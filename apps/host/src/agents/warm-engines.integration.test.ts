import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ModelSelectionSchema, type RunId, type ThreadId } from "@opensteer/core";
import {
  HarnessRegistry,
  isolatedServiceHarnessRuntimeBoundary,
  nativeUserHarnessRuntimeBoundary,
} from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import { OpencodeHarnessDriver } from "@opensteer/harness-opencode";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { testRpcData } from "../server/test-host-api-request.js";
import {
  codexThreadOf,
  codexUsageFrames,
  expectRecordedUsage,
  expectedUsage,
  recordedUsage,
  usageRecord,
  type CodexUsageFrame,
} from "./codex-usage.test-support.js";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";

/*
 * A Thread's engine stays running between its Runs when nothing it was
 * started with changes, and holds no authority while it waits. Each journey
 * drives the real Host, Runner and Codex driver against a fake app server
 * that records every process start, the token it was given, and each request,
 * so a reused engine is told apart from a fresh one.
 *
 * The artifact records, per journey, how many engines started, how long each
 * Run took, and what an idle engine's proxy answered; where the engine stated
 * token usage, each Run's statements and what it recorded against what it
 * should have.
 */

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const fakeCodexAppServer = fileURLToPath(
  new URL(
    "../../../../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs",
    import.meta.url,
  ),
);
const fakeOpencodeServer = fileURLToPath(
  new URL(
    "../../../../packages/harness-opencode/src/test-fixtures/fake-opencode-server.mjs",
    import.meta.url,
  ),
);
const selection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});

interface Journey {
  readonly engines: number;
  readonly name: string;
  readonly notes: Readonly<Record<string, unknown>>;
  readonly runMs: readonly number[];
}

