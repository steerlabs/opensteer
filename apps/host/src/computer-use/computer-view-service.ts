import { sameDeviceDriver } from "./device-drivers.js";
import type { DeviceDriverIdentity } from "@opensteer/core";
import {
  computerConnectionDeviceId,
  type DeviceComputerConnection,
  type DeviceDriverRoute,
  type DeviceDisplayAuthorization,
} from "./device-drivers.js";
import type { ComputerTargetId } from "../computer-apps/computer-app-hub.js";
import type { DeviceId } from "@opensteer/core";
import { randomUUID } from "node:crypto";
import {
  OpensteerError,
  DeviceIdSchema,
  isPhoneDisplayDefinitionId,
  ComputerViewUnavailableReasonSchema,
  type ComputerViewRecord,
  type UserId,
} from "@opensteer/core";
import { computerAppIdentitiesEqual } from "@opensteer/integration-core";
import {
  ComputerViewIdSchema,
  ComputerViewSchema,
  ComputerViewRefusalReasonSchema,
  computerAppIdentityKey,
  computerViewIdleMs,
  computerViewMaxPerOwner,
  type ComputerView,
  type DisplaySource,
  type DisplayStreamReason,
  type ComputerViewTarget,
  type ComputerAppIdentity,
  type OwnerWindowInfo,
  type ComputerViewCloseCommand,
  type ComputerViewRenewCommand,
  type HostToClientMessage,
  type ComputerViewRefusalReason,
  ComputerViewNativeResultSchema,
  OwnerWindowInfoSchema,
} from "@opensteer/protocol";
import type { ComputerAppHub } from "../computer-apps/computer-app-hub.js";

export interface PhoneViewDiagnostic {
  readonly machineId: ComputerTargetId;
  readonly operation: "tab.view.open" | "computer.view.renew" | "computer.view.close";
  readonly viewId: ComputerView["viewId"] | null;
  readonly generation: number | null;
  readonly state: ComputerView["state"] | "requested" | "refused";
  readonly reason: ComputerView["unavailableReason"] | ComputerViewRefusalReason | null;
  readonly expiresAt: string | null;
}

interface Options {
  readonly selfDeviceId?: (runnerId: import("@opensteer/core").RunnerId) => Promise<DeviceId>;
  readonly onPhoneView?: (status: PhoneViewDiagnostic) => void;
  readonly hub: Pick<ComputerAppHub, "ownerViewSupported" | "withRunnerAdmission" | "attached"> &
    Partial<Pick<ComputerAppHub, "withDeviceAdmission" | "captureRoute" | "routeCurrent">> & {
      sendComputerView(input: {
        runnerId: ComputerTargetId;
        route?: DeviceDriverRoute | undefined;
        request: {
          viewId: string;
          generation: number;
          leaseDurationMs: number;
          target: ComputerViewTarget;
          operation: "open" | "renew" | "close";
          timeoutMs: number;
        };
        signal?: AbortSignal;
      }): Promise<
        | { kind: "ok"; value: import("@opensteer/protocol").ComputerViewNativeResult }
        | { kind: "error"; code: string; message: string }
      >;
      ownerWindows(
        deviceId: ComputerTargetId,
        app: ComputerAppIdentity,
        options: { timeoutMs: number; signal?: AbortSignal },
      ): Promise<unknown>;
    };
  readonly connections: (owner: UserId) => Promise<readonly DeviceComputerConnection[]>;
  readonly owners: (
    ids: readonly ComputerTargetId[],
  ) => Promise<ReadonlyMap<ComputerTargetId, { readonly effectiveOwner: UserId | null }>>;
  readonly changed: (
    owner: UserId,
    message: Extract<
      HostToClientMessage,
      { type: "host.computer-view.changed" | "host.computer-view.removed" }
    >,
  ) => void;
  readonly ended?: (
    viewId: ComputerView["viewId"],
    generation: number,
    reason: "closed" | "expired" | "revoked" | "disconnected" | "host-restarted",
  ) => void;
  readonly log?: (event: string, details: Readonly<Record<string, unknown>>) => void;
  readonly now?: () => number;
}
type OpenViewCommand = {
  type: "tab.view.open";
  idempotencyKey: string;
  machineId: DeviceId;
  target: ComputerViewTarget;
  tabId: string;
  tabGeneration: number;
};
type ViewCommand = OpenViewCommand | ComputerViewCloseCommand | ComputerViewRenewCommand;
type ApprovedNativeApp = {
  connectionId: string;
  machineId: DeviceId;
  target: { kind: "app"; app: ComputerAppIdentity } | { kind: "phone"; display: string };
  name: string;
  iconPng: null;
};
interface HeldView {
  route?: DeviceDriverRoute | undefined;
  readonly deviceId: ComputerTargetId;
  record: ComputerViewRecord;
  timer: NodeJS.Timeout | null;
  tabId: string;
  tabGeneration: number;
}

