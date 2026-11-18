import { useCallback, useRef, useSyncExternalStore } from "react";
import type { UserId } from "@opensteer/core";
import type { TranscriptEntry } from "../host/client.js";
import {
  projectMessageOutbox,
  sameTranscript,
  type MessageOutbox,
} from "../host/message-outbox.js";

const noSubscribe = () => () => {};

/**
 * One task's transcript with this device's waiting messages drawn in it. It
 * redraws only when a row of this task changes, never for another task's queue.
 */
export function useOutboxTranscript(
  outbox: MessageOutbox | null,
  threadId: string,
  entries: readonly TranscriptEntry[],
  viewerId: UserId | null,
): readonly TranscriptEntry[] {
  const last = useRef<readonly TranscriptEntry[] | null>(null);
  const read = useCallback(() => {
    const next =
      outbox && viewerId
        ? projectMessageOutbox(outbox.getSnapshot(), threadId, entries, viewerId)
        : entries;
    return (last.current = sameTranscript(last.current, next));
  }, [entries, outbox, threadId, viewerId]);
  return useSyncExternalStore(outbox?.subscribe ?? noSubscribe, read, read);
}
