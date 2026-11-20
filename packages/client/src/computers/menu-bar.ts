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
  kind: MenuBarCapabilitySchema,
  actor: z.strictObject({
    label: Text,
    name: z.string().min(1).max(120).nullable(),
    markOrigin: z.string().min(1).max(255).nullable(),
  }),
  using: Text,
  /** This Mac can stop this one thing itself, the way the Home's Stop does. */
  stoppable: z.boolean(),
});
export type MenuBarRow = z.infer<typeof MenuBarRowSchema>;

export const MenuBarStatusSchema = z.strictObject({
  schemaVersion: z.literal(2),
  title: Text,
  homes: z.array(MenuBarHomeLineSchema).max(menuBarMaxHomes),
  moreHomes: z.string().min(1).max(40).nullable(),
  noHome: Text.nullable(),
  /** Only when a Home this Mac can read has something; never a zero or a guess. */
  needsYou: z.strictObject({ line: Text, deploymentId: z.string().min(1).max(255) }).nullable(),
  rightNow: z.array(MenuBarRowSchema).max(menuBarMaxRows),
  thisMac: z
    .strictObject({
      deploymentId: z.string().min(1).max(255),
      editable: z.boolean(),
      /** The policy revision these switches show; a change is written against it. */
      revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
      switches: z.array(MenuBarSwitchSchema).max(3),
    })
    .nullable(),
  thisMacNote: Text.nullable(),
  stop: z.strictObject({
    stopped: z.boolean(),
    /** When everything was stopped, as an ISO time; the popover writes it in local time. */
    stoppedAt: z.iso.datetime().nullable(),
    offline: Text.nullable(),
    problem: Text.nullable(),
  }),
  /** What macOS will do at login, and whether this Mac has anything to open for. */
  openAtLogin: z.strictObject({ on: z.boolean(), available: z.boolean() }),
  icon: z.strictObject({ attention: z.boolean(), unreachable: z.boolean(), stopped: z.boolean() }),
});
export type MenuBarStatus = z.infer<typeof MenuBarStatusSchema>;

export const MenuBarSwitchInputSchema = z.strictObject({
  deploymentId: z.string().min(1).max(255),
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
    readonly stopped: boolean;
    readonly stoppedAt: string | null;
    readonly problem: string | null;
  };
  /** This Mac's row in the Home the window shows, once that Home answered. */
  readonly thisMac: ({ readonly deploymentId: string } & MenuBarMachine) | null;
  /** Each Home's Needs you count; null where the Home could not be read. */
  readonly needsYou: ReadonlyMap<string, number | null>;
  /** What this Mac itself knows is using it. */
  readonly local: {
    readonly apps: readonly {
      readonly sessionId: string;
      readonly threadTitle: string | null;
      readonly app: string | null;
    }[];
    readonly tabs: readonly { readonly sessionId: string; readonly profile: boolean }[];
  };
  /** Work a readable Home reports on this Mac; absent when no Home answered. */
  readonly homeWork: {
    readonly runningTasks: readonly string[];
    readonly sessions: readonly { readonly threadId: string; readonly threadTitle: string }[];
  } | null;
  readonly openAtLogin: { readonly on: boolean; readonly available: boolean };
}

export function menuBarStatus(input: MenuBarInput): MenuBarStatus {
  const homes = menuBarHomes(input);
  const shown = homes.slice(0, menuBarMaxHomes);
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
    schemaVersion: 2,
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
      stopped: input.stop.stopped,
      stoppedAt: input.stop.stopped ? input.stop.stoppedAt : null,
      offline: unreachableName
        ? menuBarWords("menubar.stopAll.offline", { home: unreachableName })
        : null,
      problem: input.stop.problem,
    },
    openAtLogin: input.openAtLogin,
    icon: {
      attention: needsYou !== null,
      unreachable: homes.length > 0 && homes.every((home) => !home.reachable),
      stopped: input.stop.stopped,
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
      ...deviceStatus(home, input.stop.stopped),
    });
  }
  return homes;
}

/** The sum across the Homes that answered; nothing at all when none has any, or none answered. */
export function menuBarNeedsYou(input: MenuBarInput): MenuBarStatus["needsYou"] {
  let count = 0;
  let first: string | null = null;
  for (const [deploymentId, value] of input.needsYou) {
    if (!value) continue;
    count += value;
    first ??= deploymentId;
  }
  if (!count || !first) return null;
  return {
    line:
      count === 1
        ? menuBarWords("menubar.needsYouOne")
        : menuBarWords("menubar.needsYou", { count }),
    deploymentId: first,
  };
}

/**
 * Up to three things using this Mac: what the Mac itself holds first, so the
 * rows are right while every Home is unreachable, then what a Home reports.
 */
export function menuBarRightNow(input: MenuBarInput): MenuBarRow[] {
  const agent = { label: menuBarWords("menubar.rightNow.agent"), name: null, markOrigin: null };
  const rows: MenuBarRow[] = [
    ...input.local.apps.map((session): MenuBarRow => ({
      id: `apps:${session.sessionId}`,
      kind: "apps",
      actor: session.threadTitle ? { ...agent, label: session.threadTitle } : agent,
      using: session.app ?? menuBarWords("menubar.rightNow.app"),
      stoppable: true,
    })),
    ...input.local.tabs.map((tab): MenuBarRow => ({
      id: `browser:${tab.sessionId}`,
      kind: "browser",
      actor: agent,
      using: menuBarWords(tab.profile ? "menubar.rightNow.profile" : "menubar.rightNow.tab"),
      stoppable: false,
    })),
  ];
  const seen = new Set<string>();
  for (const session of input.homeWork?.sessions ?? []) {
    if (seen.has(session.threadId)) continue;
    seen.add(session.threadId);
    rows.push({
      id: `files:${session.threadId}`,
      kind: "files",
      actor: {
        label: session.threadTitle.trim() || menuBarWords("menubar.rightNow.task"),
        name: null,
        markOrigin: null,
      },
      using: menuBarWords("menubar.rightNow.files"),
      stoppable: false,
    });
  }
  for (const [index, title] of (input.homeWork?.runningTasks ?? []).entries())
    rows.push({
      id: `files:task:${index}`,
      kind: "files",
      actor: {
        label: title.trim() || menuBarWords("menubar.rightNow.task"),
        name: null,
        markOrigin: null,
      },
      using: menuBarWords("menubar.rightNow.files"),
      stoppable: false,
    });
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

function deviceStatus(
  home: MenuBarInput["deviceHomes"][number],
  stopped: boolean,
): Pick<MenuBarHomeLine, "reachable" | "status" | "tone"> {
  if (stopped)
    return { tone: "off", reachable: true, status: menuBarWords("menubar.status.paused") };
  if (home.signedOut)
    return {
      tone: "attention",
      reachable: false,
      status: menuBarWords("menubar.status.signedOut", { home: home.name }),
    };
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
