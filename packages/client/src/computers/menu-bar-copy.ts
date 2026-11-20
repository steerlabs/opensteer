/**
 * Every word the Mac menu bar popover and its dialogs show, keyed by stable
 * copy ids. This is the source of truth for these strings. `{name}` marks a
 * value filled in by `menuBarWords`.
 */
export const menuBarCopy = {
  "menubar.title": "Opensteer",
  "menubar.home": "Home: {home}",
  "menubar.moreHomes": "+{count} more",
  "menubar.noHome": "This Mac isn’t connected to a Home yet.",
  "menubar.status.connected": "Connected",
  "menubar.status.local": "This Mac is your Home · Running",
  "menubar.status.localStarting": "This Mac is your Home · Starting…",
  "menubar.status.localAttention": "This Mac is your Home · Needs attention",
  "menubar.status.localStopped": "This Mac is your Home · Stopped",
  "menubar.status.reconnecting": "Reconnecting…",
  "menubar.status.unreachable": "Can’t reach {home}",
  "menubar.status.signedOut": "Sign in to {home} again",
  "menubar.status.paused": "Stopped on this Mac",
  "menubar.needsYou": "{count} need you",
  "menubar.needsYouOne": "1 needs you",
  "menubar.needsYouPartial": "At least {count} need you",
  "menubar.needsYouUnread": "Couldn’t check {home} for what needs you",
  "menubar.rightNow": "Right now",
  "menubar.rightNow.agent": "An agent",
  "menubar.rightNow.task": "A task",
  "menubar.rightNow.profile": "A browser profile",
  "menubar.rightNow.tab": "A new browser tab",
  "menubar.rightNow.app": "An app",
  "menubar.rightNow.files": "Files and commands",
  "menubar.rightNow.running": "Working on this Mac",
  "menubar.rightNow.backgroundJob": "A background job on this Mac",
  "menubar.rightNow.voice": "A voice call on this Mac",
  "menubar.rightNow.shell": "Commands from {machine}",
  "menubar.row.stopping": "Stopping…",
  "menubar.row.failed": "Didn’t stop. Try again.",
  "menubar.thisMac": "This Mac",
  "menubar.thisMac.unreadable": "Open Opensteer to change what agents can use on this Mac.",
  "devices.switch.browser": "Browser",
  "devices.switch.apps": "Apps",
  "devices.switch.files": "Files and commands",
  "devices.switch.browserDetail": "Open and use tabs",
  "devices.switch.appsDetail": "See and control apps",
  "devices.switch.filesDetail": "Read files and run commands",
  "menubar.switch.on": "On",
  "menubar.switch.fixedHome": "Always on. Your agent runs here.",
  "menubar.switch.fixed": "Always on",
  "menubar.switch.needsMacos": "On · needs macOS permission",
  "menubar.switch.unavailable": "That switch can’t be changed from here right now.",
  "menubar.switch.conflict": "This changed on another device. The switches show what’s set now.",
  "menubar.stop": "Stop",
  "menubar.stopAll": "Stop everything on this Mac",
  "menubar.stopAll.offline": "Works even while {home} is unreachable.",
  "menubar.stopped": "Stopped everything on this Mac at {time}.",
  "menubar.stopped.detail": "Agents can’t use this Mac until you resume.",
  "menubar.stopping": "Stopping agents on this Mac…",
  "menubar.stopped.confirmed": "{home} shows this Mac as stopped too.",
  "menubar.resume": "Resume",
  "menubar.stop.unsaved":
    "Agents are stopped now, but Opensteer couldn’t save that, so they could start again after Opensteer restarts. Press Stop everything to try again.",
  "menubar.stop.unread":
    "Opensteer couldn’t read whether you stopped agents on this Mac, so they stay stopped. Press Resume to let them use this Mac again.",
  "menubar.stop.partial":
    "Some agent work on this Mac didn’t stop ({parts}). Press Stop everything to try again.",
  "menubar.resume.unsaved": "Opensteer couldn’t save Resume, so agents stay stopped. Try again.",
  "menubar.resume.partial": "Agents may use this Mac again, but {parts} didn’t come back yet.",
  "menubar.open": "Open Opensteer",
  "menubar.settings": "Settings…",
  "menubar.more": "More",
  "menubar.openAtLogin": "Open at login",
  "menubar.quit": "Quit",
  "menubar.quit.title": "Quit Opensteer?",
  "menubar.quit.body": "Agents can’t use this Mac until you open it again.",
  "menubar.quit.bodyHome":
    "This Mac is your Home, so your phone and other devices can’t reach it until then either.",
  "menubar.quit.bodyUnknown": "Opensteer can’t tell right now whether agents are using this Mac.",
  "common.cancel": "Cancel",
} as const;

export type MenuBarCopyId = keyof typeof menuBarCopy;

/** One string, its `{placeholders}` filled from `values`. */
export function menuBarWords(
  id: MenuBarCopyId,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return menuBarCopy[id].replace(/\{(\w+)\}/gu, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}
