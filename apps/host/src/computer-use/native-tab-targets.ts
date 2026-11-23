import { computerConnectionDeviceId, type DeviceComputerConnection } from "./device-drivers.js";
import type { ComputerTargetId } from "../computer-apps/computer-app-hub.js";
import {
  refused,
  isPhoneDisplayDefinitionId,
  type ComputerAppIdentity,
  type TabId,
  type UserId,
  type WindowId,
} from "@opensteer/core";
import { WindowIdSchema } from "@opensteer/core";
import type { ComputerView } from "@opensteer/protocol";
import { computerAppIdentitiesEqual } from "@opensteer/integration-core";
import type { ComputerViewService } from "./computer-view-service.js";
import type {
  NativeTabTargetsPort,
  DeviceNativeTabTargetsPort,
  NativeTabTargetState,
  NativeTargetAcquired,
  NativeTargetAcquiredHandler,
  ResolvedTabWindow,
} from "../tabs/ports.js";

export interface NativeWindowQueryResult {
  windowId: string | null;
  app: ComputerAppIdentity | null;
  title: string | null;
  unavailableReason: string | null;
}
export interface NativeTabTargetsOptions {
  views: Pick<ComputerViewService, "openForTab" | "closeTabViews" | "list">;
  connections(ownerId: UserId): Promise<readonly DeviceComputerConnection[]>;
  owns(ownerId: UserId, computerId: ComputerTargetId): Promise<boolean>;
  connected(computerId: ComputerTargetId): boolean;
  /** Lease-free window.resolve on the current authenticated helper connection. */
  queryWindow(
    computerId: ComputerTargetId,
    input: { windowId: WindowId } | { app: ComputerAppIdentity },
  ): Promise<NativeWindowQueryResult>;
  users(
    ownerId: UserId,
    computerId: ComputerTargetId,
    windowId?: WindowId,
  ): NativeTabTargetState["usedBy"];
  phoneUnavailable(
    computerId: ComputerTargetId,
  ): "paused" | "protected" | "locked" | "unsupported" | null;
  readonly now?: () => number;
  readonly windowRefreshTtlMs?: number;
  readonly maxObservedWindows?: number;
  readonly maxConcurrentWindowProbesPerComputer?: number;
  readonly onWindowStateChanged?: (
    ownerId: UserId,
    computerId: ComputerTargetId,
    windowId: WindowId,
  ) => void;
}
type WindowUnavailableCode = Extract<
  NativeTabTargetState,
  { state: "unavailable" }
>["unavailableCode"];
type ObservedWindow =
  | {
      readonly kind: "live";
      readonly computerId: ComputerTargetId;
      readonly app: ComputerAppIdentity;
      readonly checkedAt: number;
      readonly generation: number;
      readonly revision: number;
    }
  | {
      readonly kind: "unavailable";
      readonly computerId: ComputerTargetId;
      readonly code: WindowUnavailableCode;
      readonly reason: string;
      readonly checkedAt: number;
      readonly generation: number;
      readonly revision: number;
    };
const defaultWindowRefreshTtlMs = 30_000;
const defaultMaxObservedWindows = 2048;
const defaultMaxConcurrentWindowProbesPerComputer = 8;
const unavailable = (
  unavailableCode: WindowUnavailableCode,
  unavailableReason: string,
): NativeTabTargetState => ({
  state: "unavailable",
  unavailableCode,
  unavailableReason,
  usedBy: [],
});
function mapWindowUnavailableReason(reason: string): {
  code: WindowUnavailableCode;
  reason: string;
} {
  if (reason === "window-closed") return { code: reason, reason: "Window closed" };
  if (reason === "window-identity-lost")
    return { code: reason, reason: "This window's identity is no longer available." };
  if (reason === "locked" || reason === "minimized" || reason === "unsupported")
    return { code: reason, reason: `This window is ${reason}.` };
  return { code: "runtime-failed", reason: "This window is unavailable." };
}
function sameObservedProjection(
  previous: ObservedWindow | undefined,
  next: ObservedWindow,
): boolean {
  if (!previous) return next.kind === "live";
  if (previous.kind !== next.kind) return false;
  if (previous.kind === "live" && next.kind === "live")
    return computerAppIdentitiesEqual(previous.app, next.app);
  return (
    previous.kind === "unavailable" &&
    next.kind === "unavailable" &&
    previous.code === next.code &&
    previous.reason === next.reason
  );
}

