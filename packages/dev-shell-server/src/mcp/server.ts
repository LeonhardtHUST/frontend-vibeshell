import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  PROTOCOL_VERSION,
  domDescriptorSchema,
} from "@hustradio/dev-shell-contract";
import type { Visitor } from "@hustradio/dev-shell-contract";
import type { McpServices } from "./service.js";

const json = (value: unknown) => JSON.stringify(value, null, 2);
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: json(value) }],
  structuredContent: { result: value ?? null },
});
const resource = (uri: URL, value: unknown) => ({
  contents: [{ uri: uri.href, mimeType: "application/json", text: json(value) }],
});
const readOnlyAnnotations = {readOnlyHint: true, destructiveHint: false, openWorldHint: false};
const id = z.string().uuid();
const optionalWorkspace = z.string().min(1).optional();

export function createDevShellMcpServer(visitor: Visitor, services: McpServices): McpServer {
  const server = new McpServer(
    { name: "dev-shell", version: "0.1.0" },
    {
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
      instructions: [
        `DevShell protocol ${PROTOCOL_VERSION}. You are ${visitor.displayName} (${visitor.id}).`,
        "Use visitor_me to confirm identity. Queue reads are non-consuming; use read cursors explicitly.",
        "Use todo lists and advisory resource leases to coordinate. A lease is transparent coordination, not a mandatory filesystem lock.",
        "Never put bearer tokens in messages, todo items, activity, or logs.",
      ].join("\n"),
    },
  );

  server.registerTool("visitor_me", {
    annotations: readOnlyAnnotations,
    description: "Return the currently authenticated DevShell visitor.",
  }, async () => result(await services.visitor(visitor.id)));
  server.registerTool("visitor_list", {
    annotations: readOnlyAnnotations,
    description: "List registered human and agent visitors.",
  }, async () => result(await services.visitors()));

  server.registerTool("queue_list", {
    annotations: readOnlyAnnotations,
    description: "Read the shared prompt queue without consuming items.",
  }, async () => result(await services.queueList(visitor)));
  server.registerTool("queue_append", {
    description: "Append a prompt to the shared non-consuming queue.",
    inputSchema: {
      sessionScope: z.string().min(1).max(80).default("workbench"),
      clientMessageId: z.string().min(1).max(120),
      body: z.string().trim().min(1).max(50_000),
      selection: domDescriptorSchema.nullable().optional(),
    },
  }, async (input) => result(await services.queueAppend(visitor, {
    ...input,
    selection: input.selection ?? null,
  })));
  server.registerTool("queue_mark_read", {
    description: "Advance only this visitor's queue read cursor.",
    inputSchema: { queueItemId: id },
  }, async ({ queueItemId }) => result(await services.queueMarkRead(visitor, queueItemId)));
  server.registerTool("queue_send_batch", {
    description: "Human only: dispatch queued prompts as one new agent session.",
    inputSchema: {
      queueItemIds: z.array(id).min(1).max(50),
      clientMessageId: z.string().min(1).max(120),
      workspace: optionalWorkspace,
    },
  }, async (input) => result(await services.queueSendBatch(visitor, input)));

  server.registerTool("message_list", {
    annotations: readOnlyAnnotations,
    description: "List broadcast and authorized direct messages.",
  }, async () => result(await services.messageList(visitor)));
  server.registerTool("message_send", {
    description: "Send a broadcast or direct message to other visitors.",
    inputSchema: {
      recipientIds: z.array(id).max(100).default([]),
      kind: z.enum(["direct", "broadcast"]),
      body: z.string().trim().min(1).max(50_000),
    },
  }, async (input) => result(await services.messageSend(visitor, input)));
  server.registerTool("message_mark_read", {
    description: "Mark a message read for this visitor only.",
    inputSchema: { messageId: id },
  }, async ({ messageId }) => result(await services.messageMarkRead(visitor, messageId)));

  server.registerTool("todo_list", {
    annotations: readOnlyAnnotations,
    description: "List all visible todo lists and items for coordination.",
  }, async () => result(await services.todoList(visitor)));
  server.registerTool("todo_create_list", {
    description: "Create a todo list owned by this visitor.",
    inputSchema: {
      title: z.string().trim().min(1).max(160),
      description: z.string().max(4_000).default(""),
    },
  }, async (input) => result(await services.todoCreateList(visitor, input)));
  server.registerTool("todo_delete_list", {
    description: "Delete an owned todo list and its items.",
    inputSchema: { listId: id },
  }, async ({listId}) => result(await services.todoDeleteList(visitor, listId)));
  server.registerTool("todo_create_item", {
    description: "Add an item to an owned todo list.",
    inputSchema: {
      listId: id,
      body: z.string().trim().min(1).max(4_000),
      assigneeId: id.nullable().default(null),
      position: z.number().int().nonnegative().optional(),
    },
  }, async ({ listId, ...input }) => result(await services.todoCreateItem(visitor, listId, input)));
  server.registerTool("todo_update_item", {
    description: "Update an owned/assigned todo item with optimistic concurrency.",
    inputSchema: {
      itemId: id,
      body: z.string().trim().min(1).max(4_000).optional(),
      status: z.enum(["pending", "in_progress", "done"]).optional(),
      assigneeId: id.nullable().optional(),
      position: z.number().int().nonnegative().optional(),
      expectedRevision: z.number().int().positive(),
    },
  }, async ({ itemId, ...input }) => result(await services.todoUpdateItem(visitor, itemId, input)));

  server.registerTool("resource_list", {
    annotations: readOnlyAnnotations,
    description: "List advisory resource leases and waiters, including owners and expiry.",
  }, async () => result(await services.resourceList(visitor)));
  server.registerTool("resource_acquire", {
    description: "Acquire an advisory shared/exclusive lease or return visible conflicts.",
    inputSchema: {
      resource: z.string().trim().min(1).max(1_000),
      mode: z.enum(["shared", "exclusive"]),
      purpose: z.string().trim().min(1).max(1_000),
      ttlMs: z.number().int().min(30_000).max(3_600_000).default(900_000),
      wait: z.boolean().default(false),
    },
  }, async (input) => result(await services.resourceAcquire(visitor, input)));
  server.registerTool("resource_wait", {
    description: "Register a non-blocking waiter for a contested resource.",
    inputSchema: {
      resource: z.string().trim().min(1).max(1_000),
      mode: z.enum(["shared", "exclusive"]),
      purpose: z.string().trim().min(1).max(1_000),
      ttlMs: z.number().int().min(30_000).max(3_600_000).default(900_000),
    },
  }, async (input) => result(await services.resourceAcquire(visitor, { ...input, wait: true })));
  server.registerTool("resource_renew", {
    description: "Renew an owned active lease.",
    inputSchema: { leaseId: id },
  }, async ({ leaseId }) => result(await services.resourceRenew(visitor, leaseId)));
  server.registerTool("resource_release", {
    description: "Release an owned lease and notify waiters to retry.",
    inputSchema: { leaseId: id },
  }, async ({ leaseId }) => result(await services.resourceRelease(visitor, leaseId)));
  server.registerTool("resource_cancel_wait", {
    description: "Cancel this visitor's resource waiter.",
    inputSchema: { waiterId: id },
  }, async ({ waiterId }) => result(await services.resourceCancelWait(visitor, waiterId)));

  server.registerTool("activity_list", {
    annotations: readOnlyAnnotations,
    description: "Read append-only activity events after an optional sequence cursor.",
    inputSchema: { after: z.string().regex(/^\d+$/).optional() },
  }, async ({ after }) => result(await services.activityList(visitor, after)));
  server.registerTool("session_list", {
    annotations: readOnlyAnnotations,
    description: "List visible agent sessions.",
  }, async () => result(await services.sessionList(visitor)));
  server.registerTool("session_read", {
    annotations: readOnlyAnnotations,
    description: "Read a agent session and its sanitized output events.",
    inputSchema: { sessionId: id },
  }, async ({ sessionId }) => result(await services.sessionRead(visitor, sessionId)));
  server.registerTool("session_cancel", {
    description: "Human only: cancel a running agent session.",
    inputSchema: { sessionId: id },
  }, async ({ sessionId }) => result(await services.sessionCancel(visitor, sessionId)));

  server.registerResource("workbench", "devshell://workbench", {
    description: "Current authorized workbench snapshot",
    mimeType: "application/json",
  }, async (uri) => resource(uri, await services.snapshot(visitor)));
  server.registerResource("visitors", "devshell://visitors", {
    description: "Registered visitors and presence",
    mimeType: "application/json",
  }, async (uri) => resource(uri, await services.visitors()));
  server.registerResource("queue", "devshell://queue", {
    description: "Shared non-consuming prompt queue",
    mimeType: "application/json",
  }, async (uri) => resource(uri, await services.queueList(visitor)));
  server.registerResource("messages", "devshell://messages", {
    description: "Authorized direct and broadcast messages",
    mimeType: "application/json",
  }, async (uri) => resource(uri, await services.messageList(visitor)));
  server.registerResource("todos", "devshell://todos", {
    description: "Todo lists and items",
    mimeType: "application/json",
  }, async (uri) => resource(uri, await services.todoList(visitor)));
  server.registerResource("resources", "devshell://resources", {
    description: "Advisory resource leases and waiters",
    mimeType: "application/json",
  }, async (uri) => resource(uri, await services.resourceList(visitor)));
  server.registerResource("sessions", "devshell://sessions", {
    description: "agent sessions",
    mimeType: "application/json",
  }, async (uri) => resource(uri, await services.sessionList(visitor)));
  server.registerResource("activity", new ResourceTemplate("devshell://activity{?after}", {
    list: undefined,
  }), {
    description: "Append-only activity, optionally after a sequence",
    mimeType: "application/json",
  }, async (uri, variables) => resource(uri, await services.activityList(visitor, variables.after as string | undefined)));
  server.registerResource("session", new ResourceTemplate("devshell://sessions/{sessionId}", {
    list: async () => ({
      resources: (await services.sessionList(visitor)).map((session) => ({
        uri: `devshell://sessions/${session.id}`,
        name: `${session.id} · ${session.status}`,
        mimeType: "application/json",
      })),
    }),
  }), {
    description: "One agent session and output events",
    mimeType: "application/json",
  }, async (uri, variables) => resource(uri, await services.sessionRead(visitor, String(variables.sessionId))));

  return server;
}
