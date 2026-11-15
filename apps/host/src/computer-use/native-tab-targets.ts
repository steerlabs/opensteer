import {
  refused,
  type ComputerAppIdentity,
  type RunnerId,
  type TabId,
  type UserId,
  type WindowId,
} from "@opensteer/core";
import { WindowIdSchema } from "@opensteer/core";
import type { ComputerView } from "@opensteer/protocol";
import {
  computerAppIdentitiesEqual,
  type IntegrationConnectionSummary,
} from "@opensteer/integration-core";
import type { ComputerViewService } from "./computer-view-service.js";
import type {
  NativeTabTargetsPort,
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
  connections(ownerId: UserId): Promise<readonly IntegrationConnectionSummary[]>;
  owns(ownerId: UserId, computerId: RunnerId): Promise<boolean>;
  connected(computerId: RunnerId): boolean;
  /** Lease-free window.resolve on the current authenticated helper connection. */
  queryWindow(
    computerId: RunnerId,
    input: { windowId: WindowId } | { app: ComputerAppIdentity },
  ): Promise<NativeWindowQueryResult>;
  users(ownerId: UserId, computerId: RunnerId, windowId?: WindowId): NativeTabTargetState["usedBy"];
  phoneUnavailable(computerId: RunnerId): "paused" | "protected" | "unsupported" | null;
}
const unavailable = (
  unavailableCode: Extract<NativeTabTargetState, { state: "unavailable" }>["unavailableCode"],
  unavailableReason: string,
): NativeTabTargetState => ({
  state: "unavailable",
  unavailableCode,
  unavailableReason,
  usedBy: [],
});

export class NativeTabTargets implements NativeTabTargetsPort {
  readonly #options: NativeTabTargetsOptions;
  #acquired: NativeTargetAcquiredHandler | undefined;
  constructor(options: NativeTabTargetsOptions) {
    this.#options = options;
  }
  async #connections(ownerId: UserId, computerId: RunnerId) {
    if (!(await this.#options.owns(ownerId, computerId)))
      throw refused("not_found", "This computer is unavailable.");
    return (await this.#options.connections(ownerId)).filter(
      (entry) => entry.computer?.runnerId === computerId && !entry.computer.blockedAt,
    );
  }
  async resolveWindow(
    ownerId: UserId,
    computerId: RunnerId,
    target: { windowId: WindowId } | { bundleId: string },
  ): Promise<ResolvedTabWindow> {
    const connections = await this.#connections(ownerId, computerId);
    if (!this.#options.connected(computerId))
      throw refused("runner_offline", "This computer is offline.");
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
      !current.some(
        (entry) =>
          entry.computer?.app && computerAppIdentitiesEqual(entry.computer.app, result.app!),
      )
    )
      throw refused(
        "not_found",
        result.unavailableReason === "window-closed"
          ? "Window closed"
          : "This window's identity is no longer available.",
      );
    return {
      windowId: WindowIdSchema.parse(result.windowId),
      app: result.app,
      appName: result.app.displayName,
      bundleId: result.app.bundleId,
      title: result.title ?? "",
    };
  }
  async windowState(
    ownerId: UserId,
    computerId: RunnerId,
    windowId: WindowId,
  ): Promise<NativeTabTargetState> {
    let connections: readonly IntegrationConnectionSummary[];
    try {
      connections = await this.#connections(ownerId, computerId);
    } catch {
      return unavailable("access-denied", "This computer is unavailable.");
    }
    if (!this.#options.connected(computerId))
      return unavailable("computer-offline", "This computer is offline.");
    let result: NativeWindowQueryResult;
    try {
      result = await this.#options.queryWindow(computerId, { windowId });
    } catch {
      return this.#options.connected(computerId)
        ? unavailable("runtime-failed", "This window is unavailable.")
        : unavailable("computer-offline", "This computer is offline.");
    }
    try {
      connections = await this.#connections(ownerId, computerId);
    } catch {
      return unavailable("access-denied", "This computer is unavailable.");
    }
    if (!this.#options.connected(computerId))
      return unavailable("computer-offline", "This computer is offline.");
    if (result.unavailableReason) {
      const reason = result.unavailableReason;
      if (reason === "window-closed") return unavailable(reason, "Window closed");
      if (reason === "window-identity-lost")
        return unavailable(reason, "This window's identity is no longer available.");
      if (reason === "locked" || reason === "minimized" || reason === "unsupported")
        return unavailable(reason, `This window is ${reason}.`);
      return unavailable("runtime-failed", "This window is unavailable.");
    }
    if (
      result.windowId !== windowId ||
      !result.app ||
      !connections.some(
        (entry) =>
          entry.computer?.app && computerAppIdentitiesEqual(entry.computer.app, result.app!),
      )
    )
      return unavailable("access-denied", "This app is unavailable.");
    const usedBy = this.#options.users(ownerId, computerId, windowId);
    const views = await this.#options.views.list(ownerId, computerId);
    const viewed = views.some(
      (view) =>
        view.state === "ready" && view.target.kind === "app" && view.target.windowId === windowId,
    );
    return { state: usedBy.length || viewed ? "open" : "asleep", usedBy };
  }
  async phoneState(ownerId: UserId, computerId: RunnerId): Promise<NativeTabTargetState> {
    let connections: readonly IntegrationConnectionSummary[];
    try {
      connections = await this.#connections(ownerId, computerId);
    } catch {
      return unavailable("access-denied", "This phone is unavailable.");
    }
    if (!this.#options.connected(computerId))
      return unavailable("computer-offline", "This phone is offline.");
    if (!connections.some((entry) => entry.definitionId === "android-phone"))
      return unavailable("access-denied", "This phone is unavailable.");
    const reason = this.#options.phoneUnavailable(computerId);
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
  openOwnerView(
    ownerId: UserId,
    input: Parameters<NativeTabTargetsPort["openOwnerView"]>[1],
    key: string,
  ): Promise<ComputerView> {
    return this.#options.views.openForTab(ownerId, input, key);
  }
  closeOwnerViews(ownerId: UserId, tabId: TabId, tabGeneration: number): Promise<void> {
    return this.#options.views.closeTabViews(ownerId, tabId, tabGeneration);
  }
  onTargetAcquired(handler: NativeTargetAcquiredHandler): () => void {
    if (this.#acquired) throw new Error("Native tab acquisition is already connected.");
    this.#acquired = handler;
    return () => {
      if (this.#acquired === handler) this.#acquired = undefined;
    };
  }
  async acquired(target: NativeTargetAcquired): Promise<TabId> {
    if (!this.#acquired) throw refused("conflict", "The tab service is unavailable.");
    return this.#acquired(target);
  }
}
export type NativeReplTabTarget = { tabGeneration: number } & (
  | { kind: "window"; computerId: RunnerId; windowId: WindowId; app: ComputerAppIdentity }
  | { kind: "phone"; computerId: RunnerId }
);
