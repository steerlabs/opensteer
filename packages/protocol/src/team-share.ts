import { z } from "zod";
import {
  DeploymentIdSchema,
  TeamAgentRequestStateSchema,
  TeamAgentReturnOutcomeSchema,
  IsoDateTimeSchema,
  SequenceSchema,
  TeamHandleSchema,
  UserIdSchema,
} from "@opensteer/core";
import { TeamRequestTextSchema as TeamMarkdownSchema } from "@opensteer/core";
import { TeamFileSchema, teamUploadMaxBytes } from "./team-chat.js";

export const teamSharedAgentsCapability = "team-shared-agents-v1";
export const teamShareCapability = "team-shared-channels-v1";
export const teamShareMaxRows = 100_000;
export const teamShareMaxBytes = 128 * 1024 * 1024;
export const teamShareRosterBytes = 128 * 1024;
export const teamShareBatchRows = 32;
export const teamShareBatchBytes = 240 * 1024;
export const teamShareFileChunkBytes = 128 * 1024;
export const teamShareFileBytesPerMinute = 256 * 1024 * 1024;
export const TeamShareFileSchema = z.strictObject({
  teamId: DeploymentIdSchema,
  publicId: z.uuid(),
  filename: TeamFileSchema.shape.filename,
  mediaType: TeamFileSchema.shape.mediaType,
  sizeBytes: TeamFileSchema.shape.sizeBytes.positive(),
  sha256: TeamFileSchema.shape.sha256,
  preview: TeamFileSchema.shape.preview
    .unwrap()
    .extend({
      sha256: TeamFileSchema.shape.sha256,
    })
    .nullable(),
});
export type TeamShareFile = z.infer<typeof TeamShareFileSchema>;
export const TeamShareFileChunkSchema = z.strictObject({
  bytes: z.base64().max(Math.ceil(teamShareFileChunkBytes / 3) * 4),
});
export const TeamSharePersonRefSchema = z.strictObject({
  teamId: DeploymentIdSchema,
  userId: UserIdSchema,
});
export const TeamSharePersonSchema = TeamSharePersonRefSchema.extend({
  name: z.string().min(1).max(160),
  handle: TeamHandleSchema,
  level: z.enum(["read", "post"]),
  state: z.enum(["active", "removed"]),
}).strict();
export const TeamShareAskStatusSchema = z
  .strictObject({
    revision: SequenceSchema,
    refusal: z.enum(["people-only", "no-access", "no-link", "rate-limited"]).optional(),
    state: TeamAgentRequestStateSchema.exclude(["queued"]),
    consentExpiresAt: IsoDateTimeSchema.nullable(),
    acceptedAt: IsoDateTimeSchema.nullable(),
    expiresAt: IsoDateTimeSchema.nullable(),
    finishedAt: IsoDateTimeSchema.nullable(),
    failureCode: z
      .enum([
        "expired",
        "access_revoked",
        "link_revoked",
        "trigger_deleted",
        "trigger_edited",
        "execution_failed",
      ])
      .nullable(),
    outcome: TeamAgentReturnOutcomeSchema.nullable(),
    replyPublicId: z.uuid().nullable(),
  })
  .refine(
    (v) =>
      ["declined", "done", "failed", "cancelled", "stopped"].includes(v.state) ===
      (v.finishedAt !== null),
  )
  .refine((v) => (v.outcome === "answered") === (v.replyPublicId !== null));
