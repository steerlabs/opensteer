import {
  AppIdSchema,
  DeploymentIdSchema,
  DelegationIdSchema,
  ExecutionNodeIdSchema,
  MessageIdSchema,
  RequestIdSchema,
  RunAttemptIdSchema,
  RunIdSchema,
  TabIdSchema,
  ThreadIdSchema,
  UserIdSchema,
  utf8ByteLength,
} from "@opensteer/core";
import { z } from "zod";
import { PersonalRevisionSchema } from "./resources.js";

export const TranscriptItemIdSchema = z.string().min(1).max(600);
export const TranscriptPositionSchema = PersonalRevisionSchema.refine((value) => value !== "0");
export const TranscriptOrderCursorSchema = z.strictObject({
  deploymentId: DeploymentIdSchema,
  epoch: z.uuid(),
  viewerId: UserIdSchema,
  threadId: ThreadIdSchema,
  nodeId: ExecutionNodeIdSchema.nullable(),
  orderRevision: PersonalRevisionSchema,
  beforePosition: TranscriptPositionSchema,
  beforeId: TranscriptItemIdSchema,
});

export const TranscriptOverlayKindSchema = z.enum(["requests", "tools", "nodes"]);
export const TranscriptOverlayCursorSchema = TranscriptOrderCursorSchema.omit({
  beforePosition: true,
  orderRevision: true,
}).extend({ kind: TranscriptOverlayKindSchema, revision: PersonalRevisionSchema });
export type TranscriptOverlayCursor = z.infer<typeof TranscriptOverlayCursorSchema>;
export type TranscriptOverlayKind = z.infer<typeof TranscriptOverlayKindSchema>;

export const TranscriptItemPreviewSchema = z
  .strictObject({
    title: z.string().max(192).optional(),
    preview: z.string().max(1120).optional(),
    author: z.string().max(40).optional(),
    status: z.string().max(80).optional(),
    edited: z.boolean().optional(),
    published: z.boolean().optional(),
    truncated: z.boolean().optional(),
  })
  .refine((value) => utf8ByteLength(JSON.stringify(value)) <= 2048);

export const TranscriptPlaceSchema = z.strictObject({
  tabId: TabIdSchema,
  title: z.string().max(1024),
  site: z.string().max(2048).nullable(),
});
const card = {
  id: TranscriptItemIdSchema,
  revision: PersonalRevisionSchema,
  position: TranscriptPositionSchema,
  runId: RunIdSchema.nullable(),
  attemptId: RunAttemptIdSchema.nullable(),
  nodeId: ExecutionNodeIdSchema.nullable(),
  isTurnStart: z.boolean(),
  createdAt: z.iso.datetime(),
  view: TranscriptItemPreviewSchema,
};
export const TranscriptItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...card, kind: z.literal("message"), messageId: MessageIdSchema }),
  z.strictObject({ ...card, kind: z.literal("tool"), toolCallId: z.string().min(1).max(160) }),
  z.strictObject({ ...card, kind: z.literal("run"), runId: RunIdSchema }),
  z.strictObject({ ...card, kind: z.literal("request"), requestId: RequestIdSchema }),
  z.strictObject({ ...card, kind: z.literal("node"), executionNodeId: ExecutionNodeIdSchema }),
  z.strictObject({
    ...card,
    kind: z.enum(["assignment", "delegation"]),
    delegationId: DelegationIdSchema,
  }),
  z.strictObject({ ...card, kind: z.literal("app"), appId: AppIdSchema }),
  z.strictObject({
    ...card,
    kind: z.literal("reasoning"),
    blockId: z.string().min(1).max(255),
    bindingGeneration: z.int().nonnegative().nullable(),
  }),
  z.strictObject({ ...card, kind: z.literal("node-message"), nodeId: ExecutionNodeIdSchema }),
  z.strictObject({ ...card, kind: z.literal("place") }),
]);

export const TranscriptPageSchema = z.strictObject({
  kind: z.literal("page"),
  orderRevision: PersonalRevisionSchema,
  revision: PersonalRevisionSchema,
  items: z.array(TranscriptItemSchema).max(100),
  hasMore: z.boolean(),
  nextBefore: TranscriptOrderCursorSchema.nullable(),
  nextAfter: TranscriptOrderCursorSchema.nullable().optional(),
  anchorItemId: TranscriptItemIdSchema.nullable().optional(),
});

export type TranscriptItem = z.infer<typeof TranscriptItemSchema>;
export type TranscriptOrderCursor = z.infer<typeof TranscriptOrderCursorSchema>;
