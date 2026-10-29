import { z } from "zod";

export const toolOutputTextMaxBytes = 50 * 1_024;

const truncationMarkerReserveBytes = 128;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const toolOutputTruncationShape = {
  omittedBytes: z.number().int().positive(),
  originalBytes: z.number().int().positive(),
} as const;
const validToolOutputTruncation = ({
  omittedBytes,
  originalBytes,
}: {
  readonly omittedBytes: number;
  readonly originalBytes: number;
}) => omittedBytes < originalBytes;
export const ToolOutputTruncationSchema = z
  .strictObject(toolOutputTruncationShape)
  .refine(
    validToolOutputTruncation,
    "Tool output omitted bytes must be smaller than the original output",
  );
const ToolOutputTruncationViewSchema = z
  .object(toolOutputTruncationShape)
  .refine(
    validToolOutputTruncation,
    "Tool output omitted bytes must be smaller than the original output",
  );

const toolOutputShape = {
  text: z
    .string()
    .max(toolOutputTextMaxBytes)
    .refine(
      (value) => utf8ByteLength(value) <= toolOutputTextMaxBytes,
      `Tool output text must not exceed ${toolOutputTextMaxBytes} UTF-8 bytes`,
    ),
  truncation: ToolOutputTruncationSchema.optional(),
} as const;
export const ToolOutputSchema = z.strictObject(toolOutputShape);
export const ToolOutputViewSchema = z.object({
  ...toolOutputShape,
  truncation: ToolOutputTruncationViewSchema.optional(),
});
export type ToolOutput = z.infer<typeof ToolOutputSchema>;

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/**
 * Build the one durable, provider-neutral representation of tool output.
 * Small text remains byte-for-byte identical apart from U+0000, which becomes
 * U+FFFD. Oversized text keeps equal head and tail windows with an explicit
 * omission marker between them.
 */
export function createToolOutput(text: string): ToolOutput {
  // JSON and PostgreSQL `jsonb` cannot carry U+0000, so the durable form never
  // does. Every driver builds tool output here, which makes this the one place
  // to do it; replacing before measuring keeps the byte budget honest, since
  // U+FFFD is three bytes where NUL was one.
  const sanitized = text.replaceAll("\u0000", "\uFFFD");
  const bytes = encoder.encode(sanitized);
  if (bytes.byteLength <= toolOutputTextMaxBytes) return { text: sanitized };

  const { omittedBytes, text: boundedText } = utf8HeadAndTail(
    bytes,
    toolOutputTextMaxBytes - truncationMarkerReserveBytes,
  );
  if (utf8ByteLength(boundedText) > toolOutputTextMaxBytes) {
    throw new Error("Tool output truncation exceeded its canonical byte limit");
  }

  return {
    text: boundedText,
    truncation: { omittedBytes, originalBytes: bytes.byteLength },
  };
}

/**
 * UTF-8 text cut to equal head and tail windows of at most `keptBytes`
 * together, never inside a character, around a marker that says how much of
 * the middle was omitted. The marker is in addition to the kept bytes.
 */
export function utf8HeadAndTail(
  bytes: Uint8Array,
  keptBytes: number,
): { readonly omittedBytes: number; readonly text: string } {
  const headBudget = Math.floor(keptBytes / 2);
  const headEnd = utf8PrefixBoundary(bytes, headBudget);
  const tailStart = utf8SuffixBoundary(bytes, bytes.byteLength - (keptBytes - headBudget));
  const omittedBytes = tailStart - headEnd;
  return {
    omittedBytes,
    text:
      decoder.decode(bytes.subarray(0, headEnd)) +
      `\n… ${omittedBytes} bytes omitted …\n` +
      decoder.decode(bytes.subarray(tailStart)),
  };
}

/**
 * Convert one adapter-selected semantic result into readable text. Provider
 * envelopes are selected before this shared function; text content blocks and
 * otherwise structured JSON remain provider-neutral here.
 */
export function toolOutputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";

  if (Array.isArray(value)) {
    const blockText = textBlocks(value);
    return blockText ?? serializeToolOutput(value);
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.content === "string") return record.content;
    if (Array.isArray(record.content)) {
      const blockText = textBlocks(record.content);
      if (blockText !== null) return blockText;
    }
  }

  return serializeToolOutput(value);
}

export function normalizeToolOutput(value: unknown): ToolOutput {
  return createToolOutput(toolOutputText(value));
}

/** Return the largest valid UTF-8 prefix no larger than maximumBytes. */
export function utf8Prefix(value: string, maximumBytes: number): string {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 0) {
    throw new TypeError("maximumBytes must be a non-negative integer");
  }
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maximumBytes) return value;
  return decoder.decode(bytes.subarray(0, utf8PrefixBoundary(bytes, maximumBytes)));
}

function textBlocks(values: readonly unknown[]): string | null {
  const text: string[] = [];
  for (const value of values) {
    if (!value || typeof value !== "object") continue;
    const candidate = (value as Record<string, unknown>).text;
    if (typeof candidate === "string") text.push(candidate);
  }
  return text.length > 0 ? text.join("\n") : null;
}

function serializeToolOutput(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new TypeError("Tool output must be JSON-compatible");
  }
  return serialized;
}

function utf8PrefixBoundary(bytes: Uint8Array, maximumBytes: number): number {
  let boundary = Math.min(maximumBytes, bytes.byteLength);
  while (boundary > 0 && boundary < bytes.byteLength && isContinuationByte(bytes[boundary]!)) {
    boundary -= 1;
  }
  return boundary;
}

function utf8SuffixBoundary(bytes: Uint8Array, minimumStart: number): number {
  let boundary = Math.max(0, minimumStart);
  while (boundary < bytes.byteLength && isContinuationByte(bytes[boundary]!)) boundary += 1;
  return boundary;
}

function isContinuationByte(value: number): boolean {
  return (value & 0b1100_0000) === 0b1000_0000;
}
