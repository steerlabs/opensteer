import { ComputerUseTabRequestSchema, DeviceRefusalContextSchema } from "@opensteer/protocol";
import { utf8Prefix } from "@opensteer/core";
import { z } from "zod";
import { BrowserReplRequestSchema } from "../../browser-use/browser-repl-messages.js";

export const computerReplLimits = {
  sliceMs: 100,
  sliceWallMs: 1_000,
  cpuMs: 5_000,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  codeBytes: 64 * 1024,
  bridgeBytes: 1024 * 1024,
  contexts: 16,
  executing: 4,
  wallMs: 100_000,
  idleMs: 10 * 60 * 1000,
  images: 8,
  imageBytes: 4 * 1024 * 1024,
  textBytes: 512 * 1024,
} as const;
export const ReplContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), context: z.string(), callId: z.string() }),
  z.object({ type: z.literal("events-read"), context: z.string(), callId: z.string() }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("image"),
    data: z.string(),
    mimeType: z.string(),
    _meta: z.object({ "codex/imageDetail": z.literal("original") }).optional(),
  }),
]);
export type ReplContent = z.infer<typeof ReplContentSchema>;
export const ReplRequestSchema = z
  .object({
    operation: z.enum([
      "apps",
      "phones",
      "installedApps",
      "tab",
      "windows",
      "bind",
      "observe",
      "click",
      "type",
      "key",
      "setValue",
      "scroll",
      "act",
      "release",
      "sleep",
    ]),
    target: z.string().max(256).nullable(),
    args: z.record(z.string(), z.json()),
  })
  .superRefine((request, context) => {
    if (request.operation !== "tab") return;
    const parsed = ComputerUseTabRequestSchema.safeParse(request);
    if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ ...issue });
  });
export type ReplRequest = z.infer<typeof ReplRequestSchema>;
export const ReplReplySchema = z.object({
  value: z.json(),
  content: z.array(ReplContentSchema).optional(),
});
export type ReplReply = z.infer<typeof ReplReplySchema>;
export const ReplFailureSchema = z.object({
  machineId: DeviceRefusalContextSchema.shape.machineId.optional(),
  capability: DeviceRefusalContextSchema.shape.capability.optional(),
  code: z.string(),
  cdpCode: z.number().int().optional(),
  method: z
    .string()
    .max(256)
    .regex(/^[a-zA-Z][a-zA-Z0-9.]*$/u)
    .optional(),
  message: z.string(),
  next: z.string().nullable().optional(),
  performed: z.array(z.string()).default([]),
});
export type ReplFailure = z.infer<typeof ReplFailureSchema>;
/** Guest exceptions are untrusted even when the VM itself is memory-bounded. */
export function boundedReplFailure(error: ReplFailure): ReplFailure {
  return {
    ...(error.machineId ? { machineId: error.machineId } : {}),
    ...(error.capability ? { capability: error.capability } : {}),
    code: utf8Prefix(error.code.slice(0, 128), 128),
    ...(error.cdpCode === undefined ? {} : { cdpCode: error.cdpCode }),
    ...(error.method === undefined ? {} : { method: error.method }),
    message: utf8Prefix(error.message.slice(0, 8192), 8192),
    ...(error.next ? { next: utf8Prefix(error.next.slice(0, 2000), 2000) } : {}),
    performed: error.performed.slice(0, 160).map((receipt) => utf8Prefix(receipt, 2048)),
  };
}
export const ToWorkerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("execute"),
    context: z.string(),
    callId: z.string(),
    code: z.string(),
    connection: z.literal(true).optional(),
    events: z.string().optional(),
  }),
  z.object({
    type: z.literal("events"),
    context: z.string(),
    callId: z.string(),
    events: z.string(),
  }),
  z.object({ type: z.literal("cancel"), context: z.string(), callId: z.string() }),
  z.object({ type: z.literal("dispose"), context: z.string() }),
  z.object({
    type: z.literal("reply"),
    context: z.string(),
    callId: z.string(),
    id: z.number(),
    value: z.json().optional(),
    error: ReplFailureSchema.optional(),
  }),
]);
export type ToWorker = z.infer<typeof ToWorkerSchema>;
export const FromWorkerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("request"),
    context: z.string(),
    callId: z.string(),
    id: z.number(),
    request: ReplRequestSchema,
  }),
  z.object({
    type: z.literal("browser-request"),
    context: z.string(),
    callId: z.string(),
    id: z.number(),
    json: z.string(),
  }),
  z.object({ type: z.literal("ready"), context: z.string(), callId: z.string() }),
  z.object({ type: z.literal("events-read"), context: z.string(), callId: z.string() }),
  z.object({ type: z.literal("settled"), context: z.string(), callId: z.string() }),
  z.object({ type: z.literal("text"), context: z.string(), callId: z.string(), text: z.string() }),
  z.object({
    type: z.literal("done"),
    context: z.string(),
    callId: z.string(),
    error: ReplFailureSchema.optional(),
    reset: z.boolean().optional(),
  }),
]);
export type FromWorker = z.infer<typeof FromWorkerSchema>;

export type AnyReplRequest = ReplRequest | z.infer<typeof BrowserReplRequestSchema>;
