import {
  readTaskActivity,
  taskActivityKey,
  threadInDirectory,
  watchComputerId,
  watchPage,
  type HostClient,
} from "@opensteer/client/host";
import { useSyncExternalStore } from "react";
import type { WorkspaceNavigation } from "./navigation.js";
import { taskAppWatch } from "./task-app-watch.js";

let following: (() => void) | null = null;
let placeWait: {
  readonly client: HostClient;
  readonly threadId: string;
  readonly standing: () => boolean;
  readonly state: "waiting" | "ended";
} | null = null;
const listeners = new Set<() => void>();
function setPlaceWait(next: typeof placeWait) {
  placeWait = next;
  for (const listener of listeners) listener();
}

function subscribeWaiting(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWatchPlaceWait(client: HostClient, threadId: string | null) {
  return useSyncExternalStore(subscribeWaiting, () =>
    placeWait?.client === client && placeWait.threadId === threadId && placeWait.standing()
      ? placeWait.state
      : null,
  );
}

/**
 * The person's Watch on a task whose agent works in browser pages: the click is an intent that
 * lasts. Before landing it waits for the operation already in flight to yield its place.
 * Landed, it moves to the tab the Home says the task's agent works in next (`watchPage`), only
 * while the person has chosen no other place and the task's conversation is still the one open;
 * any choice of theirs ends it.
 * Nothing moves a place the person did not ask to watch.
 */
export function followWatch(input: {
  readonly client: HostClient;
  readonly nav: Pick<WorkspaceNavigation, "beginPlaceOperation">;
  readonly threadId: string;
  /** The page Watch landed on at the click, if any. */
  readonly shown: string | null;
  readonly computerId?: string | null;
}): () => void {
  following?.();
  setPlaceWait(null);
  let shown = input.shown;
  let device = input.shown ? null : (input.computerId ?? null);
  let guard = input.nav.beginPlaceOperation({ replace: true });
  const controller = new AbortController();
  const requested = {
    client: input.client,
    threadId: input.threadId,
    standing: () => guard.standing(),
  };
  let pending = shown === null;
  let revision: string | null = null;
  let operations: ReadonlySet<string> | undefined;
  let unsubscribe: () => void = () => {};
  const stop = (ended = false) => {
    unsubscribe();
    controller.abort();
    if (placeWait?.standing === requested.standing)
      setPlaceWait(ended && pending ? { ...requested, state: "ended" } : null);
    if (following === stop) following = null;
  };
  const check = () => {
    if (!guard.standing()) return stop();
    const snapshot = input.client.getSnapshot();
    const task = threadInDirectory(input.threadId, snapshot);
    if (task?.externalWork?.status === "ended") return stop(true);
    const page = watchPage(snapshot, input.threadId);
    const computer = watchComputerId(snapshot, input.threadId);
    if (page && page.tabId !== shown) {
      guard({ kind: "tab", tabId: page.tabId });
      shown = page.tabId;
      device = null;
      pending = false;
      setPlaceWait(null);
      guard = input.nav.beginPlaceOperation({ replace: true });
    } else if (!page && computer && device !== computer) {
      guard.watch();
      device = computer;
      shown = null;
      guard = input.nav.beginPlaceOperation({ replace: true });
    }
    if (
      pending &&
      device &&
      taskAppWatch({
        hostConnected: snapshot.connection === "connected",
        machines: snapshot.machines,
        threadId: input.threadId,
        computerId: device,
      })
    ) {
      pending = false;
      setPlaceWait(null);
    }
    if (!pending) return;
    const key = taskActivityKey(task);
    if (key === null || key === revision) return;
    revision = key;
    void readTaskActivity(input.client, input.threadId, controller.signal)
      .then((activity) => {
        if (controller.signal.aborted || key !== revision || !pending) return;
        if (!guard.standing()) return stop();
        const active = activity.filter(
          ({ tool, outcome, sessionId }) =>
            (tool === "browser_use" || tool === "browser_connect" || tool === "computer_use") &&
            outcome === null &&
            sessionId === task?.externalWork?.sessionId,
        );
        operations ??= new Set(active.map(({ id }) => id));
        if (!active.some(({ id }) => operations!.has(id))) stop(true);
      })
      .catch(() => {
        if (key === revision) revision = null;
      });
  };
  unsubscribe = input.client.subscribe(check);
  following = stop;
  if (pending) setPlaceWait({ ...requested, state: "waiting" });
  check();
  return stop;
}
