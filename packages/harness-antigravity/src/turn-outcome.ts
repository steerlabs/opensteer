import {
  OpensteerError,
  harnessSessionBrokenFailureCode,
  harnessUsageLimitFailureCode,
} from "@opensteer/core";
import type {
  AcpPromptOutcomeCheck,
  AcpPromptOutcomeFailure,
  AcpPromptResult,
} from "@opensteer/harness-acp";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { authenticationRequired } from "./output.js";
import { antigravityManagedPath, antigravityProfileRoot } from "./profile-paths.js";

// CORTEX_STEP_TYPE_ERROR_MESSAGE in the native trajectory.
const errorStepType = 17;
// The harness error text leads the payload; a Go stack trace follows it.
const maxErrorPayloadBytes = 16_384;
// The Go harness's rendering of a Google API error.
const apiErrorPattern = /Error (\d{3}), Message: (.+?), Status: ([A-Z_]+)/su;
// Antigravity 1.5 with a Google account writes "STATUS (code NNN): message".
const statusErrorPattern = /(?<![A-Z_])([A-Z_]+) \(code (\d{3})\): (\P{Cc}+)/u;
const quotaExhaustedPattern = /\breason:QUOTA_EXHAUSTED\b/u;
// Claude rejects a saved thinking block without a valid signature. It sits in
// the native history, so every later prompt to that session fails the same way.
export const invalidThinkingSignaturePattern =
  /\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)/u;
const nativeSessionIdPattern = /^[\w-]+$/u;
const conversationSegments = ["antigravity-acp", "conversations"] as const;

export const brokenAntigravitySessionMessage =
  "Antigravity's saved conversation can no longer be sent to the model. The next message starts a fresh Antigravity session with this thread's context.";

interface LastStep {
  readonly payload: Uint8Array | null;
  readonly type: number;
}

export function sanitizeAntigravityFailureMessage(message: string): string {
  // Keep the full payload (already bounded by maxErrorPayloadBytes) until
  // AcpHarnessSession applies named-secret redaction and final truncation, so
  // a secret spanning the 2,000-character cut cannot survive half-sliced.
  return message
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/gu, "[REDACTED]")
    .replace(
      /\b(api[ _-]?key|authorization|credential|password|secret|token)\s*[:=]\s*[^,\s]+/giu,
      "$1=[REDACTED]",
    )
    .replace(/[\r\n\0]+/gu, " ")
    .trim();
}

export function brokenAntigravitySessionError(): OpensteerError {
  return new OpensteerError({
    code: harnessSessionBrokenFailureCode,
    message: brokenAntigravitySessionMessage,
    retryable: true,
  });
}

