import { z } from "zod";
import { RunIdSchema, ThreadIdSchema, WorkspaceIdSchema } from "./ids.js";

/**
 * Live progress is what a turn is saying before it has said it: the text of an
 * answer, a reasoning block or a tool's output while it streams. It is never
 * durable. The durable event that completes each stream (`assistant.message`,
 * `reasoning.completed`, `tool.completed`) carries the whole text, so nothing a
 * transcript keeps depends on progress having arrived.
 *
 * Streams keep the newest `liveStreamTextMaxLength` UTF-16 units, the same tail
 * a transcript shows while a turn streams. `length` counts every unit a stream
 * has ever received, so an append names the offset it continues and a reader
 * that missed part of a stream can tell instead of drawing a gap.
 */
export const liveStreamTextMaxLength = 120_000;
export const liveAppendTextMaxLength = 64 * 1_024;
export const liveProgressMaxItems = 256;

const LiveStreamLengthSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const liveStreamKeys = {
  assistant: { stream: z.literal("assistant") },
  reasoning: { blockId: z.string().min(1).max(255), stream: z.literal("reasoning") },
  tool: { callId: z.string().min(1).max(255), stream: z.literal("tool") },
} as const;

function liveItemShapes<Key extends keyof typeof liveStreamKeys>(key: Key) {
  return {
    append: {
      ...liveStreamKeys[key],
      at: LiveStreamLengthSchema,
      op: z.literal("append"),
      text: z.string().min(1).max(liveAppendTextMaxLength),
    },
    replace: {
      ...liveStreamKeys[key],
      length: LiveStreamLengthSchema,
      op: z.literal("replace"),
      text: z.string().max(liveStreamTextMaxLength),
    },
  } as const;
}

const liveItemShape = {
  assistant: liveItemShapes("assistant"),
  reasoning: liveItemShapes("reasoning"),
  tool: liveItemShapes("tool"),
} as const;

function replaceFitsLength(
  item: { readonly op: "append" | "replace"; readonly text: string; readonly length?: number },
  context: z.RefinementCtx,
): void {
  if (item.op === "replace" && item.length !== undefined && item.text.length > item.length) {
    context.addIssue({
      code: "custom",
      message: "A live stream cannot hold more text than it has received",
      path: ["text"],
    });
  }
}

/** What a Runner sends and the Host forwards; strict on the Host's own wire. */
export const LiveItemSchema = z
  .union([
    z.strictObject(liveItemShape.assistant.append),
    z.strictObject(liveItemShape.assistant.replace),
    z.strictObject(liveItemShape.reasoning.append),
    z.strictObject(liveItemShape.reasoning.replace),
    z.strictObject(liveItemShape.tool.append),
    z.strictObject(liveItemShape.tool.replace),
  ])
  .superRefine(replaceFitsLength);
export type LiveItem = z.infer<typeof LiveItemSchema>;

/** The same items as a client reads them, tolerating fields a newer Host adds. */
export const LiveItemViewSchema = z
  .union([
    z.object(liveItemShape.assistant.append),
    z.object(liveItemShape.assistant.replace),
    z.object(liveItemShape.reasoning.append),
    z.object(liveItemShape.reasoning.replace),
    z.object(liveItemShape.tool.append),
    z.object(liveItemShape.tool.replace),
  ])
  .superRefine(replaceFitsLength);

export type LiveStreamKey =
  | { readonly stream: "assistant" }
  | { readonly blockId: string; readonly stream: "reasoning" }
  | { readonly callId: string; readonly stream: "tool" };

const liveRunProgressShape = {
  runId: RunIdSchema,
  threadId: ThreadIdSchema,
  workspaceId: WorkspaceIdSchema,
} as const;

export const LiveRunProgressSchema = z.strictObject({
  ...liveRunProgressShape,
  items: z.array(LiveItemSchema).min(1).max(liveProgressMaxItems),
});
export type LiveRunProgress = z.infer<typeof LiveRunProgressSchema>;

export const LiveRunProgressViewSchema = z.object({
  ...liveRunProgressShape,
  items: z.array(LiveItemViewSchema).min(1).max(liveProgressMaxItems),
});

/** A stable string for one stream of one Run, for maps keyed by stream. */
export function liveStreamKeyId(key: LiveStreamKey): string {
  switch (key.stream) {
    case "assistant":
      return "assistant";
    case "reasoning":
      return `reasoning:${key.blockId}`;
    case "tool":
      return `tool:${key.callId}`;
  }
}

export function liveStreamKeyOf(item: LiveItem): LiveStreamKey {
  switch (item.stream) {
    case "assistant":
      return { stream: "assistant" };
    case "reasoning":
      return { blockId: item.blockId, stream: "reasoning" };
    case "tool":
      return { callId: item.callId, stream: "tool" };
  }
}

/**
 * The newest `liveStreamTextMaxLength` units of a stream after an append. Both
 * ends of the wire keep the same tail, so a replace from either side is exact.
 */
export function appendLiveStreamTail(tail: string, text: string): string {
  const next = `${tail}${text}`;
  if (next.length <= liveStreamTextMaxLength) return next;
  // A tail never begins with the second half of a surrogate pair: half a
  // character is not text, and PostgreSQL refuses it in anything recorded.
  const start = next.length - liveStreamTextMaxLength;
  return next.slice(isLowSurrogate(next.charCodeAt(start)) ? start + 1 : start);
}

/** Where to cut `text` near `index` without separating a surrogate pair. */
export function surrogateSafeCut(text: string, index: number): number {
  return index > 0 && index < text.length && isLowSurrogate(text.charCodeAt(index))
    ? index - 1
    : index;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}
