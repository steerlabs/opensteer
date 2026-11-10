import type { OpensteerStore } from "@opensteer/database";
import type { RunnerAgentsModule } from "@opensteer/protocol";
import type { RunToolScope } from "../agents/run-tool-tokens.js";
import type { AgentCaller } from "../mcp/agent-caller.js";

type AdvertisedAgents = Pick<RunnerAgentsModule, "knowledgeSkill"> | null | undefined;

/**
 * The one rule for who holds the knowledge trial's skill and `sql` tool: a Run
 * in Main whose whole lineage its owner started in their own session, on a
 * Runner that can load the skill. Planning, listing and dispatch all ask it.
 */
export function knowledgeEligible(input: {
  readonly enabled: boolean;
  readonly thread: { readonly inheritsMain: boolean; readonly ownerStarted: boolean } | null;
  readonly agents: AdvertisedAgents;
}): boolean {
  return (
    input.enabled &&
    input.thread?.inheritsMain === true &&
    input.thread.ownerStarted &&
    input.agents?.knowledgeSkill === 1
  );
}

/** The same rule for an MCP caller: only a Run, judged on its own Thread and the Runner it was bound to. */
export function knowledgeForCaller(options: {
  readonly store: Pick<OpensteerStore, "threadProvenance">;
  readonly agents: (
    runnerId: RunToolScope["runnerId"],
    runnerBootId: RunToolScope["runnerBootId"],
  ) => AdvertisedAgents;
}): (caller: AgentCaller) => Promise<boolean> {
  return async (caller) =>
    caller.kind === "run" &&
    knowledgeEligible({
      enabled: true,
      thread: await options.store.threadProvenance(caller.thread.id),
      agents: options.agents(caller.claims.runnerId, caller.claims.runnerBootId),
    });
}
