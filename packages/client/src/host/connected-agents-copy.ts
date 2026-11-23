import type { ThreadAccessMode } from "@opensteer/core";
import { agentConnectionVerificationChangedMessage } from "@opensteer/protocol";

/**
 * Every word Connected agents and agent consent show, by stable id. Web, desktop and
 * mobile all read these, so they say exactly the same thing; this module is the source.
 * `{name}` marks a value filled in by `agentWords`.
 */
export const connectedAgentsCopy = {
  "agents.settings.label": "Connected agents",
  "agents.settings.description": "ChatGPT, Claude and other agents you let use Opensteer",
  "agents.lead":
    "Connect Opensteer to ChatGPT, Claude and other agents, so they can get things done for you. You choose what each can use.",
  "agents.section.connected": "Connected",
  "agents.section.disconnected": "Disconnected",
  "agents.section.add": "Add an agent",
  "agents.row.summary": "{summary} · {mode}",
  "agents.row.everything": "Everything",
  "agents.row.nothing": "Nothing chosen",
  "agents.row.tasks": "Tasks",
  "agents.row.profile": "{profile} profile",
  "agents.row.someProfile": "A browser profile",
  "agents.row.apps": "{count} apps",
  "agents.row.app": "1 app",
  "agents.row.plugins": "{count} plugins",
  "agents.row.plugin": "1 plugin",
  "agents.row.more": "+{count}",
  "agents.row.stopping": "Stopping…",
  "agents.row.stopped": "Disconnected",
  "agents.row.expired": "Expired",
  "agents.row.uncertain": "Check its last action",
  "agents.reachNote": "Agents reach Opensteer from anywhere while {home} is on and awake.",
  "agents.unreadable": "Couldn’t load your connected agents.",
  "agents.add.connected": "{agent} is connected.",
  "agents.add.step3":
    "Approve the request in Opensteer when {name} asks. You’ll choose what it can use.",
  "remoteAccess.turnOnFirst.title": "Turn on Remote access first",
  "remoteAccess.turnOnFirst.detail": "Cloud agents reach Opensteer through it.",
  "remoteAccess.turnOnFirst.action": "Turn on",
  "remoteAccess.unreadable": "Couldn’t check Remote access",

  "consent.origin.destination": "Access goes to {origin}. Anyone who runs that service gets it.",
  "consent.origin.localDestination":
    "Access goes to an app on the device that started this sign-in.",
  "consent.scope.title": "What it can use",
  "consent.scope.selected.label": "Choose what it can use",
  "consent.scope.selected.detail": "Only what you pick below.",
  "consent.scope.everything.label": "Everything my own agents can do",
  "consent.scope.everything.detail":
    "Every browser profile, app, plugin and device, and Tasks. For an agent you trust as much as yourself.",
  "consent.scope.everything.settingsNote": "Changing your settings also needs Full access.",
  "consent.scope.nothingChosen":
    "{agent} can connect, but can’t use anything until you choose something.",
  "consent.browser.title": "Browser",
  "consent.browser.none": "None",
  "consent.browser.newProfile": "New dedicated profile",
  "consent.browser.newProfile.badge": "Recommended",
  "consent.browser.newProfile.detail": "Starts signed out. Sign in only to what it needs.",
  "consent.browser.newProfile.summary": "On {device} · starts signed out",
  "consent.browser.newProfile.summaryAnywhere": "Starts signed out",
  "consent.browser.existing.summary": "Signed in to the sites you use there",
  "consent.browser.keepOn": "Keep it on",
  "consent.browser.shareWarning":
    "{agent} can use every site you’re signed in to in {profile}, as you. A new profile starts signed out.",
  "consent.browser.pickerFooter":
    "{agent} gets full control of each profile you pick, including every site signed in there. It can’t open your saved passwords or cards. When it needs one, it asks you and Opensteer fills it in; once filled, the page and the agent can read it. A page it works in can replace what is on the clipboard.",
  "consent.browser.device.online": "{device} · Online",
  "consent.browser.device.offline": "{device} · Offline",
  "consent.browser.device.unknown": "Not opened on a device yet",
  "consent.chromeTabs.label": "Tabs you share from Chrome on {device}",
  "consent.chromeTabs.detail":
    "It can act in a tab only while you share it from Chrome’s toolbar. In that tab it can navigate anywhere, use sites that Chrome is signed in to and read that tab’s own cookies. In this tab it can use what you already allowed the site in Chrome, such as the camera, microphone, location and notifications.",
  "consent.chromeTabs.repair": "To share tabs with a connected agent, pair Chrome again.",
  "consent.chromeTabs.repairOn": "To share tabs from Chrome on {device}, pair it again.",
  "consent.chromeTabs.repairOnMultiple":
    "To share tabs from Chrome on {devices}, pair Chrome again on each device.",
  "agents.row.chromeTabs": "Shared Chrome tabs",
  "consent.apps.title": "Apps and phone screens",
  "consent.apps.none": "None",
  "consent.apps.phoneThrough": "through {device}",
  "consent.apps.footer":
    "Only apps you’ve already approved on a device are listed. {agent} sees and controls each one you turn on as you would, so it can paste what’s on that device’s clipboard.",
  "consent.plugins.title": "Plugins and data",
  "consent.plugins.none": "None",
  "consent.plugins.off": "Off",
  "consent.plugins.read": "Read",
  "consent.plugins.readWrite": "Read and write",
  "consent.plugins.summaryRead": "{plugin} (read)",
  "consent.plugins.summaryReadWrite": "{plugin} (read and write)",
  "consent.plugins.footer":
    "Read lets it look things up. Read and write lets it change them; Supervised still asks first.",
  "consent.plugins.more": "Only your first plugins are listed here.",
  "consent.tasks.title": "Tasks",
  "consent.tasks.detail":
    "Lets it ask your own agents to work on {home}: read and change files and run commands there.",
  "consent.tasks.warning":
    "This is the most powerful choice. Work it starts can change anything on {home} that your own agents can, inside the safety mode below. Opensteer can stop what happens next, but can’t undo what an agent already did.",
  "consent.safety.title": "Safety mode",
  "consent.name.title": "Name",
  "consent.name.placeholder": "Connection name",
  "consent.finePrint":
    "{agent} can’t approve its own requests, open your saved passwords or cards, or change your settings. It lasts 30 days. Disconnect it any time in Settings → Connected agents.",
  "consent.legacyFinePrint":
    "It can’t approve requests, open your saved passwords or give anyone access. This lasts 30 days, and you can remove it any time in Settings → Connected agents.",
  "consent.allow": "Allow",
  "consent.allowing": "Allowing…",
  "consent.deny": "Deny",
  "consent.denying": "Denying…",
  "consent.choose": "Choose",
  "consent.hide": "Hide",
  "consent.loading": "Loading connection request…",
  "consent.missing": "This connection request is missing. Start again from the agent.",
  "consent.allowed.title": "Connected agent added",
  "consent.allowed.detail": "Go back to the agent to continue.",
  "consent.error.verificationChanged": agentConnectionVerificationChangedMessage,
  "consent.error.approve": "The connection couldn’t be approved. Try again.",
  "consent.error.deny": "The request couldn’t be denied. Try again.",
  "consent.error.approveUnknown": "Couldn’t confirm the connection was approved.",
  "consent.error.denyUnknown": "Couldn’t confirm the request was denied.",
  "consent.error.newProfile": "The new profile couldn’t be created. Try again.",
  "consent.edge.expired.title": "This request expired",
  "consent.edge.expired.detail": "Start connecting again from {agent}.",
  "consent.edge.expired.detailUnnamed": "Start connecting again from the agent.",
  "consent.edge.answered.title": "Already answered",
  "consent.edge.answered.detail": "You answered this on another device.",
  "consent.edge.failed.title": "Can’t review this request",
  "consent.edge.failed.detail": "Check your connection and try again.",
  "consent.edge.noDeviceOnline":
    "None of your devices are online. {agent} can use its profile once {device} is back.",
  "consent.edge.noBrowser.title": "Turn on Browser on a device first",
  "consent.edge.noApps.title": "No apps approved yet",
  "consent.edge.noApps.detail": "Approve an app on a device, then add it here.",
  "consent.edge.noPlugins": "No plugins installed.",
  "consent.edge.openDevices": "Open Devices",
  "consent.edge.listFailed": "Couldn’t load this list.",
  "consent.launch.title": "Review the agent in Opensteer",
  "consent.launch.lead":
    "Open the Opensteer app on this {device} to choose what the agent can do. This link carries no sign-in and approves nothing.",
  "consent.launch.open": "Open Opensteer",
  "consent.launch.qr": "Or scan with your phone to review it there.",
  "consent.launch.qrLabel": "Code that opens this request in Opensteer on your phone",
  "consent.launch.invalid": "This connection request is invalid. Start again from the agent.",
  "common.close": "Close",
  "common.loading": "Loading…",
  "common.tryAgain": "Try again",
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.saving": "Saving…",

  "agent.status.working": "Working now",
  "agent.status.idle": "Not doing anything",
  "agent.status.idleDetail": "Last used {time}.",
  "agent.status.unused": "Not used yet.",
  "agent.watch": "Watch",
  "agent.canUse.title": "Can use",
  "agent.canUse.selected": "Chosen by you",
  "agent.canUse.everything": "Everything my own agents can do",
  "agent.narrow.title": "Limit {agent} to what you choose?",
  "agent.narrow.body": "It stops being able to use anything you don’t pick.",
  "agent.narrow.confirm": "Limit",
  "agent.conflict": "This changed on another device. Showing what’s set now.",
  "agent.saved": "Saved. {agent} uses this from its next action.",
  "agent.activity.title": "Recent activity",
  "agent.activity.unavailable":
    "This Opensteer doesn’t keep a list of what connected agents did yet.",
  "agent.activity.empty": "Nothing yet.",
  "agent.about.title": "About",
  "agent.about.name": "Name",
  "agent.about.says": "Calls itself",
  "agent.about.origin": "Address it uses",
  "agent.about.originUnknown": "Not proven",
  "agent.about.connected": "Connected",
  "agent.about.expires": "Expires",
  "agent.legacy":
    "Update Opensteer on your Home to choose what this agent can use. Until then it can do everything your own agents can.",
  "agent.notFound": "This agent isn’t connected anymore.",
  "agent.back": "Connected agents",
  "agent.disconnect": "Disconnect {agent}",
  "agent.disconnecting": "Disconnecting…",
  "agent.disconnect.title": "Disconnect {agent}?",
  "agent.disconnect.body":
    "It stops right away and can’t use anything again unless you connect it again. Tabs it was using stay open so you can check them.",
  "agent.disconnect.confirm": "Disconnect",

  "disconnect.revoked.label": "{agent} can’t do anything now",
  "disconnect.revoked.detail": "Its access ended at {time}.",
  "disconnect.step.removed": "Access removed",
  "disconnect.step.stopping": "Stopping its work",
  "disconnect.step.stopped": "Stopped",
  "disconnect.stopping.label": "Stopping its work",
  "disconnect.stopping.detailGeneric":
    "Waiting for your devices to confirm its work stopped. {agent} already can’t use anything.",
  "disconnect.stopped.label": "Disconnected",
  "disconnect.stopped.detailRevokedAt":
    "Its access ended at {time}, and everything it was doing has stopped.",
  "disconnect.stopped.remove": "Remove from list",
  "disconnect.stopped.removing": "Removing…",
  "disconnect.expired.label": "Expired",
  "disconnect.expired.detail": "Its access ended {time}. Connect it again from {agent} to use it.",
  "disconnect.uncertain.label": "Check its last action",
  "disconnect.uncertain.detailGeneric":
    "Contact was lost while {agent} was in the middle of something. It may have finished. Check what it was working on before you rely on it.",
} as const;

export type ConnectedAgentsCopyId = keyof typeof connectedAgentsCopy;

/** One string from `connectedAgentsCopy` with its `{values}` filled in. */
export function agentWords(
  id: ConnectedAgentsCopyId,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return connectedAgentsCopy[id].replace(/\{(\w+)\}/gu, (whole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole,
  );
}

/**
 * How the safety mode reads where a connection's mode is chosen. Task composers keep
 * `accessModeOptions`; these say what the mode means for an agent's own direct actions too.
 * Auto-accept edits and Auto behave like Supervised for those: each asks you before a change.
 */
export const connectionModeDescriptions: Readonly<Record<ThreadAccessMode, string>> = {
  "approval-required": "Asks you before anything that changes something.",
  "auto-accept-edits": "Edits files in its tasks without asking. Asks before anything else.",
  auto: "Its tasks run under the engine’s own safety check. Its own direct actions ask you before anything that changes something.",
  "full-access": "Never asks. Only for an agent you trust completely.",
};
