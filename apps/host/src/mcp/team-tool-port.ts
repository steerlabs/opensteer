import type { TeamKnowledgeReadInputSchema } from "@opensteer/protocol";
import type { TeamChannelId, TeamMessageId, TeamBlobId } from "@opensteer/core";
import type { DeploymentId, RunId, TeamAgentRequestId } from "@opensteer/core";
import type {
  opensteer_knowledge_read,
  opensteer_knowledge_topic_list,
  opensteer_knowledge_save,
  opensteer_team_search,
  opensteer_team_post,
} from "@opensteer/agent-tools/tools";
import type { z } from "zod";

export interface TeamToolRun {
  readonly operationId: string;
  readonly runId: RunId;
}
/** L implements this over its private link; credentials never enter model input or output. */
export interface TeamToolPort {
  read(
    run: TeamToolRun,
    input: {
      teamId?: DeploymentId | undefined;
      channelId?: TeamChannelId | undefined;
      threadRootId?: TeamMessageId | undefined;
      before?: TeamMessageId | undefined;
      after?: TeamMessageId | TeamChannelId | undefined;
      fileId?: TeamBlobId | undefined;
    },
    signal?: AbortSignal,
  ): Promise<
    | {
        teams: Pick<
          z.output<typeof import("@opensteer/protocol").PersonalTeamLinkSchema>,
          "teamId" | "teamName" | "state"
        >[];
      }
    | (Omit<z.output<typeof import("@opensteer/protocol").TeamChannelsResultSchema>, "channels"> & {
        channels: import("@opensteer/agent-tools/tools").AgentTeamChannelSummary[];
      })
    | (Omit<import("@opensteer/agent-tools/tools").AgentTeamReadResult, "page"> & {
        page: Omit<import("@opensteer/agent-tools/tools").AgentTeamMessagePage, "nextCursor">;
      })
    | {
        path: string;
        link?: string;
        source: z.output<typeof import("@opensteer/core").TeamSourceSchema>;
      }
  >;
  search(
    run: TeamToolRun,
    input: Omit<z.output<typeof opensteer_team_search.input>, "cursor"> & {
      before?:
        z.output<typeof import("@opensteer/protocol").TeamSearchInputSchema>["before"] | undefined;
    },
    signal?: AbortSignal,
  ): Promise<z.output<typeof opensteer_team_search.output>>;
  post(
    run: TeamToolRun,
    input: Omit<z.output<typeof opensteer_team_post.input>, "threadId"> & {
      threadRootId?: TeamMessageId | undefined;
    },
    signal?: AbortSignal,
  ): Promise<z.output<typeof opensteer_team_post.output>>;
}

/** A Run reaching team knowledge as its owner; a team thread's Run also names its team and request. */
export interface TeamKnowledgeCaller {
  readonly runId: RunId;
  readonly teamOrigin: { readonly teamId: DeploymentId } | null;
  readonly requestId: TeamAgentRequestId | null;
}
export interface TeamKnowledgePort {
  topics(
    caller: TeamKnowledgeCaller,
    input: z.output<typeof opensteer_knowledge_topic_list.input>,
    signal?: AbortSignal,
  ): Promise<z.output<typeof opensteer_knowledge_topic_list.output>>;
  read(
    caller: TeamKnowledgeCaller,
    input: z.output<typeof TeamKnowledgeReadInputSchema> & { team?: DeploymentId | undefined },
    signal?: AbortSignal,
  ): Promise<
    Omit<z.output<typeof opensteer_knowledge_read.output>, "nextCursor"> & {
      nextBefore: string | null;
    }
  >;
  write(
    caller: TeamKnowledgeCaller,
    input: z.output<typeof opensteer_knowledge_save.input> & { delete?: true | undefined },
    signal?: AbortSignal,
  ): Promise<z.output<typeof opensteer_knowledge_save.output>>;
}
