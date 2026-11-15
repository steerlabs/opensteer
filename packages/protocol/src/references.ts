import { TabReferenceSchema, TabIdSchema } from "@opensteer/core";
import {
  ReferenceIdSchema,
  ThreadIdSchema,
  RunIdSchema,
  MessageIdSchema,
  RequestIdSchema,
  RequestStatusSchema,
  TriggerIdSchema,
  RunnerIdSchema,
  AttachmentIdSchema,
} from "@opensteer/core";
import { z } from "zod";

export const referenceResolveBatchSize = 64;
export const ReferenceResolveInputSchema = z.strictObject({
  ids: z.array(ReferenceIdSchema).min(1).max(referenceResolveBatchSize),
});
const common = { status: z.literal("available"), title: z.string().min(1).max(256) };
export const AvailableReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("tab"), id: TabIdSchema }),
  z.object({ ...common, kind: z.literal("task"), id: ThreadIdSchema }),
  z.object({
    ...common,
    kind: z.literal("run"),
    id: RunIdSchema,
    threadId: ThreadIdSchema,
    anchorMessageId: MessageIdSchema,
  }),
  z.object({
    ...common,
    kind: z.literal("message"),
    id: MessageIdSchema,
    threadId: ThreadIdSchema,
    location: z.enum(["transcript", "input-queue"]),
  }),
  z.object({
    ...common,
    kind: z.literal("request"),
    id: RequestIdSchema,
    threadId: ThreadIdSchema,
    requestStatus: RequestStatusSchema,
  }),
  z.object({ ...common, kind: z.literal("automation"), id: TriggerIdSchema }),
  z.object({ ...common, kind: z.literal("computer"), id: RunnerIdSchema }),
  z.object({
    ...common,
    kind: z.literal("attachment"),
    id: AttachmentIdSchema,
    threadId: ThreadIdSchema.nullable(),
    messageId: MessageIdSchema.nullable(),
  }),
]);
export const ReferenceResolutionSchema = z.union([
  AvailableReferenceSchema,
  z.object({ status: z.literal("unavailable"), id: ReferenceIdSchema }),
]);
export const ReferenceResolveResultSchema = z.object({
  /** One result per distinct input ID, in first-occurrence order. Failures of the read fail the call. */
  results: z.array(ReferenceResolutionSchema).max(referenceResolveBatchSize),
});
export type ReferenceResolveInput = z.infer<typeof ReferenceResolveInputSchema>;
export type AvailableReference = z.infer<typeof AvailableReferenceSchema>;
export type ReferenceResolution = z.infer<typeof ReferenceResolutionSchema>;
export type ReferenceResolveResult = z.infer<typeof ReferenceResolveResultSchema>;

export const TabReferenceResolveInputSchema = z.strictObject({
  references: z.array(TabReferenceSchema).min(1).max(referenceResolveBatchSize),
});
export const TabReferenceResolutionSchema = z.union([
  z.object({ ...common, kind: z.literal("tab"), id: TabIdSchema }),
  z.object({ status: z.literal("unavailable"), kind: z.literal("tab"), id: TabIdSchema }),
]);
