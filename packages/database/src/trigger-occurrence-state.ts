export type TriggerOccurrenceState =
  "pending" | "running" | "succeeded" | "failed" | "canceled" | "unknown";

export type LegacyTriggerOccurrenceStatus =
  "pending" | "running" | "succeeded" | "failed" | "canceled";

/**
 * Single writer for `trigger_occurrences.{status, outcome}` (Z3 / Y8).
 * Keeps the legacy 5-value `status` column and the 6-value `outcome` column
 * permanently in lockstep so readers never observe stale `outcome` values.
 */
export function triggerOccurrenceStateColumns(state: TriggerOccurrenceState): {
  readonly outcome: TriggerOccurrenceState;
  readonly status: LegacyTriggerOccurrenceStatus;
} {
  return {
    outcome: state,
    status: state === "unknown" ? "failed" : state,
  };
}
