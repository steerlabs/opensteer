import type { AssignmentId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { retryWithBackoff, type BackoffNoLaterThan } from "./deadline-drain.js";

/**
 * One pass of the delegation return outbox. Armed exactly while a pending
 * return remains:
 * - a full batch that delivered something runs again at once;
 * - a failure, a full parent inbox, or a full batch that delivered nothing
 *   backs off, but never past the end of a hold the pass already knows;
 * - a return a live synchronous reader holds is looked at again when that
 *   hold ends (read in the transaction that decided it, so a hold that has
 *   ended since reads as due, never as nothing);
 * - only a short batch that left nothing pending disarms.
 */
export async function assignmentReturnPass(
  drain: OpensteerStore["drainPendingAssignmentReturns"],
  report: (assignmentId: AssignmentId, error: unknown) => void,
): Promise<Date | null | typeof retryWithBackoff | BackoffNoLaterThan> {
  const returns = await drain();
  for (const { assignmentId, error } of returns.failures) report(assignmentId, error);
  if (returns.more && returns.settled > 0) return new Date(0);
  if (returns.failures.length > 0 || returns.waiting > 0 || returns.more)
    return returns.heldUntil ? { backoffNoLaterThan: returns.heldUntil } : retryWithBackoff;
  return returns.heldUntil;
}
