import type { BrowserTabSummary } from "@opensteer/client/host";
import {
  browserPagePart,
  pageSiteLabel,
  browserTabTitle,
  type BrowserSessionSummary,
} from "@opensteer/client/host";
import { TabIdSchema, type BrowserPageContentPart, type TabId } from "@opensteer/core";
import { isRecord } from "@opensteer/shared/isRecord";

/**
 * The tab screen's route: exactly one tab, by its tabId, whatever kind it is.
 * The route is this device's selection, so a link names exactly what it opens
 * and never a viewing lease, a browser session or a window number, which come
 * and go under the same tab. Where it was opened from — a conversation, Tabs,
 * the sidebar — decides only where Back goes, which the stack already knows.
 */
export type TabRoute = {
  readonly deploymentId: string;
  readonly tabId: TabId;
  /** The conversation it was opened from, when it was. */
  readonly threadId?: string;
  readonly editAddress?: boolean;
  /** A popup the person's input opened: when it ends they return to the page under it. */
  readonly popup?: boolean;
};

export function tabRoute(deploymentId: string, tabId: TabId, threadId?: string): TabRoute {
  return { deploymentId, tabId, ...(threadId === undefined ? {} : { threadId }) };
}

/** The tab a route held in the stack, or a link, names; null for anything else. */
export function paramsTabId(params: unknown): TabId | null {
  if (!isRecord(params)) return null;
  const parsed = TabIdSchema.safeParse(params["tabId"]);
  return parsed.success ? parsed.data : null;
}

/**
 * The page's host as a person says it, or null for a page with no address worth naming. It keeps a
 * port that is not the default and a scheme that is not https, as a browser's bar does, so two
 * pages on one host are never named alike (`pageSiteLabel`).
 */
export function pageSite(url: string): string | null {
  if (!/^https?:\/\//iu.test(url)) return null;
  return pageSiteLabel(url, { origin: true });
}

/**
 * The page a person is looking at, as a message includes it: the exact tab,
 * and the title and address they saw. Null for a page with no web address,
 * which there is nothing to ask about.
 */
export function viewedPage(
  session: Pick<BrowserSessionSummary, "id">,
  tab: BrowserTabSummary,
): BrowserPageContentPart | null {
  if (tab.navigationFailed || pageSite(tab.url) === null) return null;
  try {
    return browserPagePart({
      sessionId: session.id,
      tabId: tab.id,
      title: browserTabTitle(tab),
      url: tab.url,
    });
  } catch {
    // A browser the Host never named as one cannot be included.
    return null;
  }
}

/** One page, whatever its title becomes: its browser, its tab and its address. */
export function pageIdentity(page: BrowserPageContentPart): string {
  return `${page.sessionId}\u0000${page.tabId}\u0000${page.url}`;
}
