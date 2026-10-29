import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  HarnessRegistry,
  isolatedServiceHarnessRuntimeBoundary,
  nativeUserHarnessRuntimeBoundary,
} from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import { ModelSelectionSchema, type RunId } from "@opensteer/core";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  codexThreadOf,
  codexUsageFrames,
  expectRecordedUsage,
  expectedUsage,
  recordedUsage,
  usageRecord,
  type UsageRecord,
} from "./codex-usage.test-support.js";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";

const configuredDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = configuredDatabaseUrl ? describe : describe.skip;
const fakeCodexAppServer = fileURLToPath(
  new URL(
    "../../../../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs",
    import.meta.url,
  ),
);

const codexSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});

/** The Runner's registry shape, launching the fake app-server as Codex. */
function fakeCodexRegistry(
  scenario = "vertical",
  engineArguments: readonly string[] = [],
): HarnessRegistry {
  const registry = new HarnessRegistry();
  registry.registerDriver(
    new CodexHarnessDriver({
      launch: {
        arguments: [fakeCodexAppServer, `--scenario=${scenario}`, ...engineArguments],
        executable: process.execPath,
      },
    }),
  );
  return registry;
}

/*
 * The usage journeys run Codex turns whose fake app-server states token usage
 * the way Codex does. The artifact records each statement it sent, whether
 * the Run ran the response it describes, and what the Host recorded against
 * what those responses add up to.
 */
interface UsageJourney extends UsageRecord {
  readonly name: string;
}

