import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import {
  acquireLeaseSchema, createSessionSchema, createTodoItemSchema, createTodoListSchema,
  createVisitorSchema, dispatchQueueSchema, enqueueQueueSchema, sendMessageSchema,
  updateSettingsSchema, updateTodoItemSchema,
  PROTOCOL_VERSION,
} from "@hustradio/dev-shell-contract";
import type { WorkbenchService } from "../domain/workbench.js";
import { DomainError } from "../domain/errors.js";
import { actorId, bearerAuth } from "../http/security.js";
import { eventEnvelope } from "../db/database.js";

export interface RouteOptions {
  workbenchId?: string;
  onSessionLaunch?: (creation: ReturnType<WorkbenchService["createSession"]>) => void | Promise<void>;
  onSessionCancel?: (session: ReturnType<WorkbenchService["getSession"]>) => void | Promise<void>;
  mcpUrl?: () => string;
}
const body = <S extends z.ZodTypeAny>(schema: S, req: Request): z.output<S> => schema.parse(req.body);
const page = <T extends { id: string }>(items: T[], req: Request) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 200);
  if (!Number.isInteger(limit) || limit < 1) throw new DomainError(400, "VALIDATION_ERROR", "limit must be between 1 and 200");
  const after = typeof req.query.cursor === "string" ? req.query.cursor : "";
  const start = after ? items.findIndex(item => item.id === after) + 1 : 0;
  if (after && start === 0) throw new DomainError(400, "INVALID_CURSOR", "Cursor was not found");
  const slice = items.slice(start, start + limit);
  return { items: slice, nextCursor: start + limit < items.length && slice.length ? slice.at(-1)!.id : null };
};
const launch = async (options: RouteOptions, value: ReturnType<WorkbenchService["createSession"]>) => { await options.onSessionLaunch?.(value); return value.session; };
const sequence = (value: unknown) => {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new DomainError(400, "INVALID_CURSOR", "after must be a nonnegative safe integer");
  return Number(value);
};

