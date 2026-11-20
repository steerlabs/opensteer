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
  /** The Home the window shows, whose switches for this Mac the popover offers. */
  readonly selected: () => {
    readonly deploymentId: string;
    readonly devicesAvailable: boolean;
  } | null;
  /** Each Home's typed API under that Home's own owner session, selected or not. */
  readonly host: (deploymentId: string) => HomeHost;
  /** What this Mac itself knows is using it; read on every status, never from a Home. */
  readonly local: () => MenuBarInput["local"];
  readonly stop: () => MenuBarInput["stop"];
  /**
   * One thing in Right now, stopped the way the Home's Stop stops that kind.
   * Resolves once the stop was handed on; throws when it could not be, or
   * false when that thing had already ended.
   */
  readonly stopRow: (id: string) => Promise<boolean> | boolean;
  readonly openAtLogin: () => Promise<MenuBarInput["openAtLogin"]>;
  readonly log: ShutdownLog;
}

interface ShownRead extends HomeRead {
  readonly devicesAvailable: boolean;
}

/**
 * What the menu bar shows. The header, Right now and Stop come from what
 * desktop main itself holds, so the popover is right with every Home out of
 * reach and never waits for one. Reads of a Home only add to it, each
 * published as it answers: this Mac's switches in the Home the window shows,
 * the tasks this Mac's own Home is running, shells on this Mac, and each
 * Home's Needs you. It informs the person; quitting and updating read activity
 * for themselves.
 */
export class DesktopMenuBarService {
  readonly #options: DesktopMenuBarServiceOptions;
  readonly #listeners = new Set<() => void>();
  readonly #needsYou = new Map<string, number | null>();
  /** Rows the person stopped from here, until their end shows. */
  readonly #rowStates = new Map<string, "stopping" | "failed">();
  #read: ShownRead | null = null;
  #hostedRead: HomeRead | null = null;
  /** Whether every Home was out of reach when status was last worked out. */
  #unreachable = false;
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

  /** The window's own live count for the Home it came from, as it badges the app. */
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
    // A Home this Mac no longer works for keeps nothing here.
    for (const deploymentId of this.#needsYou.keys())
      if (!homes.has(deploymentId)) this.#needsYou.delete(deploymentId);
    const read = this.#read && homes.has(this.#read.deploymentId) ? this.#read : null;
    const hostedRead =
      hostedHome && this.#hostedRead?.deploymentId === hostedHome.deploymentId
        ? this.#hostedRead
        : null;
    const local = this.#options.local();
    const reads = [read, hostedRead].filter((value): value is HomeRead => value !== null);
    const shells = new Map<
      string,
      { id: string; threadTitle: string; callerMachineName: string }
    >();
    for (const value of reads)
      for (const session of value.machine?.access?.activeSessions ?? [])
        shells.set(session.id, {
          id: session.id,
          threadTitle: session.threadTitle,
          callerMachineName: session.callerMachineName,
        });
    // A Run the person stopped is gone once its Runner no longer reports it.
    const reported = new Set(
      (local.runs ?? []).map((run) => `runner:${run.deploymentId}:${run.runId}`),
    );
    for (const id of this.#rowStates.keys())
      if (id.startsWith("runner:") && !reported.has(id)) this.#rowStates.delete(id);
    const state = (id: string) => this.#rowStates.get(id) ?? "active";
    const status = menuBarStatus({
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
      needsYou: new Map(this.#needsYou),
      local: {
        ...local,
        runs: (local.runs ?? []).map((run) => ({
          ...run,
          state: state(`runner:${run.deploymentId}:${run.runId}`),
        })),
      },
      homeWork: reads.length
        ? {
            tasks: (hostedRead?.tasks ?? []).map((task) => ({
              ...task,
              state: state(`home:${task.threadId}`),
            })),
            shells: [...shells.values()],
          }
        : null,
      openAtLogin,
    });
    this.#unreachable = status.icon.unreachable;
    return status;
  }

  /**
   * The status item's glyph from what main already holds, without reading a
   * Home or anything that could wait: the person's Stop as it is now, the
   * Needs you counts last heard, and reachability as last worked out.
   */
  icon(): MenuBarStatus["icon"] {
    return {
      attention: [...this.#needsYou.values()].some((count) => count === null || count > 0),
      unreachable: this.#unreachable,
      stopped: this.#options.stop().phase !== "running",
    };
  }

  /**
   * Stops one row. It shows as stopping until its end shows, or as failed with
   * Stop offered again when the stop could not be handed on.
   */
  async stopRow(id: string): Promise<void> {
    this.#rowStates.set(id, "stopping");
    this.changed();
    let stopped: boolean;
    try {
      stopped = await this.#options.stopRow(id);
    } catch (error) {
      this.#rowStates.set(id, "failed");
      this.changed();
      throw error;
    }
    if (!stopped) {
      this.#rowStates.delete(id);
      this.changed();
      throw new Error("That already ended.");
    }
    // A task's end shows in the Home's next read; a Runner's in its next report.
    if (id.startsWith("home:"))
      void this.refresh()
        .catch(() => undefined)
        .finally(() => {
          this.#rowStates.delete(id);
          this.changed();
        });
    else if (!id.startsWith("runner:")) this.#rowStates.delete(id);
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
   * Writes one switch of the Device the person saw, against the revision they
   * saw. A change made elsewhere since then, or a different Device now in its
   * place, is refused, never applied on top of it.
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
    if (machine.id !== input.machineId || access.revision !== input.revision) {
      await this.#refreshAfter();
      throw new Error(switchConflictSentence);
    }
    let conflict: boolean;
    try {
      const result = hostApiData(
        await this.#options.host(input.deploymentId)["commands.dispatch"](
          DeviceMachineAccessUpdateCommandSchema.parse({
            type: "machine.access.update",
            deviceId: input.machineId,
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

  /** Every Home is read at once, and each result shows as soon as it arrives. */
  async #refresh(): Promise<void> {
    const [hostedHome, deviceHomes] = await Promise.all([
      this.#options.hostedHome(),
      this.#options.deviceHomes(),
    ]);
    const homes = [
      ...(hostedHome ? [hostedHome.deploymentId] : []),
      ...deviceHomes.map((home) => home.deploymentId),
    ];
    const published = <T>(work: Promise<T>) => work.finally(() => this.changed());
    await Promise.allSettled([
      published(this.#readShown(hostedHome, deviceHomes)),
      published(this.#readHosted(hostedHome)),
      ...[...new Set(homes)].map((deploymentId) => published(this.#readNeedsYou(deploymentId))),
    ]);
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

  /** This Mac's own Home: the tasks running here, whichever Home the window shows. */
  async #readHosted(hostedHome: MenuBarHostedHome | null): Promise<void> {
    if (!hostedHome) {
      this.#hostedRead = null;
      return;
    }
    try {
      this.#hostedRead = await readHome(this.#options.host(hostedHome.deploymentId), {
        deploymentId: hostedHome.deploymentId,
        runnerId: hostedHome.runnerId,
        hosted: true,
      });
    } catch {
      this.#options.log("desktop.menu-bar.host-read-failed", {});
      this.#hostedRead = null;
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
        hosted: false,
      });
      this.#read = { ...read, devicesAvailable: selected.devicesAvailable };
    } catch {
      this.#options.log("desktop.menu-bar.host-read-failed", {});
      this.#read = null;
    }
  }
}
