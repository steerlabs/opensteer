import { stripRefs } from "@opensteer/shared/stripRefs";
import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import {
  ContentPartSchema,
  contentSaysSomething,
  threadInputDelivery,
  type MessageEdit,
  type ContentPart,
  type MessageAuthor,
  type MessageKind,
  type ToolOutputImage,
  type TeamSource,
  utf8ByteLength,
  utf8Prefix,
} from "@opensteer/core";
import type { Insertable } from "kysely";
import {
  TranscriptMessageRefsSchema,
  transcriptMessageRefLimits,
  transcriptMessageRefsMaxBytes,
  type TranscriptMessageRefs,
} from "@opensteer/protocol/transcript";
import type {
  ToolCallTable,
  ToolOutputImageTable,
  TranscriptPreview,
} from "./personal-state-schema.js";

export function transcriptIdentity(kind: string, ...parts: readonly (string | number | null)[]) {
  const key = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return `${kind}:${key}`;
}

export function toolCallId(
  input: Pick<ToolCallTable, "runId" | "attemptId" | "bindingGeneration" | "nodeId" | "callId">,
) {
  return transcriptIdentity(
    "call",
    input.runId,
    input.attemptId,
    input.bindingGeneration,
    input.nodeId,
    input.callId,
  );
}

export function transcriptPreview(input: TranscriptPreview): TranscriptPreview {
  const title = input.title === undefined ? undefined : utf8Prefix(input.title, 192);
  // PostgreSQL's jsonb text encoding adds whitespace and escapes control characters.
  const fixed = { ...input, title, preview: undefined };
  const text = input.preview ?? "";
  let preview = utf8Prefix(text, 1024);
  while (preview && utf8ByteLength(JSON.stringify({ ...fixed, preview })) > 1_920) {
    preview = utf8Prefix(preview, Math.floor(utf8ByteLength(preview) / 2));
  }
  return {
    ...fixed,
    ...(input.preview !== undefined ? { preview } : {}),
    ...(preview !== text || title !== input.title ? { truncated: true } : {}),
  };
}

export const transcriptMessageTextBytes = 1024;

function transcriptMessageContent(content: readonly ContentPart[]) {
  return {
    hasContent: contentSaysSomething(content),
    hasRichParts: content.some((part) => part.type !== "text"),
    text: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
    richParts: content.filter((part) => part.type !== "text"),
  };
}

/**
 * The references a message card carries so clients draw them inline, in message order, bounded
 * by count per kind and by total bytes. Anything past the bounds stays in the body.
 */
export function transcriptMessageRefs(parts: readonly unknown[]): TranscriptMessageRefs | null {
  const refs: { attachments: unknown[]; pages: unknown[]; places: unknown[] } = {
    attachments: [],
    pages: [],
    places: [],
  };
  let bytes = 2;
  for (const candidate of parts) {
    const parsed = ContentPartSchema.safeParse(candidate);
    if (!parsed.success || parsed.data.type === "text") continue;
    const part = parsed.data;
    const kind =
      part.type === "artifact" ? "attachments" : part.type === "browser-page" ? "pages" : "places";
    if (refs[kind].length >= transcriptMessageRefLimits[kind]) continue;
    const size = utf8ByteLength(JSON.stringify(part)) + 16;
    if (bytes + size > transcriptMessageRefsMaxBytes) continue;
    bytes += size;
    refs[kind].push(part);
  }
  const bounded = Object.fromEntries(Object.entries(refs).filter(([, list]) => list.length));
  return Object.keys(bounded).length ? TranscriptMessageRefsSchema.parse(bounded) : null;
}

export function describeTranscriptMessage(input: {
  readonly kind: MessageKind;
  readonly content:
    | readonly ContentPart[]
    | (Omit<ReturnType<typeof transcriptMessageContent>, "richParts"> & {
        readonly richParts: readonly unknown[];
      });
  readonly author: MessageAuthor;
  readonly policy?: "queue" | "steer" | "report";
  readonly state?: string;
  readonly edited: boolean;
  readonly edit?: MessageEdit;
  readonly cancelReason?: string | null;
  readonly teamSource?: TeamSource;
  readonly admittedSeed: boolean;
  readonly seedInRun: boolean;
  readonly assigned: boolean;
}) {
  const content = "text" in input.content ? input.content : transcriptMessageContent(input.content);
  const published =
    !input.policy ||
    input.state === "delivered" ||
    (input.policy === "report" && input.state !== "cancelled");
  const cause = input.author.kind === "platform" ? input.author.cause : null;
  const messageKind =
    input.kind === "input" ||
    input.kind === "assistant" ||
    (input.kind === "continuation" && cause === "run-recovery")
      ? input.kind
      : undefined;
  const drawable = cause !== "claude-compaction" && messageKind && content.hasContent;
  const delivery =
    input.policy &&
    (input.state === "unknown" ||
      (input.state === "cancelled" && input.cancelReason !== "withdrawn"))
      ? threadInputDelivery({
          cancelReason: input.cancelReason ?? null,
          policy: input.policy,
          state: input.state,
        })
      : null;
  const visible = Boolean(drawable && (published || input.admittedSeed || delivery));
  const isTurnStart =
    visible &&
    input.kind === "input" &&
    input.policy !== "report" &&
    (input.author.kind === "human" || !input.assigned || input.seedInRun);
  const text = utf8Prefix(content.text, transcriptMessageTextBytes);
  const preview = stripRefs(text).trim();
  const refs = transcriptMessageRefs(content.richParts);
  const carried =
    (refs?.attachments?.length ?? 0) + (refs?.pages?.length ?? 0) + (refs?.places?.length ?? 0);
  // Truncated means the body holds more than the card draws: cut words or references past the bounds.
  const truncated =
    carried < content.richParts.length || text !== content.text || preview !== text.trim();
  return {
    published,
    visible,
    isTurnStart,
    refs,
    view: transcriptPreview({
      author: input.author.kind,
      ...(messageKind ? { messageKind, messageAuthor: input.author } : {}),
      ...(input.edit ? { edit: input.edit } : {}),
      ...(delivery ? { delivery } : {}),
      ...(input.teamSource ? { teamSource: input.teamSource } : {}),
      edited: input.edited,
      published,
      preview,
      ...(truncated ? { truncated } : {}),
    }),
  };
}

export function normalizeToolImagePath(path: string): string | null {
  if (
    path.length > 1024 ||
    !isAbsolute(path) ||
    /\p{Cc}/u.test(path) ||
    path.split(/[/\\]/u).includes("..")
  )
    return null;
  return normalize(path);
}

export function outputImagePathHash(path: string): Buffer {
  return createHash("sha256").update(path).digest();
}

export function retainedToolImages(
  call: Pick<ToolCallTable, "id" | "threadId" | "nodeId">,
  images: readonly ToolOutputImage[],
  completionOrder: string,
): Insertable<ToolOutputImageTable>[] {
  return images.flatMap((image, imageIndex) => {
    const path = normalizeToolImagePath(image.path);
    if (!path) return [];
    return [
      {
        id: `${call.id}:${imageIndex}`,
        toolCallId: call.id,
        imageIndex,
        threadId: call.threadId,
        nodeId: call.nodeId,
        path,
        pathHash: outputImagePathHash(path),
        mediaType: image.mediaType,
        generated: image.generated === true,
        completionOrder,
      },
    ];
  });
}
