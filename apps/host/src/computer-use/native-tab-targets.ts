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
    }
  | {
      readonly kind: "unavailable";
      readonly computerId: ComputerTargetId;
      readonly code: WindowUnavailableCode;
      readonly reason: string;
      readonly checkedAt: number;
      readonly generation: number;
    };
const defaultWindowRefreshTtlMs = 30_000;
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
  readonly #generations = new Map<ComputerTargetId, number>();
  readonly #observed = new Map<string, ObservedWindow>();
  readonly #inFlight = new Map<string, Promise<void>>();
  #acquired: NativeTargetAcquiredHandler | undefined;
  #capture: ((ownerId: UserId) => Promise<number>) | undefined;
  constructor(options: NativeTabTargetsOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#refreshTtlMs = options.windowRefreshTtlMs ?? defaultWindowRefreshTtlMs;
  }
  #generation(computerId: ComputerTargetId): number {
    return this.#generations.get(computerId) ?? 0;
  }
  #windowKey(computerId: ComputerTargetId, windowId: WindowId): string {
    return `${computerId}:${windowId}`;
  }
  #hasApprovedApp(
    connections: readonly DeviceComputerConnection[],
    app: ComputerAppIdentity,
  ): boolean {
    return connections.some(
      (entry) => entry.computer?.app && computerAppIdentitiesEqual(entry.computer.app, app),
    );
  }
  forgetComputer(computerId: ComputerTargetId): void {
    this.#generations.set(computerId, this.#generation(computerId) + 1);
    for (const [key, entry] of this.#observed) {
      if (entry.computerId === computerId) this.#observed.delete(key);
    }
    const prefix = `${computerId}:`;
    for (const key of this.#inFlight.keys()) {
      if (key.startsWith(prefix)) this.#inFlight.delete(key);
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
      };
    }
    if (!next) return false;
    this.#observed.set(key, next);
    return !sameObservedProjection(previous, next);
  }
  #observeQueryResult(
    computerId: ComputerTargetId,
    windowId: WindowId,
    result: NativeWindowQueryResult,
    generation: number,
  ): ObservedWindow {
    const checkedAt = this.#now();
    if (result.unavailableReason) {
      const mapped = mapWindowUnavailableReason(result.unavailableReason);
      return {
        kind: "unavailable",
        computerId,
        code: mapped.code,
        reason: mapped.reason,
        checkedAt,
        generation,
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
      };
    }
    return {
      kind: "live",
      computerId,
      app: result.app,
      checkedAt,
      generation,
    };
  }
  #refreshWindow(
    ownerId: UserId,
    computerId: ComputerTargetId,
    windowId: WindowId,
    generation: number,
  ): void {
    const key = this.#windowKey(computerId, windowId);
    if (this.#inFlight.has(key)) return;
    const probe = (async () => {
      let next: ObservedWindow;
      try {
        const result = await this.#options.queryWindow(computerId, { windowId });
        if (this.#generation(computerId) !== generation || !this.#options.connected(computerId))
          return;
        next = this.#observeQueryResult(computerId, windowId, result, generation);
      } catch {
        if (this.#generation(computerId) !== generation || !this.#options.connected(computerId))
          return;
        next = {
          kind: "unavailable",
          computerId,
          code: "runtime-failed",
          reason: "This window is unavailable.",
          checkedAt: this.#now(),
          generation,
        };
      }
      const previous = this.#observed.get(key);
      this.#observed.set(key, next);
      if (!sameObservedProjection(previous, next)) {
        this.#options.onWindowStateChanged?.(ownerId, computerId, windowId);
      }
    })().finally(() => {
      if (this.#inFlight.get(key) === probe) this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, probe);
  }
  async #connections(ownerId: UserId, computerId: ComputerTargetId) {
    if (!(await this.#options.owns(ownerId, computerId)))
      throw refused("not_found", "This computer is unavailable.");
    return (await this.#options.connections(ownerId)).filter(
      (entry) =>
        entry.computer &&
        computerConnectionDeviceId(entry) === computerId &&
        !entry.computer.blockedAt,
    );
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
      this.#observed.set(this.#windowKey(computerId, windowId), {
        kind: "live",
        computerId,
        app: result.app,
        checkedAt: this.#now(),
        generation,
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
  async windowState(
    ownerId: UserId,
    computerId: ComputerTargetId,
    windowId: WindowId,
    app?: ComputerAppIdentity | null,
  ): Promise<NativeTabTargetState> {
    let connections: readonly DeviceComputerConnection[];
    try {
      connections = await this.#connections(ownerId, computerId);
    } catch {
      return unavailable("access-denied", "This computer is unavailable.");
    }
    if (!this.#options.connected(computerId))
      return unavailable("computer-offline", "This computer is offline.");
    if (app && !this.#hasApprovedApp(connections, app))
      return unavailable("access-denied", "This app is unavailable.");
    const usedBy = this.#options.users(ownerId, computerId, windowId);
    const views = await this.#options.views.list(ownerId, computerId);
    const viewed = views.some(
      (view) =>
        view.state === "ready" && view.target.kind === "app" && view.target.windowId === windowId,
    );
    const generation = this.#generation(computerId);
    const key = this.#windowKey(computerId, windowId);
    const observed = this.#observed.get(key);
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
      } else if (!viewed && !usedBy.length) {
        return unavailable(observed.code, observed.reason);
      }
    }
    return { state: usedBy.length || viewed ? "open" : "asleep", usedBy };
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
