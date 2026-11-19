import type { AssignmentId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { retryWithBackoff } from "./deadline-drain.js";

/**
 * One pass of the delegation return outbox. A clean full batch runs again at
 * once; a failed or waiting return retries with backoff (which also covers
 * the rest of a full batch, so a batch of failures cannot spin); only an
 * exhausted, clean pass leaves nothing armed.
 */
export async function assignmentReturnPass(
  drain: OpensteerStore["drainPendingAssignmentReturns"],
  report: (assignmentId: AssignmentId, error: unknown) => void,
): Promise<Date | null | typeof retryWithBackoff> {
  const returns = await drain();
  for (const { assignmentId, error } of returns.failures) report(assignmentId, error);
  if (returns.failures.length > 0 || returns.waiting > 0) return retryWithBackoff;
  return returns.more ? new Date(0) : null;
}
