import {
  commandTable,
  type Command,
  type CommandEditor,
  type CommandFamily,
  type CommandResource,
  type CommandType,
  type EffectClass,
} from "./command-table.js";

/**
 * What each command is called where an agent lists them and where the person reviews one: plain
 * words, the screen's words, never the agent's. Exhaustive over the table, like the table itself.
 */
export const commandTitles: { readonly [K in CommandType]: string } = {
  "thread.create": "Start a task",
  "thread.rename": "Rename a task",
  "thread.icon.set": "Change a task's icon",
  "thread.sendMessage": "Send a message to a task",
  "thread.inputQueue.resume": "Resume a task's waiting messages",
  "thread.stop.recheck": "Check whether a stopped task has ended",
  "thread.input.steer": "Send a waiting message now",
  "thread.input.cancel": "Cancel a waiting message",
  "thread.input.move": "Reorder a waiting message",
  "thread.input.lease.take": "Edit a waiting message",
  "thread.input.lease.renew": "Keep editing a waiting message",
  "thread.input.lease.release": "Stop editing a waiting message",
  "thread.input.edit": "Change a waiting message",
  "thread.visit": "Mark a task read",
  "thread.done.set": "Mark a task done or not done",
  "thread.execution.update": "Change a task's AI engine or model",
  "thread.access.update": "Change a task's access mode",
  "run.interrupt": "Stop a task's current run",
  "node.stop": "Stop a subagent",
  "assignment.cancel": "Cancel handed-out work",
  "request.respond": "Answer a Request",
  "request.command.approve": "Approve a change an agent proposed",
  "agent.session.stop": "Stop a connected agent's session",
  "attachment.upload.create": "Start an upload",
  "attachment.upload.discard": "Discard an upload",
  "execution.preferences.remember": "Change the defaults for new tasks",
  "viewer.timeZone.update": "Change the time zone",
  "viewer.quietTasks.update": "Change quiet days for tasks",
  "viewer.name.update": "Change your name",
  "settings.idleCompaction.set": "Change idle compaction for Claude",
  "notification.preview.register": "Register this device's notification key",
  "harness.create": "Add an AI engine account",
  "harness.update": "Update an AI engine",
  "harness.delete": "Remove an AI engine account",
  "harness.model.configure": "Change a model's settings",
  "harness.rename": "Rename an AI engine account",
  "harness.enabled.set": "Turn an AI engine account on or off",
  "harness.default.set": "Make an AI engine account the default",
  "harness.authentication.begin": "Sign in to an AI engine account",
  "harness.authentication.submit": "Enter an AI engine sign-in",
  "harness.authentication.cancel": "Cancel an AI engine sign-in",
  "harness.authentication.browse": "Open an AI engine sign-in page",
  "harness.authentication.logout": "Sign out of an AI engine account",
  "machine.access.update": "Change what agents may use on a device",
  "machine.rename": "Rename a device",
  "machine.revoke": "Remove a device",
  "machine.access.session.stop": "End a shell session on a device",
  "machine.session.bind": "Link this sign-in to its device",
  "iphone.screen.attach": "Connect an iPhone screen",
  "iphone.screen.detach": "Disconnect an iPhone screen",
  "computer.view.close": "Close a live view",
  "computer.view.renew": "Keep a live view open",
  "runner.enrollment.createLocal": "Add a computer",
  "runner.enrollment.createPhone": "Add a phone",
  "runner.enrollment.retire": "Cancel adding a device",
  "integration.computer.setup.request": "Ask to set up an app on a device",
  "integration.computer.setup.respond": "Answer an app setup",
  "integration.computer.setup.set": "Approve an app on a device",
  "integration.computer.setup.cancel": "Cancel an app setup",
  "integration.computer.session.stop": "Stop a computer-use session",
  "integration.computer.policy.set": "Ask before agents use new apps on a device",
  "integration.computer.app.block": "Block an app on a device",
  "integration.grant.create": "Let an app use a device's data",
  "integration.grant.revoke": "Stop an app using a device's data",
  "integration.disconnect": "Disconnect a device app",
  "plugin.remove": "Remove a local server",
  "integration.server.secrets.set": "Enter a local server's secrets",
  "settings.plugin.enabled.set": "Turn a plugin, device app or skill on or off",
  "personal.remoteAccess.request": "Change Remote access",
  "personal.remoteAccess.pairing.create": "Make a pairing code",
  "personal.accountLink.approve": "Link this Home to an Opensteer account",
  "personal.accountLink.complete": "Finish linking an Opensteer account",
  "personal.accountLink.resume": "Resume linking an Opensteer account",
  "personal.accountLink.unlink": "Unlink the Opensteer account",
  "session.revoke": "Sign out another device",
  "connection.authorize": "Answer a connected agent's request to connect",
  "connection.update": "Change a connected agent's access",
  "connection.revoke": "Disconnect a connected agent",
  "connection.remove": "Remove a disconnected agent from the list",
  "connection.uncertain.acknowledge": "Mark a connected agent's last action checked",
  "plugins.install": "Install a plugin",
  "plugins.version.activate": "Switch a plugin's version",
  "plugins.remove": "Remove a plugin",
  "plugins.access.set": "Change what agents may do with a plugin",
  "plugins.account.create": "Add a plugin account",
  "plugins.account.remove": "Remove a plugin account",
  "plugins.account.link": "Link an account to a plugin",
  "plugins.account.unlink": "Unlink an account from a plugin",
  "plugins.schedule.configure": "Change a plugin's schedule",
  "plugins.schedule.answer": "Answer a plugin's scheduled run",
  "plugins.workflow.start": "Run a plugin workflow",
  "plugins.workflow.stop": "Stop a plugin workflow",
  "plugins.webhook.remove": "Remove a plugin webhook",
  "plugins.webhook.removal.confirm": "Confirm a webhook was removed at the provider",
  "plugins.webhook.setup.complete": "Confirm a webhook was set up at the provider",
  "plugin.authorization.prepare": "Prepare a plugin sign-in",
  "plugin.authorization.begin": "Sign in to a plugin account",
  "plugin.authorization.return": "Finish a plugin sign-in",
  "plugin.authorization.cancel": "Cancel a plugin sign-in",
  "plugin.oauthApp.save": "Save a custom sign-in app",
  "plugin.oauthApp.remove": "Remove a custom sign-in app",
  "channel.connection.create": "Connect a chat account",
  "channel.connection.credentials.replace": "Replace a chat account's credentials",
  "channel.connection.computer.create": "Connect Messages on a Mac",
  "channel.connection.status.set": "Pause, resume or disconnect a chat account",
  "channel.chat.create": "Start a chat others can write in",
  "channel.me.link": "Link your own chat identity",
  "browser.session.start": "Open a browser",
  "browser.session.close": "Close a browser",
  "browser.session.dismiss": "Dismiss an unconfirmed closed browser",
  "browser.profile.create": "Create a browser profile",
  "browser.profile.rename": "Rename a browser profile",
  "browser.profile.delete": "Delete a browser profile",
  "browser.history.remove": "Remove a page from a profile's history",
  "browser.history.clear": "Clear a profile's history",
  "browser.site.remove": "Remove a site's Chrome sign-in",
  "browser.source.pair": "Pair Chrome",
  "browser.source.rename": "Rename a paired Chrome",
  "browser.source.revoke": "Unpair a Chrome",
  "browser.session.sign-in": "Copy a Chrome sign-in into a browser",
  "browser.sign-in.respond": "Answer a Chrome sign-in Request",
  "browser.password-sign-in.respond": "Answer a saved login or card Request",
  "browser.pool.restart": "Restart a Cloud Computer's browser",
  "browser.pool.notice.seen": "Dismiss a browser notice",
  "tab.open": "Open a tab",
  "tab.close": "Close tabs",
  "tab.reopen": "Reopen a closed tab",
  "tab.activate": "Show a tab",
  "tab.organize": "Arrange tabs",
  "tab.group.update": "Change a tab group",
  "tab.group.delete": "Delete a tab group",
  "tab.group.close": "Close a tab group and its tabs",
  "app.rename": "Rename an app",
  "app.start": "Start an app",
  "app.stop": "Stop an app",
  "app.delete": "Delete an app",
  "trigger.create": "Create an automation",
  "trigger.update": "Change an automation",
  "trigger.status.set": "Pause, resume or archive an automation",
  "trigger.run": "Run an automation now",
  "trigger.cancel": "Cancel an automation's pending runs",
};

