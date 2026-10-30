import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { clientWsMessageSchema, PROTOCOL_VERSION } from "@hustradio/dev-shell-contract";
import type { ServerConfig } from "../config.js";
import { eventEnvelope, type StoredEvent } from "../db/database.js";
import type { WorkbenchService } from "../domain/workbench.js";
import { validateHostOrigin } from "../http/security.js";
import { DomainError } from "../domain/errors.js";

interface ClientState {
  socket: WebSocket;
  visitorId?: string;
  live: boolean;
  replaying: boolean;
  cursor: number;
  buffered: StoredEvent[];
  lastSeen: number;
  unsubscribe?: () => void;
  unsubscribeMessage?: () => void;
  authTimer: NodeJS.Timeout;
}

export class EventsGateway {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly clients = new Set<ClientState>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly unsubscribeRevocations: () => void;
  constructor(private readonly service: WorkbenchService, private readonly config: ServerConfig) {
    this.wss.on("connection", socket => this.connect(socket));
    this.unsubscribeRevocations = service.subscribeRevocations(visitorId => {
      for (const state of this.clients) if (state.visitorId === visitorId) {
        this.send(state.socket, { type: "error", code: "UNAUTHORIZED", message: "Visitor access was revoked" });
        state.socket.close(1008, "Access revoked"); this.cleanup(state);
      }
    });
    this.heartbeat = setInterval(() => this.pulse(), 30_000);
    this.heartbeat.unref();
  }

  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/events") return false;
    try {
      if (url.search) throw new Error("Websocket options must be sent in protocol frames");
      validateHostOrigin(this.config, { host: request.headers.host, origin: request.headers.origin });
      this.wss.handleUpgrade(request, socket, head, ws => this.wss.emit("connection", ws, request));
    } catch { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); }
    return true;
  }

  private connect(socket: WebSocket): void {
    const state: ClientState = { socket, live: false, replaying: false, cursor: 0, buffered: [], lastSeen: Date.now(), authTimer: setTimeout(() => { this.send(socket, { type: "error", code: "AUTH_TIMEOUT", message: "hello authentication timed out" }); socket.close(1008, "Authentication timeout"); }, 5_000) };
    state.authTimer.unref();
    this.clients.add(state);
    const receive = (data: import("ws").RawData) => {
      // A queued frame may arrive during the asynchronous close handshake.
      if (!this.clients.has(state)) return;
      state.lastSeen = Date.now();
      try { this.onMessage(state, data.toString()); }
      catch (error) {
        this.send(socket, {type: "error", code: error instanceof DomainError ? error.code : "INTERNAL_ERROR", message: "This event connection is no longer available"});
        socket.close(error instanceof DomainError ? 1008 : 1011);
        this.cleanup(state);
      }
    };
    socket.on("message", receive);
    state.unsubscribeMessage = () => socket.off("message", receive);
    socket.on("pong", () => { state.lastSeen = Date.now(); });
    socket.on("close", () => this.cleanup(state));
    socket.on("error", () => this.cleanup(state));
  }

  private onMessage(state: ClientState, raw: string): void {
    let json: unknown;
    try { json = JSON.parse(raw); } catch { this.send(state.socket, { type: "error", code: "INVALID_JSON", message: "Invalid JSON" }); return; }
    const parsed = clientWsMessageSchema.safeParse(json);
    if (!parsed.success) { this.send(state.socket, { type: "error", code: "VALIDATION_ERROR", message: "Invalid websocket message" }); return; }
    const message = parsed.data;
    if (!state.visitorId) {
      if (message.type !== "hello") { this.send(state.socket, { type: "error", code: "HELLO_REQUIRED", message: "hello must be the first message" }); state.socket.close(1008); return; }
      try {
        const auth = this.service.authenticate(message.token);
        state.visitorId = auth.visitor.id;
        clearTimeout(state.authTimer);
        const latest = this.service.store.latestEvent();
        state.cursor = latest?.sequence ?? 0;
        state.unsubscribe = this.service.store.subscribe(event => this.onEvent(state, event));
        this.send(state.socket, { type: "hello.ok", protocolVersion: PROTOCOL_VERSION, visitorId: auth.visitor.id, latestEventId: latest?.eventId ?? null, latestSequence: latest?.sequence ?? 0 });
      } catch { this.send(state.socket, { type: "error", code: "UNAUTHORIZED", message: "Invalid or revoked token" }); state.socket.close(1008); }
      return;
    }
    if (message.type === "hello") { this.send(state.socket, { type: "error", code: "ALREADY_AUTHENTICATED", message: "Already authenticated" }); return; }
    if (message.type === "pong") { this.service.touchVisitor(state.visitorId); return; }
    if (message.type === "history") { this.history(state, message.streamCursor); }
  }

  private history(state: ClientState, streamCursor: string | null): void {
    if (state.replaying) return;
    state.replaying = true; state.live = false; state.buffered = [];
    const sequence = streamCursor === null ? null : this.service.parseStreamCursor(state.visitorId!, streamCursor);
    const latest = this.service.store.latestEvent();
    if (sequence === null) { this.resync(state, "cursor-not-found"); return; }
    if ((latest?.sequence ?? 0) - sequence > 500) { this.resync(state, "cursor-too-old"); return; }
    // Scan private rows too: hidden direct messages create legitimate global
    // sequence gaps, and must still advance this visitor's replay watermark.
    const scanned = this.service.store.eventsAfter(sequence, 500);
    const events = scanned.filter(event => this.service.eventVisible(state.visitorId!, event));
    state.cursor = scanned.at(-1)?.sequence ?? sequence;
    this.send(state.socket, { type: "history", events: events.map(event => eventEnvelope(event, true)), streamCursor: this.cursor(state) });
    this.complete(state);
  }

  private resync(state: ClientState, reason: "cursor-too-old" | "cursor-not-found"): void {
    const snapshot = this.service.snapshot(state.visitorId!);
    state.cursor = snapshot.revision;
    this.send(state.socket, { type: "resync.required", reason, snapshot });
    this.complete(state);
  }

  private complete(state: ClientState): void {
    this.send(state.socket, { type: "completed", caughtUp: true, streamCursor: this.cursor(state) });
    state.replaying = false; state.live = true;
    const buffered = state.buffered.sort((a, b) => a.sequence - b.sequence);
    state.buffered = [];
    for (const event of buffered) if (event.sequence > state.cursor) this.emitLive(state, event);
  }

  private onEvent(state: ClientState, event: StoredEvent): void {
    if (!state.visitorId) return;
    if (state.replaying || !state.live) {
      if (state.buffered.length >= 1000) { state.socket.close(1013, "Reconnect to resynchronize events"); this.cleanup(state); }
      else state.buffered.push(event);
    }
    else if (event.sequence > state.cursor) this.emitLive(state, event);
  }
  private emitLive(state: ClientState, event: StoredEvent): void {
    if (this.service.eventVisible(state.visitorId!, event)) this.send(state.socket, eventEnvelope(event, false));
    state.cursor = event.sequence;
    this.send(state.socket, { type: "history", events: [], streamCursor: this.cursor(state) });
  }
  private cursor(state: ClientState): string { return this.service.streamCursor(state.visitorId!, state.cursor); }
  private pulse(): void {
    const timestamp = Date.now();
    for (const state of this.clients) {
      if (timestamp - state.lastSeen > 60_000) { state.socket.terminate(); this.cleanup(state); continue; }
      if (state.socket.readyState === WebSocket.OPEN) this.send(state.socket, { type: "ping", at: new Date().toISOString() });
    }
  }
  private send(socket: WebSocket, message: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 4 * 1024 * 1024) { socket.close(1013, "Reconnect to resynchronize events"); return; }
    socket.send(JSON.stringify(message));
  }
  private cleanup(state: ClientState): void { clearTimeout(state.authTimer); state.unsubscribe?.(); state.unsubscribeMessage?.(); this.clients.delete(state); }
  close(): void { clearInterval(this.heartbeat); this.unsubscribeRevocations(); for (const state of this.clients) { state.socket.terminate(); this.cleanup(state); } this.wss.close(); }
}
