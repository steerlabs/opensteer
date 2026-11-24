import { dirname } from "node:path";
import { createId } from "@opensteer/core";
import type { RunnerCommand } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { RunnerRuntime, type RunnerMessageSink } from "./runtime.js";

describe("Runner Trigger program concurrency", () => {
  it("admits two concurrent Runs in the same folder", async () => {
    const fixture = runtimeFixture({ maxConcurrentRuns: 2, maxConcurrentTriggerPrograms: 1 });
    const computerId = createId("runner");
    const first = runCommand(fixture.environmentId, computerId);
    const second = runCommand(fixture.environmentId, computerId);
    try {
      await expect(fixture.runtime.handleCommand(first, fixture.sink)).resolves.toEqual({
        status: "accepted",
      });
      await expect(fixture.runtime.handleCommand(second, fixture.sink)).resolves.toEqual({
        status: "accepted",
      });
      expect(fixture.runtime.activeRunIds()).toEqual([first.context.runId, second.context.runId]);
    } finally {
      await fixture.runtime.close();
    }
  });

  it("admits a Trigger program while the Run pool is saturated", async () => {
    const fixture = runtimeFixture({ maxConcurrentRuns: 1, maxConcurrentTriggerPrograms: 1 });
    const computerId = createId("runner");
    const run = runCommand(fixture.environmentId, computerId);
    const trigger = triggerCommand(fixture.environmentId, computerId);
    try {
      await expect(fixture.runtime.handleCommand(run, fixture.sink)).resolves.toEqual({
        status: "accepted",
      });
      await expect(fixture.runtime.handleCommand(trigger, fixture.sink)).resolves.toEqual({
        status: "accepted",
      });
      expect(fixture.runtime.activeRunIds()).toEqual([run.context.runId]);
      expect(fixture.runtime.activeTriggerOccurrenceIds()).toEqual([trigger.context.occurrenceId]);
    } finally {
      await fixture.runtime.close();
    }
  });

  it("admits two concurrent Trigger programs in the same folder", async () => {
    const fixture = runtimeFixture({ maxConcurrentRuns: 1, maxConcurrentTriggerPrograms: 2 });
    const computerId = createId("runner");
    const first = triggerCommand(fixture.environmentId, computerId);
    const second = triggerCommand(fixture.environmentId, computerId);
    try {
      await expect(fixture.runtime.handleCommand(first, fixture.sink)).resolves.toEqual({
        status: "accepted",
      });
      await expect(fixture.runtime.handleCommand(second, fixture.sink)).resolves.toEqual({
        status: "accepted",
      });
      expect(fixture.runtime.activeTriggerOccurrenceIds()).toEqual([
        first.context.occurrenceId,
        second.context.occurrenceId,
      ]);
    } finally {
      await fixture.runtime.close();
    }
  });

  it("admits a Run while the Trigger program pool is saturated", async () => {
    const fixture = runtimeFixture({ maxConcurrentRuns: 1, maxConcurrentTriggerPrograms: 1 });
    const run = runCommand(fixture.environmentId);
    const trigger = triggerCommand(fixture.environmentId);
    try {
      await expect(fixture.runtime.handleCommand(trigger, fixture.sink)).resolves.toEqual({
        status: "accepted",
      });
      await expect(fixture.runtime.handleCommand(run, fixture.sink)).resolves.toEqual({
        status: "accepted",
      });
      expect(fixture.runtime.activeRunIds()).toEqual([run.context.runId]);
      expect(fixture.runtime.activeTriggerOccurrenceIds()).toEqual([trigger.context.occurrenceId]);
    } finally {
      await fixture.runtime.close();
    }
  });

  it("returns a retryable conflict when only the Trigger program pool is saturated", async () => {
    const fixture = runtimeFixture({ maxConcurrentRuns: 1, maxConcurrentTriggerPrograms: 1 });
    const first = triggerCommand(fixture.environmentId);
    const second = triggerCommand(fixture.environmentId);
    try {
      await expect(fixture.runtime.handleCommand(first, fixture.sink)).resolves.toEqual({
        status: "accepted",
      });
      await expect(fixture.runtime.handleCommand(second, fixture.sink)).resolves.toEqual({
        error: {
          code: "conflict",
          message: "Runner Trigger program concurrency limit is saturated",
          retryable: true,
        },
        status: "rejected",
      });
    } finally {
      await fixture.runtime.close();
    }
  });

  it("keeps active firings running across connectionLost and reports them in attachFiringInventory", async () => {
    const fixture = runtimeFixture({ maxConcurrentRuns: 1, maxConcurrentTriggerPrograms: 2 });
    const trigger = triggerCommand(fixture.environmentId);
    try {
      await expect(fixture.runtime.handleCommand(trigger, fixture.sink)).resolves.toEqual({
        status: "accepted",
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await fixture.runtime.connectionLost(fixture.sink);
      // Firing must NOT be aborted by a transient disconnect (T12).
      expect(fixture.abortedPreparations()).toBe(0);
      expect(fixture.runtime.activeTriggerOccurrenceIds()).toEqual([trigger.context.occurrenceId]);
      expect(fixture.runtime.attachFiringInventory()).toEqual([
        {
          environmentId: fixture.environmentId,
          executionGeneration: trigger.context.executionGeneration,
          occurrenceId: trigger.context.occurrenceId,
          terminal: false,
        },
      ]);
      // When the Host revokes it on attach, the Runner aborts it.
      await fixture.runtime.attach(
        {
          bootId: "rbt_00000000-0000-4000-8000-000000000001" as never,
          connectionGeneration: 2,
          connectionId: "rcn_00000000-0000-4000-8000-000000000001" as never,
          connectionLeaseId: "rcl_00000000-0000-4000-8000-000000000001" as never,
          firingResults: [
            {
              occurrenceId: trigger.context.occurrenceId,
              reason: "Paused while offline",
              status: "revoked",
            },
          ],
          leaseMs: 60_000,
          results: [],
          runnerId: "runr_00000000-0000-4000-8000-000000000001" as never,
          type: "host.executions.attached",
        },
        fixture.sink,
      );
      expect(fixture.abortedPreparations()).toBe(1);
    } finally {
      await fixture.runtime.close();
    }
  });
});

function runtimeFixture(input: {
  readonly maxConcurrentRuns: number;
  readonly maxConcurrentTriggerPrograms: number;
}) {
  const environmentId = createId("environment");
  let abortedPreparations = 0;
  const runtime = new RunnerRuntime({
    agentSkills: { plugin: {}, skills: new Map() } as never,
    bootId: "boot-trigger-concurrency-test",
    browserHarnessExecutable: "/opt/opensteer/browser-harness",
    deploymentShape: {
      kind: "personal" as const,
    },
    environmentId,
    harnesses: {
      canRunDriver: () => true,
      close: async () => undefined,
      listDrivers: () => [],
      state: () => ({ definition: { runtimeRevision: 1 }, status: "available" }),
    } as never,
    plugins: async () => {
      throw new Error("A blocked Workspace preparation must not materialize plugin skills");
    },
    maxConcurrentRuns: input.maxConcurrentRuns,
    maxConcurrentTriggerPrograms: input.maxConcurrentTriggerPrograms,
    dataDirectory: dirname("/runner/private/harness-state"),
    privateStateDirectory: "/runner/private/harness-state",
    scriptExecutor: {
      execute: async () => {
        throw new Error("A blocked Workspace preparation must not execute an automation script");
      },
    },
    projectContinuationIdentity: (identity) => identity as never,
    agentHome: {
      folder: async ({ path }) => path,
      prepare: async ({ signal }) =>
        new Promise((_, rejectPromise) => {
          const abort = (): void => {
            abortedPreparations += 1;
            rejectPromise(signal.reason);
          };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }),
    },
  });
  const sink: RunnerMessageSink = { send: async () => undefined };
  return { abortedPreparations: () => abortedPreparations, environmentId, runtime, sink };
}

function runCommand(
  environmentId: ReturnType<typeof createId<"environment">>,
  computerId = createId("runner"),
): Extract<RunnerCommand, { readonly type: "run.execute" }> {
  const runId = createId("run");
  const threadId = createId("thread");
  return {
    agentHome: { computerId, path: "/runner/runs/control/workspace" },
    commandId: createId("command"),
    context: {
      environmentId,
      harness: { driverKind: "codex", runtimeRevision: 1 },
      runId,
      threadId,
    },
    environmentId,
    type: "run.execute",
  } as Extract<RunnerCommand, { readonly type: "run.execute" }>;
}

function triggerCommand(
  environmentId: ReturnType<typeof createId<"environment">>,
  computerId = createId("runner"),
): Extract<RunnerCommand, { readonly type: "trigger.execute" }> {
  const occurrenceId = createId("triggerOccurrence");
  return {
    agentHome: { computerId, path: "/runner/runs/control/workspace" },
    commandId: createId("command"),
    context: {
      executionGeneration: 1,
      occurrenceId,
    },
    environmentId,
    type: "trigger.execute",
  } as Extract<RunnerCommand, { readonly type: "trigger.execute" }>;
}
