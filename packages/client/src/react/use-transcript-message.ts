import { useEffect, useState } from "react";
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
  const needsBody = expanded && message.previewTruncated === true;
  const transcript = useThreadTranscript(client, needsBody && itemId ? threadId : null, false);
  const body = useTranscriptBody({
    client,
    threadId,
    itemId,
    revision: message.itemRevision,
    generation: transcript.generation,
    enabled: needsBody && transcript.synchronized,
  }).data?.body;
  const revisionKey = `${itemId ?? message.id}:${message.itemRevision ?? ""}`;
  const [retained, setRetained] = useState<{
    readonly key: string;
    readonly value: MessageEntry;
  } | null>(null);
  const hydrated =
    body?.kind === "message"
      ? hydrateTranscriptMessage(message, body.message)
      : body?.kind === "text"
        ? { ...message, body: body.text }
        : null;
  useEffect(() => {
    if (!hydrated) return;
    setRetained((current) =>
      current?.key === revisionKey && current.value.body === hydrated.body
        ? current
        : { key: revisionKey, value: hydrated },
    );
  }, [hydrated, revisionKey]);
  if (text)
    return { ...message, body: text.incomplete ? `…${text.text}` : text.text, streaming: true };
  if (hydrated) return hydrated;
  if (retained && retained.key === revisionKey) return retained.value;
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
  const transcript = useThreadTranscript(
    client ?? null,
    input.expanded && !nodeId && itemId ? threadId : null,
    false,
  );
  const ready = nodeId !== undefined ? true : transcript.synchronized;
  const body = useTranscriptBody({
    client,
    threadId,
    nodeId,
    itemId,
    revision: input.revision,
    generation: input.generation ?? transcript.generation,
    enabled: input.expanded && ready,
  }).data?.body;
  const revisionKey = `${itemId ?? ""}:${input.revision ?? ""}`;
  const [retained, setRetained] = useState<{
    readonly key: string;
    readonly text: string;
  } | null>(null);
  const hydratedText = body?.kind === "text" ? body.text : null;
  useEffect(() => {
    if (hydratedText === null) return;
    setRetained((current) =>
      current?.key === revisionKey && current.text === hydratedText
        ? current
        : { key: revisionKey, text: hydratedText },
    );
  }, [hydratedText, revisionKey]);
  return {
    streaming: live !== undefined,
    text: live
      ? live.incomplete
        ? `…${live.text}`
        : live.text
      : hydratedText !== null
        ? hydratedText
        : retained && retained.key === revisionKey
          ? retained.text
          : input.preview,
  };
}
