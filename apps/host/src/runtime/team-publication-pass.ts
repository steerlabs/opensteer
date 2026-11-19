import type { PersonalTeamRequest } from "@opensteer/protocol";
import { retryWithBackoff } from "./deadline-drain.js";

/**
 * One pass of the owner for finished team Runs whose answer has not been
 * recorded. What is owed comes from the persisted rows alone (a terminal Run,
 * a request with no terminal state), so a restart, a recovered link and a
 * normal finish all find the same work. A pass that recorded something runs
 * again at once; one that recorded nothing backs off; none owed disarms.
 */
export async function teamPublicationPass(
  owed: () => Promise<readonly PersonalTeamRequest[]>,
  reconcile: (request: PersonalTeamRequest) => Promise<void>,
  report: (error: unknown) => void,
): Promise<Date | null | typeof retryWithBackoff> {
  const before = await owed();
  if (before.length === 0) return null;
  for (const request of before) {
    try {
      await reconcile(request);
    } catch (error) {
      report(error);
    }
  }
  const after = await owed();
  if (after.length === 0) return null;
  const still = new Set(after.map(({ teamId, requestId }) => `${teamId}:${requestId}`));
  const recorded = before.filter(({ teamId, requestId }) => !still.has(`${teamId}:${requestId}`));
  return recorded.length > 0 ? new Date(0) : retryWithBackoff;
}
