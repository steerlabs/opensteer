import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  harnessMinimumVersion,
  ModelSelectionSchema,
  type RunId,
  type ThreadId,
} from "@opensteer/core";
import {
  HarnessRegistry,
  isolatedServiceHarnessRuntimeBoundary,
  nativeUserHarnessRuntimeBoundary,
} from "@opensteer/harness";
import {
  ClaudeHarnessDriver,
  type ClaudeAgentSdk,
  type ClaudeQueryHandle,
} from "@opensteer/harness-claude";
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
  type UsageRecord,
} from "./codex-usage.test-support.js";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";

/*
 * An engine's native subagents are execution nodes of the Run that started
 * them: their tools and questions name them, their text is their result rather
 * than a message of the Thread, and a resumed child is a new node of the same
 * child session. Each journey drives the real Host, Runner and engine driver
 * against a fake engine that spawns a researcher subagent.
 *
 * The artifact records each journey's nodes as `run.attempts.list` serves
 * them, the Requests they asked, and the Run's stored event types; for a
 * Codex journey whose engine stated token usage, each statement and what the
 * Run and its nodes recorded against what they should have.
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
const codexSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});

interface Journey {
  readonly engine: string;
  readonly events: readonly string[];
  readonly name: string;
  readonly nodes: readonly unknown[];
  readonly requests: readonly unknown[];
  readonly runStatus: string;
  readonly usage?: UsageRecord;
}

integration("Execution nodes", () => {
  let stack: VerticalStack | undefined;
  const journeys: Journey[] = [];

  afterEach(async () => {
    await stack?.close();
    stack = undefined;
  });

  afterAll(async () => {
    const directory = await mkdtemp(join(tmpdir(), "opensteer-execution-nodes-"));
    const artifact = join(directory, "nodes.json");
    await writeFile(artifact, JSON.stringify(journeys, null, 2) + "\n");
    console.info(`Execution nodes artifact: ${artifact}`);
  });

  async function startCodex(scenario: string, engineArguments: readonly string[] = []) {
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-nodes-codex-"));
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
                `--scenario=${scenario}`,
                "--unique-threads",
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
      title: "Subagent journey",
      workspaceId: stack.mainWorkspaceId,
    });
    await stack.updateThreadAccess(threadId, "approval-required");
    return { active: stack, captureFile, threadId };
  }

  async function record(
    name: string,
    engine: string,
    active: VerticalStack,
    runId: RunId,
    usage?: UsageRecord,
  ): Promise<Journey> {
    const listed = await active.api["run.attempts.list"]({ runId });
    if (!listed.ok) throw new Error(listed.error.message);
    const database = active.host.store.database;
    const journey: Journey = {
      engine,
      events: await eventTypes(active, runId),
      name,
      nodes: listed.data.nodes,
      requests: await database
        .selectFrom("requests")
        .select(["callId", "originatingNodeId", "status"])
        .where("originatingRunId", "=", runId)
        .execute(),
      runStatus: (await runRow(active, runId)).status,
      ...(usage ? { usage } : {}),
    };
    journeys.push(journey);
    return journey;
  }

  it(
    "attributes a subagent's steps and question to it, and a resumed child is a new node",
    { timeout: 120_000 },
    async () => {
      const { active, captureFile, threadId } = await startCodex("subagents", ["--token-usage"]);
      const runId = await queue(active, threadId, "Research the release notes");

      const request = await pendingRequest(active, runId);
      expect(request.originatingNodeId).not.toBeNull();
      await answer(active, request);
      await settled(active, runId);

      // The root's two responses and each invocation's own; the child thread's
      // running total carries from its first invocation into its second.
      const frames = await codexUsageFrames(captureFile);
      const expected = expectedUsage(frames, await codexThreadOf(active, threadId));
      expect(expected).toEqual({
        attempt: {
          cacheWriteTokens: 0,
          cachedInputTokens: 34_560,
          inputTokens: 15_890,
          outputTokens: 843,
          reasoningTokens: 339,
        },
        nodes: [
          {
            cacheWriteTokens: 0,
            cachedInputTokens: 7_936,
            inputTokens: 8_714,
            outputTokens: 505,
            reasoningTokens: 190,
          },
          {
            cacheWriteTokens: 0,
            cachedInputTokens: 8_448,
            inputTokens: 652,
            outputTokens: 37,
            reasoningTokens: 12,
          },
        ],
      });
      const recorded = await recordedUsage(active, runId);
      const journey = await record(
        "subagent and resume",
        "codex",
        active,
        runId,
        usageRecord(frames, expected, recorded),
      );
      expectRecordedUsage(recorded, expected);
      expect(journey.runStatus).toBe("completed");
      expect(journey.nodes).toMatchObject([
        {
          kind: "subagent",
          parentNodeId: null,
          prompt: "Look up the release notes",
          result: "The release notes say v2 ships Friday.",
          status: "completed",
          title: "researcher",
        },
        { result: "Confirmed: Friday.", status: "completed", title: "researcher" },
      ]);
      const nodes = await nodeRows(active, runId);
      // Two invocations of one child session.
      expect(nodes[0]!.sessionRef).toBe(nodes[1]!.sessionRef);
      expect(nodes[0]!.nativeRef).not.toBe(nodes[1]!.nativeRef);
      expect(journey.requests).toEqual([
        { callId: "child-command-1", originatingNodeId: nodes[0]!.id, status: "fulfilled" },
      ]);
      // The child's command is its step, not the Run's own.
      const childTool = await active.host.store.database
        .selectFrom("workspaceEvents")
        .select("data")
        .where("runId", "=", runId)
        .where("type", "=", "tool.started")
        .executeTakeFirstOrThrow();
      expect(childTool.data).toMatchObject({ callId: "child-command-1", nodeId: nodes[0]!.id });
      // The child's words are its result; the Run's reply is the root agent's.
      const replies = await active.host.store.database
        .selectFrom("messages")
        .select("content")
        .where("runId", "=", runId)
        .where("kind", "=", "assistant")
        .execute();
      expect(replies.map((reply) => JSON.stringify(reply.content))).toEqual([
        JSON.stringify([{ text: "The researcher confirmed Friday.", type: "text" }]),
      ]);
    },
  );

  it(
    "keeps a question a subagent asks before the engine reports it on that subagent",
    { timeout: 120_000 },
    async () => {
      const { active, threadId } = await startCodex("subagents-early-approval");
      const runId = await queue(active, threadId, "Research the release notes");

      const request = await pendingRequest(active, runId);
      await answer(active, request);
      await settled(active, runId);

      const journey = await record("question before discovery", "codex", active, runId);
      expect(journey.runStatus).toBe("completed");
      const nodes = await nodeRows(active, runId);
      // The question opened the node; the spawn report named it afterwards.
      expect(nodes[0]).toMatchObject({ id: request.originatingNodeId, title: "researcher" });
      expect(journey.events.indexOf("node.started")).toBeLessThan(
        journey.events.indexOf("request.opened"),
      );
      expect(journey.events).toContain("node.updated");
    },
  );

  async function startClaude(script: ClaudeScript) {
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
          new ClaudeHarnessDriver({ executable: process.execPath, sdk: fakeClaudeSdk(script) }),
        );
        return registry;
      },
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      runTimeoutMs: 60_000,
    });
    const model = stack.catalog.models[0]!;
    const threadId = await stack.createThread({
      modelSelection: ModelSelectionSchema.parse({
        modelId: model.modelId,
        options: {},
        providerId: model.providerId,
      }),
      title: "Subagent journey",
      workspaceId: stack.mainWorkspaceId,
    });
    await stack.updateThreadAccess(threadId, "approval-required");
    return { active: stack, threadId };
  }

  it.each(["task-first", "question-first"] as const)(
    "attributes a Claude subagent's steps and question to it (%s)",
    { timeout: 120_000 },
    async (order) => {
      const { active, threadId } = await startClaude(order);
      const runId = await queue(active, threadId, "Research the release notes");

      const request = await pendingRequest(active, runId);
      expect(request.originatingNodeId).not.toBeNull();
      await answer(active, request);
      await settled(active, runId);

      const journey = await record(`claude subagent, ${order}`, "claude", active, runId);
      expect(journey.runStatus).toBe("completed");
      expect(journey.nodes).toMatchObject([
        {
          model: "claude-haiku-4-5",
          prompt: "Look up the release notes",
          result: "The release notes say v2 ships Friday.",
          status: "completed",
          title: "Research release notes",
        },
      ]);
      const nodes = await nodeRows(active, runId);
      expect(nodes[0]).toMatchObject({
        id: request.originatingNodeId,
        originCallId: "agent-call-1",
      });
      const childTool = await active.host.store.database
        .selectFrom("workspaceEvents")
        .select("data")
        .where("runId", "=", runId)
        .where("type", "=", "tool.started")
        .execute();
      expect(childTool.map((row) => row.data)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ callId: "agent-call-1" }),
          expect.objectContaining({ callId: "child-bash-1", nodeId: nodes[0]!.id }),
        ]),
      );
    },
  );

  it("stops a running Claude subagent with its Run", { timeout: 120_000 }, async () => {
    const { active, threadId } = await startClaude("hold");
    const runId = await queue(active, threadId, "Research the release notes");
    await waitFor(async () => (await nodeRows(active, runId)).length === 1, "the subagent");

    await active.interruptRun(threadId, runId);
    await settled(active, runId);

    const journey = await record("claude parent stop", "claude", active, runId);
    expect(journey.runStatus).toBe("interrupted");
    expect(journey.nodes).toMatchObject([{ status: "interrupted" }]);
  });

  async function startOpencode(scenario: string) {
    stack = await startVerticalStack({
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
      harnessInstance: {
        config: {},
        driverKind: "opencode",
        sourceId: "opencode",
        stateKind: "isolated",
      },
      harnesses: () => {
        const registry = new HarnessRegistry();
        registry.registerDriver(
          new OpencodeHarnessDriver({
            arguments: [fakeOpencodeServer, `--scenario=${scenario}`],
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
      title: "Subagent journey",
      workspaceId: stack.mainWorkspaceId,
    });
    await stack.updateThreadAccess(threadId, "approval-required");
    return { active: stack, threadId };
  }

  it.each(["subagents", "subagents-early-ask", "subagents-resume-early"] as const)(
    "attributes an OpenCode subagent's steps and question to it, and a resumed session is a new node (%s)",
    { timeout: 120_000 },
    async (scenario) => {
      const { active, threadId } = await startOpencode(scenario);
      const runId = await queue(active, threadId, "Research the release notes");

      const request = await pendingRequest(active, runId);
      expect(request.originatingNodeId).not.toBeNull();
      await answer(active, request);
      await settled(active, runId);

      const journey = await record(`opencode ${scenario}`, "opencode", active, runId);
      expect(journey.runStatus).toBe("completed");
      expect(journey.nodes).toMatchObject([
        {
          model: "opencode/union-alpha",
          prompt: "Look up the release notes",
          result: "The release notes say v2 ships Friday.",
          status: "completed",
          title: "Research release notes",
          usage: { inputTokens: 20, outputTokens: 5 },
        },
        { result: "Confirmed: Friday.", status: "completed", title: "Research release notes" },
      ]);
      const nodes = await nodeRows(active, runId);
      expect(nodes[0]!.sessionRef).toBe(nodes[1]!.sessionRef);
      expect(nodes[0]).toMatchObject({
        id: request.originatingNodeId,
        originCallId: "call_task_1",
      });
      // The resumed invocation is one node, named by the call that resumed it.
      expect(nodes[1]).toMatchObject({ originCallId: "call_task_2" });
      // The subagents' model calls are the Run's too.
      const run = await active.host.store.database
        .selectFrom("runs")
        .select(["inputTokens", "outputTokens"])
        .where("id", "=", runId)
        .executeTakeFirstOrThrow();
      expect(Number(run.inputTokens)).toBe(20 + 20 + 30);
      const replies = await active.host.store.database
        .selectFrom("messages")
        .select("content")
        .where("runId", "=", runId)
        .where("kind", "=", "assistant")
        .execute();
      expect(replies.map((reply) => JSON.stringify(reply.content))).toEqual([
        JSON.stringify([{ text: "The researcher confirmed Friday.", type: "text" }]),
      ]);
    },
  );

  it("stops a running OpenCode subagent with its Run", { timeout: 120_000 }, async () => {
    const { active, threadId } = await startOpencode("subagents-hold");
    const runId = await queue(active, threadId, "Research the release notes");
    await waitFor(async () => (await nodeRows(active, runId)).length === 1, "the subagent");

    await active.interruptRun(threadId, runId);
    await settled(active, runId);

    const journey = await record("opencode parent stop", "opencode", active, runId);
    expect(journey.runStatus).toBe("interrupted");
    expect(journey.nodes).toMatchObject([{ status: "interrupted" }]);
  });

  it("stops a running subagent with its Run", { timeout: 120_000 }, async () => {
    const { active, captureFile, threadId } = await startCodex("subagents-hold", ["--token-usage"]);
    const runId = await queue(active, threadId, "Research the release notes");
    await waitFor(async () => (await nodeRows(active, runId)).length === 1, "the subagent");
    await waitFor(
      async () => (await codexUsageFrames(captureFile)).length === 2,
      "the child's first response",
    );

    await active.interruptRun(threadId, runId);
    await settled(active, runId);

    // What the stopped Run and its stopped subagent consumed before they ended.
    const frames = await codexUsageFrames(captureFile);
    const expected = expectedUsage(frames, await codexThreadOf(active, threadId));
    expect(expected).toEqual({
      attempt: {
        cacheWriteTokens: 0,
        cachedInputTokens: 6_144,
        inputTokens: 13_856,
        outputTokens: 650,
        reasoningTokens: 318,
      },
      nodes: [
        {
          cacheWriteTokens: 0,
          cachedInputTokens: 0,
          inputTokens: 8_000,
          outputTokens: 410,
          reasoningTokens: 190,
        },
      ],
    });
    const recorded = await recordedUsage(active, runId);
    const journey = await record(
      "parent stop",
      "codex",
      active,
      runId,
      usageRecord(frames, expected, recorded),
    );
    expectRecordedUsage(recorded, expected);
    expect(journey.runStatus).toBe("interrupted");
    expect(journey.nodes).toMatchObject([{ status: "interrupted", title: "researcher" }]);
    // Codex stops only the thread it is asked to; the driver asked the child too.
    const capture = await readFile(captureFile, "utf8");
    expect(capture).toContain('"childInterrupted":"codex-child-thread-1"');
  });
});

/**
 * How the fake Claude SDK's subagent turn goes: the task report before the
 * subagent's question, the question first, or a subagent that works until the
 * Run is stopped.
 */
