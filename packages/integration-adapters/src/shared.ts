// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/openapi/src/sdk/invoke.ts (MIT).
import type { AdapterToolResult } from "@opensteer/integration-core/adapter";
import { isRecord } from "@opensteer/shared/isRecord";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 1_048_576;

/** The shared record predicate, in the narrowing form these adapters chain on. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function valueAtPath(value: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let cursor = value;
  for (const segment of path.split(".")) {
    const record = asRecord(cursor);
    if (!record) return undefined;
    cursor = record[segment];
  }
  return cursor;
}

export function stringAtPath(value: unknown, path: string | undefined): string | undefined {
  const found = valueAtPath(value, path);
  if (typeof found === "string" && found.trim()) return found;
  if (typeof found === "number" || typeof found === "bigint") return String(found);
  return undefined;
}

export function errorResult(
  code: Extract<AdapterToolResult, { kind: "error" }>["code"],
  message: string,
  details?: Readonly<Record<string, unknown>>,
): AdapterToolResult {
  return { kind: "error", code, message, ...(details ? { details } : {}) };
}

export function timeoutResult(message: string): AdapterToolResult {
  return errorResult("upstream_timeout", message);
}

export function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError");
}

export function decodeResponseBody(response: Response, bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return null;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const isJson =
    contentType === "application/json" ||
    contentType?.endsWith("+json") === true ||
    contentType?.includes("json") === true;
  const isText =
    isJson ||
    contentType?.startsWith("text/") === true ||
    contentType?.includes("xml") === true ||
    contentType === "application/x-www-form-urlencoded";
  if (!isText) {
    return {
      contentType: contentType ?? "application/octet-stream",
      dataBase64: Buffer.from(bytes).toString("base64"),
      size: bytes.byteLength,
    };
  }
  const text = new TextDecoder().decode(bytes);
  if (!isJson) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