integration("Host, Runner, and Codex harness integration", () => {
  let stack: VerticalStack | undefined;
  const usageJourneys: UsageJourney[] = [];

  afterEach(async () => {
    await stack?.close();
    stack = undefined;
  }, 60_000);

  afterAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-codex-usage-"));
    const artifact = join(directory, "usage.json");
    await writeFile(artifact, JSON.stringify(usageJourneys, null, 2) + "\n");
    console.info(`Codex usage artifact: ${artifact}`);
  });

  /** A stack whose Codex states its usage and records every statement it sends. */
  async function startUsageStack(scenario: string, engineArguments: readonly string[] = []) {
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-codex-usage-engine-"));
    const captureFile = join(scratch, "capture.jsonl");
    stack = await startVerticalStack({
      catalogTimeoutMs: 10_000,
      databaseUrl: configuredDatabaseUrl!,
      harnessInstance: {
        config: {},
        driverKind: "codex",
        sourceId: "openai",
        stateKind: "isolated",
      },
      harnesses: fakeCodexRegistry(scenario, [
        "--token-usage",
        `--capture=${captureFile}`,
        ...engineArguments,
      ]),
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      runTimeoutMs: 30_000,
    });
    const threadId = await stack.createThread({
      modelSelection: codexSelection,
      title: "Usage journey",
      workspaceId: stack.mainWorkspaceId,
    });
    return { active: stack, captureFile, threadId };
  }

  it("closes a partly started deployment when its engine reports sign-in required", async () => {
    await expect(
      startVerticalStack({
        catalogTimeoutMs: 10_000,
        databaseUrl: configuredDatabaseUrl!,
        harnessInstance: {
          config: {},
          driverKind: "codex",
          sourceId: "openai",
          stateKind: "ambient",
        },
        harnesses: fakeCodexRegistry("signed-out-without-auth-flag"),
        harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
        runTimeoutMs: 15_000,
      }),
    ).rejects.toThrow("authentication-required: Sign in to Codex on this Runner");
  }, 30_000);

  it("commits a REST turn completed by a supervised Codex app-server", async () => {
    stack = await startVerticalStack({
      catalogTimeoutMs: 10_000,
      databaseUrl: configuredDatabaseUrl!,
      harnessInstance: {
        config: {},
        driverKind: "codex",
        sourceId: "openai",
        stateKind: "isolated",
      },
      harnesses: fakeCodexRegistry(),
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      runTimeoutMs: 15_000,
    });
    const { host, hostOrigin, mountCalls } = stack;

    const workspace = await stack.createWorkspace("Vertical client workspace");
    const threadId = await stack.createThread({
      modelSelection: ModelSelectionSchema.parse({
        modelId: "gpt-5.6-sol",
        options: { effort: "low" },
        providerId: "openai",
      }),
      title: "Complete the request",
      workspaceId: workspace.id,
    });
    const turn = await stack.sendMessage({
      text: "Complete this deterministic integration request.",
      threadId,
      workspaceId: workspace.id,
    });

    // The answer streams as live progress; the durable log holds its completion.
    expect(turn.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["run.started", "assistant.message", "run.completed"]),
    );
    expect(turn.assistantText).toBe("Completed by Codex.");
    const snapshot = await host.store.workspaceSnapshot(workspace.id);
    expect(snapshot.threads).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: threadId, status: "idle" })]),
    );
    const persistedRunnerEvents = await host.store.database
      .selectFrom("workspaceEvents")
      .select(["runnerOrdinal", "type"])
      .where("runId", "=", turn.runId)
      .where("runnerOrdinal", "is not", null)
      .orderBy("runnerOrdinal", "asc")
      .execute();
    expect(persistedRunnerEvents.map((event) => event.runnerOrdinal)).toEqual(
      persistedRunnerEvents.map((_event, index) => index),
    );
    await expect(
      host.store.database
        .selectFrom("runs")
        .select(["completedAt", "nextRunnerOrdinal", "status"])
        .where("id", "=", turn.runId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      completedAt: expect.any(Date),
      nextRunnerOrdinal: persistedRunnerEvents.length,
      status: "completed",
    });
    await expect(
      host.store.database
        .selectFrom("commands")
        .select("status")
        .where("runId", "=", turn.runId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "succeeded" });
    await expect(
      host.store.database
        .selectFrom("providerSessions")
        .select(["providerSessionReference", "status"])
        .where("threadId", "=", threadId)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      providerSessionReference: "codex-thread-1",
      status: "ready",
    });
    // Codex stated no usage for this turn, so the Run records none rather than zeroes.
    expectRecordedUsage(await recordedUsage(stack, turn.runId), { attempt: null, nodes: [] });

    // The owner's Main Workspace is provisioned on first bootstrap, and this
    // test then creates one specialized Workspace of its own.
    expect(stack.portableFsCreateCalls()).toBe(2);
    expect(workspace.kind).toBe("specialized");
    expect(mountCalls).toHaveLength(1);
    expect(mountCalls[0]).toMatchObject({
      plan: {
        kind: "portablefs",
        volumeId: expect.any(String),
        workspaceId: workspace.id,
      },
    });
    const preparedPlan = mountCalls[0]?.plan;
    if (preparedPlan?.kind !== "portablefs") {
      throw new Error("Expected the Host to dispatch an explicit PortableFS access plan");
    }
    expect(preparedPlan.exchangeUrl).toBe(`${hostOrigin.origin}/internal/v1/mount-grants/exchange`);
    expect(stack.mountCleanupCalls()).toBe(0);
  });

  it("records what a Codex turn's own responses consumed, once each", async () => {
    const { active, captureFile, threadId } = await startUsageStack("vertical");
    const turn = await active.sendMessage({
      text: "Complete this deterministic integration request.",
      threadId,
      workspaceId: active.mainWorkspaceId,
    });
    expect(turn.assistantText).toBe("Completed by Codex.");
    await waitFor(
      async () => (await codexUsageFrames(captureFile)).some((frame) => frame.label === "late"),
      "the statement after the turn",
    );

    const frames = await codexUsageFrames(captureFile);
    expect(frames.map((frame) => frame.label)).toEqual([
      "response",
      "duplicate",
      "foreign turn",
      "foreign thread",
      "response",
      "compaction",
      "response",
      "late",
    ]);
    const expected = expectedUsage(frames, await codexThreadOf(active, threadId));
    // Three responses and a compaction; the repeated reading, the readings of
    // a turn and a thread this Run did not run, and the one after it ended add nothing.
    expect(expected).toEqual({
      attempt: {
        cacheWriteTokens: 256,
        cachedInputTokens: 29_952,
        inputTokens: 9_953,
        outputTokens: 544,
        reasoningTokens: 72,
      },
      nodes: [],
    });
    const recorded = await recordedUsage(active, turn.runId);
    usageJourneys.push({ name: "several responses", ...usageRecord(frames, expected, recorded) });
    expectRecordedUsage(recorded, expected);
  });

  it("counts a steered Codex turn's responses on its one attempt", async () => {
    const { active, captureFile, threadId } = await startUsageStack("steer");
    const queued = await active.queueMessage({ text: "Draft the launch plan", threadId });
    const runId = queued.runId!;
    await waitFor(
      async () =>
        (await runStatus(active, runId)) === "running" &&
        (await codexUsageFrames(captureFile)).length === 1,
      "the turn's first response",
    );
    const steered = await active.steerMessage({ text: "Use the blue palette", threadId });
    expect(steered.runId).toBe(runId);
    await waitFor(
      async () => ["completed", "failed", "interrupted"].includes(await runStatus(active, runId)),
      "the Run to end",
    );
    expect(await runStatus(active, runId)).toBe("completed");

    const frames = await codexUsageFrames(captureFile);
    expect(frames.map((frame) => frame.label)).toEqual(["response", "response"]);
    const expected = expectedUsage(frames, await codexThreadOf(active, threadId));
    expect(expected.attempt).toEqual({
      cacheWriteTokens: 128,
      cachedInputTokens: 16_000,
      inputTokens: 6_222,
      outputTokens: 141,
      reasoningTokens: 49,
    });
    const recorded = await recordedUsage(active, runId);
    usageJourneys.push({ name: "steered turn", ...usageRecord(frames, expected, recorded) });
    expectRecordedUsage(recorded, expected);
  });

  it("fails a Run whose engine states usage that cannot be, keeping what came before", async () => {
    const { active, captureFile, threadId } = await startUsageStack("vertical", [
      "--impossible-usage",
    ]);
    const queued = await active.queueMessage({ text: "Complete the request", threadId });
    const runId = queued.runId!;
    await waitFor(
      async () => ["completed", "failed", "interrupted"].includes(await runStatus(active, runId)),
      "the Run to end",
    );
    expect(await runStatus(active, runId)).toBe("failed");
    const failure = await active.host.store.database
      .selectFrom("workspaceEvents")
      .select("data")
      .where("runId", "=", runId)
      .where("type", "=", "run.failed")
      .executeTakeFirstOrThrow();
    expect(failure.data).toMatchObject({
      code: "codex_harness_error",
      message: expect.stringContaining("thread/tokenUsage/updated"),
    });

    // The engine went on stating usage, but the driver read nothing after the
    // impossible reading, and counted only the response stated before it.
    const sent = await codexUsageFrames(captureFile);
    const frames = sent.slice(0, sent.findIndex((frame) => frame.label === "impossible") + 1);
    const before = frames.slice(0, -1);
    expect(before.map((frame) => frame.label)).toEqual(["response"]);
    const expected = expectedUsage(before, await codexThreadOf(active, threadId));
    expect(expected.attempt).toEqual({
      cacheWriteTokens: 0,
      cachedInputTokens: 11_008,
      inputTokens: 6_484,
      outputTokens: 151,
      reasoningTokens: 51,
    });
    const recorded = await recordedUsage(active, runId);
    usageJourneys.push({
      name: "impossible reading",
      ...usageRecord(frames, expected, recorded),
    });
    expectRecordedUsage(recorded, expected);
  });
});

async function runStatus(active: VerticalStack, runId: RunId): Promise<string> {
  const run = await active.host.store.database
    .selectFrom("runs")
    .select("status")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  return run.status;
}

async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
