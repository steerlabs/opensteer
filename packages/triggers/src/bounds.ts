/** Maximum UTF-8 byte length of an automation script's text. */
export const MAX_SCRIPT_BYTES = 256 * 1_024;

/** Maximum UTF-8 byte length kept for each firing output stream (stdout and stderr). */
export const MAX_OUTPUT_TAIL_BYTES = 64 * 1_024;

/** Most recent completed firings per automation whose output and raw webhook body are kept. */
export const RETAINED_OUTPUT_OCCURRENCES = 100;

/** Maximum raw webhook request body size accepted on /hooks/v1/:routeKey. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1_024;

/** Maximum waiting webhook firings per automation before returning HTTP 429. */
export const MAX_PENDING_WEBHOOK_FIRINGS = 100;

/** Maximum sealed environment-variable secrets stored on a single automation. */
export const MAX_AUTOMATION_SECRETS = 64;

/** Maximum UTF-8 byte length of a single sealed automation secret value. */
export const MAX_AUTOMATION_SECRET_VALUE_BYTES = 64 * 1_024;

/** Maximum combined UTF-8 byte length of all sealed secrets on a single automation. */
export const MAX_AUTOMATION_SECRETS_TOTAL_BYTES = 64 * 1_024;
