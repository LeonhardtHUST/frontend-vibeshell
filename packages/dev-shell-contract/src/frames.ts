import { z } from "zod";

export const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const domDescriptorSchema = z.object({
  tagName: z.string(),
  id: z.string().nullable().default(null),
  classes: z.array(z.string()).default([]),
  role: z.string().nullable().default(null),
  accessibleName: z.string().nullable().default(null),
  attributes: z.record(z.string(), z.string()).default({}),
  cssPath: z.string(),
  text: z.string().max(2_000).default(""),
  outerHTML: z.string().max(12_000).default(""),
  rect: rectSchema,
  pageUrl: z.string().url(),
  pageTitle: z.string().default(""),
  componentName: z.string().nullable().default(null),
  source: z.object({
    fileName: z.string(),
    lineNumber: z.number().int().positive().optional(),
    columnNumber: z.number().int().positive().optional(),
  }).nullable().default(null),
  sourceConfidence: z.enum(["dom", "framework-metadata"]),
});

export type DomDescriptor = z.infer<typeof domDescriptorSchema>;

export const frameStatusSchema = z.enum([
  "creating",
  "bootstrapping",
  "ready",
  "degraded",
  "closed",
  "error",
]);

export const frameInfoSchema = z.object({
  frameId: z.string().uuid(),
  targetUrl: z.string().url(),
  currentUrl: z.string().url(),
  proxyOrigin: z.string().url(),
  bootstrapUrl: z.string().url(),
  title: z.string().default(""),
  status: frameStatusSchema,
  bridgeReady: z.boolean(),
  detail: z.string().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type FrameInfo = z.infer<typeof frameInfoSchema>;

export const bridgeReadySchema = z.object({
  type: z.literal("bridge.ready"),
  protocolVersion: z.literal(1),
  frameId: z.string().uuid(),
  url: z.string().url(),
  title: z.string(),
});

export const bridgeFrameInfoSchema = z.object({
  type: z.literal("bridge.frame.info"),
  protocolVersion: z.literal(1),
  frameId: z.string().uuid(),
  url: z.string().url(),
  title: z.string(),
  viewport: z.object({ width: z.number(), height: z.number() }),
});

export const pickerArmedSchema = z.object({
  type: z.literal("picker.armed"),
  protocolVersion: z.literal(1),
  frameId: z.string().uuid(),
  armed: z.boolean(),
  mode: z.enum(["keyboard", "explicit", "long-press"]),
});

export const pickerSelectedSchema = z.object({
  type: z.literal("picker.selected"),
  protocolVersion: z.literal(1),
  frameId: z.string().uuid(),
  descriptor: domDescriptorSchema,
  clientPoint: z.object({ x: z.number(), y: z.number() }),
});
export type PickerSelectedMessage = z.infer<typeof pickerSelectedSchema>;

export const bridgeErrorSchema = z.object({
  type: z.literal("bridge.error"),
  protocolVersion: z.literal(1),
  frameId: z.string().uuid(),
  code: z.string(),
  message: z.string(),
});

export const bridgeToParentSchema = z.discriminatedUnion("type", [
  bridgeReadySchema,
  bridgeFrameInfoSchema,
  pickerArmedSchema,
  pickerSelectedSchema,
  bridgeErrorSchema,
]);
export type BridgeToParentMessage = z.infer<typeof bridgeToParentSchema>;

export const parentToBridgeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("picker.arm"),
    protocolVersion: z.literal(1),
    frameId: z.string().uuid(),
    mode: z.enum(["keyboard", "explicit", "long-press"]),
  }),
  z.object({
    type: z.literal("picker.disarm"),
    protocolVersion: z.literal(1),
    frameId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("frame.ping"),
    protocolVersion: z.literal(1),
    frameId: z.string().uuid(),
  }),
]);
export type ParentToBridgeMessage = z.infer<typeof parentToBridgeSchema>;
