import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Visitor } from "@hustradio/dev-shell-contract";
import { createDevShellMcpServer } from "./server.js";
import type { MaybePromise, McpServices } from "./service.js";

interface SessionRecord {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  visitorId: string;
  lastSeenAt: number;
}

export interface McpHttpGatewayOptions {
  services: McpServices;
  authenticate: (token: string | undefined) => MaybePromise<Visitor | null>;
  allowedOrigins?: string[];
  allowedHosts?: string[];
  idleTimeoutMs?: number;
}

export class McpHttpGateway {
  readonly #options: McpHttpGatewayOptions;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #sweeper: NodeJS.Timeout;
  #closed = false;

  constructor(options: McpHttpGatewayOptions) {
    this.#options = options;
    this.#sweeper = setInterval(() => {
      const cutoff = Date.now() - (this.#options.idleTimeoutMs ?? 30 * 60_000);
      for (const [sessionId, session] of this.#sessions) {
        if (session.lastSeenAt < cutoff) void this.#closeSession(sessionId, session);
      }
    }, 60_000);
    this.#sweeper.unref();
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  handler = async (req: Request, res: Response): Promise<void> => {
    if (this.#closed) {
      res.status(503).json({ error: "MCP server is shutting down" });
      return;
    }
    if (!this.#headersAllowed(req)) {
      res.status(403).json({ error: "Host or Origin is not allowed" });
      return;
    }
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    const visitor = await Promise.resolve().then(() => this.#options.authenticate(token)).catch(() => null);
    if (!visitor || visitor.revokedAt) {
      res.status(401).json({ error: "Valid Bearer visitor token required" });
      return;
    }
    if (!['POST', 'GET', 'DELETE'].includes(req.method ?? "POST")) {
      res.status(405).json({ error: "Unsupported MCP method" });
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const normalizedSessionId = Array.isArray(sessionId) ? sessionId[0] : sessionId;
    if (normalizedSessionId) {
      const session = this.#sessions.get(normalizedSessionId);
      if (!session) {
        res.status(404).json({ error: "MCP session not found" });
        return;
      }
      if (session.visitorId !== visitor.id) {
        res.status(403).json({ error: "MCP session belongs to another visitor" });
        return;
      }
      session.lastSeenAt = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }
    if (req.method !== "POST" || !isInitializeRequest(req.body)) {
      res.status(400).json({ error: "Mcp-Session-Id is required" });
      return;
    }

    const server = createDevShellMcpServer(visitor, this.#options.services);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: false,
      retryInterval: 1_000,
      keepAliveMs: 15_000,
      maxRequestBodySize: 4 * 1024 * 1024,
      onsessioninitialized: (initializedId) => {
        this.#sessions.set(initializedId, {
          server,
          transport,
          visitorId: visitor.id,
          lastSeenAt: Date.now(),
        });
      },
      onsessionclosed: (closedId) => {
        const session = this.#sessions.get(closedId);
        this.#sessions.delete(closedId);
        if (session) void session.server.close().catch(() => undefined);
      },
    });
    try {
      await server.connect(transport);
      const previousOnClose = transport.onclose;
      transport.onclose = () => {
        previousOnClose?.();
        if (transport.sessionId) this.#sessions.delete(transport.sessionId);
      };
      await transport.handleRequest(req, res, req.body);
      if (!transport.sessionId) {
        await server.close();
      }
    } catch {
      if (transport.sessionId) this.#sessions.delete(transport.sessionId);
      await server.close().catch(() => undefined);
      if (!res.headersSent) {
        res.status(500).json({
          error: "MCP request failed",
          requestId: randomUUID(),
        });
      }
    }
  };

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#sweeper);
    await Promise.allSettled(
      [...this.#sessions.entries()].map(([sessionId, session]) => this.#closeSession(sessionId, session)),
    );
    this.#sessions.clear();
  }

  async revokeVisitor(visitorId: string): Promise<void> {
    await Promise.allSettled([...this.#sessions.entries()]
      .filter(([, session]) => session.visitorId === visitorId)
      .map(([id, session]) => this.#closeSession(id, session)));
  }

  #headersAllowed(req: Request): boolean {
    const host = req.headers.host;
    if (!host || (this.#options.allowedHosts?.length && !this.#options.allowedHosts.includes(host))) {
      return false;
    }
    const origin = req.headers.origin;
    if (origin && this.#options.allowedOrigins?.length && !this.#options.allowedOrigins.includes(origin)) {
      return false;
    }
    return true;
  }

  async #closeSession(sessionId: string, session: SessionRecord): Promise<void> {
    this.#sessions.delete(sessionId);
    await session.server.close();
  }
}
