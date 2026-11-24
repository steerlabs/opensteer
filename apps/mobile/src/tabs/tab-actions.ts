import type { HostClient } from "@opensteer/client/host";
import type { TabGroupId, TabId } from "@opensteer/core";
import { refusal, type ScreenActionSpec } from "../ui/client-feedback.js";

type Work = () => Promise<unknown>;
const runWork = (work: Work) => work();
const words = (label: string, done: string, happened: string): ScreenActionSpec<Work, unknown> => ({
  label,
  done,
  happened,
  execute: runWork,
});

/**
 * Each action on a tab or group, as it is said how it went; the key ties the
 * menu running it to the row saying so.
 */
export const tabActionSpecs = {
  close: words("close this tab", "closed", "this tab closed"),
  move: words("move this tab", "moved", "this tab moved"),
  open: words("open this tab", "opened", "this tab opened"),
  reopen: words("reopen this tab", "reopened", "this tab reopened"),
  reopenLast: words("reopen a closed tab", "reopened", "a closed tab reopened"),
  newTab: words("open a new tab", "opened", "a new tab opened"),
  changeGroup: words("change this group", "changed", "this group changed"),
  closeGroup: words("close these tabs", "closed", "these tabs closed"),
} as const;

export type TabActionKind = keyof typeof tabActionSpecs;

export function tabActionKey(kind: TabActionKind, id: string): string {
  return `tab-action:${kind}:${id}`;
}

/** Closes tabs, saying a refusal the answer carried as the refusal it is. */
export async function closeTabs(client: HostClient, tabIds: readonly TabId[]): Promise<void> {
  const result = await client.closeTabs([...tabIds]);
  const failed = result.failed[0];
  if (failed !== undefined) throw refusal(failed.error.code, failed.error.message);
}

/** Closes a group on the Home, its tabs as they are then and the group with them. */
export async function closeTabGroup(client: HostClient, groupId: TabGroupId): Promise<void> {
  const result = await client.closeTabGroup(groupId);
  const failed = result.failed[0];
  if (failed !== undefined) throw refusal(failed.error.code, failed.error.message);
}