function readSteps<T>(file: string, read: (database: DatabaseSync) => T): T | undefined {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(file, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 100");
    const hasSteps =
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'")
        .get() !== undefined;
    return hasSteps ? read(database) : undefined;
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
}

function lastStepIndex(database: DatabaseSync): number {
  const row = database.prepare("SELECT max(idx) AS idx FROM steps").get() as
    { readonly idx?: unknown } | undefined;
  return typeof row?.idx === "number" ? row.idx : -1;
}

function lastStepAfter(index: number) {
  return (database: DatabaseSync): LastStep | undefined => {
    const row = database
      .prepare(
        `SELECT step_type AS type, substr(step_payload, 1, ?) AS payload
         FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1`,
      )
      .get(maxErrorPayloadBytes, index) as
      { readonly payload?: unknown; readonly type?: unknown } | undefined;
    if (typeof row?.type !== "number") return undefined;
    return {
      payload: row.payload instanceof Uint8Array ? row.payload : null,
      type: row.type,
    };
  };
}

function matchStatusError(text: string): readonly [string, string, string, string] | null {
  const match = statusErrorPattern.exec(text);
  return match === null ? null : ([match[0], match[2]!, match[3]!, match[1]!] as const);
}

function classifyTurnStep(
  result: AcpPromptResult,
  step: LastStep | undefined,
  assistantText: string,
): AcpPromptOutcomeFailure | undefined {
  const errorText =
    step?.type === errorStepType
      ? new TextDecoder().decode(step.payload ?? new Uint8Array())
      : undefined;
  if (errorText === undefined && result.stopReason !== "refusal") return undefined;
  const text = errorText ?? "";
  const apiError = apiErrorPattern.exec(text) ?? matchStatusError(text);
  const rawMessage = apiError?.[2]?.trim();
  const echoesAssistant =
    assistantText.trim().length > 0 &&
    (rawMessage === assistantText.trim() ||
      (errorText !== undefined && errorText.includes(assistantText.trim())));

  // Always check permanent session corruption first so a poisoned session rotates
  // even if the stop reason or another marker accompanies it.
  if (invalidThinkingSignaturePattern.test(text)) {
    return {
      discardAssistant: echoesAssistant,
      error: brokenAntigravitySessionError(),
    };
  }
  if (quotaExhaustedPattern.test(text)) {
    const detail = rawMessage ? `: ${sanitizeAntigravityFailureMessage(rawMessage)}` : "";
    return {
      discardAssistant: echoesAssistant,
      error: new OpensteerError({
        code: harnessUsageLimitFailureCode,
        message: `Antigravity usage limit reached${detail}`,
        retryable: true,
      }),
    };
  }
  if (apiError === null) {
    return {
      discardAssistant: echoesAssistant,
      error: new OpensteerError({
        code: "harness_error",
        message:
          result.stopReason === "refusal"
            ? "Antigravity refused to complete this turn"
            : "Antigravity stopped this turn because of an error",
      }),
    };
  }
  const [, httpStatusText, message, status] = apiError;
  const httpStatus = Number(httpStatusText);
  if (httpStatus === 402 || httpStatus === 429 || status === "RESOURCE_EXHAUSTED") {
    const detail = message ? `: ${sanitizeAntigravityFailureMessage(message)}` : "";
    return {
      discardAssistant: echoesAssistant,
      error: new OpensteerError({
        code: harnessUsageLimitFailureCode,
        message: `Antigravity usage limit reached${detail}`,
        retryable: httpStatus === 429 || status === "RESOURCE_EXHAUSTED",
      }),
    };
  }
  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    status === "UNAUTHENTICATED" ||
    status === "PERMISSION_DENIED"
  ) {
    return {
      discardAssistant: echoesAssistant,
      error: authenticationRequired(),
    };
  }
  return {
    discardAssistant: echoesAssistant,
    error: new OpensteerError({
      code: "harness_error",
      message: message
        ? sanitizeAntigravityFailureMessage(message)
        : "Antigravity could not continue",
      retryable: httpStatus >= 500,
    }),
  };
}

/**
 * Antigravity reports upstream API failures (including missing Claude thinking
 * signatures and quota exhaustion) as a chat message and `end_turn`. Its native
 * session SQLite database ends that turn with an error step, so this observer
 * snapshots `max(idx)` before a prompt and reads only steps added by that
 * prompt, read-only, from this session's own unlinked database.
 */
export async function watchAntigravityPromptOutcome(
  profileDirectory: string | undefined,
  sessionId: string,
): Promise<AcpPromptOutcomeCheck> {
  const typedOnly: AcpPromptOutcomeCheck = (result, { assistantText }) =>
    classifyTurnStep(result, undefined, assistantText);
  if (!profileDirectory || !nativeSessionIdPattern.test(sessionId)) return typedOnly;

  const segments = [...conversationSegments, `${sessionId}.db`];
  const root = await antigravityProfileRoot(profileDirectory);
  if (!root) return typedOnly;
  if (!(await antigravityManagedPath(root, conversationSegments, "directory"))) return typedOnly;

  const existing = await antigravityManagedPath(root, segments, "file");
  let startIndex: number;
  if (!existing) {
    const occupied = await lstat(join(root, ...segments)).then(
      () => true,
      () => false,
    );
    if (occupied) return typedOnly;
    startIndex = -1;
  } else {
    const snapshot = readSteps(existing.path, lastStepIndex);
    if (snapshot === undefined) return typedOnly;
    startIndex = snapshot;
  }

  return async (result, { assistantText }) => {
    const after = await antigravityManagedPath(root, segments, "file");
    const sameFile =
      after !== undefined &&
      (existing === undefined ||
        (after.info.dev === existing.info.dev && after.info.ino === existing.info.ino));
    const step = sameFile ? readSteps(after.path, lastStepAfter(startIndex)) : undefined;
    return classifyTurnStep(result, step, assistantText);
  };
}
