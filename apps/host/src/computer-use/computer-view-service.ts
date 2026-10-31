import { randomUUID } from "node:crypto";
import {
  OpensteerError,
  ComputerViewUnavailableReasonSchema,
  type ComputerViewRecord,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import {
  computerAppIdentitiesEqual,
  type IntegrationConnectionSummary,
} from "@opensteer/integration-core";
import {
  ComputerViewIdSchema,
  ComputerViewSchema,
  ComputerViewRefusalReasonSchema,
  computerAppIdentityKey,
  computerViewIdleMs,
  computerViewMaxPerOwner,
  type ApprovedComputerApp,
  type ComputerView,
  type DisplaySource,
  type DisplayStreamReason,
  type ComputerViewTarget,
  type ComputerAppIdentity,
  type OwnerWindowInfo,
  type ComputerViewOpenCommand,
  type ComputerViewCloseCommand,
  type ComputerViewRenewCommand,
  type HostToClientMessage,
  type ComputerViewRefusalReason,
} from "@opensteer/protocol";
import type { ComputerAppHub } from "../computer-apps/computer-app-hub.js";

export interface PhoneViewDiagnostic {
  readonly machineId: RunnerId;
  readonly operation: "computer.view.open" | "computer.view.renew" | "computer.view.close";
  readonly viewId: ComputerView["viewId"] | null;
  readonly generation: number | null;
  readonly state: ComputerView["state"] | "requested" | "refused";
  readonly reason: ComputerView["unavailableReason"] | ComputerViewRefusalReason | null;
  readonly expiresAt: string | null;
}

interface Options {
  readonly onPhoneView?: (status: PhoneViewDiagnostic) => void;
  readonly hub: Pick<
    ComputerAppHub,
    "ownerViewSupported" | "sendComputerView" | "withRunnerAdmission" | "attached"
  > & {
    ownerWindows(
      runnerId: RunnerId,
      app: ComputerAppIdentity,
      options: { timeoutMs: number; signal?: AbortSignal },
    ): Promise<OwnerWindowInfo[]>;
  };
  readonly connections: (owner: UserId) => Promise<readonly IntegrationConnectionSummary[]>;
  readonly owners: (
    ids: readonly RunnerId[],
  ) => Promise<ReadonlyMap<RunnerId, { readonly effectiveOwner: UserId | null }>>;
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
type ViewCommand = ComputerViewOpenCommand | ComputerViewCloseCommand | ComputerViewRenewCommand;
interface HeldView {
  record: ComputerViewRecord;
  timer: NodeJS.Timeout | null;
}

/** Ephemeral owner authority. No task, grant, observation or app reservation is borrowed. */
export class ComputerViewService {
  readonly #options: Options;
  readonly #views = new Map<string, HeldView>();
  readonly #commands = new Map<string, { fingerprint: string; result: Promise<ComputerView> }>();
  readonly #turns = new Map<UserId, Promise<unknown>>();
  readonly #now: () => number;
  #closed = false;
  constructor(options: Options) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async approved(owner: UserId): Promise<ApprovedComputerApp[]> {
    const connections = await this.#options.connections(owner);
    const owners = await this.#options.owners([
      ...new Set(
        connections.flatMap((connection) =>
          connection.computer ? [connection.computer.runnerId] : [],
        ),
      ),
    ]);
    return connections.flatMap((connection) =>
      connection.computer && owners.get(connection.computer.runnerId)?.effectiveOwner === owner
        ? (approvedApp(connection) ?? [])
        : [],
    );
  }

  async windows(
    owner: UserId,
    machine: RunnerId,
    app: ComputerAppIdentity,
  ): Promise<OwnerWindowInfo[]> {
    const target = { kind: "app" as const, app };
    try {
      const { approved, outcome } = await this.#options.hub.withRunnerAdmission(
        machine,
        async () => {
          const approved = await this.#approvedTarget(owner, machine, target);
          return {
            approved,
            outcome: this.#options.hub.ownerWindows(machine, app, { timeoutMs: 8_000 }),
          };
        },
      );
      const windows = await outcome;
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

  async list(owner: UserId, machine: RunnerId): Promise<ComputerView[]> {
    return [...this.#views.values()]
      .filter(
        ({ record }) =>
          record.ownerUserId === owner &&
          record.machineId === machine &&
          record.state !== "closed" &&
          record.state !== "expired" &&
          Date.parse(record.expiresAt) > this.#now(),
      )
      .map((view) => this.#public(view));
  }

  async command(owner: UserId, command: ViewCommand): Promise<ComputerView> {
    const held = command.type === "computer.view.open" ? null : this.#views.get(command.viewId);
    const phone =
      command.type === "computer.view.open"
        ? command.target.kind === "phone"
        : held?.record.target.kind === "phone" && held.record.ownerUserId === owner;
    const machineId =
      command.type === "computer.view.open" ? command.machineId : held?.record.machineId;
    const report = (
      state: PhoneViewDiagnostic["state"],
      view?: ComputerView,
      reason?: ComputerViewRefusalReason,
    ) => {
      if (!phone || !machineId) return;
      this.#options.onPhoneView?.({
        machineId,
        operation: command.type,
        viewId: view?.viewId ?? (command.type === "computer.view.open" ? null : command.viewId),
        generation:
          view?.generation ?? (command.type === "computer.view.open" ? null : command.generation),
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
    const before = this.#turns.get(owner) ?? Promise.resolve();
    // Revocation cannot wait for a native open/renew answer already in flight.
    const result =
      command.type === "computer.view.close"
        ? this.#command(owner, command, receivedAt)
        : before.catch(() => undefined).then(() => this.#command(owner, command, receivedAt));
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

  async #command(owner: UserId, command: ViewCommand, receivedAt: number): Promise<ComputerView> {
    if (this.#closed)
      throw this.#refusal("computer-view-ended", "The Host ended this view. Reopen it explicitly.");
    if (command.type === "computer.view.open") {
      const approved = await this.#approvedTarget(owner, command.machineId, command.target);
      const held = [...this.#views.values()].find(
        ({ record }) =>
          record.ownerUserId === owner &&
          record.machineId === command.machineId &&
          sameViewTarget(record.target, command.target),
      );
      if (held && this.#live(held) && held.record.state === "ready") {
        await this.#authorize(held, owner);
        return this.#public(held);
      }
      if (
        [...this.#views.values()].filter(
          (view) => view !== held && view.record.ownerUserId === owner && this.#live(view),
        ).length >= computerViewMaxPerOwner &&
        (command.target.kind !== "app" || command.target.window !== undefined)
      )
        throw this.#refusal("computer-view-limit", "Close a view before opening another.");
      if (held) this.#end(held, "closed");
      const now = this.#now();
      const view: HeldView = {
        timer: null,
        record: {
          ownerUserId: owner,
          connectionId: approved.connectionId,
          machineId: command.machineId,
          target:
            command.target.kind === "app" && approved.target.kind === "app"
              ? {
                  ...approved.target,
                  ...(command.target.window === undefined ? {} : { window: command.target.window }),
                }
              : approved.target,
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
              (view.record.target.window !== undefined &&
                view.record.target.window !== result.value.window.id))) ||
          result.value.viewId !== view.record.viewId ||
          result.value.generation !== view.record.generation
        )
          throw this.#refusal(
            "computer-view-unavailable",
            "This app or display is unavailable. Reopen it explicitly.",
          );
        const window = result.value.window ?? null;
        if (view.record.target.kind === "app" && window) {
          view.record = {
            ...view.record,
            target: { ...view.record.target, window: window.id },
            window,
          };
          // Native open chooses the front window. Only that answer can identify an
          // omitted target; never borrow a task's current window or an old view.
          const duplicate = [...this.#views.values()].find(
            (candidate) =>
              candidate !== view &&
              candidate.record.ownerUserId === owner &&
              candidate.record.machineId === view.record.machineId &&
              sameViewTarget(candidate.record.target, view.record.target) &&
              candidate.record.state === "ready" &&
              this.#live(candidate),
          );
          if (duplicate) {
            await this.#authorize(duplicate, owner);
            this.#end(view, "closed");
            return this.#public(duplicate);
          }
        }
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
  ): Promise<RunnerId> {
    const held = this.#get(owner, source);
    await this.#authorize(held, owner);
    if (held.record.state !== "ready")
      throw this.#refusal("computer-view-ended", "That phone view has ended.");
    return held.record.machineId;
  }
  async authorizeInput(
    source: Extract<DisplaySource, { kind: "owner-view" }>,
    owner: UserId,
  ): Promise<RunnerId> {
    const held = this.#get(owner, source);
    await this.#authorize(held, owner);
    const connections = await this.#options.connections(owner);
    const approved = connections.find((connection) => connection.id === held.record.connectionId);
    if (
      held.record.target.kind !== "app" ||
      held.record.state !== "ready" ||
      !this.#live(held) ||
      approved?.status !== "connected" ||
      approved.computer?.access !== "read-write" ||
      approved.computer.blockedAt !== null ||
      approved.computer.runnerId !== held.record.machineId ||
      !approved.computer.app ||
      !computerAppIdentitiesEqual(approved.computer.app, held.record.target.app)
    )
      throw new OpensteerError({
        code: "forbidden",
        message: "Input requires a current read-write app approval.",
      });
    return held.record.machineId;
  }
  isDisplayLive(
    source: Extract<DisplaySource, { kind: "owner-view" }>,
    owner: UserId,
    machine: RunnerId,
  ): boolean {
    const held = this.#views.get(source.viewId);
    return (
      held !== undefined &&
      held.record.ownerUserId === owner &&
      held.record.machineId === machine &&
      held.record.generation === source.generation &&
      held.record.state === "ready" &&
      this.#live(held)
    );
  }
  endDisplaySource(
    source: Extract<DisplaySource, { kind: "owner-view" }>,
    machine: RunnerId,
    reason: DisplayStreamReason,
  ): void {
    const held = this.#views.get(source.viewId);
    if (!held || held.record.machineId !== machine || held.record.generation !== source.generation)
      return;
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

  disconnect(machine: RunnerId): void {
    for (const held of this.#views.values())
      if (held.record.machineId === machine) this.#end(held, "disconnected");
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
    machine: RunnerId,
    target: ComputerViewTarget,
  ): Promise<ApprovedComputerApp> {
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
      const approved = await this.#approvedTarget(owner, view.record.machineId, view.record.target);
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
      machineId: view.record.machineId,
      reason,
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
    return ComputerViewSchema.parse(view.record);
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
    return this.#options.hub
      .withRunnerAdmission(view.record.machineId, async () => {
        if (operation !== "close" && !this.#live(view))
          throw this.#refusal("computer-view-ended", "The view ended.");
        return {
          outcome: this.#options.hub.sendComputerView({
            runnerId: view.record.machineId,
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
      })
      .then(({ outcome }) => outcome);
  }
  #refusal(reason: ComputerViewRefusalReason, message: string): OpensteerError {
    return new OpensteerError({ code: "conflict", reason, message });
  }
}

function sameApprovedTarget(left: ComputerViewTarget, right: ComputerViewTarget): boolean {
  return left.kind === "phone"
    ? right.kind === "phone" && left.display === right.display
    : right.kind === "app" &&
        computerAppIdentityKey(left.app) === computerAppIdentityKey(right.app) &&
        computerAppIdentitiesEqual(left.app, right.app);
}

function approvedApp(connection: IntegrationConnectionSummary): ApprovedComputerApp | null {
  const computer = connection.computer;
  if (
    !computer ||
    connection.status !== "connected" ||
    computer.blockedAt ||
    (connection.definitionId !== "macos-app" && connection.definitionId !== "android-phone") ||
    (connection.definitionId === "macos-app") !== (computer.app !== null)
  )
    return null;
  return {
    connectionId: connection.id,
    machineId: computer.runnerId,
    target: computer.app ? { kind: "app", app: computer.app } : { kind: "phone", display: "main" },
    name: computer.app?.displayName ?? connection.displayName,
    iconPng: null,
  };
}

function sameViewTarget(left: ComputerViewTarget, right: ComputerViewTarget): boolean {
  return (
    sameApprovedTarget(left, right) &&
    (left.kind !== "app" ||
      (right.kind === "app" && left.window !== undefined && left.window === right.window))
  );
}
