import { isLoopbackHostname } from "@opensteer/core";
import { parseHttpEndpointBaseUrl } from "@opensteer/shared/httpEndpoint";
import type { HostApiCommand } from "./host-api.js";

/**
 * What every Home command governs and what it does, as data. One row per command type of
 * `hostApi["commands.dispatch"]`; the mapped type below makes a type without a row, or a row
 * without a type, a compile error. The answer a caller gets is not written here: it is
 * `commandRule` in `@opensteer/database` (resource-access.ts), read from these classes and
 * scopes. `command-table.rows.json` holds the expected answer for every type, face and caller,
 * and `command-table.test.ts` / `command-rule.test.ts` check this file and the rule against it.
 */
export type CommandType = HostApiCommand["type"];
export type Command<K extends CommandType = CommandType> = Extract<
  HostApiCommand,
  { readonly type: K }
>;

/** The groups `opensteer_commands` pages by. */
export const commandFamilies = [
  "tasks",
  "settings",
  "engines",
  "devices",
  "device-apps",
  "home",
  "connections",
  "plugins",
  "chats",
  "browser",
  "tabs-apps",
  "automations",
] as const;
export type CommandFamily = (typeof commandFamilies)[number];

/**
 * What a command does to authority. `narrow` takes authority away or ends something;
 * `widen-self` gives the caller's own work more; `approve` lifts a gate the person set;
 * `widen-other` gives authority to another principal; `person-view` is the person's own screen
 * and device state, never an agent's to change or to ask about.
 */
export const effectClasses = [
  "read",
  "preference",
  "narrow",
  "widen-self",
  "approve",
  "widen-other",
  "destroy",
  "secret",
  "identity",
  "person-view",
] as const;
export type EffectClass = (typeof effectClasses)[number];

/**
 * How the rule reads the resource a command governs:
 * - `task`: work of a task (its inputs, Runs, Requests, tabs, automations). Your own agent below
 *   Full access may change it when it is its own task work; a connection, in its lineage.
 * - `nameable`: something a selected grant can name (a browser profile, a paired Chrome, a device
 *   app approval, a plugin, a local server, a device-data account).
 * - `new`: a new nameable thing; outside any selected grant until the person grants it.
 * - `home`: Home-wide (engines, defaults, devices as such, Remote access); a selected grant never
 *   names it.
 * - `connection`: a connection; a connected agent reaches only its own.
 * - `other-connection`: always another principal's connection (a consent, a settled entry, a chat
 *   account and its chats): never a connected agent's, `everything` included.
 */
export type CommandScope = "task" | "nameable" | "new" | "home" | "connection" | "other-connection";

/**
 * Whether the command's handler takes an agent actor and admits it in its own transaction:
 * `A` today, `B` once its family is converted, `none` for commands no agent runs directly.
 */
export type CommandStep = "A" | "B" | "none";

export interface CommandFace {
  readonly class: EffectClass;
  /** A second class that applies to the same face (a new device also returns a secret). */
  readonly also?: "secret";
  /** Overrides the row's step for this face. */
  readonly step?: CommandStep;
  /** Its handler refuses an agent below Full access today, even on its own task work. */
  readonly fullAccess?: true;
  /**
   * Its handler needs the read-write ceiling today (Full access or Auto): below it, even on its
   * own task work, the person is asked (`effective-grants.ts:125`, the tab tools' check).
   */
  readonly readWrite?: true;
  /** Its handler needs the person's signed-in session today: every agent asks. */
  readonly personSession?: true;
  /**
   * What it starts goes on after the command returns, in the governed thing's lineage. A
   * connection acting on another lineage's thing asks: its Stop and Disconnect would not reach it.
   */
  readonly lineage?: true;
}

export type CommandResourceKind =
  | "task"
  | "request"
  | "automation"
  | "tabs"
  | "tab-group"
  | "assignment"
  | "device-setup"
  | "app"
  | "engine"
  | "device"
  | "device-session"
  | "enrollment"
  | "session"
  | "connection"
  | "agent-session"
  | "browser-profile"
  | "browser-session"
  | "chrome"
  | "plugin"
  | "plugin-account"
  | "plugin-sign-in"
  | "device-app"
  | "device-data"
  | "local-server"
  | "device-plugin"
  | "plugin-setting"
  | "chat-account"
  | "home";

/**
 * The thing a command changes, read from its input and nothing else: stable ids, sorted, no
 * prose, so two commands that change the same thing name it the same way. `id` is null for a new
 * or Home-wide one; `ids` holds a set of them (sorted); `task` is the task the input says the
 * effect happens in; `mode` is the access mode new work asks for.
 */
export interface CommandResource {
  readonly kind: CommandResourceKind;
  readonly id: string | null;
  readonly ids?: readonly string[];
  readonly task?: string;
  readonly mode?: string;
}

/** The resource as one canonical string: the same thing always reads the same. */
export function commandResourceKey(resource: CommandResource): string {
  return JSON.stringify([
    resource.kind,
    resource.id,
    resource.ids ? [...resource.ids].sort() : null,
    resource.task ?? null,
    resource.mode ?? null,
  ]);
}

/** Which existing ask the person already has, when this command is the answer to it. */
export interface CommandAnsweredAsk {
  readonly kind: "request" | "consent" | "device-setup" | "plugin-approval";
  readonly id: string;
}

