import { createId } from "@opensteer/core";
import {
  DesktopDeploymentSummarySchema,
  type DeploymentAccessUnavailable,
  type DesktopAccountAuthState,
  type DesktopPersonalAccountLinkStatus,
} from "@opensteer/protocol/desktop";
import { describe, expect, it, vi } from "vitest";
import type { HostSessionObservation } from "@opensteer/client/auth";
import {
  DeploymentAccessService,
  classifyPortFailure,
  type CatalogProjection,
  type DeploymentAccessPort,
  type DeploymentAccessPorts,
  type DeploymentProbeOutcome,
} from "./deployment-access-service.js";

describe("DeploymentAccessService", () => {
  it("executes effects, feeds results back, and publishes immutable revisions", async () => {
    const fixture = fakePorts();
    const service = new DeploymentAccessService(fixture.ports);
    const revisions: number[] = [];
    service.subscribe((snapshot) => revisions.push(snapshot.revision));
    await service.initialize();

    const initialized = service.snapshot();
    expect(initialized.revision).toBeGreaterThan(0);
    expect(Object.isFrozen(initialized)).toBe(true);
    await service.signIn();
    expect(fixture.beginSignIn).toHaveBeenCalledOnce();
    expect(service.snapshot().account.status).toBe("authorizing");
    expect(revisions.at(-1)).toBe(service.snapshot().revision);
    expect(new Set(revisions).size).toBe(revisions.length);
    service.dispose();
  });

  it("releases Account authorization when the credential source reports sign-in", async () => {
    const fixture = fakePorts();
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();

    await service.signIn();
    fixture.emitAccount(signedInAccount());
    await settle();

    expect(service.snapshot().account.status).toBe("signed-in");
    await expect(service.signOut()).resolves.toBeUndefined();
    service.dispose();
  });

  it("removes an Account row through the directory without using local catalog removal", async () => {
    const target = deployment({ accountAccess: "member", source: "account" });
    const fixture = fakePorts({ deployments: [target] });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    fixture.emitAccount(signedInAccount());
    await settle();
    vi.mocked(fixture.ports.directory.removeFromAccount).mockClear();
    vi.mocked(fixture.ports.directory.syncAccountDeployments).mockClear();

    await service.removeFromAccount(target.id);

    expect(fixture.ports.directory.removeFromAccount).toHaveBeenCalledWith(target.id);
    expect(fixture.ports.directory.syncAccountDeployments).toHaveBeenCalledWith(
      "required",
      "manual",
    );
    service.dispose();
  });

  it("refuses to hide an Account row this Account owns, whatever its route", async () => {
    // On the computer that does not run it, an owner's Deployment is an
    // ordinary Account row — and the Account still answers a conflict, so the
    // move must not be offered here either.
    const owned = deployment({ accountAccess: "owner", source: "account" });
    const shared = deployment({ accountAccess: "member", source: "account" });
    const fixture = fakePorts({ deployments: [owned, shared] });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    fixture.emitAccount(signedInAccount());
    await settle();
    vi.mocked(fixture.ports.directory.removeFromAccount).mockClear();

    await expect(service.removeFromAccount(owned.id)).rejects.toThrow("removeFromAccount");
    expect(fixture.ports.directory.removeFromAccount).not.toHaveBeenCalled();

    await service.removeFromAccount(shared.id);

    expect(fixture.ports.directory.removeFromAccount).toHaveBeenCalledWith(shared.id);
    service.dispose();
  });

  it("drops an unreachable listing this Account only belongs to, never one it owns", async () => {
    const owned = {
      accountAccess: "owner" as const,
      deploymentId: createId("deployment"),
      name: "Studio Mac",
      reason: "identity-mismatch" as const,
    };
    const shared = {
      accountAccess: "member" as const,
      deploymentId: createId("deployment"),
      name: "Old Laptop",
      reason: "identity-mismatch" as const,
    };
    const fixture = fakePorts({ directoryUnavailable: [owned, shared] });
    vi.spyOn(fixture.ports.account, "currentState").mockResolvedValueOnce(signedInAccount());
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    await settle();

    // The Account rejects hiding a Deployment its owner is signed in to, so
    // the Desktop must not offer the move in the first place.
    await expect(service.removeFromAccount(owned.deploymentId)).rejects.toThrow(
      "removeFromAccount",
    );
    expect(fixture.ports.directory.removeFromAccount).not.toHaveBeenCalled();

    await service.removeFromAccount(shared.deploymentId);

    expect(fixture.ports.directory.removeFromAccount).toHaveBeenCalledWith(shared.deploymentId);
    service.dispose();
  });

  it("runs transient retries only when the connection supervisor's retry is due", async () => {
    const target = deployment();
    const fixture = fakePorts({ deployments: [target] });
    fixture.establish
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce({
        attachmentKey: target.key!,
        deploymentId: target.id,
        outcome: "ready",
      });
    const scheduled: Array<() => void> = [];
    const service = new DeploymentAccessService(fixture.ports, {
      schedule: (callback) => scheduled.push(callback),
    });
    await service.initialize();
    await service.select(target.id);

    expect(fixture.establish).toHaveBeenCalledOnce();
    expect(service.snapshot().deployments[0]).toMatchObject({
      failure: { retryable: true },
      status: "offline",
    });
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    await settle();
    expect(fixture.establish).toHaveBeenCalledTimes(2);
    expect(service.snapshot().deployments[0]?.status).toBe("connected");
    service.dispose();
  });

  it("gives every row one status from the authority that knows it, and names the repair", async () => {
    const local = deployment({
      kind: "personal" as const,
      name: "This Mac",
      onThisComputer: true,
      source: "this-device",
    });
    const otherComputer = deployment({
      attachmentKey: null,
      kind: "personal" as const,
      name: "Mac mini",
      routes: [{ kind: "canonical", origin: "http://127.0.0.1:4310" }],
    });
    const server = deployment({ name: "Server" });
    const fixture = fakePorts({
      deployments: [local, otherComputer, server],
      personal: { ...readyPersonalStatus, deploymentId: local.id },
    });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    await service.checkDeployments();

    // Nothing is attached, and every row still says what its own authority
    // knows — a self-hosted Host that was never opened is not "Starting…".
    expect(service.snapshot().deployments.map(({ statusInfo }) => statusInfo)).toEqual([
      { reason: null, status: "ready" },
      {
        label: "Remote access off",
        reason: "Remote access is off on Mac mini. Turn it on there in Settings › Remote access.",
        status: "offline",
      },
      { reason: null, status: "ready" },
    ]);
    expect(service.snapshot().deployments.map(({ status }) => status)).toEqual([
      "idle",
      "needs-remote-access",
      "idle",
    ]);
    expect(service.snapshot().deployments.map(({ availableActions }) => availableActions)).toEqual([
      ["select"],
      [],
      ["select"],
    ]);
    service.dispose();
  });

  it("carries a degraded local stack into the snapshot even while it is connected", async () => {
    const local = deployment({
      kind: "personal" as const,
      lastUsedAt: "2026-08-20T10:00:00.000Z",
      name: "This Mac",
      onThisComputer: true,
      source: "this-device",
    });
    const fixture = fakePorts({
      deployments: [local],
      personal: { ...readyPersonalStatus, deploymentId: local.id },
      selectedDeploymentId: local.id,
    });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    await settle();
    expect(service.snapshot().deployments[0]?.status).toBe("connected");

    fixture.emitPersonal({
      ...readyPersonalStatus,
      deploymentId: local.id,
      issue: {
        code: "runner-unavailable",
        component: "runner",
        detail: "Local agents are not running.",
        repairAction: "open-diagnostics",
      },
      state: "degraded",
    });
    await settle();

    expect(service.snapshot().deployments[0]).toMatchObject({
      status: "connected",
      statusInfo: { reason: "Local agents are not running.", status: "attention" },
    });
    service.dispose();
  });

  it("restarts a down local Personal stack before retrying its attachment", async () => {
    const local = deployment({ kind: "personal", onThisComputer: true, source: "this-device" });
    const down = {
      ...personalStatus,
      deploymentId: local.id,
      state: "degraded" as const,
      canStart: true,
    };
    const fixture = fakePorts({
      deployments: [local],
      personal: down,
      selectedDeploymentId: local.id,
    });
    vi.mocked(fixture.ports.personal.start).mockImplementation(async () => {
      const ready = { ...readyPersonalStatus, deploymentId: local.id };
      fixture.emitPersonal(ready);
      return ready;
    });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    expect(service.snapshot().deployments[0]?.availableActions).toContain("retry");
    await service.retry();
    await settle();
    expect(fixture.ports.personal.start).toHaveBeenCalledOnce();
    expect(fixture.establish).toHaveBeenCalledOnce();
    service.dispose();
  });

  it("holds a returning local attachment until the Personal Host is ready", async () => {
    const local = deployment({
      kind: "personal",
      lastUsedAt: "2026-08-20T10:00:00.000Z",
      name: "This Mac",
      onThisComputer: true,
      source: "this-device",
    });
    const checking = {
      ...personalStatus,
      canStart: false,
      deploymentId: local.id,
      state: "checking" as const,
      step: "checking-computer" as const,
    };
    const fixture = fakePorts({
      deployments: [local],
      personal: checking,
      selectedDeploymentId: local.id,
    });
    const service = new DeploymentAccessService(fixture.ports);

    await service.initialize();
    await settle();

    expect(fixture.establish).not.toHaveBeenCalled();
    expect(service.snapshot().deployments[0]).toMatchObject({
      availableActions: [],
      failure: null,
      status: "idle",
      statusInfo: { reason: null, status: "starting" },
    });

    fixture.emitPersonal({ ...readyPersonalStatus, deploymentId: local.id });
    await settle();

    expect(fixture.establish).toHaveBeenCalledOnce();
    expect(service.snapshot().deployments[0]?.status).toBe("connected");
    service.dispose();
  });

  it("does not carry a deferred local attachment across a selection change", async () => {
    const local = deployment({
      kind: "personal",
      lastUsedAt: "2026-08-20T10:00:00.000Z",
      name: "This Mac",
      onThisComputer: true,
      source: "this-device",
    });
    const remote = deployment({
      lastUsedAt: "2026-08-20T11:00:00.000Z",
      name: "Server",
    });
    const fixture = fakePorts({
      deployments: [local, remote],
      personal: {
        ...personalStatus,
        canStart: false,
        deploymentId: local.id,
        state: "starting",
        step: "starting-host",
      },
      selectedDeploymentId: local.id,
    });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    await settle();
    expect(fixture.establish).not.toHaveBeenCalled();

    fixture.emitCatalog({ deployments: [local, remote], selectedDeploymentId: remote.id });
    await settle();

    expect(fixture.establish).toHaveBeenCalledOnce();
    expect(fixture.establish).toHaveBeenLastCalledWith(remote.id);

    fixture.emitPersonal({ ...readyPersonalStatus, deploymentId: local.id });
    await settle();

    expect(fixture.establish).toHaveBeenCalledOnce();
    expect(service.snapshot().deployments[1]?.status).toBe("connected");
    service.dispose();
  });

  it("cannot resume a deferred attachment while selection is closing the old session", async () => {
    const local = deployment({
      kind: "personal",
      lastUsedAt: "2026-08-20T10:00:00.000Z",
      onThisComputer: true,
      source: "this-device",
    });
    const remote = deployment({ name: "Server" });
    const fixture = fakePorts({
      deployments: [local, remote],
      personal: {
        ...personalStatus,
        canStart: false,
        deploymentId: local.id,
        state: "starting",
        step: "starting-host",
      },
      selectedDeploymentId: local.id,
    });
    let finishClose: (() => void) | undefined;
    vi.mocked(fixture.ports.hostSession.closeCurrent).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    await settle();

    const selecting = service.select(remote.id);
    await settle();
    fixture.emitPersonal({ ...readyPersonalStatus, deploymentId: local.id });
    await settle();
    expect(fixture.establish).not.toHaveBeenCalled();

    finishClose?.();
    await selecting;
    expect(fixture.establish).toHaveBeenCalledOnce();
    expect(fixture.establish).toHaveBeenCalledWith(remote.id);
    service.dispose();
  });

  it("abandons a deferred local attachment when the current operation is cancelled", async () => {
    const local = deployment({
      kind: "personal",
      lastUsedAt: "2026-08-20T10:00:00.000Z",
      onThisComputer: true,
      source: "this-device",
    });
    const fixture = fakePorts({
      deployments: [local],
      personal: {
        ...personalStatus,
        canStart: false,
        deploymentId: local.id,
        state: "starting",
        step: "starting-host",
      },
      selectedDeploymentId: local.id,
    });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    await settle();
    expect(fixture.establish).not.toHaveBeenCalled();

    await service.signIn();
    await service.cancel();
    fixture.emitPersonal({ ...readyPersonalStatus, deploymentId: local.id });
    await settle();

    expect(fixture.establish).not.toHaveBeenCalled();
    expect(service.snapshot().deployments[0]?.availableActions).toEqual(["retry"]);
    service.dispose();
  });

  it("keeps a settled Personal startup failure as the row's real status", async () => {
    const local = deployment({
      kind: "personal",
      lastUsedAt: "2026-08-20T10:00:00.000Z",
      name: "This Mac",
      onThisComputer: true,
      source: "this-device",
    });
    const fixture = fakePorts({
      deployments: [local],
      personal: {
        ...personalStatus,
        canStart: false,
        deploymentId: local.id,
        state: "checking",
        step: "checking-computer",
      },
      selectedDeploymentId: local.id,
    });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();

    fixture.emitPersonal({
      ...personalStatus,
      canStart: false,
      deploymentId: local.id,
      issue: {
        code: "host-unavailable",
        component: "host",
        detail: "The Personal Host could not start.",
        repairAction: "open-diagnostics",
      },
      state: "repair-required",
    });
    await settle();

    expect(fixture.establish).not.toHaveBeenCalled();
    expect(service.snapshot().deployments[0]).toMatchObject({
      failure: null,
      statusInfo: {
        reason: "The Personal Host could not start.",
        status: "attention",
      },
    });
    service.dispose();
  });

  it.each([
    {
      expected: { reason: null, status: "offline" as const },
      personal: {
        ...personalStatus,
        canStart: false,
        state: "stopped" as const,
      },
    },
    {
      expected: { reason: "The Personal Host could not start.", status: "attention" as const },
      personal: {
        ...personalStatus,
        canStart: false,
        issue: {
          code: "host-unavailable" as const,
          component: "host" as const,
          detail: "The Personal Host could not start.",
          repairAction: "open-diagnostics" as const,
        },
        state: "repair-required" as const,
      },
    },
  ])("does not attach a returning local deployment initially in $personal.state", async (test) => {
    const local = deployment({
      kind: "personal",
      lastUsedAt: "2026-08-20T10:00:00.000Z",
      name: "This Mac",
      onThisComputer: true,
      source: "this-device",
    });
    const fixture = fakePorts({
      deployments: [local],
      personal: { ...test.personal, deploymentId: local.id },
      selectedDeploymentId: local.id,
    });
    const service = new DeploymentAccessService(fixture.ports);

    await service.initialize();
    service.networkChanged();
    service.wake();
    await settle();

    expect(fixture.establish).not.toHaveBeenCalled();
    expect(service.snapshot().deployments[0]).toMatchObject({
      availableActions: [],
      failure: null,
      statusInfo: test.expected,
    });
    service.dispose();
  });

  it("never lets a failed attempt make a deployment unselectable", async () => {
    const target = deployment();
    const fixture = fakePorts({ deployments: [target] });
    fixture.establish.mockRejectedValueOnce(new Error("This connection was refused."));
    const service = new DeploymentAccessService(fixture.ports, { schedule: () => undefined });
    await service.initialize();
    await service.select(target.id);
    await settle();

    expect(service.snapshot().deployments[0]).toMatchObject({
      availableActions: ["retry"],
      failure: { retryable: false },
      status: "offline",
      // The row's own status is the check's, not the failed attempt's.
      statusInfo: { reason: null, status: "checking" },
    });

    // A blocked attempt is still asked again on demand, and selecting the row
    // once more is never refused because of what a past attempt learned.
    await service.retry();
    await settle();
    expect(service.snapshot().deployments[0]?.status).toBe("connected");
    await expect(service.select(target.id)).resolves.toBeUndefined();
    service.dispose();
  });

  it("returns a cancelled attachment to a retryable idle row, not to a false failure", async () => {
    const target = deployment();
    const fixture = fakePorts({ deployments: [target] });
    fixture.establish.mockImplementationOnce(() => new Promise(() => undefined));
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    const selecting = service.select(target.id);
    await settle();
    expect(service.snapshot().deployments[0]).toMatchObject({
      availableActions: ["cancel"],
      status: "connecting",
    });

    await service.cancel();

    expect(fixture.abandonAuthorization).toHaveBeenCalledWith(target.id);
    expect(service.snapshot().deployments[0]).toMatchObject({
      availableActions: ["retry"],
      failure: null,
      status: "idle",
    });
    await service.retry();
    await settle();
    expect(service.snapshot().deployments[0]?.status).toBe("connected");
    await selecting;
    service.dispose();
  });

  it("offers both moves while a browser authorization is open, and drops the flow with either", async () => {
    const target = deployment();
    const fixture = fakePorts({ deployments: [target] });
    const authorizing = {
      attachmentKey: target.key!,
      deploymentId: target.id,
      detail: "Complete authorization in your browser.",
      outcome: "authorizing" as const,
    };
    fixture.establish.mockResolvedValueOnce(authorizing);
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    await service.select(target.id);
    await settle();

    // Waiting on a person's browser is neither a machine-wait nor a failure:
    // it is the one state where stopping and asking again are both real.
    expect(service.snapshot().deployments[0]).toMatchObject({
      availableActions: ["retry", "cancel"],
      failure: null,
      status: "authorizing",
    });

    // Retry opens a fresh authorization, which means the dead flow has to go
    // first — establishing short-circuits on one that is still pending.
    fixture.establish.mockResolvedValueOnce(authorizing);
    await service.retry();
    await settle();
    expect(fixture.abandonAuthorization).toHaveBeenCalledWith(target.id);
    expect(fixture.establish).toHaveBeenCalledTimes(2);
    expect(service.snapshot().deployments[0]?.status).toBe("authorizing");

    await service.cancel();
    expect(fixture.abandonAuthorization).toHaveBeenCalledTimes(2);
    expect(service.snapshot().deployments[0]).toMatchObject({
      availableActions: ["retry"],
      failure: null,
      status: "idle",
    });
    service.dispose();
  });

  it("stops an attempt that has not opened a browser yet, not only one that has", async () => {
    const target = deployment();
    const fixture = fakePorts({ deployments: [target] });
    fixture.establish.mockImplementationOnce(() => new Promise(() => undefined));
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    const selecting = service.select(target.id);
    await settle();
    expect(service.snapshot().deployments[0]?.status).toBe("connecting");

    await service.cancel();

    // An establishment still deciding what to do — resolving a route, waiting
    // on protected storage — would otherwise carry on and open a window after
    // the person already stopped, so every live attempt is abandoned.
    expect(fixture.abandonAuthorization).toHaveBeenCalledWith(target.id);
    await selecting;
    service.dispose();
  });

  it("never abandons a connected row: its live credential is nobody's stale attempt", async () => {
    const target = deployment();
    const fixture = fakePorts({ deployments: [target] });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    await service.select(target.id);
    await settle();
    expect(service.snapshot().deployments[0]?.status).toBe("connected");

    await expect(service.cancel()).rejects.toThrow(/cancel/u);
    expect(fixture.abandonAuthorization).not.toHaveBeenCalled();
    service.dispose();
  });

  it("offers sign-in as a retry that re-opens the Host's own sign-in", async () => {
    const target = deployment();
    const fixture = fakePorts({ deployments: [target] });
    fixture.establish.mockResolvedValueOnce({
      attachmentKey: target.key!,
      deploymentId: target.id,
      detail: "Sign in to this server to continue.",
      outcome: "needs-sign-in",
    });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    await service.select(target.id);
    await settle();

    expect(service.snapshot().deployments[0]).toMatchObject({
      availableActions: ["retry"],
      failure: { code: "host-sign-in-required", retryable: true },
      status: "needs-sign-in",
    });
    await expect(service.retry()).resolves.toBeUndefined();
    await settle();
    expect(fixture.establish).toHaveBeenCalledTimes(2);
    expect(service.snapshot().deployments[0]?.status).toBe("connected");
    service.dispose();
  });

  it("forces a selected deployment's rotated attachment key through close and reverify", async () => {
    const target = deployment({ lastUsedAt: "2026-08-20T10:00:00.000Z" });
    const fixture = fakePorts({ deployments: [target], selectedDeploymentId: target.id });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    await settle();
    expect(service.snapshot().deployments[0]?.status).toBe("connected");

    const rotated = { ...target, key: `${target.key!}:2` };
    fixture.emitCatalog({ deployments: [rotated], selectedDeploymentId: rotated.id });
    await settle();

    expect(fixture.ports.hostSession.closeCurrent).toHaveBeenCalled();
    expect(fixture.establish).toHaveBeenCalledTimes(2);
    expect(service.snapshot().deployments[0]?.status).toBe("connected");
    service.dispose();
  });

  it("never opens a deployment nobody has used, however the selection moved", async () => {
    const first = deployment({ lastUsedAt: "2026-08-20T10:00:00.000Z", name: "A" });
    const fresh = deployment({ name: "B" });
    const fixture = fakePorts({ deployments: [first], selectedDeploymentId: first.id });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    await settle();
    expect(fixture.establish).toHaveBeenCalledOnce();

    fixture.emitCatalog({ deployments: [first, fresh], selectedDeploymentId: fresh.id });
    await settle();

    expect(fixture.establish).toHaveBeenCalledOnce();
    expect(service.snapshot().deployments[1]).toMatchObject({
      availableActions: ["retry"],
      failure: null,
      status: "idle",
    });
    service.dispose();
  });

  it("keeps a deselected deployment's failure from outliving its attempt", async () => {
    const first = deployment({ name: "A" });
    const second = deployment({ name: "B" });
    const fixture = fakePorts({ deployments: [first, second] });
    fixture.establish.mockRejectedValueOnce(new TypeError("network unavailable"));
    const scheduled: Array<() => void> = [];
    const service = new DeploymentAccessService(fixture.ports, {
      schedule: (callback) => scheduled.push(callback),
    });
    await service.initialize();
    await service.select(first.id);
    await settle();
    expect(service.snapshot().deployments[0]?.failure).toMatchObject({ retryable: true });

    await service.select(second.id);
    await settle();
    scheduled.forEach((run) => run());
    await settle();

    expect(service.snapshot().deployments[0]).toMatchObject({
      availableActions: ["select"],
      failure: null,
      status: "idle",
    });
    expect(service.snapshot().deployments[1]?.status).toBe("connected");
    service.dispose();
  });

  it("reports a catalog it cannot read instead of freezing on the last good revision", async () => {
    const target = deployment();
    const fixture = fakePorts({ deployments: [target] });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    const before = service.snapshot().revision;

    fixture.readCatalog.mockRejectedValueOnce(
      new Error("The deployment connection catalog on this computer is incompatible or corrupt."),
    );
    fixture.emitCatalog({ deployments: [], selectedDeploymentId: null });
    await settle();

    const snapshot = service.snapshot();
    expect(snapshot.revision).toBeGreaterThan(before);
    expect(snapshot.deployments).toHaveLength(1);
    expect(snapshot.personalSetup).toMatchObject({
      canStart: false,
      issue: {
        detail: "The deployment connection catalog on this computer is incompatible or corrupt.",
      },
      state: "repair-required",
    });
    await expect(service.createPersonalDeployment()).rejects.toThrow("not available");
    service.dispose();
  });

  it("finishes an activating Account link instead of refusing the affordance it advertises", async () => {
    const fixture = fakePorts();
    const activating = {
      account: null,
      deploymentId: readyPersonalStatus.deploymentId,
      displayName: "This computer",
      status: "activating" as const,
      unlinkStep: null,
    };
    fixture.personalAccountStatus.mockResolvedValue(activating);
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    fixture.emitPersonal(readyPersonalStatus);
    await settle();

    await expect(service.linkPersonal()).resolves.toBeUndefined();
    expect(fixture.ports.personalAccount.link).toHaveBeenCalledOnce();
    service.dispose();
  });

  it("classifies every effect-port failure at its seam", () => {
    const ports: readonly DeploymentAccessPort[] = ["catalog", "directory"];
    for (const port of ports) {
      expect(classifyPortFailure(port, new TypeError("network unavailable")).classification).toBe(
        "transient",
      );
      expect(classifyPortFailure(port, new Error("Authority changed.")).classification).toBe(
        "blocked",
      );
      expect(classifyPortFailure(port, new Error("Authority changed.")).code).toMatch(
        /^[a-z0-9-]+$/u,
      );
    }
  });

  it("projects Account directory failures instead of presenting a silent empty list", async () => {
    const fixture = fakePorts();
    vi.spyOn(fixture.ports.account, "currentState").mockResolvedValueOnce({
      account: {
        available: true,
        detail: null,
        identity: {
          issuer: "https://accounts.opensteer.test",
          subject: `acct_${crypto.randomUUID()}`,
        },
        status: "signed-in",
      },
      schemaVersion: 2,
    });
    vi.mocked(fixture.ports.directory.syncAccountDeployments).mockRejectedValueOnce(
      new Error("Account Host discovery was rejected."),
    );
    const service = new DeploymentAccessService(fixture.ports);

    await service.initialize();
    await settle();

    expect(service.snapshot().directoryFailure).toEqual({
      code: "directory-blocked",
      detail: "Account Host discovery was rejected.",
      retryable: false,
    });
    service.dispose();
  });

  it("carries directory entries it could not verify, with the reason, into the snapshot", async () => {
    const unreachable = [
      {
        accountAccess: "member" as const,
        deploymentId: createId("deployment"),
        name: "Studio Mac",
        reason: "host-unavailable" as const,
      },
    ];
    const fixture = fakePorts({ directoryUnavailable: unreachable });
    vi.spyOn(fixture.ports.account, "currentState").mockResolvedValueOnce(signedInAccount());
    // Nothing in the catalog moved: the unreachable list is the only news, and
    // it still has to reach the renderer.
    vi.mocked(fixture.ports.directory.syncAccountDeployments).mockResolvedValueOnce({
      changed: false,
      unavailable: unreachable,
    });
    const service = new DeploymentAccessService(fixture.ports);

    await service.initialize();
    await settle();

    const snapshot = service.snapshot();
    expect(snapshot.unavailable).toEqual(unreachable);
    expect(Object.isFrozen(snapshot.unavailable)).toBe(true);
    expect(Object.isFrozen(snapshot.unavailable[0])).toBe(true);
    expect(snapshot.deployments).toHaveLength(0);
    service.dispose();
  });

  it("drops unreachable directory entries when the Account signs out", async () => {
    const unreachable = [
      {
        accountAccess: "member" as const,
        deploymentId: createId("deployment"),
        name: "Studio Mac",
        reason: "identity-mismatch" as const,
      },
    ];
    const fixture = fakePorts({ directoryUnavailable: unreachable });
    vi.spyOn(fixture.ports.account, "currentState").mockResolvedValueOnce(signedInAccount());
    const service = new DeploymentAccessService(fixture.ports);

    await service.initialize();
    await settle();
    expect(service.snapshot().unavailable).toEqual(unreachable);

    fixture.signOut.mockResolvedValueOnce({
      account: { available: true, detail: null, identity: null, status: "signed-out" },
      schemaVersion: 2,
    });
    await service.signOut();

    expect(service.snapshot().unavailable).toEqual([]);
    service.dispose();
  });

  it("keeps Account sign-in available and fails Personal creation closed when bootstrap storage fails", async () => {
    const failedPersonal = {
      ...personalStatus,
      canStart: true,
      issue: {
        code: "directory-invalid" as const,
        component: "desktop" as const,
        detail: "Personal deployment manifest is incompatible or corrupt.",
        repairAction: "restore-permissions" as const,
      },
      state: "repair-required" as const,
    };
    const fixture = fakePorts({ personal: failedPersonal });
    fixture.readCatalog.mockRejectedValueOnce(
      new Error("Personal deployment manifest is incompatible or corrupt."),
    );
    const service = new DeploymentAccessService(fixture.ports);

    await service.initialize();

    expect(service.snapshot()).toMatchObject({
      account: { available: true, status: "signed-out" },
      deployments: [],
      personalSetup: {
        issue: { detail: "Personal deployment manifest is incompatible or corrupt." },
        state: "repair-required",
      },
    });
    expect(service.snapshot().account.available).toBe(true);
    expect(service.snapshot().personalSetup?.canStart).toBe(false);
    service.dispose();
  });

  it("preserves configured Account capability when the credential cache cannot load", async () => {
    const fixture = fakePorts();
    fixture.currentState.mockRejectedValueOnce(new Error("Credential cache is corrupt."));
    const service = new DeploymentAccessService(fixture.ports);

    await service.initialize();

    expect(service.snapshot().account).toMatchObject({
      available: true,
      detail: "Credential cache is corrupt.",
      status: "error",
    });
    expect(service.snapshot().account.available).toBe(true);
    service.dispose();
  });

  it("refreshes the Account-link projection when a newly created Personal Host becomes ready", async () => {
    const fixture = fakePorts();
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();

    expect(service.snapshot().personalAccountLink.status).toBe("unavailable");
    fixture.personalAccountStatus.mockResolvedValueOnce({
      account: null,
      deploymentId: readyPersonalStatus.deploymentId,
      displayName: "This computer",
      status: "unlinked",
      unlinkStep: null,
    });
    fixture.emitPersonal(readyPersonalStatus);
    await settle();

    expect(fixture.personalAccountStatus).toHaveBeenCalledTimes(2);
    expect(service.snapshot().personalAccountLink).toMatchObject({
      deploymentId: readyPersonalStatus.deploymentId,
      status: "unlinked",
    });
    service.dispose();
  });

  /*
   * What the place list may claim. Every case below is a way the list could
   * tell a person something untrue: a computer that is fine shown as offline,
   * a list from an expired sign-in shown as current, a guess shown as a fact.
   */
  describe("what the place list can claim", () => {
    const otherMac = (connect: { readonly livenessExpiresAt: string | null } | null) =>
      deployment({
        accountAccess: "owner",
        connect,
        kind: "personal",
        name: "Studio Mac",
        source: "account",
      });
    const liveLease = "2026-10-20T20:01:30.000Z";

    it("hides Account places while signed out, and shows them again on sign-in without re-adding them", async () => {
      const server = deployment({ name: "Team server", source: "account" });
      const added = deployment({ name: "Lab server" });
      const fixture = fakePorts({ deployments: [server, added] });
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();

      expect(service.snapshot().deployments.map(({ name }) => name)).toEqual(["Lab server"]);
      fixture.emitAccount(signedInAccount());
      await settle();
      expect(service.snapshot().deployments.map(({ name }) => name)).toEqual([
        "Team server",
        "Lab server",
      ]);
      fixture.emitAccount(expiredAccount());
      await settle();
      expect(service.snapshot().deployments.map(({ name }) => name)).toEqual(["Lab server"]);
      service.dispose();
    });

    it("refuses to open an Account place it is not showing", async () => {
      const server = deployment({ name: "Team server", source: "account" });
      const fixture = fakePorts({ deployments: [server] });
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();

      await expect(service.select(server.id)).rejects.toThrow(/not available/u);
      expect(fixture.select).not.toHaveBeenCalled();
      service.dispose();
    });

    it("keeps the Account place a person is in, asks them to sign in again, and does not reopen it on its own", async () => {
      const mac = otherMac({ livenessExpiresAt: liveLease });
      const fixture = fakePorts({
        deployments: [{ ...mac, lastUsedAt: "2026-10-19T10:00:00.000Z" }],
        selectedDeploymentId: mac.id,
      });
      fixture.currentState.mockResolvedValueOnce(expiredAccount());
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();
      await settle();

      const [row] = service.snapshot().deployments;
      expect(row?.id).toBe(mac.id);
      expect(row?.statusInfo).toEqual({
        label: "Sign in again",
        reason: "Sign in again to keep using Studio Mac.",
        status: "attention",
      });
      expect(fixture.establish).not.toHaveBeenCalled();
      service.dispose();
    });

    it("re-reads the place list when a different Account signs in, never when a token is merely refreshed", async () => {
      const fixture = fakePorts();
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();
      const account = signedInAccount();

      fixture.emitAccount(account);
      await settle();
      fixture.emitAccount(account);
      fixture.emitAccount({ ...account });
      await settle();
      expect(fixture.ports.directory.syncAccountDeployments).toHaveBeenCalledTimes(1);

      fixture.emitAccount(signedInAccount());
      await settle();
      expect(fixture.ports.directory.syncAccountDeployments).toHaveBeenCalledTimes(2);
      service.dispose();
    });

    it("says Checking while an old list is being re-read, then what the fresh list says", async () => {
      const fixture = fakePorts({ deployments: [otherMac({ livenessExpiresAt: liveLease })] });
      fixture.currentState.mockResolvedValueOnce(signedInAccount());
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();
      fixture.clock.now += 5 * 60_000;
      const sync = deferred<{ changed: boolean; unavailable: [] }>();
      vi.mocked(fixture.ports.directory.syncAccountDeployments).mockReturnValueOnce(sync.promise);

      const check = service.checkDeployments();
      expect(service.snapshot().deployments[0]?.statusInfo).toEqual({
        reason: null,
        status: "checking",
      });
      fixture.clock.now = Date.parse("2026-10-20T20:00:30.000Z") + 5 * 60_000;
      vi.mocked(fixture.ports.catalog.read).mockResolvedValueOnce({
        deployments: [otherMac({ livenessExpiresAt: "2026-10-20T20:06:30.000Z" })],
        revision: 9,
        selectedDeploymentId: null,
      });
      sync.resolve({ changed: true, unavailable: [] });
      await check;
      expect(service.snapshot().deployments[0]?.statusInfo).toEqual({
        reason: null,
        status: "ready",
      });
      service.dispose();
    });

    it("does not renew an old verdict after an ambient refresh that did not run successfully", async () => {
      const fixture = fakePorts({ deployments: [otherMac({ livenessExpiresAt: liveLease })] });
      fixture.currentState.mockResolvedValueOnce(signedInAccount());
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();
      fixture.clock.now += 30_000;
      vi.mocked(fixture.ports.directory.syncAccountDeployments).mockResolvedValueOnce({
        changed: false,
        unavailable: [],
      });

      service.wake();
      await settle();
      expect(fixture.ports.directory.syncAccountDeployments).toHaveBeenLastCalledWith(
        "ambient",
        "wake",
      );
      expect(service.snapshot().deployments[0]?.statusInfo.status).toBe("ready");
      fixture.clock.now += 30_000;
      expect(service.snapshot().deployments[0]?.statusInfo).toEqual({
        reason: null,
        status: "checking",
      });
      service.dispose();
    });

    it("keeps a failed check visible after an ambient refresh that did not run successfully", async () => {
      const fixture = fakePorts({ deployments: [otherMac({ livenessExpiresAt: liveLease })] });
      fixture.currentState.mockResolvedValueOnce(signedInAccount());
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();
      fixture.clock.now += 60_000;
      vi.mocked(fixture.ports.directory.syncAccountDeployments).mockRejectedValueOnce(
        new TypeError("fetch failed"),
      );
      await service.checkDeployments();
      const failure = service.snapshot().directoryFailure;
      expect(failure?.retryable).toBe(true);
      vi.mocked(fixture.ports.directory.syncAccountDeployments).mockResolvedValueOnce({
        changed: false,
        unavailable: [],
      });

      service.networkChanged();
      await settle();
      expect(fixture.ports.directory.syncAccountDeployments).toHaveBeenLastCalledWith(
        "ambient",
        "network",
      );
      expect(service.snapshot().directoryFailure).toEqual(failure);
      expect(service.snapshot().deployments[0]?.statusInfo).toMatchObject({
        label: "Couldn’t check",
        status: "attention",
      });
      service.dispose();
    });

    it("expires a slow sync's verdict one minute after the read started, with the check floor counted from completion", async () => {
      const fixture = fakePorts({ deployments: [otherMac({ livenessExpiresAt: liveLease })] });
      fixture.currentState.mockResolvedValueOnce(signedInAccount());
      const readAt = fixture.clock.now;
      vi.mocked(fixture.ports.directory.syncAccountDeployments).mockImplementationOnce(async () => {
        fixture.clock.now += 20_000;
        return { changed: true, unavailable: [] };
      });
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();

      await service.checkDeployments();
      fixture.clock.now += 4_999;
      await service.checkDeployments();
      expect(fixture.ports.directory.syncAccountDeployments).toHaveBeenCalledTimes(1);
      fixture.clock.now = readAt + 59_999;
      expect(service.snapshot().deployments[0]?.statusInfo.status).toBe("ready");
      fixture.clock.now += 1;
      expect(service.snapshot().deployments[0]?.statusInfo).toEqual({
        reason: null,
        status: "checking",
      });
      service.dispose();
    });

    it("never calls a computer offline because its sign-in lease went unread", async () => {
      const fixture = fakePorts({ deployments: [otherMac({ livenessExpiresAt: liveLease })] });
      fixture.currentState.mockResolvedValueOnce(signedInAccount());
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();

      // Days later, with nothing re-read since, the old lease has long lapsed.
      fixture.clock.now += 3 * 24 * 60 * 60_000;
      expect(service.snapshot().deployments[0]?.statusInfo.status).not.toBe("offline");
      service.dispose();
    });

    it("says it could not check, not that a computer is offline, when the list cannot be re-read", async () => {
      const fixture = fakePorts({ deployments: [otherMac({ livenessExpiresAt: liveLease })] });
      fixture.currentState.mockResolvedValueOnce(signedInAccount());
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();
      fixture.clock.now += 5 * 60_000;
      vi.mocked(fixture.ports.directory.syncAccountDeployments).mockRejectedValueOnce(
        Object.assign(new TypeError("fetch failed")),
      );

      await service.checkDeployments();
      expect(service.snapshot().deployments[0]?.statusInfo).toMatchObject({
        label: "Couldn’t check",
        status: "attention",
      });
      expect(service.snapshot().directoryFailure?.retryable).toBe(true);
      service.dispose();
    });

    it("lets an old unreachable verdict lapse, so a recovered place is never stuck behind it", async () => {
      const server = deployment({ name: "Team server", source: "account" });
      const unreachable = [
        {
          accountAccess: "member" as const,
          deploymentId: server.id,
          name: "Team server",
          reason: "host-unavailable" as const,
        },
      ];
      const fixture = fakePorts({ deployments: [server], directoryUnavailable: unreachable });
      fixture.currentState.mockResolvedValueOnce(signedInAccount());
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();
      expect(service.snapshot().deployments[0]?.statusInfo.status).toBe("offline");

      fixture.clock.now += 5 * 60_000;
      vi.mocked(fixture.ports.directory.syncAccountDeployments).mockRejectedValueOnce(
        new TypeError("fetch failed"),
      );
      await service.checkDeployments();
      expect(service.snapshot().deployments[0]?.statusInfo).toMatchObject({
        label: "Couldn’t check",
        status: "attention",
      });
      expect(service.snapshot().deployments[0]?.availableActions).toEqual(["select"]);
      service.dispose();
    });

    it("does not ask a failing Account again on every click", async () => {
      const fixture = fakePorts({ deployments: [otherMac({ livenessExpiresAt: liveLease })] });
      fixture.currentState.mockResolvedValueOnce(signedInAccount());
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();
      fixture.clock.now += 5 * 60_000;
      vi.mocked(fixture.ports.directory.syncAccountDeployments)
        .mockClear()
        .mockRejectedValue(Object.assign(new Error("Too many requests"), { status: 429 }));

      await service.checkDeployments();
      await service.checkDeployments();
      await service.checkDeployments();
      expect(fixture.ports.directory.syncAccountDeployments).toHaveBeenCalledTimes(1);
      fixture.clock.now += 6_000;
      await service.checkDeployments();
      expect(fixture.ports.directory.syncAccountDeployments).toHaveBeenCalledTimes(2);
      service.dispose();
    });

    it("tells a sleeping computer from one whose remote access is off, and offers neither as openable", async () => {
      const asleep = otherMac({ livenessExpiresAt: "2026-10-20T19:58:00.000Z" });
      const closed = deployment({
        accountAccess: "owner",
        attachmentKey: null,
        kind: "personal",
        name: "Office Mac",
        routes: [{ kind: "canonical", origin: "http://127.0.0.1:4310" }],
        source: "account",
      });
      const fixture = fakePorts({ deployments: [asleep, closed] });
      fixture.currentState.mockResolvedValueOnce(signedInAccount());
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();

      const [sleeping, off] = service.snapshot().deployments;
      expect(sleeping?.statusInfo).toEqual({
        reason:
          "Studio Mac is asleep, or Opensteer isn’t open on it. Wake it up and open Opensteer, then check again.",
        status: "offline",
      });
      expect(off?.statusInfo).toEqual({
        label: "Remote access off",
        reason: "Remote access is off on Office Mac. Turn it on there in Settings › Remote access.",
        status: "offline",
      });
      expect(sleeping?.availableActions).toEqual([]);
      expect(off?.availableActions).toEqual([]);
      service.dispose();
    });

    it("reads a place the Account listed but could not reach as unreachable, not ready", async () => {
      const server = deployment({ name: "Team server", source: "account" });
      const unreachable = [
        {
          accountAccess: "member" as const,
          deploymentId: server.id,
          name: "Team server",
          reason: "host-unavailable" as const,
        },
      ];
      const fixture = fakePorts({ deployments: [server], directoryUnavailable: unreachable });
      fixture.currentState.mockResolvedValueOnce(signedInAccount());
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();

      expect(service.snapshot().deployments[0]?.statusInfo).toEqual({
        reason: "Team server can’t be reached right now.",
        status: "offline",
      });
      service.dispose();
    });

    it("proves a place added by hand is there, and the same place, before calling it ready", async () => {
      const lab = deployment({ name: "Lab server" });
      const legacy = deployment({ name: "Old server" });
      const elsewhere = deployment({ name: "Moved server" });
      const gone = deployment({ name: "Gone server" });
      const fixture = fakePorts({ deployments: [lab, legacy, elsewhere, gone] });
      const outcomes = new Map<string, DeploymentProbeOutcome>([
        [lab.id, "reachable"],
        [legacy.id, "host-too-old"],
        [elsewhere.id, "identity-mismatch"],
        [gone.id, "unreachable"],
      ]);
      fixture.probe.mockImplementation(async (id) => outcomes.get(id) ?? "unreachable");
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();

      // Nothing has been checked yet, so nothing is claimed.
      expect(service.snapshot().deployments.map(({ statusInfo }) => statusInfo.status)).toEqual([
        "checking",
        "checking",
        "checking",
        "checking",
      ]);
      await service.checkDeployments();
      expect(service.snapshot().deployments.map(({ statusInfo }) => statusInfo)).toEqual([
        { reason: null, status: "ready" },
        {
          label: "Needs update",
          reason: "Old server needs an Opensteer update to work with this app.",
          status: "attention",
        },
        {
          label: "Can’t verify",
          reason: "Something other than Moved server answered at its address.",
          status: "attention",
        },
        {
          label: "Not responding",
          reason:
            "Gone server didn’t answer just now. Make sure it’s on and reachable, then try again.",
          status: "attention",
        },
      ]);
      service.dispose();
    });

    it.each(["unreachable", "rejected"])(
      "keeps a manual place openable after an %s probe",
      async (outcome) => {
        const lab = deployment({ name: "Lab server" });
        const fixture = fakePorts({ deployments: [lab] });
        if (outcome === "unreachable") fixture.probe.mockResolvedValueOnce("unreachable");
        else fixture.probe.mockRejectedValueOnce(new TypeError("fetch failed"));
        const service = new DeploymentAccessService(fixture.ports, fixture.options);
        await service.initialize();

        await service.checkDeployments();
        expect(service.snapshot().deployments[0]?.availableActions).toEqual(["select"]);
        await service.select(lab.id);
        expect(fixture.select).toHaveBeenCalledWith(lab.id);
        expect(fixture.establish).toHaveBeenCalledWith(lab.id);
        service.dispose();
      },
    );

    it("checks each place at most once while a check is still fresh", async () => {
      const lab = deployment({ name: "Lab server" });
      const fixture = fakePorts({ deployments: [lab] });
      fixture.currentState.mockResolvedValueOnce(signedInAccount());
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();
      vi.mocked(fixture.ports.directory.syncAccountDeployments).mockClear();

      await Promise.all([service.checkDeployments(), service.checkDeployments()]);
      await service.checkDeployments();
      expect(fixture.probe).toHaveBeenCalledTimes(1);
      expect(fixture.ports.directory.syncAccountDeployments).toHaveBeenCalledTimes(0);

      fixture.clock.now += 6_000;
      await service.checkDeployments();
      expect(fixture.probe).toHaveBeenCalledTimes(2);
      expect(fixture.ports.directory.syncAccountDeployments).toHaveBeenCalledTimes(1);
      service.dispose();
    });

    it("says this computer is offline instead of blaming every other place", async () => {
      const lab = deployment({ name: "Lab server" });
      const fixture = fakePorts({ deployments: [lab, otherMac({ livenessExpiresAt: liveLease })] });
      fixture.currentState.mockResolvedValueOnce(signedInAccount());
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();
      fixture.network.online = false;

      await service.checkDeployments();
      expect(fixture.probe).not.toHaveBeenCalled();
      expect(service.snapshot().deployments.map(({ statusInfo }) => statusInfo)).toEqual(
        Array(2).fill({
          label: "You’re offline",
          reason: "This computer isn’t connected to the internet.",
          status: "attention",
        }),
      );
      service.dispose();
    });

    it("calls the place a person is connected to ready, whatever an old list says", async () => {
      const mac = otherMac({ livenessExpiresAt: "2026-10-20T19:00:00.000Z" });
      const fixture = fakePorts({
        deployments: [{ ...mac, lastUsedAt: "2026-10-19T10:00:00.000Z" }],
        selectedDeploymentId: mac.id,
      });
      fixture.currentState.mockResolvedValueOnce(signedInAccount());
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();
      await settle();

      expect(service.snapshot().deployments[0]?.status).toBe("connected");
      expect(service.snapshot().deployments[0]?.statusInfo).toEqual({
        reason: null,
        status: "ready",
      });
      service.dispose();
    });
  });
});

