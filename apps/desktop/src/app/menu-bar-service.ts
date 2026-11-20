import {
  deviceAccessRows,
  menuBarStatus,
  menuBarWords,
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

export const switchConflictSentence = menuBarWords("menubar.switch.conflict");

export interface MenuBarHostedHome {
  readonly deploymentId: string;
  readonly name: string;
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
  /** What this Mac itself knows is using it; read on every status, never from a Home. */
  readonly local: () => MenuBarInput["local"];
  readonly stop: () => MenuBarInput["stop"];
  /** One thing in Right now, stopped the way the Home's Stop stops that kind. */
  readonly stopRow: (id: string) => boolean;
  readonly openAtLogin: () => Promise<MenuBarInput["openAtLogin"]>;
  readonly log: ShutdownLog;
}

interface ShownRead extends HomeRead {
  readonly devicesAvailable: boolean;
}

/**
 * What the menu bar shows. The header, Right now and Stop come from what
 * desktop main itself holds, so the popover is right with every Home out of
 * reach and never waits for one. Reads of a Home only add to it: this Mac's
 * switches and the work the selected Home reports, and each Home's Needs you.
 * It informs the person; quitting and updating read activity for themselves.
 */
export class DesktopMenuBarService {
  readonly #options: DesktopMenuBarServiceOptions;
  readonly #listeners = new Set<() => void>();
  readonly #needsYou = new Map<string, number | null>();
  #read: ShownRead | null = null;
  #reading: Promise<void> | null = null;

  constructor(options: DesktopMenuBarServiceOptions) {
    this.#options = options;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Something desktop main holds changed; the popover and the status item redraw. */
  changed(): void {
    for (const listener of this.#listeners) listener();
  }

  /** The window's own live count for the Home it shows, as it badges the app. */
  noteNeedsYou(deploymentId: string, count: number): void {
    if (this.#needsYou.get(deploymentId) === count) return;
    this.#needsYou.set(deploymentId, count);
    this.changed();
  }

  async status(): Promise<MenuBarStatus> {
    const [hostedHome, deviceHomes, openAtLogin] = await Promise.all([
      this.#options.hostedHome(),
      this.#options.deviceHomes(),
      this.#options.openAtLogin(),
    ]);
    const homes = new Set([
      ...(hostedHome ? [hostedHome.deploymentId] : []),
      ...deviceHomes.map((home) => home.deploymentId),
    ]);
    const read = this.#read && homes.has(this.#read.deploymentId) ? this.#read : null;
    return menuBarStatus({
      hostedHome: hostedHome && {
        deploymentId: hostedHome.deploymentId,
        name: hostedHome.name,
        state: hostedHome.state,
      },
      deviceHomes,
      stop: this.#options.stop(),
      thisMac: read
        ? {
            deploymentId: read.deploymentId,
            machine: read.machine,
            devicesAvailable: read.devicesAvailable,
          }
        : null,
      needsYou: new Map([...this.#needsYou].filter(([deploymentId]) => homes.has(deploymentId))),
      local: this.#options.local(),
      homeWork: read
        ? {
            runningTasks: read.runningTasks,
            sessions: (read.machine?.access?.activeSessions ?? []).map((session) => ({
              threadId: session.threadId,
              threadTitle: session.threadTitle,
            })),
          }
        : null,
      openAtLogin,
    });
  }

  stopRow(id: string): void {
    if (!this.#options.stopRow(id)) throw new Error("That already ended.");
    this.changed();
  }

  /** Reads the Homes again; a caller joins a read already under way. */
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
      throw new Error(menuBarWords("menubar.switch.unavailable"));
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
    const [hostedHome, deviceHomes] = await Promise.all([
      this.#options.hostedHome(),
      this.#options.deviceHomes(),
    ]);
    const homes = [
      ...(hostedHome ? [hostedHome.deploymentId] : []),
      ...deviceHomes.map((home) => home.deploymentId),
    ];
    await Promise.all([
      this.#readShown(hostedHome, deviceHomes),
      ...[...new Set(homes)].map((deploymentId) => this.#readNeedsYou(deploymentId)),
    ]);
    this.changed();
  }

  async #readNeedsYou(deploymentId: string): Promise<void> {
    try {
      const attention = hostApiData(
        await this.#options
          .host(deploymentId)
          ["attention.get"]({}, { signal: AbortSignal.timeout(homeReadTimeoutMs) }),
      );
      this.#needsYou.set(deploymentId, attention.needsYou);
    } catch {
      this.#needsYou.set(deploymentId, null);
    }
  }

  async #readShown(
    hostedHome: MenuBarHostedHome | null,
    deviceHomes: readonly MenuBarDeviceHome[],
  ): Promise<void> {
    const selected = this.#options.selected();
    const hosted = hostedHome?.deploymentId === selected?.deploymentId ? hostedHome : null;
    const device = deviceHomes.find((home) => home.deploymentId === selected?.deploymentId);
    if (!selected || (!hosted && !device)) {
      this.#read = null;
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
  }
}
