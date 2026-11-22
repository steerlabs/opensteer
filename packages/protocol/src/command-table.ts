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
 * - `home`: Home-wide (engines, defaults, devices as such, chats, Remote access); a selected grant
 *   never names it.
 * - `connection`: a connection; a connected agent reaches only its own.
 * - `other-connection`: always another principal's connection (a consent, a settled entry).
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
  /** Its handler needs the person's signed-in session today: every agent asks. */
  readonly personSession?: true;
}

export type CommandResourceKind =
  | "task"
  | "request"
  | "automation"
  | "tabs"
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
  | "chat-account"
  | "home";

/** The thing a command changes, read from its input. `id` is null for a new or Home-wide one. */
export interface CommandResource {
  readonly kind: CommandResourceKind;
  readonly id: string | null;
}

export interface CommandRow<K extends CommandType = CommandType> {
  readonly family: CommandFamily;
  readonly scope: CommandScope;
  readonly step: CommandStep;
  /** Handlers actor-ready in step A that still refuse some connections today. */
  readonly stepFor?: {
    /** Refused to any connection lineage (plugin resources, `plugin-authority.ts`). */
    readonly connections?: "B";
    /** Refused to a selected grant (`admitSettingsCaller` required `everything`). */
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
  /** Top-level input fields only the person types; an agent's command never carries them. */
  readonly secretFields?: readonly string[];
}

export type CommandTable = { readonly [K in CommandType]: CommandRow<K> };

const resource = (kind: CommandResourceKind, id: string | null = null): CommandResource => ({
  kind,
  id,
});
const task = (command: { readonly threadId: string }) => resource("task", command.threadId);
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
    governs: (c) => resource("task", c.parentThreadId ?? null),
  },
  "thread.rename": {
    family: "tasks",
    scope: "task",
    step: "A",
    faces: one("preference"),
    governs: task,
  },
  "thread.icon.set": {
    family: "tasks",
    scope: "task",
    step: "B",
    faces: one("preference"),
    governs: task,
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
    faces: one("widen-self"),
    governs: task,
  },
  "thread.input.steer": {
    family: "tasks",
    scope: "task",
    step: "A",
    faces: one("widen-self"),
    governs: task,
  },
  "thread.input.cancel": {
    family: "tasks",
    scope: "task",
    step: "A",
    faces: one("narrow"),
    governs: task,
  },
  "thread.input.move": {
    family: "tasks",
    scope: "task",
    step: "A",
    faces: one("preference"),
    governs: task,
  },
  "thread.input.lease.take": {
    family: "tasks",
    scope: "task",
    step: "none",
    faces: [personView],
    governs: task,
  },
  "thread.input.lease.renew": {
    family: "tasks",
    scope: "task",
    step: "none",
    faces: [personView],
    governs: task,
  },
  "thread.input.lease.release": {
    family: "tasks",
    scope: "task",
    step: "none",
    faces: [personView],
    governs: task,
  },
  "thread.input.edit": {
    family: "tasks",
    scope: "task",
    step: "B",
    faces: one("widen-self"),
    governs: task,
  },
  "thread.visit": {
    family: "tasks",
    scope: "task",
    step: "none",
    faces: [personView],
    governs: task,
  },
  "thread.done.set": {
    family: "tasks",
    scope: "task",
    step: "A",
    faces: two({ class: "narrow" }, { class: "widen-self" }),
    face: (c) => (c.done ? 0 : 1),
    governs: task,
  },
  "thread.execution.update": {
    family: "tasks",
    scope: "task",
    step: "A",
    faces: one("preference"),
    governs: task,
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
  },
  "node.stop": { family: "tasks", scope: "task", step: "A", faces: one("narrow"), governs: task },
  "assignment.cancel": {
    family: "tasks",
    scope: "task",
    step: "A",
    faces: one("narrow"),
    governs: (c) => resource("request", c.assignmentId),
  },
  "request.respond": {
    family: "tasks",
    scope: "task",
    step: "A",
    // An answer to an agent's question; allowing a permission; declining. The Request decides.
    faces: [
      { class: "widen-self" },
      { class: "approve", step: "none" },
      { class: "narrow", step: "B" },
    ],
    face: stored,
    governs: (c) => resource("request", c.requestId),
  },
  "agent.session.stop": {
    family: "tasks",
    scope: "connection",
    step: "B",
    faces: one("narrow"),
    governs: (c) => resource("agent-session", c.agentSessionId),
  },
  "attachment.upload.create": {
    family: "tasks",
    scope: "home",
    step: "none",
    faces: [personView],
    governs: home("attachments"),
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
    faces: one("preference"),
    governs: home("defaults"),
  },
  "viewer.timeZone.update": {
    family: "settings",
    scope: "home",
    step: "A",
    faces: one("preference"),
    governs: home("time-zone"),
  },
  "viewer.quietTasks.update": {
    family: "settings",
    scope: "home",
    step: "A",
    faces: one("preference"),
    governs: home("quiet-tasks"),
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
    faces: one("widen-self"),
    governs: () => resource("engine"),
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
  },
  "harness.rename": {
    family: "engines",
    scope: "home",
    step: "A",
    faces: one("preference"),
    governs: (c) => resource("engine", c.harnessInstanceId),
  },
  "harness.enabled.set": {
    family: "engines",
    scope: "home",
    step: "A",
    faces: two({ class: "narrow" }, { class: "widen-self" }),
    face: (c) => (c.enabled ? 1 : 0),
    governs: (c) => resource("engine", c.harnessInstanceId),
  },
  "harness.default.set": {
    family: "engines",
    scope: "home",
    step: "A",
    faces: one("preference"),
    governs: (c) => resource("engine", c.harnessInstanceId),
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
    governs: (c) => resource("request", c.setupRequestId),
    secretFields: ["secrets"],
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
    governs: (c) => resource("request", c.requestId),
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
    governs: (c) => resource("local-server", c.pluginId),
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
    governs: (c) => resource("plugin", JSON.stringify(c.target)),
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
    faces: one("widen-other"),
    governs: (c) => resource("connection", c.requestId),
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
  },
  "connection.uncertain.acknowledge": {
    family: "connections",
    scope: "connection",
    step: "none",
    faces: [personView],
    governs: (c) => resource("connection", c.connectionId),
  },

  // Plugins
  "plugins.install": {
    family: "plugins",
    scope: "new",
    step: "A",
    faces: one("widen-self"),
    governs: () => resource("plugin"),
  },
  "plugins.version.activate": {
    family: "plugins",
    scope: "new",
    step: "A",
    faces: one("widen-self"),
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
    faces: two({ class: "widen-self" }, { class: "narrow" }),
    face: (c) => (c.enabled ? 0 : 1),
    governs: (c) => resource("plugin", c.pluginId),
  },
  "plugins.schedule.answer": {
    family: "plugins",
    scope: "nameable",
    step: "none",
    faces: one("approve"),
    governs: (c) => resource("plugin", c.pluginId),
  },
  "plugins.workflow.start": {
    family: "plugins",
    scope: "nameable",
    step: "A",
    stepFor: { connections: "B" },
    faces: one("widen-self"),
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
  },
  "plugin.authorization.return": {
    family: "plugins",
    scope: "nameable",
    step: "none",
    faces: one("secret"),
    governs: (c) => resource("plugin-sign-in", c.attemptId),
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
    secretFields: ["input"],
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
    scope: "home",
    step: "none",
    faces: one("widen-other", { also: "secret" }),
    governs: () => resource("chat-account"),
    secretFields: ["credentials"],
  },
  "channel.connection.credentials.replace": {
    family: "chats",
    scope: "home",
    step: "none",
    faces: one("secret"),
    governs: (c) => resource("chat-account", c.connectionId),
    secretFields: ["credentials"],
  },
  "channel.connection.computer.create": {
    family: "chats",
    scope: "home",
    step: "none",
    faces: one("widen-other"),
    governs: () => resource("chat-account"),
  },
  "channel.connection.status.set": {
    family: "chats",
    scope: "home",
    step: "A",
    // Paused or revoked narrows; connected lets the chat's senders reach the Home again.
    faces: two({ class: "narrow", step: "A" }, { class: "widen-other", step: "none" }),
    face: (c) => (c.status === "connected" ? 1 : 0),
    governs: (c) => resource("chat-account", c.connectionId),
  },
  "channel.chat.create": {
    family: "chats",
    scope: "home",
    step: "none",
    faces: one("widen-other"),
    governs: (c) => resource("chat-account", c.accountId),
  },
  "channel.me.link": {
    family: "chats",
    scope: "home",
    step: "none",
    faces: one("identity"),
    governs: (c) => resource("chat-account", c.accountId),
  },

  // Browser
  "browser.session.start": {
    family: "browser",
    scope: "task",
    step: "B",
    faces: one("widen-self"),
    governs: (c) =>
      resource("browser-profile", "profileId" in c.input ? (c.input.profileId ?? null) : null),
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
    faces: one("narrow"),
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
    faces: one("narrow"),
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
  },
  "browser.password-sign-in.respond": {
    family: "browser",
    scope: "task",
    step: "B",
    faces: one("narrow"),
    governs: (c) => resource("request", c.requestId),
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
    faces: one("widen-self"),
    governs: () => resource("tabs"),
  },
  "tab.close": {
    family: "tabs-apps",
    scope: "task",
    step: "A",
    faces: one("narrow"),
    governs: (c) => resource("tabs", c.tabIds.join(",")),
  },
  "tab.reopen": {
    family: "tabs-apps",
    scope: "task",
    step: "B",
    faces: one("widen-self"),
    governs: (c) => resource("tabs", c.tabId ?? null),
  },
  "tab.activate": {
    family: "tabs-apps",
    scope: "task",
    step: "none",
    faces: [personView],
    governs: (c) => resource("tabs", c.tabId),
  },
  "tab.organize": {
    family: "tabs-apps",
    scope: "task",
    step: "A",
    faces: one("preference"),
    governs: (c) => resource("tabs", c.tabIds.join(",")),
  },
  "tab.group.update": {
    family: "tabs-apps",
    scope: "task",
    step: "A",
    faces: one("preference"),
    governs: (c) => resource("tabs", c.groupId),
  },
  "tab.group.delete": {
    family: "tabs-apps",
    scope: "task",
    step: "B",
    faces: one("preference"),
    governs: (c) => resource("tabs", c.groupId),
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
    faces: one("widen-self"),
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
    faces: one("widen-self"),
    governs: (c) => resource("task", c.input.anchorThreadId),
  },
  "trigger.update": {
    family: "automations",
    scope: "task",
    step: "A",
    faces: one("widen-self"),
    governs: (c) => resource("automation", c.triggerId),
  },
  "trigger.status.set": {
    family: "automations",
    scope: "task",
    step: "A",
    // Pausing narrows; archiving narrows but needs Full access today; resuming widens.
    faces: [{ class: "narrow" }, { class: "narrow", fullAccess: true }, { class: "widen-self" }],
    face: (c) => (c.status === "paused" ? 0 : c.status === "archived" ? 1 : 2),
    governs: (c) => resource("automation", c.triggerId),
  },
  "trigger.run": {
    family: "automations",
    scope: "task",
    step: "A",
    faces: one("widen-self", { fullAccess: true }),
    governs: (c) => resource("automation", c.triggerId),
  },
  "trigger.cancel": {
    family: "automations",
    scope: "task",
    step: "A",
    faces: one("narrow"),
    governs: (c) => resource("automation", c.triggerId),
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
