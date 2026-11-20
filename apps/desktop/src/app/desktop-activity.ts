import { menuBarActivity, type MenuBarMachine } from "@opensteer/client/computers";
import type { DesktopRunnerStateSchema, HostApiClient, MachineSummary } from "@opensteer/protocol";
import type { z } from "zod";
import { hostApiData } from "../connections/desktop-host-api.js";

export const homeReadTimeoutMs = 5_000;

export type HomeHost = Pick<
  HostApiClient,
  "commands.dispatch" | "machines.list" | "personal.shell.get"
>;

export interface HomeRead {
  readonly deploymentId: string;
  readonly machine: MachineSummary | null;
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
  return {
    deploymentId: input.deploymentId,
    machine: runnerId ? (machines.machines.find((row) => isThisMac(row, runnerId)) ?? null) : null,
    runningTasks: (shell?.tasks ?? [])
      .filter((task) => task.status === "running")
      .map((task) => task.title.trim() || "Untitled task"),
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
  /** The one Home desktop main can read as its owner: the one the window shows. */
  readonly selected: () => string | null;
  readonly host: (deploymentId: string) => HomeHost;
  readonly local: () => { readonly appSessions: number; readonly browserTabs: number };
}

/**
 * What is using this Mac, read fresh, for the two decisions that would stop
 * it: Quit Opensteer Completely's question, and installing an update. The
 * Home this Mac hosts and every Device Runner running here count. One that
 * cannot be read — a Home the window does not show, or a read that failed —
 * makes the answer unknown, never idle.
 */
export class DesktopActivity {
  readonly #options: DesktopActivityOptions;

  constructor(options: DesktopActivityOptions) {
    this.#options = options;
  }

  async snapshot(): Promise<ActivitySnapshot> {
    const [hosted, devices] = await Promise.all([
      this.#options.hostedHome(),
      this.#options.deviceHomes(),
    ]);
    const selected = this.#options.selected();
    const working = devices.filter(
      (home) => home.runner !== "disabled" && home.deploymentId !== hosted?.deploymentId,
    );
    let known = true;
    const unread = [
      ...(hosted ? [hosted.deploymentId] : []),
      ...working.map((home) => home.deploymentId),
    ].filter((deploymentId) => deploymentId !== selected);
    if (unread.length) known = false;
    const device = working.find((home) => home.deploymentId === selected);
    const target =
      selected !== null && hosted?.deploymentId === selected
        ? { runnerId: hosted.runnerId, hosted: true }
        : device
          ? { runnerId: device.runnerId, hosted: false }
          : null;
    const machines = new Map<string, MenuBarMachine>();
    let runningTasks: readonly string[] = [];
    if (selected !== null && target) {
      try {
        const read = await readHome(this.#options.host(selected), {
          deploymentId: selected,
          ...target,
        });
        machines.set(selected, { machine: read.machine, devicesAvailable: true });
        runningTasks = read.runningTasks;
      } catch {
        known = false;
      }
    }
    return {
      known,
      hostsHome: hosted !== null,
      deviceHomes: devices
        .filter((home) => home.deploymentId !== hosted?.deploymentId)
        .map((home) => home.name),
      lines: menuBarActivity({ machines, runningTasks, local: this.#options.local() }),
    };
  }
}
