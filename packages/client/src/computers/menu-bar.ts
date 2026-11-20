import { z } from "zod";
import type {
  DesktopPersonalDeploymentState,
  DesktopRunnerStateSchema,
  MachineSummary,
} from "@opensteer/protocol";
import { deviceAccessRows, type DeviceCapability } from "./devices.js";

const MenuBarCapabilitySchema = z.enum(["browser", "apps", "files"]);

export const MenuBarSwitchSchema = z.strictObject({
  capability: MenuBarCapabilitySchema,
  label: z.string().min(1).max(40),
  detail: z.string().max(120),
  on: z.boolean(),
  /** Always on, as Devices shows it: the Home's own engines run here. */
  fixed: z.boolean(),
});
export type MenuBarSwitch = z.infer<typeof MenuBarSwitchSchema>;

export const MenuBarHomeSchema = z.strictObject({
  deploymentId: z.string().min(1).max(255),
  /** `home`: this Mac hosts it. `device`: this Mac is one of its Devices. */
  role: z.enum(["home", "device"]),
  tone: z.enum(["ok", "busy", "attention", "off"]),
  line: z.string().min(1).max(240),
  switches: z.array(MenuBarSwitchSchema).max(3),
  /** The Host answered with this Mac's access policy, so a switch can be written. */
  editable: z.boolean(),
  /** The policy revision these switches show; a change is written against it. */
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
});
export type MenuBarHome = z.infer<typeof MenuBarHomeSchema>;

export const MenuBarStatusSchema = z.strictObject({
  schemaVersion: z.literal(1),
  homes: z.array(MenuBarHomeSchema).max(32),
  activity: z.array(z.string().min(1).max(240)).max(8),
  stopped: z.boolean(),
  stopLine: z.string().min(1).max(240),
  /** A Stop or Resume that did not fully take effect, until a retry succeeds. */
  stopProblem: z.string().min(1).max(600).nullable(),
  /** What macOS will do at login, and whether this Mac has anything to open for. */
  openAtLogin: z.strictObject({ on: z.boolean(), available: z.boolean() }),
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

/** What the Opensteer menu bar item's popover can ask of desktop main. */
export interface OpensteerMenuBarBridge {
  status(): Promise<MenuBarStatus>;
  onStatus(listener: (status: MenuBarStatus) => void): () => void;
  setSwitch(input: MenuBarSwitchInput): Promise<void>;
  stop(): Promise<void>;
  resume(): Promise<void>;
  setOpenAtLogin(on: boolean): Promise<void>;
  openApp(): Promise<void>;
  quitCompletely(): Promise<void>;
}

export interface MenuBarMachine {
  readonly machine: MachineSummary | null;
  readonly devicesAvailable: boolean;
}

export interface MenuBarInput {
  readonly hostedHome: {
    readonly deploymentId: string;
    readonly state: DesktopPersonalDeploymentState;
  } | null;
  readonly deviceHomes: readonly {
    readonly deploymentId: string;
    readonly name: string;
    readonly runner: z.infer<typeof DesktopRunnerStateSchema>;
    readonly signedOut: boolean;
  }[];
  /** This Mac's row in each Home, by Deployment; absent until the Host answered. */
  readonly machines: ReadonlyMap<string, MenuBarMachine>;
  /** Tasks whose Run is executing on the Home this Mac hosts. */
  readonly runningTasks: readonly string[];
  readonly local: { readonly appSessions: number; readonly browserTabs: number };
  readonly stopped: boolean;
  readonly stopProblem: string | null;
  readonly openAtLogin: { readonly on: boolean; readonly available: boolean };
}

const switchLabel: Readonly<Record<DeviceCapability, string>> = {
  browser: "Browser",
  apps: "Apps",
  files: "Files and commands",
};
const switchDetail: Readonly<Record<DeviceCapability, string>> = {
  browser: "Open and use tabs on this Mac",
  apps: "See and control apps",
  files: "Read files and run commands",
};

export function menuBarStatus(input: MenuBarInput): MenuBarStatus {
  const homes: MenuBarHome[] = [];
  if (input.hostedHome) {
    const { tone, word } = hostedState(input.hostedHome.state);
    homes.push({
      deploymentId: input.hostedHome.deploymentId,
      role: "home",
      tone,
      line: `This Mac is your Home — ${word}`,
      ...switchesFor(input.machines.get(input.hostedHome.deploymentId)),
    });
  }
  for (const home of input.deviceHomes) {
    if (home.deploymentId === input.hostedHome?.deploymentId) continue;
    homes.push({
      deploymentId: home.deploymentId,
      role: "device",
      ...deviceLine(home, input.stopped),
      ...switchesFor(input.machines.get(home.deploymentId)),
    });
  }
  return MenuBarStatusSchema.parse({
    schemaVersion: 1,
    homes,
    activity: menuBarActivity(input).slice(0, 8),
    stopped: input.stopped,
    stopLine: input.stopped
      ? "Stopped. Agents can’t use this Mac’s apps or tabs, and it’s disconnected as a Device, until you resume."
      : "Stop cuts agents off this Mac’s apps and tabs and disconnects it as a Device.",
    stopProblem: input.stopProblem,
    openAtLogin: input.openAtLogin,
  });
}

/** One line per thing using this Mac right now, most specific first. */
export function menuBarActivity(
  input: Pick<MenuBarInput, "local" | "machines" | "runningTasks">,
): string[] {
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
  return lines.map((line) => (line.length > 240 ? `${line.slice(0, 239)}…` : line));
}

function hostedState(state: DesktopPersonalDeploymentState): {
  readonly tone: MenuBarHome["tone"];
  readonly word: string;
} {
  switch (state) {
    case "ready":
      return { tone: "ok", word: "running" };
    case "checking":
    case "starting":
      return { tone: "busy", word: "starting" };
    case "stopping":
    case "stopped":
      return { tone: "off", word: "stopped" };
    default:
      return { tone: "attention", word: "needs attention" };
  }
}

function deviceLine(
  home: MenuBarInput["deviceHomes"][number],
  stopped: boolean,
): Pick<MenuBarHome, "line" | "tone"> {
  if (home.signedOut) return { tone: "attention", line: `Signed out of ${home.name}` };
  if (stopped) return { tone: "off", line: `${home.name} — stopped on this Mac` };
  if (home.runner === "running") return { tone: "ok", line: `Connected to ${home.name}` };
  if (home.runner === "starting") return { tone: "busy", line: `Connecting to ${home.name}…` };
  return { tone: "busy", line: `Reconnecting to ${home.name}…` };
}

function switchesFor(
  entry: MenuBarMachine | undefined,
): Pick<MenuBarHome, "editable" | "revision" | "switches"> {
  const machine = entry?.machine;
  if (!machine) return { editable: false, revision: null, switches: [] };
  const switches = deviceAccessRows(machine, entry.devicesAvailable).flatMap(
    (row): MenuBarSwitch[] => {
      const label = switchLabel[row.capability];
      if (row.kind === "fixed")
        return [
          {
            capability: row.capability,
            label,
            on: true,
            fixed: true,
            detail: row.reason === "home" ? "Always on. Your agent runs here." : "Always on",
          },
        ];
      if (row.on === null) return [];
      return [
        {
          capability: row.capability,
          label,
          on: row.on,
          fixed: false,
          detail:
            row.on && needsMacos(machine, row.capability)
              ? "On · needs macOS permission"
              : switchDetail[row.capability],
        },
      ];
    },
  );
  return {
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
