import { dirname } from "node:path";
import { createId } from "@opensteer/core";
import { nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import type { RunnerCommand } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { RunnerRuntime, type RunnerMessageSink } from "./runtime.js";

describe("Runner Trigger program concurrency", () => {
  it("admits two concurrent Runs in the same Workspace", async () => {
    const fixture = runtimeFixture({ maxConcurrentRuns: 2, maxConcurrentTriggerPrograms: 1 });
    const workspaceId = createId("workspace");
    const first = runCommand(fixture.environmentId, workspaceId);
    const second = runCommand(fixture.environmentId, workspaceId);
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
    const workspaceId = createId("workspace");
    const run = runCommand(fixture.environmentId, workspaceId);
    const trigger = triggerCommand(fixture.environmentId, workspaceId);
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

  it("admits two concurrent Trigger programs in the same Workspace", async () => {
    const fixture = runtimeFixture({ maxConcurrentRuns: 1, maxConcurrentTriggerPrograms: 2 });
    const workspaceId = createId("workspace");
    const first = triggerCommand(fixture.environmentId, workspaceId);
    const second = triggerCommand(fixture.environmentId, workspaceId);
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
      defaultWorkspaceBacking: "local-directory",
      kind: "server" as const,
    },
    environmentId,
    harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
    harnesses: {
      canRunDriver: () => true,
      close: async () => undefined,
      listDrivers: () => [],
      state: () => ({ definition: { runtimeRevision: 1 }, status: "available" }),
    } as never,
    integrationSkills: async () => {
      throw new Error("A blocked Workspace preparation must not materialize integration skills");
    },
    maxConcurrentRuns: input.maxConcurrentRuns,
    maxConcurrentTriggerPrograms: input.maxConcurrentTriggerPrograms,
    dataDirectory: dirname("/runner/private/harness-state"),
    privateStateDirectory: "/runner/private/harness-state",
    programExecutor: {
      execute: async () => {
        throw new Error("A blocked Workspace preparation must not execute a Trigger program");
      },
    },
    projectContinuationIdentity: (identity) => identity as never,
    workspaceManager: {
      writableRoots: () => ["/runner/workspaces"],
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
  workspaceId = createId("workspace"),
): Extract<RunnerCommand, { readonly type: "run.execute" }> {
  const runId = createId("run");
  const threadId = createId("thread");
  return {
    commandId: createId("command"),
    context: {
      environmentId,
      harness: { driverKind: "codex", runtimeRevision: 1 },
      runId,
      threadId,
      workspaceAccess: {
        kind: "local-directory",
        ownerEnvironmentId: environmentId,
        storageAuthorityId: createId("storageAuthority"),
        workspaceId,
      },
      workspaceId,
    },
    environmentId,
    type: "run.execute",
  } as Extract<RunnerCommand, { readonly type: "run.execute" }>;
}

function triggerCommand(
  environmentId: ReturnType<typeof createId<"environment">>,
  workspaceId = createId("workspace"),
): Extract<RunnerCommand, { readonly type: "trigger.execute" }> {
  const occurrenceId = createId("triggerOccurrence");
  return {
    commandId: createId("command"),
    context: {
      executionGeneration: 1,
      occurrenceId,
      workspaceAccess: {
        kind: "local-directory",
        ownerEnvironmentId: environmentId,
        storageAuthorityId: createId("storageAuthority"),
        workspaceId,
      },
      workspaceId,
    },
    environmentId,
    type: "trigger.execute",
  } as Extract<RunnerCommand, { readonly type: "trigger.execute" }>;
}
