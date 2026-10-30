import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WORKBENCH_SESSION_SCOPE, formatQueueBundle } from "@leonhardthust/frontend-vibeshell-contract";
import type {
  AgentBackend, AgentSession, Message, QueueItem, ResourceLease, ResourceWaiter, Settings,
  TodoItem, TodoList, Visitor, WorkbenchSnapshot,
} from "@leonhardthust/frontend-vibeshell-contract";
import type { StoredEvent } from "../db/database.js";
import { WorkbenchDatabase, type Row } from "../db/database.js";
import { conflict, DomainError, forbidden, notFound } from "./errors.js";
import { canonicalWorkspace, workspaceKey } from "../config.js";

export interface AuthVisitor { visitor: Visitor; tokenHash: string }
export interface SessionCreation { session: AgentSession }
export interface SessionLaunch { session: AgentSession; prompt: string; agentToken: string; agentVisitor: Visitor }
export interface ResourceState { leases: ResourceLease[]; waiters: ResourceWaiter[] }
const terminalStates = new Set<AgentSession["status"]>(["succeeded", "failed", "cancelled", "interrupted", "completed_with_warning"]);
const now = () => new Date().toISOString();
const tokenHash = (token: string) => createHash("sha256").update(token).digest();
const hashRequest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const parse = <T>(value: unknown) => JSON.parse(String(value)) as T;
const bool = (value: unknown) => Number(value) !== 0;

export class WorkbenchService {
  constructor(readonly store: WorkbenchDatabase, private readonly defaults: Settings, private readonly binding: {workspace?: string} = {}) {
    const existing = store.get("SELECT id FROM settings WHERE id=1");
    if (!existing) store.run("INSERT INTO settings(id,valueJson,revision) VALUES(1,?,1)", JSON.stringify(defaults));
    // Process ownership cannot survive a server restart. Recover every orphan in
    // the same domain transaction used by normal terminal transitions.
    store.transaction(() => {
      for (const row of store.all("SELECT id FROM agent_sessions WHERE status IN ('queued','spawning','running')")) {
        this.updateSession(null, String(row.id), "interrupted", "Server restarted before this session completed");
      }
    });
  }

