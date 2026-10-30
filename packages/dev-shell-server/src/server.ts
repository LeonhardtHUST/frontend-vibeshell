import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig, type ServerConfig } from "./config.js";
import { WorkbenchDatabase } from "./db/database.js";
import { WorkbenchService } from "./domain/workbench.js";
import { createHttpApp, type HttpAppOptions } from "./http/app.js";
import { EventsGateway } from "./ws/gateway.js";
import express, { Router } from "express";
import { createFrameSchema, bridgeToParentSchema } from "@leonhardthust/frontend-vibeshell-contract";
import type { AgentSession } from "@leonhardthust/frontend-vibeshell-contract";
import { bearerAuth, hostOriginGuard } from "./http/security.js";
import { DomainError } from "./domain/errors.js";
import { FrameManager } from "./proxy/manager.js";
import { CodeBuddySupervisor } from "./agent/supervisor.js";
import { McpHttpGateway } from "./mcp/http.js";
import { createMcpServices } from "./mcp/adapter.js";
import { acquireWorkbench, applyStartupSettings } from "./runtime.js";

export interface DevShellServerOptions extends Omit<HttpAppOptions, "config" | "service"> {
  config?: Partial<ServerConfig>;
  settings?: ConstructorParameters<typeof WorkbenchService>[1];
}

export function createDevShellServer(options: DevShellServerOptions = {}) {
  const config = loadConfig(options.config);
  const runtime = acquireWorkbench(config);
  let store: WorkbenchDatabase | undefined;
  try {
    store = new WorkbenchDatabase(config.databasePath);
    applyStartupSettings(store, config);
    return createLockedServer(options, config, store, runtime);
  } catch (error) { store?.close(); runtime.release(); throw error; }
}

