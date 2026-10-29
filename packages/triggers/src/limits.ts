/**
 * Maximum pending (not yet started) Occurrences per Trigger.
 *
 * Cron ticks collapse to at most one pending Occurrence, so this bound is in
 * practice a webhook backlog bound for an offline Runner. Ingress over the cap
 * is refused (HTTP 429 with Retry-After for webhooks) so the sender's retry
 * policy becomes the overflow buffer instead of an unbounded durable queue.
 */
export const MAX_PENDING_TRIGGER_OCCURRENCES = 100;

/** Consecutive current-Revision failures before an active Trigger is paused. */
export const TRIGGER_AUTO_PAUSE_FAILURE_THRESHOLD = 3;

/** Visible reason recorded when repeated program failures pause a Trigger. */
export const TRIGGER_AUTO_PAUSE_REASON = `Paused after ${TRIGGER_AUTO_PAUSE_FAILURE_THRESHOLD} failed runs in a row.`;

/** Concurrent continuously running Trigger programs admitted per execution environment. */
export const MAX_ACTIVE_WATCHES_PER_ENVIRONMENT = 32;

/** Running this long proves a watch revision recovered from its prior failures. */
export const WATCH_HEALTHY_WINDOW_MS = 10 * 60 * 1_000;

/** Unexpected exits of one watch revision before the Host pauses it. */
export const WATCH_AUTO_PAUSE_FAILURE_THRESHOLD = 3;

/** Visible reason recorded when repeated watch exits pause a Trigger. */
export const WATCH_AUTO_PAUSE_REASON = `Paused after stopping unexpectedly ${WATCH_AUTO_PAUSE_FAILURE_THRESHOLD} times in a row.`;

/** Independent watch observations admitted in a rolling hour. */
export const WATCH_OBSERVATIONS_PER_HOUR = 120;

/** Capability renewal cadence; signed capabilities retain the existing 24-hour ceiling. */
export const WATCH_CAPABILITY_RENEWAL_MS = 6 * 60 * 60 * 1_000;

/** Retry cadence while durable watch intent waits for its Workspace to become ready. */
export const WATCH_START_RETRY_MS = 30_000;

/** Maximum retained output for each watch process stream. */
export const WATCH_LOG_TAIL_BYTES = 16 * 1_024;