export interface CommandRow<K extends CommandType = CommandType> {
  readonly family: CommandFamily;
  readonly scope: CommandScope;
  readonly step: CommandStep;
  /** Handlers actor-ready in step A that still refuse some connections today. */
  readonly stepFor?: {
    /** Refused to any connection lineage (plugin resources, `plugin-authority.ts`). */
    readonly connections?: "B";
    /** Refused to a selected grant (the administration identity required `everything`). */
    readonly selected?: "B";
  };
  /** `faces[0]` is the primary class. */
  readonly faces: readonly [CommandFace, ...CommandFace[]];
  /**
   * Which face the input shows. Undefined when only the stored state can tell: then the store
   * decides at commit and the caller is held to the strictest face until it does.
   */
  readonly face?: (command: Command<K>) => number | undefined;
  readonly governs: (command: Command<K>) => CommandResource;
  /**
   * Input paths only the person types (dotted, nested included); an agent's command never
   * carries them, and a stored proposal never holds them.
   */
  readonly secretFields?: readonly string[];
  /**
   * The faces that answer an ask the person already has (a Request, a consent, a setup, a plugin
   * approval) and what they answer. An agent's ask on such a face points at that ask; it never
   * opens another one.
   */
  readonly answersAsk?: {
    readonly faces: readonly number[];
    readonly of: (command: Command<K>) => CommandAnsweredAsk;
  };
  /** Where the person reviews and changes it before approving; null where no screen exists. */
  readonly editor?: CommandEditor | null;
  /**
   * Its handler changes the Home's database alone, in one transaction, with nothing after the
   * commit that can fail: a throw means nothing happened. Absent, it may act outside the Home's
   * database (a Runner, a browser, a device, a provider, files) or after its commit, so a throw
   * leaves its outcome unknown. Each row's reason, with its handler's line, is in the rows file.
   */
  readonly effect?: "database";
}

/** The screen that performs a command, filled in for the person to review. */
export interface CommandEditor {
  readonly screen: string;
}

export type CommandTable = { readonly [K in CommandType]: CommandRow<K> };

const resource = (kind: CommandResourceKind, id: string | null = null): CommandResource => ({
  kind,
  id,
});
const task = (command: { readonly threadId: string }) => resource("task", command.threadId);
const sorted = (ids: readonly string[]) => [...new Set(ids)].sort();
/**
 * Whether an engine account's source fields send its tasks to a server other than the engine's
 * own: a base URL that is not this device's loopback (read the way model servers are), or a
 * Google Cloud project. An address that does not parse is treated as elsewhere.
 */
function sendsTasksElsewhere(config: Readonly<Record<string, string>> | undefined): boolean {
  if (!config) return false;
  if (config.gcpProject !== undefined) return true;
  if (config.baseUrl === undefined) return false;
  const url = parseHttpEndpointBaseUrl(config.baseUrl);
  return url === null || !isLoopbackHostname(url.hostname);
}
const home = (area: string) => () => resource("home", area);
const one = (cls: EffectClass, extra: Omit<CommandFace, "class"> = {}) =>
  [{ class: cls, ...extra }] as const;
const personView = { class: "person-view" } as const;
const two = (first: CommandFace, second: CommandFace) => [first, second] as const;
/** The store's view decides (the stored policy, revision or Request kind). */
const stored = () => undefined;