/** The screen of each family that performs its commands, on the web, the Mac app and the phone. */
const familyEditors: { readonly [F in CommandFamily]: CommandEditor } = {
  tasks: { screen: "task-settings" },
  settings: { screen: "general-settings" },
  engines: { screen: "ai-engines" },
  devices: { screen: "device-access" },
  "device-apps": { screen: "device-apps" },
  home: { screen: "remote-access" },
  connections: { screen: "connected-agent" },
  plugins: { screen: "plugin" },
  chats: { screen: "messaging" },
  browser: { screen: "browser-profiles" },
  "tabs-apps": { screen: "tabs" },
  automations: { screen: "automation" },
};
/** Commands no existing screen performs: the person confirms them on a plain card. */
const noEditor = new Set<CommandType>([
  "browser.pool.restart",
  "connection.remove",
  "session.revoke",
  "plugins.webhook.removal.confirm",
  "plugins.webhook.setup.complete",
  "runner.enrollment.retire",
  "iphone.screen.attach",
  "iphone.screen.detach",
  "browser.source.pair",
]);
const screenFor: Partial<Record<CommandType, CommandEditor>> = {
  "runner.enrollment.createLocal": { screen: "add-device" },
  "runner.enrollment.createPhone": { screen: "add-device" },
  "browser.source.rename": { screen: "chrome" },
  "browser.source.revoke": { screen: "chrome" },
  "browser.site.remove": { screen: "chrome" },
  "browser.session.sign-in": { screen: "chrome" },
  "personal.accountLink.approve": { screen: "account-link" },
  "personal.accountLink.complete": { screen: "account-link" },
  "personal.accountLink.resume": { screen: "account-link" },
  "personal.accountLink.unlink": { screen: "account-link" },
};

