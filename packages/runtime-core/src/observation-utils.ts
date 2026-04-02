import type {
  ObservationContext,
  ObservationEventError,
  ObservabilityConfig,
  ObservabilityTraceContext,
} from "@opensteer/protocol";

import type { JsonValue } from "./json.js";
import { toCanonicalJsonValue } from "./json.js";

const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_PATTERN =
  /(authorization|proxy[_-]?authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret|password|passwd|private[_-]?key|database[_-]?url|db[_-]?url|session(?:id)?|csrf(?:token)?)/i;

const SENSITIVE_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
];

interface RedactionState {
  readonly sensitiveKeys: ReadonlySet<string>;
  readonly sensitiveValues: readonly string[];
}

export interface ObservationRedactor {
  redactText(value: string): string;
  redactJson(value: JsonValue | undefined): JsonValue | undefined;
  redactError(error: ObservationEventError | undefined): ObservationEventError | undefined;
  redactLabels(
    labels: Readonly<Record<string, string>> | undefined,
  ): Record<string, string> | undefined;
  redactTraceContext(
    traceContext: ObservabilityTraceContext | undefined,
  ): ObservabilityTraceContext | undefined;
}

export function normalizeObservationContext(
  context: ObservationContext | undefined,
): ObservationContext | undefined {
  if (context === undefined) {
    return undefined;
  }

  const normalized = {
    ...(context.sessionRef === undefined ? {} : { sessionRef: context.sessionRef }),
    ...(context.pageRef === undefined ? {} : { pageRef: context.pageRef }),
    ...(context.frameRef === undefined ? {} : { frameRef: context.frameRef }),
    ...(context.documentRef === undefined ? {} : { documentRef: context.documentRef }),
    ...(context.documentEpoch === undefined ? {} : { documentEpoch: context.documentEpoch }),
  } satisfies ObservationContext;

  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

export function createObservationRedactor(
  config: Partial<ObservabilityConfig> | undefined,
): ObservationRedactor {
  const state = createRedactionState(config);

  return {
    redactText(value) {
      return redactString(value, state);
    },
    redactJson(value) {
      return value === undefined
        ? undefined
        : (redactUnknown(value, state, new WeakSet()) as JsonValue);
    },
    redactError(error) {
      if (error === undefined) {
        return undefined;
      }
      return {
        ...(error.code === undefined ? {} : { code: redactString(error.code, state) }),
        message: redactString(error.message, state),
        ...(error.retriable === undefined ? {} : { retriable: error.retriable }),
        ...(error.details === undefined
          ? {}
          : { details: toCanonicalJsonValue(redactUnknown(error.details, state, new WeakSet())) }),
      };
    },
    redactLabels(labels) {
      if (labels === undefined) {
        return undefined;
      }

      const next = Object.entries(labels).reduce<Record<string, string>>(
        (accumulator, [key, value]) => {
          accumulator[key] = isSensitiveKey(key, state) ? REDACTED : redactString(value, state);
          return accumulator;
        },
        {},
      );

      return Object.keys(next).length === 0 ? undefined : next;
    },
    redactTraceContext(traceContext) {
      if (traceContext === undefined) {
        return undefined;
      }

      const next = {
        ...(traceContext.traceparent === undefined
          ? {}
          : { traceparent: redactString(traceContext.traceparent, state) }),
        ...(traceContext.baggage === undefined
          ? {}
          : { baggage: redactString(traceContext.baggage, state) }),
      };
      return Object.keys(next).length === 0 ? undefined : next;
    },
  };
}

function createRedactionState(config: Partial<ObservabilityConfig> | undefined): RedactionState {
  return {
    sensitiveKeys: new Set(
      (config?.redaction?.sensitiveKeys ?? [])
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value.length > 0),
    ),
    sensitiveValues: [
      ...new Set(
        (config?.redaction?.sensitiveValues ?? [])
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      ),
    ],
  };
}

function redactUnknown(value: unknown, state: RedactionState, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return redactString(value, state);
  }

  if (typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return REDACTED;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry, state, seen));
  }

  const next: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    next[key] = isSensitiveKey(key, state) ? REDACTED : redactUnknown(nestedValue, state, seen);
  }
  return next;
}

function redactString(value: string, state: RedactionState): string {
  let next = value;

  for (const secret of state.sensitiveValues) {
    next = next.split(secret).join(REDACTED);
  }

  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    next = next.replace(pattern, REDACTED);
  }

  return redactUrlString(next, state);
}

function redactUrlString(value: string, state: RedactionState): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }

  let changed = false;
  if (parsed.username) {
    parsed.username = REDACTED;
    changed = true;
  }
  if (parsed.password) {
    parsed.password = REDACTED;
    changed = true;
  }

  for (const [key] of parsed.searchParams) {
    if (!isSensitiveKey(key, state)) {
      continue;
    }
    parsed.searchParams.set(key, REDACTED);
    changed = true;
  }

  return changed ? parsed.toString() : value;
}

function isSensitiveKey(key: string, state: RedactionState): boolean {
  return state.sensitiveKeys.has(key.trim().toLowerCase()) || SENSITIVE_KEY_PATTERN.test(key);
}
