import { z } from "zod";
import {
  DeploymentIdSchema,
  HostInstanceIdSchema,
  IsoDateTimeSchema,
  RunIdSchema,
  MessageIdSchema,
  SequenceSchema,
  TeamAgentRequestIdSchema,
  TeamBlobIdSchema,
  TeamChannelIdSchema,
  TeamLinkIdSchema,
  TeamMessageIdSchema,
  TeamOriginSchema,
  TeamSourceSchema,
  TeamStatusStepSchema,
  ThreadIdSchema,
  UserIdSchema,
} from "@opensteer/core";
import {
  TeamAgentRequestSchema,
  TeamChannelsResultSchema,
  TeamFileSchema,
  TeamMarkdownSchema,
  TeamReadResultSchema,
  TeamRequestContextSchema,
  TeamSearchInputSchema,
  TeamSearchPageSchema,
} from "./team-chat.js";
import {
  TeamKnowledgeReadInputSchema,
  TeamKnowledgeReadResultSchema,
  TeamKnowledgeTopicsResultSchema,
  TeamKnowledgeWriteResultSchema,
  TeamKnowledgeWriteSchema,
} from "./team-knowledge.js";
import { ProtocolErrorSchema } from "./common.js";

export const TeamLinkCredentialSchema = z.string().regex(/^ost_link_[A-Za-z0-9_-]{43}$/);
export const TeamLinkCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const TeamLinkOfferSchema = z.strictObject({
  origin: TeamOriginSchema,
  teamId: DeploymentIdSchema,
  hostKeyFingerprint: z.string().min(1).max(128),
  code: TeamLinkCodeSchema,
});
export type TeamLinkOffer = z.infer<typeof TeamLinkOfferSchema>;
export const TeamLinkRedeemSchema = z.strictObject({
  code: TeamLinkCodeSchema,
  credentialHash: z.string().regex(/^[a-f0-9]{64}$/),
  personalDeploymentId: DeploymentIdSchema,
  installationLabel: z.string().trim().min(1).max(120),
});
export const TeamLinkViewSchema = z.strictObject({
  teamName: z.string().min(1).max(160),
  id: TeamLinkIdSchema,
  ownerUserId: UserIdSchema,
  personalDeploymentId: DeploymentIdSchema.nullable(),
  installationLabel: z.string().max(120).nullable(),
  state: z.enum(["pending", "active", "revoked"]),
  lastSeenAt: IsoDateTimeSchema.nullable(),
});
export const PersonalTeamLinkSchema = z.strictObject({
  teamId: DeploymentIdSchema,
  hostInstanceId: HostInstanceIdSchema,
  origin: TeamOriginSchema,
  teamName: z.string().min(1).max(160),
  remoteLinkId: TeamLinkIdSchema.nullable(),
  ownerUserId: UserIdSchema.nullable(),
  state: z.enum(["joining", "active", "unreachable", "leaving", "revoked", "needs_update"]),
  updateRequiredBy: z.enum(["personal", "team"]).nullable(),
  lastContactAt: IsoDateTimeSchema.nullable(),
});
export type PersonalTeamLink = z.infer<typeof PersonalTeamLinkSchema>;
export const PersonalTeamRequestSchema = z.strictObject({
  teamId: DeploymentIdSchema,
  requestId: TeamAgentRequestIdSchema,
  answerMessageId: MessageIdSchema.nullable().default(null),
  answerPayload: z
    .strictObject({
      bodyMarkdown: TeamMarkdownSchema,
      attachmentIds: z.array(TeamBlobIdSchema).max(10),
    })
    .nullable()
    .default(null),
  clientMessageId: z.uuid().nullable().default(null),
  deliveryVia: z.enum(["final", "tool"]).nullable().default(null),
  blockedReason: z.string().min(1).max(500).nullable().default(null),
  triggerMessageId: TeamMessageIdSchema,
  taskId: ThreadIdSchema,
  inputId: z.string().min(1).max(255),
  runId: RunIdSchema.nullable(),
  publicationState: z.enum(["pending", "accepted", "blocked"]),
  terminalState: z.enum(["done", "failed", "stopped", "cancelled"]).nullable(),
  replyMessageId: TeamMessageIdSchema.nullable(),
  source: TeamSourceSchema,
});
export type PersonalTeamRequest = z.infer<typeof PersonalTeamRequestSchema>;
export const TeamLinkWebSocketHeadersSchema = z.strictObject({
  "x-opensteer-team-api-version": z.string().regex(/^[1-9][0-9]*$/),
  authorization: z.string().regex(/^Bearer ost_link_[A-Za-z0-9_-]{43}$/),
});
export const TeamBinaryRouteHeadersSchema = TeamLinkWebSocketHeadersSchema.extend({
  "x-opensteer-team-request-id": TeamAgentRequestIdSchema.optional(),
  "x-opensteer-team-run-id": RunIdSchema,
  "x-opensteer-team-operation-id": z.string().min(1).max(128),
});
export const teamBinaryRoutes = {
  upload: "/internal/v1/team/files/upload",
  download: "/internal/v1/team/files/download",
} as const;
export const TeamUploadMetadataSchema = z.strictObject({
  clientUploadId: z.uuid(),
  filename: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(255),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(100 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  previewSizeBytes: z
    .number()
    .int()
    .nonnegative()
    .max(64 * 1024),
});
export const TeamBinaryUploadMetadataSchema = TeamUploadMetadataSchema.extend({
  channelId: TeamChannelIdSchema,
});
export const TeamBinaryDownloadHeadersSchema = TeamBinaryRouteHeadersSchema.extend({
  "x-opensteer-team-blob-id": TeamBlobIdSchema,
  "x-opensteer-team-file-part": z.enum(["original", "preview"]),
});
const request = { requestId: TeamAgentRequestIdSchema };
const optionalRequest = { requestId: TeamAgentRequestIdSchema.optional() };
const attribution = { runId: RunIdSchema };
const call = { id: z.string().min(1).max(128) };
export const TeamLinkClientFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("hello"),
    teamApiVersion: z.number().int().positive(),
    terminalRequests: z
      .array(
        PersonalTeamRequestSchema.pick({
          requestId: true,
          terminalState: true,
          publicationState: true,
        }),
      )
      .max(32),
  }),
  z.strictObject({ ...call, ...request, type: z.literal("accept") }),
  z.strictObject({ ...call, ...request, type: z.literal("context") }),
  z.strictObject({
    ...call,
    ...request,
    type: z.literal("status"),
    state: z.enum(["working", "needs_you", "failed", "stopped", "cancelled"]),
    steps: z.array(TeamStatusStepSchema).max(8),
  }),
  z.strictObject({
    ...call,
    ...optionalRequest,
    ...attribution,
    type: z.literal("post"),
    publication: z.boolean().optional(),
    clientMessageId: z.uuid(),
    channelId: TeamChannelIdSchema,
    threadRootId: TeamMessageIdSchema.optional(),
    bodyMarkdown: TeamMarkdownSchema,
    attachmentIds: z.array(TeamBlobIdSchema).max(10),
  }),
  z.strictObject({ ...call, ...request, type: z.literal("receipt") }),
  z
    .strictObject({
      ...call,
      ...optionalRequest,
      ...attribution,
      type: z.literal("read"),
      channelId: TeamChannelIdSchema,
      threadRootId: TeamMessageIdSchema.optional(),
      before: TeamMessageIdSchema.optional(),
      after: TeamMessageIdSchema.optional(),
    })
    .refine((input) => !(input.before && input.after), "Choose before or after"),
  z.strictObject({
    ...call,
    ...optionalRequest,
    ...attribution,
    type: z.literal("search"),
    input: TeamSearchInputSchema,
  }),
  // Knowledge acts as the link's owner; a request, when named, only records where the ask came from.
  z.strictObject({ ...call, ...optionalRequest, type: z.literal("knowledge.topics") }),
  z.strictObject({
    ...call,
    ...optionalRequest,
    type: z.literal("knowledge.read"),
    input: TeamKnowledgeReadInputSchema,
  }),
  z.strictObject({
    ...call,
    ...optionalRequest,
    type: z.literal("knowledge.write"),
    input: TeamKnowledgeWriteSchema,
  }),
  z.strictObject({
    ...call,
    ...attribution,
    type: z.literal("channels"),
    after: TeamChannelIdSchema.optional(),
  }),
  z.strictObject({ ...call, type: z.literal("revoke") }),
  z.strictObject({ type: z.literal("ping") }),
]);
export type TeamLinkClientFrame = z.infer<typeof TeamLinkClientFrameSchema>;
export const TeamLinkResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("accepted"), request: TeamAgentRequestSchema }),
  z.strictObject({ kind: z.literal("context"), context: TeamRequestContextSchema }),
  z.strictObject({ kind: z.literal("receipt"), messageId: TeamMessageIdSchema.nullable() }),
  z.strictObject({ kind: z.literal("read"), result: TeamReadResultSchema }),
  z.strictObject({ kind: z.literal("search"), result: TeamSearchPageSchema }),
  z.strictObject({ kind: z.literal("knowledge.topics"), result: TeamKnowledgeTopicsResultSchema }),
  z.strictObject({ kind: z.literal("knowledge.read"), result: TeamKnowledgeReadResultSchema }),
  z.strictObject({ kind: z.literal("knowledge.write"), result: TeamKnowledgeWriteResultSchema }),
  z.strictObject({ kind: z.literal("file"), file: TeamFileSchema, source: TeamSourceSchema }),
  z.strictObject({ kind: z.literal("ok") }),
  z.strictObject({ kind: z.literal("channels"), result: TeamChannelsResultSchema }),
]);
export const TeamRunRequestSchema = z.strictObject({
  request: TeamAgentRequestSchema,
  source: TeamSourceSchema,
  bodyMarkdown: TeamMarkdownSchema,
  attachments: z.array(TeamFileSchema).max(10),
});
export type TeamRunRequest = z.infer<typeof TeamRunRequestSchema>;
export const TeamLinkServerFrameSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ready"),
    teamApiVersion: z.number().int().positive(),
    link: TeamLinkViewSchema,
    accessRevision: SequenceSchema,
  }),
  z.strictObject({
    type: z.literal("requests"),
    requests: z.array(TeamRunRequestSchema).max(32),
  }),
  z.strictObject({ type: z.literal("cancel"), requestId: TeamAgentRequestIdSchema }),
  z.strictObject({ ...call, type: z.literal("result"), result: TeamLinkResultSchema }),
  z.strictObject({ ...call, type: z.literal("error"), error: ProtocolErrorSchema }),
  z.strictObject({ type: z.literal("revoked") }),
  z.strictObject({ type: z.literal("pong") }),
]);
export type TeamLinkServerFrame = z.infer<typeof TeamLinkServerFrameSchema>;

