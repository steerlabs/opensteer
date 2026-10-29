import { OpensteerError } from "@opensteer/core";

export type JsonObject = Record<string, unknown>;

/**
 * One line of Pi's RPC stream. Pi answers a command with `{"type":"response",
 * "command":…,"success":…}` echoing the `id` the command carried, and pushes
 * everything else as an event with no id (pi-facts §2).
 */
export interface PiMessage extends JsonObject {
  readonly type: string;
}

export function parsePiMessage(line: Buffer): PiMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.toString("utf8"));
  } catch (error) {
    throw protocolError("Pi emitted invalid JSON", { cause: error });
  }
  const object = requireObject(parsed, "Pi message");
  if (typeof object.type !== "string" || object.type.length === 0) {
    throw protocolError("Pi emitted a message without a type");
  }
  return object as PiMessage;
}

export function isResponse(message: PiMessage): boolean {
  return message.type === "response";
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

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

/**
 * Pi's own RPC documentation (`packages/coding-agent/docs/rpc.md:28-38`) states
 * the framing is LF-only and warns that Node's `readline` is **not** protocol
 * compliant, because it also splits on U+2028 and U+2029 — both of which are
 * legal unescaped inside a JSON string and do occur in model output. This
 * splitter therefore looks for byte 0x0A and nothing else, and strips one
 * optional trailing CR (pi-facts §2).
 */
export class PiLineFramer {
  readonly #maxLineBytes: number;
  readonly #skippable: ((head: Buffer) => boolean) | undefined;
  #fragments: Buffer[] = [];
  #pendingBytes = 0;
  /** Discarding the rest of an over-long line the caller chose to skip. */
  #skipping = false;

  /**
   * `skippable` sees the first bytes of a line that outgrows `maxLineBytes`;
   * when it accepts them the line is dropped as it streams, never buffered.
   */
  constructor(maxLineBytes: number, skippable?: (head: Buffer) => boolean) {
    this.#maxLineBytes = maxLineBytes;
    this.#skippable = skippable;
  }

  push(chunk: Buffer): Buffer[] {
    const lines: Buffer[] = [];
    let start = 0;
    while (start < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline < 0) {
        this.#append(chunk.subarray(start));
        break;
      }
      this.#append(chunk.subarray(start, newline));
      const skipped = this.#skipping;
      const line = this.#takeLine();
      if (!skipped && line.byteLength > 0) lines.push(stripCarriageReturn(line));
      start = newline + 1;
    }
    return lines;
  }

  finish(): Buffer | undefined {
    const skipped = this.#skipping;
    if (this.#pendingBytes === 0 && !skipped) return undefined;
    const line = this.#takeLine();
    return skipped ? undefined : stripCarriageReturn(line);
  }

  #append(fragment: Buffer): void {
    if (fragment.byteLength === 0 || this.#skipping) return;
    this.#pendingBytes += fragment.byteLength;
    if (this.#pendingBytes > this.#maxLineBytes) {
      const leading: Buffer[] = [];
      let leadingBytes = 0;
      for (const part of [...this.#fragments, fragment]) {
        leading.push(part);
        leadingBytes += part.byteLength;
        if (leadingBytes >= 256) break;
      }
      if (!this.#skippable?.(Buffer.concat(leading).subarray(0, 256))) {
        throw protocolError(`Pi emitted a line longer than ${this.#maxLineBytes} bytes`);
      }
      this.#fragments = [];
      this.#pendingBytes = 0;
      this.#skipping = true;
      return;
    }
    this.#fragments.push(fragment);
  }

  #takeLine(): Buffer {
    this.#skipping = false;
    const line =
      this.#fragments.length === 1
        ? (this.#fragments[0] ?? Buffer.alloc(0))
        : Buffer.concat(this.#fragments, this.#pendingBytes);
    this.#fragments = [];
    this.#pendingBytes = 0;
    return line;
  }
}

function stripCarriageReturn(line: Buffer): Buffer {
  return line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
}
