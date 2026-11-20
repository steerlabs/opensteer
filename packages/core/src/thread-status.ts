import type { Run, ThreadStatus } from "./models.js";

/**
 * A Thread's status from the facts that decide it. The Host projects it into
 * the database. Clients use this only for optimistic feedback: their Run facts
 * can be incomplete, so snapshots and Host status events remain authoritative.
 *
 * Its earliest active Run decides:
 * waiting is `waiting`, anything else is `running`, except that a queued Run
 * behind a paused queue is not activity. With nothing active, the Thread has
 * `failed` only while its latest Run is a failure. A task an external agent works directly has no
 * Run: its active session is the activity, waiting while a Request of its is open.
 */
export function deriveThreadStatus(facts: {
  readonly earliestActiveRunStatus: Run["status"] | null;
  readonly inputQueuePaused: boolean;
  readonly lastRunFailed: boolean;
  /** An external agent's session on this task: working, or waiting on the person's answer. */
  readonly agentSession?: "active" | "waiting" | null;
}): ThreadStatus {
  if (facts.agentSession) return facts.agentSession === "waiting" ? "waiting" : "running";
  const active = facts.earliestActiveRunStatus;
  if (active !== null && !(facts.inputQueuePaused && active === "queued")) {
    return active === "waiting" ? "waiting" : "running";
  }
  return facts.lastRunFailed ? "failed" : "idle";
}
