import type { DeploymentId, RunId, TeamAgentRequestId } from "@opensteer/core";
import type {
  knowledge_read,
  knowledge_topics,
  knowledge_write,
  team_read,
  team_search,
  team_reply,
} from "@opensteer/agent-tools/tools";
import type { z } from "zod";

export interface TeamToolRun {
  readonly teamId: DeploymentId;
  readonly requestId: TeamAgentRequestId;
  readonly runId: RunId;
}
/** L implements this over its private link; credentials never enter model input or output. */
export interface TeamToolPort {
  read(
    run: TeamToolRun,
    input: z.output<typeof team_read.input>,
    signal?: AbortSignal,
  ): Promise<z.output<typeof team_read.output>>;
  search(
    run: TeamToolRun,
    input: z.output<typeof team_search.input>,
    signal?: AbortSignal,
  ): Promise<z.output<typeof team_search.output>>;
  reply(
    run: TeamToolRun,
    input: z.output<typeof team_reply.input>,
    signal?: AbortSignal,
  ): Promise<z.output<typeof team_reply.output>>;
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
    input: z.output<typeof knowledge_topics.input>,
    signal?: AbortSignal,
  ): Promise<z.output<typeof knowledge_topics.output>>;
  read(
    caller: TeamKnowledgeCaller,
    input: z.output<typeof knowledge_read.input>,
    signal?: AbortSignal,
  ): Promise<z.output<typeof knowledge_read.output>>;
  write(
    caller: TeamKnowledgeCaller,
    input: z.output<typeof knowledge_write.input>,
    signal?: AbortSignal,
  ): Promise<z.output<typeof knowledge_write.output>>;
}
