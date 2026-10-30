import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDevShellServer, type DevShellServer } from "../../src/server.js";

let server: DevShellServer; let directory: string; let base: string; let token: string; let visitorId: string;
const request = async (path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers); headers.set("host", new URL(base).host);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  return fetch(`${base}${path}`, { ...init, headers });
};
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "dev-shell-http-")); token = "";
  server = createDevShellServer({ config: { port: 0, dataDir: directory, databasePath: join(directory, "test.sqlite") }, onSessionLaunch: () => {} });
  await server.listen(); base = `http://127.0.0.1:${server.config.port}`;
  const response = await request("/api/bootstrap", { method: "POST", headers: { "x-dev-shell-web": "1" }, body: JSON.stringify({ displayName: "Owner" }) });
  expect(response.status).toBe(201); const data = await response.json(); token = data.token; visitorId = data.visitor.id;
});
afterEach(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });

describe("HTTP workbench", () => {
  it("bootstraps once and provides a contract snapshot and real fixture", async () => {
    expect(visitorId).toBeDefined();
    const snapshot = await (await request("/api/bootstrap")).json();
    expect(snapshot.snapshot.settings.defaultTarget).toBe(`${base}/fixture`);
    expect(snapshot.snapshot.queue).toEqual([]);
    expect(server.service.parseStreamCursor(visitorId, snapshot.snapshot.streamCursor)).toBe(snapshot.snapshot.revision);
    const second = await request("/api/bootstrap", { method: "POST", headers: { "x-dev-shell-web": "1" }, body: "{}" }); expect(second.status).toBe(409);
    const fixture = await request("/fixture"); expect(fixture.status).toBe(200); expect(await fixture.text()).toContain("/fixture.css");
    expect((await request("/fixture.js")).status).toBe(200);
  });

  it("enforces bearer, web bootstrap header and origin protection with uniform errors", async () => {
    const unauthenticated = await request("/api/queue", { headers: { authorization: "" } }); expect(unauthenticated.status).toBe(401); expect((await unauthenticated.json()).requestId).toBeDefined();
    const bootstrap = await request("/api/bootstrap", { method: "POST", body: "{}" }); expect(bootstrap.status).toBe(403);
    const origin = await request("/api/queue", { headers: { origin: "https://evil.invalid" } }); expect(origin.status).toBe(403);
  });

  it("runs queue, messages, todos, resources and settings routes", async () => {
    const queuedResponse = await request("/api/queue", { method: "POST", body: JSON.stringify({ clientMessageId: "one", body: "Do work" }) });
    expect(queuedResponse.status).toBe(201); const queued = await queuedResponse.json();
    expect((await (await request("/api/queue")).json()).items).toHaveLength(1);
    expect((await request(`/api/queue/${queued.id}/read`, { method: "POST" })).status).toBe(204);
    const message = await request("/api/messages", { method: "POST", body: JSON.stringify({ kind: "broadcast", recipientIds: [], body: "hello" }) }); expect(message.status).toBe(201);
    const list = await (await request("/api/todos/lists", { method: "POST", body: JSON.stringify({ title: "List" }) })).json();
    const item = await (await request(`/api/todos/lists/${list.id}/items`, { method: "POST", body: JSON.stringify({ body: "Item" }) })).json();
    const patched = await request(`/api/todos/items/${item.id}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: 1, status: "done" }) }); expect(patched.status).toBe(200);
    const lease = await (await request("/api/resources/leases", { method: "POST", body: JSON.stringify({ resource: "file", mode: "exclusive", purpose: "test" }) })).json();
    expect((await request(`/api/resources/leases/${lease.lease.id}/renew`, { method: "POST", body: "{}" })).status).toBe(200);
    expect((await request(`/api/resources/leases/${lease.lease.id}/release`, { method: "POST" })).status).toBe(204);
    const settings = await request("/api/settings", { method: "PATCH", body: JSON.stringify({ theme: "dark" }) }); expect((await settings.json()).theme).toBe("dark");
    expect((await (await request("/api/activity")).json()).items.length).toBeGreaterThan(4);
  });

  it("creates independent session records and dispatches one batch", async () => {
    const first = await (await request("/api/queue", { method: "POST", body: JSON.stringify({ clientMessageId: "a", body: "A" }) })).json();
    const second = await (await request("/api/queue", { method: "POST", body: JSON.stringify({ clientMessageId: "b", body: "B" }) })).json();
    const response = await request("/api/queue/dispatch", { method: "POST", body: JSON.stringify({ queueItemIds: [first.id, second.id], clientMessageId: "batch" }) });
    expect(response.status).toBe(201); const session = await response.json(); expect(session.queueItemIds).toEqual([first.id, second.id]);
    expect((await request(`/api/sessions/${session.id}/cancel`, { method: "POST" })).status).toBe(200);
    const events = (await (await request(`/api/sessions/${session.id}/events`)).json()).items;
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({ type: "event", topic: "sessions", data: { id: session.id } });
    expect(events[0]).not.toHaveProperty("payload");
  });

  it("replays one session DTO and requires an explicit retry before redispatch", async () => {
    const first = await (await request("/api/queue", { method: "POST", body: JSON.stringify({ clientMessageId: "queue", body: "Work" }) })).json();
    const input = { queueItemIds: [first.id], clientMessageId: "batch" };
    const original = await (await request("/api/queue/dispatch", { method: "POST", body: JSON.stringify(input) })).json();
    const repeated = await (await request("/api/queue/dispatch", { method: "POST", body: JSON.stringify(input) })).json();
    expect(repeated).toEqual(original);
    expect((await request(`/api/queue/${first.id}`, { method: "DELETE" })).status).toBe(409);
    expect((await request(`/api/sessions/${original.id}/cancel`, { method: "POST" })).status).toBe(200);
    const cancelled = server.service.getQueue(first.id);
    expect(cancelled.status).toBe("cancelled");
    expect((await request(`/api/queue/${first.id}/retry`, { method: "POST" })).status).toBe(200);
    const retry = await request("/api/queue/dispatch", { method: "POST", body: JSON.stringify({ ...input, clientMessageId: "retry" }) });
    expect(retry.status).toBe(201);
    expect((await retry.json()).id).not.toBe(original.id);
  });

  it("deletes a todo list and validates activity cursors", async () => {
    const list = await (await request("/api/todos/lists", { method: "POST", body: JSON.stringify({ title: "Temporary" }) })).json();
    await request(`/api/todos/lists/${list.id}/items`, { method: "POST", body: JSON.stringify({ body: "Item" }) });
    expect((await request(`/api/todos/lists/${list.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await (await request("/api/todos/lists")).json()).items).toEqual([]);
    for (const after of ["NaN", "-1", "1.5", "9007199254740992"]) expect((await request(`/api/activity?after=${after}`)).status).toBe(400);
  });

  it("returns a separate MCP endpoint with visitor credentials and no token hash", async () => {
    const response = await request("/api/visitors", { method: "POST", body: JSON.stringify({ displayName: "External", kind: "agent" }) });
    const credentials = await response.json();
    expect(credentials.mcpUrl).toMatch(/\/mcp$/);
    expect(credentials.token).toHaveLength(43);
    expect(JSON.stringify(credentials)).not.toContain("tokenHash");
    expect(credentials.mcpUrl).not.toContain(credentials.token);
  });
});
