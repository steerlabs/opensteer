import { createId } from "@opensteer/core";
import type { RunnerIdentity } from "@opensteer/orchestration";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginServiceState } from "./plugin-service.js";
import { PluginStopCoordinator } from "./plugin-stop-coordinator.js";

const stoppedAt = "2026-11-22T09:00:00.000Z";
const laterStoppedAt = "2026-11-22T09:05:00.000Z";

function runnerIdentity(
  runnerId: RunnerIdentity["runnerId"],
  agentsStoppedSince: string | null | undefined,
  generation = 1,
): RunnerIdentity {
  return {
    runnerId,
    runnerKind: "main",
    connectionGeneration: generation,
    agentsStoppedSince,
  } as unknown as RunnerIdentity;
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it("does zero work on non-stopped Runner registration", async () => {
  const runnerId = createId("runner");
  const agentWork = vi.fn(async () => true);
  const stopAgentWork = vi.fn(async () => true);
  const hasUnfinishedWorkflows = vi.fn(async () => false);
  const coordinator = new PluginStopCoordinator({
    pluginService: () => ({ state: () => ({ status: "idle", generation: 0 }), agentWork }),
    pluginExecutions: () => ({ stopAgentWork }),
    hasUnfinishedWorkflows,
    isCurrent: () => true,
    log: { warn: vi.fn() },
  });

  coordinator.onHostingRunnerRegistered(runnerIdentity(runnerId, null));
  coordinator.onHostingRunnerRegistered(runnerIdentity(runnerId, undefined));
  await vi.runAllTimersAsync();

  expect(agentWork).not.toHaveBeenCalled();
  expect(stopAgentWork).not.toHaveBeenCalled();
  expect(hasUnfinishedWorkflows).not.toHaveBeenCalled();
  expect(coordinator.proofFor(runnerId, false)).toBeUndefined();
});

it("proves stopped without cold-starting an idle plugin engine when no workflows are unfinished", async () => {
  const runnerId = createId("runner");
  const agentWork = vi.fn(async () => true);
  const stopAgentWork = vi.fn(async () => true);
  const hasUnfinishedWorkflows = vi.fn(async () => false);
  const log = { warn: vi.fn() };
  const coordinator = new PluginStopCoordinator({
    pluginService: () => ({ state: () => ({ status: "idle", generation: 0 }), agentWork }),
    pluginExecutions: () => ({ stopAgentWork }),
    hasUnfinishedWorkflows,
    isCurrent: () => true,
    log,
  });

  coordinator.onHostingRunnerRegistered(runnerIdentity(runnerId, stoppedAt));
  await vi.advanceTimersByTimeAsync(0);

  expect(agentWork).not.toHaveBeenCalled();
  expect(stopAgentWork).toHaveBeenCalledOnce();
  expect(hasUnfinishedWorkflows).toHaveBeenCalledOnce();
  expect(coordinator.proofFor(runnerId, true)).toBe(stoppedAt);
  expect(coordinator.proofFor(runnerId, false)).toBeUndefined();
  expect(log.warn).not.toHaveBeenCalled();
});

it("does not prove via idle fast path if the plugin engine starts mid-check", async () => {
  const runnerId = createId("runner");
  let status: PluginServiceState["status"] = "idle";
  const agentWork = vi.fn(async () => true);
  const stopAgentWork = vi.fn(async () => {
    status = "starting";
    return true;
  });
  const coordinator = new PluginStopCoordinator({
    pluginService: () => ({ state: () => ({ status, generation: 1 }), agentWork }),
    pluginExecutions: () => ({ stopAgentWork }),
    hasUnfinishedWorkflows: async () => false,
    isCurrent: () => true,
    log: { warn: vi.fn() },
  });

  coordinator.onHostingRunnerRegistered(runnerIdentity(runnerId, stoppedAt));
  await vi.advanceTimersByTimeAsync(0);

  expect(agentWork).toHaveBeenCalledOnce();
  expect(agentWork).toHaveBeenCalledWith(
    { stopped: true },
    { caller: "personal", mode: "automatic" },
    expect.any(AbortSignal),
  );
  expect(coordinator.proofFor(runnerId, true)).toBe(stoppedAt);
});

it("retries with backoff and logs what was missing when agentWork fails or workflows are unfinished", async () => {
  const runnerId = createId("runner");
  let attempt = 0;
  const agentWork = vi.fn(async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("engine still starting");
    return true;
  });
  let workflowChecks = 0;
  const hasUnfinishedWorkflows = vi.fn(async () => {
    workflowChecks += 1;
    return workflowChecks < 3;
  });
  const stopAgentWork = vi.fn(async () => true);
  const log = { warn: vi.fn() };
  const coordinator = new PluginStopCoordinator({
    pluginService: () => ({ state: () => ({ status: "starting", generation: 1 }), agentWork }),
    pluginExecutions: () => ({ stopAgentWork }),
    hasUnfinishedWorkflows,
    isCurrent: () => true,
    log,
    initialRetryMs: 500,
    maxRetryMs: 2_000,
  });

  coordinator.onHostingRunnerRegistered(runnerIdentity(runnerId, stoppedAt));
  // Attempt 1: agentWork rejects and workflow is unfinished -> logged, no proof.
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.proofFor(runnerId, true)).toBeUndefined();
  expect(log.warn).toHaveBeenCalledWith(
    expect.objectContaining({
      attempt: 1,
      backgroundError: "engine still starting",
      backgroundOk: false,
      unfinishedWorkflows: true,
      retryInMs: 500,
    }),
    "Plugin Stop proof incomplete; retrying",
  );

  // Attempt 2 after 500ms: agentWork succeeds, workflow still unfinished -> logged, still no proof.
  await vi.advanceTimersByTimeAsync(500);
  expect(coordinator.proofFor(runnerId, true)).toBeUndefined();
  expect(log.warn).toHaveBeenCalledWith(
    expect.objectContaining({
      attempt: 2,
      backgroundOk: true,
      unfinishedWorkflows: true,
      retryInMs: 1_000,
    }),
    "Plugin Stop proof incomplete; retrying",
  );

  // Attempt 3 after 1000ms: all conditions hold in one attempt -> proven.
  await vi.advanceTimersByTimeAsync(1_000);
  expect(coordinator.proofFor(runnerId, true)).toBe(stoppedAt);
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels pending retries and ignores late results on Resume, a newer Stop, or close", async () => {
  const runnerId = createId("runner");
  let current = runnerIdentity(runnerId, stoppedAt, 1);
  const firstCall = Promise.withResolvers<boolean>();
  const agentWork = vi.fn(async (input: { stopped: boolean }) =>
    input.stopped ? firstCall.promise : true,
  );
  const coordinator = new PluginStopCoordinator({
    pluginService: () => ({ state: () => ({ status: "ready", generation: 1 }), agentWork }),
    pluginExecutions: () => ({ stopAgentWork: async () => true }),
    hasUnfinishedWorkflows: async () => false,
    isCurrent: (identity) => identity.connectionGeneration === current.connectionGeneration,
    log: { warn: vi.fn() },
  });

  coordinator.onHostingRunnerRegistered(current);
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.proofFor(runnerId, true)).toBeUndefined();

  // Resume supersedes the first Stop; a late resolution from the first Stop never sets proof.
  current = runnerIdentity(runnerId, null, 2);
  coordinator.onHostingRunnerRegistered(current);
  firstCall.resolve(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.proofFor(runnerId, true)).toBeUndefined();

  // A new Stop whose attempt fails stops retrying immediately when closed.
  agentWork.mockRejectedValueOnce(new Error("temporary"));
  current = runnerIdentity(runnerId, laterStoppedAt, 3);
  coordinator.onHostingRunnerRegistered(current);
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1);
  coordinator.close();
  expect(vi.getTimerCount()).toBe(0);
});
