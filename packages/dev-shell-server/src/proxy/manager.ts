import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import httpProxy from "http-proxy";
import {
  bridgeToParentSchema,
  type BridgeToParentMessage,
  type FrameInfo,
} from "@hustradio/dev-shell-contract";
import { ProxyError, sendProxyError } from "./errors.js";
import { BRIDGE_PATH, handleProxyResponse } from "./http-transform.js";
import { FrameCookieJar } from "./cookie-jar.js";
import {
  createTargetAgent,
  resolveTargetAddresses,
  validateTargetUrl,
  type AllowOrigin,
} from "./target-policy.js";

const BOOTSTRAP_PATH = "/__dev_shell_bootstrap";
const BRIDGE_SOURCE = readFileSync(new URL("./bridge.js", import.meta.url), "utf8");
const REQUEST_TIMEOUT = 30_000;
const BRIDGE_READY_TIMEOUT = 15_000;

export interface FrameManagerOptions {
  allowOrigin: AllowOrigin;
  onChange?: (frame: FrameInfo) => void;
  parentOrigin?: string | (() => string);
  longPressMs?: number | (() => number);
}

type Proxy = ReturnType<typeof httpProxy.createProxyServer>;

interface FrameRuntime {
  target: URL;
  proxyOrigin: string;
  cookieName: string;
  cookieValue: string;
  ticket: string | null;
  parentOrigin: string | null;
  jar: FrameCookieJar;
  closed: boolean;
  server: http.Server;
  proxy: Proxy;
  agent: http.Agent;
  sockets: Set<Socket>;
  targetSockets: Set<Socket>;
  readyTimer: NodeJS.Timeout;
}

interface FrameRecord {
  info: FrameInfo;
  runtime?: FrameRuntime;
}

