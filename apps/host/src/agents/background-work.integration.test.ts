import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  conversationTurn,
  foldTranscriptEvent,
  groupTranscriptEntries,
  observedSequence,
  threadActivity,
  threadActivityIndicator,
  type TranscriptEntry,
} from "@opensteer/client/host";
import {
  AgentEventSchema,
  harnessMinimumVersion,
  ModelSelectionSchema,
  type RunId,
  type ThreadId,
} from "@opensteer/core";
import { HarnessRegistry, isolatedServiceHarnessRuntimeBoundary } from "@opensteer/harness";
import {
  ClaudeHarnessDriver,
  type ClaudeAgentSdk,
  type ClaudeQueryHandle,
} from "@opensteer/harness-claude";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  codexThreadOf,
  codexUsageFrames,
  expectRecordedUsage,
  expectedUsage,
  recordedUsage,
  usageRecord,
  type UsageRecord,
} from "./codex-usage.test-support.js";
import { waitForBackgroundWork as waitFor } from "./background-work.test-support.js";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";

/*
 * Work an engine leaves running when its turn ends stays joined to the Run
 * that started it: the Run waits in the background phase, takes its
 * requester's next message as a new turn, and ends when that work does — or
 * at its deadline, or when stopped. Each journey drives the real Host, Runner
 * and Codex driver against a fake app server whose root answers while a
 * researcher child keeps working until the test releases it.
 *
 * The artifact records each journey's Run, phases, nodes and messages; where
 * the engine stated token usage, each statement and what the Run and its
 * nodes recorded against what they should have.
 */

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
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

interface Journey {
  readonly events: readonly string[];
  readonly messages: readonly string[];
  readonly name: string;
  readonly nodes: readonly unknown[];
  readonly run: unknown;
  readonly usage?: UsageRecord;
}

