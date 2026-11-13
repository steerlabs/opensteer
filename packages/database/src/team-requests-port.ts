import type {
  RunId,
  TeamAgentRequestId,
  TeamAskDecision,
  TeamBlobId,
  TeamLinkId,
  TeamMessageId,
  TeamStatusStepSchema,
} from "@opensteer/core";
import type {
  TeamAgentRequest,
  TeamRequestContextSchema,
  TeamRunRequest,
} from "@opensteer/protocol";
import type { z } from "zod";

export interface TeamRequestStorePort {
  authorize(
    linkId: TeamLinkId,
    requestId: TeamAgentRequestId,
    action: "read" | "post" | "knowledge" | "status",
  ): Promise<TeamAgentRequest>;
  pending(linkId: TeamLinkId): Promise<readonly TeamRunRequest[]>;
  /** First accept fixes expiry at seven days; repeated accepts never extend it. */
  accept(
    linkId: TeamLinkId,
    requestId: TeamAgentRequestId,
    decision?: TeamAskDecision,
  ): Promise<TeamAgentRequest>;
  context(
    linkId: TeamLinkId,
    requestId: TeamAgentRequestId,
  ): Promise<z.infer<typeof TeamRequestContextSchema>>;
  status(
    linkId: TeamLinkId,
    requestId: TeamAgentRequestId,
    input: {
      readonly state: "working" | "needs_you" | "done" | "failed" | "stopped" | "cancelled";
      readonly steps: readonly z.infer<typeof TeamStatusStepSchema>[];
    },
  ): Promise<void>;
  post(
    linkId: TeamLinkId,
    input: {
      readonly channelId: import("@opensteer/core").TeamChannelId;
      readonly threadRootId?: TeamMessageId | undefined;
      readonly runId?: RunId | undefined;
      readonly clientMessageId: string;
      readonly bodyMarkdown: string;
      readonly attachmentIds: readonly TeamBlobId[];
      readonly requestId?: TeamAgentRequestId | undefined;
      readonly publication?: boolean | undefined;
    },
  ): Promise<TeamMessageId>;
  reply(
    linkId: TeamLinkId,
    requestId: TeamAgentRequestId,
    input: { readonly bodyMarkdown: string; readonly attachmentIds: readonly TeamBlobId[] },
  ): Promise<TeamMessageId>;
  /** A reply claim is readable while its request is still running. */
  receipt(linkId: TeamLinkId, requestId: TeamAgentRequestId): Promise<TeamMessageId | null>;
  cancel(linkId: TeamLinkId, requestId: TeamAgentRequestId): Promise<void>;
}
export interface PersonalTeamRequestRun {
  readonly requestId: TeamAgentRequestId;
  readonly runId: RunId;
}
