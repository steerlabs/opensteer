import {
  AppIdSchema,
  DeploymentIdSchema,
  DelegationIdSchema,
  ExecutionNodeIdSchema,
  MessageIdSchema,
  MessageViewSchema,
  MessageAuthorSchema,
  ToolIdentitySchema,
  ToolOutputViewSchema,
  ExecutionNodeViewSchema,
  RunViewSchema,
  RunUsageViewSchema,
  RunFailureViewSchema,
  RequestKindSchema,
  AssignmentSummarySchema,
  RequestIdSchema,
  RunAttemptIdSchema,
  RunIdSchema,
  TabIdSchema,
  ThreadIdSchema,
  UserIdSchema,
  utf8ByteLength,
} from "@opensteer/core";
import { z } from "zod";
import { TranscriptImageRefSchema } from "./assets.js";
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
  z.strictObject({
    ...card,
    kind: z.literal("message"),
    messageId: MessageIdSchema,
    messageKind: z.enum(["assistant", "input", "continuation"]).optional(),
    author: MessageAuthorSchema.optional(),
  }),
  z.strictObject({
    ...card,
    kind: z.literal("tool"),
    toolCallId: z.string().min(1).max(160),
    tool: ToolIdentitySchema.nullable().optional(),
    view: TranscriptItemPreviewSchema.refine((value) => value.preview === undefined),
  }),
  z.strictObject({
    ...card,
    kind: z.literal("run"),
    runId: RunIdSchema,
    replyMessageId: MessageIdSchema.nullable().optional(),
    endedAt: z.iso.datetime().optional(),
    usage: RunUsageViewSchema.optional(),
    failure: RunFailureViewSchema.optional(),
  }),
  z.strictObject({
    ...card,
    kind: z.literal("request"),
    requestId: RequestIdSchema,
    requestKind: RequestKindSchema.optional(),
  }),
  z.strictObject({
    ...card,
    kind: z.literal("node"),
    executionNodeId: ExecutionNodeIdSchema,
    node: ExecutionNodeViewSchema.optional(),
  }),
  z.strictObject({
    ...card,
    kind: z.literal("assignment"),
    delegationId: DelegationIdSchema,
    assignment: AssignmentSummarySchema.optional(),
  }),
  z.strictObject({ ...card, kind: z.literal("app"), appId: AppIdSchema }),
  z.strictObject({
    ...card,
    kind: z.literal("reasoning"),
    blockId: z.string().min(1).max(255),
    bindingGeneration: z.int().nonnegative().nullable(),
  }),
  z.strictObject({ ...card, kind: z.literal("node-message"), nodeId: ExecutionNodeIdSchema }),
  z.strictObject({ ...card, kind: z.literal("place"), place: TranscriptPlaceSchema.optional() }),
]);

export const TranscriptPageSchema = z.strictObject({
  kind: z.literal("page"),
  threadId: ThreadIdSchema,
  nodeId: ExecutionNodeIdSchema.nullable(),
  orderRevision: PersonalRevisionSchema,
  revision: PersonalRevisionSchema,
  items: z.array(TranscriptItemSchema).max(100),
  hasMore: z.boolean(),
  nextBefore: TranscriptOrderCursorSchema.nullable(),
  nextAfter: TranscriptOrderCursorSchema.nullable().optional(),
});

export type TranscriptItem = z.infer<typeof TranscriptItemSchema>;
export type TranscriptOrderCursor = z.infer<typeof TranscriptOrderCursorSchema>;

export const TranscriptPageResultSchema = z.discriminatedUnion("kind", [
  TranscriptPageSchema,
  z.strictObject({
    kind: z.literal("history-reset"),
    orderRevision: PersonalRevisionSchema,
    anchorUnavailable: z.literal(true).optional(),
  }),
]);

export const TranscriptItemBodySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("message"), message: MessageViewSchema }),
  z.strictObject({
    kind: z.literal("tool"),
    arguments: z.unknown(),
    output: ToolOutputViewSchema.omit({ images: true }).optional(),
    images: z.array(TranscriptImageRefSchema).max(8).optional(),
  }),
  z.strictObject({ kind: z.literal("node"), node: ExecutionNodeViewSchema }),
  z.strictObject({ kind: z.literal("run"), run: RunViewSchema }),
  z.strictObject({ kind: z.literal("assignment"), assignment: AssignmentSummarySchema }),
  z.strictObject({ kind: z.literal("place"), place: TranscriptPlaceSchema }),
  z.strictObject({ kind: z.literal("text"), text: z.string().max(480 * 1024) }),
]);

export const TranscriptItemResultSchema = z
  .strictObject({
    threadId: ThreadIdSchema,
    nodeId: ExecutionNodeIdSchema.nullable(),
    item: TranscriptItemSchema,
    body: TranscriptItemBodySchema.nullable(),
    truncated: z.boolean(),
  })
  .refine((value) => utf8ByteLength(JSON.stringify(value)) <= 1024 * 1024);
export type TranscriptItemResult = z.infer<typeof TranscriptItemResultSchema>;
