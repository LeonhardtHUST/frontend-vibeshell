import type {
  AgentSession, ApiError, DomDescriptor, EventEnvelope, FrameInfo, Message, QueueItem,
  ResourceLease, Settings, TodoItem, TodoList, Visitor, WorkbenchSnapshot,
} from "@hustradio/dev-shell-contract";
import { bootstrapCreateSchema, bootstrapReadSchema, visitorCredentialsSchema, eventEnvelopeSchema,
  frameInfoSchema, settingsSchema, leaseResultSchema, agentSessionSchema } from "@hustradio/dev-shell-contract";

export type ActivityItem = EventEnvelope;
export const EVENT_HISTORY_LIMIT = 1_000;

/** Keep a bounded ordered window when pages overlap or refreshes are coalesced. */
export function mergeEventWindow(previous: EventEnvelope[], incoming: EventEnvelope[]): EventEnvelope[] {
  const ids = new Set<string>(); const sequences = new Set<number>();
  return [...previous, ...incoming].sort((a, b) => a.sequence - b.sequence).filter(event => {
    if (ids.has(event.eventId) || sequences.has(event.sequence)) return false;
    ids.add(event.eventId); sequences.add(event.sequence); return true;
  }).slice(-EVENT_HISTORY_LIMIT);
}

export interface BootstrapResult {
  visitor: Visitor;
  token: string;
  snapshot: WorkbenchSnapshot;
}

export interface VisitorCredentials {
  visitor: Visitor;
  token: string;
  mcpUrl: string;
}

export class ShellApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: unknown,
    public requestId?: string,
  ) { super(message); this.name = "ShellApiError"; }
}

type RequestOptions = Omit<RequestInit, "body"> & { body?: unknown };

function unwrap<T>(value: unknown, key?: string): T {
  if (key && value && typeof value === "object" && key in value) {
    return (value as Record<string, unknown>)[key] as T;
  }
  return value as T;
}

function items<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object" && Array.isArray((value as {items?: unknown}).items)) {
    return (value as {items: T[]}).items;
  }
  throw new ShellApiError("INVALID_RESPONSE", "列表响应不完整。", 500);
}

export class ApiClient {
  private tokenValue: string | null;
  constructor(token: string | null = null) { this.tokenValue = token; }
  get token() { return this.tokenValue; }
  setToken(token: string | null) { this.tokenValue = token; }