function createLockedServer(options: DevShellServerOptions, config: ServerConfig, store: WorkbenchDatabase, runtime: ReturnType<typeof acquireWorkbench>) {
  const service = new WorkbenchService(store, options.settings ?? {
    defaultTarget: config.defaultTarget,
    allowedOrigins: config.targetAllowedOrigins,
    workspace: config.workspace,
    codebuddyExecutable: "codebuddy",
    backend: config.startupSettings.backend ?? "codebuddy",
    codexExecutable: "codex",
    opencodeExecutable: "opencode",
    model: null,
    permissionMode: "default",
    timeoutMs: 1_800_000,
    maxConcurrent: 2,
    theme: "system",
    longPressMs: 500,
  }, {workspace: config.workspace});
  const origin = () => `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${config.port}`;
  let shuttingDown = false;
  const mcpVisitorReads = new Map<string, number>();
  const sessionErrors = new Map<string, string>();
  const supervisor = new CodeBuddySupervisor({
    dataDir: config.dataDir,
    mcpUrl: `${origin()}/mcp`,
    maxConcurrent: () => service.getSettings().maxConcurrent,
    onOutput: (id, event) => {
      if (event.kind === "error" && typeof event.raw === "string" && /^(?:CODEBUDDY|CODEX|OPENCODE|MCP_CONFIG|WORKSPACE)_[A-Z0-9_]+$/.test(event.raw)) sessionErrors.set(id, event.raw);
      if (typeof event.normalized?.nativeSessionId === "string") service.recordBackendSessionId(id, event.normalized.nativeSessionId);
      service.appendSessionEvent(null, id, event);
    },
    onState: (id, state) => {
      if (state !== "queued") service.updateSession(null, id, state, state === "failed" ? sessionErrors.get(id) ?? "AGENT_EXECUTION_FAILED" : null);
      if (["succeeded", "failed", "cancelled", "interrupted", "completed_with_warning"].includes(state)) sessionErrors.delete(id);
    },
  });
  const launch = async (session: AgentSession) => {
    if (shuttingDown) throw new DomainError(503, "SHUTTING_DOWN", "Server is shutting down");
    const claimed = service.claimSession(session.id);
    if (!claimed) return;
    try {
      await supervisor.start({ sessionId: session.id, cliSessionId: session.cliSessionId, creatorId: session.creatorId, backend: claimed.session.backend,
        agentVisitorId: session.agentVisitorId, agentToken: claimed.agentToken, prompt: claimed.prompt,
        workspace: session.workspace, settings: service.getSettings() });
    } catch {
      service.updateSession(null, session.id, "failed", "Agent backend could not be started");
    }
  };
  const cancel = async (actorId: string, id: string) => {
    service.requireHuman(actorId);
    await supervisor.cancel(id);
    return service.cancelSession(actorId, id);
  };
  const mcp = new McpHttpGateway({
    services: createMcpServices(service, {launch, cancel, onVisitorRead: id => mcpVisitorReads.set(id, (mcpVisitorReads.get(id) ?? 0) + 1)}),
    authenticate: token => { try { return token ? service.authenticate(token).visitor : null; } catch { return null; } },
    allowedOrigins: config.shellAllowedOrigins,
  });
  const unsubscribeRevoke = service.subscribeRevocations(id => { void mcp.revokeVisitor(id); });
  const frames = new FrameManager({
    allowOrigin: targetOrigin => service.getSettings().allowedOrigins.includes(targetOrigin),
    parentOrigin: origin,
    longPressMs: () => service.getSettings().longPressMs,
    onChange: frame => store.transaction(() => { store.appendEvent("frames", null, frame.frameId, {frameId: frame.frameId, status: frame.status, targetUrl: frame.targetUrl, title: frame.title}); }),
  });
  const app = createHttpApp({ ...options, config, service, workbenchId: runtime.workbenchId,
    mcpUrl: () => `${origin()}/mcp`,
    onSessionLaunch: options.onSessionLaunch ?? (async ({session}) => launch(session)),
    onSessionCancel: options.onSessionCancel ?? (async session => { await supervisor.cancel(session.id); }),
    beforeApi: app => {
      app.use((req, res, next) => { if (shuttingDown && req.method !== "GET") { res.status(503).json({error: {code: "SHUTTING_DOWN", message: "Server is shutting down"}}); } else next(); });
      app.all("/mcp", hostOriginGuard(config), express.json({limit: "4mb"}), mcp.handler);
      const router = Router();
      router.use(bearerAuth(service), (_req, res, next) => { service.requireHuman(res.locals.visitor.id); next(); });
      router.get("/", (_req, res) => res.json({items: frames.listFrames(), nextCursor: null}));
      router.post("/", express.json({limit: "1mb"}), async (req, res) => {
        const input = createFrameSchema.parse(req.body);
        const parentOrigin = req.headers.origin ?? origin();
        if (!config.shellAllowedOrigins.includes(parentOrigin)) throw new DomainError(403, "ORIGIN_NOT_ALLOWED", "Shell origin is not allowed");
        res.status(201).json(await frames.createFrame(input.targetUrl, parentOrigin));
      });
      router.post("/:id/bridge", express.json({limit: "64kb"}), (req, res) => {
        const message = bridgeToParentSchema.parse(req.body);
        if (message.frameId !== req.params.id) throw new DomainError(400, "FRAME_ID_MISMATCH", "Frame ID does not match");
        res.json(frames.handleBridgeMessage(message));
      });
      router.delete("/:id", async (req, res) => { await frames.closeFrame(String(req.params.id)); res.status(204).end(); });
      app.use("/api/frames", router);
      options.beforeApi?.(app);
    },
  });
  const httpServer: Server = createServer(app);
  const gateway = new EventsGateway(service, config);
  const leaseSweeper = setInterval(() => { if (!shuttingDown) service.resources(); }, 30_000);
  leaseSweeper.unref();
  httpServer.on("upgrade", (request, socket, head) => { if (!gateway.upgrade(request, socket, head)) socket.destroy(); });
  let closing: Promise<void> | undefined;
  return {
    app, httpServer, service, store, config, gateway, frames, mcp, supervisor, mcpVisitorReads, workbenchId: runtime.workbenchId,
    async listen(): Promise<AddressInfo> {
      await new Promise<void>((resolve, reject) => { httpServer.once("error", reject); httpServer.listen(config.port, config.host, () => { httpServer.off("error", reject); resolve(); }); });
      const address = httpServer.address() as AddressInfo;
      config.port = address.port;
      const shellOrigin = `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${address.port}`;
      if (!config.allowedOrigins.includes(shellOrigin)) config.allowedOrigins.push(shellOrigin);
      // Test servers use port zero; resolve the built-in preview only before a
      // workspace has an owner, without changing an existing user's settings.
      const settings = service.getSettings();
      if (!service.hasOwner() && new URL(settings.defaultTarget).port === "0") {
        settings.defaultTarget = `${shellOrigin}/fixture`;
        settings.allowedOrigins = settings.allowedOrigins.map(value => new URL(value).port === "0" ? shellOrigin : value);
        store.run("UPDATE settings SET valueJson=? WHERE id=1", JSON.stringify(settings));
      }
      // The supervisor reads its endpoint at spawn time after listen resolved.
      supervisor.setMcpUrl?.(`${shellOrigin}/mcp`);
      return address;
    },
    close(): Promise<void> {
      if (closing) return closing;
      shuttingDown = true;
      clearInterval(leaseSweeper);
      closing = (async () => {
        await supervisor.close();
        unsubscribeRevoke();
        await mcp.close();
        gateway.close();
        await frames.closeAll();
        await new Promise<void>(resolve => { httpServer.close(() => resolve()); httpServer.closeAllConnections(); });
        try { store.close(); } finally { runtime.release(); }
      })();
      return closing;
    },
  };
}

export type DevShellServer = ReturnType<typeof createDevShellServer>;
