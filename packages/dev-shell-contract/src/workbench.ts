import { z } from "zod";
import { domDescriptorSchema } from "./frames.js";

export const idSchema = z.string().uuid();
export const isoDateSchema = z.string().datetime();
export const revisionSchema = z.number().int().positive();
export const agentBackendSchema = z.enum(["codebuddy", "codex", "opencode-v2"]);
export type AgentBackend = z.infer<typeof agentBackendSchema>;

export const visitorSchema = z.object({
  id: idSchema,
  kind: z.enum(["human", "agent"]),
  displayName: z.string().min(1).max(80),
  parentVisitorId: idSchema.nullable(),
  createdAt: isoDateSchema,
  lastSeenAt: isoDateSchema,
  revokedAt: isoDateSchema.nullable(),
  online: z.boolean(),
});
export type Visitor = z.infer<typeof visitorSchema>;

export const queueItemSchema = z.object({
  id: idSchema,
  ownerId: idSchema,
  sessionScope: z.string().min(1).max(80),
  clientMessageId: z.string().min(1).max(120),
  body: z.string().min(1).max(50_000),
  selection: domDescriptorSchema.nullable(),
  status: z.enum(["queued", "dispatching", "sent", "failed", "cancelled"]),
  agentSessionId: idSchema.nullable(),
  revision: revisionSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type QueueItem = z.infer<typeof queueItemSchema>;

export const messageSchema = z.object({
  id: idSchema,
  senderId: idSchema,
  recipientIds: z.array(idSchema),
  kind: z.enum(["direct", "broadcast", "system"]),
  body: z.string().min(1).max(50_000),
  createdAt: isoDateSchema,
});
export type Message = z.infer<typeof messageSchema>;

export const todoListSchema = z.object({
  id: idSchema,
  ownerId: idSchema,
  title: z.string().min(1).max(160),
  description: z.string().max(4_000),
  archivedAt: isoDateSchema.nullable(),
  revision: revisionSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type TodoList = z.infer<typeof todoListSchema>;

export const todoItemSchema = z.object({
  id: idSchema,
  listId: idSchema,
  ownerId: idSchema,
  assigneeId: idSchema.nullable(),
  body: z.string().min(1).max(4_000),
  status: z.enum(["pending", "in_progress", "done"]),
  position: z.number().int().nonnegative(),
  revision: revisionSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type TodoItem = z.infer<typeof todoItemSchema>;

export const resourceLeaseSchema = z.object({
  id: idSchema,
  resource: z.string().min(1).max(1_000),
  mode: z.enum(["shared", "exclusive"]),
  ownerId: idSchema,
  purpose: z.string().min(1).max(1_000),
  acquiredAt: isoDateSchema,
  expiresAt: isoDateSchema,
  revision: revisionSchema,
});
export type ResourceLease = z.infer<typeof resourceLeaseSchema>;

export const resourceWaiterSchema = z.object({
  id: idSchema,
  resource: z.string().min(1).max(1_000),
  mode: z.enum(["shared", "exclusive"]),
  ownerId: idSchema,
  purpose: z.string().min(1).max(1_000),
  requestedAt: isoDateSchema,
});
export type ResourceWaiter = z.infer<typeof resourceWaiterSchema>;

export const agentSessionSchema = z.object({
  id: idSchema,
  creatorId: idSchema,
  agentVisitorId: idSchema,
  backend: agentBackendSchema.optional(),
  nativeSessionId: z.string().nullable().optional(),
  workspace: z.string().min(1),
  status: z.enum(["queued", "spawning", "running", "succeeded", "failed", "cancelled", "interrupted", "completed_with_warning"]),
  cliSessionId: idSchema,
  queueItemIds: z.array(idSchema),
  error: z.string().nullable(),
  createdAt: isoDateSchema,
  startedAt: isoDateSchema.nullable(),
  endedAt: isoDateSchema.nullable(),
});
export type AgentSession = z.infer<typeof agentSessionSchema>;

export const settingsSchema = z.object({
  backend: agentBackendSchema.optional(),
  defaultTarget: z.string().url(),
  allowedOrigins: z.array(z.string().url()),
  workspace: z.string().min(1),
  codebuddyExecutable: z.string().min(1),
  codexExecutable: z.string().min(1).optional(),
  opencodeExecutable: z.string().min(1).optional(),
  model: z.string().nullable(),
  permissionMode: z.enum(["default", "acceptEdits", "plan"]),
  timeoutMs: z.number().int().min(10_000).max(7_200_000),
  maxConcurrent: z.number().int().min(1).max(8),
  theme: z.enum(["system", "light", "dark"]),
  longPressMs: z.number().int().min(250).max(1_200),
});
export type Settings = z.infer<typeof settingsSchema>;

export const workbenchSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  streamCursor: z.string(),
  visitors: z.array(visitorSchema),
  queue: z.array(queueItemSchema),
  messages: z.array(messageSchema),
  todoLists: z.array(todoListSchema),
  todoItems: z.array(todoItemSchema),
  leases: z.array(resourceLeaseSchema),
  waiters: z.array(resourceWaiterSchema),
  sessions: z.array(agentSessionSchema),
  settings: settingsSchema,
});
export type WorkbenchSnapshot = z.infer<typeof workbenchSnapshotSchema>;

export const createVisitorSchema = z.object({
  kind: z.enum(["human", "agent"]),
  displayName: z.string().trim().min(1).max(80),
});
export const enqueueQueueSchema = z.object({
  sessionScope: z.string().min(1).max(80).default("workbench"),
  clientMessageId: z.string().min(1).max(120),
  body: z.string().trim().min(1).max(50_000),
  selection: domDescriptorSchema.nullable().default(null),
});
export const dispatchQueueSchema = z.object({
  backend: agentBackendSchema.optional(),
  queueItemIds: z.array(idSchema).min(1).max(50),
  clientMessageId: z.string().min(1).max(120),
  workspace: z.string().min(1).optional(),
});
export const sendMessageSchema = z.object({
  recipientIds: z.array(idSchema).max(100).default([]),
  kind: z.enum(["direct", "broadcast"]),
  body: z.string().trim().min(1).max(50_000),
});
export const createTodoListSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().max(4_000).default(""),
});
export const createTodoItemSchema = z.object({
  body: z.string().trim().min(1).max(4_000),
  assigneeId: idSchema.nullable().default(null),
  position: z.number().int().nonnegative().optional(),
});
export const updateTodoItemSchema = z.object({
  body: z.string().trim().min(1).max(4_000).optional(),
  status: z.enum(["pending", "in_progress", "done"]).optional(),
  assigneeId: idSchema.nullable().optional(),
  position: z.number().int().nonnegative().optional(),
  expectedRevision: revisionSchema,
});
export const acquireLeaseSchema = z.object({
  resource: z.string().trim().min(1).max(1_000),
  mode: z.enum(["shared", "exclusive"]),
  purpose: z.string().trim().min(1).max(1_000),
  ttlMs: z.number().int().min(30_000).max(3_600_000).default(900_000),
  wait: z.boolean().default(false),
});
export const createSessionSchema = z.object({
  backend: agentBackendSchema.optional(),
  prompt: z.string().trim().min(1).max(100_000),
  queueItemIds: z.array(idSchema).max(50).default([]),
  clientMessageId: z.string().min(1).max(120),
  workspace: z.string().min(1).optional(),
});
export const updateSettingsSchema = settingsSchema.partial();
export const createFrameSchema = z.object({ targetUrl: z.string().url() });

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
  requestId: z.string().uuid(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export const pageSchema = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
});

export const bootstrapReadSchema = z.object({ visitor: visitorSchema, snapshot: workbenchSnapshotSchema });
export const bootstrapCreateSchema = bootstrapReadSchema.extend({ token: z.string().min(32) });
export const visitorCredentialsSchema = z.object({ visitor: visitorSchema, token: z.string().min(32), mcpUrl: z.string().url() });
export const leaseResultSchema = z.object({ lease: resourceLeaseSchema.nullable(), waiter: resourceWaiterSchema.nullable(), conflicts: z.array(resourceLeaseSchema).default([]) });
