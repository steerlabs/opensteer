import { useMemo, useSyncExternalStore } from "react";
import type { MessageOutbox, MessageOutboxSnapshot } from "../host/message-outbox.js";

const noSubscribe = () => () => {};
const noSnapshot = () => null;
export function useOptionalMessageOutbox(
  outbox: MessageOutbox | null,
): MessageOutboxSnapshot | null {
  return useSyncExternalStore(
    outbox?.subscribe ?? noSubscribe,
    outbox?.getSnapshot ?? noSnapshot,
    outbox?.getSnapshot ?? noSnapshot,
  );
}

export function useMessageOutbox(outbox: MessageOutbox, threadId: string): MessageOutboxSnapshot {
  const state = useSyncExternalStore(outbox.subscribe, outbox.getSnapshot, outbox.getSnapshot);
  return useMemo(
    () => ({
      ...state,
      messages: state.messages.filter((entry) => entry.command.threadId === threadId),
    }),
    [state, threadId],
  );
}