export class NativeTabTargets implements NativeTabTargetsPort {
  readonly #options: NativeTabTargetsOptions;
  readonly #now: () => number;
  readonly #refreshTtlMs: number;
  readonly #maxObservedWindows: number;
  readonly #maxConcurrentWindowProbesPerComputer: number;
  readonly #generations = new Map<ComputerTargetId, number>();
  readonly #observed = new Map<string, ObservedWindow>();
  readonly #evictedUnavailable = new Map<string, ComputerTargetId>();
  readonly #evictedUnavailableOverflow = new Set<ComputerTargetId>();
  readonly #inFlight = new Map<string, { readonly promise: Promise<void>; superseded: boolean }>();
  readonly #activeProbesByComputer = new Map<ComputerTargetId, number>();
  readonly #queuedProbes = new Map<
    string,
    {
      readonly ownerId: UserId;
      readonly computerId: ComputerTargetId;
      readonly windowId: WindowId;
      readonly generation: number;
    }
  >();
  #revision = 0;
  #acquired: NativeTargetAcquiredHandler | undefined;
  #capture: ((ownerId: UserId) => Promise<number>) | undefined;
  constructor(options: NativeTabTargetsOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#refreshTtlMs = options.windowRefreshTtlMs ?? defaultWindowRefreshTtlMs;
    this.#maxObservedWindows = Math.max(1, options.maxObservedWindows ?? defaultMaxObservedWindows);
    this.#maxConcurrentWindowProbesPerComputer = Math.max(
      1,
      options.maxConcurrentWindowProbesPerComputer ?? defaultMaxConcurrentWindowProbesPerComputer,
    );
  }
  #generation(computerId: ComputerTargetId): number {
    return this.#generations.get(computerId) ?? 0;
  }
  #windowKey(computerId: ComputerTargetId, windowId: WindowId): string {
    return `${computerId}:${windowId}`;
  }
  #rememberObserved(
    key: string,
    entry: ObservedWindow,
    activeFlight?: { readonly promise: Promise<void>; superseded: boolean },
  ): void {
    const active = this.#inFlight.get(key);
    if (active && active !== activeFlight) active.superseded = true;
    this.#evictedUnavailable.delete(key);
    this.#observed.delete(key);
    this.#observed.set(key, entry);
    while (this.#observed.size > this.#maxObservedWindows) {
      const oldest = this.#observed.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.#observed.get(oldest);
      this.#observed.delete(oldest);
      if (evicted?.kind === "unavailable") {
        this.#evictedUnavailable.delete(oldest);
        this.#evictedUnavailable.set(oldest, evicted.computerId);
        while (this.#evictedUnavailable.size > this.#maxObservedWindows * 4) {
          const stale = this.#evictedUnavailable.entries().next().value;
          if (stale === undefined) break;
          this.#evictedUnavailable.delete(stale[0]);
          this.#evictedUnavailableOverflow.add(stale[1]);
        }
      }
    }
  }
  #touchObserved(key: string, entry: ObservedWindow): void {
    this.#observed.delete(key);
    this.#observed.set(key, entry);
  }
  #hasApprovedApp(
    connections: readonly DeviceComputerConnection[],
    app: ComputerAppIdentity,
  ): boolean {
    return connections.some(
      (entry) => entry.computer?.app && computerAppIdentitiesEqual(entry.computer.app, app),
    );
  }
  #filterComputerConnections(
    connections: readonly DeviceComputerConnection[],
    computerId: ComputerTargetId,
  ): DeviceComputerConnection[] {
    return connections.filter(
      (entry) =>
        entry.computer &&
        computerConnectionDeviceId(entry) === computerId &&
        !entry.computer.blockedAt,
    );
  }
  forgetComputer(computerId: ComputerTargetId): void {
    this.#generations.set(computerId, this.#generation(computerId) + 1);
    for (const [key, entry] of this.#observed) {
      if (entry.computerId === computerId) this.#observed.delete(key);
    }
    const prefix = `${computerId}:`;
    for (const [key, evictedComputerId] of this.#evictedUnavailable) {
      if (evictedComputerId === computerId) this.#evictedUnavailable.delete(key);
    }
    this.#evictedUnavailableOverflow.delete(computerId);
    for (const [key, active] of this.#inFlight) {
      if (key.startsWith(prefix)) {
        active.superseded = true;
        this.#inFlight.delete(key);
      }
    }
    for (const [key, queued] of this.#queuedProbes) {
      if (queued.computerId === computerId) this.#queuedProbes.delete(key);
    }
  }
  observeView(view: ComputerView): boolean {
    if (view.target.kind !== "app") return false;
    const windowId = view.target.windowId ?? view.window?.windowId;
    if (!windowId) return false;
    const computerId = view.machineId as ComputerTargetId;
    const generation = this.#generation(computerId);
    const key = this.#windowKey(computerId, windowId);
    const previous = this.#observed.get(key);
    let next: ObservedWindow | undefined;
    if (view.state === "ready") {
      next = {
        kind: "live",
        computerId,
        app: view.target.app,
        checkedAt: this.#now(),
        generation,
        revision: ++this.#revision,
      };
    } else if (
      view.state === "unavailable" &&
      (view.unavailableReason === "window-closed" ||
        view.unavailableReason === "window-identity-lost" ||
        view.unavailableReason === "minimized" ||
        view.unavailableReason === "locked" ||
        view.unavailableReason === "unsupported")
    ) {
      const mapped = mapWindowUnavailableReason(view.unavailableReason);
      next = {
        kind: "unavailable",
        computerId,
        code: mapped.code,
        reason: mapped.reason,
        checkedAt: this.#now(),
        generation,
        revision: ++this.#revision,
      };
    }
    if (!next) return false;
    const hadEvictedUnavailable =
      this.#evictedUnavailable.delete(key) ||
      (!previous && this.#evictedUnavailableOverflow.has(computerId) && next.kind === "live");
    this.#rememberObserved(key, next);
    return hadEvictedUnavailable || !sameObservedProjection(previous, next);
  }
  #observeQueryResult(
    computerId: ComputerTargetId,
    windowId: WindowId,
    result: NativeWindowQueryResult,
    generation: number,
  ): ObservedWindow {
    const checkedAt = this.#now();
    const revision = ++this.#revision;
    if (result.unavailableReason) {
      const mapped = mapWindowUnavailableReason(result.unavailableReason);
      return {
        kind: "unavailable",
        computerId,
        code: mapped.code,
        reason: mapped.reason,
        checkedAt,
        generation,
        revision,
      };
    }
    if (result.windowId !== windowId || !result.app) {
      return {
        kind: "unavailable",
        computerId,
        code: "access-denied",
        reason: "This app is unavailable.",
        checkedAt,
        generation,
        revision,
      };
    }
    return {
      kind: "live",
      computerId,
      app: result.app,
      checkedAt,
      generation,
      revision,
    };
  }
  #refreshWindow(
    ownerId: UserId,
    computerId: ComputerTargetId,
    windowId: WindowId,
    generation: number,
  ): void {
    const key = this.#windowKey(computerId, windowId);
    if (this.#inFlight.has(key) || this.#queuedProbes.has(key)) return;
    const active = this.#activeProbesByComputer.get(computerId) ?? 0;
    if (active >= this.#maxConcurrentWindowProbesPerComputer) {
      this.#queuedProbes.set(key, { ownerId, computerId, windowId, generation });
      return;
    }
    this.#startWindowProbe(key, ownerId, computerId, windowId, generation);
  }
  #startWindowProbe(
    key: string,
    ownerId: UserId,
    computerId: ComputerTargetId,
    windowId: WindowId,
    generation: number,
  ): void {
    this.#activeProbesByComputer.set(
      computerId,
      (this.#activeProbesByComputer.get(computerId) ?? 0) + 1,
    );
    const flight = { promise: Promise.resolve(), superseded: false };
    const promise = (async () => {
      let next: ObservedWindow;
      try {
        const result = await this.#options.queryWindow(computerId, { windowId });
        if (
          flight.superseded ||
          this.#generation(computerId) !== generation ||
          !this.#options.connected(computerId)
        )
          return;
        next = this.#observeQueryResult(computerId, windowId, result, generation);
      } catch {
        if (
          flight.superseded ||
          this.#generation(computerId) !== generation ||
          !this.#options.connected(computerId)
        )
          return;
        next = {
          kind: "unavailable",
          computerId,
          code: "runtime-failed",
          reason: "This window is unavailable.",
          checkedAt: this.#now(),
          generation,
          revision: ++this.#revision,
        };
      }
      const previous = this.#observed.get(key);
      const hadEvictedUnavailable =
        this.#evictedUnavailable.delete(key) ||
        (!previous && this.#evictedUnavailableOverflow.has(computerId) && next.kind === "live");
      this.#rememberObserved(key, next, flight);
      if (hadEvictedUnavailable || !sameObservedProjection(previous, next)) {
        this.#options.onWindowStateChanged?.(ownerId, computerId, windowId);
      }
    })().finally(() => {
      if (this.#inFlight.get(key) === flight) this.#inFlight.delete(key);
      const remaining = (this.#activeProbesByComputer.get(computerId) ?? 1) - 1;
      if (remaining <= 0) this.#activeProbesByComputer.delete(computerId);
      else this.#activeProbesByComputer.set(computerId, remaining);
      this.#drainQueuedProbes(computerId);
    });
    (flight as { promise: Promise<void> }).promise = promise;
    this.#inFlight.set(key, flight);
  }
  #drainQueuedProbes(computerId: ComputerTargetId): void {
    while (
      (this.#activeProbesByComputer.get(computerId) ?? 0) <
      this.#maxConcurrentWindowProbesPerComputer
    ) {
      let nextKey: string | undefined;
      for (const [key, queued] of this.#queuedProbes) {
        if (queued.computerId === computerId) {
          nextKey = key;
          break;
        }
      }
      if (!nextKey) return;
      const queued = this.#queuedProbes.get(nextKey)!;
      this.#queuedProbes.delete(nextKey);
      if (
        this.#generation(computerId) !== queued.generation ||
        !this.#options.connected(computerId) ||
        this.#inFlight.has(nextKey)
      )
        continue;
      this.#startWindowProbe(
        nextKey,
        queued.ownerId,
        queued.computerId,
        queued.windowId,
        queued.generation,
      );
    }
  }
  async #connections(ownerId: UserId, computerId: ComputerTargetId) {
    if (!(await this.#options.owns(ownerId, computerId)))
      throw refused("not_found", "This computer is unavailable.");
    return this.#filterComputerConnections(await this.#options.connections(ownerId), computerId);
  }
  async resolveWindow(
    ownerId: UserId,
    computerId: ComputerTargetId,
    target: { windowId: WindowId } | { bundleId: string },
  ): Promise<ResolvedTabWindow> {
    const connections = await this.#connections(ownerId, computerId);
    if (!this.#options.connected(computerId))
      throw refused("runner_offline", "This computer is offline.");
    const generation = this.#generation(computerId);
    const app =
      "bundleId" in target
        ? connections.find((entry) => entry.computer?.app?.bundleId === target.bundleId)?.computer
            ?.app
        : undefined;
    if ("bundleId" in target && !app) throw refused("not_found", "This app is unavailable.");
    const result = await this.#options.queryWindow(
      computerId,
      "windowId" in target ? target : { app: app! },
    );
    const current = await this.#connections(ownerId, computerId);
    if (!this.#options.connected(computerId))
      throw refused("runner_offline", "This computer is offline.");
    if (
      ("windowId" in target && result.windowId !== target.windowId) ||
      !result.windowId ||
      !result.app ||
      !this.#hasApprovedApp(current, result.app)
    )
      throw refused(
        "not_found",
        result.unavailableReason === "window-closed"
          ? "Window closed"
          : "This window's identity is no longer available.",
      );
    const windowId = WindowIdSchema.parse(result.windowId);
    if (this.#generation(computerId) === generation) {
      this.#rememberObserved(this.#windowKey(computerId, windowId), {
        kind: "live",
        computerId,
        app: result.app,
        checkedAt: this.#now(),
        generation,
        revision: ++this.#revision,
      });
    }
    return {
      windowId,
      app: result.app,
      appName: result.app.displayName,
      bundleId: result.app.bundleId,
      title: result.title ?? "",
    };
  }
  #evaluateWindowState(
    ownerId: UserId,
    computerId: ComputerTargetId,
    windowId: WindowId,
    app: ComputerAppIdentity | null | undefined,
    connections: readonly DeviceComputerConnection[],
    views: readonly ComputerView[],
  ): NativeTabTargetState {
    if (app && !this.#hasApprovedApp(connections, app))
      return unavailable("access-denied", "This app is unavailable.");
    const usedBy = this.#options.users(ownerId, computerId, windowId);
    const viewed = views.some(
      (view) =>
        view.state === "ready" && view.target.kind === "app" && view.target.windowId === windowId,
    );
    const generation = this.#generation(computerId);
    const key = this.#windowKey(computerId, windowId);
    const observed = this.#observed.get(key);
    if (observed && observed.generation === generation) {
      this.#touchObserved(key, observed);
    }
    const fresh =
      observed !== undefined &&
      observed.generation === generation &&
      this.#now() - observed.checkedAt < this.#refreshTtlMs;
    if (!fresh) {
      this.#refreshWindow(ownerId, computerId, windowId, generation);
    }
    if (observed && observed.generation === generation) {
      if (observed.kind === "live") {
        if (!this.#hasApprovedApp(connections, observed.app))
          return unavailable("access-denied", "This app is unavailable.");
      } else if (!viewed) {
        return unavailable(observed.code, observed.reason);
      }
    }
    return { state: usedBy.length || viewed ? "open" : "asleep", usedBy };
  }
  async windowState(
    ownerId: UserId,
    computerId: ComputerTargetId,
    windowId: WindowId,
    app?: ComputerAppIdentity | null,
  ): Promise<NativeTabTargetState> {
    const sentinel = "tab_single" as TabId;
    const states = await this.windowStates(ownerId, [
      { tabId: sentinel, computerId, windowId, app },
    ]);
    return states.get(sentinel)!;
  }
  async windowStates(
    ownerId: UserId,
    windows: readonly {
      readonly tabId: TabId;
      readonly computerId: ComputerTargetId;
      readonly windowId: WindowId;
      readonly app?: ComputerAppIdentity | null | undefined;
    }[],
  ): Promise<Map<TabId, NativeTabTargetState>> {
    const states = new Map<TabId, NativeTabTargetState>();
    if (!windows.length) return states;
    const byComputer = new Map<ComputerTargetId, (typeof windows)[number][]>();
    for (const entry of windows) {
      let group = byComputer.get(entry.computerId);
      if (!group) {
        group = [];
        byComputer.set(entry.computerId, group);
      }
      group.push(entry);
    }
    const computers = [...byComputer.keys()];
    const owned = new Map(
      await Promise.all(
        computers.map(async (computerId) => {
          try {
            return [computerId, await this.#options.owns(ownerId, computerId)] as const;
          } catch {
            return [computerId, false] as const;
          }
        }),
      ),
    );
    const ownedComputers = computers.filter((computerId) => owned.get(computerId));
    let allConnections: readonly DeviceComputerConnection[] | null = null;
    if (ownedComputers.length) {
      try {
        allConnections = await this.#options.connections(ownerId);
      } catch {
        allConnections = null;
      }
    }
    // Take one consistent connectivity cut after loading connection approvals.
    const connectedComputers = new Set(
      ownedComputers.filter((computerId) => this.#options.connected(computerId)),
    );
    const connectionsByComputer = new Map<ComputerTargetId, DeviceComputerConnection[]>();
    const computersNeedingViews: ComputerTargetId[] = [];
    if (allConnections) {
      for (const computerId of connectedComputers) {
        const filtered = this.#filterComputerConnections(allConnections, computerId);
        connectionsByComputer.set(computerId, filtered);
        const group = byComputer.get(computerId)!;
        if (group.some((entry) => !entry.app || this.#hasApprovedApp(filtered, entry.app))) {
          computersNeedingViews.push(computerId);
        }
      }
    }
    const viewsByComputer = new Map<ComputerTargetId, readonly ComputerView[]>(
      computersNeedingViews.length
        ? await Promise.all(
            computersNeedingViews.map(
              async (computerId) =>
                [computerId, await this.#options.views.list(ownerId, computerId)] as const,
            ),
          )
        : [],
    );
    for (const [computerId, group] of byComputer) {
      if (!owned.get(computerId) || !allConnections) {
        for (const entry of group)
          states.set(entry.tabId, unavailable("access-denied", "This computer is unavailable."));
        continue;
      }
      if (!connectedComputers.has(computerId)) {
        for (const entry of group)
          states.set(entry.tabId, unavailable("computer-offline", "This computer is offline."));
        continue;
      }
      const connections = connectionsByComputer.get(computerId) ?? [];
      const views = viewsByComputer.get(computerId) ?? [];
      for (const entry of group) {
        states.set(
          entry.tabId,
          this.#evaluateWindowState(
            ownerId,
            computerId,
            entry.windowId,
            entry.app,
            connections,
            views,
          ),
        );
      }
    }
    return states;
  }
  async phoneState(ownerId: UserId, computerId: ComputerTargetId): Promise<NativeTabTargetState> {
    let connections: readonly DeviceComputerConnection[];
    try {
      connections = await this.#connections(ownerId, computerId);
    } catch {
      return unavailable("access-denied", "This phone is unavailable.");
    }
    if (!this.#options.connected(computerId))
      return unavailable("computer-offline", "This phone is offline.");
    if (!connections.some((entry) => isPhoneDisplayDefinitionId(entry.definitionId)))
      return unavailable("access-denied", "This phone is unavailable.");
    const reason = this.#options.phoneUnavailable(computerId);
    if (reason === "unsupported")
      return unavailable(reason, "Live viewing is unavailable for this phone.");
    if (reason) return unavailable(reason, `This phone is ${reason}.`);
    const usedBy = this.#options.users(ownerId, computerId);
    const views = await this.#options.views.list(ownerId, computerId);
    const viewed = views.some((view) => view.state === "ready" && view.target.kind === "phone");
    const refusal = views.find(
      (view) =>
        view.target.kind === "phone" &&
        view.state === "unavailable" &&
        (view.unavailableReason === "paused" || view.unavailableReason === "protected"),
    );
    if (
      !viewed &&
      refusal &&
      (refusal.unavailableReason === "paused" || refusal.unavailableReason === "protected")
    )
      return unavailable(refusal.unavailableReason, `This phone is ${refusal.unavailableReason}.`);
    return { state: usedBy.length || viewed ? "open" : "asleep", usedBy };
  }
  async openOwnerView(
    ownerId: UserId,
    input: Omit<Parameters<DeviceNativeTabTargetsPort["openOwnerView"]>[1], "computerId"> & {
      computerId: ComputerTargetId;
    },
    key: string,
  ): Promise<ComputerView> {
    const view = await this.#options.views.openForTab(ownerId, input, key);
    this.observeView(view);
    return view;
  }
  closeOwnerViews(ownerId: UserId, tabId: TabId, tabGeneration: number): Promise<void> {
    return this.#options.views.closeTabViews(ownerId, tabId, tabGeneration);
  }
  onTargetAcquired(
    handler: NativeTargetAcquiredHandler,
    capture?: (ownerId: UserId) => Promise<number>,
  ): () => void {
    this.#capture = capture;
    if (this.#acquired) throw new Error("Native tab acquisition is already connected.");
    this.#acquired = handler;
    return () => {
      if (this.#acquired === handler) {
        this.#acquired = undefined;
        this.#capture = undefined;
      }
    };
  }
  async captureMembership(ownerId: UserId): Promise<number> {
    if (!this.#capture) throw refused("conflict", "The tab service is unavailable.");
    return this.#capture(ownerId);
  }
  async acquired(target: NativeTargetAcquired): Promise<TabId> {
    if (!this.#acquired) throw refused("conflict", "The tab service is unavailable.");
    return this.#acquired(target);
  }
}
export type NativeReplTabTarget = { tabGeneration: number } & (
  | { kind: "window"; computerId: ComputerTargetId; windowId: WindowId; app: ComputerAppIdentity }
  | { kind: "phone"; computerId: ComputerTargetId; driverGeneration?: number | undefined }
);