integration("Background work", () => {
  let stack: VerticalStack | undefined;
  const journeys: Journey[] = [];

  afterEach(async () => {
    await stack?.close();
    stack = undefined;
  });

  afterAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-background-"));
    const artifact = join(directory, "background.json");
    await writeFile(artifact, JSON.stringify(journeys, null, 2) + "\n");
    console.info(`Background work artifact: ${artifact}`);
  });

  async function start(engineArguments: readonly string[] = []) {
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-background-codex-"));
    const releaseFile = join(scratch, "release");
    const captureFile = join(scratch, "capture.jsonl");
    stack = await startVerticalStack({
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
      harnessInstance: {
        config: {},
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
                "--scenario=background-children",
                "--unique-threads",
                `--release-file=${releaseFile}`,
                `--capture=${captureFile}`,
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
      modelSelection: codexSelection,
      title: "Background journey",
      workspaceId: stack.mainWorkspaceId,
    });
    const queued = await stack.queueMessage({
      text: "Research the release in the background",
      threadId,
    });
    const runId = queued.runId!;
    await waitFor(async () => (await runRow(stack!, runId)).phase === "background", "background");
    return {
      active: stack,
      captureFile,
      release: () => writeFile(releaseFile, ""),
      runId,
      threadId,
    };
  }

  async function record(
    name: string,
    active: VerticalStack,
    runId: RunId,
    usage?: UsageRecord,
  ): Promise<Journey> {
    const listed = await active.api["run.attempts.list"]({ runId });
    if (!listed.ok) throw new Error(listed.error.message);
    const database = active.host.store.database;
    const messages = await database
      .selectFrom("messages")
      .select("content")
      .where("runId", "=", runId)
      .where("kind", "=", "assistant")
      .orderBy("sequence", "asc")
      .execute();
    const journey: Journey = {
      events: await eventTypes(active, runId),
      messages: messages.map((message) => textOf(message.content)),
      name,
      nodes: listed.data.nodes,
      run: await runRow(active, runId),
      ...(usage ? { usage } : {}),
    };
    journeys.push(journey);
    return journey;
  }

  it(
    "keeps the Run live while its child works, and takes its requester's message as a new turn",
    { timeout: 120_000 },
    async () => {
      const { active, captureFile, release, runId, threadId } = await start(["--token-usage"]);
      expect((await runRow(active, runId)).status).toBe("running");
      // What every client shows: the turn's reply, no typing, and that the
      // work carries on.
      const during = await clientView(active, threadId, runId);
      expect(during.replies).toEqual(["The researcher is working in the background."]);
      expect(during.composing).toBe(false);
      expect(during.activity).toBe("background");
      expect(during.indicator).toEqual({ kind: "status", label: "Working in the background" });
      expect(during.readThrough).toBe(during.replySequences.at(-1));
      // A history page that begins after the Run started shows the reply too.
      const page = await clientView(active, threadId, runId, { pageAfter: "run.started" });
      expect(page.replies).toEqual(["The researcher is working in the background."]);
      expect(page.composing).toBe(false);

      // An ordinary message, not a steer: the Run in the background takes it.
      const sent = await active.queueMessage({ text: "Also check the changelog", threadId });
      expect(sent.runId).toBe(runId);
      await waitFor(
        async () =>
          (await assistantTexts(active, runId)).some(
            (text) => text.startsWith("Noted:") && text.endsWith("Also check the changelog"),
          ),
        "the new turn's answer",
      ).catch(async (error: unknown) => {
        const commands = await active.host.store.database
          .selectFrom("commands")
          .select(["type", "status", "lastError"])
          .where("runId", "=", runId)
          .execute();
        throw new Error(
          `${String(error)}\n${JSON.stringify({ commands, events: await eventTypes(active, runId) })}`,
        );
      });
      await waitFor(async () => (await runRow(active, runId)).phase === "background", "background");
      const input = await active.host.store.database
        .selectFrom("threadInputs")
        .select(["runId", "state"])
        .where("messageId", "=", sent.messageId)
        .executeTakeFirstOrThrow();
      expect(input).toEqual({ runId, state: "delivered" });

      await release();
      await settled(active, runId);
      // Both of the root's turns and every response of the child working
      // through them are this Run's; the child's are also its node's.
      const frames = await codexUsageFrames(captureFile);
      const expected = expectedUsage(frames, await codexThreadOf(active, threadId));
      expect(expected).toEqual({
        attempt: {
          cacheWriteTokens: 0,
          cachedInputTokens: 31_360,
          inputTokens: 12_540,
          outputTokens: 886,
          reasoningTokens: 404,
        },
        nodes: [
          {
            cacheWriteTokens: 0,
            cachedInputTokens: 6_272,
            inputTokens: 7_228,
            outputTokens: 660,
            reasoningTokens: 340,
          },
        ],
      });
      const recorded = await recordedUsage(active, runId);
      const journey = await record(
        "message during background",
        active,
        runId,
        usageRecord(frames, expected, recorded),
      );
      expectRecordedUsage(recorded, expected);
      expect(journey.run).toMatchObject({ status: "completed" });
      expect(journey.nodes).toMatchObject([
        { result: "Background research finished.", status: "completed", title: "researcher" },
      ]);
      expect(journey.messages).toEqual([
        "The researcher is working in the background.",
        expect.stringMatching(/^Noted:[\s\S]*Also check the changelog$/u),
      ]);
      expect(journey.events.filter((type) => type === "run.phase")).toHaveLength(3);
      // Each turn answered in its own reply.
      const after = await clientView(active, threadId, runId);
      expect(after.replies).toEqual([
        "The researcher is working in the background.",
        expect.stringMatching(/^Noted:[\s\S]*Also check the changelog$/u),
      ]);
      expect(after.composing).toBe(false);
      // Both of the child's steps, one taken after the root answered, are its own.
      expect(after.subagentSteps).toEqual([2]);
      const runs = await active.host.store.database
        .selectFrom("runs")
        .select("id")
        .where("threadId", "=", threadId)
        .execute();
      expect(runs).toHaveLength(1);
    },
  );

  it(
    "does not end the Run when its last child finishes while a new turn is starting",
    { timeout: 120_000 },
    async () => {
      const { active, runId, threadId } = await start(["--child-ends-while-starting"]);
      const sent = await active.queueMessage({ text: "Also check the changelog", threadId });
      expect(sent.runId).toBe(runId);
      await settled(active, runId);

      const journey = await record("child ends while a turn starts", active, runId);
      expect(journey.run).toMatchObject({ status: "completed" });
      // The new turn answered before the Run ended; the child's end did not end it.
      expect(journey.messages).toEqual([
        "The researcher is working in the background.",
        expect.stringMatching(/^Noted:[\s\S]*Also check the changelog$/u),
      ]);
      expect(journey.nodes).toMatchObject([{ status: "completed" }]);
      const phases = journey.events.filter((type) => type === "run.phase");
      expect(phases).toHaveLength(2);
      expect(journey.events.filter((type) => type === "run.completed")).toHaveLength(1);
      expect(journey.events.at(-1)).toBe("run.completed");
    },
  );

  it.each([
    { order: "answered and announced", engineArguments: ["--slow-follow-up-start"] },
    {
      order: "announced long before it is answered",
      engineArguments: ["--slow-follow-up-start", "--announce-before-answer"],
    },
  ])(
    "interrupts a new turn that was still starting when its Runner stops the Run: $order",
    { timeout: 120_000 },
    async ({ engineArguments }) => {
      const { active, captureFile, runId, threadId } = await start(engineArguments);
      await active.queueMessage({ text: "Also check the changelog", threadId });
      // The engine has been asked for the new turn and has not started it yet.
      await waitFor(
        async () => (await readFile(captureFile, "utf8")).split('"fakeTurn"').length - 1 === 2,
        "the new turn to be asked for",
      );
      // A Runner that stops ends its Runs itself, there and then.
      await active.restartRunner();
      await settled(active, runId);
      // The turn that started after the stop was interrupted by its own id.
      const interrupted = (await readFile(captureFile, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { rootInterrupted?: string | null })
        .flatMap((line) => (line.rootInterrupted === undefined ? [] : [line.rootInterrupted]));
      expect(interrupted).toEqual(["codex-turn-2"]);
      const journey = await record("Runner stop while a turn starts", active, runId);
      expect(journey.run).not.toMatchObject({ status: "completed" });
    },
  );

  it("stops background work when the Run is stopped", { timeout: 120_000 }, async () => {
    const { active, captureFile, runId, threadId } = await start(["--token-usage"]);
    await active.interruptRun(threadId, runId);
    await settled(active, runId);
    // Stopped between the root's turns: what it and its child had consumed.
    const frames = await codexUsageFrames(captureFile);
    const expected = expectedUsage(frames, await codexThreadOf(active, threadId));
    expect(expected).toEqual({
      attempt: {
        cacheWriteTokens: 0,
        cachedInputTokens: 9_984,
        inputTokens: 11_416,
        outputTokens: 700,
        reasoningTokens: 364,
      },
      nodes: [
        {
          cacheWriteTokens: 0,
          cachedInputTokens: 0,
          inputTokens: 6_400,
          outputTokens: 520,
          reasoningTokens: 300,
        },
      ],
    });
    const recorded = await recordedUsage(active, runId);
    const journey = await record(
      "stop during background",
      active,
      runId,
      usageRecord(frames, expected, recorded),
    );
    expectRecordedUsage(recorded, expected);
    expect(journey.run).toMatchObject({ status: "interrupted" });
    expect(journey.nodes).toMatchObject([{ status: "interrupted" }]);
    expect(await readFile(captureFile, "utf8")).toContain(
      '"childInterrupted":"codex-child-thread-1"',
    );
  });

  it(
    "stops background work at its deadline without holding the Thread",
    { timeout: 120_000 },
    async () => {
      const { active, runId, threadId } = await start();
      const run = await runRow(active, runId);
      expect(run.backgroundDeadlineAt).not.toBeNull();
      // The deadline was set once, when the Run first went to the background.
      await active.host.store.database
        .updateTable("runs")
        .set({ backgroundDeadlineAt: new Date(Date.now() - 1_000) })
        .where("id", "=", runId)
        .execute();
      await settled(active, runId);
      const journey = await record("deadline", active, runId);
      expect(journey.run).toMatchObject({ status: "interrupted" });
      expect(journey.nodes).toMatchObject([{ status: "interrupted" }]);
      const thread = await active.host.store.database
        .selectFrom("threads")
        .select("inputQueuePaused")
        .where("id", "=", threadId)
        .executeTakeFirstOrThrow();
      expect(thread.inputQueuePaused).toBe(false);
    },
  );

  it(
    "keeps a Claude Run live for its background subagent, through a wake-up that races idle",
    { timeout: 120_000 },
    async () => {
      const finish = Promise.withResolvers<void>();
      stack = await startVerticalStack({
        catalogTimeoutMs: 30_000,
        databaseUrl: databaseUrl!,
        harnessInstance: {
          config: {},
          driverKind: "claude",
          sourceId: "anthropic",
          stateKind: "isolated",
        },
        harnesses: () => {
          const registry = new HarnessRegistry();
          registry.registerDriver(
            new ClaudeHarnessDriver({
              executable: process.execPath,
              sdk: backgroundClaudeSdk(finish.promise),
            }),
          );
          return registry;
        },
        harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
        runTimeoutMs: 60_000,
      });
      const active = stack;
      const model = active.catalog.models[0]!;
      const threadId = await active.createThread({
        modelSelection: ModelSelectionSchema.parse({
          modelId: model.modelId,
          options: {},
          providerId: model.providerId,
        }),
        title: "Background journey",
        workspaceId: active.mainWorkspaceId,
      });
      const runId = (await active.queueMessage({ text: "Research in the background", threadId }))
        .runId!;
      await waitFor(async () => (await runRow(active, runId)).phase === "background", "background");

      const sent = await active.queueMessage({ text: "Also check the changelog", threadId });
      expect(sent.runId).toBe(runId);
      await waitFor(
        async () => (await assistantTexts(active, runId)).includes("Noted the changelog."),
        "the new turn's answer",
      );
      await waitFor(async () => (await runRow(active, runId)).phase === "background", "background");

      // The task finishes; its wake-up turn comes a second after the roster empties.
      finish.resolve();
      await settled(active, runId);
      const journey = await record("claude background and wake-up", active, runId);
      expect(journey.run).toMatchObject({ status: "completed" });
      expect(journey.messages).toEqual([
        "Started the research in the background.",
        "Noted the changelog.",
        "The background research is done.",
      ]);
      expect(journey.nodes).toMatchObject([
        {
          result: "Background research finished.",
          status: "completed",
          title: "Background research",
        },
      ]);
    },
  );

  it("keeps background work through a Host restart", { timeout: 180_000 }, async () => {
    let restartStage = "not requested";
    const within = <T>(operation: Promise<T>, label: string, timeoutMs = 10_000) =>
      withTimeout(operation, timeoutMs, {
        timeoutError: () =>
          new Error(
            `Timed out waiting for ${label} (restart stage: ${restartStage}; Host closing step: ${stack?.host.closingStep() ?? "none"})`,
          ),
      });
    const { active, release, runId } = await within(start(), "background stack startup", 30_000);
    try {
      const deadline = (await within(runRow(active, runId), "background deadline read"))
        .backgroundDeadlineAt;
      const oldHost = active.host;
      const close = oldHost.close.bind(oldHost);
      const stopped = vi.spyOn(oldHost, "close").mockImplementation(async () => {
        restartStage = "stop requested; joining old Host";
        await close();
        restartStage = "old Host joined";
      });
      try {
        restartStage = "stop requested";
        await within(
          active.restartHost({
            whileDown: async () => {
              expect(oldHost.closingStep()).toBeUndefined();
              restartStage = "binding replacement listener";
            },
          }),
          "Host restart",
        );
        restartStage = "replacement listener bound";
      } finally {
        stopped.mockRestore();
      }
      const environment = async () => {
        const result = await active.api["bootstrap.get"]({});
        if (!result.ok) throw new Error(result.error.message);
        return result.data.environments.find((entry) => entry.id === active.environmentId);
      };
      await within(
        waitFor(
          async () => (await environment())?.connected === true,
          "Runner reauthentication",
          10_000,
        ),
        "Runner reauthentication",
      );
      restartStage = "Runner reauthenticated";
      await within(
        waitFor(
          async () =>
            (await environment())?.harnessCatalogs.some(
              (catalog) =>
                catalog.harnessInstanceId === active.harnessInstanceId &&
                catalog.status === "ready",
            ) === true,
          "ready catalog visible",
          10_000,
        ),
        "ready catalog visible",
      );
      restartStage = "ready catalog visible";
      await within(
        waitFor(
          async () => (await runRow(active, runId)).phase === "background",
          "background projection restored",
          10_000,
        ),
        "background projection restored",
      );
      restartStage = "background projection restored";
      expect(
        (await within(runRow(active, runId), "restarted Run read")).backgroundDeadlineAt,
      ).toEqual(deadline);
      await within(release(), "background child release");
      await within(settled(active, runId), "released completion persisted");
      restartStage = "released completion persisted";
      const journey = await within(
        record("host restart", active, runId),
        "restart journey recording",
      );
      expect(journey.run).toMatchObject({ status: "completed" });
      expect(journey.nodes).toMatchObject([{ status: "completed" }]);
    } finally {
      // A failed restart must not leave the fake child waiting for the test
      // while teardown drains that same restart operation.
      await within(release(), "background child release during cleanup");
    }
  });
});

