import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Message, QueueItem, ResourceLease, ResourceWaiter, TodoItem, TodoList, Visitor, WorkbenchSnapshot } from "@hustradio/dev-shell-contract";
import { createDevShellServer, type DevShellServer } from "../../src/server.js";

let directory: string;
let server: DevShellServer | undefined;
let base: string;
const clients: { client: Client; transport: StreamableHTTPClientTransport }[] = [];

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "dev-shell-mcp-")); server = undefined; });
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(({client}) => client.close()));
  await server?.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

async function start() {
  server = createDevShellServer({
    config: { port: 0, dataDir: directory, databasePath: join(directory, "test.sqlite"), workspace: directory },
    onSessionLaunch: () => {},
  });
  await server.listen();
  base = `http://127.0.0.1:${server.config.port}`;
  return server;
}

async function connect(token: string) {
  const client = new Client({ name: "dev-shell-integration", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    reconnectionOptions: { initialReconnectionDelay: 10, maxReconnectionDelay: 10, reconnectionDelayGrowFactor: 1, maxRetries: 0 },
  });
  clients.push({client, transport});
  await client.connect(transport);
  return {client, transport};
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent?.result as T;
}

async function denied(client: Client, name: string, args: Record<string, unknown>) {
  const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
  expect(result.isError).toBe(true);
  return result;
}

async function resource<T>(client: Client, uri: string): Promise<T> {
  const result = await client.readResource({uri});
  const entry = result.contents[0];
  if (!entry || !("text" in entry)) throw new Error("Expected a JSON text resource");
  return JSON.parse(entry.text) as T;
}

