/**
 * Maximum pending (not yet started) Occurrences per Trigger.
 *
 * Cron ticks collapse to at most one pending Occurrence, so this bound is in
 * practice a webhook backlog bound for an offline Runner. Ingress over the cap
 * is refused (HTTP 429 with Retry-After for webhooks) so the sender's retry
 * policy becomes the overflow buffer instead of an unbounded durable queue.
 */
export const MAX_PENDING_TRIGGER_OCCURRENCES = 100;

/** Running this long proves a watch revision recovered from its prior failures. */
export const WATCH_HEALTHY_WINDOW_MS = 10 * 60 * 1_000;

/** Unexpected exits of one watch revision before the Host tells the task. */
export const WATCH_CRASH_NOTICE_THRESHOLD = 3;

/** Capability renewal cadence; signed capabilities retain the existing 24-hour ceiling. */
export const WATCH_CAPABILITY_RENEWAL_MS = 6 * 60 * 60 * 1_000;

/** Retry cadence while a desired watch waits for its Runner or Agent home to become available. */
export const WATCH_START_RETRY_MS = 30_000;

/** Maximum retained output for each watch process stream. */
export const WATCH_LOG_TAIL_BYTES = 16 * 1_024;
