import { z } from "zod";
import type {
  DesktopPersonalDeploymentState,
  DesktopRunnerStateSchema,
  MachineSummary,
} from "@opensteer/protocol";
import { deviceAccessRows, type DeviceCapability } from "./devices.js";
import { menuBarWords, type MenuBarCopyId } from "./menu-bar-copy.js";

export const menuBarMaxHomes = 3;
export const menuBarMaxRows = 3;

const MenuBarCapabilitySchema = z.enum(["browser", "apps", "files"]);
const MenuBarRowKindSchema = z.enum(["browser", "apps", "files", "task"]);
const Text = z.string().min(1).max(600);

export const MenuBarSwitchSchema = z.strictObject({
  capability: MenuBarCapabilitySchema,
  label: z.string().min(1).max(40),
  detail: z.string().max(120),
  on: z.boolean(),
  /** Always on, as Devices shows it: the Home's own engines run here. */
  fixed: z.boolean(),
});
export type MenuBarSwitch = z.infer<typeof MenuBarSwitchSchema>;

/** One Home this Mac serves or connects to, as two short header lines. */
export const MenuBarHomeLineSchema = z.strictObject({
  deploymentId: z.string().min(1).max(255),
  line: Text,
  status: Text,
  tone: z.enum(["ok", "busy", "attention", "off"]),
  reachable: z.boolean(),
});
export type MenuBarHomeLine = z.infer<typeof MenuBarHomeLineSchema>;

/**
 * One thing using this Mac right now. `actor.label` is what the row shows
 * today; `name` and `markOrigin` stay empty until the Home names the agent.
 */
export const MenuBarRowSchema = z.strictObject({
  id: z.string().min(1).max(300),
  /** What the thing is, from the record it came from: never a label guessed for it. */
  kind: MenuBarRowKindSchema,
  actor: z.strictObject({
    label: Text,
    name: z.string().min(1).max(120).nullable(),
    markOrigin: z.string().min(1).max(255).nullable(),
  }),
  using: Text,
  /** This Mac can stop this one thing itself, the way the Home's Stop does. */
  stoppable: z.boolean(),
  /**
   * A row being stopped stays until its end is confirmed; one whose Stop was
   * not confirmed says so and can be stopped again.
   */
  state: z.enum(["active", "stopping", "failed"]),
});
export type MenuBarRow = z.infer<typeof MenuBarRowSchema>;

/**
 * The person's Stop for this Mac. `stopping` until what was using this Mac is
 * confirmed ended, `stopped` once it is, `failed` when something did not stop
 * or the Stop could not be saved, with `problem` saying what and Stop
 * everything offered again.
 */
export const MenuBarStopPhaseSchema = z.enum(["running", "stopping", "stopped", "failed"]);
export type MenuBarStopPhase = z.infer<typeof MenuBarStopPhaseSchema>;

export const MenuBarStatusSchema = z.strictObject({
  schemaVersion: z.literal(3),
  title: Text,
  homes: z.array(MenuBarHomeLineSchema).max(menuBarMaxHomes),
  moreHomes: z.string().min(1).max(40).nullable(),
  noHome: Text.nullable(),
  /**
   * What the Homes that answered have for the person, partial when one did
   * not answer; a Home that could not be read is never counted as zero.
   */
  needsYou: z
    .strictObject({
      line: Text,
      deploymentId: z.string().min(1).max(255),
      partial: z.boolean(),
    })
    .nullable(),
  rightNow: z.array(MenuBarRowSchema).max(menuBarMaxRows),
  thisMac: z
    .strictObject({
      deploymentId: z.string().min(1).max(255),
      /** The Device these switches belong to; a change is written to it alone. */
      machineId: z.string().min(1).max(255),
      editable: z.boolean(),
      /** The policy revision these switches show; a change is written against it. */
      revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
      switches: z.array(MenuBarSwitchSchema).max(3),
    })
    .nullable(),
  thisMacNote: Text.nullable(),
  stop: z.strictObject({
    phase: MenuBarStopPhaseSchema,
    /** When everything was confirmed stopped, as an ISO time; the popover writes it in local time. */
    stoppedAt: z.iso.datetime().nullable(),
    offline: Text.nullable(),
    problem: Text.nullable(),
    /** The Home the window shows says this Mac is stopped too, once it does. */
    confirmed: Text.nullable(),
  }),
  /** What macOS will do at login, and whether this Mac has anything to open for. */
  openAtLogin: z.strictObject({ on: z.boolean(), available: z.boolean() }),
  icon: z.strictObject({ attention: z.boolean(), unreachable: z.boolean(), stopped: z.boolean() }),
});
export type MenuBarStatus = z.infer<typeof MenuBarStatusSchema>;

