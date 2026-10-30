import { createId, type AgentEvent } from "@opensteer/core";
import type { SecurityEffectRecord } from "@opensteer/database";
import type { RunnerIdentity } from "@opensteer/orchestration";
import { describe, expect, it, vi } from "vitest";
import { SecurityEffectService } from "./security-effect-service.js";

describe("SecurityEffectService", () => {
  const runner = { runnerId: createId("runner") } as RunnerIdentity;
  const revokeRuns = vi.fn().mockResolvedValue(undefined);

  it("terminalizes every active Run for Workspace deletion and revokes it on its Runner", async () => {
    const workspaceId = createId("workspace");
    const terminal = {
      environmentId: createId("environment"),
      runId: createId("run"),
      threadId: createId("thread"),
      data: {
        code: "forbidden",
        message: "Access revoked",
        retryable: false,
        status: "failed",
        startedBy: {
          displayName: "Alex",
          kind: "human",
          userId: createId("user"),
          principalId: "test-principal",
        },
      },
      type: "run.failed",
    } as AgentEvent;
    const failActiveRunsForWorkspaceDeletion = vi.fn(async () => recovery([terminal]));
    const publish = vi.fn();
    const dispatch = vi.fn();
    const service = new SecurityEffectService({
      browser: { revokeWorkspaceUser: vi.fn() },
      onWatchDesiredChanged: vi.fn(),
      publish,
      realtime: { closeUserWorkspace: vi.fn(), publishViewerTasksChanged: vi.fn() },
      runners: { dispatch, identityForEnvironment: () => runner, revokeRuns },
      store: {
        claimSecurityEffects: vi.fn(),
        completeSecurityEffect: vi.fn(),
        failActiveRunsForMembershipRevocation: vi.fn(),
        failActiveRunsForWorkspaceDeletion,
        failSecurityEffect: vi.fn(),
      },
      triggers: {
        activeExecutionsForMembershipRevocation: vi.fn(),
        revokeForMembershipRevocation: vi.fn(),
      },
    });

    await service.terminateWorkspace(workspaceId);

    expect(failActiveRunsForWorkspaceDeletion).toHaveBeenCalledWith(workspaceId);
    expect(publish).toHaveBeenCalledWith(terminal);
    expect(revokeRuns).toHaveBeenCalledWith(runner.runnerId, [
      expect.objectContaining({ runId: terminal.runId }),
    ]);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("makes every revocation effect independently safe and completes the full set", async () => {
    const userId = createId("user");
    const workspaceId = createId("workspace");
    const runId = createId("run");
    const threadId = createId("thread");
    const environmentId = createId("environment");
    const effects = [
      "close-realtime",
      "stop-runs",
      "revoke-mounts",
      "revoke-browser",
      "revoke-credentials",
      "revoke-triggers",
    ].map((kind) => ({
      attempts: 1,
      id: createId("securityEffect"),
      kind,
      membershipGeneration: 2,
      userId,
      workspaceId,
    })) as readonly SecurityEffectRecord[];
    const terminal = {
      environmentId,
      runId,
      threadId,
      data: {
        code: "forbidden",
        message: "Access revoked",
        retryable: false,
        status: "failed",
        startedBy: {
          displayName: "Alex",
          kind: "human",
          userId: createId("user"),
          principalId: "test-principal",
        },
      },
      type: "run.failed",
    } as AgentEvent;
    const failActiveRunsForMembershipRevocation = vi
      .fn()
      .mockResolvedValueOnce(recovery([terminal]))
      .mockResolvedValue(recovery([]));
    const completeSecurityEffect = vi.fn().mockResolvedValue(undefined);
    const publish = vi.fn();
    const reconcileMounts = vi.fn().mockResolvedValue(undefined);
    const revokeBrowser = vi.fn().mockResolvedValue(undefined);
    const closeRealtime = vi.fn();
    const publishViewerTasksChanged = vi.fn();
    const dispatch = vi.fn().mockResolvedValue({ status: "accepted" });
    const revokeTriggers = vi.fn().mockResolvedValue(1);
    const onWatchDesiredChanged = vi.fn().mockResolvedValue(undefined);
    const service = new SecurityEffectService({
      browser: { revokeWorkspaceUser: revokeBrowser },
      onWatchDesiredChanged,
      publish,
      realtime: { closeUserWorkspace: closeRealtime, publishViewerTasksChanged },
      runners: { dispatch, identityForEnvironment: () => runner, revokeRuns },
      mounts: { revokeForMembership: reconcileMounts },
      store: {
        claimSecurityEffects: vi.fn().mockResolvedValueOnce(effects).mockResolvedValueOnce([]),
        completeSecurityEffect,
        failActiveRunsForMembershipRevocation,
        failActiveRunsForWorkspaceDeletion: vi.fn(),
        failSecurityEffect: vi.fn(),
      },
      triggers: {
        activeExecutionsForMembershipRevocation: vi
          .fn()
          .mockResolvedValue([
            { environmentId: createId("environment"), occurrenceId: createId("triggerOccurrence") },
          ]),
        revokeForMembershipRevocation: revokeTriggers,
      },
    });

    await service.reconcile();

    expect(closeRealtime).toHaveBeenCalledWith(userId, workspaceId);
    expect(publishViewerTasksChanged).toHaveBeenCalledWith(userId);
    expect(failActiveRunsForMembershipRevocation).toHaveBeenCalledTimes(3);
    expect(publish).toHaveBeenCalledWith(terminal);
    expect(reconcileMounts).toHaveBeenCalledOnce();
    expect(reconcileMounts).toHaveBeenCalledWith(workspaceId, userId);
    expect(revokeBrowser).toHaveBeenCalledWith(userId, workspaceId);
    expect(revokeTriggers).toHaveBeenCalledWith({
      membershipGeneration: 2,
      userId,
      workspaceId,
    });
    expect(onWatchDesiredChanged).toHaveBeenCalledWith(workspaceId);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "trigger.interrupt" }),
      expect.any(AbortSignal),
    );
    expect(revokeRuns).toHaveBeenCalledWith(runner.runnerId, [expect.objectContaining({ runId })]);
    expect(completeSecurityEffect).toHaveBeenCalledTimes(effects.length);
  });

  it("persists a bounded retry when one cleanup action fails", async () => {
    const effect: SecurityEffectRecord = {
      attempts: 4,
      id: createId("securityEffect"),
      kind: "revoke-browser",
      membershipGeneration: 3,
      userId: createId("user"),
      workspaceId: createId("workspace"),
    };
    const failSecurityEffect = vi.fn().mockResolvedValue(undefined);
    const service = new SecurityEffectService({
      browser: { revokeWorkspaceUser: vi.fn().mockRejectedValue(new Error("runtime offline")) },
      onWatchDesiredChanged: vi.fn(),
      publish: vi.fn(),
      realtime: { closeUserWorkspace: vi.fn(), publishViewerTasksChanged: vi.fn() },
      runners: { dispatch: vi.fn(), identityForEnvironment: () => runner, revokeRuns },
      store: {
        claimSecurityEffects: vi.fn().mockResolvedValue([effect]),
        completeSecurityEffect: vi.fn(),
        failActiveRunsForMembershipRevocation: vi.fn(),
        failActiveRunsForWorkspaceDeletion: vi.fn(),
        failSecurityEffect,
      },
      triggers: {
        activeExecutionsForMembershipRevocation: vi.fn().mockResolvedValue([]),
        revokeForMembershipRevocation: vi.fn(),
      },
    });

    await expect(service.reconcile()).rejects.toThrow("runtime offline");
    expect(failSecurityEffect).toHaveBeenCalledWith(
      expect.objectContaining({
        effectId: effect.id,
        error: "security-effect-failed",
        nextAttemptAt: expect.any(Date),
      }),
    );
  });

  it("records a Trigger cancellation even when its Runner is already offline", async () => {
    const effect: SecurityEffectRecord = {
      attempts: 1,
      id: createId("securityEffect"),
      kind: "revoke-triggers",
      membershipGeneration: 4,
      userId: createId("user"),
      workspaceId: createId("workspace"),
    };
    const dispatch = vi.fn();
    const revoke = vi.fn().mockResolvedValue(1);
    const complete = vi.fn().mockResolvedValue(undefined);
    const service = new SecurityEffectService({
      browser: { revokeWorkspaceUser: vi.fn() },
      onWatchDesiredChanged: vi.fn(),
      publish: vi.fn(),
      realtime: { closeUserWorkspace: vi.fn(), publishViewerTasksChanged: vi.fn() },
      runners: { dispatch, identityForEnvironment: () => runner, revokeRuns },
      store: {
        claimSecurityEffects: vi.fn().mockResolvedValueOnce([effect]).mockResolvedValueOnce([]),
        completeSecurityEffect: complete,
        failActiveRunsForMembershipRevocation: vi.fn(),
        failActiveRunsForWorkspaceDeletion: vi.fn(),
        failSecurityEffect: vi.fn(),
      },
      triggers: {
        activeExecutionsForMembershipRevocation: vi
          .fn()
          .mockResolvedValue([
            { environmentId: createId("environment"), occurrenceId: createId("triggerOccurrence") },
          ]),
        revokeForMembershipRevocation: revoke,
      },
    });

    await service.reconcile();

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "trigger.interrupt" }),
      expect.any(AbortSignal),
    );
    expect(revoke).toHaveBeenCalledWith({
      membershipGeneration: effect.membershipGeneration,
      userId: effect.userId,
      workspaceId: effect.workspaceId,
    });
    expect(complete).toHaveBeenCalledWith(effect.id);
  });

  it("does not reconcile mounts for occurrence terminal state", async () => {
    const effect: SecurityEffectRecord = {
      attempts: 1,
      id: createId("securityEffect"),
      kind: "revoke-triggers",
      membershipGeneration: 5,
      userId: createId("user"),
      workspaceId: createId("workspace"),
    };
    const order: string[] = [];
    const service = new SecurityEffectService({
      browser: { revokeWorkspaceUser: vi.fn() },
      onWatchDesiredChanged: vi.fn(),
      publish: vi.fn(),
      realtime: { closeUserWorkspace: vi.fn(), publishViewerTasksChanged: vi.fn() },
      mounts: {
        revokeForMembership: vi.fn(async () => void order.push("mounts")),
      },
      runners: { dispatch: vi.fn(), identityForEnvironment: () => runner, revokeRuns },
      store: {
        claimSecurityEffects: vi.fn().mockResolvedValueOnce([effect]).mockResolvedValueOnce([]),
        completeSecurityEffect: vi.fn(),
        failActiveRunsForMembershipRevocation: vi.fn(),
        failActiveRunsForWorkspaceDeletion: vi.fn(),
        failSecurityEffect: vi.fn(),
      },
      triggers: {
        activeExecutionsForMembershipRevocation: vi.fn().mockResolvedValue([]),
        revokeForMembershipRevocation: vi.fn(async () => {
          order.push("terminal");
          return 1;
        }),
      },
    });

    await service.reconcile();

    expect(order).toEqual(["terminal"]);
  });
});

function recovery(events: readonly AgentEvent[]) {
  return {
    events,
    terminatedRuns: events.flatMap((event) =>
      event.runId
        ? [{ environmentId: event.environmentId, runId: event.runId, threadId: event.threadId }]
        : [],
    ),
  };
}
