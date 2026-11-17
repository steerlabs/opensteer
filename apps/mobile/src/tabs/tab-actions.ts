import type { HostClient } from "@opensteer/client/host";
import type { TabId } from "@opensteer/core";
import { refusal, type ItemActionWords } from "../ui/item-action.js";

/**
 * What each action on a tab or group is called when it is said how it went,
 * and the key that ties the menu running it to the row saying so.
 */
export const tabActionWords = {
  close: { done: "closed", label: "close", thing: "this tab" },
  move: { done: "moved", label: "move", thing: "this tab" },
  open: { done: "opened", label: "open", thing: "this tab" },
  reopen: { done: "reopened", label: "reopen", thing: "this tab" },
  reopenLast: { done: "reopened", label: "reopen", thing: "a closed tab" },
  newTab: { done: "opened", label: "open", thing: "a new tab" },
  changeGroup: { done: "changed", label: "change", thing: "this group" },
  closeGroup: { done: "closed", label: "close", thing: "these tabs" },
} as const satisfies Readonly<Record<string, ItemActionWords>>;

export type TabActionKind = keyof typeof tabActionWords;

export function tabActionKey(kind: TabActionKind, id: string): string {
  return `tab-action:${kind}:${id}`;
}

/** Closes tabs, saying a refusal the answer carried as the refusal it is. */
export async function closeTabs(client: HostClient, tabIds: readonly TabId[]): Promise<void> {
  const result = await client.closeTabs([...tabIds]);
  const failed = result.failed[0];
  if (failed !== undefined) throw refusal(failed.error.code, failed.error.message);
}
