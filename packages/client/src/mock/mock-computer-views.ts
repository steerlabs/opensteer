import { mockDeviceMachine } from "./mock-device-machine.js";
import { DeviceIdSchema, isPhoneDisplayDefinitionId, type DeviceId } from "@opensteer/core";
import {
  deviceDriverKey,
  computerTargetId,
  type ClientComputerConnection,
} from "../host/device-projection.js";
import {
  computerAppIdentityKey,
  ComputerViewSchema,
  computerViewIdleMs,
  computerViewMaxPerOwner,
  type ApprovedComputerApp,
  type ComputerView,
  type ComputerViewTarget,
  type HostApiCommand,
  type OwnerWindowInfo,
} from "@opensteer/protocol";
import { computerAppIdentitiesEqual } from "@opensteer/integration-core";
import { HostClientRequestError, type HostSnapshot } from "../host/client.js";
import { WindowIdSchema, type WindowId } from "@opensteer/core";

export class MockComputerViews {
  readonly #snapshot: () => HostSnapshot;
  readonly #update: (snapshot: HostSnapshot) => void;
  readonly #connections: () => readonly ClientComputerConnection[];
  readonly #now: () => Date;
  readonly #drivers = new Map<string, string | null>();
  readonly #results = new Map<string, { fingerprint: string; view: ComputerView }>();
  constructor(
    snapshot: () => HostSnapshot,
    update: (snapshot: HostSnapshot) => void,
    connections: () => readonly ClientComputerConnection[],
    now: () => Date,
  ) {
    this.#snapshot = snapshot;
    this.#update = update;
    this.#connections = connections;
    this.#now = now;
  }
  #authenticated(): HostSnapshot {
    const snapshot = this.#snapshot();
    if (snapshot.session !== "authenticated" || !snapshot.user)
      throw new HostClientRequestError({
        code: "unauthorized",
        status: 401,
        message: "Sign in to view a computer.",
      });
    return snapshot;
  }
  #refuse(reason: string, message: string): never {
    throw new HostClientRequestError({ code: "conflict", status: 409, reason, message });
  }
  #targetKey(target: ComputerViewTarget): string {
    return target.kind === "app"
      ? `app:${computerAppIdentityKey(target.app)}`
      : `phone:${target.display}`;
  }
  /** An app's windows as the Host lists them: opaque, stable handles and titles. */
  windows(
    machineId: string,
    app: Extract<ComputerViewTarget, { kind: "app" }>["app"],
  ): OwnerWindowInfo[] {
    this.#validate(machineId, { kind: "app", app });
    // Archive is minimized; Ideas sits on another Space.
    return ["Shopping list", "Work plan", "Archive", "Ideas"].map((title, index) => ({
      windowId: mockWindowId(machineId, app.bundleId, index),
      title,
      minimized: index === 2,
      onScreen: index < 2,
    }));
  }
  approved(): ApprovedComputerApp[] {
    return this.#approvedDevices();
  }
  #approvedDevices(): (Omit<ApprovedComputerApp, "machineId"> & { machineId: DeviceId })[] {
    const snapshot = this.#authenticated();
    return this.#connections().flatMap((connection) => {
      const computer = connection.computer;
      const machine = snapshot.machines.find(
        (machine) => machine.id === computerTargetId(computer),
      );
      if (
        !computer ||
        connection.status !== "connected" ||
        computer.blockedAt ||
        !machine ||
        (machine.ownership !== "mine" &&
          !(machine.ownership === "deployment" && machine.access?.ownerReachAvailable === true))
      )
        return [];
      if (
        connection.definitionId !== "macos-app" &&
        !isPhoneDisplayDefinitionId(connection.definitionId)
      )
        return [];
      if ((connection.definitionId === "macos-app") !== (computer.app !== null)) return [];
      const target: ApprovedComputerApp["target"] = computer.app
        ? { kind: "app", app: computer.app }
        : { kind: "phone", display: "main" };
      return [
        {
          connectionId: connection.id,
          machineId: DeviceIdSchema.parse(machine.id),
          target,
          name: computer.app?.displayName ?? machine.name,
          iconPng: null,
        },
      ];
    });
  }
  inputAvailable(viewId: string, generation: number): boolean {
    const view = this.#snapshot()
      .machines.flatMap((machine) => machine.computerUse?.ownerViews ?? [])
      .find((view) => view.viewId === viewId && view.generation === generation);
    return (
      view?.state === "ready" &&
      Date.parse(view.expiresAt) > this.#now().getTime() &&
      this.#connections().some(
        (connection) =>
          connection.id === view.connectionId &&
          connection.status === "connected" &&
          connection.computer?.blockedAt === null &&
          connection.computer.access === "read-write",
      )
    );
  }
  #validate(
    machineId: string,
    target:
      | { readonly kind: "app"; readonly app: Extract<ComputerViewTarget, { kind: "app" }>["app"] }
      | { readonly kind: "phone"; readonly display: string },
  ): Omit<ApprovedComputerApp, "machineId"> & { machineId: DeviceId } {
    const snapshot = this.#authenticated();
    const machine = snapshot.machines.find((machine) => machine.id === machineId);
    if (
      !machine ||
      (machine.ownership !== "mine" &&
        !(machine.ownership === "deployment" && machine.access?.ownerReachAvailable === true))
    )
      throw new HostClientRequestError({
        code: "forbidden",
        status: 403,
        message: "Only this computer's owner can view it.",
      });
    const approved = this.#approvedDevices().find(
      (app) =>
        app.machineId === machineId &&
        (app.target.kind === "phone"
          ? target.kind === "phone"
          : target.kind === "app" &&
            computerAppIdentityKey(app.target.app) === computerAppIdentityKey(target.app)) &&
        (target.kind !== "app" ||
          (app.target.kind === "app" && computerAppIdentitiesEqual(target.app, app.target.app))),
    );
    if (!approved)
      this.#refuse("computer-view-not-approved", "This app or phone needs an existing approval.");
    if (
      mockDeviceMachine(machine).phoneDisplay
        ? mockDeviceMachine(machine).phoneDisplay?.view.state !== "ready"
        : machine?.computerUse?.ownerViewVersion !== 3
    )
      this.#refuse("computer-view-unsupported", "Update this computer to view apps and devices.");
    if (
      snapshot.connection === "offline" ||
      machine.status !== "online" ||
      (!mockDeviceMachine(machine).phoneDisplay && machine.computerUse?.state !== "ready")
    )
      this.#refuse("computer-view-unavailable", "This computer is unavailable.");
    return approved;
  }
  #put(view: ComputerView): void {
    const snapshot = this.#snapshot();
    this.#update({
      ...snapshot,
      machines: snapshot.machines.map((machine) =>
        machine.id === view.machineId && machine.computerUse
          ? {
              ...machine,
              computerUse: {
                ...machine.computerUse,
                ownerViews: [
                  ...(machine.computerUse.ownerViews ?? []).filter(
                    (held) => held.viewId !== view.viewId,
                  ),
                  view,
                ].slice(-computerViewMaxPerOwner),
              },
            }
          : machine,
      ),
    });
  }
  expire(): void {
    const snapshot = this.#snapshot();
    if (snapshot.session !== "authenticated") return;
    const now = this.#now().getTime();
    let approved: ReturnType<MockComputerViews["approved"]> | undefined;
    for (const machine of snapshot.machines)
      for (const view of machine.computerUse?.ownerViews ?? []) {
        if (view.state === "closed" || view.state === "expired") continue;
        if (Date.parse(view.expiresAt) <= now) {
          this.#put({ ...view, state: "expired", unavailableReason: "expired" });
          continue;
        }
        const valid = (approved ??= this.#approvedDevices()).some(
          (item) => item.connectionId === view.connectionId && item.machineId === view.machineId,
        );
        if (
          !valid ||
          machine.status !== "online" ||
          snapshot.connection === "offline" ||
          (this.#drivers.has(view.viewId) &&
            this.#drivers.get(view.viewId) !== deviceDriverKey(machine))
        ) {
          const unavailableReason = valid ? "offline" : "connection-revoked";
          if (view.state !== "unavailable" || view.unavailableReason !== unavailableReason)
            this.#put({ ...view, state: "unavailable", unavailableReason });
        }
      }
  }
  /** The app's window closed: its views end as the Home ends them, with the reason. */
  windowClosed(machineId: string, bundleId: string): void {
    for (const machine of this.#snapshot().machines)
      for (const view of machine.computerUse?.ownerViews ?? [])
        if (
          view.machineId === machineId &&
          view.target.kind === "app" &&
          view.target.app.bundleId === bundleId &&
          (view.state === "ready" || view.state === "opening")
        )
          this.#put({ ...view, state: "unavailable", unavailableReason: "window-closed" });
  }
  /** The person's view of an exact window or a phone, as activating its tab opens one. */
  open(
    machineId: string,
    target:
      | {
          readonly kind: "app";
          readonly app: Extract<ComputerViewTarget, { kind: "app" }>["app"];
          readonly windowId?: WindowId;
        }
      | { readonly kind: "phone"; readonly display: string },
  ): ComputerView {
    this.expire();
    const approved = this.#validate(machineId, target);
    const window =
      target.kind === "app"
        ? (this.windows(machineId, target.app).find(
            (window) => window.windowId === (target.windowId ?? window.windowId),
          ) ?? null)
        : null;
    if (target.kind === "app" && !window)
      this.#refuse("computer-view-unavailable", "That window is closed.");
    const viewTarget: ComputerViewTarget =
      target.kind === "app"
        ? { kind: "app", app: target.app, windowId: window!.windowId }
        : { kind: "phone", display: target.display };
    const all = this.#snapshot().machines.flatMap(
      (machine) => machine.computerUse?.ownerViews ?? [],
    );
    const held = all.find(
      (view) =>
        view.machineId === machineId &&
        this.#targetKey(view.target) === this.#targetKey(viewTarget) &&
        (viewTarget.kind !== "app" ||
          (view.target.kind === "app" && view.target.windowId === viewTarget.windowId)),
    );
    if (held?.state === "ready" && Date.parse(held.expiresAt) > this.#now().getTime()) return held;
    if (
      all.filter(
        (view) =>
          view.viewId !== held?.viewId && view.state !== "closed" && view.state !== "expired",
      ).length >= computerViewMaxPerOwner
    )
      this.#refuse("computer-view-limit", "Close a view before opening another.");
    const at = this.#now().getTime();
    const record = ComputerViewSchema.parse({
      connectionId: approved.connectionId,
      machineId,
      target: viewTarget,
      window,
      viewId: held?.viewId ?? `cvw_${crypto.randomUUID()}`,
      generation: (held?.generation ?? 0) + 1,
      state: "ready",
      openedAt: new Date(at).toISOString(),
      expiresAt: new Date(at + computerViewIdleMs[target.kind]).toISOString(),
      unavailableReason: null,
    });
    const driver = mockDeviceMachine(
      this.#snapshot().machines.find((machine) => machine.id === machineId)!,
    ).phoneDisplay?.driver;
    const view =
      driver?.role === "screen" ? { ...record, driverGeneration: driver.generation } : record;
    this.#drivers.set(
      view.viewId,
      deviceDriverKey(this.#snapshot().machines.find((machine) => machine.id === machineId)!),
    );
    this.#put(view);
    return view;
  }
  command(
    command: Extract<HostApiCommand, { type: "computer.view.close" | "computer.view.renew" }>,
  ): ComputerView {
    const snapshot = this.#authenticated();
    const key = `${snapshot.user!.id}:${command.idempotencyKey}`;
    const fingerprint = JSON.stringify(command);
    const previous = this.#results.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        this.#refuse("computer-view-idempotency-conflict", "Idempotency key already used.");
      return previous.view;
    }
    this.expire();
    const all = this.#snapshot().machines.flatMap(
      (machine) => machine.computerUse?.ownerViews ?? [],
    );
    const held = all.find((view) => view.viewId === command.viewId);
    if (!held) this.#refuse("computer-view-ended", "This view ended. Open it again.");
    if (held.generation !== command.generation)
      this.#refuse("computer-view-stale-generation", "This view has been replaced.");
    let view: ComputerView;
    if (command.type === "computer.view.close")
      view = { ...held, state: "closed", unavailableReason: "closed" };
    else {
      if (held.state === "closed" || held.state === "expired")
        this.#refuse("computer-view-ended", "This view ended. Open it again.");
      this.#validate(
        held.machineId,
        held.target.kind === "app" ? { kind: "app", app: held.target.app } : held.target,
      );
      view = {
        ...held,
        expiresAt: new Date(
          this.#now().getTime() + computerViewIdleMs[held.target.kind],
        ).toISOString(),
      };
    }
    this.#results.set(key, { fingerprint, view });
    this.#put(view);
    return view;
  }
}

/** A stable opaque window handle per mock app window, as the native identity registry mints. */
export function mockWindowId(machineId: string, bundleId: string, index: number): WindowId {
  let hash = 0;
  for (const char of `${machineId}:${bundleId}:${index}`)
    hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  const hex = hash.toString(16).padStart(8, "0");
  return WindowIdSchema.parse(
    `win_${hex}-0000-4000-8000-${hex}${index.toString(16).padStart(4, "0")}`,
  );
}
