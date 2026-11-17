import { stripRefs } from "@opensteer/shared/stripRefs";
import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import {
  contentSaysSomething,
  threadInputDelivery,
  type MessageEdit,
  type ContentPart,
  type MessageAuthor,
  type MessageKind,
  type MessageId,
  type ToolOutputImage,
  type TeamSource,
  utf8ByteLength,
  utf8Prefix,
} from "@opensteer/core";
import type { Insertable } from "kysely";
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

export function describeTranscriptMessage(input: {
  readonly id: MessageId;
  readonly kind: MessageKind;
  readonly content: readonly ContentPart[];
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
  const drawable =
    cause !== "claude-compaction" && messageKind && contentSaysSomething(input.content);
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
  return {
    published,
    visible,
    isTurnStart,
    view: transcriptPreview({
      author: input.author.kind,
      ...(messageKind ? { messageKind, messageAuthor: input.author } : {}),
      ...(input.edit ? { edit: input.edit } : {}),
      ...(delivery ? { delivery } : {}),
      ...(input.teamSource ? { teamSource: input.teamSource } : {}),
      edited: input.edited,
      published,
      preview: input.content
        .flatMap((part) => (part.type === "text" ? [stripRefs(part.text)] : []))
        .join("\n"),
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
