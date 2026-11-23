import {
  AppIdSchema,
  ArtifactContentPartSchema,
  BrowserPageContentPartSchema,
  ComputerAppContentPartSchema,
  PhoneContentPartSchema,
  DeploymentIdSchema,
  DelegationIdSchema,
  ExecutionNodeIdSchema,
  MessageIdSchema,
  MessageViewSchema,
  MessageAuthorViewSchema,
  MessageEditViewSchema,
  IntegrationCallSubjectViewSchema,
  ToolIdentityViewSchema,
  ToolOutputViewSchema,
  ExecutionNodeViewSchema,
  RunViewSchema,
  RunRetryViewSchema,
  RunUsageViewSchema,
  RunFailureViewSchema,
  RunInterruptedCauseSchema,
  RequestKindSchema,
  AnsweredQuestionSchema,
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
  beforePosition: TranscriptPositionSchema,
  beforeId: TranscriptItemIdSchema,
});

export const TranscriptOrderCursorViewSchema = z.object(TranscriptOrderCursorSchema.shape);

export const TranscriptItemPreviewSchema = z
  .object({
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
const TranscriptPlaceViewSchema = z.object(TranscriptPlaceSchema.shape);
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
const clientSendKey = z.string().min(1).max(255);
// Covers JSON escaping and the field name when a sender reads their item.
export const clientSendKeyWireReserve = 6 * 255 + 20;

/** At most this many references of each kind ride on a message card; the body has the rest. */
export const transcriptMessageRefLimits = { attachments: 6, pages: 4, places: 4 } as const;
/** The references' combined JSON size; references past it are left to the body. */
export const transcriptMessageRefsMaxBytes = 4 * 1024;
/**
 * Maximum JSON-encoded UTF-8 bytes of conversation prose carried inline on a `message` or
 * `node-message` item. Keeps ordinary assistant replies, user prompts and subagent messages whole
 * on the wire while bounding JSON-escaped payloads (including control chars and quotes) safely
 * inside `personalChangesFrameMaxBytes` (512 KiB) and `personalDetailFrameMaxBytes` (1 MiB).
 */
export const transcriptInlineTextMaxBytes = 480 * 1024;

/**
 * Shared inline-text admission rule for both DB projections and mocks: checks both UTF-16 schema
 * length and exact JSON-encoded UTF-8 byte length against `transcriptInlineTextMaxBytes`.
 */
export function fitsInlineTranscriptText(text: string): boolean {
  if (text.length > transcriptInlineTextMaxBytes) return false;
  // Fast path: even worst-case 6-byte `\uXXXX` escaping per code unit fits inside the budget.
  if (text.length * 6 + 2 <= transcriptInlineTextMaxBytes) return true;
  return utf8ByteLength(JSON.stringify(text)) <= transcriptInlineTextMaxBytes;
}
export const TranscriptMessageRefsSchema = z.object({
  attachments: z
    .array(z.object(ArtifactContentPartSchema.shape))
    .max(transcriptMessageRefLimits.attachments)
    .optional(),
  pages: z
    .array(z.object(BrowserPageContentPartSchema.shape))
    .max(transcriptMessageRefLimits.pages)
    .optional(),
  places: z
    .array(
      z.discriminatedUnion("type", [
        z.object(ComputerAppContentPartSchema.shape),
        z.object(PhoneContentPartSchema.shape),
      ]),
    )
    .max(transcriptMessageRefLimits.places)
    .optional(),
});
export type TranscriptMessageRefs = z.infer<typeof TranscriptMessageRefsSchema>;

export const TranscriptItemSchema = z.discriminatedUnion("kind", [
  z.object({
    ...card,
    ...TranscriptMessageRefsSchema.shape,
    kind: z.literal("message"),
    messageId: MessageIdSchema,
    clientSendKey: clientSendKey.optional(),
    messageKind: z.enum(["assistant", "input", "continuation"]).optional(),
    author: MessageAuthorViewSchema.optional(),
    edit: MessageEditViewSchema.optional(),
    delivery: z
      .object({
        status: z.enum(["failed", "unconfirmed"]),
        reason: z.string().max(500),
      })
      .optional(),
    /** Full unstripped message text when it fits within `transcriptInlineTextMaxBytes`. */
    text: z.string().max(transcriptInlineTextMaxBytes).optional(),
  }),
  z.object({
    ...card,
    kind: z.literal("tool"),
    toolCallId: z.string().min(1).max(160),
    tool: ToolIdentityViewSchema.nullable().optional(),
    completedAt: z.iso.datetime().optional(),
    view: TranscriptItemPreviewSchema.refine((value) => value.preview === undefined),
  }),
  z.object({
    ...card,
    kind: z.literal("run"),
    runId: RunIdSchema,
    replyMessageId: MessageIdSchema.nullable().optional(),
    endedAt: z.iso.datetime().optional(),
    interruptedCause: RunInterruptedCauseSchema.optional(),
    stopConfirmedAt: z.iso.datetime().optional(),
    usage: RunUsageViewSchema.optional(),
    failure: RunFailureViewSchema.optional(),
    retry: RunRetryViewSchema.optional(),
  }),
  z.object({
    ...card,
    kind: z.literal("request"),
    requestId: RequestIdSchema,
    requestKind: RequestKindSchema.optional(),
    waitedSince: z.iso.datetime().optional(),
    /** A settled agent question: what was asked and the answer, cut to fit. */
    question: AnsweredQuestionSchema.optional(),
  }),
  z.object({
    ...card,
    kind: z.literal("node"),
    executionNodeId: ExecutionNodeIdSchema,
    node: ExecutionNodeViewSchema.optional(),
  }),
  z.object({
    ...card,
    kind: z.literal("assignment"),
    delegationId: DelegationIdSchema,
    assignment: AssignmentSummarySchema.optional(),
  }),
  z.object({
    ...card,
    kind: z.literal("app"),
    appId: AppIdSchema,
    version: z.int().nonnegative().optional(),
  }),
  z.object({
    ...card,
    kind: z.literal("reasoning"),
    blockId: z.string().min(1).max(255),
    bindingGeneration: z.int().nonnegative().nullable(),
  }),
  z.object({
    ...card,
    kind: z.literal("node-message"),
    nodeId: ExecutionNodeIdSchema,
    /** Full subagent message text when it fits within `transcriptInlineTextMaxBytes`. */
    text: z.string().max(transcriptInlineTextMaxBytes).optional(),
  }),
  z.object({ ...card, kind: z.literal("place"), place: TranscriptPlaceViewSchema.optional() }),
]);

export const TranscriptPageSchema = z.object({
  kind: z.literal("page"),
  threadId: ThreadIdSchema,
  nodeId: ExecutionNodeIdSchema.nullable(),
  revision: PersonalRevisionSchema,
  items: z.array(TranscriptItemSchema).max(100),
  hasMore: z.boolean(),
  nextBefore: TranscriptOrderCursorViewSchema.nullable(),
  nextAfter: TranscriptOrderCursorViewSchema.nullable().optional(),
});

export type TranscriptItem = z.infer<typeof TranscriptItemSchema>;
export type TranscriptOrderCursor = z.infer<typeof TranscriptOrderCursorSchema>;

export const TranscriptPageResultSchema = z.discriminatedUnion("kind", [
  TranscriptPageSchema,
  z.object({
    kind: z.literal("history-reset"),
    anchorUnavailable: z.literal(true).optional(),
  }),
]);

export const TranscriptItemBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), message: MessageViewSchema }),
  z.object({
    kind: z.literal("tool"),
    arguments: z.unknown(),
    integration: IntegrationCallSubjectViewSchema.optional(),
    output: ToolOutputViewSchema.omit({ images: true }).optional(),
    images: z.array(TranscriptImageRefSchema).max(8).optional(),
  }),
  z.object({ kind: z.literal("node"), node: ExecutionNodeViewSchema }),
  z.object({ kind: z.literal("run"), run: RunViewSchema }),
  z.object({ kind: z.literal("assignment"), assignment: AssignmentSummarySchema }),
  z.object({ kind: z.literal("place"), place: TranscriptPlaceViewSchema }),
  z.object({ kind: z.literal("text"), text: z.string().max(transcriptInlineTextMaxBytes) }),
]);

export const TranscriptItemResultSchema = z
  .object({
    threadId: ThreadIdSchema,
    nodeId: ExecutionNodeIdSchema.nullable(),
    item: TranscriptItemSchema,
    body: TranscriptItemBodySchema.nullable(),
    truncated: z.boolean(),
  })
  .refine((value) => utf8ByteLength(JSON.stringify(value)) <= 1024 * 1024);
export type TranscriptItemResult = z.infer<typeof TranscriptItemResultSchema>;