export type TeamShareAskStatus = z.infer<typeof TeamShareAskStatusSchema>;
export const TeamShareAskSchema = z.strictObject({
  target: TeamSharePersonRefSchema,
  status: TeamShareAskStatusSchema.nullable(),
});
export const TeamShareRowSchema = z.strictObject({
  kind: z.literal("text"),
  asks: z.array(TeamShareAskSchema).max(20).optional(),
  publicId: z.uuid(),
  ordinal: SequenceSchema,
  sequence: SequenceSchema,
  author: TeamSharePersonRefSchema,
  authorKind: z.enum(["human", "agent"]),
  clientMessageId: z.uuid(),
  bodyMarkdown: TeamMarkdownSchema,
  threadRootPublicId: z.uuid().nullable(),
  createdAt: IsoDateTimeSchema,
  editedAt: IsoDateTimeSchema.nullable(),
  deletedAt: IsoDateTimeSchema.nullable(),
  pinnedBy: TeamSharePersonRefSchema.nullable(),
  attachments: z.array(TeamShareFileSchema).max(10).default([]),
});
export type TeamShareRow = z.infer<typeof TeamShareRowSchema>;
export const TeamShareCursorSchema = z.strictObject({
  created: SequenceSchema,
  sequence: SequenceSchema,
  publicId: z.union([z.literal(""), z.uuid()]),
});
export const TeamShareBatchSchema = z
  .strictObject({
    rows: z.array(TeamShareRowSchema).max(teamShareBatchRows),
    people: z.array(TeamSharePersonSchema).max(1000),
    peopleOnly: z.boolean(),
    cursor: TeamShareCursorSchema,
    more: z.boolean(),
  })
  .refine(
    (v) => new TextEncoder().encode(JSON.stringify(v)).byteLength <= teamShareBatchBytes,
    "Share batch exceeds byte limit",
  );
const scope = { shareId: z.uuid(), generation: z.number().int().positive() };
export const TeamShareWriteSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("send"),
    publication: z.boolean().optional(),
    author: TeamSharePersonRefSchema,
    authorKind: z.enum(["human", "agent"]),
    clientMessageId: z.uuid(),
    bodyMarkdown: TeamMarkdownSchema,
    threadRootPublicId: z.uuid().nullable(),
    attachments: z.array(TeamShareFileSchema).max(10).default([]),
  }),
  z.strictObject({
    action: z.literal("edit"),
    author: TeamSharePersonRefSchema,
    publicId: z.uuid(),
    bodyMarkdown: TeamMarkdownSchema,
  }),
  z.strictObject({
    action: z.literal("delete"),
    author: TeamSharePersonRefSchema,
    publicId: z.uuid(),
  }),
  z.strictObject({
    action: z.literal("pin"),
    author: TeamSharePersonRefSchema,
    publicId: z.uuid(),
    pinned: z.boolean(),
  }),
]);
export const TeamShareReceiptSchema = z.strictObject({
  publicId: z.uuid(),
  batch: TeamShareBatchSchema,
});
export const TeamShareOperationSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("offer"),
    historyFromShareId: z.uuid().nullable(),
    ...scope,
    name: z.string().min(1).max(160),
    peopleOnly: z.boolean(),
  }),
  z.strictObject({
    op: z.literal("accept"),
    ...scope,
    people: z.array(TeamSharePersonSchema).max(1000),
  }),
  z.strictObject({
    op: z.literal("roster"),
    ...scope,
    people: z.array(TeamSharePersonSchema).max(1000),
  }),
  z.strictObject({ op: z.literal("pull"), ...scope, cursor: TeamShareCursorSchema }),
  z.strictObject({
    op: z.literal("write"),
    createdThrough: SequenceSchema,
    ...scope,
    write: TeamShareWriteSchema,
  }),
  z.strictObject({
    op: z.literal("ask.status"),
    ...scope,
    triggerPublicId: z.uuid(),
    target: TeamSharePersonRefSchema,
    status: TeamShareAskStatusSchema,
  }),
  z.strictObject({ op: z.literal("end"), ...scope }),
  z.strictObject({
    op: z.literal("file"),
    ...scope,
    publicId: z.uuid(),
    part: z.enum(["original", "preview"]),
    offset: z.number().int().nonnegative().max(teamUploadMaxBytes),
  }),
]);
export type TeamShareOperation = z.infer<typeof TeamShareOperationSchema>;
export type TeamSharePerson = z.infer<typeof TeamSharePersonSchema>;
export type TeamShareBatch = z.infer<typeof TeamShareBatchSchema>;
export const TeamPartnerDataFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("share.request"), id: z.uuid(), operation: z.unknown() }),
  z.strictObject({
    type: z.literal("share.response"),
    id: z.uuid(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    reason: z.enum(["not-found", "retryable", "unsupported"]).optional(),
    retryAfterMs: z.number().int().positive().max(60_000).optional(),
  }),
  z.strictObject({ type: z.literal("share.changed"), ...scope }),
]);
