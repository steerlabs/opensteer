import {
  menuBarActivity,
  menuBarStatus,
  withDeviceSwitch,
  type MenuBarInput,
  type MenuBarStatus,
  type MenuBarSwitchInput,
} from "@opensteer/client/computers";
import {
  DeviceMachineAccessUpdateCommandSchema,
  type DesktopPersonalDeploymentState,
  type DesktopRunnerStateSchema,
  type HostApiClient,
  type MachineSummary,
} from "@opensteer/protocol";
import type { z } from "zod";
import { hostApiData } from "../connections/desktop-host-api.js";
import type { QuitWork } from "./background-mode.js";
import type { ShutdownLog } from "./desktop-shutdown.js";

export const menuBarHostReadTimeoutMs = 5_000;
const conflictSentence = "This changed on another device. The switches show what’s set now.";

export type MenuBarHost = Pick<
  HostApiClient,
  "commands.dispatch" | "machines.list" | "personal.shell.get"
>;

export interface MenuBarHostedHome {
  readonly deploymentId: string;
  readonly state: DesktopPersonalDeploymentState;
  readonly runnerId: string | null;
}

export interface MenuBarDeviceHome {
  readonly deploymentId: string;
  readonly name: string;
  readonly runner: z.infer<typeof DesktopRunnerStateSchema>;
  readonly signedOut: boolean;
  readonly runnerId: string | null;
}

export interface DesktopMenuBarServiceOptions {
  readonly hostedHome: () => Promise<MenuBarHostedHome | null>;
  readonly deviceHomes: () => Promise<readonly MenuBarDeviceHome[]>;
  /** The Home the window shows: the one Host desktop main holds an owner session for. */
  readonly selected: () => {
    readonly deploymentId: string;
    readonly devicesAvailable: boolean;
  } | null;
  readonly host: (deploymentId: string) => MenuBarHost;
  readonly local: () => MenuBarInput["local"];
  readonly stopped: () => boolean;
  readonly openAtLogin: () => Promise<boolean>;
  readonly log: ShutdownLog;
}

interface HomeRead {
  readonly deploymentId: string;
  readonly devicesAvailable: boolean;
  readonly machine: MachineSummary | null;
  readonly runningTasks: readonly string[];
}

/**
 * What the menu bar shows, from what desktop main already supervises plus one
 * owner read of the selected Home: this Mac's row there (the switches Devices
 * shows) and the tasks running on it. Every write is the Devices screen's.
 */
export class DesktopMenuBarService {
  readonly #options: DesktopMenuBarServiceOptions;
  readonly #listeners = new Set<() => void>();
  #read: HomeRead | null = null;
  #reading: Promise<void> | null = null;

  constructor(options: DesktopMenuBarServiceOptions) {
    this.#options = options;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Something desktop main holds changed; the popover redraws from it. */
  changed(): void {
    for (const listener of this.#listeners) listener();
  }

  async status(): Promise<MenuBarStatus> {
    return menuBarStatus(await this.#input());
  }

  /** Reads the selected Home again; concurrent callers share one read. */
  refresh(): Promise<void> {
    this.#reading ??= this.#refresh().finally(() => {
      this.#reading = null;
    });
    return this.#reading;
  }

  async setSwitch(input: MenuBarSwitchInput): Promise<void> {
    const read = this.#read;
    const access = read?.deploymentId === input.deploymentId ? read.machine?.access : null;
    if (!read?.machine || !access) throw new Error("This Mac’s switches are still loading.");
    const result = hostApiData(
      await this.#options.host(input.deploymentId)["commands.dispatch"](
        DeviceMachineAccessUpdateCommandSchema.parse({
          type: "machine.access.update",
          deviceId: read.machine.id,
          policy: withDeviceSwitch(access.policy, input.capability, input.on),
          expectedRevision: access.revision,
          idempotencyKey: crypto.randomUUID(),
        }),
        { signal: AbortSignal.timeout(menuBarHostReadTimeoutMs) },
      ),
    );
    await this.refresh();
    if (result.type === "machine.access.update" && result.outcome === "conflict")
      throw new Error(conflictSentence);
  }

