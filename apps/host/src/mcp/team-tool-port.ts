import type { DeploymentId, RunId, TeamAgentRequestId } from "@opensteer/core";
import type { team_read, team_search, team_reply, sql } from "@opensteer/agent-tools/tools";
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
  sql(
    run: TeamToolRun,
    input: z.output<typeof sql.input>,
    signal?: AbortSignal,
  ): Promise<z.output<typeof sql.output>>;
}
