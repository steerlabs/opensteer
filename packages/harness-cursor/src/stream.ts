import { OpensteerError, type ToolIdentity } from "@opensteer/core";
import { opensteerToolIdentity } from "@opensteer/harness";
import {
  cursorAgentToolsServerName,
  cursorIntegrationToolsServerName,
  cursorMcpServerIdentifier,
} from "./plugin.js";

/**
 * One `--output-format stream-json` frame. Cursor's own shape is unversioned
 * and grows tool kinds without notice, so nothing here is schema-validated
 * beyond "it is a JSON object": an unknown frame or an unknown tool kind is
 * projected on what it does carry rather than failing the Run.
 */
export type CursorFrame = Readonly<Record<string, unknown>>;

/**
 * Splits the CLI's stdout into whole JSON lines. A line longer than the
 * configured bound is a Run whose events cannot be delivered intact, so it
 * fails rather than being truncated into a frame that parses but lies.
 */
export class CursorStreamReader {
  readonly #maximumLineBytes: number;
  #buffer = "";

  constructor(maximumLineBytes: number) {
    this.#maximumLineBytes = maximumLineBytes;
  }

  *push(chunk: string): Iterable<CursorFrame> {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(this.#buffer, "utf8") > this.#maximumLineBytes) {
          this.#buffer = "";
          throw this.#overflow();
        }
        return;
      }
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) continue;
      if (Buffer.byteLength(line, "utf8") > this.#maximumLineBytes) throw this.#overflow();
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        throw new OpensteerError({
          code: "harness_error",
          message: "Cursor emitted a stream-json line that is not JSON",
        });
      }
      if (typeof frame !== "object" || frame === null || Array.isArray(frame)) continue;
      yield frame as CursorFrame;
    }
  }

  #overflow(): OpensteerError {
    return new OpensteerError({
      code: "harness_error",
      message: `Cursor emitted a stream-json line longer than ${this.#maximumLineBytes} bytes`,
    });
  }
}

/**
 * Whether an `assistant` frame is an incremental piece or the finished
 * message. Verified 2026-09-17: with `--stream-partial-output` every piece
 * carries `timestamp_ms` and no `model_call_id`, and the finished text arrives
 * either with `model_call_id` or with neither field.
 */
export function isCursorAssistantDelta(frame: CursorFrame): boolean {
  return frame.timestamp_ms !== undefined && frame.model_call_id === undefined;
}

export function cursorFrameText(frame: CursorFrame): string {
  const message = frame.message;
  if (typeof message !== "object" || message === null) return "";
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" &&
      part !== null &&
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("");
}

export interface CursorToolCall {
  readonly arguments: unknown;
  readonly identity: ToolIdentity;
  readonly isError: boolean;
  readonly output: unknown;
}

/** What Cursor calls its own tools, and what Opensteer calls them. */
const cursorToolNames: Readonly<Record<string, string>> = {
  editToolCall: "edit",
  getMcpToolsToolCall: "get_mcp_tools",
  globToolCall: "glob",
  grepToolCall: "grep",
  lsToolCall: "ls",
  readToolCall: "read",
  shellToolCall: "shell",
  webSearchToolCall: "web_search",
  writeToolCall: "write",
};

/**
 * Reads one `tool_call` frame. The payload is a oneof keyed by tool kind, so
 * the first key is the kind; a kind this build has never seen keeps its own
 * name rather than being dropped, because a Run that ran a tool must show it.
 */
export function readCursorToolCall(frame: CursorFrame): CursorToolCall | undefined {
  const payload = frame.tool_call;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const entries = Object.entries(payload as Record<string, unknown>);
  const entry = entries.find(
    ([key, value]) => key.endsWith("ToolCall") && typeof value === "object" && value !== null,
  );
  if (!entry) return undefined;
  const [kind, rawCall] = entry;
  const call = rawCall as Record<string, unknown>;
  const args =
    typeof call.args === "object" && call.args !== null
      ? (call.args as Record<string, unknown>)
      : {};
  const result = call.result;
  const mcp = kind === "mcpToolCall";
  return {
    // An MCP call's args wrap the tool's own arguments with the server and
    // tool it addresses; the identity carries those, and the arguments are
    // the tool's, as every other engine reports them.
    arguments: mcp ? mcpToolArguments(args) : args,
    identity: mcp
      ? cursorMcpToolIdentity(args)
      : { name: cursorToolNames[kind] ?? kind.replace(/ToolCall$/u, ""), namespace: "cursor" },
    isError: cursorToolFailed(result),
    output: result ?? "",
  };
}

function mcpToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  return typeof args.args === "object" && args.args !== null && !Array.isArray(args.args)
    ? (args.args as Record<string, unknown>)
    : {};
}

/**
 * Opensteer's own two servers are reported under their Opensteer names; every
 * other server keeps Cursor's namespaced spelling, which is what the model saw.
 */
function cursorMcpToolIdentity(args: Record<string, unknown>): ToolIdentity {
  const provider = typeof args.providerIdentifier === "string" ? args.providerIdentifier : "";
  const toolName = typeof args.toolName === "string" ? args.toolName : "unknown";
  if (provider === cursorMcpServerIdentifier(cursorAgentToolsServerName)) {
    return opensteerToolIdentity(cursorAgentToolsServerName, toolName);
  }
  if (provider === cursorMcpServerIdentifier(cursorIntegrationToolsServerName)) {
    return opensteerToolIdentity(cursorIntegrationToolsServerName, toolName);
  }
  return opensteerToolIdentity(provider || "mcp", toolName);
}

/**
 * A completed tool result is a oneof too: `success` for a tool that ran, and
 * `error`, `rejected` or `permissionDenied` for the three ways a hook or the
 * classifier can stop one (all four observed live).
 */
function cursorToolFailed(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const keys = Object.keys(result as Record<string, unknown>);
  if (keys.length === 0) return false;
  return !keys.includes("success");
}

export interface CursorUsage {
  readonly cacheReadTokens: number | undefined;
  readonly cacheWriteTokens: number | undefined;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * The `result` frame's usage. Cursor states no cost and no reasoning tokens on
 * this surface, so neither is reported: `run.usage` carries what the engine
 * said and nothing Opensteer worked out.
 */
export function readCursorUsage(frame: CursorFrame): CursorUsage | undefined {
  const usage = frame.usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const values = usage as Record<string, unknown>;
  const inputTokens = tokenCount(values.inputTokens);
  const outputTokens = tokenCount(values.outputTokens);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  return {
    cacheReadTokens: tokenCount(values.cacheReadTokens),
    cacheWriteTokens: tokenCount(values.cacheWriteTokens),
    inputTokens,
    outputTokens,
  };
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
