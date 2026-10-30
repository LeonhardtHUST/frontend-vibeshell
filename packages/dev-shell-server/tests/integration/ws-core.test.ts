import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@hustradio/dev-shell-contract";
import { createDevShellServer, type DevShellServer } from "../../src/server.js";

let server: DevShellServer; let directory: string; let url: string; let token: string; let streamCursor: string;
interface Inbox { messages: any[]; waiter?: (value: any) => void }
const inboxes = new Map<WebSocket, Inbox>();
const openSocket = async () => {
  const socket = new WebSocket(url);
  const inbox: Inbox = { messages: [] }; inboxes.set(socket, inbox);
  socket.on("message", data => {
    const message = JSON.parse(data.toString());
    if (inbox.waiter) { const waiter = inbox.waiter; inbox.waiter = undefined; waiter(message); }
    else inbox.messages.push(message);
  });
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return socket;
};
const next = (socket: WebSocket): Promise<any> => {
  const inbox = inboxes.get(socket)!;
  if (inbox.messages.length) return Promise.resolve(inbox.messages.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { inbox.waiter = undefined; reject(new Error("Timed out waiting for websocket frame")); }, 3000);
    inbox.waiter = value => { clearTimeout(timer); resolve(value); };
  });
};
const history = async (socket: WebSocket, cursor: string | null) => {
  socket.send(JSON.stringify({ type: "history", streamCursor: cursor }));
  const frames: any[] = [];
  do { frames.push(await next(socket)); } while (frames.at(-1).type !== "completed");
  return frames;
};
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "dev-shell-ws-")); server = createDevShellServer({ config: { port: 0, dataDir: directory, databasePath: join(directory, "test.sqlite") } }); await server.listen();
  url = `ws://127.0.0.1:${server.config.port}/api/events`;
  const owner = server.service.bootstrapOwner(); token = owner.token; streamCursor = owner.snapshot.streamCursor;
});
afterEach(async () => { vi.restoreAllMocks(); for (const socket of inboxes.keys()) socket.terminate(); inboxes.clear(); await server.close(); rmSync(directory, { recursive: true, force: true }); });
const authenticated = async (accessToken = token) => { const socket = await openSocket(); socket.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, token: accessToken })); expect((await next(socket)).type).toBe("hello.ok"); return socket; };

