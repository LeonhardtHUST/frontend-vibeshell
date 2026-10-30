import type {
  AgentSession,
  EventEnvelope,
  Message,
  QueueItem,
  ResourceLease,
  ResourceWaiter,
  Settings,
  TodoItem,
  TodoList,
  Visitor,
  WorkbenchSnapshot,
  createTodoItemSchema,
  createTodoListSchema,
  createVisitorSchema,
  dispatchQueueSchema,
  enqueueQueueSchema,
  acquireLeaseSchema,
  sendMessageSchema,
  updateTodoItemSchema,
} from "@hustradio/dev-shell-contract";
import type { z } from "zod";

export type MaybePromise<T> = T | Promise<T>;

export interface McpServices {
  visitor(visitorId: string): MaybePromise<Visitor>;
  visitors(): MaybePromise<Visitor[]>;
  snapshot(actor: Visitor): MaybePromise<WorkbenchSnapshot>;
  settings(actor: Visitor): MaybePromise<Settings>;
  queueList(actor: Visitor): MaybePromise<QueueItem[]>;
  queueAppend(actor: Visitor, input: z.infer<typeof enqueueQueueSchema>): MaybePromise<QueueItem>;
  queueMarkRead(actor: Visitor, queueItemId: string): MaybePromise<{ readAt: string }>;
  queueSendBatch(actor: Visitor, input: z.infer<typeof dispatchQueueSchema>): MaybePromise<AgentSession>;
  messageList(actor: Visitor): MaybePromise<Message[]>;
  messageSend(actor: Visitor, input: z.infer<typeof sendMessageSchema>): MaybePromise<Message>;
  messageMarkRead(actor: Visitor, messageId: string): MaybePromise<{ readAt: string }>;
  todoList(actor: Visitor): MaybePromise<{ lists: TodoList[]; items: TodoItem[] }>;
  todoCreateList(actor: Visitor, input: z.infer<typeof createTodoListSchema>): MaybePromise<TodoList>;
  todoDeleteList(actor: Visitor, id: string): MaybePromise<{ deleted: true }>;
  todoCreateItem(actor: Visitor, listId: string, input: z.infer<typeof createTodoItemSchema>): MaybePromise<TodoItem>;
  todoUpdateItem(actor: Visitor, itemId: string, input: z.infer<typeof updateTodoItemSchema>): MaybePromise<TodoItem>;
  resourceList(actor: Visitor): MaybePromise<{ leases: ResourceLease[]; waiters: ResourceWaiter[] }>;
  resourceAcquire(actor: Visitor, input: z.infer<typeof acquireLeaseSchema>): MaybePromise<{
    lease: ResourceLease | null;
    waiter: ResourceWaiter | null;
    conflicts: ResourceLease[];
  }>;
  resourceRenew(actor: Visitor, leaseId: string): MaybePromise<ResourceLease>;
  resourceRelease(actor: Visitor, leaseId: string): MaybePromise<{ released: true }>;
  resourceCancelWait(actor: Visitor, waiterId: string): MaybePromise<{ cancelled: true }>;
  activityList(actor: Visitor, after?: string): MaybePromise<EventEnvelope[]>;
  sessionList(actor: Visitor): MaybePromise<AgentSession[]>;
  sessionRead(actor: Visitor, sessionId: string): MaybePromise<{ session: AgentSession; events: EventEnvelope[] }>;
  sessionCancel(actor: Visitor, sessionId: string): MaybePromise<AgentSession>;
}

export type VisitorRegistration = z.infer<typeof createVisitorSchema>;
