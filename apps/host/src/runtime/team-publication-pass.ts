import type { DeploymentId, TeamAgentRequestId } from "@opensteer/core";
import type { PersonalTeamRequest } from "@opensteer/protocol";
import { retryWithBackoff } from "./deadline-drain.js";

export interface TeamPublicationPassOptions {
  /** Teams whose link can carry a publication right now. */
  readonly readyTeams: () => readonly DeploymentId[];
  readonly owed: (input: {
    readonly teamIds: readonly DeploymentId[];
    readonly after?: { readonly teamId: DeploymentId; readonly requestId: TeamAgentRequestId };
    readonly limit: number;
  }) => Promise<readonly PersonalTeamRequest[]>;
  /** Whether this attempt recorded the request's terminal state. */
  readonly reconcile: (request: PersonalTeamRequest) => Promise<boolean>;
  readonly report: (error: unknown) => void;
  readonly pageSize?: number;
}

/**
 * One pass of the owner for finished team Runs whose answer has not been
 * recorded. What is owed comes from the persisted rows alone (a terminal Run,
 * a request with no terminal state), so a restart, a recovered link and a
 * normal finish all find the same work. Only teams whose link is ready are
 * read, and the pass pages through every owed row, so rows that cannot be
 * published never hold a page against ones that can. Any row this pass did
 * not record owes a retry with backoff; a failed read throws, which the
 * DeadlineDrain also answers with a backoff retry. A link becoming ready wakes
 * the owner for the rows it was skipping.
 */
export async function teamPublicationPass(
  options: TeamPublicationPassOptions,
): Promise<null | typeof retryWithBackoff> {
  const teamIds = options.readyTeams();
  const limit = options.pageSize ?? 100;
  let after: { teamId: DeploymentId; requestId: TeamAgentRequestId } | undefined;
  let unrecorded = 0;
  for (;;) {
    const page = await options.owed({ teamIds, limit, ...(after ? { after } : {}) });
    for (const request of page) {
      try {
        if (!(await options.reconcile(request))) unrecorded += 1;
      } catch (error) {
        unrecorded += 1;
        options.report(error);
      }
    }
    if (page.length < limit) break;
    const last = page.at(-1)!;
    after = { teamId: last.teamId, requestId: last.requestId };
  }
  return unrecorded > 0 ? retryWithBackoff : null;
}
