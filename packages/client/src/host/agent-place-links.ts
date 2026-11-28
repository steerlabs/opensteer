import type { Tab, TabId, TabKind } from "@opensteer/core";
import type { HostSnapshot } from "./client.js";
import { threadInDirectory } from "./host-snapshot-selectors.js";

/*
 * Where a link the person clicks goes: from a task to the place its agent is
 * working, and from a Request to the page it is about. Nothing here moves the
 * person's tab by itself; only their click on such a link does.
 */

/** One page tab, by its stable ID. */
export interface BrowserTabDestination {
  readonly tabId: TabId;
}

/** The tab a task's agent is working in now, of any kind, with the name a link to it says. */
export interface ThreadAgentPlace {
  readonly tabId: TabId;
  readonly kind: TabKind;
  readonly title: string;
}

function placeTitle(tab: Tab): string {
  const title = tab.title.trim();
  if (title) return title;
  switch (tab.kind) {
    case "page":
      return "the page";
    case "window":
      return tab.appName?.trim() || "the app";
    case "phone":
      return tab.computer.name.trim() || "the phone";
    case "app":
      return "the app";
  }
}

/**
 * The page, Mac app or phone screen a task holds that changed most recently: where its agent
 * is working right now, for a link from the task to it. Holding is the Host's word.
 */
export function threadAgentPlace(
  source: Pick<HostSnapshot, "tabs">,
  threadId: string,
): ThreadAgentPlace | null {
  let best: Tab | null = null;
  for (const tab of source.tabs.rows.values())
    if (
      tab.usedBy.some((holder) => holder.taskId === threadId) &&
      (best === null || tab.updatedAt > best.updatedAt)
    )
      best = tab;
  return best && { tabId: best.tabId, kind: best.kind, title: placeTitle(best) };
}

/** The Home's place belongs to the current session alone. */
export function watchSessionPlace(
  source: Pick<HostSnapshot, "agentWorkingIn" | "threads" | "tasks" | "activeTasks">,
  threadId: string,
) {
  const working = source.agentWorkingIn?.[threadId];
  const work = threadInDirectory(threadId, source)?.externalWork;
  return working && (!work || (work.status === "active" && work.sessionId === working.sessionId))
    ? working
    : null;
}

/** Watch's tab, if the named place has one here. A device place never falls back to a browser. */
export function watchPage(
  source: Pick<HostSnapshot, "tabs" | "agentWorkingIn" | "threads" | "tasks" | "activeTasks">,
  threadId: string,
): BrowserTabDestination | null {
  const working = watchSessionPlace(source, threadId);
  if (!working) return threadAgentPage(source, threadId);
  if (working.computerId) {
    for (const tab of source.tabs.rows.values())
      if (
        tab.kind === "phone" &&
        tab.state !== "unavailable" &&
        tab.computer.computerId === working.computerId
      )
        return { tabId: tab.tabId };
    return null;
  }
  if (working.tabId === null) return threadAgentPage(source, threadId);
  const tab = source.tabs.get(working.tabId);
  return tab?.kind === "page" && tab.state !== "unavailable"
    ? { tabId: tab.tabId }
    : threadAgentPage(source, threadId);
}

/** The device the Home says a connected agent worked on most recently. */
export function watchComputerId(
  source: Pick<HostSnapshot, "agentWorkingIn" | "threads" | "tasks" | "activeTasks">,
  threadId: string,
): string | null {
  return watchSessionPlace(source, threadId)?.computerId ?? null;
}

/**
 * The page tab a task holds, for Watch when the Home names no tab it is working in, and for its
 * badge: of the pages the task holds that can be shown now, the one its work took up last (the
 * holder's `since`: a script's bind of it, a Run's last action in it). A holder with no time
 * comes after any with one; then the row that changed last. Holding is the Host's word.
 */
export function threadAgentPage(
  source: Pick<HostSnapshot, "tabs">,
  threadId: string,
): BrowserTabDestination | null {
  let best: { readonly tab: Tab; readonly since: string } | null = null;
  for (const tab of source.tabs.rows.values()) {
    if (tab.kind !== "page" || tab.state === "unavailable") continue;
    const holder = tab.usedBy.find((entry) => entry.taskId === threadId);
    if (!holder) continue;
    const since = holder.since ?? "";
    if (
      best === null ||
      since > best.since ||
      (since === best.since && tab.updatedAt > best.tab.updatedAt)
    )
      best = { tab, since };
  }
  return best && { tabId: best.tab.tabId };
}

/**
 * The page a Request is about, or null: the tab the Request names, while the tab list still
 * holds it; when it names none, the asking task's page, only while the task holds exactly
 * one. Never the most recent of several, which may be another site altogether.
 */
export function requestPageTab(
  source: Pick<HostSnapshot, "tabs">,
  request: {
    readonly originatingThreadId?: string | null | undefined;
    readonly payload: { readonly kind: string; readonly tabId?: string | undefined };
  },
): BrowserTabDestination | null {
  const named = request.payload.kind === "browser.sign-in" ? request.payload.tabId : undefined;
  if (named !== undefined) {
    const tab = source.tabs.get(named);
    return tab?.kind === "page" ? { tabId: tab.tabId } : null;
  }
  const threadId = request.originatingThreadId;
  if (!threadId) return null;
  let only: TabId | null = null;
  for (const tab of source.tabs.rows.values()) {
    if (tab.kind !== "page" || !tab.usedBy.some((holder) => holder.taskId === threadId)) continue;
    if (only !== null) return null;
    only = tab.tabId;
  }
  return only === null ? null : { tabId: only };
}
