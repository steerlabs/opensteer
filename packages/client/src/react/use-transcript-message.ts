import { useCallback } from "react";
import type { HostClient, MessageEntry } from "../host/client.js";
import { toMessageEntry } from "../host/transcript.js";
import { useHostRead } from "./use-host-read.js";
import { useItemText } from "./use-thread-transcript.js";

export function useTranscriptMessage(
  client: HostClient | null,
  threadId: string | null,
  message: MessageEntry,
  expanded: boolean,
) {
  const itemId = message.itemId;
  const text = useItemText(
    itemId && threadId ? client?.getThreadItemText(threadId) : undefined,
    itemId,
  );
  const read = useCallback(
    () => client!.readTranscriptItem(threadId!, itemId!),
    [client, threadId, itemId],
  );
  const body = useHostRead(
    expanded && client && threadId && itemId && message.previewTruncated ? read : null,
    `${threadId}:${itemId}:${message.itemRevision}`,
  ).data?.body;
  if (text) return { ...message, body: text.text, streaming: true };
  if (body?.kind === "message") {
    const full = toMessageEntry(body.message);
    if (full) return full;
  }
  if (body?.kind === "text") return { ...message, body: body.text };
  return message;
}