integration("Warm engines", () => {
  let stack: VerticalStack | undefined;
  const journeys: Journey[] = [];

  afterEach(async () => {
    await stack?.close();
    stack = undefined;
  });

  afterAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-warm-"));
    const artifact = join(directory, "warm.json");
    await writeFile(artifact, JSON.stringify(journeys, null, 2) + "\n");
    console.info(`Warm engines artifact: ${artifact}`);
  });

  async function start(
    scenario = "vertical",
    engineArguments: readonly string[] = [],
    config: Readonly<Record<string, unknown>> = {},
  ) {
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-warm-codex-"));
    const captureFile = join(scratch, "capture.jsonl");
    stack = await startVerticalStack({
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
      harnessInstance: {
        config,
        driverKind: "codex",
        sourceId: "openai",
        stateKind: "isolated",
      },
      harnesses: () => {
        const registry = new HarnessRegistry();
        registry.registerDriver(
          new CodexHarnessDriver({
            launch: {
              arguments: [
                fakeCodexAppServer,
                `--scenario=${scenario}`,
                `--capture=${captureFile}`,
                "--capture-tokens",
                ...engineArguments,
              ],
              executable: process.execPath,
            },
          }),
        );
        return registry;
      },
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      runTimeoutMs: 60_000,
    });
    const threadId = await stack.createThread({
      modelSelection: selection,
      title: "Warm journey",
      workspaceId: stack.mainWorkspaceId,
    });
    return { active: stack, captureFile, threadId };
  }

  /**
   * Each Run's usage, from the statements its engine sent while it ran:
   * those after the fake was asked for that Run's turn, before the next one.
   */
  async function usageByRun(
    active: VerticalStack,
    captureFile: string,
    threadId: ThreadId,
    runIds: readonly RunId[],
  ) {
    const frames = await codexUsageFrames(captureFile);
    const rootThreadId = await codexThreadOf(active, threadId);
    return Promise.all(
      runIds.map(async (runId, index) => {
        const own = frames.filter((frame) => frame.turnStarts === index + 1);
        const expected = expectedUsage(own, rootThreadId);
        return { expected, own, recorded: await recordedUsage(active, runId) };
      }),
    );
  }

  async function startOpencode(
    scenario = "zen-free",
    engineArguments: readonly string[] = [],
    config: Readonly<Record<string, unknown>> = {},
  ) {
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-warm-opencode-"));
    const captureFile = join(scratch, "capture.jsonl");
    stack = await startVerticalStack({
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
      harnessInstance: {
        config,
        driverKind: "opencode",
        sourceId: "opencode",
        stateKind: "isolated",
      },
      harnesses: () => {
        const registry = new HarnessRegistry();
        registry.registerDriver(
          new OpencodeHarnessDriver({
            arguments: [
              fakeOpencodeServer,
              `--scenario=${scenario}`,
              `--capture=${captureFile}`,
              ...engineArguments,
            ],
            executable: process.execPath,
          }),
        );
        return registry;
      },
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      runTimeoutMs: 60_000,
    });
    const model = stack.catalog.models[0]!;
    const threadId = await stack.createThread({
      modelSelection: ModelSelectionSchema.parse({
        modelId: model.modelId,
        options: {},
        providerId: model.providerId,
      }),
      title: "Warm OpenCode journey",
      workspaceId: stack.mainWorkspaceId,
    });
    return { active: stack, captureFile, threadId };
  }

  /** A Run on the Thread, start to end, and how long it took. */
  async function run(active: VerticalStack, threadId: ThreadId, text: string) {
    const started = performance.now();
    const queued = await active.queueMessage({ text, threadId });
    const runId = queued.runId!;
    await settled(active, runId);
    return { ms: Math.round(performance.now() - started), runId };
  }

  it(
    "serves a Thread's next Run with the engine its last Run left",
    { timeout: 120_000 },
    async () => {
      // Each turn after the first begins by restating the thread's reading.
      const { active, captureFile, threadId } = await start("vertical", [
        "--token-usage",
        "--restate-usage",
      ]);
      const first = await run(active, threadId, "First question");
      const second = await run(active, threadId, "Second question");
      const third = await run(active, threadId, "Third question");
      for (const done of [first, second, third]) {
        expect((await runRow(active, done.runId)).status).toBe("completed");
      }
      const capture = await captured(captureFile);
      const engines = turnServers(capture);
      expect(engines).toBe(1);
      // Each Run's leftovers end before the engine waits again.
      expect(capture.filter((line) => line.backgroundTerminalsCleaned).length).toBe(3);
      // Each execution's details say how its engine started.
      const starts = [];
      for (const done of [first, second, third]) starts.push(await engineStart(active, done.runId));
      expect(starts).toEqual(["cold", "warm", "warm"]);
      // The engine's running total grows across the three Runs; each records
      // only its own responses, and a restated reading adds nothing.
      const usage = await usageByRun(active, captureFile, threadId, [
        first.runId,
        second.runId,
        third.runId,
      ]);
      expect(usage.map(({ own }) => own[0]?.label)).toEqual(["response", "restated", "restated"]);
      for (const { expected, recorded } of usage) {
        expect(expected.attempt).toEqual({
          cacheWriteTokens: 256,
          cachedInputTokens: 29_952,
          inputTokens: 9_953,
          outputTokens: 544,
          reasoningTokens: 72,
        });
        expectRecordedUsage(recorded, expected);
      }
      journeys.push({
        engines,
        name: "reuse",
        notes: {
          engineStarts: starts,
          usage: usage.map(({ expected, own, recorded }) => usageRecord(own, expected, recorded)),
        },
        runMs: [first.ms, second.ms, third.ms],
      });
    },
  );

  it.each([
    ["valid", ["--title-reply=Support migration\nplane"], "plane", "generated", 1],
    ["title only", ["--title-reply=Support migration"], "document", "generated", 1],
    ["invalid symbol", ["--title-reply=Support migration\ninvalid"], "document", "generated", 1],
    ["no reply", ["--title-reply="], null, "provisional", 2],
    ["failed call", ["--title-error"], null, "provisional", 2],
  ] as const)(
    "isolates naming and keeps its engine warm after %s",
    { timeout: 120_000 },
    async (name, arguments_, icon, iconSource, calls) => {
      const { active, captureFile, threadId } = await start("vertical", [
        "--token-usage",
        "--restate-usage",
        ...arguments_,
      ]);
      const first = await run(active, threadId, "First question");
      const second = await run(active, threadId, "Second question");
      const stored = await active.host.store.database
        .selectFrom("threads")
        .select(["title", "icon", "iconSource"])
        .where("id", "=", threadId)
        .executeTakeFirstOrThrow();
      expect(stored).toEqual({ title: "Warm journey", icon, iconSource });
      const capture = await captured(captureFile);
      const naming = capture.flatMap((line) => (line.fakeTitleTurn ? [line.fakeTitleTurn] : []));
      expect(naming).toHaveLength(calls);
      expect(naming.every(({ pid }) => !alive(pid))).toBe(true);
      const namingThreads = new Set(naming.map((turn) => turn.threadId));
      expect(
        capture.filter((line) => line.usageFrame && namingThreads.has(line.usageFrame.threadId)),
      ).toHaveLength(name === "failed call" ? 0 : calls);
      expect(turnServers(capture)).toBe(1);
      const starts = [
        await engineStart(active, first.runId),
        await engineStart(active, second.runId),
      ];
      expect(starts).toEqual(["cold", "warm"]);
      const usage = await usageByRun(active, captureFile, threadId, [first.runId, second.runId]);
      for (const { expected, recorded } of usage) {
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
        expectRecordedUsage(recorded, expected);
      }
      const transcript = await active.host.store.database
        .selectFrom("messages")
        .select("content")
        .where("threadId", "=", threadId)
        .execute();
      expect(JSON.stringify(transcript)).not.toContain("Support migration");
      expect(JSON.stringify(transcript)).not.toContain("You name tasks");
      journeys.push({
        engines: 1,
        name: `naming: ${name}`,
        notes: { naming, stored, engineStarts: starts, usage },
        runMs: [first.ms, second.ms],
      });
    },
  );

  it(
    "cleans every thread a reused engine's Run used before the next Run",
    { timeout: 120_000 },
    async () => {
      const { active, captureFile, threadId } = await start("background-children", [
        `--release-file=${await releasedFile()}`,
      ]);
      const first = await run(active, threadId, "Research the release in the background");
      const second = await run(active, threadId, "Second question");
      for (const done of [first, second]) {
        expect((await runRow(active, done.runId)).status).toBe("completed");
      }
      const cleanedThreads = async () =>
        (await captured(captureFile)).flatMap((line) =>
          line.backgroundTerminalsCleaned ? [line.backgroundTerminalsCleaned] : [],
        );
      await waitFor(async () => (await cleanedThreads()).length === 3, "the second release");
      // The first Run's researcher worked on a thread of its own; the second
      // Run used only the root's.
      const cleaned = await cleanedThreads();
      expect(cleaned).toEqual(["codex-thread-1", "codex-child-thread-1", "codex-thread-1"]);
      const starts = [
        await engineStart(active, first.runId),
        await engineStart(active, second.runId),
      ];
      expect(starts).toEqual(["cold", "warm"]);
      journeys.push({
        engines: turnServers(await captured(captureFile)),
        name: "subagent thread cleanup",
        notes: { cleaned, engineStarts: starts },
        runMs: [first.ms, second.ms],
      });
    },
  );

  it(
    "does not keep an engine whose subagent thread could not be cleaned",
    { timeout: 120_000 },
    async () => {
      const { active, captureFile, threadId } = await start("background-children", [
        `--release-file=${await releasedFile()}`,
        "--fail-clean=codex-child-thread-1",
      ]);
      const first = await run(active, threadId, "Research the release in the background");
      const second = await run(active, threadId, "Research it again");
      for (const done of [first, second]) {
        expect((await runRow(active, done.runId)).status).toBe("completed");
      }
      const capture = await captured(captureFile);
      expect(
        capture.filter((line) => line.backgroundTerminalsCleaned === "codex-child-thread-1"),
      ).not.toHaveLength(0);
      const engines = turnServers(capture);
      expect(engines).toBe(2);
      const starts = [
        await engineStart(active, first.runId),
        await engineStart(active, second.runId),
      ];
      expect(starts).toEqual(["cold", "cold"]);
      journeys.push({
        engines,
        name: "subagent thread cleanup failed",
        notes: { engineStarts: starts },
        runMs: [first.ms, second.ms],
      });
    },
  );

  it(
    "serves an OpenCode Thread's next Run with the same server",
    { timeout: 120_000 },
    async () => {
      const { active, captureFile, threadId } = await startOpencode();
      const first = await run(active, threadId, "First question");
      const second = await run(active, threadId, "Second question");
      for (const done of [first, second]) {
        expect((await runRow(active, done.runId)).status).toBe("completed");
      }
      const engines = turnServers(await captured(captureFile));
      expect(engines).toBe(1);
      journeys.push({ engines, name: "opencode reuse", notes: {}, runMs: [first.ms, second.ms] });
    },
  );

  it(
    "keeps a reused engine's tool session working on its next Run's authority",
    { timeout: 120_000 },
    async () => {
      const { active, captureFile, threadId } = await start("mcp-session");
      const first = await run(active, threadId, "First question");
      const second = await run(active, threadId, "Second question");
      const calls = (await captured(captureFile)).flatMap((line) =>
        line.fakeMcpCall ? [line.fakeMcpCall] : [],
      );
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => call.ok)).toBe(true);
      // One engine, one session, and each call answered with its own Run's tools.
      expect(new Set(calls.map((call) => call.pid)).size).toBe(1);
      expect(new Set(calls.map((call) => call.sessionId)).size).toBe(1);
      for (const done of [first, second]) {
        expect((await runRow(active, done.runId)).status).toBe("completed");
      }
      journeys.push({
        engines: 1,
        name: "tool session across Runs",
        notes: { calls },
        runMs: [first.ms, second.ms],
      });
    },
  );

  it("lends an idle engine no authority", { timeout: 120_000 }, async () => {
    const { active, captureFile, threadId } = await start();
    const iconSet = await active.api["commands.dispatch"]({
      type: "thread.icon.set",
      threadId,
      icon: "document",
      idempotencyKey: "idle-authority-icon",
    });
    expect(iconSet.ok).toBe(true);
    const first = await run(active, threadId, "First question");
    const capture = await readFile(captureFile, "utf8");
    const token = (await captured(captureFile)).findLast((line) => line.fakeOpensteerTokens)
      ?.fakeOpensteerTokens?.agentTools;
    const url = capture.match(/http:\/\/127\.0\.0\.1:\d+\/[\w-]+\/agent-tools/gu)?.at(-1);
    if (!token || !url) throw new Error("The engine's proxy was not captured");
    const idle = await fetch(url, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(idle.status).toBe(403);
    // The next Run gets the same engine, and the proxy carries its authority.
    const second = await run(active, threadId, "Second question");
    expect((await runRow(active, second.runId)).status).toBe("completed");
    expect(turnServers(await captured(captureFile))).toBe(1);
    journeys.push({
      engines: 1,
      name: "idle authority",
      notes: { idleProxyStatus: idle.status },
      runMs: [first.ms, second.ms],
    });
  });

  it(
    "does not keep an engine that granted an answer for the rest of its runtime",
    { timeout: 120_000 },
    async () => {
      const { active, captureFile, threadId } = await start("run-scoped-approval");
      await active.updateThreadAccess(threadId, "approval-required");
      const queued = await active.queueMessage({ text: "Run the tests", threadId });
      const runId = queued.runId!;
      const request = await pendingRequest(active, runId);
      await answer(active, request.id, "allow-run");
      await settled(active, runId);
      const queuedAgain = await active.queueMessage({ text: "Run them again", threadId });
      const again = await pendingRequest(active, queuedAgain.runId!);
      await answer(active, again.id, "allow-once");
      await settled(active, queuedAgain.runId!);
      const engines = turnServers(await captured(captureFile));
      expect(engines).toBe(2);
      journeys.push({ engines, name: "run-scoped approval", notes: {}, runMs: [] });
    },
  );

  /*
   * Codex restates a resumed thread's reading, naming the thread's last turn,
   * before any new turn: right after the resume, or — when it reaches the
   * driver late — once the Run's turn has been asked for but before it starts.
   */
  it.each([
    { arrives: "right after the resume", engineArguments: [] },
    {
      arrives: "once the Run has asked for its turn",
      engineArguments: ["--defer-resume-restatement"],
    },
  ])(
    "starts a new engine when the selection changes, counting only the resumed thread's new growth: restatement $arrives",
    { timeout: 120_000 },
    async ({ arrives, engineArguments }) => {
      const { active, captureFile, threadId } = await start("vertical", [
        "--token-usage",
        "--single-response",
        "--unique-turns",
        ...engineArguments,
      ]);
      const first = await run(active, threadId, "First question");
      await active.updateThreadExecution(
        threadId,
        ModelSelectionSchema.parse({ ...selection, options: { effort: "high" } }),
      );
      const second = await run(active, threadId, "Second question");
      const capture = await captured(captureFile);
      const engines = turnServers(capture);
      expect(engines).toBe(2);
      expect(capture.filter((line) => line.method === "thread/resume")).toHaveLength(1);

      // The first engine's turn, the second engine's restatement of it, and
      // the second engine's own turn, whose running total starts from it.
      const frames = await codexUsageFrames(captureFile);
      expect(frames.map((frame) => frame.label)).toEqual(["response", "restated", "response"]);
      const [answered, restated, resumed] = frames as [
        CodexUsageFrame,
        CodexUsageFrame,
        CodexUsageFrame,
      ];
      expect(answered.total.totalTokens).toBe(17_515);
      expect(restated).toMatchObject({
        last: answered.total,
        total: answered.total,
        turnId: answered.turnId,
      });
      // Before the second Run's turn was asked for, or after it but before
      // the turn's own first response.
      expect(restated.turnStarts).toBe(engineArguments.length === 0 ? 1 : 2);
      expect(resumed.turnId).not.toBe(answered.turnId);
      expect(resumed.total.totalTokens).toBe(35_257);
      expect(resumed.last.totalTokens).toBe(17_742);

      const rootThreadId = await codexThreadOf(active, threadId);
      const expected = [
        expectedUsage([answered], rootThreadId),
        expectedUsage([resumed], rootThreadId),
      ];
      expect(expected.map(({ attempt }) => attempt)).toEqual([
        {
          cacheWriteTokens: 0,
          cachedInputTokens: 11_008,
          inputTokens: 6_356,
          outputTokens: 151,
          reasoningTokens: 51,
        },
        {
          cacheWriteTokens: 0,
          cachedInputTokens: 17_152,
          inputTokens: 438,
          outputTokens: 152,
          reasoningTokens: 64,
        },
      ]);
      const recorded = [
        await recordedUsage(active, first.runId),
        await recordedUsage(active, second.runId),
      ];
      expectRecordedUsage(recorded[0]!, expected[0]!);
      expectRecordedUsage(recorded[1]!, expected[1]!);
      journeys.push({
        engines,
        name: `selection change, restatement ${arrives}`,
        notes: {
          usage: [
            usageRecord([answered], expected[0]!, recorded[0]!),
            usageRecord([restated, resumed], expected[1]!, recorded[1]!),
          ],
        },
        runMs: [first.ms, second.ms],
      });
    },
  );

  it("starts a new engine when the Workspace's skills change", { timeout: 120_000 }, async () => {
    const { active, captureFile, threadId } = await start();
    await run(active, threadId, "First question");
    // An engine reads its skill catalog when it starts.
    const skill = join(active.mountedWorkspacePath, "skills", "release-notes");
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: release-notes\ndescription: Write release notes.\n---\nList what changed.\n",
    );
    const second = await run(active, threadId, "Second question");
    expect((await runRow(active, second.runId)).status).toBe("completed");
    expect(await engineStart(active, second.runId)).toBe("cold");
    // Editing a skill changes what the engine read too.
    await writeFile(
      join(skill, "SKILL.md"),
      "---\nname: release-notes\ndescription: Write release notes for a release.\n---\nList what changed.\n",
    );
    const third = await run(active, threadId, "Third question");
    expect(await engineStart(active, third.runId)).toBe("cold");
    const fourth = await run(active, threadId, "Fourth question");
    expect(await engineStart(active, fourth.runId)).toBe("warm");
    const engines = turnServers(await captured(captureFile));
    expect(engines).toBe(3);
    journeys.push({
      engines,
      name: "workspace skills change",
      notes: {},
      runMs: [second.ms, third.ms, fourth.ms],
    });
  });

  it(
    "frees a stopped Run's conversation at once though its engine never finished the turn",
    { timeout: 120_000 },
    async () => {
      // The engine acknowledges the interrupt and never ends the turn; waiting
      // for it would hold the conversation for this long.
      const requestTimeoutMs = 120_000;
      const releaseFile = join(await mkdtemp(join(tmpdir(), "opensteer-warm-release-")), "release");
      const { active, captureFile, threadId } = await start(
        "long-stream-held",
        ["--ignore-interrupt", `--release-file=${releaseFile}`],
        { requestTimeoutMs },
      );
      const turnPids = async () =>
        (await captured(captureFile)).flatMap((line) => (line.fakeTurn ? [line.fakeTurn.pid] : []));
      const stopped = (await active.queueMessage({ text: "Write at length", threadId })).runId!;
      await waitFor(
        async () =>
          (await runRow(active, stopped)).status === "running" && (await turnPids()).length === 1,
        "the held turn",
      );

      const stoppedAt = performance.now();
      await active.interruptRun(threadId, stopped);
      await settled(active, stopped);
      expect((await runRow(active, stopped)).status).toBe("interrupted");
      // The next message reaches the same conversation in a new engine.
      await active.resumeThreadInputQueue(threadId);
      const next = (await active.queueMessage({ text: "Again", threadId })).runId!;
      await waitFor(
        async () =>
          (await turnPids()).length === 2 ||
          ["completed", "failed", "interrupted"].includes((await runRow(active, next)).status),
        "the next Run's turn",
      );
      await writeFile(releaseFile, "");
      await settled(active, next);
      const nextMs = Math.round(performance.now() - stoppedAt);
      const failure = await active.host.store.database
        .selectFrom("runs")
        .select("failure")
        .where("id", "=", next)
        .executeTakeFirstOrThrow();
      expect(failure.failure).toBeNull();
      expect((await runRow(active, next)).status).toBe("completed");
      expect(nextMs).toBeLessThan(requestTimeoutMs / 4);
      const [first, second] = await turnPids();
      expect(second).not.toBe(first);
      expect(alive(first!)).toBe(false);
      journeys.push({
        engines: turnServers(await captured(captureFile)),
        name: "stop of an engine that never finishes the turn",
        notes: { nextRunCompletedAfterStopMs: nextMs, requestTimeoutMs },
        runMs: [nextMs],
      });
    },
  );

  it(
    "frees a stopped OpenCode Run's conversation at once though its server never settled the turn",
    { timeout: 120_000 },
    async () => {
      // The server takes the abort and would settle the turn only this late;
      // waiting for it would hold the conversation for the driver's whole budget.
      const interruptTimeoutMs = 120_000;
      const { active, threadId } = await startOpencode(
        "steer-restart",
        ["--abort-delay-ms=600000"],
        { interruptTimeoutMs },
      );
      const stopped = (await active.queueMessage({ text: "[hold] Draft the plan", threadId }))
        .runId!;
      await waitFor(async () => (await runRow(active, stopped)).status === "running", "the turn");

      const stoppedAt = performance.now();
      await active.interruptRun(threadId, stopped);
      await settled(active, stopped);
      expect((await runRow(active, stopped)).status).toBe("interrupted");
      await active.resumeThreadInputQueue(threadId);
      const next = (await active.queueMessage({ text: "Again", threadId })).runId!;
      await settled(active, next);
      const nextMs = Math.round(performance.now() - stoppedAt);
      const failure = await active.host.store.database
        .selectFrom("runs")
        .select("failure")
        .where("id", "=", next)
        .executeTakeFirstOrThrow();
      expect(failure.failure).toBeNull();
      expect((await runRow(active, next)).status).toBe("completed");
      expect(nextMs).toBeLessThan(interruptTimeoutMs / 4);
      journeys.push({
        engines: 2,
        name: "stop of an OpenCode server that never settles the turn",
        notes: { interruptTimeoutMs, nextRunCompletedAfterStopMs: nextMs },
        runMs: [nextMs],
      });
    },
  );

  it("ends the engine of a stopped Run", { timeout: 120_000 }, async () => {
    const { active, captureFile, threadId } = await start("vertical", ["--hold-second-turn"]);
    await run(active, threadId, "First question");
    const kept = (await captured(captureFile)).find((line) => line.fakeTurn)?.fakeTurn?.pid;
    if (kept === undefined) throw new Error("The engine's process was not captured");
    const queued = await active.queueMessage({ text: "Second question", threadId });
    const runId = queued.runId!;
    await waitFor(
      async () => (await captured(captureFile)).filter((line) => line.fakeTurn).length === 2,
      "the second turn",
    );
    await active.interruptRun(threadId, runId);
    await settled(active, runId);
    expect((await runRow(active, runId)).status).toBe("interrupted");
    // Whatever the stopped turn left is gone with its engine, before the Thread runs again.
    expect(alive(kept)).toBe(false);
    await active.resumeThreadInputQueue(threadId);
    const third = await run(active, threadId, "Third question");
    expect((await runRow(active, third.runId)).status).toBe("completed");
    const engines = turnServers(await captured(captureFile));
    expect(engines).toBe(2);
    expect(await engineStart(active, third.runId)).toBe("cold");
    journeys.push({ engines, name: "stop", notes: {}, runMs: [third.ms] });
  });

  it("ends its idle engines when the Runner shuts down", { timeout: 120_000 }, async () => {
    const { active, captureFile, threadId } = await start();
    await run(active, threadId, "First question");
    const pid = (await captured(captureFile)).find((line) => line.fakeTurn)?.fakeTurn?.pid;
    if (pid === undefined) throw new Error("The engine's process was not captured");
    expect(alive(pid)).toBe(true);
    const closing = performance.now();
    await active.close();
    stack = undefined;
    const closeMs = Math.round(performance.now() - closing);
    expect(alive(pid)).toBe(false);
    journeys.push({ engines: 1, name: "shutdown", notes: { closeMs }, runMs: [] });
  });
});