function expiredAccount(): DesktopAccountAuthState {
  return {
    account: {
      available: true,
      detail: "Your Opensteer Account authorization expired. Sign in again.",
      identity: null,
      status: "error",
    },
    schemaVersion: 2,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function signedInAccount(): DesktopAccountAuthState {
  return {
    account: {
      available: true,
      detail: null,
      identity: {
        issuer: "https://accounts.opensteer.test",
        subject: `acct_${crypto.randomUUID()}`,
      },
      status: "signed-in",
    },
    schemaVersion: 2,
  };
}

function fakePorts(
  options: {
    readonly deployments?: CatalogProjection["deployments"];
    readonly directoryUnavailable?: readonly DeploymentAccessUnavailable[];
    readonly personal?: DeploymentAccessPorts["personal"]["status"];
    readonly selectedDeploymentId?: string;
  } = {},
) {
  const clock = { now: Date.parse("2026-10-20T20:00:00.000Z") };
  const network = { online: true };
  const probe = vi.fn(
    async (_deploymentId: string, _signal: AbortSignal): Promise<DeploymentProbeOutcome> =>
      "reachable",
  );
  const signedOut: DesktopAccountAuthState = {
    account: { available: true, detail: null, identity: null, status: "signed-out" },
    schemaVersion: 2,
  };
  const authorizing: DesktopAccountAuthState = {
    account: {
      available: true,
      detail: "Finish in your browser.",
      identity: null,
      status: "authorizing",
    },
    schemaVersion: 2,
  };
  const catalog: CatalogProjection = {
    deployments: options.deployments ?? [],
    revision: 1,
    selectedDeploymentId: options.selectedDeploymentId ?? null,
  };
  const beginSignIn = vi.fn(async () => authorizing);
  const select = vi.fn(async (deploymentId: string) => {
    projection = {
      deployments: projection.deployments,
      revision: projection.revision + 1,
      selectedDeploymentId: deploymentId,
    };
    return projection;
  });
  const establish = vi.fn(async (deploymentId: string): Promise<HostSessionObservation> => ({
    attachmentKey:
      projection.deployments.find(({ id }) => id === deploymentId)?.key ??
      `attachment:${deploymentId}`,
    deploymentId,
    outcome: "ready",
  }));
  const abandonAuthorization = vi.fn((_deploymentId: string) => undefined);
  const readCatalog = vi.fn(async () => projection);
  const currentState = vi.fn(async () => signedOut);
  const signOut = vi.fn(async () => signedOut);
  const accountListeners = new Set<(state: DesktopAccountAuthState) => void>();
  const catalogListeners = new Set<() => void>();
  const hostSessionListeners = new Set<(observation: HostSessionObservation) => void>();
  let projection: CatalogProjection = catalog;
  const personalListeners = new Set<
    (status: DeploymentAccessPorts["personal"]["status"]) => void
  >();
  const personalAccountStatus = vi.fn(
    async (): Promise<DesktopPersonalAccountLinkStatus> => personalLinkStatus,
  );
  const ports: DeploymentAccessPorts = {
    account: {
      available: true,
      beginReauthorization: vi.fn(async () => authorizing),
      beginSignIn,
      currentState,
      signOut,
      subscribe: (listener) => {
        accountListeners.add(listener);
        return () => accountListeners.delete(listener);
      },
    },
    catalog: {
      read: readCatalog,
      select,
      subscribe: (listener) => {
        catalogListeners.add(listener);
        return () => catalogListeners.delete(listener);
      },
    },
    direct: {
      addRoute: vi.fn(async () => catalog),
      connect: vi.fn(async () => catalog),
    },
    directory: {
      removeFromAccount: vi.fn(async () => undefined),
      syncAccountDeployments: vi.fn(async () => ({
        changed: true,
        unavailable: options.directoryUnavailable ?? [],
      })),
    },
    hostSession: {
      abandonAuthorization,
      closeCurrent: vi.fn(async () => undefined),
      establish,
      subscribe: (listener: (observation: HostSessionObservation) => void) => {
        hostSessionListeners.add(listener);
        return () => hostSessionListeners.delete(listener);
      },
    },
    personal: {
      start: vi.fn(async () => personalStatus),
      status: options.personal ?? personalStatus,
      subscribe: (listener) => {
        personalListeners.add(listener);
        return () => personalListeners.delete(listener);
      },
    },
    personalAccount: {
      link: vi.fn(async () => personalLinkStatus),
      resetJournal: vi.fn(async () => personalLinkStatus),
      status: personalAccountStatus,
      subscribe: () => () => undefined,
      unlink: vi.fn(async () => personalLinkStatus),
    },
    places: {
      online: () => network.online,
      probe,
    },
  };
  return {
    abandonAuthorization,
    beginSignIn,
    clock,
    network,
    options: { now: () => clock.now },
    probe,
    currentState,
    emitAccount(state: DesktopAccountAuthState) {
      for (const listener of accountListeners) listener(state);
    },
    emitCatalog(next: Omit<CatalogProjection, "revision">) {
      projection = { ...next, revision: projection.revision + 1 };
      for (const listener of catalogListeners) listener();
    },
    emitHostSession(observation: HostSessionObservation) {
      for (const listener of hostSessionListeners) listener(observation);
    },
    establish,
    emitPersonal(status: DeploymentAccessPorts["personal"]["status"]) {
      for (const listener of personalListeners) listener(status);
    },
    personalAccountStatus,
    ports,
    readCatalog,
    select,
    signOut,
  };
}

const personalStatus = {
  canStart: true,
  components: {
    browser: { state: "stopped" as const, version: null },
    host: { state: "stopped" as const, version: null },
    messaging: { state: "stopped" as const, version: null },
    postgresql: { state: "stopped" as const, version: null },
    runner: { state: "stopped" as const, version: null },
  },
  deploymentId: null,
  environmentId: null,
  issue: null,
  schemaVersion: 1 as const,
  state: "stopped" as const,
  step: null,
};

const readyPersonalStatus = {
  ...personalStatus,
  canStart: false,
  deploymentId: createId("deployment"),
  environmentId: createId("environment"),
  state: "ready" as const,
  step: "ready" as const,
};

const personalLinkStatus = {
  account: null,
  deploymentId: null,
  displayName: null,
  status: "unavailable" as const,
  unlinkStep: null,
};

function deployment(
  overrides: {
    readonly accountAccess?: "owner" | "member" | null;
    readonly attachmentKey?: string | null;
    readonly id?: string;
    readonly kind?: "personal" | "self-hosted";
    readonly lastUsedAt?: string | null;
    readonly name?: string;
    readonly onThisComputer?: boolean;
    readonly routes?: readonly { readonly kind: "canonical" | "direct"; readonly origin: string }[];
    readonly source?: "account" | "manual" | "this-device";
    /** An Account Personal row's signed Connect route and its liveness lease. */
    readonly connect?: { readonly livenessExpiresAt: string | null } | null;
  } = {},
): CatalogProjection["deployments"][number] {
  const origin = "https://host.example.test";
  const summary = DesktopDeploymentSummarySchema.parse({
    access: overrides.attachmentKey === null ? null : "native",
    activeOrigin: origin,
    canonicalOrigin: origin,
    id: overrides.id ?? createId("deployment"),
    kind: overrides.kind ?? "self-hosted",
    lastUsedAt: overrides.lastUsedAt ?? null,
    name: overrides.name ?? "Host",
    onThisComputer: overrides.onThisComputer ?? false,
    routes: (overrides.routes ?? [{ kind: "canonical", origin }]).map((route) => ({
      ...route,
      selected: route.origin === origin,
    })),
  });
  return {
    ...summary,
    accountAccess: overrides.accountAccess ?? null,
    accountLivenessExpiresAt: overrides.connect?.livenessExpiresAt ?? null,
    hasAccountConnectRoute: overrides.connect != null,
    hasVerifiedAccountRoute: overrides.connect != null,
    key:
      overrides.attachmentKey === undefined ? `attachment:${summary.id}` : overrides.attachmentKey,
    source: overrides.source ?? "manual",
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
