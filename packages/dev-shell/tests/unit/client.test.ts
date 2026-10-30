import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROTOCOL_VERSION,
  type AgentSession, type EventEnvelope, type ResourceLease, type ResourceWaiter,
  type Visitor, type WorkbenchSnapshot,
} from "@hustradio/dev-shell-contract";
import { ApiClient, EVENT_HISTORY_LIMIT, mergeEventWindow, ShellApiError } from "../../src/api/client";

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const timestamp = "2026-10-25T00:00:00.000Z";
const visitor: Visitor = { id: id(1), kind: "human", displayName: "Owner", parentVisitorId: null, createdAt: timestamp, lastSeenAt: timestamp, revokedAt: null, online: true };
const token = "a-valid-fixture-token-with-at-least-32-characters";
const snapshot: WorkbenchSnapshot = {
  revision: 7, streamCursor: "opaque-visitor-bound-fixture-cursor",
  visitors: [visitor], queue: [], messages: [], todoLists: [], todoItems: [], leases: [], waiters: [], sessions: [],
  settings: {
    defaultTarget: "http://127.0.0.1:5274/fixture", allowedOrigins: ["http://127.0.0.1:5274"],
    workspace: "workspace", codebuddyExecutable: "codebuddy", model: null, permissionMode: "default",
    timeoutMs: 120_000, maxConcurrent: 2, theme: "system", longPressMs: 500,
  },
};
const session: AgentSession = {
  id: id(2), creatorId: visitor.id, agentVisitorId: id(3), workspace: "workspace", status: "queued",
  cliSessionId: id(4), queueItemIds: [], error: null, createdAt: timestamp, startedAt: null, endedAt: null,
};
const event: EventEnvelope = {
  type: "event", protocolVersion: PROTOCOL_VERSION, eventId: id(5), sequence: 8, replay: false,
  topic: "sessions", actorId: null, entityId: session.id, data: { kind: "assistant", raw: { text: "Hello" } }, occurredAt: timestamp,
};
const lease: ResourceLease = { id: id(6), resource: "src/preview.tsx", mode: "exclusive", ownerId: visitor.id, purpose: "edit", acquiredAt: timestamp, expiresAt: "2026-10-25T00:15:00.000Z", revision: 1 };
const waiter: ResourceWaiter = { id: id(7), resource: lease.resource, mode: "exclusive", ownerId: id(8), purpose: "next edit", requestedAt: timestamp };
const fetchMock = vi.fn<typeof fetch>();
const respond = (value: unknown, status = 200) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }));

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe("ApiClient response contracts", () => {
  it("accepts the bootstrap creation envelope and saves only its returned bearer token", async () => {
    const client = new ApiClient();
    respond({ visitor, token, snapshot });
    expect(await client.bootstrap("Owner")).toEqual({ visitor, token, snapshot });
    expect(client.token).toBe(token);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/bootstrap");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ displayName: "Owner" });
    expect(new Headers(init?.headers).get("x-dev-shell-web")).toBe("1");
  });

  it("unwraps the authenticated bootstrap read envelope on login and refresh", async () => {
    const client = new ApiClient();
    respond({ visitor, snapshot });
    expect(await client.login(token)).toEqual(snapshot);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBe(`Bearer ${token}`);
    respond({ visitor, snapshot: { ...snapshot, revision: 9, streamCursor: "new-watermark" } });
    expect(await client.snapshot()).toMatchObject({ revision: 9, streamCursor: "new-watermark", settings: snapshot.settings });
    expect(client.token).toBe(token);
  });

  it("preserves OWNER_EXISTS and request metadata so the UI can switch to login", async () => {
    const client = new ApiClient();
    const failure = { error: { code: "OWNER_EXISTS", message: "Owner already exists", details: { action: "login" } }, requestId: id(9) };
    respond(failure, 409);
    await expect(client.bootstrap("Another owner")).rejects.toMatchObject({
      name: "ShellApiError", code: "OWNER_EXISTS", status: 409, message: failure.error.message, details: failure.error.details, requestId: failure.requestId,
    });
    expect(client.token).toBeNull();
  });

  it("clears a rejected login token and retains the server's concrete authorization error", async () => {
    const client = new ApiClient("previous-token");
    respond({ error: { code: "UNAUTHORIZED", message: "Visitor access was revoked" }, requestId: id(10) }, 401);
    await expect(client.login(token)).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401, requestId: id(10) });
    expect(client.token).toBeNull();
  });

  it("returns separate visitor MCP endpoint and token fields", async () => {
    const client = new ApiClient(token);
    const agent = { ...visitor, id: id(3), kind: "agent", parentVisitorId: visitor.id, displayName: "External agent" };
    const credentials = { visitor: agent, token, mcpUrl: "http://127.0.0.1:5274/mcp" };
    respond(credentials, 201);
    expect(await client.createVisitor("External agent")).toEqual(credentials);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ displayName: "External agent", kind: "agent" });
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBe(`Bearer ${token}`);
  });

  it("parses independent session DTOs and the public data-based event envelope", async () => {
    const client = new ApiClient(token);
    respond(session, 201);
    expect(await client.createSession("Implement the selected element", "client-message")).toEqual(session);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ prompt: "Implement the selected element", queueItemIds: [], clientMessageId: "client-message" });
    respond({ items: [event], nextCursor: "8" });
    respond({ items: [], nextCursor: null });
    expect(await client.sessionEvents(session.id)).toEqual([event]);
    respond({ items: [event, { ...event, eventId: id(11), sequence: 9, topic: "queue", data: { status: "queued" } }], nextCursor: null });
    expect(await client.activity("sessions")).toEqual([event]);
    respond({ ...session, queueItemIds: [id(12)] }, 201);
    expect(await client.dispatch([id(12)], "one-batch")).toMatchObject({ cliSessionId: session.cliSessionId, queueItemIds: [id(12)] });
  });

  it.each(["session", "activity"])("reads beyond the first %s page and advances incremental requests", async kind => {
    const client = new ApiClient(token);
    const pageSize = kind === "session" ? 500 : 200;
    const events = Array.from({length: pageSize + 1}, (_, index) => ({...event, sequence: index + 1, eventId: id(index + 100)}));
    respond({items: events.slice(0, pageSize), nextCursor: String(pageSize)});
    respond({items: [events[pageSize - 1], events[pageSize]], nextCursor: null});
    const controller = new AbortController();
    const actual = kind === "session" ? await client.sessionEvents(session.id, 0, controller.signal) : await client.activity(undefined, 0, controller.signal);
    expect(actual).toEqual(events);
    expect(fetchMock.mock.calls[1][0]).toBe(`${kind === "session" ? `/api/sessions/${session.id}/events` : "/api/activity"}?after=${pageSize}`);
    expect(fetchMock.mock.calls.every(([, options]) => options?.signal === controller.signal)).toBe(true);
    respond({items: [{...event, eventId: id(9000), sequence: pageSize + 2}], nextCursor: null});
    const later = kind === "session" ? await client.sessionEvents(session.id, pageSize + 1) : await client.activity(undefined, pageSize + 1);
    expect(later).toHaveLength(1);
    expect(later[0].sequence).toBe(pageSize + 2);
  });

  it("retains a bounded latest window without dropping progress between pages", async () => {
    const client = new ApiClient(token);
    const history = Array.from({length: 1200}, (_, index) => ({...event, sequence: index + 1, eventId: id(index + 100)}));
    respond({items: history.slice(0, 500), nextCursor: "500"});
    respond({items: history.slice(500, 1000), nextCursor: "1000"});
    respond({items: history.slice(1000), nextCursor: null});
    const actual = await client.sessionEvents(session.id);
    expect(actual).toHaveLength(EVENT_HISTORY_LIMIT);
    expect(actual[0].sequence).toBe(201);
    expect(actual.at(-1)?.sequence).toBe(1200);
    expect(mergeEventWindow(actual, [history[1199], {...event, sequence: 1201, eventId: id(9001)}])).toEqual([...history.slice(201), {...event, sequence: 1201, eventId: id(9001)}]);
  });

  it.each(["0", "7", "not-a-cursor", 8])("rejects a non-progressing or invalid cursor %s", async nextCursor => {
    const client = new ApiClient(token);
    respond({items: [event], nextCursor});
    await expect(client.sessionEvents(session.id)).rejects.toMatchObject({code: "PAGINATION_STALLED"});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves the acquired and waiting lease result shapes", async () => {
    const client = new ApiClient(token);
    respond({ lease, waiter: null, conflicts: [] }, 201);
    expect(await client.acquireLease(lease.resource, "exclusive", "edit", false)).toEqual({ lease, waiter: null, conflicts: [] });
    respond({ lease: null, waiter, conflicts: [lease] }, 202);
    expect(await client.acquireLease(lease.resource, "exclusive", "next edit", true)).toEqual({ lease: null, waiter, conflicts: [lease] });
    respond({ error: { code: "RESOURCE_CONFLICT", message: "Already leased", details: { holders: [lease], waiters: [] } }, requestId: id(13) }, 409);
    await expect(client.acquireLease(lease.resource, "exclusive", "edit", false)).rejects.toMatchObject({ code: "RESOURCE_CONFLICT", details: { holders: [lease] } });
  });

  it("rejects incomplete bootstrap, credentials, session and lease responses", async () => {
    const client = new ApiClient();
    respond({ visitor, token });
    await expect(client.bootstrap("Owner")).rejects.toThrow();
    expect(client.token).toBeNull();
    respond(snapshot); // A raw snapshot is not the authenticated read envelope.
    await expect(client.snapshot()).rejects.toThrow();
    respond({ visitor, token, mcpUrl: "not-a-url" });
    await expect(client.createVisitor("Bad endpoint")).rejects.toThrow();
    respond({ id: session.id });
    await expect(client.createSession("Task", "invalid")).rejects.toThrow();
    respond({ waiter, conflicts: [] });
    await expect(client.acquireLease(lease.resource, "exclusive", "edit", true)).rejects.toThrow();
  });

  it("rejects malformed event envelopes and malformed list containers", async () => {
    const client = new ApiClient(token);
    respond({ items: [{ ...event, sequence: "8" }], nextCursor: null });
    await expect(client.sessionEvents(session.id)).rejects.toThrow();
    respond({ entries: [] });
    await expect(client.queue()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    respond({ entries: [] });
    await expect(client.activity()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("refuses the old payload-only event representation", async () => {
    const client = new ApiClient(token);
    const { data, ...withoutData } = event;
    respond({ items: [{ ...withoutData, payload: data }], nextCursor: null });
    await expect(client.sessionEvents(session.id)).rejects.toThrow();
  });

  it("turns network failures into actionable errors and handles empty successful responses", async () => {
    const client = new ApiClient(token);
    const cause = new TypeError("Connection refused");
    fetchMock.mockRejectedValueOnce(cause);
    await expect(client.snapshot()).rejects.toMatchObject({ name: "ShellApiError", code: "NETWORK_ERROR", status: 0, details: cause });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(client.deleteTodoList(id(14))).resolves.toBeUndefined();
    respond({}, 502);
    await expect(client.snapshot()).rejects.toBeInstanceOf(ShellApiError);
  });
});