/** What the fake engines recorded: each turn's process, its token, each cleanup. */
interface Captured {
  readonly backgroundTerminalsCleaned?: string;
  /** A request the driver sent the app server. */
  readonly method?: string;
  readonly fakeMcpCall?: {
    readonly error?: string;
    readonly ok: boolean;
    readonly pid: number;
    readonly sessionId?: string;
  };
  readonly fakeOpensteerTokens?: { readonly agentTools: string };
  readonly fakeTurn?: { readonly pid: number };
  readonly fakeTitleTurn?: { readonly pid: number; readonly threadId: string };
  readonly usageFrame?: { readonly threadId: string };
  /** OpenCode's record of a prompt and the server that took it. */
  readonly kind?: string;
  readonly pid?: number;
}

/** The engines that served a turn; catalog reads start engines of their own. */
function turnServers(capture: readonly Captured[]): number {
  return new Set(
    capture.flatMap((line) => {
      if (line.fakeTurn) return [line.fakeTurn.pid];
      return line.kind === "prompt" && line.pid !== undefined ? [line.pid] : [];
    }),
  ).size;
}

async function captured(file: string): Promise<Captured[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Captured);
}

/** A release file that already exists, so a background child finishes as soon as it starts. */
async function releasedFile(): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), "opensteer-warm-release-")), "release");
  await writeFile(file, "");
  return file;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pendingRequest(active: VerticalStack, runId: RunId) {
  let found: { readonly id: string } | undefined;
  await waitFor(async () => {
    found = await active.host.store.database
      .selectFrom("requests")
      .select("id")
      .where("originatingRunId", "=", runId)
      .where("status", "=", "pending")
      .executeTakeFirst();
    return found !== undefined;
  }, "a pending Request");
  return found!;
}

