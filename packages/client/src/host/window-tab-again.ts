import type { Tab, TabTarget } from "@opensteer/core";
import type { TabsClient } from "./tabs-contract.js";

/** The answers that say a window tab's own window is gone, by its view or by its row. */
const goneWindow = new Set(["window-closed", "window-identity-lost"]);

/**
 * Whether Open again on this tab opens its app afresh: the person's own window tab whose
 * window is gone. A tab a task opened keeps the window its Run observed, and Open again on it
 * activates it as before.
 */
export function opensWindowAgain(tab: Tab, viewReason: string | null): boolean {
  return (
    tab.kind === "window" &&
    tab.openedBy === "person" &&
    !!tab.bundleId &&
    (goneWindow.has(viewReason ?? "") ||
      (tab.state === "unavailable" && goneWindow.has(tab.unavailableCode ?? "")))
  );
}

/**
 * Open again for a window tab whose window is gone, as a person does it by hand: open the same
 * app on the same device through New tab's own door, show the new tab, put it in the dead tab's
 * place, then close the dead tab. A refused open (the app shows no window, the Mac is away)
 * throws its own refusal and closes nothing.
 */
export async function openWindowTabAgain(
  client: Pick<TabsClient, "openTab" | "organizeTabs" | "closeTabs">,
  dead: Tab,
  show: (tabId: Tab["tabId"]) => void,
): Promise<Tab> {
  const opened = await client.openTab({
    kind: "window",
    computerId: dead.computer.computerId,
    bundleId: dead.bundleId!,
  } as TabTarget);
  show(opened.tabId);
  if (opened.tabId === dead.tabId) return opened;
  await client.organizeTabs({
    tabIds: [opened.tabId],
    group: dead.groupId ? { groupId: dead.groupId } : null,
    beforeTabId: dead.tabId,
  });
  await client.closeTabs([dead.tabId]);
  return opened;
}
