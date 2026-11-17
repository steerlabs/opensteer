import { createHash } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import {
  contentSaysSomething,
  type ContentPart,
  type MessageAuthor,
  type MessageKind,
  type MessageId,
  type ToolOutputImage,
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
  readonly admittedSeed: boolean;
  readonly seedInRun: boolean;
  readonly assigned: boolean;
}) {
  const published =
    !input.policy ||
    input.state === "delivered" ||
    (input.policy === "report" && input.state !== "cancelled");
  const cause = input.author.kind === "platform" ? input.author.cause : null;
  const drawable =
    cause !== "claude-compaction" &&
    (input.kind === "input" ||
      input.kind === "assistant" ||
      (input.kind === "continuation" && cause === "run-recovery") ||
      cause === "assignment-result") &&
    contentSaysSomething(input.content);
  const visible = drawable && (published || input.admittedSeed);
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
      edited: input.edited,
      published,
      preview: input.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n"),
    }),
  };
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
    if (!isAbsolute(image.path) || image.path.includes("\u0000")) return [];
    const path = normalize(image.path);
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