export const commandTable: CommandTable = {
  // Tasks, inputs, Requests
  "thread.create": {
    family: "tasks",
    scope: "task",
    step: "A",
    faces: one("widen-self"),
    governs: (c) => ({
      ...resource("task", c.parentThreadId ?? null),
      ...(c.accessMode ? { mode: c.accessMode } : {}),
    }),
    effect: "database",
  },
  "thread.rename": {
    family: "tasks",
    scope: "task",
    step: "A",
    faces: one("preference"),
    governs: task,
    effect: "database",
  },
  "thread.icon.set": {
    family: "tasks",
    scope: "task",
    step: "B",
    faces: one("preference"),
    governs: task,
    effect: "database",
  },
  "thread.sendMessage": {
    family: "tasks",
    scope: "task",
    step: "A",
    faces: one("widen-self"),
    governs: task,
  },
  "thread.inputQueue.resume": {
    family: "tasks",
    scope: "task",
    step: "A",
    // The inputs it releases run in the task's lineage, or their own (X11).
    faces: one("widen-self", { lineage: true }),
    governs: task,
    effect: "database",
  },
  "thread.input.steer": {
    family: "tasks",
    scope: "task",
    step: "A",
    // A waiting input steers the running Run, in that Run's lineage (X11).
    faces: one("widen-self", { lineage: true }),
    governs: task,
    effect: "database",
  },
  "thread.input.cancel": {
    family: "tasks",
    scope: "task",
    step: "A",
    faces: one("narrow"),
    governs: task,
    effect: "database",
  },
  "thread.input.move": {
    family: "tasks",
    scope: "task",
    step: "A",
    faces: one("preference"),
    governs: task,
    effect: "database",
  },
  "thread.input.lease.take": {
    family: "tasks",
    scope: "task",
    step: "none",
    faces: [personView],
    governs: task,
    effect: "database",
  },
  "thread.input.lease.renew": {
    family: "tasks",
    scope: "task",
    step: "none",
    faces: [personView],
    governs: task,
    effect: "database",
  },
  "thread.input.lease.release": {
    family: "tasks",
    scope: "task",
    step: "none",
    faces: [personView],
    governs: task,
    effect: "database",
  },
  "thread.input.edit": {
    family: "tasks",
    scope: "task",
    step: "B",
    faces: one("widen-self"),
    governs: task,
    effect: "database",
  },
  "thread.visit": {
    family: "tasks",
    scope: "task",
    step: "none",
    faces: [personView],
    governs: task,
    effect: "database",
  },
  "thread.done.set": {
    family: "tasks",
    scope: "task",
    step: "A",
    faces: two({ class: "narrow" }, { class: "widen-self" }),
    face: (c) => (c.done ? 0 : 1),
    governs: task,
    effect: "database",
  },
  "thread.execution.update": {
    family: "tasks",
    scope: "task",
    step: "A",
    // What engine and model the task's later Runs use, in the task's lineage (X11).
    faces: one("preference", { lineage: true }),
    governs: task,
    effect: "database",
  },
  "thread.access.update": {
    family: "tasks",
    scope: "task",
    step: "B",
    // Lower or equal to the stored mode narrows; higher lifts a gate.
    faces: two({ class: "narrow" }, { class: "approve" }),
    face: stored,
    governs: task,
  },
  "run.interrupt": {
    family: "tasks",
    scope: "task",
    step: "A",
    faces: one("narrow"),
    governs: task,
    effect: "database",
  },
  "node.stop": {
    family: "tasks",
    scope: "task",
    step: "A",
    faces: one("narrow"),
    governs: task,
    effect: "database",
  },
  "assignment.cancel": {
    family: "tasks",
    scope: "task",
    step: "A",
    faces: one("narrow"),
    governs: (c) => resource("assignment", c.assignmentId),
    effect: "database",
  },
  "request.respond": {
    family: "tasks",
    scope: "task",
    step: "A",
    // An answer to an agent's question; allowing a permission; declining. The Request decides.
    faces: [
      // Answering lets the Run that asked go on, in its own lineage (X11).
      { class: "widen-self", lineage: true },
      { class: "approve", step: "none" },
      { class: "narrow", step: "B" },
    ],
    face: stored,
    governs: (c) => resource("request", c.requestId),
    answersAsk: { faces: [1], of: (c) => ({ kind: "request", id: c.requestId }) },
  },
  "request.command.approve": {
    family: "tasks",
    scope: "task",
    step: "none",
    // The person's own approval of an agent's proposal: an agent sending it asks about an ask.
    faces: one("approve"),
    governs: (c) => resource("request", c.requestId),
    answersAsk: { faces: [0], of: (c) => ({ kind: "request", id: c.requestId }) },
    editor: null,
  },
  "agent.session.stop": {
    family: "tasks",
    scope: "connection",
    step: "B",
    faces: one("narrow"),
    governs: (c) => ({ ...resource("agent-session", c.agentSessionId), task: c.threadId }),
  },
  "attachment.upload.create": {
    family: "tasks",
    scope: "home",
    step: "none",
    faces: [personView],
    governs: home("attachments"),
    effect: "database",
  },
  "attachment.upload.discard": {
    family: "tasks",
    scope: "home",
    step: "none",
    faces: [personView],
    governs: home("attachments"),
  },

  // Settings and defaults
  "execution.preferences.remember": {
    family: "settings",
    scope: "home",
    step: "A",
    // Raising the mode new tasks start in lifts a gate the person set; only the stored default
    // says whether it rises.
    faces: two({ class: "preference" }, { class: "approve", step: "none" }),
    face: (c) =>
      c.accessMode === undefined || c.accessMode === "approval-required" ? 0 : undefined,
    governs: home("defaults"),
    effect: "database",
  },
  "viewer.timeZone.update": {
    family: "settings",
    scope: "home",
    step: "A",
    faces: one("preference"),
    governs: home("time-zone"),
    effect: "database",
  },
  "viewer.quietTasks.update": {
    family: "settings",
    scope: "home",
    step: "A",
    faces: one("preference"),
    governs: home("quiet-tasks"),
    effect: "database",
  },
  "viewer.name.update": {
    family: "settings",
    scope: "home",
    step: "none",
    faces: one("identity"),
    governs: home("name"),
  },
  "settings.idleCompaction.set": {
    family: "settings",
    scope: "home",
    step: "B",
    faces: one("preference"),
    governs: home("idle-compaction"),
  },
  "notification.preview.register": {
    family: "settings",
    scope: "home",
    step: "none",
    faces: [personView],
    governs: home("notification-key"),
  },

  // Engines
  "harness.create": {
    family: "engines",
    scope: "home",
    step: "B",
    // Where an engine sends a task's conversation is who else receives it: a server other than
    // this device's own (or a Google Cloud project it names) is another principal.
    faces: two({ class: "widen-self" }, { class: "widen-other", step: "none" }),
    face: (c) => (sendsTasksElsewhere(c.config) ? 1 : 0),
    governs: () => resource("engine"),
    effect: "database",
  },
  "harness.update": {
    family: "engines",
    scope: "home",
    step: "B",
    faces: one("preference"),
    governs: (c) => resource("engine", c.driverKind),
  },
  "harness.delete": {
    family: "engines",
    scope: "home",
    step: "B",
    faces: one("destroy"),
    governs: (c) => resource("engine", c.harnessInstanceId),
  },
  "harness.model.configure": {
    family: "engines",
    scope: "home",
    step: "A",
    faces: one("preference"),
    governs: (c) => resource("engine", c.harnessInstanceId),
    effect: "database",
  },
  "harness.rename": {
    family: "engines",
    scope: "home",
    step: "A",
    faces: one("preference"),
    governs: (c) => resource("engine", c.harnessInstanceId),
    effect: "database",
  },
  "harness.enabled.set": {
    family: "engines",
    scope: "home",
    step: "A",
    faces: two({ class: "narrow" }, { class: "widen-self" }),
    face: (c) => (c.enabled ? 1 : 0),
    governs: (c) => resource("engine", c.harnessInstanceId),
    effect: "database",
  },
  "harness.default.set": {
    family: "engines",
    scope: "home",
    step: "A",
    faces: one("preference"),
    governs: (c) => resource("engine", c.harnessInstanceId),
    effect: "database",
  },
  "harness.authentication.begin": {
    family: "engines",
    scope: "home",
    step: "none",
    faces: one("secret"),
    governs: (c) => resource("engine", c.harnessInstanceId),
  },
  "harness.authentication.submit": {
    family: "engines",
    scope: "home",
    step: "none",
    faces: one("secret"),
    governs: (c) => resource("engine", c.harnessInstanceId),
    secretFields: ["value"],
  },
  "harness.authentication.cancel": {
    family: "engines",
    scope: "home",
    step: "B",
    faces: one("narrow"),
    governs: (c) => resource("engine", c.harnessInstanceId),
  },
  "harness.authentication.browse": {
    family: "engines",
    scope: "home",
    step: "none",
    faces: one("secret"),
    governs: (c) => resource("engine", c.harnessInstanceId),
  },
  "harness.authentication.logout": {
    family: "engines",
    scope: "home",
    step: "B",
    faces: one("narrow"),
    governs: (c) => resource("engine", c.harnessInstanceId),
  },

  // Devices
  "machine.access.update": {
    family: "devices",
    scope: "home",
    step: "B",
    // Narrow only if no switch goes up against the stored policy.
    faces: two({ class: "narrow" }, { class: "approve" }),
    face: stored,
    governs: (c) => resource("device", "deviceId" in c ? c.deviceId : c.runnerId),
  },
  "machine.rename": {
    family: "devices",
    scope: "home",
    step: "A",
    faces: one("preference"),
    governs: (c) => resource("device", c.machineId),
    effect: "database",
  },
  "machine.revoke": {
    family: "devices",
    scope: "home",
    step: "A",
    faces: one("destroy"),
    governs: (c) => resource("device", c.machineId),
  },
  "machine.access.session.stop": {
    family: "devices",
    scope: "home",
    step: "A",
    faces: one("narrow"),
    governs: (c) => resource("device-session", c.sessionId),
  },
  "machine.session.bind": {
    family: "devices",
    scope: "home",
    step: "none",
    faces: [personView],
    governs: (c) => resource("device", c.machineId),
    effect: "database",
  },
  "iphone.screen.attach": {
    family: "devices",
    scope: "home",
    step: "none",
    faces: one("widen-self", { personSession: true }),
    governs: (c) => resource("device", c.target.kind === "existing" ? c.target.deviceId : null),
  },
  "iphone.screen.detach": {
    family: "devices",
    scope: "home",
    step: "B",
    faces: one("narrow"),
    governs: (c) => resource("device", c.deviceId),
  },
  "computer.view.close": {
    family: "devices",
    scope: "home",
    step: "none",
    faces: [personView],
    governs: home("live-view"),
  },
  "computer.view.renew": {
    family: "devices",
    scope: "home",
    step: "none",
    faces: [personView],
    governs: home("live-view"),
  },
  "runner.enrollment.createLocal": {
    family: "devices",
    scope: "home",
    step: "none",
    faces: one("widen-other", { also: "secret" }),
    governs: () => resource("enrollment"),
  },
  "runner.enrollment.createPhone": {
    family: "devices",
    scope: "home",
    step: "none",
    faces: one("widen-other", { also: "secret" }),
    governs: () => resource("enrollment"),
  },
  "runner.enrollment.retire": {
    family: "devices",
    scope: "home",
    step: "B",
    faces: one("narrow"),
    governs: (c) => resource("enrollment", c.enrollmentId),
    effect: "database",
  },

  // Device apps, approvals, local servers
  "integration.computer.setup.request": {
    family: "device-apps",
    scope: "nameable",
    step: "none",
    faces: one("approve"),
    governs: () => resource("device-app"),
  },
  "integration.computer.setup.respond": {
    family: "device-apps",
    scope: "task",
    step: "B",
    faces: two({ class: "approve", step: "none" }, { class: "narrow" }),
    face: (c) => (c.decision === "allow" ? 0 : 1),
    governs: (c) => resource("device-setup", c.setupRequestId),
    secretFields: ["secrets"],
    answersAsk: { faces: [0], of: (c) => ({ kind: "device-setup", id: c.setupRequestId }) },
  },
  "integration.computer.setup.set": {
    family: "device-apps",
    scope: "nameable",
    step: "none",
    faces: one("approve"),
    governs: () => resource("device-app"),
  },
  "integration.computer.setup.cancel": {
    family: "device-apps",
    scope: "nameable",
    step: "B",
    faces: one("narrow"),
    governs: (c) => resource("device-setup", c.requestId),
  },
  "integration.computer.policy.set": {
    family: "device-apps",
    scope: "home",
    step: "B",
    faces: one("narrow"),
    governs: (c) => resource("device", c.input.runnerId),
  },
  "integration.computer.app.block": {
    family: "device-apps",
    scope: "nameable",
    step: "B",
    faces: one("narrow"),
    governs: (c) => resource("device-app", c.connectionId),
  },
  "integration.grant.create": {
    family: "device-apps",
    scope: "nameable",
    step: "none",
    faces: one("approve"),
    governs: (c) => resource("device-data", c.input.connectionId),
  },
  "integration.grant.revoke": {
    family: "device-apps",
    scope: "nameable",
    step: "A",
    stepFor: { selected: "B" },
    faces: one("narrow"),
    governs: (c) => resource("device-data", c.grantId),
  },
  "integration.disconnect": {
    family: "device-apps",
    scope: "nameable",
    step: "A",
    stepFor: { selected: "B" },
    faces: one("narrow"),
    governs: (c) => resource("device-app", c.connectionId),
  },
  "plugin.remove": {
    family: "device-apps",
    scope: "nameable",
    step: "A",
    faces: one("destroy"),
    governs: (c) => resource("device-plugin", c.pluginId),
  },
  "integration.server.secrets.set": {
    family: "device-apps",
    scope: "nameable",
    step: "none",
    faces: one("secret"),
    governs: (c) => resource("local-server", c.serverId),
    secretFields: ["secrets"],
  },
  "settings.plugin.enabled.set": {
    family: "device-apps",
    scope: "nameable",
    step: "B",
    faces: two({ class: "narrow" }, { class: "approve" }),
    face: (c) => (c.enabled ? 1 : 0),
    governs: (c) =>
      resource(
        "plugin-setting",
        c.target.kind === "device-app"
          ? `device-app:${c.target.definitionId}`
          : c.target.kind === "plugin"
            ? `plugin:${c.target.pluginId}`
            : `skill:${c.target.fullName}`,
      ),
  },

  // Remote access, account link, sign-ins
  "personal.remoteAccess.request": {
    family: "home",
    scope: "home",
    step: "B",
    faces: two({ class: "widen-other", step: "none" }, { class: "narrow" }),
    // Turning it off or unlinking narrows; anything else may open the Home to another client.
    face: (c) =>
      c.intent.action === "unlink" || (c.intent.action === "configure" && c.intent.mode === "off")
        ? 1
        : 0,
    governs: home("remote-access"),
  },
  "personal.remoteAccess.pairing.create": {
    family: "home",
    scope: "home",
    step: "none",
    faces: one("widen-other", { also: "secret" }),
    governs: home("remote-access"),
  },
  "personal.accountLink.approve": {
    family: "home",
    scope: "home",
    step: "none",
    faces: one("identity"),
    governs: home("account-link"),
  },
  "personal.accountLink.complete": {
    family: "home",
    scope: "home",
    step: "none",
    faces: one("identity"),
    governs: home("account-link"),
  },
  "personal.accountLink.resume": {
    family: "home",
    scope: "home",
    step: "none",
    faces: one("identity"),
    governs: home("account-link"),
  },
  "personal.accountLink.unlink": {
    family: "home",
    scope: "home",
    step: "none",
    faces: one("identity"),
    governs: home("account-link"),
  },
  "session.revoke": {
    family: "home",
    scope: "home",
    step: "B",
    faces: one("narrow"),
    governs: (c) => resource("session", c.sessionId),
  },

  // Connected agents
  "connection.authorize": {
    family: "connections",
    scope: "other-connection",
    step: "none",
    // Approving a consent gives an agent authority; denying it ends the ask.
    faces: two({ class: "widen-other" }, { class: "narrow" }),
    face: (c) => (c.decision.kind === "deny" ? 1 : 0),
    governs: (c) => resource("connection", c.requestId),
    answersAsk: { faces: [0], of: (c) => ({ kind: "consent", id: c.requestId }) },
  },
  "connection.update": {
    family: "connections",
    scope: "connection",
    step: "B",
    // Narrow when the store finds the grant a subset and the mode no higher (its `narrowed`).
    faces: two({ class: "narrow" }, { class: "widen-other", step: "none" }),
    face: stored,
    governs: (c) => resource("connection", c.connectionId),
  },
  "connection.revoke": {
    family: "connections",
    scope: "connection",
    step: "B",
    faces: one("narrow"),
    governs: (c) => resource("connection", c.connectionId),
  },
  "connection.remove": {
    family: "connections",
    scope: "other-connection",
    step: "B",
    faces: one("preference"),
    governs: (c) => resource("connection", c.connectionId),
    effect: "database",
  },
  "connection.uncertain.acknowledge": {
    family: "connections",
    scope: "connection",
    step: "none",
    faces: [personView],
    governs: (c) => resource("connection", c.connectionId),
    effect: "database",
  },

  // Plugins
  "plugins.install": {
    family: "plugins",
    scope: "new",
    step: "A",
    // Its code runs later wherever the plugin is used, in no connection's lineage (X11).
    faces: one("widen-self", { lineage: true }),
    governs: () => resource("plugin"),
  },
  "plugins.version.activate": {
    family: "plugins",
    scope: "new",
    step: "A",
    // What the plugin's schedules and workflows run from now on (X11).
    faces: one("widen-self", { lineage: true }),
    governs: (c) => resource("plugin", c.pluginId),
  },
  "plugins.remove": {
    family: "plugins",
    scope: "nameable",
    step: "A",
    faces: one("destroy"),
    governs: (c) => resource("plugin", c.pluginId),
  },
  "plugins.access.set": {
    family: "plugins",
    scope: "nameable",
    step: "B",
    // Lower than the stored access narrows; higher lifts a gate.
    faces: two({ class: "narrow" }, { class: "approve", step: "none" }),
    face: (c) => (c.access === "off" ? 0 : undefined),
    governs: (c) => resource("plugin", c.pluginId),
  },
  "plugins.account.create": {
    family: "plugins",
    scope: "nameable",
    step: "none",
    faces: one("secret"),
    governs: () => resource("plugin-account"),
    secretFields: ["fields"],
  },
  "plugins.account.remove": {
    family: "plugins",
    scope: "nameable",
    step: "B",
    faces: one("narrow"),
    governs: (c) => resource("plugin-account", c.accountId),
  },
  "plugins.account.link": {
    family: "plugins",
    scope: "nameable",
    step: "none",
    faces: one("approve"),
    governs: (c) => resource("plugin", c.pluginId),
  },
  "plugins.account.unlink": {
    family: "plugins",
    scope: "nameable",
    step: "B",
    faces: one("narrow"),
    governs: (c) => resource("plugin", c.pluginId),
  },
  "plugins.schedule.configure": {
    family: "plugins",
    scope: "nameable",
    step: "A",
    stepFor: { connections: "B" },
    // Approval set to automatic lifts the browser approval the person would otherwise give.
    faces: [{ class: "widen-self" }, { class: "narrow" }, { class: "approve", step: "none" }],
    // Left out, an enabled schedule takes the default the store applies, which on the person's own
    // path is automatic: only an explicit browser approval keeps it from approving itself.
    face: (c) =>
      c.approvalMode === "automatic" || (c.enabled && c.approvalMode === undefined)
        ? 2
        : c.enabled
          ? 0
          : 1,
    governs: (c) => resource("plugin", c.pluginId),
  },
  "plugins.schedule.answer": {
    family: "plugins",
    scope: "nameable",
    step: "none",
    faces: two({ class: "approve" }, { class: "narrow" }),
    face: (c) => (c.action === "decline" ? 1 : 0),
    governs: (c) => resource("plugin", c.pluginId),
    answersAsk: {
      faces: [0],
      of: (c) => ({ kind: "plugin-approval", id: `${c.pluginId}:${c.runId}` }),
    },
  },
  "plugins.workflow.start": {
    family: "plugins",
    scope: "nameable",
    step: "A",
    stepFor: { connections: "B" },
    // The workflow run goes on in the plugin engine, as the person's (X11).
    faces: one("widen-self", { lineage: true }),
    governs: (c) => resource("plugin", c.pluginId),
  },
  "plugins.workflow.stop": {
    family: "plugins",
    scope: "nameable",
    step: "A",
    stepFor: { connections: "B" },
    faces: one("narrow"),
    governs: (c) => resource("plugin", c.pluginId),
  },
  "plugins.webhook.remove": {
    family: "plugins",
    scope: "nameable",
    step: "A",
    stepFor: { connections: "B" },
    faces: one("narrow"),
    governs: (c) => resource("plugin", c.pluginId),
  },
  "plugins.webhook.removal.confirm": {
    family: "plugins",
    scope: "nameable",
    step: "B",
    faces: one("narrow"),
    governs: (c) => resource("plugin", c.pluginId),
  },
  "plugins.webhook.setup.complete": {
    family: "plugins",
    scope: "nameable",
    step: "B",
    faces: one("widen-self"),
    governs: (c) => resource("plugin", c.pluginId),
    // The signing secret the person copies from the provider.
    secretFields: ["secret"],
  },
  "plugin.authorization.prepare": {
    family: "plugins",
    scope: "nameable",
    step: "none",
    faces: one("secret"),
    governs: (c) => resource("plugin", c.input.plugin),
  },
  "plugin.authorization.begin": {
    family: "plugins",
    scope: "nameable",
    step: "none",
    faces: one("secret"),
    governs: () => resource("plugin-sign-in"),
    secretFields: ["input.client.clientSecret"],
  },
  "plugin.authorization.return": {
    family: "plugins",
    scope: "nameable",
    step: "none",
    faces: one("secret"),
    governs: (c) => resource("plugin-sign-in", c.attemptId),
    // The proof the provider's redirect handed to the person's browser.
    secretFields: ["returnProof"],
  },
  "plugin.authorization.cancel": {
    family: "plugins",
    scope: "nameable",
    step: "B",
    faces: one("narrow"),
    governs: (c) => resource("plugin-sign-in", c.attemptId),
  },
  "plugin.oauthApp.save": {
    family: "plugins",
    scope: "home",
    step: "none",
    faces: one("secret"),
    governs: home("oauth-apps"),
    secretFields: ["input.clientSecret"],
  },
  "plugin.oauthApp.remove": {
    family: "plugins",
    scope: "home",
    step: "B",
    faces: one("narrow"),
    governs: home("oauth-apps"),
  },

  // Chats
  "channel.connection.create": {
    family: "chats",
    scope: "other-connection",
    step: "none",
    faces: one("widen-other", { also: "secret" }),
    governs: () => resource("chat-account"),
    secretFields: ["credentials"],
  },
  "channel.connection.credentials.replace": {
    family: "chats",
    scope: "other-connection",
    step: "none",
    faces: one("secret"),
    governs: (c) => resource("chat-account", c.connectionId),
    secretFields: ["credentials"],
  },
  "channel.connection.computer.create": {
    family: "chats",
    scope: "other-connection",
    step: "none",
    faces: one("widen-other"),
    governs: () => resource("chat-account"),
  },
  "channel.connection.status.set": {
    family: "chats",
    scope: "other-connection",
    step: "A",
    // Paused or revoked narrows; connected lets the chat's senders reach the Home again.
    faces: two({ class: "narrow", step: "A" }, { class: "widen-other", step: "none" }),
    face: (c) => (c.status === "connected" ? 1 : 0),
    governs: (c) => resource("chat-account", c.connectionId),
  },
  "channel.chat.create": {
    family: "chats",
    scope: "other-connection",
    step: "none",
    faces: one("widen-other"),
    governs: (c) => resource("chat-account", c.accountId),
  },
  "channel.me.link": {
    family: "chats",
    scope: "other-connection",
    step: "none",
    faces: one("identity"),
    governs: (c) => resource("chat-account", c.accountId),
  },

  // Browser
  "browser.session.start": {
    family: "browser",
    scope: "task",
    step: "B",
    // A browser session goes on after it starts, for the task it was started for (X11).
    faces: one("widen-self", { lineage: true }),
    governs: (c) => ({
      ...resource("browser-profile", "profileId" in c.input ? (c.input.profileId ?? null) : null),
      ...(c.input.threadId ? { task: c.input.threadId } : {}),
    }),
  },
  "browser.session.close": {
    family: "browser",
    scope: "task",
    step: "B",
    faces: one("narrow"),
    governs: (c) => resource("browser-session", c.sessionId),
  },
  "browser.profile.create": {
    family: "browser",
    scope: "new",
    step: "B",
    faces: one("widen-self"),
    governs: () => resource("browser-profile"),
  },
  "browser.profile.rename": {
    family: "browser",
    scope: "nameable",
    step: "A",
    stepFor: { selected: "B" },
    faces: one("preference"),
    governs: (c) => resource("browser-profile", c.profileId),
  },
  "browser.profile.delete": {
    family: "browser",
    scope: "nameable",
    step: "A",
    faces: one("destroy"),
    governs: (c) => resource("browser-profile", c.profileId),
  },
  "browser.history.remove": {
    family: "browser",
    scope: "nameable",
    step: "A",
    stepFor: { selected: "B" },
    // Removing for good, as the lead decided: a removed history entry cannot be put back.
    faces: one("destroy"),
    governs: (c) => resource("browser-profile", c.profileId),
  },
  "browser.history.clear": {
    family: "browser",
    scope: "nameable",
    step: "A",
    faces: one("destroy"),
    governs: (c) => resource("browser-profile", c.profileId),
  },
  "browser.site.remove": {
    family: "browser",
    scope: "home",
    step: "A",
    // Removing for good, as the lead decided: a removed site signs the person out and cannot be put back.
    faces: one("destroy"),
    governs: home("chrome-sign-ins"),
  },
  "browser.source.pair": {
    family: "browser",
    scope: "home",
    step: "none",
    faces: one("widen-other", { also: "secret" }),
    governs: () => resource("chrome"),
  },
  "browser.source.rename": {
    family: "browser",
    scope: "nameable",
    step: "B",
    faces: one("preference"),
    governs: (c) => resource("chrome", c.sourceId),
  },
  "browser.source.revoke": {
    family: "browser",
    scope: "nameable",
    step: "B",
    faces: one("narrow"),
    governs: (c) => resource("chrome", c.sourceId),
  },
  "browser.session.sign-in": {
    family: "browser",
    scope: "nameable",
    step: "none",
    faces: one("approve"),
    governs: (c) => resource("chrome", c.sourceId),
  },
  "browser.sign-in.respond": {
    family: "browser",
    scope: "task",
    step: "B",
    faces: two({ class: "approve", step: "none" }, { class: "narrow", step: "B" }),
    face: (c) => (c.decision.decision === "allow" ? 0 : 1),
    governs: (c) => resource("request", c.requestId),
    answersAsk: { faces: [0], of: (c) => ({ kind: "request", id: c.requestId }) },
  },
  "browser.password-sign-in.respond": {
    family: "browser",
    scope: "task",
    step: "B",
    // Releasing a saved login or a card to a page lifts a gate; declining ends the ask.
    faces: two({ class: "approve", step: "none" }, { class: "narrow" }),
    face: (c) => (c.decision.kind === "decline" ? 1 : 0),
    governs: (c) => resource("request", c.requestId),
    answersAsk: { faces: [0], of: (c) => ({ kind: "request", id: c.requestId }) },
  },
  "browser.pool.restart": {
    family: "browser",
    scope: "home",
    step: "B",
    faces: one("destroy"),
    governs: (c) => resource("device", c.runnerId),
  },
  "browser.pool.notice.seen": {
    family: "browser",
    scope: "home",
    step: "none",
    faces: [personView],
    governs: home("notices"),
  },

  // Tabs and apps
  "tab.open": {
    family: "tabs-apps",
    scope: "task",
    step: "A",
    // Today's tab_open refuses below the read-write ceiling (D0a recording, X12).
    faces: one("widen-self", { readWrite: true }),
    governs: (c) =>
      c.target.kind === "page" && "profileId" in c.target
        ? resource("browser-profile", c.target.profileId)
        : resource("tabs"),
  },
  "tab.close": {
    family: "tabs-apps",
    scope: "task",
    step: "A",
    faces: one("narrow"),
    governs: (c) => ({ ...resource("tabs"), ids: sorted(c.tabIds) }),
  },
  "tab.reopen": {
    family: "tabs-apps",
    scope: "task",
    step: "B",
    faces: one("widen-self"),
    governs: (c) => ({ ...resource("tabs"), ...(c.tabId ? { ids: [c.tabId] } : {}) }),
  },
  "tab.activate": {
    family: "tabs-apps",
    scope: "task",
    step: "none",
    faces: [personView],
    governs: (c) => ({ ...resource("tabs"), ids: [c.tabId] }),
  },
  "tab.organize": {
    family: "tabs-apps",
    scope: "task",
    step: "A",
    faces: one("preference"),
    governs: (c) => ({ ...resource("tabs"), ids: sorted(c.tabIds) }),
  },
  "tab.group.update": {
    family: "tabs-apps",
    scope: "task",
    step: "A",
    faces: one("preference"),
    governs: (c) => resource("tab-group", c.groupId),
  },
  "tab.group.delete": {
    family: "tabs-apps",
    scope: "task",
    step: "B",
    faces: one("preference"),
    governs: (c) => resource("tab-group", c.groupId),
  },
  "app.rename": {
    family: "tabs-apps",
    scope: "home",
    step: "B",
    faces: one("preference"),
    governs: (c) => resource("app", c.appId),
  },
  "app.start": {
    family: "tabs-apps",
    scope: "home",
    step: "A",
    // An app server runs on, in no connection's Disconnect set (X11).
    faces: one("widen-self", { lineage: true }),
    governs: (c) => resource("app", c.appId),
  },
  "app.stop": {
    family: "tabs-apps",
    scope: "home",
    step: "A",
    faces: one("narrow"),
    governs: (c) => resource("app", c.appId),
  },
  "app.delete": {
    family: "tabs-apps",
    scope: "home",
    step: "A",
    faces: one("destroy"),
    governs: (c) => resource("app", c.appId),
  },

  // Automations
  "trigger.create": {
    family: "automations",
    scope: "task",
    step: "A",
    // Today's tool requires Full access to create an automation (agent-tools triggers.ts:47).
    // It takes its anchor task's lineage (`trigger-store.ts:2437`), and runs on there (X11).
    faces: one("widen-self", { fullAccess: true, lineage: true }),
    governs: (c) => resource("task", c.input.anchorThreadId),
    effect: "database",
  },
  "trigger.update": {
    family: "automations",
    scope: "task",
    step: "A",
    // Today's tool refuses any change below Full access, a name included (D0a recording). What it
    // will run (its program or its source) goes on in the automation's lineage (X11).
    faces: [
      { class: "widen-self", fullAccess: true },
      { class: "widen-self", fullAccess: true, lineage: true },
    ],
    face: (c) => (c.input.program !== undefined || c.input.source !== undefined ? 1 : 0),
    governs: (c) => resource("automation", c.triggerId),
    effect: "database",
  },
  "trigger.status.set": {
    family: "automations",
    scope: "task",
    step: "A",
    // Pausing narrows; archiving narrows but needs Full access today; resuming widens.
    // Resuming starts the automation again, in its own lineage (X11).
    faces: [
      { class: "narrow" },
      { class: "narrow", fullAccess: true },
      { class: "widen-self", lineage: true },
    ],
    face: (c) => (c.status === "paused" ? 0 : c.status === "archived" ? 1 : 2),
    governs: (c) => resource("automation", c.triggerId),
    effect: "database",
  },
  "trigger.run": {
    family: "automations",
    scope: "task",
    step: "A",
    // The occurrence is recorded as the automation's lineage's (`trigger-store.ts:1879`).
    faces: one("widen-self", { fullAccess: true, lineage: true }),
    governs: (c) => resource("automation", c.triggerId),
    effect: "database",
  },
  "trigger.cancel": {
    family: "automations",
    scope: "task",
    step: "A",
    faces: one("narrow"),
    governs: (c) => resource("automation", c.triggerId),
    effect: "database",
  },
};

