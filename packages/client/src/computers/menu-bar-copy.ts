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
  "menubar.rightNow.shell": "Files and commands from {machine}",
  "menubar.rightNow.forTask": "{using} · {task}",
  "menubar.thisMac": "This Mac",
  "menubar.thisMac.unreadable": "Open Opensteer to change what agents can use on this Mac.",
  "devices.switch.browser": "Browser",
  "devices.switch.apps": "Apps",
  "devices.switch.files": "Files and commands",
  "devices.switch.browserDetail": "Open and use tabs",
  "devices.switch.appsDetail": "See and control apps",
  "devices.switch.filesDetail": "Read files and run commands",
  "menubar.switch.on": "On",
  "menubar.switch.fixedHome": "Always on. Your own agents run here.",
  "menubar.switch.fixed": "Always on",
  "menubar.switch.needsMacos": "On · needs macOS permission",
  "menubar.switch.unavailable": "That switch can’t be changed from here right now.",
  "menubar.switch.conflict": "This changed on another device. The switches show what’s set now.",
  "menubar.stopAll": "Stop everything on this Mac",
  "menubar.stopAll.offline": "Works even while {home} is unreachable.",
  "menubar.stopped": "Stopped everything on this Mac at {time}.",
  "menubar.stopped.waiting":
    "Agents on this Mac are stopped. Checking that this Mac’s Home stopped everything too…",
  "menubar.stopped.waitingOverdue":
    "Agents on this Mac are stopped. Couldn’t confirm yet that this Mac’s Home stopped everything. Still checking.",
  "menubar.stopped.detail":
    "Agents can’t use this Mac until you resume. Your own tabs keep working, and you can still watch this Mac from your phone.",
  "menubar.stopping": "Stopping agents on this Mac…",
  "menubar.stop.unconfirmed": "Couldn’t confirm everything stopped",
  "menubar.stopped.confirmed": "{home} shows this Mac as stopped too.",
  "menubar.resume": "Resume",
  "menubar.stop.unsaved":
    "Opensteer couldn’t save Stop. Agents could start again when Opensteer restarts.",
  "menubar.stop.unread":
    "Opensteer couldn’t read whether you stopped agents on this Mac, so they stay stopped. Press Resume to let them use this Mac again.",
  "menubar.resume.unsaved": "Opensteer couldn’t save Resume, so agents stay stopped. Try again.",
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
