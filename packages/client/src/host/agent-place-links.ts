import type { Tab, TabId, TabKind } from "@opensteer/core";
import type { HostSnapshot } from "./client.js";

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