/** Where the person reviews this command, filled in; null where only a plain card can. */
export function commandEditor(type: CommandType): CommandEditor | null {
  const row = commandTable[type];
  if (row.editor !== undefined) return row.editor;
  if (noEditor.has(type)) return null;
  return screenFor[type] ?? familyEditors[row.family];
}

/**
 * The change in the screen's words, from the table and the command's input only: the title, and
 * what it is done to as the Home names it (a task's title, a device's name). Never the agent's.
 */
export function commandSentence(
  command: Command,
  name: (resource: CommandResource) => string | null,
): string {
  const title = commandTitles[command.type];
  const resource = (commandTable[command.type].governs as (c: Command) => CommandResource)(command);
  const named = name(resource);
  return named ? `${title}: ${named}` : title;
}

/** Each title's first word as it reads once done: activity says what an agent did (C5). */
const pastTense: Readonly<Record<string, string>> = {
  Add: "added",
  Answer: "answered",
  Approve: "approved",
  Archive: "archived",
  Arrange: "arranged",
  Ask: "asked",
  Block: "blocked",
  Cancel: "cancelled",
  Change: "changed",
  Check: "checked",
  Clear: "cleared",
  Close: "closed",
  Confirm: "confirmed",
  Connect: "connected",
  Copy: "copied",
  Create: "created",
  Delete: "deleted",
  Discard: "discarded",
  Disconnect: "disconnected",
  Dismiss: "dismissed",
  Edit: "edited",
  End: "ended",
  Enter: "entered",
  Finish: "finished",
  Install: "installed",
  Keep: "kept",
  Let: "let",
  Link: "linked",
  Make: "made",
  Mark: "marked",
  Open: "opened",
  Pair: "paired",
  Pause: "paused",
  Prepare: "prepared",
  Register: "registered",
  Remove: "removed",
  Rename: "renamed",
  Reopen: "reopened",
  Reorder: "reordered",
  Replace: "replaced",
  Restart: "restarted",
  Resume: "resumed",
  Run: "ran",
  Save: "saved",
  Send: "sent",
  Show: "showed",
  Sign: "signed",
  Start: "started",
  Stop: "stopped",
  Switch: "switched",
  Turn: "turned",
  Unlink: "unlinked",
  Unpair: "unpaired",
  Update: "updated",
};

/** A title's words after the first, as they follow a verb: "Rename a task" gives "a task". */
function titleRest(title: string): { readonly verb: string; readonly rest: string } {
  const space = title.indexOf(" ");
  return space < 0
    ? { verb: title, rest: "" }
    : { verb: title.slice(0, space), rest: title.slice(space) };
}

/**
 * A title that names several changes, as the one this command made: one title covers pausing,
 * resuming and disconnecting a chat account, and activity says which.
 */
function chosenTitle(command: CommandWordsInput): string {
  const input = command as {
    readonly status?: string;
    readonly enabled?: boolean;
    readonly done?: boolean;
  };
  switch (command.type) {
    case "channel.connection.status.set":
      return input.status === "paused"
        ? "Pause a chat account"
        : input.status === "revoked"
          ? "Disconnect a chat account"
          : "Resume a chat account";
    case "trigger.status.set":
      return input.status === "paused"
        ? "Pause an automation"
        : input.status === "archived"
          ? "Archive an automation"
          : "Resume an automation";
    case "harness.enabled.set":
      return input.enabled === false
        ? "Turn off an AI engine account"
        : "Turn on an AI engine account";
    case "settings.plugin.enabled.set":
      return input.enabled === false
        ? "Turn off a plugin, device app or skill"
        : "Turn on a plugin, device app or skill";
    case "thread.done.set":
      return input.done === false ? "Mark a task not done" : "Mark a task done";
    default:
      return commandTitles[command.type];
  }
}

/** A command as activity reads it: its type, and whatever input says which change it made. */
export type CommandWordsInput = { readonly type: CommandType } & Readonly<Record<string, unknown>>;

/** What the command did, in the past and lower case: "renamed a task". */
export function commandDoneWords(command: CommandWordsInput): string {
  const { verb, rest } = titleRest(chosenTitle(command));
  return `${pastTense[verb] ?? verb.toLowerCase()}${rest}`;
}