  private visitor(row: Row): Visitor {
    return { id: String(row.id), kind: row.kind as Visitor["kind"], displayName: String(row.displayName), parentVisitorId: row.parentVisitorId === null ? null : String(row.parentVisitorId), createdAt: String(row.createdAt), lastSeenAt: String(row.lastSeenAt), revokedAt: row.revokedAt === null ? null : String(row.revokedAt), online: bool(row.online) };
  }
  private queue(row: Row): QueueItem {
    return { id: String(row.id), ownerId: String(row.ownerId), sessionScope: String(row.sessionScope), clientMessageId: String(row.clientMessageId), body: String(row.body), selection: row.selectionJson === null ? null : parse(row.selectionJson), status: row.status as QueueItem["status"], agentSessionId: row.agentSessionId === null ? null : String(row.agentSessionId), revision: Number(row.revision), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt) };
  }
  private todoList(row: Row): TodoList {
    return { id: String(row.id), ownerId: String(row.ownerId), title: String(row.title), description: String(row.description), archivedAt: row.archivedAt === null ? null : String(row.archivedAt), revision: Number(row.revision), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt) };
  }
  private todoItem(row: Row): TodoItem {
    return { id: String(row.id), listId: String(row.listId), ownerId: String(row.ownerId), assigneeId: row.assigneeId === null ? null : String(row.assigneeId), body: String(row.body), status: row.status as TodoItem["status"], position: Number(row.position), revision: Number(row.revision), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt) };
  }
  private lease(row: Row): ResourceLease {
    return { id: String(row.id), resource: String(row.resource), mode: row.mode as ResourceLease["mode"], ownerId: String(row.ownerId), purpose: String(row.purpose), acquiredAt: String(row.acquiredAt), expiresAt: String(row.expiresAt), revision: Number(row.revision) };
  }
  private waiter(row: Row): ResourceWaiter {
    return { id: String(row.id), resource: String(row.resource), mode: row.mode as ResourceWaiter["mode"], ownerId: String(row.ownerId), purpose: String(row.purpose), requestedAt: String(row.requestedAt) };
  }
  private session(row: Row): AgentSession {
    return { id: String(row.id), creatorId: String(row.creatorId), agentVisitorId: String(row.agentVisitorId), backend: row.backend as AgentBackend, nativeSessionId: row.nativeSessionId === null ? null : String(row.nativeSessionId), workspace: String(row.workspace), status: row.status as AgentSession["status"], cliSessionId: String(row.cliSessionId), queueItemIds: parse<string[]>(row.queueItemIdsJson), error: row.error === null ? null : String(row.error), createdAt: String(row.createdAt), startedAt: row.startedAt === null ? null : String(row.startedAt), endedAt: row.endedAt === null ? null : String(row.endedAt) };
  }

  listVisitors(): Visitor[] {
    const cutoff = Date.now() - 120_000;
    return this.store.all("SELECT v.*, EXISTS(SELECT 1 FROM visitor_tokens t WHERE t.visitorId=v.id AND t.revokedAt IS NULL) AS active, CASE WHEN v.lastSeenAt>? THEN 1 ELSE 0 END online FROM visitors v ORDER BY createdAt", new Date(cutoff).toISOString()).map(row => this.visitor(row));
  }
  getVisitor(id: string): Visitor {
    const row = this.store.get("SELECT v.*, CASE WHEN lastSeenAt>? THEN 1 ELSE 0 END online FROM visitors v WHERE id=?", new Date(Date.now() - 120_000).toISOString(), id);
    if (!row) throw notFound("Visitor");
    return this.visitor(row);
  }
  hasOwner(): boolean { return this.store.get("SELECT id FROM visitors WHERE kind='human' AND parentVisitorId IS NULL LIMIT 1") !== undefined; }

  bootstrapOwner(displayName = "Owner"): { visitor: Visitor; token: string; snapshot: WorkbenchSnapshot } {
    return this.store.transaction(() => {
      if (this.hasOwner()) throw conflict("OWNER_EXISTS", "An owner has already been bootstrapped");
      const visitor = this.insertVisitor("human", displayName, null);
      const token = this.mintToken(visitor.id);
      this.store.appendEvent("visitors", visitor.id, visitor.id, visitor);
      return { visitor, token, snapshot: this.snapshot(visitor.id) };
    });
  }
  private insertVisitor(kind: Visitor["kind"], displayName: string, parentVisitorId: string | null): Visitor {
    const id = randomUUID();
    const timestamp = now();
    this.store.run("INSERT INTO visitors(id,kind,displayName,parentVisitorId,createdAt,lastSeenAt) VALUES(?,?,?,?,?,?)", id, kind, displayName, parentVisitorId, timestamp, timestamp);
    return { id, kind, displayName, parentVisitorId, createdAt: timestamp, lastSeenAt: timestamp, revokedAt: null, online: true };
  }
  private mintToken(visitorId: string): string {
    const token = randomBytes(32).toString("base64url");
    this.store.run("INSERT INTO visitor_tokens(tokenHash,visitorId,createdAt) VALUES(?,?,?)", tokenHash(token).toString("hex"), visitorId, now());
    return token;
  }
  createVisitor(actorId: string, kind: Visitor["kind"], displayName: string): { visitor: Visitor; token: string } {
    this.requireHuman(actorId);
    return this.store.transaction(() => {
      const visitor = this.insertVisitor(kind, displayName, actorId);
      const token = this.mintToken(visitor.id);
      this.store.appendEvent("visitors", actorId, visitor.id, visitor);
      return { visitor, token };
    });
  }
  revokeVisitor(actorId: string, id: string): Visitor {
    this.requireHuman(actorId);
    return this.store.transaction(() => {
      const visitor = this.getVisitor(id);
      if (visitor.revokedAt) return visitor;
      if (visitor.kind === "human" && Number(this.store.get("SELECT COUNT(*) AS count FROM visitors WHERE kind='human' AND revokedAt IS NULL")!.count) <= 1) {
        throw conflict("LAST_HUMAN_REQUIRED", "Keep at least one human visitor who can sign in and manage access");
      }
      const timestamp = now();
      this.store.run("UPDATE visitors SET revokedAt=? WHERE id=?", timestamp, id);
      this.store.run("UPDATE visitor_tokens SET revokedAt=? WHERE visitorId=? AND revokedAt IS NULL", timestamp, id);
      const result = this.getVisitor(id);
      this.store.appendEvent("visitors", actorId, id, result);
      return result;
    });
  }
  subscribeRevocations(listener: (visitorId: string) => void): () => void {
    return this.store.subscribe(event => {
      if (event.type === "visitors" && event.payload && typeof event.payload === "object" && "revokedAt" in event.payload && event.payload.revokedAt) listener(event.entityId);
    });
  }
  authenticate(token: string): AuthVisitor {
    const supplied = tokenHash(token);
    const rows = this.store.all("SELECT tokenHash,visitorId FROM visitor_tokens WHERE revokedAt IS NULL");
    const matched = rows.find(row => {
      const expected = Buffer.from(String(row.tokenHash), "hex");
      return expected.length === supplied.length && timingSafeEqual(expected, supplied);
    });
    if (!matched) throw new DomainError(401, "UNAUTHORIZED", "Invalid or revoked token");
    const visitor = this.getVisitor(String(matched.visitorId));
    if (visitor.revokedAt) throw new DomainError(401, "UNAUTHORIZED", "Visitor is revoked");
    this.store.run("UPDATE visitors SET lastSeenAt=? WHERE id=?", now(), visitor.id);
    return { visitor: this.getVisitor(visitor.id), tokenHash: String(matched.tokenHash) };
  }
  requireHuman(actorId: string): Visitor {
    const actor = this.getVisitor(actorId);
    if (actor.kind !== "human" || actor.revokedAt) throw forbidden("A human visitor is required");
    return actor;
  }
  touchVisitor(id: string): void {
    this.requireActive(id);
    this.store.run("UPDATE visitors SET lastSeenAt=? WHERE id=?", now(), id);
  }

  snapshot(visitorId: string): WorkbenchSnapshot {
    return this.store.transaction(() => {
      this.requireActive(visitorId);
      const resources = this.resources();
      const revision = this.store.latestEvent()?.sequence ?? 0;
      return {
        revision, streamCursor: this.streamCursor(visitorId, revision),
        visitors: this.listVisitors(), queue: this.listQueue(), messages: this.listMessages(visitorId),
        todoLists: this.store.all("SELECT * FROM todo_lists ORDER BY createdAt").map(row => this.todoList(row)),
        todoItems: this.store.all("SELECT * FROM todo_items ORDER BY listId,position,createdAt").map(row => this.todoItem(row)),
        ...resources, sessions: this.listSessions(), settings: this.getSettings(),
      };
    });
  }

  streamCursor(visitorId: string, sequence = this.store.latestEvent()?.sequence ?? 0): string {
    return Buffer.from(JSON.stringify([visitorId, sequence])).toString("base64url");
  }
  parseStreamCursor(visitorId: string, cursor: string): number | null {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 512) return null;
      const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (!Array.isArray(value) || value.length !== 2 || value[0] !== visitorId || !Number.isSafeInteger(value[1]) || value[1] < 0 || value[1] > (this.store.latestEvent()?.sequence ?? 0)) return null;
      return value[1] as number;
    } catch { return null; }
  }
  private requireActive(visitorId: string): Visitor {
    const visitor = this.getVisitor(visitorId);
    if (visitor.revokedAt) throw new DomainError(401, "UNAUTHORIZED", "Visitor is revoked");
    return visitor;
  }

  listQueue(): QueueItem[] { return this.store.all("SELECT * FROM queue_items ORDER BY createdAt").map(row => this.queue(row)); }
  getQueue(id: string): QueueItem { const row = this.store.get("SELECT * FROM queue_items WHERE id=?", id); if (!row) throw notFound("Queue item"); return this.queue(row); }
  enqueue(actorId: string, input: { sessionScope?: string; clientMessageId: string; body: string; selection?: unknown }): QueueItem {
    const scope = input.sessionScope ?? WORKBENCH_SESSION_SCOPE;
    const requestHash = hashRequest({ body: input.body, selection: input.selection ?? null });
    return this.store.transaction(() => {
      const previous = this.idempotent<QueueItem>(actorId, scope, input.clientMessageId, requestHash);
      if (previous) return previous;
      const id = randomUUID(); const timestamp = now();
      this.store.run("INSERT INTO queue_items(id,ownerId,sessionScope,clientMessageId,body,selectionJson,status,createdAt,updatedAt) VALUES(?,?,?,?,?,?, 'queued',?,?)", id, actorId, scope, input.clientMessageId, input.body, input.selection == null ? null : JSON.stringify(input.selection), timestamp, timestamp);
      const item = this.getQueue(id);
      this.saveIdempotent(actorId, scope, input.clientMessageId, requestHash, item);
      this.store.appendEvent("queue", actorId, id, item);
      return item;
    });
  }
  cancelQueue(actorId: string, id: string): QueueItem {
    return this.store.transaction(() => {
      const item = this.getQueue(id);
      if (item.ownerId !== actorId) throw forbidden("Only the queue item owner may cancel it");
      if (item.status === "cancelled") return item;
      if (!["queued", "failed"].includes(item.status)) throw conflict("QUEUE_STATE_CONFLICT", "Cancel the associated session before changing a dispatched queue item");
      this.store.run("UPDATE queue_items SET status='cancelled',revision=revision+1,updatedAt=? WHERE id=?", now(), id);
      const result = this.getQueue(id); this.store.appendEvent("queue", actorId, id, result); return result;
    });
  }
  retryQueue(actorId: string, id: string): QueueItem {
    return this.store.transaction(() => {
      const item = this.getQueue(id);
      if (item.ownerId !== actorId) throw forbidden("Only the queue item owner may retry it");
      if (!["failed", "cancelled"].includes(item.status)) throw conflict("QUEUE_STATE_CONFLICT", "Only failed or cancelled queue items may be retried");
      this.store.run("UPDATE queue_items SET status='queued',agentSessionId=NULL,revision=revision+1,updatedAt=? WHERE id=?", now(), id);
      const result = this.getQueue(id); this.store.appendEvent("queue", actorId, id, result); return result;
    });
  }
  dispatch(actorId: string, input: { queueItemIds: string[]; clientMessageId: string; workspace?: string; backend?: AgentBackend }): SessionCreation {
    this.requireHuman(actorId);
    const items = input.queueItemIds.map(id => this.getQueue(id));
    const prompt = formatQueueBundle(items);
    return this.createSession(actorId, { prompt, ...input });
  }
  markQueueRead(actorId: string, id: string): void { this.getQueue(id); this.markRead(actorId, "queue", id); }

  private message(row: Row): Message {
    return { id: String(row.id), senderId: String(row.senderId), recipientIds: this.store.all("SELECT visitorId FROM message_recipients WHERE messageId=? ORDER BY visitorId", String(row.id)).map(item => String(item.visitorId)), kind: row.kind as Message["kind"], body: String(row.body), createdAt: String(row.createdAt) };
  }
  listMessages(visitorId: string): Message[] {
    return this.store.all("SELECT * FROM messages ORDER BY createdAt").map(row => this.message(row)).filter(message => message.kind !== "direct" || message.senderId === visitorId || message.recipientIds.includes(visitorId));
  }
  getMessage(visitorId: string, id: string): Message {
    const row = this.store.get("SELECT * FROM messages WHERE id=?", id); if (!row) throw notFound("Message");
    const message = this.message(row);
    if (message.kind === "direct" && message.senderId !== visitorId && !message.recipientIds.includes(visitorId)) throw notFound("Message");
    return message;
  }
  sendMessage(actorId: string, input: { recipientIds: string[]; kind: "direct" | "broadcast"; body: string }): Message {
    if (input.kind === "direct" && input.recipientIds.length === 0) throw new DomainError(400, "VALIDATION_ERROR", "Direct messages require recipients");
    for (const id of input.recipientIds) this.getVisitor(id);
    return this.store.transaction(() => {
      const id = randomUUID(); const timestamp = now();
      this.store.run("INSERT INTO messages(id,senderId,kind,body,createdAt) VALUES(?,?,?,?,?)", id, actorId, input.kind, input.body, timestamp);
      for (const recipient of new Set(input.recipientIds)) this.store.run("INSERT INTO message_recipients(messageId,visitorId) VALUES(?,?)", id, recipient);
      const message = this.getMessage(actorId, id); this.store.appendEvent("messages", actorId, id, message); return message;
    });
  }
  markMessageRead(actorId: string, id: string): void { this.getMessage(actorId, id); this.markRead(actorId, "message", id); }
  private markRead(actorId: string, entityType: string, entityId: string): void {
    this.store.run("INSERT INTO read_cursors(visitorId,entityType,entityId,readAt) VALUES(?,?,?,?) ON CONFLICT(visitorId,entityType,entityId) DO UPDATE SET readAt=excluded.readAt", actorId, entityType, entityId, now());
  }

  createTodoList(actorId: string, input: { title: string; description: string }): TodoList {
    return this.store.transaction(() => {
      const id = randomUUID(); const timestamp = now();
      this.store.run("INSERT INTO todo_lists(id,ownerId,title,description,createdAt,updatedAt) VALUES(?,?,?,?,?,?)", id, actorId, input.title, input.description, timestamp, timestamp);
      const row = this.store.get("SELECT * FROM todo_lists WHERE id=?", id)!; const result = this.todoList(row);
      this.store.appendEvent("todos", actorId, id, result, "todoList"); return result;
    });
  }
  createTodoItem(actorId: string, listId: string, input: { body: string; assigneeId: string | null; position?: number }): TodoItem {
    return this.store.transaction(() => {
      const listRow = this.store.get("SELECT * FROM todo_lists WHERE id=?", listId); if (!listRow) throw notFound("Todo list");
      if (String(listRow.ownerId) !== actorId) throw forbidden("Only the list owner may add items");
      if (input.assigneeId) this.getVisitor(input.assigneeId);
      const id = randomUUID(); const timestamp = now();
      const position = input.position ?? Number(this.store.get("SELECT COALESCE(MAX(position),-1)+1 AS position FROM todo_items WHERE listId=?", listId)!.position);
      this.store.run("INSERT INTO todo_items(id,listId,ownerId,assigneeId,body,status,position,createdAt,updatedAt) VALUES(?,?,?,?,?,'pending',?,?,?)", id, listId, actorId, input.assigneeId, input.body, position, timestamp, timestamp);
      const result = this.todoItem(this.store.get("SELECT * FROM todo_items WHERE id=?", id)!);
      this.store.appendEvent("todos", actorId, id, result, "todoItem"); return result;
    });
  }
  deleteTodoList(actorId: string, id: string): void {
    this.store.transaction(() => {
      const row = this.store.get("SELECT * FROM todo_lists WHERE id=?", id);
      if (!row) throw notFound("Todo list");
      if (String(row.ownerId) !== actorId) throw forbidden("Only the list owner may delete it");
      this.store.run("DELETE FROM todo_lists WHERE id=?", id);
      this.store.appendEvent("todos", actorId, id, { action: "deleted", listId: id }, "todoList");
    });
  }
  updateTodoItem(actorId: string, id: string, input: { expectedRevision: number; body?: string; status?: TodoItem["status"]; assigneeId?: string | null; position?: number }): TodoItem {
    return this.store.transaction(() => {
      const current = this.todoItem(this.store.get("SELECT * FROM todo_items WHERE id=?", id) ?? (() => { throw notFound("Todo item"); })());
      if (current.ownerId !== actorId && current.assigneeId !== actorId) throw forbidden("Only the owner or assignee may update this item");
      if (current.revision !== input.expectedRevision) throw conflict("REVISION_MISMATCH", "Todo item has changed", { current });
      if (input.assigneeId) this.getVisitor(input.assigneeId);
      this.store.run("UPDATE todo_items SET body=?,status=?,assigneeId=?,position=?,revision=revision+1,updatedAt=? WHERE id=?", input.body ?? current.body, input.status ?? current.status, input.assigneeId === undefined ? current.assigneeId : input.assigneeId, input.position ?? current.position, now(), id);
      const result = this.todoItem(this.store.get("SELECT * FROM todo_items WHERE id=?", id)!);
      this.store.appendEvent("todos", actorId, id, result, "todoItem"); return result;
    });
  }

  private expireLeases(): void {
    const timestamp = now();
    const expired = this.store.all("SELECT * FROM resource_leases WHERE expiresAt<=?", timestamp);
    for (const row of expired) {
      const lease = this.lease(row);
      this.store.run("DELETE FROM resource_leases WHERE id=?", lease.id);
      this.store.appendEvent("resources", null, lease.id, { action: "expired", lease, retryWaiters: true });
    }
  }
  resources(): ResourceState {
    return this.store.transaction(() => {
      this.expireLeases();
      return { leases: this.store.all("SELECT * FROM resource_leases ORDER BY acquiredAt").map(row => this.lease(row)), waiters: this.store.all("SELECT * FROM resource_waiters ORDER BY requestedAt").map(row => this.waiter(row)) };
    });
  }
  acquireLease(actorId: string, input: { resource: string; mode: ResourceLease["mode"]; purpose: string; ttlMs: number; wait: boolean }): { lease: ResourceLease | null; waiter: ResourceWaiter | null; conflicts: ResourceLease[] } {
    return this.store.transaction(() => {
      this.expireLeases();
      const holders = this.store.all("SELECT * FROM resource_leases WHERE resource=?", input.resource).map(row => this.lease(row));
      const conflicted = holders.length > 0 && (input.mode === "exclusive" || holders.some(lease => lease.mode === "exclusive"));
      if (conflicted) {
        const waiters = this.store.all("SELECT * FROM resource_waiters WHERE resource=? ORDER BY requestedAt", input.resource).map(row => this.waiter(row));
        if (!input.wait) throw conflict("RESOURCE_CONFLICT", "Resource is currently leased", { holders, waiters });
        const id = randomUUID(); const timestamp = now();
        this.store.run("INSERT INTO resource_waiters(id,resource,mode,ownerId,purpose,requestedAt) VALUES(?,?,?,?,?,?)", id, input.resource, input.mode, actorId, input.purpose, timestamp);
        const waiter = this.waiter(this.store.get("SELECT * FROM resource_waiters WHERE id=?", id)!);
        this.store.appendEvent("resources", actorId, id, { action: "waiting", waiter }); return { lease: null, waiter, conflicts: holders };
      }
      const id = randomUUID(); const timestamp = now(); const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
      this.store.run("INSERT INTO resource_leases(id,resource,mode,ownerId,purpose,acquiredAt,expiresAt) VALUES(?,?,?,?,?,?,?)", id, input.resource, input.mode, actorId, input.purpose, timestamp, expiresAt);
      const lease = this.lease(this.store.get("SELECT * FROM resource_leases WHERE id=?", id)!);
      this.store.appendEvent("resources", actorId, id, { action: "acquired", lease }); return { lease, waiter: null, conflicts: [] };
    });
  }
  renewLease(actorId: string, id: string, ttlMs = 900_000): ResourceLease {
    return this.store.transaction(() => {
      this.expireLeases();
      const row = this.store.get("SELECT * FROM resource_leases WHERE id=?", id); if (!row) throw notFound("Lease");
      const current = this.lease(row); if (current.ownerId !== actorId) throw forbidden("Only the lease owner may renew it");
      if (ttlMs < 30_000 || ttlMs > 3_600_000) throw new DomainError(400, "VALIDATION_ERROR", "ttlMs must be between 30000 and 3600000");
      this.store.run("UPDATE resource_leases SET expiresAt=?,revision=revision+1 WHERE id=?", new Date(Date.now() + ttlMs).toISOString(), id);
      const lease = this.lease(this.store.get("SELECT * FROM resource_leases WHERE id=?", id)!);
      this.store.appendEvent("resources", actorId, id, { action: "renewed", lease }); return lease;
    });
  }
  releaseLease(actorId: string, id: string): void {
    this.store.transaction(() => {
      this.expireLeases(); const row = this.store.get("SELECT * FROM resource_leases WHERE id=?", id); if (!row) throw notFound("Lease");
      if (this.lease(row).ownerId !== actorId) throw forbidden("Only the lease owner may release it");
      this.store.run("DELETE FROM resource_leases WHERE id=?", id);
      const waiters = this.store.all("SELECT * FROM resource_waiters WHERE resource=?", String(row.resource)).map(item => this.waiter(item));
      this.store.appendEvent("resources", actorId, id, { action: "released", retryWaiters: waiters.length > 0, waiters });
    });
  }
  cancelWaiter(actorId: string, id: string): void {
    this.store.transaction(() => {
      const row = this.store.get("SELECT * FROM resource_waiters WHERE id=?", id); if (!row) throw notFound("Waiter");
      if (this.waiter(row).ownerId !== actorId) throw forbidden("Only the waiter owner may cancel it");
      this.store.run("DELETE FROM resource_waiters WHERE id=?", id); this.store.appendEvent("resources", actorId, id, { action: "wait-cancelled" });
    });
  }

  createSession(actorId: string, input: { prompt: string; queueItemIds: string[]; clientMessageId: string; workspace?: string; backend?: AgentBackend }): SessionCreation {
    this.requireHuman(actorId);
    const scope = WORKBENCH_SESSION_SCOPE;
    const requestHash = hashRequest({ prompt: input.prompt, queueItemIds: input.queueItemIds, workspace: input.workspace ?? null, backend: input.backend ?? null });
    return this.store.transaction(() => {
      const previous = this.idempotent<SessionCreation>(actorId, scope, input.clientMessageId, requestHash);
      if (previous) return previous;
      if (new Set(input.queueItemIds).size !== input.queueItemIds.length) throw new DomainError(400, "VALIDATION_ERROR", "Queue item IDs must be unique");
      for (const id of input.queueItemIds) { const item = this.getQueue(id); if (item.status !== "queued") throw conflict("QUEUE_NOT_READY", "Every queue item must be queued"); }
      const backend = input.backend ?? this.getSettings().backend ?? "codebuddy";
      const agent = this.insertVisitor("agent", `${backend} ${new Date().toISOString()}`, actorId);
      const id = randomUUID(); const cliSessionId = randomUUID(); const timestamp = now();
      const workspace = this.boundWorkspace(input.workspace ?? this.getSettings().workspace);
      this.store.run("INSERT INTO agent_sessions(id,creatorId,agentVisitorId,workspace,status,cliSessionId,queueItemIdsJson,createdAt,promptText,backend) VALUES(?,?,?,?,'queued',?,?,?,?,?)", id, actorId, agent.id, workspace, cliSessionId, JSON.stringify(input.queueItemIds), timestamp, input.prompt, backend);
      for (const queueId of input.queueItemIds) {
        this.store.run("UPDATE queue_items SET status='dispatching',agentSessionId=?,revision=revision+1,updatedAt=? WHERE id=?", id, timestamp, queueId);
        this.store.appendEvent("queue", actorId, queueId, this.getQueue(queueId));
      }
      const session = this.getSession(id);
      const creation = { session };
      this.saveIdempotent(actorId, scope, input.clientMessageId, requestHash, creation);
      this.store.appendEvent("visitors", actorId, agent.id, agent);
      this.store.appendEvent("sessions", actorId, id, session);
      return creation;
    });
  }
  claimSession(id: string): SessionLaunch | null {
    return this.store.transaction(() => {
      const session = this.getSession(id);
      if (session.status !== "queued") return null;
      this.requireHuman(session.creatorId);
      this.requireActive(session.agentVisitorId);
      const prompt = String(this.store.get("SELECT promptText FROM agent_sessions WHERE id=?", id)!.promptText);
      if (!prompt) { this.updateSession(null, id, "failed", "Session prompt is unavailable; enqueue it again"); return null; }
      const claimed = this.updateSession(null, id, "spawning");
      return { session: claimed, prompt, agentToken: this.mintToken(session.agentVisitorId), agentVisitor: this.getVisitor(session.agentVisitorId) };
    });
  }
  listSessions(): AgentSession[] { return this.store.all("SELECT * FROM agent_sessions ORDER BY createdAt DESC").map(row => this.session(row)); }
  getSession(id: string): AgentSession { const row = this.store.get("SELECT * FROM agent_sessions WHERE id=?", id); if (!row) throw notFound("Session"); return this.session(row); }
  sessionEvents(id: string, after = 0): StoredEvent[] { this.getSession(id); return this.store.all("SELECT * FROM events WHERE entityType='sessions' AND entityId=? AND sequence>? ORDER BY sequence LIMIT 500", id, after).map(row => ({ sequence: Number(row.sequence), eventId: String(row.eventId), type: row.type as StoredEvent["type"], actorId: row.actorId === null ? null : String(row.actorId), entityType: String(row.entityType), entityId: String(row.entityId), payload: parse(row.payloadJson), occurredAt: String(row.occurredAt) })); }
  updateSession(actorId: string | null, id: string, status: AgentSession["status"], error: string | null = null): AgentSession {
    return this.store.transaction(() => {
      const current = this.getSession(id); const terminal = ["succeeded", "failed", "cancelled", "interrupted", "completed_with_warning"].includes(status);
      if (terminalStates.has(current.status)) return current;
      if (status === current.status) return current;
      const allowed = current.status === "queued" ? ["spawning", "failed", "cancelled", "interrupted"] : current.status === "spawning" ? ["running", "failed", "cancelled", "interrupted", "completed_with_warning", "succeeded"] : ["succeeded", "failed", "cancelled", "interrupted", "completed_with_warning"];
      if (!allowed.includes(status)) throw conflict("SESSION_STATE_CONFLICT", "Illegal session state transition");
      this.store.run("UPDATE agent_sessions SET status=?,error=?,startedAt=COALESCE(startedAt,?),endedAt=? WHERE id=?", status, error, status === "queued" ? null : now(), terminal ? now() : current.endedAt, id);
      if (terminal) {
        const session = this.getSession(id); this.store.run("UPDATE visitors SET revokedAt=? WHERE id=?", now(), session.agentVisitorId);
        this.store.run("UPDATE visitor_tokens SET revokedAt=? WHERE visitorId=? AND revokedAt IS NULL", now(), session.agentVisitorId);
        this.store.appendEvent("visitors", actorId, session.agentVisitorId, this.getVisitor(session.agentVisitorId));
        const queuedStatus = status === "succeeded" || status === "completed_with_warning" ? "sent" : status === "cancelled" ? "cancelled" : "failed";
        const queueIds = this.store.all("SELECT id FROM queue_items WHERE agentSessionId=? AND status='dispatching'", id);
        for (const row of queueIds) {
          this.store.run("UPDATE queue_items SET status=?,revision=revision+1,updatedAt=? WHERE id=?", queuedStatus, now(), String(row.id));
          this.store.appendEvent("queue", actorId, String(row.id), this.getQueue(String(row.id)));
        }
      }
      const session = this.getSession(id); this.store.appendEvent("sessions", actorId, id, session); return session;
    });
  }
  recordBackendSessionId(id: string, nativeSessionId: string): void {
    if (!nativeSessionId || nativeSessionId.length > 256) return;
    this.store.transaction(() => {
      const session = this.getSession(id);
      if (session.nativeSessionId === nativeSessionId) return;
      this.store.run("UPDATE agent_sessions SET nativeSessionId=? WHERE id=?", nativeSessionId, id);
      this.store.appendEvent("sessions", null, id, this.getSession(id));
    });
  }
  appendSessionEvent(actorId: string | null, id: string, data: unknown): void { this.getSession(id); this.store.transaction(() => { this.store.appendEvent("sessions", actorId, id, data); }); }
  cancelSession(actorId: string, id: string): AgentSession { this.requireHuman(actorId); const current = this.getSession(id); if (["succeeded", "failed", "cancelled", "interrupted", "completed_with_warning"].includes(current.status)) return current; return this.updateSession(actorId, id, "cancelled"); }

  activity(visitorId: string, after = 0, limit = 200): StoredEvent[] {
    const visible: StoredEvent[] = [];
    let sequence = after;
    while (visible.length < limit) {
      const scanned = this.store.eventsAfter(sequence, 200);
      if (!scanned.length) break;
      visible.push(...scanned.filter(event => this.eventVisible(visitorId, event)).slice(0, limit - visible.length));
      sequence = scanned.at(-1)!.sequence;
      if (scanned.length < 200) break;
    }
    return visible;
  }
  eventVisible(visitorId: string, event: StoredEvent): boolean {
    if (this.getVisitor(visitorId).revokedAt) return false;
    if (event.type !== "messages") return true;
    try { this.getMessage(visitorId, event.entityId); return true; } catch { return false; }
  }
  getSettings(): Settings { return parse<Settings>(this.store.get("SELECT valueJson FROM settings WHERE id=1")!.valueJson); }
  private boundWorkspace(workspace: string): string {
    if (!this.binding.workspace) return workspace;
    let matches = false;
    try { matches = workspaceKey(canonicalWorkspace(workspace)) === workspaceKey(this.binding.workspace); } catch { /* Invalid paths are rejected below. */ }
    if (!matches) throw new DomainError(400, "WORKSPACE_MISMATCH", "Workspace is fixed for this process. Restart Dev Shell with --workspace to switch projects.");
    return this.binding.workspace;
  }
  updateSettings(actorId: string, patch: Partial<Settings>): Settings {
    this.requireHuman(actorId);
    return this.store.transaction(() => {
      const next = { ...this.getSettings(), ...patch };
      next.workspace = this.boundWorkspace(next.workspace);
      if (new URL(next.defaultTarget).protocol !== "http:" && new URL(next.defaultTarget).protocol !== "https:") throw new DomainError(400, "VALIDATION_ERROR", "Only HTTP targets are allowed");
      this.store.run("UPDATE settings SET valueJson=?,revision=revision+1 WHERE id=1", JSON.stringify(next));
      this.store.appendEvent("settings", actorId, "settings", next); return next;
    });
  }

  private idempotent<T>(visitorId: string, scope: string, clientMessageId: string, requestHash: string): T | undefined {
    const row = this.store.get("SELECT * FROM idempotency_keys WHERE visitorId=? AND sessionScope=? AND clientMessageId=?", visitorId, scope, clientMessageId);
    if (!row) return undefined;
    if (row.requestHash !== requestHash) throw conflict("IDEMPOTENCY_CONFLICT", "clientMessageId was already used with a different request");
    return parse<T>(row.responseJson);
  }
  private saveIdempotent(visitorId: string, scope: string, clientMessageId: string, requestHash: string, response: unknown): void {
    this.store.run("INSERT INTO idempotency_keys(visitorId,sessionScope,clientMessageId,requestHash,responseJson,createdAt) VALUES(?,?,?,?,?,?)", visitorId, scope, clientMessageId, requestHash, JSON.stringify(response), now());
  }
}
