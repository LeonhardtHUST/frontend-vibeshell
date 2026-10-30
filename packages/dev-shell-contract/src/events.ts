import { z } from "zod";
import { PROTOCOL_VERSION } from "./protocol.js";

export const eventTopicSchema = z.enum([
  "visitors",
  "queue",
  "messages",
  "todos",
  "resources",
  "sessions",
  "activity",
  "frames",
  "settings",
]);
export type EventTopic = z.infer<typeof eventTopicSchema>;

export const eventEnvelopeSchema = z.object({
  type: z.literal("event"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  eventId: z.string().uuid(),
  sequence: z.number().int().positive(),
  replay: z.boolean(),
  topic: eventTopicSchema,
  actorId: z.string().uuid().nullable(),
  entityId: z.string(),
  data: z.unknown().refine(value => value !== undefined, {message: "Event data is required"}),
  occurredAt: z.string().datetime(),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const helloSchema = z.object({
  type: z.literal("hello"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  token: z.string().min(32),
});
export type HelloMessage = z.infer<typeof helloSchema>;

export const helloOkSchema = z.object({
  type: z.literal("hello.ok"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  visitorId: z.string().uuid(),
  latestEventId: z.string().uuid().nullable(),
  latestSequence: z.number().int().nonnegative(),
});

export const historyRequestSchema = z.object({
  type: z.literal("history"),
  streamCursor: z.string().nullable(),
});
export type HistoryRequest = z.infer<typeof historyRequestSchema>;

export const historyFrameSchema = z.object({
  type: z.literal("history"),
  events: z.array(eventEnvelopeSchema),
  streamCursor: z.string(),
});
export type HistoryFrame = z.infer<typeof historyFrameSchema>;

export const completedSchema = z.object({
  type: z.literal("completed"),
  caughtUp: z.literal(true),
  streamCursor: z.string(),
});
export type CompletedMessage = z.infer<typeof completedSchema>;

export const resyncRequiredSchema = z.object({
  type: z.literal("resync.required"),
  reason: z.enum(["cursor-too-old", "cursor-not-found"]),
  snapshot: z.unknown(),
});

export const clientWsMessageSchema = z.discriminatedUnion("type", [
  helloSchema,
  historyRequestSchema,
  z.object({ type: z.literal("pong"), at: z.string().datetime().optional() }),
]);
export type ClientWsMessage = z.infer<typeof clientWsMessageSchema>;

export const serverWsMessageSchema = z.discriminatedUnion("type", [
  helloOkSchema,
  historyFrameSchema,
  completedSchema,
  resyncRequiredSchema,
  eventEnvelopeSchema,
  z.object({ type: z.literal("ping"), at: z.string().datetime() }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerWsMessage = z.infer<typeof serverWsMessageSchema>;