export const MenuBarSwitchInputSchema = z.strictObject({
  deploymentId: z.string().min(1).max(255),
  /** The Device whose switch the person flipped. */
  machineId: z.string().min(1).max(255),
  capability: MenuBarCapabilitySchema,
  on: z.boolean(),
  /** The revision the person saw when they flipped it. */
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
export type MenuBarSwitchInput = z.infer<typeof MenuBarSwitchInputSchema>;

export const MenuBarRowStopInputSchema = z.strictObject({ id: z.string().min(1).max(300) });

/** What the Opensteer menu bar item's popover can ask of desktop main. */
export interface OpensteerMenuBarBridge {
  status(): Promise<MenuBarStatus>;
  onStatus(listener: (status: MenuBarStatus) => void): () => void;
  setSwitch(input: MenuBarSwitchInput): Promise<void>;
  stopRow(input: { readonly id: string }): Promise<void>;
  stop(): Promise<void>;
  resume(): Promise<void>;
  setOpenAtLogin(on: boolean): Promise<void>;
  openApp(): Promise<void>;
  openNeedsYou(deploymentId: string): Promise<void>;
  openSettings(): Promise<void>;
  quitCompletely(): Promise<void>;
}

export interface MenuBarMachine {
  readonly machine: MachineSummary | null;
  readonly devicesAvailable: boolean;
}

export interface MenuBarInput {
  readonly hostedHome: {
    readonly deploymentId: string;
    readonly name: string;
    readonly state: DesktopPersonalDeploymentState;
  } | null;
  readonly deviceHomes: readonly {
    readonly deploymentId: string;
    readonly name: string;
    readonly runner: z.infer<typeof DesktopRunnerStateSchema>;
    readonly signedOut: boolean;
  }[];
  readonly stop: {
    readonly phase: MenuBarStopPhase;
    readonly stoppedAt: string | null;
    readonly problem: string | null;
  };
  /** This Mac's row in the Home the window shows, once that Home answered. */
  readonly thisMac: ({ readonly deploymentId: string } & MenuBarMachine) | null;
  /**
   * Each Home's Needs you count once it answered; null where its last read
   * failed. A Home with no entry has not answered yet.
   */
  readonly needsYou: ReadonlyMap<string, number | null>;
  /** What this Mac itself knows is using it. */
  readonly local: {
    readonly apps: readonly {
      readonly sessionId: string;
      readonly threadTitle: string | null;
      readonly app: string | null;
      readonly state?: MenuBarRow["state"];
    }[];
    /** Browser sessions an agent is acting in, one per session. */
    readonly tabs: readonly { readonly sessionId: string; readonly profile: boolean }[];
    /** Runs the Device Runners on this Mac are working on, whatever their Home's reach. */
    readonly runs?: readonly {
      readonly deploymentId: string;
      readonly runId: string;
      readonly engine: string;
      readonly purpose: "task" | "voice" | "background-job";
      readonly state?: MenuBarRow["state"];
    }[];
  };
  /** Typed records a readable Home reports about work on this Mac; null when none answered. */
  readonly homeWork: {
    /** Tasks this Mac's own Home is running here. */
    readonly tasks: readonly {
      readonly threadId: string;
      readonly title: string;
      readonly state?: MenuBarRow["state"];
    }[];
    /** Shells other computers' agents hold open on this Mac. */
    readonly shells: readonly {
      readonly id: string;
      readonly threadTitle: string;
      readonly callerMachineName: string;
    }[];
  } | null;
  readonly openAtLogin: { readonly on: boolean; readonly available: boolean };
}

export function menuBarStatus(input: MenuBarInput): MenuBarStatus {
  const homes = menuBarHomes(input);
  const shown = homes.slice(0, menuBarMaxHomes);
  const stopped = input.stop.phase !== "running";
  const unreachable = homes.find((home) => !home.reachable);
  const unreachableName = unreachable
    ? ((input.hostedHome?.deploymentId === unreachable.deploymentId
        ? input.hostedHome.name
        : input.deviceHomes.find((home) => home.deploymentId === unreachable.deploymentId)?.name) ??
      null)
    : null;
  const needsYou = menuBarNeedsYou(input);
  const thisMac = switchesFor(input.thisMac);
  return MenuBarStatusSchema.parse({
    schemaVersion: 3,
    title: menuBarWords("menubar.title"),
    homes: shown,
    moreHomes:
      homes.length > shown.length
        ? menuBarWords("menubar.moreHomes", { count: homes.length - shown.length })
        : null,
    noHome: homes.length ? null : menuBarWords("menubar.noHome"),
    needsYou,
    rightNow: menuBarRightNow(input),
    thisMac,
    thisMacNote:
      homes.length && (!thisMac || !thisMac.editable)
        ? menuBarWords("menubar.thisMac.unreadable")
        : null,
    stop: {
      phase: input.stop.phase,
      stoppedAt: input.stop.phase === "stopped" ? input.stop.stoppedAt : null,
      offline: unreachableName
        ? menuBarWords("menubar.stopAll.offline", { home: unreachableName })
        : null,
      problem: input.stop.problem,
      confirmed:
        input.stop.phase === "stopped" && input.thisMac?.machine?.agentsStoppedSince
          ? menuBarWords("menubar.stopped.confirmed", {
              home: homeNames(input).get(input.thisMac.deploymentId) ?? "Your Home",
            })
          : null,
    },
    openAtLogin: input.openAtLogin,
    icon: {
      attention: needsYou !== null,
      unreachable: homes.length > 0 && homes.every((home) => !home.reachable),
      stopped,
    },
  });
}

/** Every Home this Mac works for, the one it hosts first. */
export function menuBarHomes(input: MenuBarInput): MenuBarHomeLine[] {
  const homes: MenuBarHomeLine[] = [];
  const hosted = input.hostedHome;
  if (hosted)
    homes.push({
      deploymentId: hosted.deploymentId,
      line: menuBarWords("menubar.home", { home: hosted.name }),
      ...hostedStatus(hosted.state),
    });
  for (const home of input.deviceHomes) {
    if (home.deploymentId === hosted?.deploymentId) continue;
    homes.push({
      deploymentId: home.deploymentId,
      line: menuBarWords("menubar.home", { home: home.name }),
      ...deviceStatus(home, input.stop.phase !== "running", input.needsYou.get(home.deploymentId)),
    });
  }
  return homes;
}

/**
 * The sum across the Homes that answered, said as partial while another has
 * not answered or could not be read; a Home that could not be read is never a
 * zero. Nothing when every Home answered with nothing.
 */
export function menuBarNeedsYou(input: MenuBarInput): MenuBarStatus["needsYou"] {
  const homes = homeNames(input);
  let count = 0;
  let first: string | null = null;
  let unread: string | null = null;
  let partial = false;
  for (const [deploymentId] of homes) {
    const value = input.needsYou.get(deploymentId);
    if (value === undefined || value === null) {
      partial = true;
      if (value === null) unread ??= deploymentId;
      continue;
    }
    if (!value) continue;
    count += value;
    first ??= deploymentId;
  }
  if (count && first)
    return {
      line: partial
        ? menuBarWords("menubar.needsYouPartial", { count })
        : count === 1
          ? menuBarWords("menubar.needsYouOne")
          : menuBarWords("menubar.needsYou", { count }),
      deploymentId: first,
      partial,
    };
  if (!unread) return null;
  return {
    line: menuBarWords("menubar.needsYouUnread", { home: homes.get(unread) ?? "your Home" }),
    deploymentId: unread,
    partial: true,
  };
}

function homeNames(input: MenuBarInput): Map<string, string> {
  const names = new Map<string, string>();
  if (input.hostedHome) names.set(input.hostedHome.deploymentId, input.hostedHome.name);
  for (const home of input.deviceHomes)
    if (!names.has(home.deploymentId)) names.set(home.deploymentId, home.name);
  return names;
}

/**
 * Up to three things using this Mac, each from a record that says what it is:
 * what the Mac itself holds first, so the rows are right while every Home is
 * unreachable, then what a Home reports.
 */
export function menuBarRightNow(input: MenuBarInput): MenuBarRow[] {
  const agent = { label: menuBarWords("menubar.rightNow.agent"), name: null, markOrigin: null };
  const titled = (title: string | null | undefined) =>
    title?.trim() ? { ...agent, label: title.trim() } : agent;
  const rows: MenuBarRow[] = [
    ...input.local.apps.map((session): MenuBarRow => ({
      id: `apps:${session.sessionId}`,
      kind: "apps",
      actor: titled(session.threadTitle),
      using: session.app ?? menuBarWords("menubar.rightNow.app"),
      stoppable: true,
      state: session.state ?? "active",
    })),
    ...input.local.tabs.map((tab): MenuBarRow => ({
      id: `browser:${tab.sessionId}`,
      kind: "browser",
      actor: agent,
      using: menuBarWords(tab.profile ? "menubar.rightNow.profile" : "menubar.rightNow.tab"),
      stoppable: false,
      state: "active",
    })),
    ...(input.local.runs ?? []).map((run): MenuBarRow => ({
      id: `runner:${run.deploymentId}:${run.runId}`,
      kind: "task",
      actor: { label: run.engine, name: null, markOrigin: null },
      using: menuBarWords(
        run.purpose === "background-job"
          ? "menubar.rightNow.backgroundJob"
          : run.purpose === "voice"
            ? "menubar.rightNow.voice"
            : "menubar.rightNow.running",
      ),
      stoppable: true,
      state: run.state ?? "active",
    })),
    ...(input.homeWork?.tasks ?? []).map((task): MenuBarRow => ({
      id: `home:${task.threadId}`,
      kind: "task",
      actor: {
        label: task.title.trim() || menuBarWords("menubar.rightNow.task"),
        name: null,
        markOrigin: null,
      },
      using: menuBarWords("menubar.rightNow.running"),
      stoppable: true,
      state: task.state ?? "active",
    })),
    ...(input.homeWork?.shells ?? []).map((shell): MenuBarRow => ({
      id: `shell:${shell.id}`,
      kind: "files",
      actor: {
        label: shell.threadTitle.trim() || menuBarWords("menubar.rightNow.task"),
        name: null,
        markOrigin: null,
      },
      using: menuBarWords("menubar.rightNow.shell", { machine: shell.callerMachineName }),
      stoppable: false,
      state: "active",
    })),
  ];
  return rows
    .slice(0, menuBarMaxRows)
    .map((row) => ({ ...row, actor: { ...row.actor, label: clip(row.actor.label, 120) } }));
}

/** One line per thing using this Mac, for Quit Opensteer's question. */
export function menuBarActivity(input: {
  readonly machines: ReadonlyMap<string, MenuBarMachine>;
  readonly runningTasks: readonly string[];
  readonly local: { readonly appSessions: number; readonly browserTabs: number };
}): string[] {
  const lines: string[] = [];
  const running = input.runningTasks;
  if (running.length === 1) lines.push(`Running: ${running[0]}`);
  else if (running.length > 1)
    lines.push(`${running.length} tasks running: ${running.slice(0, 2).join(", ")}`);
  const seen = new Set<string>();
  for (const { machine } of input.machines.values())
    for (const session of machine?.access?.activeSessions ?? []) {
      if (seen.has(session.threadId)) continue;
      seen.add(session.threadId);
      lines.push(`“${session.threadTitle || "A task"}” is using this Mac`);
    }
  if (input.local.appSessions > 0) lines.push("An agent is using apps on this Mac");
  if (input.local.browserTabs > 0)
    lines.push(
      input.local.browserTabs === 1
        ? "An agent has a tab open on this Mac"
        : `An agent has ${input.local.browserTabs} tabs open on this Mac`,
    );
  return lines.map((line) => clip(line, 240));
}

function clip(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function hostedStatus(
  state: DesktopPersonalDeploymentState,
): Pick<MenuBarHomeLine, "reachable" | "status" | "tone"> {
  switch (state) {
    case "ready":
      return { tone: "ok", reachable: true, status: menuBarWords("menubar.status.local") };
    case "checking":
    case "starting":
      return {
        tone: "busy",
        reachable: true,
        status: menuBarWords("menubar.status.localStarting"),
      };
    case "stopping":
    case "stopped":
      return {
        tone: "off",
        reachable: false,
        status: menuBarWords("menubar.status.localStopped"),
      };
    default:
      return {
        tone: "attention",
        reachable: false,
        status: menuBarWords("menubar.status.localAttention"),
      };
  }
}

/**
 * A Device Home's line. Whether the Home can be reached does not depend on the
 * person's Stop: while stopped, its last read says it, not the stopped worker.
 */
function deviceStatus(
  home: MenuBarInput["deviceHomes"][number],
  stopped: boolean,
  read: number | null | undefined,
): Pick<MenuBarHomeLine, "reachable" | "status" | "tone"> {
  if (home.signedOut)
    return {
      tone: "attention",
      reachable: false,
      status: menuBarWords("menubar.status.signedOut", { home: home.name }),
    };
  if (stopped)
    return read === null
      ? {
          tone: "attention",
          reachable: false,
          status: menuBarWords("menubar.status.unreachable", { home: home.name }),
        }
      : { tone: "off", reachable: true, status: menuBarWords("menubar.status.paused") };
  if (home.runner === "running")
    return { tone: "ok", reachable: true, status: menuBarWords("menubar.status.connected") };
  if (home.runner === "failed")
    return {
      tone: "attention",
      reachable: false,
      status: menuBarWords("menubar.status.unreachable", { home: home.name }),
    };
  return { tone: "busy", reachable: false, status: menuBarWords("menubar.status.reconnecting") };
}

const switchLabel = {
  browser: "devices.switch.browser",
  apps: "devices.switch.apps",
  files: "devices.switch.files",
} as const satisfies Record<DeviceCapability, MenuBarCopyId>;
const switchDetail = {
  browser: "devices.switch.browserDetail",
  apps: "devices.switch.appsDetail",
  files: "devices.switch.filesDetail",
} as const satisfies Record<DeviceCapability, MenuBarCopyId>;

function switchesFor(entry: MenuBarInput["thisMac"]): MenuBarStatus["thisMac"] {
  const machine = entry?.machine;
  if (!entry || !machine) return null;
  const switches = deviceAccessRows(machine, entry.devicesAvailable).flatMap(
    (row): MenuBarSwitch[] => {
      const label = menuBarWords(switchLabel[row.capability]);
      if (row.kind === "fixed")
        return [
          {
            capability: row.capability,
            label,
            on: true,
            fixed: true,
            detail: menuBarWords(
              row.reason === "home" ? "menubar.switch.fixedHome" : "menubar.switch.fixed",
            ),
          },
        ];
      if (row.on === null) return [];
      return [
        {
          capability: row.capability,
          label,
          on: row.on,
          fixed: false,
          detail: menuBarWords(
            row.on && needsMacos(machine, row.capability)
              ? "menubar.switch.needsMacos"
              : switchDetail[row.capability],
          ),
        },
      ];
    },
  );
  return {
    deploymentId: entry.deploymentId,
    machineId: machine.id,
    editable: machine.access !== null,
    revision: machine.access?.revision ?? null,
    switches,
  };
}

function needsMacos(machine: MachineSummary, capability: DeviceCapability): boolean {
  if (machine.device?.platform !== "macos") return false;
  if (capability === "apps") return machine.computerUse?.state === "permission-required";
  if (capability === "files") return machine.fullDiskAccess === false;
  return false;
}