/** Ephemeral owner authority. No task, grant, observation or app reservation is borrowed. */
export class ComputerViewService {
  readonly #options: Options;
  readonly #views = new Map<string, HeldView>();
  readonly #commands = new Map<string, { fingerprint: string; result: Promise<ComputerView> }>();
  readonly #turns = new Map<UserId, Promise<unknown>>();
  /** Each tab's last closed generation: an open received before one must not outlive it. */
  readonly #tabCloses = new Map<string, number>();
  readonly #now: () => number;
  #closed = false;
  constructor(options: Options) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async approved(owner: UserId): Promise<ApprovedNativeApp[]> {
    const connections = await this.#options.connections(owner);
    const owners = await this.#options.owners([
      ...new Set(
        connections.flatMap((connection) =>
          computerConnectionDeviceId(connection) ? [computerConnectionDeviceId(connection)!] : [],
        ),
      ),
    ]);
    return connections.flatMap((connection) =>
      connection.computer &&
      owners.get(computerConnectionDeviceId(connection)!)?.effectiveOwner === owner
        ? (approvedApp(connection) ?? [])
        : [],
    );
  }

  async windows(
    owner: UserId,
    machine: ComputerTargetId,
    app: ComputerAppIdentity,
  ): Promise<OwnerWindowInfo[]> {
    const target = { kind: "app" as const, app };
    try {
      const { approved, outcome } = await (
        this.#options.hub.withDeviceAdmission?.bind(this.#options.hub) ??
        this.#options.hub.withRunnerAdmission.bind(this.#options.hub)
      )(machine, async () => {
        const approved = await this.#approvedTarget(owner, machine, target);
        return {
          approved,
          outcome: this.#options.hub.ownerWindows(machine, app, { timeoutMs: 8_000 }),
        };
      });
      const windows = OwnerWindowInfoSchema.array().parse(await outcome);
      const current = await this.#approvedTarget(owner, machine, target);
      if (current.connectionId !== approved.connectionId)
        throw this.#refusal("computer-view-not-approved", "This approval changed.");
      return windows;
    } catch (error) {
      // A refused list only hides the person's window picker; this is its one trace.
      this.#options.log?.("computer.app.windows", {
        machineId: machine,
        bundleId: app.bundleId,
        reason: error instanceof OpensteerError ? (error.reason ?? error.code) : "failed",
      });
      throw error;
    }
  }

  async list(owner: UserId, machine: ComputerTargetId): Promise<ComputerView[]> {
    return [...this.#views.values()]
      .filter(
        ({ record, deviceId }) =>
          record.ownerUserId === owner &&
          deviceId === machine &&
          record.state !== "closed" &&
          record.state !== "expired" &&
          Date.parse(record.expiresAt) > this.#now(),
      )
      .map((view) => this.#public(view));
  }

  /** Whether a view of this phone is live: one that ended cannot keep its tab open. */
  holdsPhoneView(machine: ComputerTargetId): boolean {
    return [...this.#views.values()].some(
      (view) =>
        view.deviceId === machine && view.record.target.kind === "phone" && this.#live(view),
    );
  }

  openForTab(
    owner: UserId,
    input: {
      tabId: string;
      tabGeneration: number;
      computerId: ComputerTargetId;
      target: ComputerViewTarget;
    },
    key: string,
  ): Promise<ComputerView> {
    return this.command(owner, {
      type: "tab.view.open",
      idempotencyKey: key,
      machineId: DeviceIdSchema.parse(input.computerId),
      ...input,
    });
  }

  async closeTabViews(owner: UserId, tabId: string, tabGeneration: number): Promise<void> {
    const key = `${owner}:${tabId}`;
    this.#tabCloses.set(key, Math.max(this.#tabCloses.get(key) ?? 0, tabGeneration));
    for (const view of this.#views.values())
      if (
        view.record.ownerUserId === owner &&
        view.tabId === tabId &&
        view.tabGeneration <= tabGeneration
      )
        this.#end(view, "closed");
  }

  async command(owner: UserId, command: ViewCommand): Promise<ComputerView> {
    const held = command.type === "tab.view.open" ? null : this.#views.get(command.viewId);
    const phone =
      command.type === "tab.view.open"
        ? command.target.kind === "phone"
        : held?.record.target.kind === "phone" && held.record.ownerUserId === owner;
    const machineId = command.type === "tab.view.open" ? command.machineId : held?.deviceId;
    const report = (
      state: PhoneViewDiagnostic["state"],
      view?: ComputerView,
      reason?: ComputerViewRefusalReason,
    ) => {
      if (!phone || !machineId) return;
      this.#options.onPhoneView?.({
        machineId,
        operation: command.type,
        viewId: view?.viewId ?? (command.type === "tab.view.open" ? null : command.viewId),
        generation:
          view?.generation ?? (command.type === "tab.view.open" ? null : command.generation),
        state,
        reason: reason ?? view?.unavailableReason ?? null,
        expiresAt: view?.expiresAt ?? null,
      });
    };
    report("requested");
    try {
      const view = await this.#dispatch(owner, command);
      report(view.state, view);
      return view;
    } catch (error) {
      const reason = ComputerViewRefusalReasonSchema.safeParse(
        error instanceof OpensteerError ? error.reason : null,
      );
      report("refused", undefined, reason.success ? reason.data : undefined);
      throw error;
    }
  }

  #dispatch(owner: UserId, command: ViewCommand): Promise<ComputerView> {
    const key = `${owner}:${command.idempotencyKey}`;
    const fingerprint = JSON.stringify(command);
    const previous = this.#commands.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        return Promise.reject(
          this.#refusal("computer-view-idempotency-conflict", "Idempotency key already used."),
        );
      return previous.result.then(async (view) => {
        // A replay can return its old generation, but cannot reattach a revoked/expired one.
        const held = this.#views.get(view.viewId);
        if (held?.record.generation === view.generation && this.#live(held))
          await this.#authorize(held, owner);
        return held?.record.generation === view.generation ? this.#public(held) : view;
      });
    }
    const receivedAt = this.#now();
    const tabCloses =
      command.type === "tab.view.open"
        ? (this.#tabCloses.get(`${owner}:${command.tabId}`) ?? 0)
        : 0;
    const before = this.#turns.get(owner) ?? Promise.resolve();
    // Revocation cannot wait for a native open/renew answer already in flight.
    const result =
      command.type === "computer.view.close"
        ? this.#command(owner, command, receivedAt, tabCloses)
        : before
            .catch(() => undefined)
            .then(() => this.#command(owner, command, receivedAt, tabCloses));
    this.#commands.set(key, { fingerprint, result });
    if (command.type !== "computer.view.close") {
      this.#turns.set(owner, result);
      void result
        .finally(() => {
          if (this.#turns.get(owner) === result) this.#turns.delete(owner);
        })
        .catch(() => undefined);
    }
    if (this.#commands.size > 1000) this.#commands.delete(this.#commands.keys().next().value!);
    return result;
  }

  async #command(
    owner: UserId,
    command: ViewCommand,
    receivedAt: number,
    tabCloses: number,
  ): Promise<ComputerView> {
    if (this.#closed)
      throw this.#refusal("computer-view-ended", "The Host ended this view. Reopen it explicitly.");
    if (command.type === "tab.view.open") {
      const approved = await this.#approvedTarget(owner, command.machineId, command.target);
      if (
        (this.#tabCloses.get(`${owner}:${command.tabId}`) ?? 0) >= command.tabGeneration ||
        (this.#tabCloses.get(`${owner}:${command.tabId}`) ?? 0) !== tabCloses
      )
        throw this.#refusal("computer-view-ended", "This tab was closed.");
      const held = [...this.#views.values()].find(
        ({ record, deviceId }) =>
          record.ownerUserId === owner &&
          deviceId === command.machineId &&
          sameViewTarget(record.target, command.target) &&
          this.#views.get(record.viewId)?.tabId === command.tabId &&
          this.#views.get(record.viewId)?.tabGeneration === command.tabGeneration,
      );
      if (held && this.#live(held) && held.record.state === "ready") {
        await this.#authorize(held, owner);
        return this.#public(held);
      }
      if (
        [...this.#views.values()].filter(
          (view) => view !== held && view.record.ownerUserId === owner && this.#live(view),
        ).length >= computerViewMaxPerOwner
      )
        throw this.#refusal("computer-view-limit", "Close a view before opening another.");
      if (held) this.#end(held, "closed");
      const now = this.#now();
      const view: HeldView = {
        timer: null,
        deviceId: command.machineId,
        tabId: command.tabId,
        tabGeneration: command.tabGeneration,
        record: {
          ownerUserId: owner,
          connectionId: approved.connectionId,
          machineId: DeviceIdSchema.parse(command.machineId),
          target: command.target,
          window: null,
          viewId: held?.record.viewId ?? ComputerViewIdSchema.parse(`cvw_${randomUUID()}`),
          generation: (held?.record.generation ?? 0) + 1,
          captureTargetId: null,
          state: "opening",
          openedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + computerViewIdleMs[command.target.kind]).toISOString(),
          unavailableReason: null,
        },
      };
      this.#views.set(view.record.viewId, view);
      this.#log(view, "open");
      this.#arm(view);
      try {
        const result = await this.#send(view, "open");
        await this.#authorize(view, owner);
        if (result.kind === "error")
          throw this.#refusal(
            result.code === "unsupported"
              ? "computer-view-unsupported"
              : "computer-view-unavailable",
            result.message,
          );
        if (
          "kind" in result.value &&
          result.value.kind === "unavailable" &&
          result.value.viewId === view.record.viewId &&
          result.value.generation === view.record.generation
        ) {
          const reason = ComputerViewUnavailableReasonSchema.safeParse(result.value.reason);
          view.record = {
            ...view.record,
            state: "unavailable",
            captureTargetId: null,
            unavailableReason: reason.success ? reason.data : "target-unavailable",
          };
          this.#publish(view);
          return this.#public(view);
        }
        if (
          !("state" in result.value) ||
          result.value.state !== "ready" ||
          (view.record.target.kind === "app" &&
            (!result.value.captureTargetId ||
              !result.value.window ||
              view.record.target.windowId !== result.value.window.windowId)) ||
          result.value.viewId !== view.record.viewId ||
          result.value.generation !== view.record.generation
        )
          throw this.#refusal(
            "computer-view-unavailable",
            "This app or display is unavailable. Reopen it explicitly.",
          );
        const window = result.value.window ?? null;
        if (
          [...this.#views.values()].filter(
            (candidate) => candidate.record.ownerUserId === owner && this.#live(candidate),
          ).length > computerViewMaxPerOwner
        )
          throw this.#refusal("computer-view-limit", "Close a view before opening another.");
        view.record = {
          ...view.record,
          state: "ready",
          window,
          captureTargetId: result.value.captureTargetId,
        };
        this.#publish(view);
        return this.#public(view);
      } catch (error) {
        this.#end(view, "closed");
        throw error;
      }
    }
    const held = this.#get(owner, command);
    if (command.type === "computer.view.close") {
      this.#end(held, "closed");
      return this.#public(held);
    }
    await this.#authorize(held, owner);
    if (held.record.state !== "ready")
      throw this.#refusal(
        "computer-view-unavailable",
        "This target is unavailable. Reopen it explicitly.",
      );
    const expiresAt = new Date(
      receivedAt + computerViewIdleMs[held.record.target.kind],
    ).toISOString();
    const previous = held.record;
    held.record = { ...previous, expiresAt };
    this.#arm(held);
    this.#publish(held);
    const result = await this.#send(held, "renew");
    await this.#authorize(held, owner);
    const terminal =
      result.kind === "error"
        ? result.code === "ended" || result.code === "stale-generation"
        : result.value.viewId !== held.record.viewId ||
          result.value.generation !== held.record.generation ||
          ("state" in result.value
            ? result.value.state === "closed"
            : result.value.kind === "unavailable" && result.value.reason === "ended");
    if (terminal) {
      this.#end(held, "closed");
      throw this.#refusal(
        "computer-view-ended",
        "The computer ended this view. Reopen it explicitly.",
      );
    }
    if (result.kind !== "ok" || !("state" in result.value) || result.value.state !== "ready")
      throw this.#refusal(
        "computer-view-unavailable",
        "The computer could not renew this view yet. Try again.",
      );

    return this.#public(held);
  }

  async authorizeDisplay(
    source: Extract<DisplaySource, { kind: "owner-view" }>,
    owner: UserId,
  ): Promise<DeviceDisplayAuthorization> {
    const held = this.#get(owner, source);
    await this.#authorize(held, owner);
    if (held.record.state !== "ready")
      throw this.#refusal("computer-view-ended", "That phone view has ended.");
    return { deviceId: DeviceIdSchema.parse(held.deviceId), route: held.route };
  }
  async authorizeInput(
    source: Extract<DisplaySource, { kind: "owner-view" }>,
    owner: UserId,
  ): Promise<DeviceDisplayAuthorization> {
    const held = this.#get(owner, source);
    await this.#authorize(held, owner);
    const connections = await this.#options.connections(owner);
    const approved = connections.find((connection) => connection.id === held.record.connectionId);
    if (
      held.record.state !== "ready" ||
      !this.#live(held) ||
      approved?.status !== "connected" ||
      approved.computer?.access !== "read-write" ||
      approved.computer.blockedAt !== null ||
      computerConnectionDeviceId(approved) !== held.deviceId ||
      (held.record.target.kind === "app"
        ? !approved.computer.app ||
          !computerAppIdentitiesEqual(approved.computer.app, held.record.target.app)
        : !isPhoneDisplayDefinitionId(approved.definitionId) || approved.computer.app !== null)
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Input requires a current read-write approval.",
      });
    return { deviceId: DeviceIdSchema.parse(held.deviceId), route: held.route };
  }
  isDisplayLive(
    source: Extract<DisplaySource, { kind: "owner-view" }>,
    owner: UserId,
    machine: ComputerTargetId,
  ): boolean {
    const held = this.#views.get(source.viewId);
    return (
      held !== undefined &&
      held.record.ownerUserId === owner &&
      held.deviceId === machine &&
      held.record.generation === source.generation &&
      held.record.state === "ready" &&
      this.#live(held)
    );
  }
  endDisplaySource(
    source: Extract<DisplaySource, { kind: "owner-view" }>,
    machine: ComputerTargetId,
    reason: DisplayStreamReason,
  ): void {
    const held = this.#views.get(source.viewId);
    if (!held || held.deviceId !== machine || held.record.generation !== source.generation) return;
    if (
      [
        "capacity",
        "capture-timeout",
        "capture-failed",
        "encoder-failed",
        "window-closed",
        "minimized",
        "permission-required",
        "sharing-stopped",
        "target-unavailable",
      ].includes(reason)
    ) {
      if (held.timer) clearTimeout(held.timer);
      held.timer = null;
      held.record = {
        ...held.record,
        state: "unavailable",
        captureTargetId: null,
        unavailableReason:
          reason === "capacity" ||
          reason === "capture-timeout" ||
          reason === "window-closed" ||
          reason === "minimized" ||
          reason === "permission-required"
            ? reason
            : "capture-failed",
      };
      this.#publish(held);
      void this.#send(held, "close").catch(() => undefined);
      return;
    }
    this.#end(
      held,
      reason === "owner-expired" ? "expired" : reason === "owner-revoked" ? "revoked" : "closed",
    );
  }

  forgetRunner(
    runnerId: import("@opensteer/core").RunnerId,
    displayReason?: "device-restarting",
  ): void {
    for (const held of this.#views.values())
      if (held.route?.runnerId === runnerId || (!held.route && held.deviceId === runnerId))
        this.#end(held, "disconnected", displayReason);
  }
  forgetDriver(binding: DeviceDriverIdentity): void {
    for (const held of this.#views.values())
      if (sameDeviceDriver(held.route, binding)) this.#end(held, "disconnected");
  }
  forgetDevice(deviceId: ComputerTargetId): void {
    this.disconnect(deviceId);
  }
  disconnect(machine: ComputerTargetId): void {
    for (const held of this.#views.values())
      if (held.deviceId === machine) this.#end(held, "disconnected");
  }
  async revalidate(): Promise<void> {
    await Promise.all(
      [...this.#views.values()]
        .filter((view) => this.#live(view))
        .map(async (view) => {
          try {
            await this.#authorize(view, view.record.ownerUserId);
          } catch {
            /* Authorization ends the generation. */
          }
        }),
    );
  }
  shutdown(): void {
    this.#closed = true;
    for (const view of this.#views.values()) this.#end(view, "host-restarted");
    this.#views.clear();
    this.#commands.clear();
  }

  async #approvedTarget(
    owner: UserId,
    machine: ComputerTargetId,
    target: ApprovedNativeApp["target"],
  ): Promise<ApprovedNativeApp> {
    const [owners, connections] = await Promise.all([
      this.#options.owners([machine]),
      this.#options.connections(owner),
    ]);
    if (owners.get(machine)?.effectiveOwner !== owner)
      throw new OpensteerError({
        code: "forbidden",
        message: "Only this computer's owner can view it.",
      });
    const app = connections
      .flatMap((connection) => approvedApp(connection) ?? [])
      .find((app) => app.machineId === machine && sameApprovedTarget(app.target, target));
    if (!app)
      throw this.#refusal(
        "computer-view-not-approved",
        "This app or phone needs an existing connected approval.",
      );
    if (!this.#options.hub.attached(machine))
      throw this.#refusal("computer-view-unavailable", "This computer is offline.");
    if (!this.#options.hub.ownerViewSupported(machine))
      throw this.#refusal(
        "computer-view-unsupported",
        "Update this computer to view apps and devices.",
      );
    return app;
  }
  async #authorize(view: HeldView, owner: UserId): Promise<void> {
    if (!this.#live(view))
      throw this.#refusal("computer-view-ended", "The view ended. Reopen it explicitly.");
    try {
      const approved = await this.#approvedTarget(owner, view.deviceId, view.record.target);
      if (approved.connectionId !== view.record.connectionId)
        throw this.#refusal("computer-view-not-approved", "This approval changed.");
      if (!this.#live(view)) throw this.#refusal("computer-view-ended", "The view ended.");
    } catch (error) {
      this.#end(view, "revoked");
      throw error;
    }
  }
  #get(owner: UserId, input: Pick<ComputerViewCloseCommand, "viewId" | "generation">): HeldView {
    const held = this.#views.get(input.viewId);
    if (!held || held.record.ownerUserId !== owner)
      throw this.#refusal("computer-view-ended", "View not found. Reopen it explicitly.");
    if (held.record.generation !== input.generation)
      throw this.#refusal(
        "computer-view-stale-generation",
        "This view was replaced. Reopen it explicitly.",
      );
    return held;
  }
  #live(view: HeldView): boolean {
    if (view.route && !this.#options.hub.routeCurrent?.(view.route)) return false;
    if (
      this.#closed ||
      this.#views.get(view.record.viewId) !== view ||
      (view.record.state !== "ready" && view.record.state !== "opening")
    )
      return false;
    if (Date.parse(view.record.expiresAt) <= this.#now()) {
      this.#end(view, "expired");
      return false;
    }
    return true;
  }
  #arm(view: HeldView): void {
    if (view.timer) clearTimeout(view.timer);
    view.timer = setTimeout(
      () => this.#end(view, "expired"),
      Math.max(1, Date.parse(view.record.expiresAt) - this.#now()),
    );
    view.timer.unref();
  }
  #end(
    view: HeldView,
    reason: "closed" | "expired" | "revoked" | "disconnected" | "host-restarted",
    displayReason?: "device-restarting",
  ): void {
    if (view.record.state === "closed" || view.record.state === "expired") return;
    if (view.timer) clearTimeout(view.timer);
    view.timer = null;
    view.record = {
      ...view.record,
      captureTargetId: null,
      state: reason === "expired" ? "expired" : "closed",
      unavailableReason:
        reason === "revoked"
          ? "connection-revoked"
          : reason === "disconnected"
            ? "offline"
            : reason,
    };
    this.#log(view, "closed", reason);
    this.#options.ended?.(view.record.viewId, view.record.generation, reason);
    this.#options.changed(view.record.ownerUserId, {
      type: "host.computer-view.removed",
      viewId: view.record.viewId,
      generation: view.record.generation,
      machineId: DeviceIdSchema.parse(view.deviceId),
      reason,
      ...(displayReason === undefined ? {} : { displayReason }),
    });
    if (reason !== "disconnected") void this.#send(view, "close").catch(() => undefined);
    // Closed generations are needed only for bounded command replay and stale-generation checks.
    if (this.#views.size > 1000) {
      const terminal = [...this.#views.values()].find(
        (candidate) => candidate.record.state === "closed" || candidate.record.state === "expired",
      );
      if (terminal) this.#views.delete(terminal.record.viewId);
    }
  }
  #public(view: HeldView): ComputerView {
    return ComputerViewSchema.parse({
      ...view.record,
      ...(view.route?.role === "screen" ? { driverGeneration: view.route.generation } : {}),
    });
  }
  #log(view: HeldView, transition: string, reason?: string): void {
    this.#options.log?.("computer.view.lifecycle", {
      transition,
      reason: reason ?? transition,
      machineId: view.record.machineId,
      viewId: view.record.viewId,
      generation: view.record.generation,
    });
  }
  #publish(view: HeldView): void {
    this.#log(
      view,
      view.record.state === "unavailable" ? "failed" : view.record.state,
      view.record.unavailableReason ?? undefined,
    );
    this.#options.changed(view.record.ownerUserId, {
      type: "host.computer-view.changed",
      view: this.#public(view),
    });
  }
  #send(view: HeldView, operation: "open" | "close" | "renew", signal?: AbortSignal) {
    return (
      this.#options.hub.withDeviceAdmission?.bind(this.#options.hub) ??
      this.#options.hub.withRunnerAdmission.bind(this.#options.hub)
    )(view.deviceId, async () => {
      if (operation !== "close" && !this.#live(view))
        throw this.#refusal("computer-view-ended", "The view ended.");
      const route = await this.#options.hub.captureRoute?.(view.deviceId);
      if (
        view.route &&
        (!this.#options.hub.routeCurrent?.(view.route) ||
          route?.generation !== view.route.generation ||
          route?.runnerId !== view.route.runnerId)
      )
        throw this.#refusal("computer-view-ended", "The Device driver changed. Reopen the view.");
      view.route ??= route;
      return {
        outcome: this.#options.hub.sendComputerView({
          runnerId: view.deviceId,
          route: view.route,
          request: {
            viewId: view.record.viewId,
            generation: view.record.generation,
            leaseDurationMs: Math.max(
              1,
              Math.ceil(Date.parse(view.record.expiresAt) - this.#now()),
            ),
            target: view.record.target,
            operation,
            timeoutMs: 8_000,
          },
          ...(signal ? { signal } : {}),
        }),
      };
    }).then(async ({ outcome }) => {
      const result = await outcome;
      return result.kind === "error"
        ? result
        : { ...result, value: ComputerViewNativeResultSchema.parse(result.value) };
    });
  }
  #refusal(reason: ComputerViewRefusalReason, message: string): OpensteerError {
    return new OpensteerError({ code: "conflict", reason, message });
  }
}