export function commandRow<K extends CommandType>(type: K): CommandRow<K> {
  return commandTable[type] as CommandRow<K>;
}

/** The face the input shows, or undefined when only the stored state can decide. */
export function commandFace(command: Command): number | undefined {
  const row = commandRow(command.type) as CommandRow;
  return row.face ? row.face(command) : 0;
}

/** The face's step for one caller: a connection lineage, a selected grant, or neither. */
export function commandFaceStep(
  row: CommandRow,
  face: number,
  caller: { readonly connection: boolean; readonly selected: boolean },
): CommandStep {
  const step = row.faces[face]?.step ?? row.step;
  if (step !== "A") return step;
  if (caller.connection && row.stepFor?.connections) return row.stepFor.connections;
  if (caller.selected && row.stepFor?.selected) return row.stepFor.selected;
  return step;
}

/**
 * Where a command's effect can be: only the Home's database, or possibly beyond it. Unknown is
 * the default: a row says `database` only where its handler was read to do one transaction.
 */
export function commandEffect(row: Pick<CommandRow, "effect">): "database" | "outside" {
  return row.effect ?? "outside";
}

/**
 * What an agent may read of a command's result. A command that hands out a secret or an identity
 * (a device's one-use token, a pairing code, a sign-in link, a chat's link code) returns only its
 * type to an agent: the value is for the person's screen.
 */
export function commandAgentOutput(command: Command, output: unknown): unknown {
  const row = commandRow(command.type) as CommandRow;
  const sensitive = row.faces.some(
    (face) => face.class === "secret" || face.class === "identity" || face.also === "secret",
  );
  return sensitive ? { type: command.type } : output;
}