async function answer(active: VerticalStack, requestId: string, optionId: string) {
  const key = `respond-${randomUUID()}`;
  await testRpcData(
    active.hostOrigin,
    "commands.dispatch",
    {
      idempotencyKey: key,
      requestId,
      response: { kind: "choice", optionId },
      type: "request.respond",
    },
    {
      headers: {
        cookie: active.sessionCookie,
        "content-type": "application/json",
        "idempotency-key": key,
        origin: active.hostOrigin.origin,
      },
    },
  );
}

async function settled(active: VerticalStack, runId: RunId) {
  await waitFor(
    async () =>
      ["completed", "failed", "interrupted"].includes((await runRow(active, runId)).status),
    "the Run to end",
  ).catch(async (error: unknown) => {
    const events = await active.host.store.database
      .selectFrom("workspaceEvents")
      .select("type")
      .where("runId", "=", runId)
      .orderBy("sequence", "asc")
      .execute();
    throw new Error(
      `${String(error)}\n${JSON.stringify({ events: events.map(({ type }) => type), run: await runRow(active, runId) })}`,
    );
  });
}

async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/** How the Run's engine started, as its execution details report it. */
async function engineStart(active: VerticalStack, runId: RunId) {
  const listed = await active.api["run.attempts.list"]({ runId });
  if (!listed.ok) throw new Error(listed.error.message);
  return listed.data.attempts.at(-1)?.engineStart ?? null;
}

function runRow(active: VerticalStack, runId: RunId) {
  return active.host.store.database
    .selectFrom("runs")
    .select("status")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
}
