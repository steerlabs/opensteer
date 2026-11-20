import {
  deviceAccessRows,
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
} from "@opensteer/protocol";
import type { z } from "zod";
import { hostApiData } from "../connections/desktop-host-api.js";
import { homeReadTimeoutMs, readHome, type HomeHost, type HomeRead } from "./desktop-activity.js";
import type { ShutdownLog } from "./desktop-shutdown.js";

export const switchConflictSentence =
  "This changed on another device. The switches show what’s set now.";

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
  readonly host: (deploymentId: string) => HomeHost;
  readonly local: () => MenuBarInput["local"];
  readonly stop: () => { readonly stopped: boolean; readonly problem: string | null };
  readonly openAtLogin: () => Promise<MenuBarInput["openAtLogin"]>;
  readonly log: ShutdownLog;
}

interface ShownRead extends HomeRead {
  readonly devicesAvailable: boolean;
}

/**
 * What the menu bar shows, from what desktop main already supervises plus one
 * owner read of the selected Home: this Mac's row there (the switches Devices
 * shows) and the tasks running on it. Every write is the Devices screen's.
 * It informs the person; quitting and updating read activity for themselves.
 */
export class DesktopMenuBarService {
  readonly #options: DesktopMenuBarServiceOptions;
  readonly #listeners = new Set<() => void>();
  #read: ShownRead | null = null;
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
    const stop = this.#options.stop();
    return menuBarStatus({
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
      stopped: stop.stopped,
      stopProblem: stop.problem,
      openAtLogin,
    });
  }

  /** Reads the selected Home again; a caller joins a read already under way. */
  refresh(): Promise<void> {
    this.#reading ??= this.#refresh().finally(() => {
      this.#reading = null;
    });
    return this.#reading;
  }

  /** A read that starts after everything before it settled: what a write must show. */
  async #refreshAfter(): Promise<void> {
    await this.#reading?.catch(() => undefined);
    await this.refresh();
  }

  /**
   * Writes one switch against the revision the person saw. A change made
   * elsewhere since then is refused, never applied on top of it.
   */
  async setSwitch(input: MenuBarSwitchInput): Promise<void> {
    const read = this.#read;
    const machine = read?.deploymentId === input.deploymentId ? read.machine : null;
    const access = machine?.access;
    const row = machine
      ? deviceAccessRows(machine, read?.devicesAvailable === true).find(
          (candidate) => candidate.capability === input.capability,
        )
      : undefined;
    if (!machine || !access || row?.kind !== "switch" || row.on === null) {
      await this.#refreshAfter();
      throw new Error("That switch can’t be changed from here right now.");
    }
    if (access.revision !== input.revision) {
      await this.#refreshAfter();
      throw new Error(switchConflictSentence);
    }
    let conflict: boolean;
    try {
      const result = hostApiData(
        await this.#options.host(input.deploymentId)["commands.dispatch"](
          DeviceMachineAccessUpdateCommandSchema.parse({
            type: "machine.access.update",
            deviceId: machine.id,
            policy: withDeviceSwitch(access.policy, input.capability, input.on),
            expectedRevision: input.revision,
            idempotencyKey: crypto.randomUUID(),
          }),
          { signal: AbortSignal.timeout(homeReadTimeoutMs) },
        ),
      );
      conflict = result.type === "machine.access.update" && result.outcome === "conflict";
    } finally {
      await this.#refreshAfter();
    }
    if (conflict) throw new Error(switchConflictSentence);
  }

  async #refresh(): Promise<void> {
    const selected = this.#options.selected();
    const [hostedHome, deviceHomes] = await Promise.all([
      this.#options.hostedHome(),
      this.#options.deviceHomes(),
    ]);
    const hosted = hostedHome?.deploymentId === selected?.deploymentId ? hostedHome : null;
    const device = deviceHomes.find((home) => home.deploymentId === selected?.deploymentId);
    if (!selected || (!hosted && !device)) {
      this.#read = null;
      this.changed();
      return;
    }
    try {
      const read = await readHome(this.#options.host(selected.deploymentId), {
        deploymentId: selected.deploymentId,
        runnerId: hosted?.runnerId ?? device?.runnerId ?? null,
        hosted: hosted !== null,
      });
      this.#read = { ...read, devicesAvailable: selected.devicesAvailable };
    } catch {
      this.#options.log("desktop.menu-bar.host-read-failed", {});
      this.#read = null;
    }
    this.changed();
  }
}
