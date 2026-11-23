export type TriggerOccurrenceState =
  "pending" | "running" | "succeeded" | "failed" | "canceled" | "unknown";

/**
 * Single writer for `trigger_occurrences.status` (Z3 / AA3).
 * Every production write to `trigger_occurrences.status` goes through this helper
 * and is enforced by `trigger-occurrence-state-writers.test.ts`.
 */
export function triggerOccurrenceStateColumns(state: TriggerOccurrenceState): {
  readonly status: TriggerOccurrenceState;
} {
  return { status: state };
}
