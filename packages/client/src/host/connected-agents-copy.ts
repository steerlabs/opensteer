import {
  agentEndedForPersonMessage,
  chatEndedMessage,
  type ThreadAccessMode,
} from "@opensteer/core";
import { agentConnectionVerificationChangedMessage } from "@opensteer/protocol";
import { plainSentence, sentenceWith, type SentencePart } from "./sentence-parts.js";

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
  "agents.row.paused": "Paused · its replies are held until it’s back",
  "agents.row.unknown": "Update Opensteer to see where this stands",
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
    "Lets it ask your own agents to work on {home}: read and change files and run commands there. The tasks it starts work in your Agent home. From Auto-accept edits up, they can change files there without asking you, your own agents’ instructions and skills among them.",
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
  "agent.readFailed": "Couldn’t read your connected agents.",
  "messaging.chats.loading": "Reading this account’s chats…",
  "messaging.chats.readFailed": "Couldn’t read this account’s chats.",
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.saving": "Saving…",

  "agent.status.working": "Working now",
  "agent.status.needsYou": "Needs you",
  "agent.status.idle": "Not doing anything",
  "agent.status.idleDetail": "Last used {time}.",
  "agent.status.unused": "Not used yet.",
  "agent.status.paused": "Paused",
  "agent.status.unknown": "Not known to this app",
  "agent.status.unknownDetail":
    "Your Home says something this version of Opensteer doesn’t know. Update Opensteer to see whether it can still act.",
  "chat.paused.you": "You paused its messaging account.",
  "chat.paused.unknown": "This chat is paused.",
  "chat.paused.attention": "Paused because {account} needs attention.",
  "chat.paused.replies": "Its replies are held to be sent in order when it’s back.",
  "chat.paused.kept":
    "Messages sent while this is paused arrive when it’s back; one sent more than an hour before is answered that it came too late.",
  "chat.paused.lost": "Messages sent while this is paused are not delivered.",
  "chat.paused.resume": "Resume its account in Messaging to go on.",
  "chat.paused.attentionDetail":
    "It says: {detail} Fix that on its messaging account, then check it again.",
  "chat.paused.attentionFix": "Open its messaging account and check it again.",
  "chat.where.title": "Where",
  "chat.where.dm": "Direct messages to {account} on {provider}",
  "chat.where.channel": "{conversation} on {provider}, through {account}",
  "chat.speakers.title": "Who can give it work",
  "chat.speakers.me": "You, as {identity}",
  "chat.speakers.meDetail":
    "Only messages you send as {identity} give this agent work. To use another account, link it on Messaging: the new one replaces this one.",
  "chat.speakers.meNone": "You, once you link your account",
  "chat.speakers.meNoneDetail":
    "No {provider} account is linked as you yet. Link yours on Messaging; until then, nothing sent here gives this agent work.",
  "chat.speakers.anyone": "Anyone who can write in {conversation}",
  "chat.speakers.anyoneDetail":
    "Anyone who can write there can give this agent work. Their tasks run without your personal context, in a folder of their own instead of your Agent home. That folder is not a wall: a task can still reach other files on that computer, as far as its safety mode allows.",
  "chat.speakers.fixed":
    "This is chosen when the chat is added and can’t be changed. To change it, disconnect this chat and add it again.",
  "chat.ended.you": "You disconnected it.",
  "chat.ended.unknown": "This chat has ended.",
  "chat.ended.account": "Its messaging account was disconnected.",
  "chat.ended.computer": "The Mac it used was removed, or can no longer use Messages.",
  "chat.ended.again": "To use it again, add the chat again on Messaging.",
  "chat.unknownReply":
    "1 reply may have been sent. Opensteer couldn’t confirm it arrived, so it won’t send it again.",
  "chat.unknownReplies":
    "{count} replies may have been sent. Opensteer couldn’t confirm they arrived, so it won’t send them again.",
  "chat.tasks.title": "Recent work",
  "chat.tasks.empty": "Nothing yet.",
  "chat.tasks.running": "Running",
  "chat.tasks.done": "Not running",
  "chat.tasks.stop": "Stop",
  "chat.tasks.stopping": "Stopping…",
  "chat.tasks.open": "Open",
  "chat.row": "{where} · {summary}",
  "chat.grant.tasks": "Always on: a chat can only ask your own agents to work.",
  "chat.grant.refused": "This chat can’t use that",
  "messaging.title": "Messaging",
  "messaging.lead":
    "Message your own agents from Slack or iMessage. Each chat is a connected agent: you choose what it can use, and you can stop or disconnect it like any other.",
  "messaging.add": "Add an account",
  "messaging.empty": "No messaging account yet. Add one to message your own agents.",
  "messaging.loading": "Loading your messaging accounts…",
  "messaging.readFailed": "Couldn’t read your messaging accounts.",
  "messaging.status.connected": "Connected",
  "messaging.status.pending": "Connecting",
  "messaging.status.paused": "Paused",
  "messaging.status.needs-attention": "Needs attention",
  "messaging.status.revoked": "Removed",
  "messaging.status.unknown": "Not known to this app",
  "messaging.status.stale": "Not read just now",
  "messaging.pause": "Pause",
  "messaging.resume": "Resume",
  "messaging.check": "Check again",
  "messaging.fix": "Fix setup",
  "messaging.remove": "Remove account",
  "messaging.remove.title": "Remove {account}?",
  "messaging.remove.body":
    "Every chat on it ends, and nothing sent there gives your own agents work again. Replies that may already have been sent can’t be taken back.",
  "messaging.pausedNoteUnknown": "Paused: its chats hold their replies until you resume it.",
  "messaging.pausedNote": "Paused: its chats hold their replies until you resume it. {sent}",
  "messaging.me.title": "You on {provider}",
  "messaging.me.linked": "{identity} is you. Messages from it count as you in your chats.",
  "messaging.me.none": "No {provider} account is linked as you yet.",
  "messaging.me.link": "Link my account",
  "messaging.me.relink": "Link another account",
  "messaging.me.code":
    "Send {code} to {account} in a direct message from your own {provider} account. It works once, until {time}. Nothing is said in the chat; this page shows your account once it’s linked.",
  "messaging.me.replaces": "Linking another account replaces {identity} as you.",
  "messaging.computer.none":
    "No online Mac of yours has Messages turned on yet. Turn it on from that Mac’s Devices page first.",
  "messaging.me.whenFixed":
    "Until this account is fixed, the code can’t link your account: fix its setup first, then send it.",
  "messaging.me.whenResumed": "Once this account is resumed, sending the code links your account.",
  "messaging.chats.title": "Chats",
  "messaging.chats.empty": "No chat on this account yet.",
  "messaging.chats.add": "Add a chat",
  "messaging.chat.where": "Where",
  "messaging.chat.dm": "Direct messages",
  "messaging.chat.channel": "One channel",
  "messaging.chat.channelId": "Channel ID",
  "messaging.chat.channelIdHint": "From the channel’s details in {provider}, such as C0123ABCD.",
  "messaging.chat.channelName": "Channel name",
  "messaging.chat.speakers": "Who can give it work",
  "messaging.chat.me": "Only me",
  "messaging.chat.meDetail": "Messages you send from your linked account.",
  "messaging.chat.anyone": "Anyone in the channel",
  "messaging.chat.anyoneDetail":
    "Anyone who can write there can give this agent work. Their tasks run without your personal context, in a folder of their own instead of your Agent home. That folder is not a wall: a task can still reach other files on that computer, as far as its safety mode allows.",
  "messaging.chat.fixed":
    "This can’t be changed later; to change it, disconnect the chat and add it again.",
  "messaging.chat.grant": "It starts with Tasks only. Choose what else it can use on its page.",
  "messaging.chat.create": "Add chat",
  "messaging.chat.creating": "Adding…",
  "messaging.chat.cancel": "Cancel",
  "messaging.phone.computer": "Add {provider} from Opensteer on the Mac it will use.",
  "messaging.phone":
    "Add a chat from Opensteer on your computer: there you choose where it listens and who can give it work. Here you can see each chat, pause or resume its account, stop its work and disconnect it.",
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
  "agent.about.connected": "Added",
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
    "Confirming with your devices that its work stopped. {agent} already can’t use anything.",
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
  "disconnect.uncertain.device": "It was on {device}.",
} as const;

