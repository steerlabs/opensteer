import { threadAgentPage, type HostClient } from "@opensteer/client/host";
import type { WorkspaceNavigation } from "./navigation.js";

/**
 * How long a Watch click waits for the task's page to reach this client when it is not there
 * yet at the click (a row the Home published a moment before): then the task alone stays.
 */
export const watchArrivalMs = 5_000;

let following: (() => void) | null = null;

/**
 * The person's Watch on a task whose agent works in browser pages: the click is an intent that
 * lasts. Not landed yet, it lands on the task's page when that arrives, within `watchArrivalMs`.
 * Landed, it moves to the page the task's work takes up next, only while the person has chosen no
 * other place and the task's conversation is still the one open; any choice of theirs ends it.
 * Nothing moves a place the person did not ask to watch.
 */
export function followWatch(input: {
  readonly client: Pick<HostClient, "subscribe" | "getSnapshot">;
  readonly nav: Pick<WorkspaceNavigation, "beginPlaceOperation">;
  readonly threadId: string;
  /** The page Watch landed on at the click, if any. */
  readonly shown: string | null;
}): () => void {
  following?.();
  let shown = input.shown;
  let guard = input.nav.beginPlaceOperation({ replace: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: () => void = () => {};
  const stop = () => {
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
    if (following === stop) following = null;
  };
  const check = () => {
    if (!guard.standing()) return stop();
    const page = threadAgentPage(input.client.getSnapshot(), input.threadId);
    if (!page || page.tabId === shown) return;
    guard({ kind: "tab", tabId: page.tabId });
    shown = page.tabId;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    guard = input.nav.beginPlaceOperation({ replace: true });
  };
  unsubscribe = input.client.subscribe(check);
  if (shown === null)
    timer = setTimeout(() => {
      if (shown === null) stop();
    }, watchArrivalMs);
  following = stop;
  return stop;
}