  async request<T>(path: string, options: RequestOptions = {}, unwrapKey?: string): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set("x-dev-shell-web", "1");
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (this.tokenValue) headers.set("authorization", `Bearer ${this.tokenValue}`);
    let response: Response;
    try {
      response = await fetch(path, {...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body)});
    } catch (cause) {
      throw new ShellApiError("NETWORK_ERROR", "无法连接本机开发服务，请检查服务是否正在运行。", 0, cause);
    }
    if (response.status === 204) return undefined as T;
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const failure = data as Partial<ApiError> | null;
      throw new ShellApiError(
        failure?.error?.code ?? `HTTP_${response.status}`,
        failure?.error?.message ?? `请求失败（${response.status}）`,
        response.status,
        failure?.error?.details,
        failure?.requestId,
      );
    }
    return unwrap<T>(data, unwrapKey);
  }

  async bootstrap(displayName: string): Promise<BootstrapResult> {
    const value = await this.request<unknown>("/api/bootstrap", {method: "POST", body: {displayName}});
    const data = bootstrapCreateSchema.parse(value);
    this.setToken(data.token);
    return data as BootstrapResult;
  }
  async login(token: string): Promise<WorkbenchSnapshot> {
    this.setToken(token);
    try { return await this.snapshot(); } catch (error) { this.setToken(null); throw error; }
  }
  snapshot() { return this.request<unknown>("/api/bootstrap").then(value => bootstrapReadSchema.parse(value).snapshot); }

  private async eventHistory(path: string, after = 0, signal?: AbortSignal, topic?: string): Promise<EventEnvelope[]> {
    if (!Number.isSafeInteger(after) || after < 0) throw new ShellApiError("INVALID_CURSOR", "事件游标无效。", 400);
    let cursor = after;
    let retained: EventEnvelope[] = [];
    for (let pageIndex = 0; pageIndex < 10_000; pageIndex++) {
      const value = await this.request<unknown>(`${path}${cursor ? `?after=${cursor}` : ""}`, {signal});
      if (!value || typeof value !== "object" || Array.isArray(value) || !("nextCursor" in value)) throw new ShellApiError("INVALID_RESPONSE", "事件分页响应不完整。", 500);
      const page = value as {items?: unknown; nextCursor: unknown};
      const parsed = eventEnvelopeSchema.array().parse(items<unknown>(page));
      const pageMaximum = parsed.reduce((latest, event) => Math.max(latest, event.sequence), cursor);
      retained = mergeEventWindow(retained, parsed.filter(event => event.sequence > cursor && (!topic || event.topic === topic)));
      if (page.nextCursor === null) return retained;
      const next = typeof page.nextCursor === "string" && /^\d+$/.test(page.nextCursor) ? Number(page.nextCursor) : NaN;
      if (!Number.isSafeInteger(next) || next <= cursor || next < pageMaximum) throw new ShellApiError("PAGINATION_STALLED", "事件分页游标没有前进，请刷新后重试。", 500);
      cursor = next;
    }
    throw new ShellApiError("PAGINATION_LIMIT", "事件历史过长，暂时无法完成读取，请稍后重试。", 500);
  }

  queue() { return this.request<unknown>("/api/queue").then(items<QueueItem>); }
  enqueue(body: string, selection: DomDescriptor | null, clientMessageId: string) {
    return this.request<QueueItem>("/api/queue", {method: "POST", body: {sessionScope: "workbench", clientMessageId, body, selection}});
  }
  readQueue(id: string) { return this.request(`/api/queue/${id}/read`, {method: "POST"}); }
  deleteQueue(id: string) { return this.request(`/api/queue/${id}`, {method: "DELETE"}); }
  retryQueue(id: string) { return this.request(`/api/queue/${id}/retry`, {method: "POST"}); }
  dispatch(queueItemIds: string[], clientMessageId: string) {
    return this.request<unknown>("/api/queue/dispatch", {method: "POST", body: {queueItemIds, clientMessageId}}).then(value => agentSessionSchema.parse(value));
  }
  messages() { return this.request<unknown>("/api/messages").then(items<Message>); }
  sendMessage(body: string, kind: "direct" | "broadcast", recipientIds: string[]) {
    return this.request<Message>("/api/messages", {method: "POST", body: {body, kind, recipientIds}});
  }
  readMessage(id: string) { return this.request(`/api/messages/${id}/read`, {method: "POST"}); }
  todoLists() { return this.request<unknown>("/api/todos/lists").then(items<TodoList>); }
  createTodoList(title: string, description = "") { return this.request<TodoList>("/api/todos/lists", {method: "POST", body: {title, description}}); }
  deleteTodoList(id: string) { return this.request(`/api/todos/lists/${id}`, {method: "DELETE"}); }
  todoItems(listId: string) { return this.request<unknown>(`/api/todos/lists/${listId}/items`).then(items<TodoItem>); }
  createTodoItem(listId: string, body: string, assigneeId: string | null = null) {
    return this.request<TodoItem>(`/api/todos/lists/${listId}/items`, {method: "POST", body: {body, assigneeId}});
  }
  updateTodoItem(id: string, body: Partial<Pick<TodoItem, "body" | "status" | "assigneeId" | "position">>, expectedRevision: number) {
    return this.request<TodoItem>(`/api/todos/items/${id}`, {method: "PATCH", body: {...body, expectedRevision}});
  }
  leases() { return this.request<unknown>("/api/resources/leases").then(items<ResourceLease>); }
  acquireLease(resource: string, mode: "shared" | "exclusive", purpose: string, wait: boolean, ttlMs = 900_000) {
    return this.request<unknown>("/api/resources/leases", {method: "POST", body: {resource, mode, purpose, ttlMs, wait}}).then(value => leaseResultSchema.parse(value));
  }
  renewLease(id: string) { return this.request(`/api/resources/leases/${id}/renew`, {method: "POST", body: {ttlMs: 900_000}}); }
  releaseLease(id: string) { return this.request(`/api/resources/leases/${id}/release`, {method: "POST"}); }
  cancelWaiter(id: string) { return this.request(`/api/resources/waiters/${id}/cancel`, {method: "POST"}); }
  sessions() { return this.request<unknown>("/api/sessions").then(items<AgentSession>); }
  createSession(prompt: string, clientMessageId: string, queueItemIds: string[] = []) {
    return this.request<unknown>("/api/sessions", {method: "POST", body: {prompt, queueItemIds, clientMessageId}}).then(value => agentSessionSchema.parse(value));
  }
  sessionEvents(id: string, after = 0, signal?: AbortSignal) { return this.eventHistory(`/api/sessions/${id}/events`, after, signal); }
  cancelSession(id: string) { return this.request(`/api/sessions/${id}/cancel`, {method: "POST"}); }
  activity(topic?: string, after = 0, signal?: AbortSignal) { return this.eventHistory("/api/activity", after, signal, topic); }
  settings() { return this.request<unknown>("/api/settings").then(value => settingsSchema.parse(value)); }
  updateSettings(settings: Partial<Settings>) { return this.request<unknown>("/api/settings", {method: "PATCH", body: settings}).then(value => settingsSchema.parse(value)); }
  frames() { return this.request<unknown>("/api/frames").then(items<FrameInfo>); }
  createFrame(targetUrl: string) { return this.request<unknown>("/api/frames", {method: "POST", body: {targetUrl}}).then(value => frameInfoSchema.parse(value)); }
  frameBridge(id: string, message: unknown) { return this.request(`/api/frames/${id}/bridge`, {method: "POST", body: message}); }
  deleteFrame(id: string) { return this.request(`/api/frames/${id}`, {method: "DELETE"}); }
  visitors() { return this.request<unknown>("/api/visitors").then(items<Visitor>); }
  createVisitor(displayName: string, kind: "human" | "agent" = "agent") {
    return this.request<unknown>("/api/visitors", {method: "POST", body: {displayName, kind}}).then(value => visitorCredentialsSchema.parse(value));
  }
  revokeVisitor(id: string) { return this.request(`/api/visitors/${id}`, {method: "DELETE"}); }
}

export const api = new ApiClient();