describe("EventsGateway", () => {
  it("requires first-message hello authentication", async () => {
    const socket = await openSocket(); const response = next(socket); socket.send(JSON.stringify({ type: "history", streamCursor: null }));
    expect((await response).code).toBe("HELLO_REQUIRED"); socket.close();
  });

  it("does not replay old events on first connect and sends live events only after completed", async () => {
    const socket = await authenticated();
    const frames = await history(socket, streamCursor);
    expect(frames[0]).toMatchObject({ type: "history", events: [] });
    const eventPromise = next(socket); server.service.sendMessage(server.service.listVisitors()[0].id, { kind: "broadcast", recipientIds: [], body: "live" });
    const event = await eventPromise; expect(event.type).toBe("event"); expect(event.replay).toBe(false); expect(event.data.body).toBe("live"); socket.close();
  });

  it("replays from an event cursor with replay envelopes and global sequences", async () => {
    const ownerId = server.service.listVisitors()[0].id;
    server.service.sendMessage(ownerId, { kind: "broadcast", recipientIds: [], body: "history" });
    const socket = await authenticated(); const framePromise = next(socket);
    socket.send(JSON.stringify({ type: "history", streamCursor }));
    const frame = await framePromise; expect(frame.type).toBe("history"); expect(frame.events[0].replay).toBe(true); expect(frame.events[0].data.body).toBe("history");
    expect((await next(socket)).type).toBe("completed"); socket.close();
  });

  it("requires snapshot resync for unknown cursors", async () => {
    const socket = await authenticated(); const resyncPromise = next(socket);
    socket.send(JSON.stringify({ type: "history", streamCursor: "invalid-cursor" }));
    const resync = await resyncPromise; expect(resync.type).toBe("resync.required"); expect(resync.snapshot.settings).toBeDefined();
    expect((await next(socket)).type).toBe("completed"); socket.close();
  });

  it("resynchronizes a null cursor instead of skipping writes between snapshot and connection", async () => {
    const ownerId = server.service.listVisitors()[0].id;
    server.service.enqueue(ownerId, { clientMessageId: "race", body: "Created after initial snapshot" });
    const socket = await authenticated();
    const frames = await history(socket, streamCursor);
    expect(frames[0].events.map((event: any) => event.data.body)).toContain("Created after initial snapshot");
    const fresh = await authenticated();
    const resync = await history(fresh, null);
    expect(resync[0].type).toBe("resync.required");
    expect(resync[0].snapshot.queue[0].body).toBe("Created after initial snapshot");
    expect(resync.at(-1).streamCursor).toBe(resync[0].snapshot.streamCursor);
  });

  it("advances over hidden messages without exposing bodies and binds cursors to visitors", async () => {
    const ownerId = server.service.listVisitors()[0].id;
    const other = server.service.createVisitor(ownerId, "human", "Other");
    const snapshot = server.service.snapshot(other.visitor.id);
    server.service.sendMessage(ownerId, { kind: "direct", recipientIds: [ownerId], body: "private body" });
    const publicMessage = server.service.sendMessage(ownerId, { kind: "broadcast", recipientIds: [], body: "public body" });
    const socket = await authenticated(other.token);
    const frames = await history(socket, snapshot.streamCursor);
    expect(JSON.stringify(frames)).not.toContain("private body");
    expect(frames[0].events.map((event: any) => event.entityId)).toEqual([publicMessage.id]);
    const watermark = frames.at(-1).streamCursor;
    expect(server.service.parseStreamCursor(other.visitor.id, watermark)).toBe(server.store.latestEvent()!.sequence);
    const wrongVisitor = await history(socket, streamCursor);
    expect(wrongVisitor[0].type).toBe("resync.required");
    const liveWatermark = next(socket);
    server.service.sendMessage(ownerId, { kind: "direct", recipientIds: [ownerId], body: "another private body" });
    const hidden = await liveWatermark;
    expect(hidden).toMatchObject({ type: "history", events: [] });
    expect(JSON.stringify(hidden)).not.toContain("private");
  });

  it("buffers writes during replay and emits them once after the completion barrier", async () => {
    const ownerId = server.service.listVisitors()[0].id;
    server.service.sendMessage(ownerId, { kind: "broadcast", recipientIds: [], body: "replayed" });
    const readEvents = server.store.eventsAfter.bind(server.store);
    vi.spyOn(server.store, "eventsAfter").mockImplementationOnce((after, limit) => {
      const rows = readEvents(after, limit);
      server.service.sendMessage(ownerId, { kind: "broadcast", recipientIds: [], body: "buffered live" });
      return rows;
    });
    const socket = await authenticated();
    const frames = await history(socket, streamCursor);
    expect(frames[0].events[0].data.body).toBe("replayed");
    const live = await next(socket);
    expect(live).toMatchObject({ type: "event", replay: false, data: { body: "buffered live" } });
    expect((await next(socket)).type).toBe("history");
  });

  it("uses an authorized snapshot when replay exceeds 500 events", async () => {
    server.store.transaction(() => {
      for (let index = 0; index < 501; index++) server.store.appendEvent("activity", null, String(index), { index });
    });
    const socket = await authenticated();
    const frames = await history(socket, streamCursor);
    expect(frames[0]).toMatchObject({ type: "resync.required", reason: "cursor-too-old" });
    expect(frames.at(-1).streamCursor).toBe(frames[0].snapshot.streamCursor);
  });

  it("closes an already authenticated connection immediately when access is revoked", async () => {
    const ownerId = server.service.listVisitors()[0].id;
    const other = server.service.createVisitor(ownerId, "agent", "Other");
    const socket = await authenticated(other.token);
    await history(socket, server.service.snapshot(other.visitor.id).streamCursor);
    const closed = new Promise<number>(resolve => socket.once("close", resolve));
    server.service.revokeVisitor(ownerId, other.visitor.id);
    expect(await next(socket)).toMatchObject({ type: "error", code: "UNAUTHORIZED" });
    expect(await closed).toBe(1008);
  });

  it("ignores queued pong frames during revocation without throwing from the websocket emitter", async () => {
    const ownerId = server.service.listVisitors()[0].id;
    const other = server.service.createVisitor(ownerId, "agent", "Other");
    const socket = await authenticated(other.token);
    await history(socket, server.service.snapshot(other.visitor.id).streamCursor);
    const serverSocket = [...server.gateway.wss.clients][0];
    const queuedListener = serverSocket.listeners("message")[0];
    const payload = Buffer.from(JSON.stringify({type: "pong"}));
    const closed = new Promise<number>(resolve => socket.once("close", resolve));
    expect(() => {
      server.service.revokeVisitor(ownerId, other.visitor.id);
      // Exercise both a late socket emission and an already queued callback.
      serverSocket.emit("message", payload);
      queuedListener.call(serverSocket, payload);
    }).not.toThrow();
    expect(await closed).toBe(1008);
    expect(serverSocket.listenerCount("message")).toBe(0);
    const response = await fetch(`http://127.0.0.1:${server.config.port}/api/health`);
    expect(response.status).toBe(200);
  });
});
