import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@hustradio/dev-shell-contract";
import { PROTOCOL_VERSION } from "@hustradio/dev-shell-contract";
import { EventCursor } from "../../src/api/event-cursor";

const event = (sequence: number, id: string): EventEnvelope => ({type: "event", protocolVersion: PROTOCOL_VERSION, eventId: id, sequence, replay: false, topic: "queue", actorId: null, entityId: "entity", data: {}, occurredAt: new Date(0).toISOString()});

describe("event cursor", () => {
  it("advances only for new events and deduplicates event id and sequence", () => {
    const cursor = new EventCursor();
    expect(cursor.apply(event(1, crypto.randomUUID()))).toBe(true);
    const current = cursor.eventId!;
    expect(cursor.apply(event(1, crypto.randomUUID()))).toBe(false);
    expect(cursor.apply(event(2, current))).toBe(false);
    expect(cursor.sequence).toBe(1);
    expect(cursor.apply(event(2, crypto.randomUUID()))).toBe(true);
    expect(cursor.eventId).not.toBe(current);
  });
  it("resets cleanly after a server resync", () => {
    const cursor = new EventCursor(crypto.randomUUID(), 40);
    cursor.reset(); expect(cursor.eventId).toBeNull(); expect(cursor.sequence).toBe(0);
    expect(cursor.apply(event(1, crypto.randomUUID()))).toBe(true);
  });
});
