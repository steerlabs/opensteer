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
import type { IntegrationConnectionSummary } from "@opensteer/integration-core";
import { HostClientRequestError, type HostSnapshot } from "../host/client.js";

export class MockComputerViews {
  readonly #snapshot: () => HostSnapshot;
  readonly #update: (snapshot: HostSnapshot) => void;
  readonly #connections: () => readonly IntegrationConnectionSummary[];
  readonly #now: () => Date;
  readonly #results = new Map<string, { fingerprint: string; view: ComputerView }>();
  constructor(
    snapshot: () => HostSnapshot,
    update: (snapshot: HostSnapshot) => void,
    connections: () => readonly IntegrationConnectionSummary[],
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
  windows(
    machineId: string,
    app: Extract<ComputerViewTarget, { kind: "app" }>["app"],
  ): OwnerWindowInfo[] {
    this.#validate(machineId, { kind: "app", app });
    return [
      {
        id: 101,
        title: "Shopping list",
        focused: true,
        main: true,
        minimized: false,
        onScreen: true,
      },
      {
        id: 102,
        title: "Work plan",
        focused: false,
        main: false,
        minimized: false,
        onScreen: true,
      },
      { id: 103, title: "Archive", focused: false, main: false, minimized: true, onScreen: false },
      { id: 104, title: "Ideas", focused: false, main: false, minimized: false, onScreen: false },
    ];
  }
  approved(): ApprovedComputerApp[] {
    const snapshot = this.#authenticated();
    return this.#connections().flatMap((connection) => {
      const computer = connection.computer;
      const machine = snapshot.machines.find((machine) => machine.id === computer?.runnerId);
      if (
        !computer ||
        connection.status !== "connected" ||
        computer.blockedAt ||
        !machine ||
        (machine.ownership !== "mine" &&
          !(
            snapshot.deploymentShape?.kind === "personal" &&
            machine.ownership === "deployment" &&
            machine.access?.ownerReachAvailable === true
          ))
      )
        return [];
      if (connection.definitionId !== "macos-app" && connection.definitionId !== "android-phone")
        return [];
      if ((connection.definitionId === "macos-app") !== (computer.app !== null)) return [];
      const target: ComputerViewTarget = computer.app
        ? { kind: "app", app: computer.app }
        : { kind: "phone", display: "main" };
      return [
        {
          connectionId: connection.id,
          machineId: computer.runnerId,
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
  #validate(machineId: string, target: ComputerViewTarget): ApprovedComputerApp {
    const snapshot = this.#authenticated();
    const machine = snapshot.machines.find((machine) => machine.id === machineId);
    if (
      !machine ||
      (machine.ownership !== "mine" &&
        !(
          snapshot.deploymentShape?.kind === "personal" &&
          machine.ownership === "deployment" &&
          machine.access?.ownerReachAvailable === true
        ))
    )
      throw new HostClientRequestError({
        code: "forbidden",
        status: 403,
        message: "Only this computer's owner can view it.",
      });
    const approved = this.approved().find(
      (app) =>
        app.machineId === machineId &&
        this.#targetKey(app.target) === this.#targetKey(target) &&
        (target.kind !== "app" ||
          (app.target.kind === "app" && computerAppIdentitiesEqual(target.app, app.target.app))),
    );
    if (!approved)
      this.#refuse("computer-view-not-approved", "This app or phone needs an existing approval.");
    if (
      machine?.device?.form === "phone"
        ? machine.computerUse?.displayStreamSupported !== true
        : machine?.computerUse?.ownerViewVersion !== 3
    )
      this.#refuse("computer-view-unsupported", "Update this computer to view apps and devices.");
    if (
      snapshot.connection === "offline" ||
      machine.status !== "online" ||
      machine.computerUse?.state !== "ready"
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
    const approved = this.approved();
    for (const machine of snapshot.machines)
      for (const view of machine.computerUse?.ownerViews ?? []) {
        if (view.state === "closed" || view.state === "expired") continue;
        const valid = approved.some(
          (item) => item.connectionId === view.connectionId && item.machineId === view.machineId,
        );
        if (Date.parse(view.expiresAt) <= now)
          this.#put({ ...view, state: "expired", unavailableReason: "expired" });
        else if (!valid || machine.status !== "online" || snapshot.connection === "offline")
          this.#put({
            ...view,
            state: "unavailable",
            unavailableReason: valid ? "offline" : "connection-revoked",
          });
      }
  }
  command(command: Extract<HostApiCommand, { type: `computer.view.${string}` }>): ComputerView {
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
    let view: ComputerView;
    if (command.type === "computer.view.open") {
      const approved = this.#validate(command.machineId, command.target);
      const window =
        command.target.kind === "app"
          ? this.windows(command.machineId, command.target.app).find(
              (window) =>
                window.id ===
                (command.target.kind === "app" ? (command.target.window ?? 101) : 101),
            )
          : null;
      if (command.target.kind === "app" && !window)
        this.#refuse("computer-view-unavailable", "That window is closed.");
      const target =
        command.target.kind === "app" && window
          ? { ...command.target, window: window.id }
          : command.target;
      const held = all.find(
        (view) =>
          view.machineId === command.machineId &&
          this.#targetKey(view.target) === this.#targetKey(target) &&
          (target.kind !== "app" ||
            (view.target.kind === "app" && view.target.window === target.window)),
      );
      if (held?.state === "ready" && Date.parse(held.expiresAt) > this.#now().getTime())
        view = held;
      else {
        if (
          all.filter(
            (view) =>
              view.viewId !== held?.viewId && view.state !== "closed" && view.state !== "expired",
          ).length >= computerViewMaxPerOwner
        )
          this.#refuse("computer-view-limit", "Close a view before opening another.");
        const at = this.#now().getTime();
        view = ComputerViewSchema.parse({
          connectionId: approved.connectionId,
          machineId: command.machineId,
          target,
          window: window ? { id: window.id, title: window.title } : null,
          viewId: held?.viewId ?? `cvw_${crypto.randomUUID()}`,
          generation: (held?.generation ?? 0) + 1,
          state: "ready",
          openedAt: new Date(at).toISOString(),
          expiresAt: new Date(at + computerViewIdleMs[command.target.kind]).toISOString(),
          unavailableReason: null,
        });
      }
    } else {
      const held = all.find((view) => view.viewId === command.viewId);
      if (!held) this.#refuse("computer-view-ended", "This view ended. Open it again.");
      if (held.generation !== command.generation)
        this.#refuse("computer-view-stale-generation", "This view has been replaced.");
      if (command.type === "computer.view.close")
        view = { ...held, state: "closed", unavailableReason: "closed" };
      else {
        if (held.state === "closed" || held.state === "expired")
          this.#refuse("computer-view-ended", "This view ended. Open it again.");
        this.#validate(held.machineId, held.target);
        view = {
          ...held,
          expiresAt: new Date(
            this.#now().getTime() + computerViewIdleMs[held.target.kind],
          ).toISOString(),
        };
      }
    }
    this.#results.set(key, { fingerprint, view });
    this.#put(view);
    return view;
  }
}