export type ConnectedAgentsCopyId = keyof typeof connectedAgentsCopy;

type ForbiddenOutsideAgentCopyKey = "agent" | "label" | "name" | "task";
const forbiddenOutsideAgentCopyKeys = new Set<string>(["agent", "label", "name", "task"]);

export type SafeAgentCopyValues = Readonly<Record<string, string | number>> &
  Partial<Record<ForbiddenOutsideAgentCopyKey, never>>;

function formatAgentCopy(
  id: ConnectedAgentsCopyId,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return connectedAgentsCopy[id].replace(/\{(\w+)\}/gu, (whole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : whole,
  );
}

/**
 * One string from `connectedAgentsCopy` for Opensteer's own words and numbers. Outside-name keys
 * (`agent`, `label`, `name`, `task`) are forbidden here: use `agentSentence` or `agentText`.
 */
export function agentWords(id: ConnectedAgentsCopyId, values: SafeAgentCopyValues = {}): string {
  for (const key of Object.keys(values)) {
    if (forbiddenOutsideAgentCopyKeys.has(key)) {
      throw new TypeError(
        `agentWords("${id}") forbids outside-name key "${key}"; use agentSentence instead.`,
      );
    }
  }
  return formatAgentCopy(id, values);
}

/**
 * A copy sentence with values from outside Opensteer in it as parts: each name someone else gave
 * (an agent's, an account's, a conversation's) a `{ name }`, drawn as a name and never as
 * Opensteer's words (`SentenceText`, `phoneSentence`). A value that is Opensteer's own words
 * ("This connected agent") is a plain string, as in any `SentencePart`. `values` are Opensteer's
 * own too (a count, a device's name the person gave on this Home, a provider's label).
 */
export function agentSentence(
  id: ConnectedAgentsCopyId,
  outside: Readonly<Record<string, SentencePart>>,
  values: Readonly<Record<string, string | number>> = {},
): readonly SentencePart[] {
  const words: Record<string, string | number> = { ...values };
  const parts: Record<string, { readonly name: string } | { readonly address: string }> = {};
  for (const [key, part] of Object.entries(outside))
    if (typeof part === "string") words[key] = part;
    else parts[key] = part;
  return sentenceWith(
    (slot) =>
      formatAgentCopy(id, {
        ...words,
        ...Object.fromEntries(Object.keys(parts).map((key) => [key, slot(key)])),
      }),
    parts,
  );
}

/** The same as plain text, for a title, an alert or a label: each name cleaned and quoted. */
export function agentText(
  id: ConnectedAgentsCopyId,
  outside: Readonly<Record<string, SentencePart>>,
  values: Readonly<Record<string, string | number>> = {},
): string {
  return plainSentence(agentSentence(id, outside, values));
}

/**
 * How the safety mode reads where a connection's mode is chosen: for a connected agent, and for
 * a chat that answers only you, whose tasks work in your Agent home. Task composers keep
 * `accessModeOptions`. A safety check is the engine's own, never Opensteer's.
 */
export const connectionModeDescriptions: Readonly<Record<ThreadAccessMode, string>> = {
  "approval-required": "Asks you before anything that changes something.",
  "auto-accept-edits":
    "Its tasks edit files in their own folder without asking, and the engine asks before what it counts as riskier. Its own direct actions ask you before anything that changes something.",
  auto: "Its tasks run under the engine’s own safety check. Its own direct actions ask you before anything that changes something.",
  "full-access":
    "Never asks. It can change anything in your Agent home, and anything else on that computer that your user account can.",
};

/** A chat has no direct actions: what Auto-accept edits means for the tasks it starts. */
const chatAutoAcceptEdits =
  "Edits files in the task’s own folder without asking; the engine asks you before what it counts as riskier.";

/** The same, for a chat that answers only you: its tasks work in your Agent home. */
export const ownerChatModeDescriptions: Readonly<Record<ThreadAccessMode, string>> = {
  "approval-required": connectionModeDescriptions["approval-required"],
  "auto-accept-edits": chatAutoAcceptEdits,
  auto: "Acts without asking whenever the engine’s own safety check allows it, and can change files in your Agent home.",
  "full-access": connectionModeDescriptions["full-access"],
};

/** What a safety mode means for one connection: Opensteer's words, or a sentence with a name. */
export type ConnectionModeDescription = string | readonly SentencePart[];

/**
 * The same, for a chat that anyone in a conversation can give work: what each mode lets the
 * people there have its tasks do. The conversation's name is someone else's, so it is a name
 * part (`SentenceText`, `phoneSentence`), never words of Opensteer's.
 */
export function anyoneChatModeDescriptions(
  conversation: string,
): Readonly<Record<ThreadAccessMode, ConnectionModeDescription>> {
  const name = { name: conversation };
  return {
    "approval-required": connectionModeDescriptions["approval-required"],
    "auto-accept-edits": chatAutoAcceptEdits,
    auto: [
      "People in ",
      name,
      " can have it act without asking you whenever the engine’s own safety check allows it. That can reach files outside its folder.",
    ],
    "full-access": [
      "Never asks. People in ",
      name,
      " can have it do anything on its computer that your user account can.",
    ],
  };
}

/**
 * What a task says when the chat or connected agent that started it has ended: the Home's own
 * refusal (`chatEndedMessage` / `agentEndedForPersonMessage` in `@opensteer/core`).
 */
export function taskOriginEndedMessage(origin: "chat" | "agent"): string {
  return origin === "chat" ? chatEndedMessage : agentEndedForPersonMessage;
}