export function serializeTeamLinkOffer(offer: TeamLinkOffer): string {
  const parsed = TeamLinkOfferSchema.parse(offer);
  const url = new URL("/agent-link", parsed.origin);
  url.hash = new URLSearchParams({
    teamId: parsed.teamId,
    fingerprint: parsed.hostKeyFingerprint,
    code: parsed.code,
  }).toString();
  return url.href;
}
export function parseTeamLinkOffer(text: string): TeamLinkOffer | null {
  try {
    const url = new URL(text);
    if (url.pathname !== "/agent-link" || url.search || url.username || url.password) return null;
    const params = new URLSearchParams(url.hash.slice(1));
    if (params.size !== 3) return null;
    const parsed = TeamLinkOfferSchema.safeParse({
      origin: url.origin,
      teamId: params.get("teamId"),
      hostKeyFingerprint: params.get("fingerprint"),
      code: params.get("code"),
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
export const TeamLinkOfferTextSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((text) => parseTeamLinkOffer(text) !== null, "Invalid team link code");

export const TeamBinaryUploadHeadersSchema = TeamBinaryRouteHeadersSchema.extend({
  "content-type": z
    .string()
    .max(128)
    .regex(/^multipart\/form-data; boundary=[A-Za-z0-9'()+_,./:=?-]{1,70}$/),
  "x-opensteer-team-upload": z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        return TeamBinaryUploadMetadataSchema.safeParse(JSON.parse(value)).success;
      } catch {
        return false;
      }
    }, "Invalid upload metadata"),
});