  /** Whether stopping now would interrupt an agent; reads the Home first when asked. */
  async activeWork(fresh: boolean): Promise<boolean> {
    if (fresh) await this.refresh();
    return menuBarActivity(await this.#input()).length > 0;
  }

  async quitWork(): Promise<QuitWork> {
    await this.refresh();
    const input = await this.#input();
    const devices = await this.#options.deviceHomes();
    return {
      hostsHome: input.hostedHome !== null,
      deviceHomes: devices
        .filter((home) => home.deploymentId !== input.hostedHome?.deploymentId)
        .map((home) => home.name),
      activity: menuBarActivity(input),
    };
  }

  async #input(): Promise<MenuBarInput> {
    const [hostedHome, deviceHomes, openAtLogin] = await Promise.all([
      this.#options.hostedHome(),
      this.#options.deviceHomes(),
      this.#options.openAtLogin(),
    ]);
    const read = this.#read;
    const homes = new Set([
      ...(hostedHome ? [hostedHome.deploymentId] : []),
      ...deviceHomes.map((home) => home.deploymentId),
    ]);
    const current = read && homes.has(read.deploymentId) ? read : null;
    return {
      hostedHome: hostedHome && { deploymentId: hostedHome.deploymentId, state: hostedHome.state },
      deviceHomes,
      machines: current
        ? new Map([
            [
              current.deploymentId,
              { machine: current.machine, devicesAvailable: current.devicesAvailable },
            ],
          ])
        : new Map(),
      runningTasks: current?.runningTasks ?? [],
      local: this.#options.local(),
      stopped: this.#options.stopped(),
      openAtLogin,
    };
  }

  async #refresh(): Promise<void> {
    const selected = this.#options.selected();
    const [hostedHome, deviceHomes] = await Promise.all([
      this.#options.hostedHome(),
      this.#options.deviceHomes(),
    ]);
    const hosted = hostedHome?.deploymentId === selected?.deploymentId ? hostedHome : null;
    const device = deviceHomes.find((home) => home.deploymentId === selected?.deploymentId);
    const runnerId = hosted?.runnerId ?? device?.runnerId ?? null;
    if (!selected || (!hosted && !device)) {
      this.#read = null;
      this.changed();
      return;
    }
    const host = this.#options.host(selected.deploymentId);
    const signal = () => AbortSignal.timeout(menuBarHostReadTimeoutMs);
    const [machines, shell] = await Promise.allSettled([
      host["machines.list"]({}, { signal: signal() }).then(hostApiData),
      hosted ? host["personal.shell.get"]({}, { signal: signal() }).then(hostApiData) : null,
    ]);
    if (machines.status === "rejected")
      this.#options.log("desktop.menu-bar.host-read-failed", { read: "machines" });
    if (shell.status === "rejected")
      this.#options.log("desktop.menu-bar.host-read-failed", { read: "tasks" });
    const machine =
      machines.status === "fulfilled" && runnerId
        ? (machines.value.machines.find((row) => isThisMac(row, runnerId)) ?? null)
        : null;
    const snapshot = shell.status === "fulfilled" ? shell.value : null;
    this.#read = {
      deploymentId: selected.deploymentId,
      devicesAvailable: selected.devicesAvailable,
      machine,
      runningTasks: (snapshot?.tasks ?? [])
        .filter((task) => task.status === "running")
        .map((task) => task.title.trim() || "Untitled task"),
    };
    this.changed();
  }
}

function isThisMac(machine: MachineSummary, runnerId: string): boolean {
  return (
    machine.id === runnerId ||
    machine.selfRunnerId === runnerId ||
    machine.drivers?.some((driver) => driver.runnerId === runnerId) === true
  );
}