type ClaudeScript = "hold" | "question-first" | "task-first";

/**
 * A Claude Agent SDK that runs one scripted turn: the root agent calls Agent,
 * the subagent runs a command it must ask about, and its result returns.
 */
function fakeClaudeSdk(script: ClaudeScript): ClaudeAgentSdk {
  return {
    inspectModels: async () => ({
      account: { email: "person@example.test", subscriptionType: "max" },
      models: [
        {
          description: "Test model",
          displayName: "Claude Test",
          supportsEffort: false,
          value: "default",
          resolvedModel: "claude-test-1",
        },
      ] as never,
    }),
    query: (parameters) => {
      const sessionId = parameters.options.resume ?? parameters.options.sessionId ?? "session";
      const canUseTool = parameters.options.canUseTool!;
      const message = (value: Record<string, unknown>) => ({
        session_id: sessionId,
        uuid: randomUUID(),
        ...value,
      });
      const assistant = (parentToolUseId: string | null, content: unknown[]) =>
        message({
          message: {
            content,
            id: `msg_${randomUUID()}`,
            model: "claude-test-1",
            role: "assistant",
            stop_reason: "tool_use",
            stop_sequence: null,
            type: "message",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          parent_tool_use_id: parentToolUseId,
          type: "assistant",
        });
      const user = (
        parentToolUseId: string | null,
        content: unknown[],
        extra: Record<string, unknown> = {},
      ) =>
        message({
          message: { content, role: "user" },
          parent_tool_use_id: parentToolUseId,
          type: "user",
          ...extra,
        });
      const taskStarted = message({
        description: "Research release notes",
        subagent_type: "general-purpose",
        subtype: "task_started",
        task_id: "agent-1",
        tool_use_id: "agent-call-1",
        type: "system",
      });
      const abort = new AbortController();
      const ask = () =>
        canUseTool(
          "Bash",
          { command: "cat NOTES.md" },
          {
            agentID: "agent-1",
            requestId: "permission-1",
            signal: abort.signal,
            toolUseID: "child-bash-1",
          },
        );
      async function* turn() {
        yield message({
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
          tools: ["AskUserQuestion", "Bash", "Edit", "Read", "Agent"],
          type: "system",
        });
        yield assistant(null, [
          {
            id: "agent-call-1",
            input: {
              description: "Research release notes",
              prompt: "Look up the release notes",
              subagent_type: "general-purpose",
            },
            name: "Agent",
            type: "tool_use",
          },
        ]);
        // The subagent's question can overtake the report that names it.
        const decision = script === "question-first" ? ask() : undefined;
        yield taskStarted;
        yield assistant("agent-call-1", [
          {
            id: "child-bash-1",
            input: { command: "cat NOTES.md" },
            name: "Bash",
            type: "tool_use",
          },
        ]);
        if (script === "hold") {
          await new Promise<void>((resolve) =>
            abort.signal.addEventListener("abort", () => resolve()),
          );
          return;
        }
        await (decision ?? ask());
        yield user("agent-call-1", [
          { content: "v2 ships Friday", tool_use_id: "child-bash-1", type: "tool_result" },
        ]);
        const answer = "The release notes say v2 ships Friday.";
        yield user(
          null,
          [
            {
              content: [{ text: answer, type: "text" }],
              tool_use_id: "agent-call-1",
              type: "tool_result",
            },
          ],
          {
            tool_use_result: {
              agentId: "agent-1",
              content: [{ text: answer, type: "text" }],
              resolvedModel: "claude-haiku-4-5",
              status: "completed",
            },
          },
        );
        yield message({
          duration_api_ms: 5,
          duration_ms: 10,
          is_error: false,
          modelUsage: {},
          num_turns: 1,
          permission_denials: [],
          result: "The researcher found that v2 ships Friday.",
          stop_reason: "end_turn",
          subtype: "success",
          total_cost_usd: 0,
          type: "result",
          usage: {},
        });
      }
      const generator = turn();
      const handle: ClaudeQueryHandle = {
        [Symbol.asyncIterator]: () => generator as never,
        close: () => abort.abort(),
        interrupt: () => Promise.resolve(undefined),
      };
      return handle;
    },
  };
}

async function queue(active: VerticalStack, threadId: ThreadId, text: string): Promise<RunId> {
  const queued = await active.queueMessage({ text, threadId });
  if (!queued.runId) throw new Error("The message did not start a Run");
  return queued.runId;
}

async function pendingRequest(active: VerticalStack, runId: RunId) {
  let found:
    | {
        readonly id: string;
        readonly originatingNodeId: string | null;
        readonly presentation: unknown;
      }
    | undefined;
  await waitFor(async () => {
    found = await active.host.store.database
      .selectFrom("requests")
      .select(["id", "originatingNodeId", "presentation"])
      .where("originatingRunId", "=", runId)
      .where("status", "=", "pending")
      .executeTakeFirst();
    return found !== undefined;
  }, "a pending Request");
  return found!;
}

/** Answers as any client does, through the Host's command API. */
async function answer(
  active: VerticalStack,
  request: { readonly id: string; readonly presentation: unknown },
) {
  const options = (
    request.presentation as { readonly options: readonly { hint?: string; id: string }[] }
  ).options;
  const allow = options.find((option) => option.hint !== "reject-once")!;
  const key = `respond-${randomUUID()}`;
  await testRpcData(
    active.hostOrigin,
    "commands.dispatch",
    {
      idempotencyKey: key,
      requestId: request.id,
      response: { kind: "choice", optionId: allow.id },
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
    const state = {
      events: await eventTypes(active, runId),
      requests: await active.host.store.database
        .selectFrom("requests")
        .select(["status", "originatingNodeId"])
        .where("originatingRunId", "=", runId)
        .execute(),
      run: await runRow(active, runId),
    };
    throw new Error(`${String(error)}\n${JSON.stringify(state)}`);
  });
}

async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function runRow(active: VerticalStack, runId: RunId) {
  return active.host.store.database
    .selectFrom("runs")
    .select("status")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
}

function nodeRows(active: VerticalStack, runId: RunId) {
  return active.host.store.database
    .selectFrom("executionNodes")
    .selectAll()
    .where("runId", "=", runId)
    .orderBy("startedAt", "asc")
    .execute();
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
