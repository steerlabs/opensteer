import type { Run, ThreadStatus } from "./models.js";

/**
 * A Thread's status from the facts that decide it. The Host projects it into
 * the database. Clients use this only for optimistic feedback: their Run facts
 * can be incomplete, so snapshots and Host status events remain authoritative.
 *
 * Its earliest active Run decides:
 * waiting is `waiting`, anything else is `running`, except that a queued Run
 * behind a paused queue is not activity. With nothing active, the Thread has
 * `failed` only while its latest Run is a failure.
 */
export function deriveThreadStatus(facts: {
  readonly earliestActiveRunStatus: Run["status"] | null;
  readonly inputQueuePaused: boolean;
  readonly lastRunFailed: boolean;
}): ThreadStatus {
  const active = facts.earliestActiveRunStatus;
  if (active !== null && !(facts.inputQueuePaused && active === "queued")) {
    return active === "waiting" ? "waiting" : "running";
  }
  return facts.lastRunFailed ? "failed" : "idle";
}
