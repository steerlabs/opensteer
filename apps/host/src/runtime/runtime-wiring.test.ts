import { describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import {
  authorizeRunnerRegistration,
  ensureDefaultHarnesses,
  integrationConnectionReaction,
  runnerRegistrationHook,
  terminalRunReaction,
} from "./runtime.js";
import type { HarnessInstanceRecord } from "@opensteer/database";

describe("Host runtime wiring", () => {
  it("reconciles a registering Runner before execution is woken", async () => {
    const wake = vi.fn();
    let finishCatalogCapture: (() => void) | undefined;
    const catalogCapture = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishCatalogCapture = resolve;
        }),
    );
    const onRegistered = runnerRegistrationHook(wake, catalogCapture);

    const registration = onRegistered({ runnerId: "runner-1" });
    expect(catalogCapture).toHaveBeenCalledWith({ runnerId: "runner-1" });
    // Dispatch inspects profiles live, so waking it before the authoritative
    // reconciliation lands would let a run race the reconciliation that is
    // about to replace the Runner's profile set.
    expect(wake).not.toHaveBeenCalled();

    finishCatalogCapture?.();
    await expect(registration).resolves.toBeUndefined();
    expect(wake).toHaveBeenCalledOnce();
  });

  it("wakes execution even when a registering Runner's reconciliation fails", async () => {
    const wake = vi.fn();
    const onRegistered = runnerRegistrationHook(wake, async () => {
      throw new Error("catalog capture failed");
    });

    await expect(onRegistered({ runnerId: "runner-1" })).rejects.toThrow(/catalog capture failed/u);
    expect(wake).toHaveBeenCalledOnce();
  });

  describe("terminal Run reaction", () => {
    const runEvent = (type: "run.completed" | "run.started", runId: string | null) =>
      ({
        createdAt: "2026-08-09T09:00:00.000Z",
        data: {
          status: type === "run.completed" ? "completed" : "running",
          startedAt: "2026-08-09T09:00:00.000Z",
          personWaiting: true,
          startedBy: {
            displayName: "Alex",
            kind: "human",
            userId: createId("user"),
            principalId: "test-principal",
          },
        },
        environmentId: createId("environment"),
        eventId: createId("event"),
        runId,
        sequence: 1,
        threadId: createId("thread"),
        type,
        workspaceId: createId("workspace"),
      }) as never;

    it("releases Run-owned sessions when a Run ends", async () => {
      const runId = createId("run");
      const detachBrowserSessions = vi.fn(async () => undefined);
      const endShellSessions = vi.fn(async () => undefined);
      const closeComputerUseSessions = vi.fn();

      terminalRunReaction({
        closeComputerUseSessions,
        detachBrowserSessions,
        endShellSessions,
      })(runEvent("run.completed", runId));

      expect(closeComputerUseSessions).toHaveBeenCalledWith(runId);
      expect(detachBrowserSessions).toHaveBeenCalledWith(`run:${runId}`);
      expect(endShellSessions).toHaveBeenCalledWith(runId);
    });

    it("leaves Run-owned sessions alone before the Run ends", () => {
      const runId = createId("run");
      const closeComputerUseSessions = vi.fn();
      const detachBrowserSessions = vi.fn(async () => undefined);
      const endShellSessions = vi.fn(async () => undefined);

      terminalRunReaction({
        closeComputerUseSessions,
        detachBrowserSessions,
        endShellSessions,
      })(runEvent("run.started", runId));

      expect(closeComputerUseSessions).not.toHaveBeenCalled();
      expect(detachBrowserSessions).not.toHaveBeenCalled();
      expect(endShellSessions).not.toHaveBeenCalled();
    });
  });

  describe("integration connection reaction", () => {
    const connected = {
      connectionId: createIntegrationId("connection"),
      ownerUserId: createId("user"),
    };

    it("wakes the continuation outbox only when a connection settled a Request", async () => {
      const notify = vi.fn();
      const report = vi.fn();
      const settle = vi.fn(async () => [createId("request")]);

      await integrationConnectionReaction({ notify, report, settle })(connected);

      expect(settle).toHaveBeenCalledWith(connected);
      expect(notify).toHaveBeenCalledOnce();
      expect(report).not.toHaveBeenCalled();
    });

    it("reports a failed settlement instead of failing the connection", async () => {
      const notify = vi.fn();
      const report = vi.fn();
      const failure = new Error("tool discovery failed");

      await expect(
        integrationConnectionReaction({
          notify,
          report,
          settle: async () => {
            throw failure;
          },
        })(connected),
      ).resolves.toBeUndefined();

      expect(report).toHaveBeenCalledWith(failure, connected.connectionId);
      expect(notify).not.toHaveBeenCalled();
    });
  });

  describe("default AI engine seeding", () => {
    const environmentId = createId("environment");

    /** A store holding exactly the rows a seeding pass is allowed to see. */
    function seedingStore(rows: readonly Partial<HarnessInstanceRecord>[]) {
      const listHarnessInstances = vi.fn(
        async (options: { readonly includeRemoved?: boolean } = {}) =>
          rows.filter((row) => options.includeRemoved === true || row.removedAt == null),
      );
      const createHarnessInstance = vi.fn(async (input: unknown) => input);
      return { createHarnessInstance, listHarnessInstances };
    }

    it("seeds one profile per usable driver the first time a Runner arrives", async () => {
      const store = seedingStore([]);
      await ensureDefaultHarnesses(store as never, environmentId, {
        harnessDrivers: [
          {
            driverKind: "codex",
            readiness: "configured",
            sources: [{ sourceId: "openai", stateKinds: ["ambient", "isolated"] }],
          },
          // A driver the Runner cannot run would only ever seed a row that
          // reports an error, so it is left alone until it becomes usable.
          { driverKind: "claude", readiness: "unavailable" },
          // An account has to name a source, and only the engine can say which
          // ones it drives. One that declares none has no account to seed.
          { driverKind: "opencode", readiness: "configured", sources: [] },
          // An engine that runs the person's own install offers their sign-in
          // only where it is installed; without it the account is Opensteer's.
          {
            driverKind: "pi",
            readiness: "configured",
            sources: [{ sourceId: "openai", stateKinds: ["isolated"] }],
          },
        ],
        providerStateModes: ["ambient", "isolated"],
      });
      // The seeded account talks to the first source its engine declares,
      // because that is the engine's own answer to "which one by default".
      expect(store.createHarnessInstance.mock.calls.map(([input]) => input)).toEqual([
        expect.objectContaining({
          driverKind: "codex",
          environmentId,
          sourceId: "openai",
          stateKind: "ambient",
        }),
        expect.objectContaining({
          driverKind: "pi",
          environmentId,
          sourceId: "openai",
          stateKind: "isolated",
        }),
      ]);
    });
  });
});

