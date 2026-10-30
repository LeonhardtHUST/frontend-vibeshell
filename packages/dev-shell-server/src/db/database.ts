import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { EventEnvelope, EventTopic } from "@hustradio/dev-shell-contract";
import { PROTOCOL_VERSION } from "@hustradio/dev-shell-contract";
import { initialMigration, sessionMigration, backendMigration } from "./schema.js";

export type Row = Record<string, unknown>;
export interface StoredEvent { sequence: number; eventId: string; type: EventTopic; actorId: string | null; entityType: string; entityId: string; payload: unknown; occurredAt: string }

export class WorkbenchDatabase {
  readonly db: DatabaseSync;
  private transactionDepth = 0;
  private pendingEvents: StoredEvent[] = [];
  private notificationQueue: StoredEvent[] = [];
  private notifying = false;
  private readonly listeners = new Set<(event: StoredEvent) => void>();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL; PRAGMA secure_delete=ON;");
    const version = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    if (version > 3) throw new Error(`Unsupported database version ${version}`);
    if (version === 0) {
      this.db.exec("BEGIN IMMEDIATE");
      try { this.db.exec(initialMigration); this.db.exec("PRAGMA user_version=1"); this.db.exec("COMMIT"); }
      catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    if (version < 2) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(sessionMigration);
        // Earlier work-in-progress databases persisted the internal launch object.
        // Preserve the business prompt while removing bearer credentials from replay DTOs.
        for (const row of this.all("SELECT visitorId,sessionScope,clientMessageId,responseJson FROM idempotency_keys")) {
          const value = JSON.parse(String(row.responseJson));
          if (!value || typeof value !== "object" || !value.session) continue;
          if (typeof value.prompt === "string") this.run("UPDATE agent_sessions SET promptText=? WHERE id=?", value.prompt, value.session.id);
          this.run("UPDATE idempotency_keys SET responseJson=? WHERE visitorId=? AND sessionScope=? AND clientMessageId=?", JSON.stringify({ session: value.session }), String(row.visitorId), String(row.sessionScope), String(row.clientMessageId));
        }
        this.db.exec("PRAGMA user_version=2; COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
    if (version < 3) {
      this.db.exec("BEGIN IMMEDIATE");
      try { this.db.exec(backendMigration); this.db.exec("PRAGMA user_version=3; COMMIT"); }
      catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
  }

  transaction<T>(operation: () => T): T {
    if (this.transactionDepth > 0) return operation();
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try {
      const result = operation();
      this.db.exec("COMMIT");
      this.transactionDepth = 0;
      const events = this.pendingEvents;
      this.pendingEvents = [];
      this.publish(events);
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.transactionDepth = 0;
      this.pendingEvents = [];
      throw error;
    }
  }

  subscribe(listener: (event: StoredEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  all(sql: string, ...params: Array<string | number | null>): Row[] {
    return this.db.prepare(sql).all(...params) as unknown as Row[];
  }
  get(sql: string, ...params: Array<string | number | null>): Row | undefined {
    return this.db.prepare(sql).get(...params) as unknown as Row | undefined;
  }
  run(sql: string, ...params: Array<string | number | null>): void { this.db.prepare(sql).run(...params); }

  appendEvent(topic: EventTopic, actorId: string | null, entityId: string, data: unknown, entityType: string = topic): StoredEvent {
    const eventId = randomUUID();
    const occurredAt = new Date().toISOString();
    this.run("INSERT INTO events(eventId,type,actorId,entityType,entityId,payloadJson,occurredAt) VALUES(?,?,?,?,?,?,?)", eventId, topic, actorId, entityType, entityId, JSON.stringify(data), occurredAt);
    const event = { sequence: Number(this.get("SELECT last_insert_rowid() AS sequence")!.sequence), eventId, type: topic, actorId, entityType, entityId, payload: data, occurredAt };
    if (this.transactionDepth > 0) this.pendingEvents.push(event);
    else this.publish([event]);
    return event;
  }

  eventsAfter(sequence: number, limit = 501): StoredEvent[] {
    return this.all("SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT ?", sequence, limit).map(rowToEvent);
  }
  eventById(eventId: string): StoredEvent | undefined {
    const row = this.get("SELECT * FROM events WHERE eventId=?", eventId);
    return row ? rowToEvent(row) : undefined;
  }
  latestEvent(): StoredEvent | undefined {
    const row = this.get("SELECT * FROM events ORDER BY sequence DESC LIMIT 1");
    return row ? rowToEvent(row) : undefined;
  }
  close(): void { this.db.close(); }

  private publish(events: StoredEvent[]): void {
    // Committed writes must never be reported as rolled back because a socket
    // or another observer disconnected while processing its notification.
    this.notificationQueue.push(...events);
    if (this.notifying) return;
    this.notifying = true;
    try {
      while (this.notificationQueue.length) {
        const event = this.notificationQueue.shift()!;
        for (const listener of this.listeners) { try { listener(event); } catch { /* observer isolation */ } }
      }
    } finally { this.notifying = false; }
  }
}

export function rowToEvent(row: Row): StoredEvent {
  return { sequence: Number(row.sequence), eventId: String(row.eventId), type: row.type as EventTopic, actorId: row.actorId === null ? null : String(row.actorId), entityType: String(row.entityType), entityId: String(row.entityId), payload: JSON.parse(String(row.payloadJson)), occurredAt: String(row.occurredAt) };
}

export function eventEnvelope(event: StoredEvent, replay = false): EventEnvelope {
  return { type: "event", protocolVersion: PROTOCOL_VERSION, eventId: event.eventId, sequence: event.sequence, replay, topic: event.type, actorId: event.actorId, entityId: event.entityId, data: event.payload ?? null, occurredAt: event.occurredAt };
}
