import { OpensteerError } from "@opensteer/core";

export type JsonRpcId = number | string;
export type JsonObject = Record<string, unknown>;

export interface CodexMethodMessage extends JsonObject {
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexResponseMessage extends JsonObject {
  readonly error?: unknown;
  readonly id: JsonRpcId;
  readonly result?: unknown;
}

export type CodexInboundMessage = CodexMethodMessage | CodexResponseMessage;

export function parseCodexMessage(line: Buffer): CodexInboundMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.toString("utf8"));
  } catch (error) {
    throw protocolError("Codex app-server emitted invalid JSON", { cause: error });
  }
  const object = requireObject(parsed, "Codex app-server message");
  if (typeof object.method === "string") {
    if ("id" in object && !isJsonRpcId(object.id)) {
      throw protocolError("Codex app-server request used an invalid id");
    }
    return object as CodexMethodMessage;
  }
  if (isJsonRpcId(object.id) && ("result" in object || "error" in object)) {
    return object as CodexResponseMessage;
  }
  throw protocolError("Codex app-server emitted an unrecognized JSON-RPC message");
}

export function isMethodMessage(message: CodexInboundMessage): message is CodexMethodMessage {
  return typeof (message as JsonObject).method === "string";
}

export function isResponseMessage(message: CodexInboundMessage): message is CodexResponseMessage {
  return !isMethodMessage(message);
}

export function requireObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw protocolError(`${label} must be an object`);
  }
  return value as JsonObject;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw protocolError(`${label} must be a non-empty string`);
  }
  return value;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function requestKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

export function protocolError(
  message: string,
  options: { readonly cause?: unknown; readonly details?: Readonly<Record<string, unknown>> } = {},
): OpensteerError {
  return new OpensteerError({
    ...(options.cause === undefined ? {} : { cause: options.cause }),
    code: "harness_error",
    ...(options.details === undefined ? {} : { details: options.details }),
    message,
  });
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}
