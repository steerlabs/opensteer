import { defineAgentTool } from "../registry.js";
import {
  TabCloseInputSchema,
  TabCloseResultSchema,
  TabGroupUpdateInputSchema,
  TabGroupUpdateResultSchema,
  TabListInputSchema,
  TabListResultSchema,
  TabOpenInputSchema,
  TabOpenResultSchema,
  TabOrganizeInputSchema,
  TabOrganizeResultSchema,
} from "@opensteer/protocol";
export const tab_list = defineAgentTool({
  name: "tab_list",
  title: "List tabs",
  description:
    "Find the person's page, window, phone and app tabs, including asleep and unavailable tabs. Query matches title, URL, group, profile, app or computer name. Results follow workspace order, 50 per page; keep query and kind when using nextCursor. Groups organize tabs and grant no access. Use tab_open to open a target, Browser Harness openPage(tabId) for pages, or computer_use tab(tabId) for windows and phones.",
  input: TabListInputSchema,
  output: TabListResultSchema,
  access: "read",
  callers: ["run", "connection"] as const,
  capability: "tabs",
});
export const tab_open = defineAgentTool({
  name: "tab_open",
  title: "Open a tab",
  description:
    "Open a website, exact desktop window, Agent Phone or iPhone screen, or published app in the person's shared tab list. A profile stays on its home computer; Guest defaults to the hosting computer. windowId comes from computer_use app.windows(); bundleId opens or launches that approved app and binds its chosen window. Phone and app targets reuse their one tab. Publishing an app alone does not open it. The returned tabId works with tab tools and show_to_person; opening does not move the person's selection.",
  input: TabOpenInputSchema,
  output: TabOpenResultSchema,
  access: "write",
  callers: ["run"] as const,
  capability: "tabs",
});
export const tab_close = defineAgentTool({
  name: "tab_close",
  title: "Close tabs",
  description:
    "Remove these entries from the person's tab list. This does not quit a desktop app, stop a phone, stop agent work or stop an app server. Each ID is independent; closed lists successes and failed gives per-tab errors. Use app_stop to stop an app server.",
  input: TabCloseInputSchema,
  output: TabCloseResultSchema,
  access: "write",
  callers: ["run"] as const,
  capability: "tabs",
});
export const tab_organize = defineAgentTool({
  name: "tab_organize",
  title: "Organize tabs",
  description:
    "Move tabs into an existing group, a new named group, or no group (null). All kinds can mix. tabIds gives their order. beforeTabId inserts before a destination tab; omit it to append. To move a whole group, pass all of its tabIds with its groupId; beforeTabId then places the group before that tab. Get IDs from tab_list. A stale destination fails without moving anything.",
  input: TabOrganizeInputSchema,
  output: TabOrganizeResultSchema,
  access: "write",
  callers: ["run"] as const,
  capability: "tabs",
});
export const tab_group_update = defineAgentTool({
  name: "tab_group_update",
  title: "Update a tab group",
  description:
    "Rename, recolor, collapse or expand a tab group from tab_list. Supply at least one changed field. Collapsing changes the shared list; it does not close tabs or stop work.",
  input: TabGroupUpdateInputSchema,
  output: TabGroupUpdateResultSchema,
  access: "write",
  callers: ["run"] as const,
  capability: "tabs",
});
export const tabTools = [tab_list, tab_open, tab_close, tab_organize, tab_group_update] as const;