/** What the agent asked for, in its own clause: "asked to rename a task". */
export function commandAskedWords(command: CommandWordsInput): string {
  const { verb, rest } = titleRest(chosenTitle(command));
  return `asked to ${verb.toLowerCase()}${rest}`;
}

/** Whether every title's first word has its past form here: the table's words test it. */
export function commandPastTenseKnown(type: CommandType): boolean {
  return titleRest(chosenTitle({ type })).verb in pastTense;
}

/** The class of a face, from the worst it can do to the least, for the one a card speaks of. */
const severity: readonly EffectClass[] = [
  "identity",
  "secret",
  "widen-other",
  "approve",
  "destroy",
  "widen-self",
  "narrow",
  "preference",
  "read",
  "person-view",
];

/** The face a card speaks of: the one admitted, or the most it could be while only the store can tell. */
export function commandAskedFace(type: CommandType, face: number | undefined): number {
  const faces = commandTable[type].faces;
  if (face !== undefined && faces[face]) return face;
  let worst = 0;
  faces.forEach((candidate, index) => {
    if (severity.indexOf(candidate.class) < severity.indexOf(faces[worst]!.class)) worst = index;
  });
  return worst;
}

/**
 * Where an automation's script would run, and as whom, as the Home read it from the anchor task's
 * device (T4): the parts of one sentence, the device's own name already quoted as an outside name.
 * Nothing about a sandbox: a script runs as that user, with what that user may do.
 */
export interface CommandScriptPlace {
  /** "on your Mac", "on this Cloud Computer", "on this server", "on the computer". */
  readonly where: string;
  /** The device's name, quoted, where it is not the Home's own computer. */
  readonly name: string | null;
  /** "you" on the person's Mac; "its user" elsewhere. */
  readonly as: "you" | "its user";
}

/**
 * What a command gives, and to whom, when it widens something, in the person's words; null when
 * it gives nothing to anyone. From the table and the input only, never the agent's description,
 * and, for a script an automation will run, the place the Home read (`place`).
 */
export function commandGives(
  command: Command,
  face: number,
  place?: CommandScriptPlace | null,
): string | null {
  const shape = commandTable[command.type].faces[face];
  if (!shape) return null;
  const input = command as unknown as Record<string, unknown>;
  switch (command.type) {
    case "connection.update":
      return "It gives this connected agent more than it holds now: more of your things, or a higher access mode.";
    case "channel.chat.create":
      return input.senders === "anyone"
        ? "Anyone in that conversation could ask your agents to work."
        : "You could ask your agents to work from that conversation.";
    case "channel.connection.status.set":
      return "Its chats reach your agents again.";
    case "machine.access.update":
      return "It turns on something agents may use on this device.";
    case "personal.remoteAccess.request":
      return "Your other devices could reach this Home over the internet.";
    case "personal.remoteAccess.pairing.create":
      return "The code lets another device connect to this Home.";
    case "runner.enrollment.createLocal":
    case "runner.enrollment.createPhone":
      return "It adds a device your agents may then use.";
    case "browser.source.pair":
      return "A Chrome could share its tabs with this Home.";
    case "thread.access.update":
      return `Agents in this task would act with ${String(input.accessMode)} access.`;
    case "execution.preferences.remember":
      return `New tasks would start with ${String(input.accessMode)} access.`;
    case "plugins.schedule.configure":
      return "Its scheduled runs would be approved automatically, without asking you.";
    case "plugins.access.set":
      return `Agents could ${input.access === "all" ? "read and change" : "read"} through this plugin.`;
    case "settings.plugin.enabled.set":
      return "Agents could use it again.";
    case "integration.computer.setup.request":
    case "integration.computer.setup.set":
      return "Agents could use this app on that device.";
    case "integration.grant.create":
      return "That app could use this device's data.";
    case "browser.session.sign-in":
      return "Your Chrome sign-in for this site would be copied into a browser your agents use.";
    case "plugins.account.link":
      return "This plugin could act with that account.";
    case "harness.create":
    case "harness.update":
      return shape.class === "widen-other"
        ? "What your tasks say would be sent to that server."
        : null;
    case "trigger.create":
    case "trigger.update":
    case "trigger.run":
      // Only a face that puts a program on the computer (its script, or when it runs).
      if (!shape.lineage || !place) return null;
      return `Its script runs ${place.where}${place.name ? ` ${place.name}` : ""}, as ${place.as}.`;
    default:
  }
  switch (shape.class) {
    case "widen-other":
      return "It gives access to someone other than this agent.";
    case "approve":
      return "It lifts an approval you set.";
    case "secret":
      return "You type the value on this screen; it is not sent to the agent.";
    case "identity":
      return "It concerns who you are or your Opensteer account.";
    default:
      return null;
  }
}