function now(): string {
  return new Date().toISOString();
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function secretsEqual(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function authenticated(request: IncomingMessage, runtime: FrameRuntime): boolean {
  return secretsEqual(cookieValue(request, runtime.cookieName), runtime.cookieValue);
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n`);
  }
  socket.destroy();
}

function trackTargetRequest(request: http.ClientRequest, runtime: FrameRuntime): void {
  request.on("socket", (socket) => {
    runtime.targetSockets.add(socket);
    socket.once("close", () => runtime.targetSockets.delete(socket));
  });
}

function stripSensitiveHeaders(
  request: http.ClientRequest,
  incoming: IncomingMessage,
  runtime: FrameRuntime,
  websocket: boolean,
): void {
  const connectionTokens = (incoming.headers.connection ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const hopByHop = websocket
    ? ["proxy-connection", "proxy-authorization"]
    : [
        "proxy-connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        ...connectionTokens,
        "connection",
        "upgrade",
      ];
  for (const name of new Set(hopByHop)) request.removeHeader(name);
  request.removeHeader("authorization");
  request.removeHeader("proxy-authorization");

  const cookies = runtime.jar.header(new URL(incoming.url ?? "/", runtime.target.origin));
  if (cookies) request.setHeader("cookie", cookies);
  else request.removeHeader("cookie");

  if (request.hasHeader("origin")) request.setHeader("origin", runtime.target.origin);
  const referer = incoming.headers.referer;
  request.removeHeader("referer");
  if (referer) {
    try {
      const url = new URL(referer);
      if (url.origin === runtime.proxyOrigin && url.pathname !== BOOTSTRAP_PATH) {
        request.setHeader("referer", `${runtime.target.origin}${url.pathname}${url.search}`);
      }
    } catch {
      request.removeHeader("referer");
    }
  }
}

export class FrameManager {
  private readonly frames = new Map<string, FrameRecord>();
  private readonly allowOrigin: AllowOrigin;
  private readonly onChange?: (frame: FrameInfo) => void;
  private readonly options: FrameManagerOptions;

  constructor(options: FrameManagerOptions) {
    const { allowOrigin, onChange } = options;
    this.options = options;
    this.allowOrigin = allowOrigin;
    this.onChange = onChange;
  }

  async createFrame(targetUrl: string, parentOriginOverride?: string): Promise<FrameInfo> {
    const target = await validateTargetUrl(targetUrl, this.allowOrigin);
    const addresses = await resolveTargetAddresses(target);
    const configuredParent = parentOriginOverride ?? (typeof this.options.parentOrigin === "function" ? this.options.parentOrigin() : this.options.parentOrigin);
    const parent = configuredParent ? new URL(configuredParent) : null;
    if (parent && (!/^https?:$/.test(parent.protocol) || parent.username || parent.password || parent.origin !== configuredParent)) {
      throw new ProxyError(400, "INVALID_PARENT_ORIGIN", "The shell parent must be an exact HTTP(S) origin.");
    }
    const frameId = randomUUID();
    const cookieValue = randomBytes(32).toString("base64url");
    const runtime = {} as FrameRuntime;
    const sockets = new Set<Socket>();
    const targetSockets = new Set<Socket>();
    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response, runtime);
    });
    const proxy = httpProxy.createProxyServer();
    const agent = createTargetAgent(target.protocol as "http:" | "https:", addresses.map(entry => entry.address));

    Object.assign(runtime, {
      target,
      cookieName: `__dev_shell_${frameId.replaceAll("-", "")}`,
      cookieValue,
      ticket: randomBytes(32).toString("base64url"),
      parentOrigin: parent?.origin ?? null,
      jar: new FrameCookieJar(),
      closed: false,
      server,
      proxy,
      agent,
      sockets,
      targetSockets,
    });

    server.requestTimeout = REQUEST_TIMEOUT;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head, runtime);
    });

    proxy.on("proxyReq", (proxyRequest, request) => {
      stripSensitiveHeaders(proxyRequest, request, runtime, false);
      trackTargetRequest(proxyRequest, runtime);
      proxyRequest.setTimeout(REQUEST_TIMEOUT, () => {
        proxyRequest.destroy(new ProxyError(504, "UPSTREAM_TIMEOUT", "The target request timed out."));
      });
    });
    proxy.on("proxyReqWs", (proxyRequest, request) => {
      stripSensitiveHeaders(proxyRequest, request, runtime, true);
      trackTargetRequest(proxyRequest, runtime);
      const captureCookies = (upstream: IncomingMessage) => {
        runtime.jar.accept(upstream.headers["set-cookie"], new URL(request.url ?? "/", runtime.target.origin));
        delete upstream.headers["set-cookie"];
      };
      // http-proxy registers its upgrade writer after proxyReqWs, so cookies
      // are captured before it serializes the upstream handshake headers.
      proxyRequest.on("upgrade", captureCookies);
      proxyRequest.on("response", captureCookies);
    });
    proxy.on("proxyRes", (proxyResponse, request, response) => {
      const targetRequest = new URL(request.url ?? "/", runtime.target.origin);
      runtime.jar.accept(proxyResponse.headers["set-cookie"], targetRequest);
      void handleProxyResponse(
        proxyResponse,
        response,
        targetRequest,
        runtime.proxyOrigin,
        this.allowOrigin,
      );
    });
    proxy.on("error", (error, _request, output) => {
      if (output instanceof http.ServerResponse) {
        sendProxyError(output, error);
      } else {
        rejectUpgrade(output, 502, "Bad Gateway");
      }
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      agent.destroy();
      proxy.removeAllListeners();
      throw error;
    }

    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      agent.destroy();
      throw new Error("The frame proxy did not expose a TCP port.");
    }
    runtime.proxyOrigin = `http://127.0.0.1:${address.port}`;
    const createdAt = now();
    const info: FrameInfo = {
      frameId,
      targetUrl: target.href,
      currentUrl: target.href,
      proxyOrigin: runtime.proxyOrigin,
      bootstrapUrl: `${runtime.proxyOrigin}${BOOTSTRAP_PATH}?ticket=${runtime.ticket}`,
      title: "",
      status: "bootstrapping",
      bridgeReady: false,
      detail: null,
      createdAt,
      updatedAt: createdAt,
    };
    runtime.readyTimer = setTimeout(() => {
      const record = this.frames.get(frameId);
      if (record?.info.status === "bootstrapping") {
        this.update(record, {
          status: "degraded",
          detail: "The preview is available, but the picker bridge is not ready.",
        });
      }
    }, BRIDGE_READY_TIMEOUT);
    runtime.readyTimer.unref();
    this.frames.set(frameId, { info, runtime });
    this.notify(info);
    return { ...info };
  }

  getFrame(id: string): FrameInfo | undefined {
    const frame = this.frames.get(id)?.info;
    return frame ? { ...frame } : undefined;
  }

  listFrames(): FrameInfo[] {
    return [...this.frames.values()].filter(record => record.runtime).map(record => ({ ...record.info }));
  }

  handleBridgeMessage(message: BridgeToParentMessage): FrameInfo {
    const parsed = bridgeToParentSchema.parse(message);
    const record = this.frames.get(parsed.frameId);
    if (!record?.runtime) throw new ProxyError(404, "FRAME_NOT_FOUND", "The frame is not active.");

    if (parsed.type === "bridge.ready" || parsed.type === "bridge.frame.info") {
      const url = new URL(parsed.url);
      if (url.origin !== record.runtime.target.origin) {
        throw new ProxyError(400, "FRAME_URL_MISMATCH", "The bridge URL does not match the target.");
      }
      this.update(record, {
        currentUrl: url.href,
        title: parsed.title,
        ...(parsed.type === "bridge.ready"
          ? { status: "ready" as const, bridgeReady: true, detail: null }
          : {}),
      });
    } else if (parsed.type === "bridge.error") {
      this.update(record, {
        status: "degraded",
        bridgeReady: false,
        detail: `${parsed.code}: ${parsed.message}`,
      });
    }
    return { ...record.info };
  }

  async closeFrame(id: string): Promise<void> {
    const record = this.frames.get(id);
    if (!record?.runtime) return;
    const runtime = record.runtime;
    runtime.closed = true;
    runtime.ticket = null;
    runtime.jar.clear();
    record.runtime = undefined;
    clearTimeout(runtime.readyTimer);
    this.update(record, { status: "closed", bridgeReady: false, detail: null });

    for (const socket of runtime.targetSockets) socket.destroy();
    for (const socket of runtime.sockets) socket.destroy();
    runtime.agent.destroy();
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.frames.keys()].map((id) => this.closeFrame(id)));
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
    runtime: FrameRuntime,
  ): Promise<void> {
    try {
      const requestUrl = new URL(request.url ?? "/", runtime.proxyOrigin);
      this.validateRequest(request, requestUrl, runtime);
      if (requestUrl.pathname === BOOTSTRAP_PATH) {
        this.bootstrap(request, response, requestUrl, runtime);
        return;
      }
      if (!authenticated(request, runtime)) {
        throw new ProxyError(403, "FRAME_AUTH_REQUIRED", "A valid frame cookie is required.");
      }
      if (requestUrl.pathname === BRIDGE_PATH) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          throw new ProxyError(405, "METHOD_NOT_ALLOWED", "Only GET is supported.");
        }
        const configuredDelay = typeof this.options.longPressMs === "function" ? this.options.longPressMs() : this.options.longPressMs;
        const delay = Math.max(200, Math.min(2_000, Number(configuredDelay) || 500));
        const body = `(${BRIDGE_SOURCE})(${JSON.stringify(this.frameIdFor(runtime))},${JSON.stringify(runtime.target.origin)},${JSON.stringify(runtime.parentOrigin)},${delay});`;
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/javascript; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "x-content-type-options": "nosniff",
        });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }

      await validateTargetUrl(runtime.target, this.allowOrigin);
      if (runtime.closed) throw new ProxyError(410, "FRAME_CLOSED", "The frame is closed.");
      request.url = `${requestUrl.pathname}${requestUrl.search}`;
      runtime.proxy.web(request, response, {
        target: runtime.target.origin,
        changeOrigin: true,
        selfHandleResponse: true,
        agent: runtime.agent,
      });
    } catch (error) {
      sendProxyError(response, error);
    }
  }

  private bootstrap(
    request: IncomingMessage,
    response: ServerResponse,
    requestUrl: URL,
    runtime: FrameRuntime,
  ): void {
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new ProxyError(405, "METHOD_NOT_ALLOWED", "Only GET is supported.");
    }
    const ticket = requestUrl.searchParams.get("ticket");
    if (!runtime.ticket || !secretsEqual(ticket ?? undefined, runtime.ticket)) {
      throw new ProxyError(403, "INVALID_BOOTSTRAP_TICKET", "The bootstrap ticket is invalid or used.");
    }
    runtime.ticket = null;
    const destination = `${runtime.target.pathname}${runtime.target.search}${runtime.target.hash}`;
    response.writeHead(302, {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      location: destination,
      "set-cookie": `${runtime.cookieName}=${runtime.cookieValue}; HttpOnly; SameSite=Strict; Path=/`,
    });
    response.end();
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    runtime: FrameRuntime,
  ): Promise<void> {
    try {
      const requestUrl = new URL(request.url ?? "/", runtime.proxyOrigin);
      this.validateRequest(request, requestUrl, runtime);
      if (!authenticated(request, runtime)) {
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }
      await validateTargetUrl(runtime.target, this.allowOrigin);
      if (runtime.closed) { rejectUpgrade(socket, 410, "Gone"); return; }
      if (requestUrl.pathname === BOOTSTRAP_PATH || requestUrl.pathname === BRIDGE_PATH) {
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }
      request.url = `${requestUrl.pathname}${requestUrl.search}`;
      runtime.proxy.ws(request, socket, head, {
        target: runtime.target.origin,
        changeOrigin: true,
        agent: runtime.agent,
        ws: true,
      });
    } catch {
      rejectUpgrade(socket, 403, "Forbidden");
    }
  }

  private validateRequest(request: IncomingMessage, url: URL, runtime: FrameRuntime): void {
    if (runtime.closed) throw new ProxyError(410, "FRAME_CLOSED", "The frame is closed.");
    if (request.headers.host !== new URL(runtime.proxyOrigin).host || url.origin !== runtime.proxyOrigin) {
      throw new ProxyError(403, "FRAME_HOST_FORBIDDEN", "The frame proxy Host is not allowed.");
    }
    const origin = request.headers.origin;
    if (origin && origin !== runtime.proxyOrigin && origin !== runtime.parentOrigin) {
      throw new ProxyError(403, "FRAME_ORIGIN_FORBIDDEN", "The frame request Origin is not allowed.");
    }
  }

  private frameIdFor(runtime: FrameRuntime): string {
    for (const [frameId, record] of this.frames) {
      if (record.runtime === runtime) return frameId;
    }
    throw new ProxyError(404, "FRAME_NOT_FOUND", "The frame is not active.");
  }

  private update(record: FrameRecord, patch: Partial<FrameInfo>): void {
    Object.assign(record.info, patch, { updatedAt: now() });
    this.notify(record.info);
  }

  private notify(frame: FrameInfo): void {
    try {
      this.onChange?.({ ...frame });
    } catch {
      // Observers must not interrupt frame lifecycle cleanup.
    }
  }
}
