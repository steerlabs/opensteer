import type { TabId, ThreadId, UserId } from "@opensteer/core";
import type { TabRecord } from "@opensteer/database";
import type { BrowserService } from "../browser/browser-service.js";
import { canReadTab } from "../tabs/tab-authority.js";

/**
 * Lets go of each tab `bindingId` holds that its connection can no longer read by the one rule
 * (rule 1, through the tab authority), and answers the tabs it let go of. A tab the rule still
 * grants stays held. A closed or removed tab is let go of too.
 */
export async function releaseUngrantedTabs(
  bindingId: string,
  browser: Pick<BrowserService, "heldTabs" | "releaseHeldTab">,
  row: (ownerId: UserId, tabId: TabId) => Promise<TabRecord | null>,
  database: Parameters<typeof canReadTab>[2],
): Promise<readonly TabId[]> {
  const released: TabId[] = [];
  for (const held of browser.heldTabs(bindingId)) {
    const tab = await row(held.ownerId, held.tabId);
    const actor = {
      kind: "browser-binding" as const,
      authority: { agentBindingId: bindingId, ownerId: held.ownerId },
      threadId: held.threadId satisfies ThreadId,
    };
    if (tab && (await canReadTab(actor, tab, database))) continue;
    browser.releaseHeldTab(bindingId, held.tabId);
    released.push(held.tabId);
  }
  return released;
}