export function createApiRouter(service: WorkbenchService, options: RouteOptions = {}): Router {
  const router = Router();
  const auth = bearerAuth(service);
  router.get("/health", (_req, res) => res.json({ ok: true, protocolVersion: PROTOCOL_VERSION, workbenchId: options.workbenchId, ownerBootstrapped: service.hasOwner() }));
  router.post("/bootstrap", (req, res) => {
    if (req.headers["x-dev-shell-web"] !== "1") throw new DomainError(403, "WEB_HEADER_REQUIRED", "x-dev-shell-web header is required");
    const name = z.object({ displayName: z.string().trim().min(1).max(80).default("Owner") }).parse(req.body ?? {});
    res.status(201).json(service.bootstrapOwner(name.displayName));
  });
  router.use(auth);
  router.get("/bootstrap", (_req, res) => res.json({ visitor: res.locals.visitor, snapshot: service.snapshot(actorId(_req, res)) }));
  router.post("/visitors", (req, res) => { const input = body(createVisitorSchema, req); res.status(201).json({ ...service.createVisitor(actorId(req, res), input.kind, input.displayName), mcpUrl: options.mcpUrl?.() ?? "/mcp" }); });
  router.get("/visitors", (req, res) => res.json(page(service.listVisitors(), req)));
  router.delete("/visitors/:id", (req, res) => res.json(service.revokeVisitor(actorId(req, res), String(req.params.id))));

  router.get("/queue", (req, res) => res.json(page(service.listQueue(), req)));
  router.post("/queue", (req, res) => res.status(201).json(service.enqueue(actorId(req, res), body(enqueueQueueSchema, req))));
  router.post("/queue/dispatch", async (req, res) => res.status(201).json(await launch(options, service.dispatch(actorId(req, res), body(dispatchQueueSchema, req)))));
  router.post("/queue/:id/read", (req, res) => { service.markQueueRead(actorId(req, res), String(req.params.id)); res.status(204).end(); });
  router.delete("/queue/:id", (req, res) => res.json(service.cancelQueue(actorId(req, res), String(req.params.id))));
  router.post("/queue/:id/retry", (req, res) => res.json(service.retryQueue(actorId(req, res), String(req.params.id))));

  router.get("/messages", (req, res) => res.json(page(service.listMessages(actorId(req, res)), req)));
  router.post("/messages", (req, res) => res.status(201).json(service.sendMessage(actorId(req, res), body(sendMessageSchema, req))));
  router.post("/messages/:id/read", (req, res) => { service.markMessageRead(actorId(req, res), String(req.params.id)); res.status(204).end(); });

  router.get("/todos/lists", (req, res) => res.json(page(service.snapshot(actorId(req, res)).todoLists, req)));
  router.post("/todos/lists", (req, res) => res.status(201).json(service.createTodoList(actorId(req, res), body(createTodoListSchema, req))));
  router.delete("/todos/lists/:id", (req, res) => { service.deleteTodoList(actorId(req, res), String(req.params.id)); res.status(204).end(); });
  router.get("/todos/lists/:id/items", (req, res) => { const id = String(req.params.id); const snapshot = service.snapshot(actorId(req, res)); if (!snapshot.todoLists.some(list => list.id === id)) throw new DomainError(404, "NOT_FOUND", "Todo list not found"); res.json(page(snapshot.todoItems.filter(item => item.listId === id), req)); });
  router.post("/todos/lists/:id/items", (req, res) => res.status(201).json(service.createTodoItem(actorId(req, res), String(req.params.id), body(createTodoItemSchema, req))));
  router.patch("/todos/items/:id", (req, res) => res.json(service.updateTodoItem(actorId(req, res), String(req.params.id), body(updateTodoItemSchema, req))));

  router.get("/resources/leases", (req, res) => { const state = service.resources(); res.json({ ...page(state.leases, req), waiters: state.waiters }); });
  router.post("/resources/leases", (req, res) => { const result = service.acquireLease(actorId(req, res), body(acquireLeaseSchema, req)); res.status(result.waiter ? 202 : 201).json(result); });
  router.post("/resources/leases/:id/renew", (req, res) => { const input = z.object({ ttlMs: z.number().int().min(30_000).max(3_600_000).default(900_000) }).parse(req.body ?? {}); res.json(service.renewLease(actorId(req, res), String(req.params.id), input.ttlMs)); });
  router.post("/resources/leases/:id/release", (req, res) => { service.releaseLease(actorId(req, res), String(req.params.id)); res.status(204).end(); });
  router.post("/resources/waiters/:id/cancel", (req, res) => { service.cancelWaiter(actorId(req, res), String(req.params.id)); res.status(204).end(); });

  router.get("/sessions", (req, res) => res.json(page(service.listSessions(), req)));
  router.post("/sessions", async (req, res) => res.status(201).json(await launch(options, service.createSession(actorId(req, res), body(createSessionSchema, req)))));
  router.get("/sessions/:id/events", (req, res) => { const events = service.sessionEvents(String(req.params.id), sequence(req.query.after)); res.json({ items: events.map(event => eventEnvelope(event)), nextCursor: events.length ? String(events.at(-1)!.sequence) : null }); });
  router.post("/sessions/:id/cancel", async (req, res) => {
    service.requireHuman(actorId(req, res));
    const session = service.getSession(String(req.params.id));
    await options.onSessionCancel?.(session);
    res.json(service.cancelSession(actorId(req, res), session.id));
  });
  router.get("/activity", (req, res) => { const events = service.activity(actorId(req, res), sequence(req.query.after)); res.json({ items: events.map(event => eventEnvelope(event)), nextCursor: events.length ? String(events.at(-1)!.sequence) : null }); });
  router.get("/settings", (_req, res) => res.json(service.getSettings()));
  router.patch("/settings", (req, res) => res.json(service.updateSettings(actorId(req, res), body(updateSettingsSchema, req))));

  router.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = randomUUID();
    if (error instanceof ZodError) res.status(400).json({ error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: error.issues }, requestId });
    else if (error instanceof DomainError) res.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }, requestId });
    else if (error instanceof SyntaxError && "body" in error) res.status(400).json({ error: { code: "INVALID_JSON", message: "Malformed JSON body" }, requestId });
    else { console.error(`[dev-shell:${requestId}]`, error instanceof Error ? error.message : "Unknown error"); res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" }, requestId }); }
  });
  return router;
}
