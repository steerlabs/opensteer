import type { HostClient, MessageEntry } from "../host/client.js";
import { hydrateTranscriptMessage } from "../host/transcript.js";
import { useTranscriptBody } from "./use-transcript-body.js";
import { useItemText, useThreadTranscript } from "./use-thread-transcript.js";

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
  const transcript = useThreadTranscript(client, expanded && itemId ? threadId : null, false);
  const body = useTranscriptBody({
    client,
    threadId,
    itemId,
    revision: message.itemRevision,
    generation: transcript.generation,
    enabled: expanded && message.previewTruncated === true && transcript.synchronized,
  }).data?.body;
  if (text)
    return { ...message, body: text.incomplete ? `…${text.text}` : text.text, streaming: true };
  if (body?.kind === "message") {
    const full = hydrateTranscriptMessage(message, body.message);
    if (full) return full;
  }
  if (body?.kind === "text") return { ...message, body: body.text };
  return message;
}

export function useTranscriptText(input: {
  readonly client?: HostClient | null | undefined;
  readonly threadId?: string | null | undefined;
  readonly nodeId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly revision?: string | undefined;
  readonly generation?: number | undefined;
  readonly expanded: boolean;
  readonly preview: string;
}) {
  const { client, threadId, nodeId, itemId } = input;
  const live = useItemText(
    threadId && itemId ? client?.getThreadItemText(threadId, nodeId) : undefined,
    itemId,
  );
  const body = useTranscriptBody({
    client,
    threadId,
    nodeId,
    itemId,
    revision: input.revision,
    generation: input.generation,
    enabled: input.expanded,
  }).data?.body;
  return {
    streaming: live !== undefined,
    text: live
      ? live.incomplete
        ? `…${live.text}`
        : live.text
      : body?.kind === "text"
        ? body.text
        : input.preview,
  };
}