describe("admitting a connection as a registered computer", () => {
  const runnerId = createId("runner");
  const environmentId = createId("environment");

  function authorizingStore(input: {
    readonly currentGeneration?: number | null;
    readonly durable?: Record<string, unknown> | null;
  }) {
    return {
      personalRemoteAccessGeneration: vi.fn(async () => input.currentGeneration ?? null),
      runnerForAuthentication: vi.fn(async () =>
        input.durable === undefined
          ? {
              allowedModules: ["shell"],
              connectionGeneration: 4,
              environmentIds: [],
              publicKeyFingerprint: "sha256:key",
              publicKeyPem: "pem",
              revokedAt: null,
              runnerId,
              runnerKind: "local",
            }
          : input.durable,
      ),
    };
  }

  const admitted = (personalRemoteAccessGeneration: number | null) => ({
    allowedModules: ["shell"] as const,
    connectionGeneration: 4,
    environmentIds: [] as const,
    personalRemoteAccessGeneration,
    runnerId,
    runnerKind: "local" as const,
  });

  it("refuses an identity the durable record no longer agrees with, before any route check", async () => {
    const revoked = authorizingStore({
      currentGeneration: 7,
      durable: {
        allowedModules: ["shell"],
        connectionGeneration: 4,
        environmentIds: [],
        publicKeyFingerprint: "sha256:key",
        publicKeyPem: "pem",
        revokedAt: new Date(),
        runnerId,
        runnerKind: "local",
      },
    });
    const gone = authorizingStore({ currentGeneration: 7, durable: null });

    await expect(authorizeRunnerRegistration(revoked as never, admitted(7))).rejects.toThrow(
      "Runner connection is no longer authorized",
    );
    await expect(authorizeRunnerRegistration(gone as never, admitted(7))).rejects.toThrow(
      "Runner connection is no longer authorized",
    );
    expect(revoked.personalRemoteAccessGeneration).not.toHaveBeenCalled();
  });

  it("keeps admitting a computer that stopped advertising its environment", async () => {
    // Turning "Runs agents" off restarts the same identity naming no
    // environment; the binding it holds is not evidence against it.
    const store = {
      personalRemoteAccessGeneration: vi.fn(async () => null),
      runnerForAuthentication: vi.fn(async () => ({
        allowedModules: ["agents", "shell"],
        connectionGeneration: 4,
        environmentIds: [environmentId],
        publicKeyFingerprint: "sha256:key",
        publicKeyPem: "pem",
        revokedAt: null,
        runnerId,
        runnerKind: "local",
      })),
    };

    await expect(
      authorizeRunnerRegistration(store as never, {
        ...admitted(null),
        allowedModules: ["agents", "shell"],
      }),
    ).resolves.toBeUndefined();
  });
});
