import type { AgentSession, Visitor } from "@hustradio/dev-shell-contract";
import { eventEnvelope } from "../db/database.js";
import { DomainError } from "../domain/errors.js";
import type { WorkbenchService } from "../domain/workbench.js";
import type { McpServices } from "./service.js";

export function createMcpServices(service: WorkbenchService, actions: {
  launch: (session: AgentSession) => Promise<void>;
  cancel: (actorId: string, id: string) => Promise<AgentSession>;
  onVisitorRead?: (id: string) => void;
}): McpServices {
  const active = (actor: Visitor) => {
    const current = service.getVisitor(actor.id);
    if (current.revokedAt) throw new DomainError(401, "UNAUTHORIZED", "Visitor has been revoked");
    return current.id;
  };
  return {
    visitor: id => { const current = service.getVisitor(id); active(current); actions.onVisitorRead?.(id); return current; },
    visitors: () => service.listVisitors(),
    snapshot: actor => service.snapshot(active(actor)),
    settings: actor => { active(actor); return service.getSettings(); },
    queueList: actor => { active(actor); return service.listQueue(); },
    queueAppend: (actor, input) => service.enqueue(active(actor), input),
    queueMarkRead: (actor, id) => { service.markQueueRead(active(actor), id); return { readAt: new Date().toISOString() }; },
    queueSendBatch: async (actor, input) => { const {session} = service.dispatch(active(actor), input); await actions.launch(session); return service.getSession(session.id); },
    messageList: actor => service.listMessages(active(actor)),
    messageSend: (actor, input) => service.sendMessage(active(actor), input),
    messageMarkRead: (actor, id) => { service.markMessageRead(active(actor), id); return { readAt: new Date().toISOString() }; },
    todoList: actor => { const snapshot = service.snapshot(active(actor)); return { lists: snapshot.todoLists, items: snapshot.todoItems }; },
    todoCreateList: (actor, input) => service.createTodoList(active(actor), input),
    todoDeleteList: (actor, id) => { service.deleteTodoList(active(actor), id); return { deleted: true }; },
    todoCreateItem: (actor, id, input) => service.createTodoItem(active(actor), id, input),
    todoUpdateItem: (actor, id, input) => service.updateTodoItem(active(actor), id, input),
    resourceList: actor => { active(actor); return service.resources(); },
    resourceAcquire: (actor, input) => service.acquireLease(active(actor), input),
    resourceRenew: (actor, id) => service.renewLease(active(actor), id),
    resourceRelease: (actor, id) => { service.releaseLease(active(actor), id); return { released: true }; },
    resourceCancelWait: (actor, id) => { service.cancelWaiter(active(actor), id); return { cancelled: true }; },
    activityList: (actor, after) => service.activity(active(actor), Number(after ?? 0)).map(event => eventEnvelope(event)),
    sessionList: actor => { active(actor); return service.listSessions(); },
    sessionRead: (actor, id) => { active(actor); return {session: service.getSession(id), events: service.sessionEvents(id).map(event => eventEnvelope(event))}; },
    sessionCancel: (actor, id) => actions.cancel(active(actor), id),
  };
}
