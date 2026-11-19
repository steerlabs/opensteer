import type { ContentPart } from "@opensteer/core";
import { useEffect, useState } from "react";
import type { HostClient } from "../host/client.js";
import { unwrapRpcResult } from "../host/host-session-client.js";
import { messageDraftParts } from "../host/pending-send.js";
import type { WaitingInput } from "../host/waiting-inputs.js";

/**
 * The whole of a waiting message at the version the tray shows. The queue
 * carries a clipped preview; anything that approves or acts on the words
 * waits for `complete`, so it never names text the person did not see.
 */
export type WaitingBody =
  | { readonly status: "complete"; readonly text: string; readonly revision: number }
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly retry: () => void };

/** Reads the full words of `messageId` at exactly `revision`; a newer one is a conflict. */
export async function readWaitingBody(
  client: Pick<HostClient, "rpc">,
  input: Pick<WaitingInput, "threadId" | "messageId" | "revision">,
): Promise<readonly ContentPart[]> {
  const page = unwrapRpcResult(
    await client.rpc["thread.message.revisions.list"]({
      threadId: input.threadId as never,
      messageId: input.messageId as never,
      expectedRevision: input.revision,
    }),
  );
  const current = page.revisions[0];
  if (current?.revision !== input.revision)
    throw new Error("The waiting message changed while it was read.");
  return current.content;
}

// The tray and the decision dock show the same ask: one read serves both.
const shared = new WeakMap<object, Map<string, Promise<readonly ContentPart[]>>>();

function sharedRead(
  client: Pick<HostClient, "rpc">,
  key: string,
  input: Pick<WaitingInput, "threadId" | "messageId" | "revision">,
) {
  let reads = shared.get(client);
  if (!reads) shared.set(client, (reads = new Map()));
  const held = reads.get(key);
  if (held) return held;
  const read = readWaitingBody(client, input);
  reads.set(key, read);
  if (reads.size > 32) reads.delete(reads.keys().next().value!);
  // A failed read is not kept, so Try again reads again.
  read.catch(() => {
    if (reads.get(key) === read) reads.delete(key);
  });
  return read;
}

export function useWaitingBody(
  client: Pick<HostClient, "rpc">,
  input: WaitingInput | null,
): WaitingBody {
  const truncated = input?.entry.previewTruncated === true;
  const threadId = input?.threadId;
  const messageId = input?.messageId;
  const revision = input?.revision;
  const key = input && truncated ? `${threadId}:${messageId}:${revision}` : null;
  const [read, setRead] = useState<{ key: string; body: WaitingBody } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (key === null || threadId === undefined || messageId === undefined || revision === undefined)
      return;
    const controller = new AbortController();
    setRead({ key, body: { status: "loading" } });
    const loaded = (content: readonly ContentPart[]) =>
      setRead({
        key,
        body: { status: "complete", revision, text: messageDraftParts(content).body },
      });
    sharedRead(client, key, { threadId, messageId, revision }).then(
      (content) => {
        if (!controller.signal.aborted) loaded(content);
      },
      () => {
        if (!controller.signal.aborted)
          setRead({
            key,
            body: { status: "failed", retry: () => setAttempt((value) => value + 1) },
          });
      },
    );
    return () => controller.abort();
  }, [attempt, client, key, messageId, revision, threadId]);
  if (!input) return { status: "loading" };
  if (!truncated) return { status: "complete", text: input.entry.body, revision: input.revision };
  return read?.key === key ? read.body : { status: "loading" };
}