function consumedUuids(consumed: readonly unknown[]) {
  const uuids = consumed.flatMap((input) =>
    input && typeof input === "object" && "uuid" in input && typeof input.uuid === "string"
      ? [input.uuid]
      : [],
  );
  return uuids.length === 0 ? {} : { user_message_uuid: uuids.at(-1), user_message_uuids: uuids };
}

/**
 * A Claude Agent SDK whose turn starts a background subagent and answers;
 * a message steered in is a turn of its own; when `finished` settles the task
 * notifies, the roster empties, and a second later Claude wakes a turn.
 */
function backgroundClaudeSdk(finished: Promise<void>): ClaudeAgentSdk {
  return {
    inspectModels: async () => ({
      account: { email: "person@example.test", subscriptionType: "max" },
      models: [
        {
          description: "Test model",
          displayName: "Claude Test",
          resolvedModel: "claude-test-1",
          supportsEffort: false,
          value: "default",
        },
      ] as never,
    }),
    query: (parameters) => {
      const sessionId = parameters.options.resume ?? parameters.options.sessionId ?? "session";
      const message = (value: Record<string, unknown>) => ({
        session_id: sessionId,
        uuid: randomUUID(),
        ...value,
      });
      const init = () =>
        message({
          apiKeySource: "user",
          capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1"],
          claude_code_version: harnessMinimumVersion("claude"),
          cwd: "/workspace",
          fast_mode_state: "off",
          mcp_servers: [],
          model: "claude-test-1",
          output_style: "default",
          permissionMode: "default",
          plugins: [],
          skills: [],
          slash_commands: [],
          subtype: "init",
          tools: ["Bash", "Read", "Agent", "TaskStop"],
          type: "system",
        });
      const assistant = (content: unknown[]) =>
        message({
          message: {
            content,
            id: `msg_${randomUUID()}`,
            model: "claude-test-1",
            role: "assistant",
            stop_reason: "end_turn",
            stop_sequence: null,
            type: "message",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          parent_tool_use_id: null,
          type: "assistant",
        });
      // Like Claude, each result names the client messages its turn consumed.
      const result = (text: string, consumed: readonly unknown[] = []) =>
        message({
          ...consumedUuids(consumed),
          duration_api_ms: 5,
          duration_ms: 10,
          is_error: false,
          modelUsage: {},
          num_turns: 1,
          permission_denials: [],
          result: text,
          stop_reason: "end_turn",
          subtype: "success",
          total_cost_usd: 0,
          type: "result",
          usage: {},
        });
      const roster = (tasks: unknown[]) =>
        message({ subtype: "background_tasks_changed", tasks, type: "system" });
      const prompt = (parameters.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      const closed = new AbortController();
      async function* turn() {
        const opening = await prompt.next();
        yield init();
        yield assistant([
          {
            id: "agent-call-1",
            input: {
              description: "Background research",
              prompt: "Research in the background",
              run_in_background: true,
            },
            name: "Agent",
            type: "tool_use",
          },
        ]);
        yield message({
          description: "Background research",
          is_backgrounded: true,
          subtype: "task_started",
          task_id: "agent-1",
          task_type: "local_agent",
          tool_use_id: "agent-call-1",
          type: "system",
        });
        yield message({
          message: {
            content: [{ content: "Launched", tool_use_id: "agent-call-1", type: "tool_result" }],
            role: "user",
          },
          parent_tool_use_id: null,
          tool_use_result: { agentId: "agent-1", status: "async_launched" },
          type: "user",
        });
        yield roster([
          { description: "Background research", task_id: "agent-1", task_type: "local_agent" },
        ]);
        yield result("Started the research in the background.", [opening.value]);
        // A message steered in while the task works is a turn of its own.
        const steered = await prompt.next();
        yield init();
        yield result("Noted the changelog.", [steered.value]);
        await Promise.race([
          finished,
          new Promise((resolve) => closed.signal.addEventListener("abort", resolve)),
        ]);
        if (closed.signal.aborted) return;
        yield message({
          status: "completed",
          subtype: "task_notification",
          summary: "Background research finished.",
          task_id: "agent-1",
          tool_use_id: "agent-call-1",
          type: "system",
        });
        yield roster([]);
        await delay(1_000);
        yield init();
        yield result("The background research is done.");
      }
      const generator = turn();
      const handle: ClaudeQueryHandle = {
        [Symbol.asyncIterator]: () => generator as never,
        close: () => closed.abort(),
        interrupt: () => Promise.resolve(undefined),
      };
      return handle;
    },
  };
}

/**
 * The Thread as a client shows it in a conversation, folded from the Host's
 * events with the client's own model, as web, desktop and mobile do. With
 * `pageAfter`, only what follows the first event of that type is folded, as
 * a history page that begins after it would be.
 */
async function clientView(
  active: VerticalStack,
  threadId: ThreadId,
  runId: RunId,
  options: { readonly pageAfter?: string } = {},
) {
  const all = await active.host.store.database
    .selectFrom("workspaceEvents")
    .selectAll()
    .where("threadId", "=", threadId)
    .orderBy("sequence", "asc")
    .execute();
  const rows = options.pageAfter
    ? all.slice(all.findIndex((row) => row.type === options.pageAfter) + 1)
    : all;
  let entries: TranscriptEntry[] = [];
  for (const row of rows) {
    entries = foldTranscriptEvent(
      entries,
      AgentEventSchema.parse({
        createdAt: row.createdAt.toISOString(),
        data: row.data,
        environmentId: row.environmentId,
        eventId: row.eventId,
        runId: row.runId,
        sequence: String(row.sequence),
        threadId: row.threadId,
        type: row.type,
        workspaceId: row.workspaceId,
      }),
    );
  }
  const groups = groupTranscriptEntries(entries);
  const turns = groups.flatMap((group) =>
    group.kind === "turn" ? [conversationTurn(group.turn)] : [],
  );
  // Each subagent's steps, as the turn that holds the subagent shows them.
  const subagentSteps = groups.flatMap((group) =>
    group.kind === "turn" ? Object.values(group.turn.subagentWork).map((work) => work.length) : [],
  );
  const run = await runRow(active, runId);
  const thread = await active.host.store.database
    .selectFrom("threads")
    .select("status")
    .where("id", "=", threadId)
    .executeTakeFirstOrThrow();
  const activity = threadActivity({
    entries,
    runQueue: ["completed", "failed", "interrupted"].includes(run.status)
      ? []
      : [
          {
            createdAt: new Date().toISOString(),
            id: runId,
            runOrdinal: 0,
            status: "running",
            threadId,
          },
        ],
    thread: { id: threadId, status: thread.status },
  });
  return {
    activity,
    composing: turns.some((turn) => turn.composing),
    indicator: threadActivityIndicator(activity, { conversation: true, groups }),
    readThrough: observedSequence(entries, true),
    replies: turns.flatMap((turn) => (turn.reply ? [turn.reply.body] : [])),
    subagentSteps,
    replySequences: turns.flatMap((turn) => (turn.reply?.sequence ? [turn.reply.sequence] : [])),
  };
}

async function settled(active: VerticalStack, runId: RunId) {
  await waitFor(
    async () =>
      ["completed", "failed", "interrupted"].includes((await runRow(active, runId)).status),
    "the Run to end",
    60_000,
  );
}

function runRow(active: VerticalStack, runId: RunId) {
  return active.host.store.database
    .selectFrom("runs")
    .select(["backgroundDeadlineAt", "phase", "status"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
}

async function assistantTexts(active: VerticalStack, runId: RunId): Promise<string[]> {
  const rows = await active.host.store.database
    .selectFrom("messages")
    .select("content")
    .where("runId", "=", runId)
    .where("kind", "=", "assistant")
    .execute();
  return rows.map((row) => textOf(row.content));
}

async function eventTypes(active: VerticalStack, runId: RunId): Promise<string[]> {
  const rows = await active.host.store.database
    .selectFrom("workspaceEvents")
    .select("type")
    .where("runId", "=", runId)
    .orderBy("sequence", "asc")
    .execute();
  return rows.map((row) => row.type);
}

function textOf(content: unknown): string {
  return (content as readonly { readonly text?: string; readonly type: string }[])
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("");
}
