import { menuBarActivity, type MenuBarMachine } from "@opensteer/client/computers";
import type { DesktopRunnerStateSchema, HostApiClient, MachineSummary } from "@opensteer/protocol";
import type { z } from "zod";
import { hostApiData } from "../connections/desktop-host-api.js";
import type { AgentAdmission } from "./agent-admission.js";

export const homeReadTimeoutMs = 5_000;

export type HomeHost = Pick<
  HostApiClient,
  "attention.get" | "commands.dispatch" | "machines.list" | "personal.shell.get"
>;

export interface HomeRead {
  readonly deploymentId: string;
  /** This Mac's row there; null when the Home lists none for its Runner. */
  readonly machine: MachineSummary | null;
  /** The tasks this Mac's own Home is running, which run here. */
  readonly tasks: readonly { readonly threadId: string; readonly title: string }[];
  readonly runningTasks: readonly string[];
}

/**
 * One owner read of a Home: this Mac's row there and, for the Home this Mac
 * hosts, the tasks running on it. Rejects when either read fails, so a caller
 * deciding whether this Mac is idle never mistakes a failed read for none.
 */
export async function readHome(
  host: HomeHost,
  input: {
    readonly deploymentId: string;
    readonly runnerId: string | null;
    readonly hosted: boolean;
  },
): Promise<HomeRead> {
  const signal = () => AbortSignal.timeout(homeReadTimeoutMs);
  const [machines, shell] = await Promise.all([
    host["machines.list"]({}, { signal: signal() }).then(hostApiData),
    input.hosted ? host["personal.shell.get"]({}, { signal: signal() }).then(hostApiData) : null,
  ]);
  const runnerId = input.runnerId;
  const tasks = (shell?.tasks ?? [])
    .filter((task) => task.status === "running" || task.status === "waiting")
    .map((task) => ({ threadId: task.id, title: task.title }));
  return {
    deploymentId: input.deploymentId,
    machine: runnerId ? (machines.machines.find((row) => isThisMac(row, runnerId)) ?? null) : null,
    tasks,
    runningTasks: tasks.map((task) => task.title.trim() || "Untitled task"),
  };
}

export function isThisMac(machine: MachineSummary, runnerId: string): boolean {
  return (
    machine.id === runnerId ||
    machine.selfRunnerId === runnerId ||
    machine.drivers?.some((driver) => driver.runnerId === runnerId) === true
  );
}

export interface ActivitySnapshot {
  /** False when something that may be using this Mac could not be read. */
  readonly known: boolean;
  readonly hostsHome: boolean;
  /** Homes this Mac is a Device of, by name. */
  readonly deviceHomes: readonly string[];
  readonly lines: readonly string[];
}

/** Idle only when everything that could be using this Mac was read and nothing is. */
export function activityIdle(snapshot: ActivitySnapshot): boolean {
  return snapshot.known && snapshot.lines.length === 0;
}

export interface DesktopActivityOptions {
  readonly hostedHome: () => Promise<{
    readonly deploymentId: string;
    readonly runnerId: string | null;
  } | null>;
  readonly deviceHomes: () => Promise<
    readonly {
      readonly deploymentId: string;
      readonly name: string;
      readonly runner: z.infer<typeof DesktopRunnerStateSchema>;
      readonly runnerId: string | null;
    }[]
  >;
  /** Each Home's typed API under that Home's own owner session, selected or not. */
  readonly host: (deploymentId: string) => HomeHost;
  readonly local: () => {
    readonly appSessions: number;
    readonly browserTabs: number;
    /** Runs the Device Runners here are working on. */
    readonly runs?: number;
  };
}

/**
 * What is using this Mac, read fresh, for the two decisions that would stop
 * it: Quit Opensteer Completely's question, and installing an update. Every
 * Home this Mac works for is read, the one it hosts and each one whose Device
 * Runner is running here. A read that failed, or a Home that does not list
 * this Mac's Runner, makes the answer unknown, never idle.
 */
export class DesktopActivity {
  readonly #options: DesktopActivityOptions;

  constructor(options: DesktopActivityOptions) {
    this.#options = options;
  }

  async snapshot(): Promise<ActivitySnapshot> {
    let known = true;
    const [hosted, devices] = await Promise.all([
      this.#options.hostedHome(),
      this.#options.deviceHomes(),
    ]);
    const working = devices.filter(
      (home) => home.runner !== "disabled" && home.deploymentId !== hosted?.deploymentId,
    );
    const targets = [
      ...(hosted
        ? [{ deploymentId: hosted.deploymentId, runnerId: hosted.runnerId, hosted: true }]
        : []),
      ...working.map((home) => ({
        deploymentId: home.deploymentId,
        runnerId: home.runnerId,
        hosted: false,
      })),
    ];
    const machines = new Map<string, MenuBarMachine>();
    const runningTasks: string[] = [];
    const reads = await Promise.allSettled(
      targets.map((target) => readHome(this.#options.host(target.deploymentId), target)),
    );
    for (const [index, read] of reads.entries()) {
      const target = targets[index]!;
      if (read.status === "rejected") {
        known = false;
        continue;
      }
      // A Runner the Home does not list is one whose work this read cannot see.
      if (!target.runnerId || !read.value.machine) known = false;
      machines.set(target.deploymentId, { machine: read.value.machine, devicesAvailable: true });
      runningTasks.push(...read.value.runningTasks);
    }
    let local: ReturnType<DesktopActivityOptions["local"]>;
    try {
      local = this.#options.local();
    } catch {
      known = false;
      local = { appSessions: 0, browserTabs: 0 };
    }
    const lines = menuBarActivity({ machines, runningTasks, local });
    if ((local.runs ?? 0) > 0)
      lines.push(
        local.runs === 1
          ? "A Device on this Mac is running a task"
          : `Devices on this Mac are running ${local.runs} tasks`,
      );
    return {
      known,
      hostsHome: hosted !== null,
      deviceHomes: devices
        .filter((home) => home.deploymentId !== hosted?.deploymentId)
        .map((home) => home.name),
      lines,
    };
  }
}

/**
 * The update's last look at whether this Mac is idle, fenced: admission closes
 * first, so nothing new starts between the look and the restart. When the
 * look finds work, or the caller backs off, `release` opens admission again,
 * unless the person stopped agents meanwhile.
 */
export async function fencedIdle(
  admission: Pick<AgentAdmission, "close" | "reopen" | "open">,
  personStopped: () => boolean,
  idle: () => Promise<boolean>,
): Promise<{ readonly idle: boolean; release(): void }> {
  const fenced = admission.open;
  if (fenced) admission.close();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (fenced && !personStopped()) admission.reopen();
  };
  let result: boolean;
  try {
    result = await idle();
  } catch {
    result = false;
  }
  if (!result) release();
  return { idle: result, release };
}
