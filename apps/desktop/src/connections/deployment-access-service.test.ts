import { ClientOperationError, HostTransportError } from "@opensteer/client/connections";
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
  DeploymentAccessRefusal,
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

  it("keeps main attachment one-shot until the renderer requests another attempt", async () => {
    const target = deployment();
    const fixture = fakePorts({ deployments: [target] });
    fixture.establish
      .mockRejectedValueOnce(new HostTransportError("unreachable"))
      .mockResolvedValueOnce({
        attachmentKey: target.key!,
        deploymentId: target.id,
        outcome: "ready",
      });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    await service.select(target.id);

    expect(fixture.establish).toHaveBeenCalledOnce();
    expect(service.snapshot().deployments[0]).toMatchObject({
      failure: { retryable: true },
      status: "offline",
    });
    await service.retry();
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
    // knows — a Home at its own address that was never opened is not "Starting…".
    expect(service.snapshot().deployments.map(({ statusInfo }) => statusInfo)).toEqual([
      { reason: null, status: "ready" },
      {
        label: "Can’t be opened from here",
        reason:
          "Mac mini can only be used on that computer. Turn on Remote access there, in Settings › Account.",
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

    fixture.emitPersonal({
      ...readyPersonalStatus,
      deploymentId: local.id,
      components: {
        ...readyPersonalStatus.components,
        runner: { state: "starting", version: null },
        browser: { state: "starting", version: null },
      },
    });
    await settle();

    expect(fixture.establish).toHaveBeenCalledOnce();
    expect(service.snapshot().deployments[0]?.status).toBe("connected");
    service.dispose();
  });

  it("never publishes (ready, idle) while a returning local startup transitions to connecting", async () => {
    const local = deployment({
      attachmentKey: "owner",
      kind: "personal",
      lastUsedAt: "2026-08-20T10:00:00.000Z",
      name: "This Mac",
      onThisComputer: true,
      source: "this-device",
    });
    const starting = {
      ...personalStatus,
      canStart: false,
      deploymentId: local.id,
      state: "starting" as const,
      step: "starting-host" as const,
    };
    const ready = { ...readyPersonalStatus, deploymentId: local.id };
    const fixture = fakePorts({
      deployments: [{ ...local, access: "native", key: "native" }],
      personal: starting,
      selectedDeploymentId: local.id,
    });
    const service = new DeploymentAccessService(fixture.ports);
    const observed: Array<{
      personalState: string | null;
      selectedStatus: string | null;
    }> = [];
    const record = (snap: ReturnType<DeploymentAccessService["snapshot"]>) => {
      observed.push({
        personalState: snap.personalSetup?.state ?? null,
        selectedStatus: snap.deployments.find(({ id }) => id === local.id)?.status ?? null,
      });
    };
    service.subscribe(record);

    await service.initialize();
    await settle();
    expect(fixture.establish).not.toHaveBeenCalled();

    // Defer the catalog reload and resolve personalAccount.status() before it finishes.
    const catalogRead = Promise.withResolvers<CatalogProjection>();
    vi.mocked(fixture.ports.catalog.read).mockReturnValueOnce(catalogRead.promise);
    fixture.personalAccountStatus.mockResolvedValueOnce({
      account: null,
      deploymentId: local.id,
      displayName: "This Mac",
      status: "unlinked",
      unlinkStep: null,
    });

    fixture.emitPersonal(ready);
    await settle();
    // Synchronous snapshot() while catalog reload is still in flight must not leak (ready, idle).
    record(service.snapshot());

    fixture.replaceCatalog({ deployments: [local], selectedDeploymentId: local.id });
    catalogRead.resolve({
      deployments: [local],
      revision: 2,
      selectedDeploymentId: local.id,
    });
    await settle();

    expect(fixture.establish).toHaveBeenCalledOnce();
    expect(service.snapshot().personalSetup?.state).toBe("ready");
    expect(service.snapshot().deployments[0]?.status).toBe("connected");
    expect(
      observed.filter(
        ({ personalState, selectedStatus }) =>
          personalState === "ready" && selectedStatus === "idle",
      ),
    ).toEqual([]);
    service.dispose();
  });

  it("handles cancel, reselection, out-of-order reads, null keys, and catalog failures while ready is staged", async () => {
    const local = deployment({
      attachmentKey: "owner",
      kind: "personal",
      lastUsedAt: "2026-08-20T10:00:00.000Z",
      name: "This Mac",
      onThisComputer: true,
      source: "this-device",
    });
    const remote = deployment({ name: "Server" });
    const starting = {
      ...personalStatus,
      canStart: false,
      deploymentId: local.id,
      state: "starting" as const,
      step: "starting-host" as const,
    };
    const ready = { ...readyPersonalStatus, deploymentId: local.id };

    // 1) Out-of-order catalog reads keep staged ready until the winning read lands.
    {
      const fixture = fakePorts({
        deployments: [{ ...local, access: "native", key: "native" }],
        personal: starting,
        selectedDeploymentId: local.id,
      });
      const service = new DeploymentAccessService(fixture.ports);
      const leaked: unknown[] = [];
      service.subscribe((snap) => {
        if (snap.personalSetup?.state === "ready" && snap.deployments[0]?.status === "idle") {
          leaked.push(snap);
        }
      });
      await service.initialize();
      await settle();
      const first = Promise.withResolvers<CatalogProjection>();
      const second = Promise.withResolvers<CatalogProjection>();
      vi.mocked(fixture.ports.catalog.read)
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      fixture.emitPersonal(ready);
      fixture.emitCatalog({ deployments: [local], selectedDeploymentId: local.id });
      first.resolve({
        deployments: [{ ...local, access: "native", key: "native" }],
        revision: 2,
        selectedDeploymentId: local.id,
      });
      await settle();
      expect(service.snapshot().personalSetup?.state).toBe("starting");
      fixture.replaceCatalog({ deployments: [local], selectedDeploymentId: local.id });
      second.resolve({ deployments: [local], revision: 3, selectedDeploymentId: local.id });
      await settle();
      expect(leaked).toEqual([]);
      expect(fixture.establish).toHaveBeenCalledOnce();
      expect(service.snapshot().deployments[0]?.status).toBe("connected");
      service.dispose();
    }

    // 2) Cancel while ready is staged commits ready + idle cleanly and never attaches on late reload.
    {
      const fixture = fakePorts({
        deployments: [{ ...local, access: "native", key: "native" }],
        personal: starting,
        selectedDeploymentId: local.id,
      });
      const service = new DeploymentAccessService(fixture.ports);
      await service.initialize();
      await settle();
      await service.signIn();
      const read = Promise.withResolvers<CatalogProjection>();
      vi.mocked(fixture.ports.catalog.read).mockReturnValueOnce(read.promise);
      fixture.emitPersonal(ready);
      await service.cancel();
      expect(service.snapshot().personalSetup?.state).toBe("ready");
      expect(service.snapshot().deployments[0]?.status).toBe("idle");
      read.resolve({ deployments: [local], revision: 2, selectedDeploymentId: local.id });
      await settle();
      expect(fixture.establish).not.toHaveBeenCalled();
      service.dispose();
    }

    // 3) Null key after reload surfaces needs-remote-access instead of idle.
    {
      const fixture = fakePorts({
        deployments: [{ ...local, access: "native", key: "native" }],
        personal: starting,
        selectedDeploymentId: local.id,
      });
      const service = new DeploymentAccessService(fixture.ports);
      await service.initialize();
      await settle();
      const read = Promise.withResolvers<CatalogProjection>();
      vi.mocked(fixture.ports.catalog.read).mockReturnValueOnce(read.promise);
      fixture.emitPersonal(ready);
      read.resolve({
        deployments: [{ ...local, access: null, key: null }],
        revision: 2,
        selectedDeploymentId: local.id,
      });
      await settle();
      expect(fixture.establish).not.toHaveBeenCalled();
      expect(service.snapshot().personalSetup?.state).toBe("ready");
      expect(service.snapshot().deployments[0]?.status).toBe("needs-remote-access");
      service.dispose();
    }

    // 4) Catalog read failure while ready is staged reports repair-required and never leaks (ready, idle).
    {
      const fixture = fakePorts({
        deployments: [{ ...local, access: "native", key: "native" }],
        personal: starting,
        selectedDeploymentId: local.id,
      });
      const service = new DeploymentAccessService(fixture.ports);
      const leaked: unknown[] = [];
      service.subscribe((snap) => {
        if (snap.personalSetup?.state === "ready" && snap.deployments[0]?.status === "idle") {
          leaked.push(snap);
        }
      });
      await service.initialize();
      await settle();
      vi.mocked(fixture.ports.catalog.read).mockRejectedValueOnce(new Error("disk read failed"));
      fixture.emitPersonal(ready);
      await settle();
      expect(leaked).toEqual([]);
      expect(service.snapshot().personalSetup?.state).toBe("repair-required");
      service.dispose();
    }

    // 5) Reselection while ready is staged commits ready without attaching the old local deployment.
    {
      const fixture = fakePorts({
        deployments: [{ ...local, access: "native", key: "native" }, remote],
        personal: starting,
        selectedDeploymentId: local.id,
      });
      const service = new DeploymentAccessService(fixture.ports);
      await service.initialize();
      await settle();
      const read = Promise.withResolvers<CatalogProjection>();
      vi.mocked(fixture.ports.catalog.read).mockReturnValueOnce(read.promise);
      fixture.emitPersonal(ready);
      await service.select(remote.id);
      read.resolve({ deployments: [local, remote], revision: 2, selectedDeploymentId: local.id });
      await settle();
      expect(fixture.establish).toHaveBeenCalledExactlyOnceWith(remote.id, true);
      expect(service.snapshot().personalSetup?.state).toBe("ready");
      service.dispose();
    }

    // 6) Startup when local Personal Host is already ready never leaks (ready, idle), even while signed in.
    {
      const fixture = fakePorts({
        deployments: [local],
        personal: ready,
        selectedDeploymentId: local.id,
      });
      fixture.currentState.mockResolvedValueOnce(signedInAccount());
      const syncGate = Promise.withResolvers<{
        changed: boolean;
        unavailable: readonly DeploymentAccessUnavailable[];
      }>();
      vi.mocked(fixture.ports.directory.syncAccountDeployments).mockReturnValueOnce(
        syncGate.promise,
      );
      const service = new DeploymentAccessService(fixture.ports);
      const leaked: unknown[] = [];
      service.subscribe((snap) => {
        if (snap.personalSetup?.state === "ready" && snap.deployments[0]?.status === "idle") {
          leaked.push(snap);
        }
      });
      const initializing = service.initialize();
      await settle();
      expect(service.snapshot().deployments[0]?.status).toBe("connected");
      syncGate.resolve({ changed: false, unavailable: [] });
      await initializing;
      expect(leaked).toEqual([]);
      expect(fixture.establish).toHaveBeenCalledOnce();
      service.dispose();
    }

    // 7) Held local restart with simultaneous key rotation attaches once and never leaks (ready, idle).
    {
      const first = deployment({
        attachmentKey: "owner:1",
        kind: "personal",
        lastUsedAt: "2026-08-20T10:00:00.000Z",
        name: "This Mac",
        onThisComputer: true,
        source: "this-device",
      });
      const firstReady = { ...readyPersonalStatus, deploymentId: first.id };
      const fixture = fakePorts({
        deployments: [first],
        personal: firstReady,
        selectedDeploymentId: first.id,
      });
      const service = new DeploymentAccessService(fixture.ports);
      const leaked: unknown[] = [];
      service.subscribe((snap) => {
        if (snap.personalSetup?.state === "ready" && snap.deployments[0]?.status === "idle") {
          leaked.push(snap);
        }
      });
      await service.initialize();
      await settle();
      fixture.replaceCatalog({
        deployments: [{ ...first, access: "native", key: "native" }],
        selectedDeploymentId: first.id,
      });
      fixture.emitPersonal({ ...firstReady, canStart: true, state: "degraded", step: null });
      await settle();
      const rotated = { ...first, key: "owner:2" };
      const read = Promise.withResolvers<CatalogProjection>();
      vi.mocked(fixture.ports.catalog.read).mockReturnValueOnce(read.promise);
      fixture.emitPersonal(firstReady);
      fixture.replaceCatalog({ deployments: [rotated], selectedDeploymentId: first.id });
      read.resolve({ deployments: [rotated], revision: 3, selectedDeploymentId: first.id });
      await settle();
      expect(leaked).toEqual([]);
      expect(fixture.establish).toHaveBeenCalledTimes(2);
      expect(service.snapshot().deployments[0]).toMatchObject({
        attachmentKey: "owner:2",
        status: "connected",
      });
      service.dispose();
    }

    // 8) First-time setup (createPersonalDeployment) never leaks (ready, idle) before catalog reload attaches.
    {
      const created = deployment({
        attachmentKey: "owner",
        kind: "personal",
        lastUsedAt: "2026-08-20T10:00:00.000Z",
        name: "This Mac",
        onThisComputer: true,
        source: "this-device",
      });
      const createdReady = { ...readyPersonalStatus, deploymentId: created.id };
      const fixture = fakePorts({
        deployments: [],
        personal: {
          ...personalStatus,
          canStart: true,
          deploymentId: null,
          state: "stopped",
          step: null,
        },
      });
      const startGate = Promise.withResolvers<DeploymentAccessPorts["personal"]["status"]>();
      vi.mocked(fixture.ports.personal.start).mockReturnValueOnce(startGate.promise);
      const service = new DeploymentAccessService(fixture.ports);
      const leaked: unknown[] = [];
      service.subscribe((snap) => {
        if (
          snap.personalSetup?.state === "ready" &&
          snap.deployments.find(({ id }) => id === created.id)?.status === "idle"
        ) {
          leaked.push(snap);
        }
      });
      await service.initialize();
      const creating = service.createPersonalDeployment();
      fixture.replaceCatalog({ deployments: [created], selectedDeploymentId: created.id });
      const catalogRead = Promise.withResolvers<CatalogProjection>();
      vi.mocked(fixture.ports.catalog.read).mockReturnValueOnce(catalogRead.promise);
      fixture.emitPersonal(createdReady);
      expect(service.snapshot().personalSetup?.state).not.toBe("ready");
      catalogRead.resolve({
        deployments: [created],
        revision: 2,
        selectedDeploymentId: created.id,
      });
      await settle();
      expect(fixture.establish).toHaveBeenCalledOnce();
      expect(service.snapshot().deployments[0]?.status).toBe("connected");

      // A subsequent supervisor ready update while create-personal is still active must not re-establish.
      const updatedReady = {
        ...createdReady,
        components: {
          ...createdReady.components,
          runner: { state: "ready" as const, version: "1.0.0" },
        },
      };
      fixture.emitPersonal(updatedReady);
      await settle();
      startGate.resolve(updatedReady);
      await creating;
      await settle();
      expect(leaked).toEqual([]);
      expect(fixture.establish).toHaveBeenCalledOnce();
      expect(service.snapshot().personalSetup?.state).toBe("ready");
      expect(service.snapshot().personalSetup?.components.runner.state).toBe("ready");
      expect(service.snapshot().deployments[0]?.status).toBe("connected");
      service.dispose();
    }

    // 9) Reselecting the same local Host keeps staged ready held even if an earlier catalog read resolves while catalog.select() is pending.
    {
      const fixture = fakePorts({
        deployments: [{ ...local, access: "native", key: "native" }],
        personal: starting,
        selectedDeploymentId: local.id,
      });
      const closeGate = Promise.withResolvers<void>();
      const selectGate = Promise.withResolvers<CatalogProjection>();
      vi.mocked(fixture.ports.hostSession.closeCurrent).mockReturnValueOnce(closeGate.promise);
      vi.mocked(fixture.ports.catalog.select).mockReturnValueOnce(selectGate.promise);
      const service = new DeploymentAccessService(fixture.ports);
      const leaked: unknown[] = [];
      const check = (snap: ReturnType<DeploymentAccessService["snapshot"]>) => {
        if (snap.personalSetup?.state === "ready" && snap.deployments[0]?.status === "idle") {
          leaked.push(snap);
        }
      };
      service.subscribe(check);
      await service.initialize();
      await settle();
      const read = Promise.withResolvers<CatalogProjection>();
      vi.mocked(fixture.ports.catalog.read).mockReturnValueOnce(read.promise);
      fixture.emitPersonal(ready);
      const reselecting = service.select(local.id);
      check(service.snapshot());
      expect(service.snapshot().personalSetup?.state).toBe("starting");
      fixture.replaceCatalog({ deployments: [local], selectedDeploymentId: local.id });
      closeGate.resolve();
      await settle();
      // Earlier reload fails, then a recovery read succeeds, AND an overlapping select() of the same Home adopts the open in flight,
      // all while catalog.select() is still in flight: none of them may release the guard or leak (ready, idle).
      read.reject(new Error("transient catalog read failure"));
      await settle();
      check(service.snapshot());
      fixture.emitCatalog({ deployments: [local], selectedDeploymentId: local.id });
      await settle();
      check(service.snapshot());
      // Opening the same Home again is the open already under way: it adopts that outcome.
      const again = service.select(local.id);
      check(service.snapshot());
      expect(service.snapshot().personalSetup?.state).toBe("starting");
      selectGate.resolve({ deployments: [local], revision: 3, selectedDeploymentId: local.id });
      await reselecting;
      await expect(again).resolves.toBeUndefined();
      expect(fixture.ports.catalog.select).toHaveBeenCalledTimes(1);
      await settle();
      expect(leaked).toEqual([]);
      expect(fixture.establish).toHaveBeenCalledOnce();
      expect(service.snapshot().personalSetup?.state).toBe("ready");
      expect(service.snapshot().deployments[0]?.status).toBe("connected");
      service.dispose();
    }

    // 10) Startup initialize() does not overwrite a newer catalog notification that landed during a slow account read.
    {
      const accountGate = Promise.withResolvers<DesktopAccountAuthState>();
      const fixture = fakePorts({ deployments: [] });
      fixture.currentState.mockReturnValueOnce(accountGate.promise);
      const service = new DeploymentAccessService(fixture.ports);
      const initializing = service.initialize();
      await settle();
      fixture.emitCatalog({ deployments: [local], selectedDeploymentId: local.id });
      await settle();
      accountGate.resolve({
        account: { available: true, detail: null, identity: null, status: "signed-out" },
        schemaVersion: 2,
      });
      await initializing;
      expect(service.snapshot().selectedDeploymentId).toBe(local.id);
      service.dispose();
    }
  });

  it("holds a connected local attachment through a Host restart until the supervisor is ready", async () => {
    const owner = deployment({
      attachmentKey: "owner:first",
      kind: "personal",
      lastUsedAt: "2026-08-20T10:00:00.000Z",
      onThisComputer: true,
      source: "this-device",
    });
    const ready = { ...readyPersonalStatus, deploymentId: owner.id };
    const fixture = fakePorts({
      deployments: [owner],
      personal: ready,
      selectedDeploymentId: owner.id,
    });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    await settle();
    expect(fixture.establish).toHaveBeenCalledOnce();
    expect(service.snapshot().deployments[0]?.status).toBe("connected");

    // The Host crashed: no runtime, so the row resolves to its loopback address.
    const restarting = { ...ready, canStart: true, state: "degraded" as const, step: null };
    fixture.replaceCatalog({
      deployments: [{ ...owner, access: "native", key: "native" }],
      selectedDeploymentId: owner.id,
    });
    fixture.emitPersonal(restarting);
    await settle();
    // The new Host is serving, but its owner claim and Runner are not back yet.
    fixture.replaceCatalog({
      deployments: [{ ...owner, key: "owner:second" }],
      selectedDeploymentId: owner.id,
    });
    fixture.emitPersonal({ ...restarting, step: "starting-host" });
    await settle();

    expect(fixture.establish).toHaveBeenCalledOnce();
    expect(service.snapshot().deployments[0]).toMatchObject({
      attachmentKey: "owner:second",
      failure: null,
      status: "connecting",
    });

    fixture.emitPersonal(ready);
    await settle();

    expect(fixture.establish).toHaveBeenCalledTimes(2);
    expect(service.snapshot().deployments[0]).toMatchObject({
      attachmentKey: "owner:second",
      status: "connected",
    });

    // The next restart's new key and its ready arrive in one read: one establishment.
    fixture.replaceCatalog({
      deployments: [{ ...owner, access: "native", key: "native" }],
      selectedDeploymentId: owner.id,
    });
    fixture.emitPersonal(restarting);
    await settle();
    fixture.replaceCatalog({
      deployments: [{ ...owner, key: "owner:third" }],
      selectedDeploymentId: owner.id,
    });
    fixture.emitPersonal(ready);
    await settle();
    expect(fixture.establish).toHaveBeenCalledTimes(3);
    expect(service.snapshot().deployments[0]).toMatchObject({
      attachmentKey: "owner:third",
      status: "connected",
    });

    // A restart that gives up leaves the row to the supervisor's own failure.
    fixture.replaceCatalog({
      deployments: [{ ...owner, access: "native", key: "native" }],
      selectedDeploymentId: owner.id,
    });
    fixture.emitPersonal(restarting);
    await settle();
    expect(service.snapshot().deployments[0]?.status).toBe("connecting");
    fixture.emitPersonal({ ...restarting, state: "repair-required" });
    await settle();

    expect(fixture.establish).toHaveBeenCalledTimes(3);
    expect(service.snapshot().deployments[0]).toMatchObject({ failure: null, status: "idle" });
    service.dispose();
  });

  it("attaches a restarted local Host once, whatever order its reads and Retry finish in", async () => {
    const owner = deployment({
      attachmentKey: "owner",
      kind: "personal",
      lastUsedAt: "2026-08-20T10:00:00.000Z",
      onThisComputer: true,
      source: "this-device",
    });
    const ready = { ...readyPersonalStatus, deploymentId: owner.id };
    const restarting = { ...ready, canStart: true, state: "degraded" as const, step: null };
    const fixture = fakePorts({
      deployments: [owner],
      personal: ready,
      selectedDeploymentId: owner.id,
    });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    await settle();
    const down = { deployments: [{ ...owner, access: "native" as const, key: "native" }] };
    const crash = async () => {
      fixture.replaceCatalog({ ...down, selectedDeploymentId: owner.id });
      fixture.emitPersonal(restarting);
      await settle();
      expect(service.snapshot().deployments[0]?.status).toBe("connecting");
    };
    const read = () => {
      const pending = Promise.withResolvers<CatalogProjection>();
      vi.mocked(fixture.ports.catalog.read).mockReturnValueOnce(pending.promise);
      return pending;
    };
    const back = (revision: number) => ({
      deployments: [owner],
      revision,
      selectedDeploymentId: owner.id,
    });

    // The Host serves again while the stack is still degraded, then is ready; the
    // older read answers between ready and the newer read's answer.
    await crash();
    fixture.replaceCatalog({ deployments: [owner], selectedDeploymentId: owner.id });
    const serving = read();
    fixture.emitPersonal({ ...restarting, step: "starting-host" });
    const readied = read();
    fixture.emitPersonal(ready);
    serving.resolve(back(10));
    await settle();
    readied.resolve(back(11));
    await settle();
    expect(fixture.establish).toHaveBeenCalledTimes(2);
    expect(service.snapshot().deployments[0]?.status).toBe("connected");

    // A Retry pressed during a restart that recovers by itself attaches nothing more.
    await crash();
    const started = Promise.withResolvers<typeof ready>();
    vi.mocked(fixture.ports.personal.start).mockReturnValueOnce(started.promise);
    const retrying = service.retry();
    fixture.replaceCatalog({ deployments: [owner], selectedDeploymentId: owner.id });
    fixture.emitPersonal(ready);
    await settle();
    started.resolve(ready);
    await retrying;
    await settle();
    expect(fixture.establish).toHaveBeenCalledTimes(3);
    expect(service.snapshot().deployments[0]?.status).toBe("connected");
    service.dispose();
  });

  it("lets Cancel win over a local Retry whose restart is still running", async () => {
    const owner = deployment({
      attachmentKey: "owner",
      kind: "personal",
      lastUsedAt: "2026-08-20T10:00:00.000Z",
      onThisComputer: true,
      source: "this-device",
    });
    const ready = { ...readyPersonalStatus, deploymentId: owner.id };
    const fixture = fakePorts({
      deployments: [owner],
      personal: ready,
      selectedDeploymentId: owner.id,
    });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    await settle();
    const restarting = { ...ready, canStart: true, state: "degraded" as const, step: null };
    fixture.replaceCatalog({
      deployments: [{ ...owner, access: "native", key: "native" }],
      selectedDeploymentId: owner.id,
    });
    fixture.emitPersonal(restarting);
    await settle();
    expect(service.snapshot().deployments[0]?.status).toBe("connecting");

    const started = Promise.withResolvers<typeof ready>();
    vi.mocked(fixture.ports.personal.start).mockReturnValueOnce(started.promise);
    const retrying = service.retry();
    // The restart it asked for is under way: stopping the wait stays on offer.
    fixture.emitPersonal({ ...restarting, canStart: false, state: "starting" });
    await settle();
    expect(service.snapshot().deployments[0]).toMatchObject({
      availableActions: ["cancel"],
      status: "connecting",
    });
    await service.cancel();
    expect(service.snapshot().deployments[0]?.status).toBe("idle");
    fixture.replaceCatalog({ deployments: [owner], selectedDeploymentId: owner.id });
    fixture.emitPersonal(ready);
    started.resolve(ready);
    await retrying;
    await settle();

    expect(fixture.establish).toHaveBeenCalledOnce();
    expect(service.snapshot().deployments[0]?.status).toBe("idle");
    service.dispose();
  });

  it("attaches a local Host whose first attempt failed once its restart is ready", async () => {
    const owner = deployment({
      attachmentKey: "owner",
      kind: "personal",
      lastUsedAt: "2026-08-20T10:00:00.000Z",
      onThisComputer: true,
      source: "this-device",
    });
    const ready = { ...readyPersonalStatus, deploymentId: owner.id };
    const fixture = fakePorts({
      deployments: [owner],
      personal: ready,
      selectedDeploymentId: owner.id,
    });
    fixture.establish.mockRejectedValueOnce(new HostTransportError("unreachable"));
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    await settle();
    expect(service.snapshot().deployments[0]?.status).toBe("offline");

    // Main never reads the Host as down: it is back under its own key, still degraded.
    fixture.emitPersonal({ ...ready, canStart: true, state: "degraded", step: null });
    await settle();
    expect(service.snapshot().deployments[0]?.status).toBe("connecting");
    fixture.emitPersonal(ready);
    await settle();

    expect(fixture.establish).toHaveBeenCalledTimes(2);
    expect(service.snapshot().deployments[0]?.status).toBe("connected");
    service.dispose();
  });

  it("opens this computer's Host when its supervisor selects it while another read is answered first", async () => {
    const remote = deployment({ lastUsedAt: "2026-08-20T09:00:00.000Z", name: "Server" });
    const local = deployment({
      attachmentKey: "owner",
      kind: "personal",
      lastUsedAt: "2026-08-20T10:00:00.000Z",
      onThisComputer: true,
      source: "this-device",
    });
    const fixture = fakePorts({
      deployments: [remote, local],
      personal: { ...readyPersonalStatus, deploymentId: local.id, state: "starting" },
      selectedDeploymentId: remote.id,
    });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    await settle();
    expect(fixture.establish).toHaveBeenCalledExactlyOnceWith(remote.id, false);

    // The supervisor selects its Host; that catalog notice's read is answered last.
    const selection = Promise.withResolvers<CatalogProjection>();
    vi.mocked(fixture.ports.catalog.read).mockReturnValueOnce(selection.promise);
    fixture.emitCatalog({ deployments: [remote, local], selectedDeploymentId: local.id });
    fixture.emitPersonal({ ...readyPersonalStatus, deploymentId: local.id });
    await settle();
    selection.resolve({
      deployments: [remote, local],
      revision: 1,
      selectedDeploymentId: local.id,
    });
    await settle();

    expect(fixture.establish).toHaveBeenLastCalledWith(local.id, false);
    expect(service.snapshot().deployments[1]?.status).toBe("connected");
    service.dispose();
  });

  it("keeps the newest place list when an older read finishes last", async () => {
    const owner = deployment({
      attachmentKey: "owner",
      kind: "personal",
      lastUsedAt: "2026-08-20T10:00:00.000Z",
      onThisComputer: true,
      source: "this-device",
    });
    const ready = { ...readyPersonalStatus, deploymentId: owner.id };
    const fixture = fakePorts({
      deployments: [owner],
      personal: ready,
      selectedDeploymentId: owner.id,
    });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    await settle();
    expect(service.snapshot().deployments[0]?.status).toBe("connected");

    // Read while the Host was down, answered only after the read that saw it back.
    const stale = Promise.withResolvers<CatalogProjection>();
    vi.mocked(fixture.ports.catalog.read).mockReturnValueOnce(stale.promise);
    fixture.emitPersonal({ ...ready, state: "degraded", step: null });
    fixture.emitPersonal(ready);
    await settle();
    stale.resolve({
      deployments: [{ ...owner, access: "native", key: "native" }],
      revision: 2,
      selectedDeploymentId: owner.id,
    });
    await settle();

    expect(fixture.establish).toHaveBeenCalledOnce();
    expect(service.snapshot().deployments[0]).toMatchObject({
      attachmentKey: "owner",
      status: "connected",
    });
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
    expect(fixture.establish).toHaveBeenLastCalledWith(remote.id, false);

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
    expect(fixture.establish).toHaveBeenCalledWith(remote.id, true);
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
    const service = new DeploymentAccessService(fixture.ports);
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
    expect(fixture.establish).toHaveBeenLastCalledWith(target.id, false);
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
    fixture.establish.mockRejectedValueOnce(new HostTransportError("unreachable"));
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    await service.select(first.id);
    await settle();
    expect(service.snapshot().deployments[0]?.failure).toMatchObject({ retryable: true });

    await service.select(second.id);
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
        detail: "Couldn't confirm this change.",
      },
      state: "repair-required",
    });
    await expect(service.createPersonalDeployment()).rejects.toThrow("not available");
    service.dispose();
  });

  it("starts a setup again that failed before its Deployment was listed, and only then", async () => {
    const failed = {
      ...personalStatus,
      canStart: true,
      deploymentId: createId("deployment"),
      issue: {
        code: "database-unavailable" as const,
        component: "postgresql" as const,
        detail: "Another app is using port 5432. Quit it, then try again.",
        repairAction: "restart-opensteer" as const,
      },
      state: "repair-required" as const,
      step: null,
    };
    const fixture = fakePorts({ personal: failed });
    const service = new DeploymentAccessService(fixture.ports);
    await service.initialize();
    // Nothing is listed to retry through, so setting up again is the way on.
    await expect(service.createPersonalDeployment()).resolves.toBeUndefined();
    expect(fixture.ports.personal.start).toHaveBeenCalledOnce();
    service.dispose();

    const listed = fakePorts({
      deployments: [deployment({ id: failed.deploymentId, onThisComputer: true })],
      personal: failed,
    });
    const listedService = new DeploymentAccessService(listed.ports);
    await listedService.initialize();
    await expect(listedService.createPersonalDeployment()).rejects.toThrow("not available");
    expect(listed.ports.personal.start).not.toHaveBeenCalled();
    listedService.dispose();
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
      expect(classifyPortFailure(port, new HostTransportError("unreachable")).classification).toBe(
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
      new ClientOperationError("PRIVATE discovery detail", "blocked", {
        reason: "rejected",
        provenance: "host",
      }),
    );
    const service = new DeploymentAccessService(fixture.ports);

    await service.initialize();
    await settle();

    expect(service.snapshot().directoryFailure).toEqual({
      code: "directory-rejected",
      detail: "Couldn't complete this action.",
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
        issue: { detail: "Couldn't confirm this change." },
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
      detail: "Couldn't confirm this change.",
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

  describe("one foreground operation at a time", () => {
    const unlinked = {
      account: null,
      deploymentId: readyPersonalStatus.deploymentId,
      displayName: "This computer",
      status: "unlinked" as const,
      unlinkStep: null,
    };
    /** This Mac's Home is set up and reported ready, while its setup is still finishing. */
    async function settingUp() {
      const fixture = fakePorts();
      const started = deferred<typeof readyPersonalStatus>();
      vi.mocked(fixture.ports.personal.start).mockReturnValueOnce(started.promise);
      fixture.personalAccountStatus.mockResolvedValue(unlinked);
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();
      const creating = service.createPersonalDeployment();
      await settle();
      // The supervisor says ready before its start has finished its last steps.
      fixture.emitPersonal(readyPersonalStatus);
      await settle();
      return { creating, fixture, service, started };
    }

    it("lets a link asked while this Mac is still being set up wait its turn, then run as its own outcome", async () => {
      const { creating, fixture, service, started } = await settingUp();
      const linking = service.linkPersonal();
      await settle();
      expect(fixture.ports.personalAccount.link).not.toHaveBeenCalled();
      started.resolve(readyPersonalStatus);
      await creating;
      await expect(linking).resolves.toBeUndefined();
      expect(fixture.ports.personalAccount.link).toHaveBeenCalledTimes(1);
      service.dispose();
    });

    it("lets a second ask for the link that is running adopt its outcome, in either order of callers", async () => {
      const { creating, fixture, service, started } = await settingUp();
      started.resolve(readyPersonalStatus);
      await creating;
      const link = deferred<typeof unlinked>();
      vi.mocked(fixture.ports.personalAccount.link).mockReturnValueOnce(link.promise as never);
      const first = service.linkPersonal();
      await settle();
      const second = service.linkPersonal();
      link.resolve({ ...unlinked, status: "linked" } as never);
      await expect(first).resolves.toBeUndefined();
      await expect(second).resolves.toBeUndefined();
      expect(fixture.ports.personalAccount.link).toHaveBeenCalledTimes(1);
      service.dispose();
    });

    it("refuses a turn that never comes in a plain sentence, never as already running", async () => {
      const { fixture, service } = await settingUp();
      vi.useFakeTimers();
      try {
        const linking = service.linkPersonal();
        const refused = expect(linking).rejects.toEqual(
          new DeploymentAccessRefusal(
            "Opensteer is still finishing another change on this Mac. Try again in a moment.",
          ),
        );
        fixture.clock.now += 2 * 60_000;
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        await refused;
        // Refused on purpose, with the words a person reads, not as a fault.
        expect(await linking.catch((error: unknown) => error)).toBeInstanceOf(
          DeploymentAccessRefusal,
        );
        expect(fixture.ports.personalAccount.link).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
        service.dispose();
      }
    });
  });

  describe("signing in when this Mac's keychain refuses Opensteer", () => {
    const keychainRefused: DesktopAccountAuthState = {
      account: {
        available: false,
        detail:
          "macOS Keychain is not accepting protected storage. In Keychain Access, lock and unlock the login keychain, then try again.",
        identity: null,
        status: "error",
      },
      schemaVersion: 2,
    };

    it("lets the person try again, which reads the keychain afresh through the account's own sign-in", async () => {
      const fixture = fakePorts();
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();
      fixture.emitAccount(keychainRefused);
      await settle();
      await service.signIn();
      expect(fixture.beginSignIn).toHaveBeenCalledOnce();
      service.dispose();
    });

    it("says plainly that the keychain still refuses, when it does", async () => {
      const fixture = fakePorts();
      fixture.beginSignIn.mockRejectedValueOnce(
        new Error("macOS Keychain is not accepting protected storage."),
      );
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();
      fixture.emitAccount(keychainRefused);
      await settle();
      const refused = await service.signIn().catch((error: unknown) => error);
      expect(refused).toEqual(
        new DeploymentAccessRefusal(
          "Opensteer still can’t use this Mac’s keychain. Unlock the login keychain, then try again.",
        ),
      );
      service.dispose();
    });

    it("still refuses a build with no account to sign in to", async () => {
      const fixture = fakePorts();
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();
      fixture.emitAccount({
        account: {
          available: false,
          detail: "Opensteer account sign-in isn't available yet.",
          identity: null,
          status: "signed-out",
        },
        schemaVersion: 2,
      });
      await settle();
      await expect(service.signIn()).rejects.toThrow("not available now: signIn");
      expect(fixture.beginSignIn).not.toHaveBeenCalled();
      service.dispose();
    });
  });

  /*
   * Whether two asks are the same is what they ask for, not what kind of change they are. The
   * same ask twice runs once and both hear its outcome; the same kind for another target waits
   * its turn and runs for its own target, never adopting the first one's result.
   */
  describe("the same request, by what it asks for", () => {
    const origin = (name: string) => `https://${name}.example.test`;

    async function listing(deployments: CatalogProjection["deployments"], signedIn = false) {
      const fixture = fakePorts({ deployments });
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();
      if (signedIn) {
        fixture.emitAccount(signedInAccount());
        await settle();
      }
      return { fixture, service };
    }

    /** Holds the port's next answers until each is released, in the order they were asked. */
    function held<T>(
      port: { mockImplementationOnce(fn: () => Promise<T>): unknown },
      count: number,
    ) {
      const gates = Array.from({ length: count }, () => deferred<T>());
      for (const gate of gates) port.mockImplementationOnce(() => gate.promise);
      return gates;
    }

    it("adds a route for each Home asked, in order, when two different ones are asked at once", async () => {
      const a = deployment({ name: "A" });
      const b = deployment({ name: "B" });
      const { fixture, service } = await listing([a, b]);
      const addRoute = vi.mocked(fixture.ports.direct.addRoute);
      const catalog = await fixture.ports.catalog.read();
      const [first, second] = held(addRoute, 2);
      const forA = service.addDirect({ deploymentId: a.id as never, origin: origin("a") });
      const forB = service.addDirect({ deploymentId: b.id as never, origin: origin("b") });
      await settle();
      expect(addRoute.mock.calls.map(([input]) => input.deploymentId)).toEqual([a.id]);
      first!.resolve(catalog);
      await expect(forA).resolves.toBeUndefined();
      await settle();
      expect(addRoute.mock.calls.map(([input]) => input.deploymentId)).toEqual([a.id, b.id]);
      second!.resolve(catalog);
      await expect(forB).resolves.toBeUndefined();
      service.dispose();
    });

    it("adds one route when the same one is asked twice, and both callers hear it", async () => {
      const a = deployment({ name: "A" });
      const { fixture, service } = await listing([a]);
      const addRoute = vi.mocked(fixture.ports.direct.addRoute);
      const [only] = held(addRoute, 1);
      const input = { deploymentId: a.id as never, origin: origin("a") };
      const one = service.addDirect(input);
      const two = service.addDirect({ ...input });
      await settle();
      only!.reject(new Error("That address didn't answer."));
      await expect(one).rejects.toThrow("That address didn't answer.");
      await expect(two).rejects.toThrow("That address didn't answer.");
      expect(addRoute).toHaveBeenCalledTimes(1);
      service.dispose();
    });

    it("connects each address asked, in order, and the same address once", async () => {
      const { fixture, service } = await listing([]);
      const connect = vi.mocked(fixture.ports.direct.connect);
      const catalog = await fixture.ports.catalog.read();
      const [first, second] = held(connect, 2);
      const a = service.connectPrivate({ kind: "address", origin: origin("a") });
      const aAgain = service.connectPrivate({ kind: "address", origin: origin("a") });
      const b = service.connectPrivate({ kind: "address", origin: origin("b") });
      await settle();
      expect(connect.mock.calls.map(([input]) => input.origin)).toEqual([origin("a")]);
      first!.resolve(catalog);
      await expect(a).resolves.toBeUndefined();
      await expect(aAgain).resolves.toBeUndefined();
      await settle();
      expect(connect.mock.calls.map(([input]) => input.origin)).toEqual([origin("a"), origin("b")]);
      second!.resolve(catalog);
      await expect(b).resolves.toBeUndefined();
      service.dispose();
    });

    it("removes each Home asked from the account, in order, and the same Home once", async () => {
      const a = deployment({ accountAccess: "member", name: "A", source: "account" });
      const b = deployment({ accountAccess: "member", name: "B", source: "account" });
      const { fixture, service } = await listing([a, b], true);
      const remove = vi.mocked(fixture.ports.directory.removeFromAccount);
      remove.mockClear();
      const [first, second] = held(remove, 2);
      const removingA = service.removeFromAccount(a.id);
      const removingAAgain = service.removeFromAccount(a.id);
      const removingB = service.removeFromAccount(b.id);
      await settle();
      expect(remove.mock.calls.map(([id]) => id)).toEqual([a.id]);
      first!.resolve(undefined);
      await expect(removingA).resolves.toBeUndefined();
      await expect(removingAAgain).resolves.toBeUndefined();
      await settle();
      expect(remove.mock.calls.map(([id]) => id)).toEqual([a.id, b.id]);
      second!.resolve(undefined);
      await expect(removingB).resolves.toBeUndefined();
      service.dispose();
    });

    it("opens a Home after a route added for another, never taking that route's outcome as its own", async () => {
      const a = deployment({ name: "A" });
      const b = deployment({ name: "B" });
      const { fixture, service } = await listing([a, b]);
      const addRoute = vi.mocked(fixture.ports.direct.addRoute);
      const catalog = await fixture.ports.catalog.read();
      const [route] = held(addRoute, 1);
      const adding = service.addDirect({ deploymentId: a.id as never, origin: origin("a") });
      const opening = service.select(b.id);
      await settle();
      expect(fixture.select).not.toHaveBeenCalled();
      route!.resolve(catalog);
      await adding;
      await expect(opening).resolves.toBeUndefined();
      expect(fixture.select).toHaveBeenCalledExactlyOnceWith(b.id);
      service.dispose();
    });

    it("runs a removal and an open of the same Home in the order asked, each for itself", async () => {
      const a = deployment({
        accountAccess: "member",
        connect: { livenessExpiresAt: "2026-10-20T20:01:30.000Z" },
        name: "A",
        source: "account",
      });
      // Removal first, then the open waits its turn.
      {
        const { fixture, service } = await listing([a], true);
        const remove = vi.mocked(fixture.ports.directory.removeFromAccount);
        const [removal] = held(remove, 1);
        const removing = service.removeFromAccount(a.id);
        const opening = service.select(a.id);
        await settle();
        expect(fixture.select).not.toHaveBeenCalled();
        removal!.resolve(undefined);
        await removing;
        await expect(opening).resolves.toBeUndefined();
        expect(fixture.select).toHaveBeenCalledExactlyOnceWith(a.id);
        service.dispose();
      }
      // The removal takes the Home off the list, as the account does: the open that waited
      // behind it finds nothing to open and is refused as not there, never run against it.
      {
        const { fixture, service } = await listing([a], true);
        const remove = vi.mocked(fixture.ports.directory.removeFromAccount);
        const [removal] = held(remove, 1);
        const removing = service.removeFromAccount(a.id);
        const opening = service.select(a.id);
        await settle();
        fixture.replaceCatalog({ deployments: [], selectedDeploymentId: null });
        removal!.resolve(undefined);
        await removing;
        const refused = await opening.catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(DeploymentAccessRefusal);
        expect((refused as DeploymentAccessRefusal).words).toBe(
          "A is no longer in your Opensteers.",
        );
        expect(fixture.select).not.toHaveBeenCalled();
        expect(service.snapshot().deployments).toEqual([]);
        service.dispose();
      }
      // The open finishes first and its Home leaves the list: the removal that waited is told so.
      {
        const { fixture, service } = await listing([a], true);
        const remove = vi.mocked(fixture.ports.directory.removeFromAccount);
        remove.mockClear();
        const [open] = held(fixture.select, 1);
        const opening = service.select(a.id);
        const removing = service.removeFromAccount(a.id);
        await settle();
        fixture.replaceCatalog({ deployments: [], selectedDeploymentId: null });
        open!.resolve({ deployments: [], revision: 9, selectedDeploymentId: null });
        await opening.catch(() => undefined);
        await expect(removing).rejects.toEqual(
          new DeploymentAccessRefusal("A is no longer in your Opensteers."),
        );
        expect(remove).not.toHaveBeenCalled();
        service.dispose();
      }
      // Open first, then the removal waits its turn.
      {
        const { fixture, service } = await listing([a], true);
        const remove = vi.mocked(fixture.ports.directory.removeFromAccount);
        remove.mockClear();
        const [open] = held(fixture.select, 1);
        const opening = service.select(a.id);
        const removing = service.removeFromAccount(a.id);
        await settle();
        expect(remove).not.toHaveBeenCalled();
        open!.resolve(await fixture.ports.catalog.read());
        await opening;
        await expect(removing).resolves.toBeUndefined();
        expect(remove).toHaveBeenCalledExactlyOnceWith(a.id);
        service.dispose();
      }
    });
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
      const server = deployment({ name: "Studio server", source: "account" });
      const added = deployment({ name: "Lab server" });
      const fixture = fakePorts({ deployments: [server, added] });
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();

      expect(service.snapshot().deployments.map(({ name }) => name)).toEqual(["Lab server"]);
      fixture.emitAccount(signedInAccount());
      await settle();
      expect(service.snapshot().deployments.map(({ name }) => name)).toEqual([
        "Studio server",
        "Lab server",
      ]);
      fixture.emitAccount(expiredAccount());
      await settle();
      expect(service.snapshot().deployments.map(({ name }) => name)).toEqual(["Lab server"]);
      service.dispose();
    });

    const accountB = {
      issuer: testAccount.issuer,
      subject: "acct_0192f4a1-2222-4000-8000-000000000002",
    };
    /** The person presses Sign in here, and the browser comes back signed in as `who`. */
    async function signInHere(
      fixture: ReturnType<typeof fakePorts>,
      service: DeploymentAccessService,
      who: { readonly issuer: string; readonly subject: string } = testAccount,
    ) {
      await service.signIn();
      fixture.emitAccount(signedInAccount(who));
      await settle();
    }

    it("opens the one Home an account has, after a sign-in the person started, never on a token refresh", async () => {
      const server = otherMac({ livenessExpiresAt: liveLease });
      const fixture = fakePorts({ deployments: [server] });
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();
      expect(fixture.select).not.toHaveBeenCalled();

      await signInHere(fixture, service);
      expect(fixture.select).toHaveBeenCalledExactlyOnceWith(server.id);
      fixture.emitAccount(signedInAccount(testAccount));
      await settle();
      expect(fixture.select).toHaveBeenCalledTimes(1);
      service.dispose();
    });

    it("opens nothing for a sign-in this Mac didn't start, or a re-authorisation", async () => {
      const server = otherMac({ livenessExpiresAt: liveLease });
      const restored = fakePorts({ deployments: [server] });
      const quiet = new DeploymentAccessService(restored.ports, restored.options);
      await quiet.initialize();
      restored.emitAccount(signedInAccount(testAccount));
      await settle();
      expect(restored.select).not.toHaveBeenCalled();
      // Confirming it's still them passes through authorizing and back: still not a sign-in.
      await quiet.reauthorize();
      restored.emitAccount({
        account: { available: true, detail: null, identity: null, status: "authorizing" },
        schemaVersion: 2,
      });
      restored.emitAccount(signedInAccount(testAccount));
      await settle();
      expect(restored.select).not.toHaveBeenCalled();
      quiet.dispose();
    });

    it("leaves several Homes, or one beside a place of this Mac's own, as a list to choose from", async () => {
      const studio = otherMac({ livenessExpiresAt: liveLease });
      const lab = otherMac({ livenessExpiresAt: liveLease });
      const two = fakePorts({ deployments: [studio, lab] });
      const listed = new DeploymentAccessService(two.ports, two.options);
      await listed.initialize();
      await signInHere(two, listed);
      expect(two.select).not.toHaveBeenCalled();
      listed.dispose();

      const added = deployment({ name: "Added by hand" });
      const beside = fakePorts({ deployments: [studio, added] });
      const mixed = new DeploymentAccessService(beside.ports, beside.options);
      await mixed.initialize();
      await signInHere(beside, mixed);
      expect(beside.select).not.toHaveBeenCalled();
      mixed.dispose();
    });

    it("never opens a Home this Mac remembers from another account, read or not", async () => {
      const ofA = { ...otherMac({ livenessExpiresAt: liveLease }), accountOwner: testAccount };
      // The read fails: the remembered Home of A is all there is to see.
      const failing = fakePorts({ deployments: [ofA], joined: [ofA.id] });
      vi.mocked(failing.ports.directory.syncAccountDeployments).mockRejectedValue(
        new Error("The Account did not answer."),
      );
      const failed = new DeploymentAccessService(failing.ports, failing.options);
      await failed.initialize();
      await signInHere(failing, failed, accountB);
      expect(failing.select).not.toHaveBeenCalled();
      failed.dispose();

      // The read succeeds and still lists only A's Home, which this Mac joined.
      const reading = fakePorts({ deployments: [ofA], joined: [ofA.id] });
      const read = new DeploymentAccessService(reading.ports, reading.options);
      await read.initialize();
      await signInHere(reading, read, accountB);
      expect(reading.select).not.toHaveBeenCalled();
      read.dispose();
    });

    it("opens nothing when the person signs out, or another account signs in, while the read is out", async () => {
      for (const next of ["signed-out", "account B"] as const) {
        const home = otherMac({ livenessExpiresAt: liveLease });
        const fixture = fakePorts({ deployments: [home] });
        const sync = deferred<{ changed: boolean; unavailable: [] }>();
        vi.mocked(fixture.ports.directory.syncAccountDeployments).mockReturnValueOnce(sync.promise);
        const service = new DeploymentAccessService(fixture.ports, fixture.options);
        await service.initialize();
        await signInHere(fixture, service);
        fixture.emitAccount(
          next === "signed-out"
            ? {
                account: { available: true, detail: null, identity: null, status: "signed-out" },
                schemaVersion: 2,
              }
            : signedInAccount(accountB),
        );
        await settle();
        sync.resolve({ changed: true, unavailable: [] });
        await settle();
        expect(fixture.select, next).not.toHaveBeenCalled();
        service.dispose();
      }
    });

    it("shows the list when a catalog reload is still on its way with a second Home", async () => {
      const first = otherMac({ livenessExpiresAt: liveLease });
      const second = otherMac({ livenessExpiresAt: liveLease });
      const fixture = fakePorts({ deployments: [first] });
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();
      const stale = deferred<CatalogProjection>();
      const fresh = deferred<CatalogProjection>();
      vi.mocked(fixture.ports.catalog.read)
        .mockReturnValueOnce(stale.promise)
        .mockReturnValueOnce(fresh.promise);
      await service.signIn();
      fixture.emitAccount(signedInAccount(testAccount));
      await settle();
      // While the read's own catalog read is out, a write with a second Home starts another.
      fixture.emitCatalog({ deployments: [first, second], selectedDeploymentId: null });
      await settle();
      // The older read answers first, with one Home, and is superseded; the newer is still out.
      stale.resolve({ deployments: [first], revision: 2, selectedDeploymentId: null });
      await settle();
      expect(fixture.select).not.toHaveBeenCalled();
      fresh.resolve({ deployments: [first, second], revision: 3, selectedDeploymentId: null });
      await settle();
      expect(fixture.select).not.toHaveBeenCalled();
      expect(service.snapshot().deployments).toHaveLength(2);
      service.dispose();
    });

    it("keeps an Account place this Mac joined listed and openable after the sign-in ends, until the Mac leaves it", async () => {
      const mac = otherMac({ livenessExpiresAt: liveLease });
      const other = deployment({ name: "Studio server", source: "account" });
      const fixture = fakePorts({ deployments: [mac, other], joined: [mac.id] });
      fixture.currentState.mockResolvedValueOnce(expiredAccount());
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();

      expect(service.snapshot().deployments.map(({ name }) => name)).toEqual(["Studio Mac"]);
      expect(service.snapshot().deployments[0]?.statusInfo.label).toBe("Sign in again");
      await service.select(mac.id);
      expect(fixture.select).toHaveBeenCalledWith(mac.id);
      expect(fixture.establish).not.toHaveBeenCalled();

      fixture.emitCatalog({ deployments: [mac, other], selectedDeploymentId: null });
      fixture.emitJoined([]);
      await settle();
      expect(service.snapshot().deployments).toEqual([]);
      service.dispose();
    });

    it("never lets startup's read of what this Mac joined undo a newer one", async () => {
      const mac = otherMac({ livenessExpiresAt: liveLease });
      const fixture = fakePorts({ deployments: [mac] });
      const catalog = deferred<CatalogProjection>();
      vi.mocked(fixture.ports.catalog.read).mockReturnValueOnce(catalog.promise);
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      const initialized = service.initialize();
      await settle();
      fixture.emitJoined([mac.id]);
      await settle();
      catalog.resolve({ deployments: [mac], revision: 1, selectedDeploymentId: null });
      await initialized;

      expect(service.snapshot().deployments.map(({ name }) => name)).toEqual(["Studio Mac"]);
      service.dispose();
    });

    it("won't offer to start an Opensteer until it can read what this Mac joined", async () => {
      const fixture = fakePorts();
      vi.spyOn(fixture.ports.devices, "joinedDeploymentIds").mockRejectedValueOnce(
        new Error("This Mac's device membership file is incompatible or corrupt."),
      );
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();
      expect(service.snapshot().personalSetup).toMatchObject({
        canStart: false,
        state: "repair-required",
      });

      fixture.emitJoined([]);
      await settle();
      expect(service.snapshot().personalSetup).toMatchObject({ canStart: true, state: "stopped" });
      service.dispose();
    });

    it("refuses to open an Account place it is not showing", async () => {
      const server = deployment({ name: "Studio server", source: "account" });
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
        new HostTransportError("unreachable"),
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
        Object.assign(new HostTransportError("unreachable")),
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
      const server = deployment({ name: "Studio server", source: "account" });
      const unreachable = [
        {
          accountAccess: "member" as const,
          deploymentId: server.id,
          name: "Studio server",
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
        new HostTransportError("unreachable"),
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
        label: "Can’t be opened from here",
        reason:
          "Office Mac can only be used on that computer. Turn on Remote access there, in Settings › Account.",
        status: "offline",
      });
      expect(sleeping?.availableActions).toEqual([]);
      expect(off?.availableActions).toEqual([]);
      service.dispose();
    });

    it("reads a place the Account listed but could not reach as unreachable, not ready", async () => {
      const server = deployment({ name: "Studio server", source: "account" });
      const unreachable = [
        {
          accountAccess: "member" as const,
          deploymentId: server.id,
          name: "Studio server",
          reason: "host-unavailable" as const,
        },
      ];
      const fixture = fakePorts({ deployments: [server], directoryUnavailable: unreachable });
      fixture.currentState.mockResolvedValueOnce(signedInAccount());
      const service = new DeploymentAccessService(fixture.ports, fixture.options);
      await service.initialize();

      expect(service.snapshot().deployments[0]?.statusInfo).toEqual({
        reason: "Studio server can’t be reached right now.",
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
        else fixture.probe.mockRejectedValueOnce(new HostTransportError("unreachable"));
        const service = new DeploymentAccessService(fixture.ports, fixture.options);
        await service.initialize();

        await service.checkDeployments();
        expect(service.snapshot().deployments[0]?.availableActions).toEqual(["select"]);
        await service.select(lab.id);
        expect(fixture.select).toHaveBeenCalledWith(lab.id);
        expect(fixture.establish).toHaveBeenCalledWith(lab.id, true);
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
      detail: "Your Opensteer account authorization expired. Sign in again.",
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

/** The account `signedInAccount()` signs in by default, and the one Account rows belong to. */
const testAccount = {
  issuer: "https://accounts.opensteer.test",
  subject: "acct_0192f4a1-1111-4000-8000-000000000001",
};

function signedInAccount(
  identity: { readonly issuer: string; readonly subject: string } = {
    issuer: testAccount.issuer,
    subject: `acct_${crypto.randomUUID()}`,
  },
): DesktopAccountAuthState {
  return {
    account: {
      available: true,
      detail: null,
      identity,
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
    readonly joined?: readonly string[];
    readonly selectedDeploymentId?: string;
  } = {},
) {
  let joined: ReadonlySet<string> = new Set(options.joined ?? []);
  const devicesListeners = new Set<() => void>();
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
    devices: {
      joinedDeploymentIds: async () => joined,
      subscribe: (listener) => {
        devicesListeners.add(listener);
        return () => devicesListeners.delete(listener);
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
    /** What the next projection read returns, as a supervisor status change re-reads it. */
    replaceCatalog(next: Omit<CatalogProjection, "revision">) {
      projection = { ...next, revision: projection.revision + 1 };
    },
    emitJoined(ids: readonly string[]) {
      joined = new Set(ids);
      for (const listener of devicesListeners) listener();
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
    readonly kind?: "personal";
    readonly lastUsedAt?: string | null;
    readonly name?: string;
    readonly onThisComputer?: boolean;
    readonly routes?: readonly { readonly kind: "canonical" | "direct"; readonly origin: string }[];
    readonly source?: "account" | "manual" | "this-device";
    /** Which account listed an Account row; by default the one `signedInAccount()` signs in. */
    readonly accountOwner?: { readonly issuer: string; readonly subject: string } | null;
    /** An Account Personal row's signed Connect route and its liveness lease. */
    readonly connect?: { readonly livenessExpiresAt: string | null } | null;
  } = {},
): CatalogProjection["deployments"][number] {
  const origin = "https://host.example.test";
  const summary = DesktopDeploymentSummarySchema.parse({
    // This computer's own Host is reached as its owner while it is serving.
    access: overrides.attachmentKey === null ? null : overrides.onThisComputer ? "owner" : "native",
    activeOrigin: origin,
    canonicalOrigin: origin,
    id: overrides.id ?? createId("deployment"),
    kind: overrides.kind ?? "personal",
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
    accountOwner:
      overrides.accountOwner !== undefined
        ? overrides.accountOwner
        : overrides.source === "account"
          ? testAccount
          : null,
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
