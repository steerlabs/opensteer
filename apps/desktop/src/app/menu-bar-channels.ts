/** The popover's one document; its bridge and handlers answer nothing else. */
export const menuBarPopoverUrl = "app://opensteer/menu-bar.html";

export const menuBarChannels = {
  status: "opensteer-menu-bar:status",
  statusChanged: "opensteer-menu-bar:status-changed",
  setSwitch: "opensteer-menu-bar:set-switch",
  stop: "opensteer-menu-bar:stop",
  openRow: "opensteer-menu-bar:open-row",
  openNeedsYou: "opensteer-menu-bar:open-needs-you",
  openSettings: "opensteer-menu-bar:open-settings",
  resume: "opensteer-menu-bar:resume",
  setOpenAtLogin: "opensteer-menu-bar:set-open-at-login",
  openApp: "opensteer-menu-bar:open-app",
  quitCompletely: "opensteer-menu-bar:quit-completely",
} as const;
