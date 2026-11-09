import {
  freshRunPageMemory,
  type HostClient,
  type RunPageMemory,
  type RunPageShown,
} from "@opensteer/client/host";
import { useCallback, useSyncExternalStore } from "react";

/** What the conversation shows of its Run's page, read by the bar over it. */
export interface RunPageView {
  readonly memory: RunPageMemory;
  readonly runId: string | null;
  readonly shown: RunPageShown;
  /** Whether there is room to open it here; without it, the bar opens the full tab. */
  readonly room: boolean;
}

const fresh: RunPageView = { memory: freshRunPageMemory, runId: null, shown: "none", room: true };

interface Held {
  view: RunPageView;
  readonly listeners: Set<() => void>;
}

// Per attachment, so another Host or a sign-out starts from nothing; never persisted.
const held = new WeakMap<HostClient, Map<string, Held>>();

function entry(hostClient: HostClient, threadId: string): Held {
  let threads = held.get(hostClient);
  if (threads === undefined) held.set(hostClient, (threads = new Map()));
  let value = threads.get(threadId);
  if (value === undefined) threads.set(threadId, (value = { view: fresh, listeners: new Set() }));
  return value;
}

/**
 * One conversation's page, shared by its pane and the bar over it: the
 * native bar is configured by the screen, not the pane, so no React context
 * reaches from one to the other.
 */
export function useRunPageView(
  hostClient: HostClient,
  threadId: string,
): readonly [RunPageView, (change: (view: RunPageView) => RunPageView) => void] {
  const subscribe = useCallback(
    (listener: () => void) => {
      const value = entry(hostClient, threadId);
      value.listeners.add(listener);
      return () => value.listeners.delete(listener);
    },
    [hostClient, threadId],
  );
  const get = useCallback(() => entry(hostClient, threadId).view, [hostClient, threadId]);
  const view = useSyncExternalStore(subscribe, get, get);
  const update = useCallback(
    (change: (view: RunPageView) => RunPageView) => {
      const value = entry(hostClient, threadId);
      const next = change(value.view);
      if (
        next.memory === value.view.memory &&
        next.runId === value.view.runId &&
        next.shown === value.view.shown &&
        next.room === value.view.room
      )
        return;
      value.view = next;
      for (const listener of value.listeners) listener();
    },
    [hostClient, threadId],
  );
  return [view, update] as const;
}
