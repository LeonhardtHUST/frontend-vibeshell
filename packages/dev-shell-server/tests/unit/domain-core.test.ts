import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatQueueBundle, type Settings } from "@hustradio/dev-shell-contract";
import { WorkbenchDatabase } from "../../src/db/database.js";
import { WorkbenchService } from "../../src/domain/workbench.js";

let directory: string; let store: WorkbenchDatabase; let service: WorkbenchService;
const settings = (): Settings => ({ defaultTarget: "http://127.0.0.1:5274/fixture", allowedOrigins: ["http://127.0.0.1:5274"], workspace: process.cwd(), codebuddyExecutable: "codebuddy", model: null, permissionMode: "default", timeoutMs: 1800000, maxConcurrent: 2, theme: "system", longPressMs: 500 });
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "dev-shell-domain-")); store = new WorkbenchDatabase(join(directory, "test.sqlite")); service = new WorkbenchService(store, settings()); });
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

describe("WorkbenchService", () => {
  it("freezes the selected backend and uses the exact shared copy/dispatch bundle", () => {
    const owner = service.bootstrapOwner();
    service.updateSettings(owner.visitor.id, {backend: "codex"});
    const a = service.enqueue(owner.visitor.id, {body: "First", clientMessageId: "a"});
    const b = service.enqueue(owner.visitor.id, {body: "Second", clientMessageId: "b"});
    const input = {queueItemIds: [b.id, a.id], clientMessageId: "batch"};
    const created = service.dispatch(owner.visitor.id, input);
    service.updateSettings(owner.visitor.id, {backend: "opencode-v2"});
    expect(service.dispatch(owner.visitor.id, input)).toEqual(created);
    const claimed = service.claimSession(created.session.id)!;
    expect(claimed.session.backend).toBe("codex");
    expect(claimed.prompt).toBe(formatQueueBundle([a, b]));
    expect(() => service.dispatch(owner.visitor.id, {...input, backend: "codebuddy"})).toThrow(/different request/);
  });
  it("stores only token hashes and enforces human visitor administration", () => {
    const owner = service.bootstrapOwner();
    expect(owner.token).toHaveLength(43);
    expect(store.get("SELECT tokenHash FROM visitor_tokens")!.tokenHash).not.toBe(owner.token);
    const agent = service.createVisitor(owner.visitor.id, "agent", "Agent");
    expect(() => service.createVisitor(agent.visitor.id, "human", "Bad")).toThrow(/human visitor/);
    expect(service.authenticate(owner.token).visitor.id).toBe(owner.visitor.id);
    service.revokeVisitor(owner.visitor.id, agent.visitor.id);
    expect(() => service.authenticate(agent.token)).toThrow(/Invalid or revoked/);
  });

  it("keeps the last human's credentials usable and allows revocation when another human can manage access", () => {
    const owner = service.bootstrapOwner();
    expect(() => service.revokeVisitor(owner.visitor.id, owner.visitor.id)).toThrow(expect.objectContaining({ code: "LAST_HUMAN_REQUIRED", status: 409 }));
    expect(service.authenticate(owner.token).visitor.revokedAt).toBeNull();
    const other = service.createVisitor(owner.visitor.id, "human", "Recovery operator");
    service.revokeVisitor(owner.visitor.id, owner.visitor.id);
    expect(() => service.authenticate(owner.token)).toThrow(/Invalid or revoked/);
    expect(service.authenticate(other.token).visitor.revokedAt).toBeNull();
    expect(() => service.revokeVisitor(other.visitor.id, other.visitor.id)).toThrow(expect.objectContaining({ code: "LAST_HUMAN_REQUIRED" }));
    expect(service.createVisitor(other.visitor.id, "human", "Replacement owner").visitor.kind).toBe("human");
  });

  it("replays idempotent queue writes, isolates scopes and never consumes reads", () => {
    const owner = service.bootstrapOwner();
    const input = { clientMessageId: "same", body: "hello", selection: null };
    const first = service.enqueue(owner.visitor.id, input);
    expect(service.enqueue(owner.visitor.id, input)).toEqual(first);
    expect(() => service.enqueue(owner.visitor.id, { ...input, body: "different" })).toThrow(/different request/);
    expect(service.enqueue(owner.visitor.id, { ...input, sessionScope: "another" }).id).not.toBe(first.id);
    service.markQueueRead(owner.visitor.id, first.id);
    expect(service.getQueue(first.id).status).toBe("queued");
    expect(service.listQueue()).toHaveLength(2);
  });

  it("keeps direct messages private and broadcast messages shared", () => {
    const owner = service.bootstrapOwner(); const other = service.createVisitor(owner.visitor.id, "human", "Other"); const third = service.createVisitor(owner.visitor.id, "agent", "Third");
    const direct = service.sendMessage(owner.visitor.id, { kind: "direct", recipientIds: [other.visitor.id], body: "secret" });
    expect(service.listMessages(other.visitor.id).map(item => item.id)).toContain(direct.id);
    expect(service.listMessages(third.visitor.id)).toHaveLength(0);
    expect(service.snapshot(third.visitor.id).messages).toHaveLength(0);
    expect(service.store.eventsAfter(0).filter(event => service.eventVisible(third.visitor.id, event) && event.type === "messages")).toHaveLength(0);
    service.sendMessage(owner.visitor.id, { kind: "broadcast", recipientIds: [], body: "public" });
    expect(service.listMessages(third.visitor.id)).toHaveLength(1);
  });

  it("supports multiple todo lists and optimistic item revisions", () => {
    const owner = service.bootstrapOwner(); const other = service.createVisitor(owner.visitor.id, "agent", "Assignee");
    const a = service.createTodoList(owner.visitor.id, { title: "A", description: "" }); service.createTodoList(owner.visitor.id, { title: "B", description: "" });
    const item = service.createTodoItem(owner.visitor.id, a.id, { body: "Work", assigneeId: other.visitor.id });
    expect(service.updateTodoItem(other.visitor.id, item.id, { expectedRevision: 1, status: "done" }).revision).toBe(2);
    expect(() => service.updateTodoItem(owner.visitor.id, item.id, { expectedRevision: 1, body: "stale" })).toThrow(/changed/);
  });

  it("handles exclusive/shared leases, waiters, renewal and owner ACL", () => {
    const owner = service.bootstrapOwner(); const other = service.createVisitor(owner.visitor.id, "agent", "Other");
    const shared = service.acquireLease(owner.visitor.id, { resource: "src/a", mode: "shared", purpose: "edit", ttlMs: 30000, wait: false }).lease!;
    const second = service.acquireLease(other.visitor.id, { resource: "src/a", mode: "shared", purpose: "read", ttlMs: 30000, wait: false }).lease!;
    expect(second.id).not.toBe(shared.id);
    const waiter = service.acquireLease(other.visitor.id, { resource: "src/a", mode: "exclusive", purpose: "replace", ttlMs: 30000, wait: true }).waiter!;
    expect(service.resources().waiters.map(item => item.id)).toContain(waiter.id);
    expect(() => service.releaseLease(other.visitor.id, shared.id)).toThrow(/owner/);
    expect(service.renewLease(owner.visitor.id, shared.id, 60000).revision).toBe(2);
    service.releaseLease(owner.visitor.id, shared.id); service.cancelWaiter(other.visitor.id, waiter.id);
    expect(service.resources().waiters).toHaveLength(0);
  });

  it("creates replay-safe sessions and claims each launch exactly once without storing bearer secrets", () => {
    const owner = service.bootstrapOwner();
    const queued = service.enqueue(owner.visitor.id, { clientMessageId: "queue", body: "A" });
    const input = { clientMessageId: "session", prompt: "Business prompt", queueItemIds: [queued.id] };
    const creation = service.createSession(owner.visitor.id, input);
    expect(Object.keys(creation)).toEqual(["session"]);
    expect(service.createSession(owner.visitor.id, input)).toEqual(creation);
    service.updateSettings(owner.visitor.id, { workspace: "changed-default" });
    expect(service.createSession(owner.visitor.id, input)).toEqual(creation);
    expect(() => service.createSession(owner.visitor.id, { ...input, prompt: "Different" })).toThrow(/different request/);
    const launch = service.claimSession(creation.session.id)!;
    expect(launch.prompt).toBe("Business prompt");
    expect(service.claimSession(creation.session.id)).toBeNull();
    expect(service.authenticate(launch.agentToken).visitor.id).toBe(creation.session.agentVisitorId);
    expect(JSON.stringify(store.all("SELECT * FROM idempotency_keys"))).not.toContain(launch.agentToken);
    expect(JSON.stringify(store.all("SELECT * FROM agent_sessions"))).not.toContain(launch.agentToken);
    expect(service.getQueue(queued.id).status).toBe("dispatching");
    service.updateSession(null, creation.session.id, "running");
    expect(service.getQueue(queued.id).status).toBe("dispatching");
    service.updateSession(null, creation.session.id, "succeeded");
    expect(service.getQueue(queued.id).status).toBe("sent");
    expect(() => service.authenticate(launch.agentToken)).toThrow(/Invalid or revoked/);
    expect(service.updateSession(null, creation.session.id, "running").status).toBe("succeeded");
    const queueEvents = store.eventsAfter(0).filter(event => event.type === "queue" && event.entityId === queued.id);
    expect(queueEvents.map(event => (event.payload as { status: string }).status)).toEqual(["queued", "dispatching", "sent"]);
  });

  it("requires explicit owner retry and prevents queue cancellation during dispatch", () => {
    const owner = service.bootstrapOwner();
    const other = service.createVisitor(owner.visitor.id, "human", "Other");
    const queued = service.enqueue(owner.visitor.id, { clientMessageId: "queue", body: "A" });
    const creation = service.dispatch(owner.visitor.id, { clientMessageId: "batch", queueItemIds: [queued.id] });
    expect(() => service.cancelQueue(owner.visitor.id, queued.id)).toThrow(/associated session/);
    service.cancelSession(owner.visitor.id, creation.session.id);
    expect(service.getQueue(queued.id).status).toBe("cancelled");
    expect(() => service.retryQueue(other.visitor.id, queued.id)).toThrow(/owner/);
    const retried = service.retryQueue(owner.visitor.id, queued.id);
    expect(retried).toMatchObject({ status: "queued", agentSessionId: null });
    expect(() => service.retryQueue(owner.visitor.id, queued.id)).toThrow(/Only failed or cancelled/);
  });

  it("recovers orphan sessions atomically with queue events and credential revocation", () => {
    const owner = service.bootstrapOwner();
    const queued = service.enqueue(owner.visitor.id, { clientMessageId: "queue", body: "A" });
    const creation = service.dispatch(owner.visitor.id, { clientMessageId: "batch", queueItemIds: [queued.id] });
    const launch = service.claimSession(creation.session.id)!;
    service.updateSession(null, creation.session.id, "running");
    const revoked: string[] = [];
    const unsubscribe = service.subscribeRevocations(id => revoked.push(id));
    service = new WorkbenchService(store, settings());
    expect(service.getSession(creation.session.id).status).toBe("interrupted");
    expect(service.getQueue(queued.id).status).toBe("failed");
    expect(revoked).toContain(launch.agentVisitor.id);
    expect(() => service.authenticate(launch.agentToken)).toThrow(/Invalid or revoked/);
    unsubscribe();
  });

  it("deletes only owned todo lists and cascades their items", () => {
    const owner = service.bootstrapOwner();
    const agent = service.createVisitor(owner.visitor.id, "agent", "Other");
    const list = service.createTodoList(owner.visitor.id, { title: "List", description: "" });
    service.createTodoItem(owner.visitor.id, list.id, { body: "Item", assigneeId: agent.visitor.id });
    expect(() => service.deleteTodoList(agent.visitor.id, list.id)).toThrow(/owner/);
    service.deleteTodoList(owner.visitor.id, list.id);
    expect(service.snapshot(owner.visitor.id).todoLists).toEqual([]);
    expect(service.snapshot(owner.visitor.id).todoItems).toEqual([]);
  });

  it("binds snapshot watermarks to their visitor and reads beyond private activity gaps", () => {
    const owner = service.bootstrapOwner();
    const other = service.createVisitor(owner.visitor.id, "human", "Other");
    const snapshot = service.snapshot(other.visitor.id);
    expect(service.parseStreamCursor(other.visitor.id, snapshot.streamCursor)).toBe(snapshot.revision);
    expect(service.parseStreamCursor(owner.visitor.id, snapshot.streamCursor)).toBeNull();
    for (let index = 0; index < 205; index++) service.sendMessage(owner.visitor.id, { kind: "direct", recipientIds: [owner.visitor.id], body: "private" });
    const publicMessage = service.sendMessage(owner.visitor.id, { kind: "broadcast", recipientIds: [], body: "public" });
    expect(service.activity(other.visitor.id, snapshot.revision).map(event => event.entityId)).toContain(publicMessage.id);
  });

  it("captures lease expiry and its watermark in the same snapshot transaction", () => {
    const owner = service.bootstrapOwner();
    const lease = service.acquireLease(owner.visitor.id, { resource: "expired", mode: "exclusive", purpose: "work", ttlMs: 30_000, wait: false }).lease!;
    store.run("UPDATE resource_leases SET expiresAt=? WHERE id=?", new Date(0).toISOString(), lease.id);
    const snapshot = service.snapshot(owner.visitor.id);
    expect(snapshot.leases).toEqual([]);
    expect(snapshot.revision).toBe(store.latestEvent()!.sequence);
    expect(service.parseStreamCursor(owner.visitor.id, snapshot.streamCursor)).toBe(snapshot.revision);
    expect(store.latestEvent()!.payload).toMatchObject({ action: "expired" });
  });

  it("notifies revocation observers only after the revocation transaction commits", () => {
    const owner = service.bootstrapOwner();
    const agent = service.createVisitor(owner.visitor.id, "agent", "Agent");
    const revoked: string[] = [];
    service.subscribeRevocations(id => revoked.push(id));
    expect(() => store.transaction(() => {
      service.revokeVisitor(owner.visitor.id, agent.visitor.id);
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(revoked).toEqual([]);
    expect(service.authenticate(agent.token).visitor.id).toBe(agent.visitor.id);
    service.revokeVisitor(owner.visitor.id, agent.visitor.id);
    expect(revoked).toEqual([agent.visitor.id]);
  });
});
