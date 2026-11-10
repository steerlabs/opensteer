import type { ThreadReachScope, UserId } from "@opensteer/core";
import type { RunnerAgentsModule } from "@opensteer/protocol";
import type { RunToolScope } from "../agents/run-tool-tokens.js";
import type { AgentCaller } from "../mcp/agent-caller.js";

type AdvertisedAgents = Pick<RunnerAgentsModule, "knowledgeSkill"> | null | undefined;

/**
 * The one rule for who holds the knowledge trial's skill and `sql` tool, the
 * boundary personal memory follows: the Personal owner's own Run that inherits
 * Main, on a Runner that can load the skill. Planning, listing and dispatch all ask it.
 */
export function knowledgeEligible(input: {
  readonly callerKind: AgentCaller["kind"];
  readonly reach: ThreadReachScope["kind"];
  readonly userId: UserId;
  readonly owner: UserId | null;
  readonly agents: AdvertisedAgents;
}): boolean {
  return (
    input.callerKind === "run" &&
    input.reach === "user" &&
    input.owner !== null &&
    input.userId === input.owner &&
    input.agents?.knowledgeSkill === 1
  );
}

/** The same rule for an MCP caller, judged on the Runner its Run was bound to. */
export function knowledgeForCaller(options: {
  readonly owner: () => Promise<UserId | null>;
  readonly agents: (
    runnerId: RunToolScope["runnerId"],
    runnerBootId: RunToolScope["runnerBootId"],
  ) => AdvertisedAgents;
}): (caller: AgentCaller) => Promise<boolean> {
  return async (caller) =>
    caller.kind === "run" &&
    knowledgeEligible({
      callerKind: caller.kind,
      reach: caller.reach.kind,
      userId: caller.userId,
      owner: await options.owner(),
      agents: options.agents(caller.claims.runnerId, caller.claims.runnerBootId),
    });
}