async function request(token: string, options: { method?: string; sessionId?: string; protocolVersion?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": options.protocolVersion ?? "2025-11-25",
    ...(options.sessionId ? { "mcp-session-id": options.sessionId } : {}),
    ...options.headers,
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${base}/mcp`, { method: options.method ?? "POST", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}

describe("MCP workbench over the official HTTP client", () => {
  it("initializes, lists tools/resources and reads queue entries without consuming another visitor's data", async () => {
    const app = await start();
    const owner = app.service.bootstrapOwner();
    const agent = app.service.createVisitor(owner.visitor.id, "agent", "Agent");
    const human = await connect(owner.token);
    const external = await connect(agent.token);
    expect(human.transport.sessionId).toBeDefined();
    expect(external.transport.sessionId).not.toBe(human.transport.sessionId);
    const listed = await human.client.listTools();
    expect(listed.tools.find(tool => tool.name === "visitor_me")?.annotations).toMatchObject({readOnlyHint: true, destructiveHint: false});
    expect(listed.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(["visitor_me", "queue_list", "queue_append", "queue_mark_read", "todo_list", "resource_acquire", "session_cancel"]));
    expect((await human.client.listResources()).resources.map(item => item.uri)).toContain("devshell://workbench");
    expect((await call<Visitor>(external.client, "visitor_me")).id).toBe(agent.visitor.id);
    const queued = await call<QueueItem>(external.client, "queue_append", { clientMessageId: "shared", body: "Inspect this element" });
    await call(external.client, "queue_mark_read", { queueItemId: queued.id });
    expect((await call<QueueItem[]>(human.client, "queue_list")).map(item => item.id)).toContain(queued.id);
    expect((await resource<QueueItem[]>(external.client, "devshell://queue"))[0]).toMatchObject({ id: queued.id, status: "queued" });
    const snapshot = await resource<WorkbenchSnapshot>(human.client, "devshell://workbench");
    expect(snapshot.streamCursor).toBeDefined();
    expect(snapshot.queue[0].id).toBe(queued.id);
    expect(JSON.stringify(snapshot)).not.toContain(agent.token);
  });

  it("enforces direct-message privacy, todo ownership and advisory lease conflicts across three identities", async () => {
    const app = await start();
    const owner = app.service.bootstrapOwner();
    const alice = app.service.createVisitor(owner.visitor.id, "agent", "Alice");
    const bob = app.service.createVisitor(owner.visitor.id, "agent", "Bob");
    const human = (await connect(owner.token)).client;
    const a = (await connect(alice.token)).client;
    const b = (await connect(bob.token)).client;
    const direct = await call<Message>(human, "message_send", { kind: "direct", recipientIds: [alice.visitor.id], body: "Only Alice can read this" });
    expect((await call<Message[]>(a, "message_list")).map(message => message.id)).toContain(direct.id);
    expect(JSON.stringify(await resource(b, "devshell://messages"))).not.toContain(direct.body);
    expect(JSON.stringify(await call(b, "activity_list"))).not.toContain(direct.body);
    const list = await call<TodoList>(a, "todo_create_list", { title: "Alice tasks" });
    const item = await call<TodoItem>(a, "todo_create_item", { listId: list.id, body: "Edit the preview" });
    await denied(b, "todo_update_item", { itemId: item.id, expectedRevision: 1, status: "done" });
    expect((await call<TodoItem>(a, "todo_update_item", { itemId: item.id, expectedRevision: 1, status: "done" })).status).toBe("done");
    const acquired = await call<{lease: ResourceLease}>(a, "resource_acquire", { resource: "src/preview.tsx", mode: "exclusive", purpose: "edit" });
    await denied(b, "resource_acquire", { resource: acquired.lease.resource, mode: "exclusive", purpose: "edit" });
    const waiting = await call<{lease: null; waiter: ResourceWaiter; conflicts: ResourceLease[]}>(b, "resource_wait", { resource: acquired.lease.resource, mode: "exclusive", purpose: "next" });
    expect(waiting.lease).toBeNull(); expect(waiting.conflicts[0].id).toBe(acquired.lease.id);
    await denied(b, "resource_release", { leaseId: acquired.lease.id });
    await call(a, "resource_release", { leaseId: acquired.lease.id });
    await call(b, "resource_cancel_wait", { waiterId: waiting.waiter.id });
    expect((await call<{lease: ResourceLease}>(b, "resource_acquire", { resource: acquired.lease.resource, mode: "exclusive", purpose: "now edit" })).lease.ownerId).toBe(bob.visitor.id);
  });

  it("binds session headers to a visitor and refuses agent batch dispatch or cancellation", async () => {
    const app = await start();
    const owner = app.service.bootstrapOwner();
    const agent = app.service.createVisitor(owner.visitor.id, "agent", "Agent");
    const human = await connect(owner.token);
    const external = await connect(agent.token);
    const crossed = await request(agent.token, { sessionId: human.transport.sessionId, body: { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} } });
    expect(crossed.status).toBe(403);
    const queued = app.service.enqueue(owner.visitor.id, { clientMessageId: "queued", body: "Safe test task" });
    await denied(external.client, "queue_send_batch", { queueItemIds: [queued.id], clientMessageId: "forbidden" });
    expect(app.service.getQueue(queued.id).status).toBe("queued");
    const {session} = app.service.createSession(owner.visitor.id, { prompt: "No process should start", clientMessageId: "session", queueItemIds: [] });
    await denied(external.client, "session_cancel", { sessionId: session.id });
    expect(app.service.getSession(session.id).status).toBe("queued");
    expect(app.mcp.sessionCount).toBe(2);
  });

  it("rejects invalid Host, Origin, bearer tokens and unsupported protocol versions", async () => {
    const app = await start();
    const owner = app.service.bootstrapOwner();
    const connection = await connect(owner.token);
    const body = { jsonrpc: "2.0", id: 99, method: "tools/list", params: {} };
    // Node fetch normalizes the Host header; use the HTTP API to send the
    // DNS-rebinding fixture's actual wire-level Host value.
    const badHost = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${base}/mcp`, { method: "POST", headers: { host: "attacker.invalid", authorization: `Bearer ${owner.token}`, "content-type": "application/json" } }, response => {
        response.resume(); response.once("end", () => resolve(response.statusCode));
      });
      request.once("error", reject); request.end(JSON.stringify(body));
    });
    expect(badHost).toBe(403);
    expect((await request(owner.token, { headers: { origin: "https://attacker.invalid" }, body })).status).toBe(403);
    expect((await request("invalid-token", { sessionId: connection.transport.sessionId, body })).status).toBe(401);
    expect((await request(owner.token, { sessionId: connection.transport.sessionId, protocolVersion: "invalid-version", body })).status).toBe(400);
    expect((await request(owner.token, { sessionId: "missing-session", body })).status).toBe(404);
    expect(app.mcp.sessionCount).toBe(1);
  });

  it("releases transports on DELETE, visitor revocation and server shutdown", async () => {
    const app = await start();
    const owner = app.service.bootstrapOwner();
    const agent = app.service.createVisitor(owner.visitor.id, "agent", "Agent");
    const first = await connect(owner.token);
    const second = await connect(agent.token);
    expect(app.mcp.sessionCount).toBe(2);
    await first.transport.terminateSession();
    expect(app.mcp.sessionCount).toBe(1);
    app.service.revokeVisitor(owner.visitor.id, agent.visitor.id);
    await expect.poll(() => app.mcp.sessionCount).toBe(0);
    expect((await request(agent.token, { method: "GET", sessionId: second.transport.sessionId })).status).toBe(401);
    await connect(owner.token);
    expect(app.mcp.sessionCount).toBe(1);
    await app.close();
    expect(app.mcp.sessionCount).toBe(0);
  });

  it("expires idle MCP sessions without requiring a client DELETE", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const app = await start();
    const owner = app.service.bootstrapOwner();
    const connection = await connect(owner.token);
    expect(app.mcp.sessionCount).toBe(1);
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(app.mcp.sessionCount).toBe(0);
    expect((await request(owner.token, { sessionId: connection.transport.sessionId, body: { jsonrpc: "2.0", id: 100, method: "tools/list", params: {} } })).status).toBe(404);
  });
});