function sameApprovedTarget(
  left: ApprovedNativeApp["target"],
  right: ApprovedNativeApp["target"],
): boolean {
  return left.kind === "phone"
    ? right.kind === "phone" && left.display === right.display
    : right.kind === "app" &&
        computerAppIdentityKey(left.app) === computerAppIdentityKey(right.app) &&
        computerAppIdentitiesEqual(left.app, right.app);
}

function approvedApp(connection: DeviceComputerConnection): ApprovedNativeApp | null {
  const computer = connection.computer;
  if (
    !computer ||
    connection.status !== "connected" ||
    computer.blockedAt ||
    (connection.definitionId !== "macos-app" &&
      !isPhoneDisplayDefinitionId(connection.definitionId)) ||
    (connection.definitionId === "macos-app") !== (computer.app !== null)
  )
    return null;
  return {
    connectionId: connection.id,
    machineId: computerConnectionDeviceId(connection)!,
    target: computer.app ? { kind: "app", app: computer.app } : { kind: "phone", display: "main" },
    name: computer.app?.displayName ?? connection.displayName,
    iconPng: null,
  };
}

function sameViewTarget(left: ComputerViewTarget, right: ComputerViewTarget): boolean {
  return (
    sameApprovedTarget(left, right) &&
    (left.kind !== "app" || (right.kind === "app" && left.windowId === right.windowId))
  );
}
