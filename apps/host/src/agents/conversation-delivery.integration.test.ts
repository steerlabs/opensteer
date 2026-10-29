import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  ModelSelectionSchema,
  RequestPresentationSchema,
  type MessageId,
  type RunId,
  type ThreadId,
} from "@opensteer/core";
import {
  HarnessRegistry,
  isolatedServiceHarnessRuntimeBoundary,
  nativeUserHarnessRuntimeBoundary,
} from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import { OpencodeHarnessDriver } from "@opensteer/harness-opencode";
import { visibleTranscript, type TranscriptEntry } from "@opensteer/client/host";
import type { ThreadInputQueue } from "@opensteer/core";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";

/*
 * A person's message in their Chat contributes to the reply under way. Each
 * journey drives the real Host, dispatcher and Runner over its WebSocket
 * against a scripted engine: a Codex app server whose `[hold]` turns work
 * until the person's next message reaches them and whose other turns answer
 * naming every message they were started with, and an OpenCode server that
 * can only restart. The artifact records each journey's inputs, commands,
 * Runs, attempts and replies.
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
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});

interface Journey {
  readonly name: string;
  readonly [fact: string]: unknown;
}

integration("conversation delivery across Host and Runner", () => {
  let stack: VerticalStack | undefined;
  let captureRoot: string | undefined;
  const journeys: Journey[] = [];

  afterEach(async () => {
    await stack?.close();
    stack = undefined;
    if (captureRoot) await rm(captureRoot, { force: true, recursive: true });
    captureRoot = undefined;
  }, 60_000);

  afterAll(async () => {
    const directory =
      process.env.OPENSTEER_CONVERSATION_DELIVERY_OUTPUT ??
      join(tmpdir(), "opensteer-conversation-delivery", randomUUID());
    await mkdir(directory, { recursive: true });
    const artifact = join(directory, "vertical-journeys.json");
    await writeFile(artifact, JSON.stringify(journeys, null, 2) + "\n");
    console.info(`Conversation delivery journeys: ${artifact}`);
  });

  async function codexStack() {
    captureRoot = await mkdtemp(join(tmpdir(), "opensteer-conversation-codex-"));
    const capturePath = join(captureRoot, "codex.jsonl");
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
                "--scenario=conversation",
                `--capture=${capturePath}`,
                "--unique-threads",
                "--unique-turns",
              ],
              executable: process.execPath,
            },
          }),
        );
        return registry;
      },
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      runTimeoutMs: 30_000,
    });
    return stack;
  }

  async function chat(active: VerticalStack): Promise<ThreadId> {
    return active.createThread({
      home: true,
      modelSelection,
      title: "Chat",
      workspaceId: active.mainWorkspaceId,
    });
  }

  it("joins a person's Chat message into the reply under way and answers both in one Run", async () => {
    const active = await codexStack();
    const threadId = await chat(active);
    const first = await active.queueMessage({ text: "[hold] Plan the trip", threadId });
    const runId = await running(active, first.runId);
    const follow = await active.queueMessage({ text: "Also book the hotel", threadId });
    expect(follow.runId).toBe(runId);
    await settled(active, runId);
    const journey = await record("chat-join", active, threadId, runId);
    expect(journey.runStatus).toBe("completed");
    expect(journey.reply).toContain("Also book the hotel");
    expect(await inputState(active, follow.messageId)).toMatchObject({ runId, state: "delivered" });
    expect(journey.runs).toHaveLength(1);
  }, 90_000);

  it("keeps a work Thread's message in its queue until the person steers it", async () => {
    const active = await codexStack();
    const threadId = await active.createThread({
      modelSelection,
      title: "Task",
      workspaceId: active.mainWorkspaceId,
    });
    const first = await active.queueMessage({ text: "[hold] Audit the deploy", threadId });
    const runId = await running(active, first.runId);
    const queued = await active.queueMessage({ text: "Also check the logs", threadId });
    expect(queued.runId).toBeNull();
    const view = await active.api["thread.inputQueue.get"]({ threadId });
    if (!view.ok) throw new Error(view.error.message);
    expect(view.data.items.map(({ canSteer, message }) => [message.id, canSteer])).toEqual([
      [queued.messageId, true],
    ]);
    const steered = await active.api["commands.dispatch"]({
      expectedRunId: runId,
      idempotencyKey: `steer-${randomUUID()}`,
      messageId: queued.messageId,
      threadId,
      type: "thread.input.steer",
    });
    expect(steered.ok).toBe(true);
    await settled(active, runId);
    const journey = await record("work-queue-steer", active, threadId, runId);
    expect(journey.reply).toContain("Also check the logs");
    expect(journey.runs).toHaveLength(1);
  }, 90_000);

  it("gives what the person sends before the reply can start to its first turn", async () => {
    const active = await codexStack();
    // The Runner takes one Run at a time and is busy with a task.
    const task = await active.createThread({
      modelSelection,
      title: "Busy task",
      workspaceId: active.mainWorkspaceId,
    });
    const busy = await active.queueMessage({ text: "[hold] Long task", threadId: task });
    const busyRunId = await running(active, busy.runId);
    const threadId = await chat(active);
    const a = await active.queueMessage({ text: "Find a flight", threadId });
    const b = await active.queueMessage({ text: "Aisle seat", threadId });
    const c = await active.queueMessage({ text: "Under 400 dollars", threadId });
    if (!a.runId) throw new Error("The first message did not start a reply");
    expect([b.runId, c.runId]).toEqual([null, null]);
    expect((await runStatus(active, a.runId)).status).toBe("queued");
    await active.interruptRun(task, busyRunId);
    await settled(active, a.runId);
    const journey = await record("burst-first-turn", active, threadId, a.runId);
    // One turn: the engine answered once, naming everything it started with.
    expect(journey.reply).toMatch(/^Answered \d+:/u);
    for (const text of ["Find a flight", "Aisle seat", "Under 400 dollars"])
      expect(journey.reply).toContain(text);
    for (const sent of [a, b, c])
      expect(await inputState(active, sent.messageId)).toMatchObject({
        runId: a.runId,
        state: "delivered",
      });
    expect(journey.runs).toHaveLength(1);
  }, 90_000);

  it("hands a message written during an approval to the reply once the person answers it", async () => {
    const active = await codexStack();
    const threadId = await chat(active);
    const first = await active.queueMessage({ text: "[approve] Run the tests", threadId });
    const runId = first.runId;
    if (!runId) throw new Error("The message did not start a reply");
    await waitFor(
      async () => (await runStatus(active, runId)).status === "waiting",
      "the approval",
    );
    const follow = await active.queueMessage({ text: "Then summarize the failures", threadId });
    expect(follow.runId).toBeNull();
    expect(await inputState(active, follow.messageId)).toMatchObject({ state: "pending" });
    const request = await active.host.store.database
      .selectFrom("requests")
      .select(["id", "presentation", "status"])
      .where("originatingRunId", "=", runId)
      .executeTakeFirstOrThrow();
    // Sending never answered it.
    expect(request.status).toBe("pending");
    const presentation = RequestPresentationSchema.parse(request.presentation);
    if (presentation.kind !== "choice") throw new Error("Expected an approval");
    const allow = presentation.options.find(
      (option) => option.hint !== "reject-once" && option.hint !== "cancel",
    );
    if (!allow) throw new Error("The approval offers no way to allow it");
    const answered = await active.api["commands.dispatch"]({
      idempotencyKey: `answer-${randomUUID()}`,
      requestId: request.id,
      response: { kind: "choice", optionId: allow.id },
      type: "request.respond",
    });
    expect(answered.ok).toBe(true);
    await settled(active, runId);
    const journey = await record("approval-then-follow-up", active, threadId, runId);
    expect(journey.reply).toContain("Then summarize the failures");
    expect(await inputState(active, follow.messageId)).toMatchObject({ runId, state: "delivered" });
    expect(journey.runs).toHaveLength(1);
  }, 90_000);

  it("stops Chat's reply without pausing it, ends the follow-up it had not taken, and answers the next message", async () => {
    const active = await codexStack();
    const threadId = await chat(active);
    const first = await active.queueMessage({ text: "[hold] Write the report", threadId });
    const runId = await running(active, first.runId);
    // The Runner is out of reach: the follow-up is handed to the Run but not
    // yet sent to the Runner when the person presses Stop.
    active.network.block();
    const follow = await active.queueMessage({ text: "Make it shorter", threadId });
    expect(follow.runId).toBe(runId);
    await active.interruptRun(threadId, runId);
    expect(await inputState(active, follow.messageId)).toMatchObject({
      cancelReason: "stopped",
      state: "cancelled",
    });
    const thread = await active.host.store.database
      .selectFrom("threads")
      .select("inputQueuePaused")
      .where("id", "=", threadId)
      .executeTakeFirstOrThrow();
    expect(thread.inputQueuePaused).toBe(false);
    active.network.unblock();
    await settled(active, runId);
    expect((await runStatus(active, runId)).status).toBe("interrupted");
    const next = await active.queueMessage({ text: "New question", threadId });
    if (!next.runId) throw new Error("The next message did not start a reply");
    await settled(active, next.runId);
    const journey = await record("stop-then-send", active, threadId, next.runId);
    expect(journey.reply).toMatch(/^Answered \d+:/u);
    expect(journey.reply).toContain("New question");
    expect(journey.reply).not.toContain("Make it shorter");
    expect(journey.runs).toHaveLength(2);
  }, 120_000);

  it("orders two devices' messages into one reply by when the Host took them", async () => {
    const active = await codexStack();
    const threadId = await chat(active);
    const first = await active.queueMessage({ text: "[hold] Plan the week", threadId });
    const runId = await running(active, first.runId);
    const [phone, laptop] = await Promise.all([
      active.queueMessage({ text: "[hold] From the phone", threadId }),
      active.queueMessage({ text: "[hold] From the laptop", threadId }),
    ]);
    expect([phone.runId, laptop.runId]).toEqual([runId, runId]);
    await waitFor(
      async () =>
        (await inputState(active, phone.messageId)).state === "delivered" &&
        (await inputState(active, laptop.messageId)).state === "delivered",
      "both messages to reach the reply",
    );
    const last = await active.queueMessage({ text: "Wrap up", threadId });
    expect(last.runId).toBe(runId);
    await settled(active, runId);
    const journey = await record("two-devices", active, threadId, runId);
    const order = await active.host.store.database
      .selectFrom("messages")
      .select("id")
      .where("id", "in", [phone.messageId, laptop.messageId])
      .orderBy("sequence", "asc")
      .execute();
    const [earlier, later] = order.map(({ id }) =>
      id === phone.messageId ? "From the phone" : "From the laptop",
    );
    expect(journey.reply).toMatch(/^Handled 3:/u);
    const reply = String(journey.reply);
    expect(reply.indexOf(earlier!)).toBeLessThan(reply.indexOf(later!));
    expect(reply.indexOf(later!)).toBeLessThan(reply.indexOf("Wrap up"));
    expect(journey.runs).toHaveLength(1);
  }, 90_000);

  it("keeps a person's message where they sent it as the shared client draws Chat", async () => {
    const active = await codexStack();
    const threadId = await chat(active);
    const client = await sessionClient(active);
    const frames: string[][] = [];
    const record = () => {
      const snapshot = client.getSnapshot();
      const visible = visibleTranscript(
        snapshot.transcripts[threadId] ?? [],
        snapshot.inputQueues[threadId] ?? null,
        { conversation: true },
      )
        .filter((entry) => entry.kind === "message")
        .map((entry) => entry.id);
      const last = frames.at(-1);
      if (!last || last.join() !== visible.join()) frames.push(visible);
    };
    const unsubscribe = client.subscribe(record);
    try {
      await client.load();
      await vi.waitFor(() => expect(client.getSnapshot().connection).toBe("connected"), {
        timeout: 15_000,
      });
      client.activateWorkspace(active.mainWorkspaceId);
      client.activateThread(threadId);
      const send = async (text: string) => {
        const sent = await client.dispatch({
          content: [{ text, type: "text" }],
          idempotencyKey: `client-send-${randomUUID()}`,
          threadId,
          type: "thread.sendMessage",
        });
        if (sent.type !== "thread.sendMessage") throw new Error("Unexpected send answer");
        return sent.message.id as MessageId;
      };
      // Joins a reply under way.
      const first = await send("[hold] Plan the trip");
      const firstRun = await waitForRunOf(active, first);
      await running(active, firstRun);
      const joined = await send("Also book the hotel");
      await settled(active, firstRun);
      // Waits behind an approval, then joins once the person answers it.
      const approval = await send("[approve] Run the tests");
      const approvalRun = await waitForRunOf(active, approval);
      await waitFor(
        async () => (await runStatus(active, approvalRun)).status === "waiting",
        "the approval",
      );
      const waiting = await send("Then summarize the failures");
      await vi.waitFor(() => expect(frames.at(-1)?.at(-1)).toBe(waiting), { timeout: 10_000 });
      const request = await active.host.store.database
        .selectFrom("requests")
        .select(["id", "presentation"])
        .where("originatingRunId", "=", approvalRun)
        .executeTakeFirstOrThrow();
      const presentation = RequestPresentationSchema.parse(request.presentation);
      if (presentation.kind !== "choice") throw new Error("Expected an approval");
      const allow = presentation.options.find(
        (option) => option.hint !== "reject-once" && option.hint !== "cancel",
      )!;
      await active.api["commands.dispatch"]({
        idempotencyKey: `answer-${randomUUID()}`,
        requestId: request.id,
        response: { kind: "choice", optionId: allow.id },
        type: "request.respond",
      });
      await settled(active, approvalRun);
      await vi.waitFor(
        async () => {
          const answers = await active.host.store.database
            .selectFrom("messages")
            .select("id")
            .where("runId", "in", [firstRun, approvalRun])
            .where("kind", "=", "assistant")
            .execute();
          for (const { id } of answers) expect(frames.at(-1)).toContain(id);
        },
        { timeout: 10_000 },
      );
      for (const message of [joined, waiting]) {
        const shown = frames.map((frame) => frame.indexOf(message));
        const firstShown = shown.findIndex((index) => index !== -1);
        // Once drawn it stays drawn, exactly once, and nothing drawn above it
        // ever moves below it.
        expect(firstShown).toBeGreaterThanOrEqual(0);
        for (const [index, frame] of frames.entries()) {
          if (index < firstShown) continue;
          expect(frame.filter((id) => id === message)).toHaveLength(1);
          const above = new Set(frames[firstShown]!.slice(0, shown[firstShown]));
          for (const id of above) expect(frame.indexOf(id)).toBeLessThan(frame.indexOf(message));
        }
      }
      journeys.push({ frames, joined, name: "client-visual-stability", waiting });
    } finally {
      unsubscribe();
      client.dispose();
    }
  }, 120_000);

  it("restarts a restart-only engine's reply to take the follow-up, in the same Run", async () => {
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
            arguments: [fakeOpencodeServer, "--scenario=steer-restart"],
            executable: process.execPath,
          }),
        );
        return registry;
      },
      harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
      runTimeoutMs: 60_000,
    });
    const active = stack;
    const model = active.catalog.models[0]!;
    const threadId = await active.createThread({
      home: true,
      modelSelection: ModelSelectionSchema.parse({
        modelId: model.modelId,
        options: {},
        providerId: model.providerId,
      }),
      title: "Chat",
      workspaceId: active.mainWorkspaceId,
    });
    const first = await active.queueMessage({ text: "[hold] Draft the launch plan", threadId });
    const runId = await running(active, first.runId);
    const follow = await active.queueMessage({ text: "Use the blue palette", threadId });
    expect(follow.runId).toBe(runId);
    await settled(active, runId);
    const journey = await record("restart-join", active, threadId, runId);
    expect(journey.runStatus).toBe("completed");
    expect(journey.reply).toContain("Use the blue palette");
    expect(journey.attempts).toMatchObject([
      { outcome: "interrupted", reason: "initial" },
      { outcome: "completed", reason: "steer_restart" },
    ]);
    expect(await inputState(active, follow.messageId)).toMatchObject({ runId, state: "delivered" });
    expect(journey.runs).toHaveLength(1);
  }, 120_000);

  async function record(
    name: string,
    active: VerticalStack,
    threadId: ThreadId,
    runId: RunId,
  ): Promise<Journey & { readonly reply: string | null }> {
    const database = active.host.store.database;
    const [inputs, commands, runs, attempts, reply, replyInput] = await Promise.all([
      database
        .selectFrom("threadInputs")
        .innerJoin("messages", "messages.id", "threadInputs.messageId")
        .select([
          "messages.content",
          "messages.sequence",
          "threadInputs.cancelReason",
          "threadInputs.policy",
          "threadInputs.runId",
          "threadInputs.state",
        ])
        .where("threadInputs.threadId", "=", threadId)
        .orderBy("messages.sequence", "asc")
        .execute(),
      database
        .selectFrom("commands")
        .select(["type", "status", "idempotencyKey"])
        .where("threadId", "=", threadId)
        .orderBy("createdAt", "asc")
        .execute(),
      database
        .selectFrom("runs")
        .select(["id", "status", "runOrdinal"])
        .where("threadId", "=", threadId)
        .orderBy("runOrdinal", "asc")
        .execute(),
      database
        .selectFrom("runAttempts")
        .select(["ordinal", "reason", "outcome"])
        .where("runId", "=", runId)
        .orderBy("ordinal", "asc")
        .execute(),
      database
        .selectFrom("messages")
        .select("content")
        .where("runId", "=", runId)
        .where("kind", "=", "assistant")
        .orderBy("sequence", "desc")
        .executeTakeFirst(),
      database
        .selectFrom("messages")
        .select("content")
        .where("runId", "=", runId)
        .where("kind", "=", "input")
        .orderBy("sequence", "asc")
        .executeTakeFirst(),
    ]);
    const journey = {
      attempts,
      commands,
      inputs: inputs.map((row) => ({ ...row, text: textOf(row.content), content: undefined })),
      name,
      reply: reply ? textOf(reply.content) : null,
      replyInput: replyInput ? textOf(replyInput.content) : null,
      runStatus: (await runStatus(active, runId)).status,
      runs,
    };
    journeys.push(journey);
    return journey;
  }
});

async function running(active: VerticalStack, runId: RunId | null): Promise<RunId> {
  if (!runId) throw new Error("The message did not start a Run");
  await waitFor(async () => (await runStatus(active, runId)).status === "running", "the reply");
  return runId;
}

async function settled(active: VerticalStack, runId: RunId): Promise<void> {
  await waitFor(
    async () =>
      ["completed", "failed", "interrupted"].includes((await runStatus(active, runId)).status),
    "the Run to end",
    60_000,
  );
}

function runStatus(active: VerticalStack, runId: RunId) {
  return active.host.store.database
    .selectFrom("runs")
    .select("status")
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
}

function inputState(active: VerticalStack, messageId: MessageId) {
  return active.host.store.database
    .selectFrom("threadInputs")
    .select(["cancelReason", "runId", "state"])
    .where("messageId", "=", messageId)
    .executeTakeFirstOrThrow();
}

async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(50);
  }
}

function textOf(content: unknown): string {
  return Array.isArray(content)
    ? content
        .flatMap((part: { readonly text?: unknown }) =>
          typeof part.text === "string" ? [part.text] : [],
        )
        .join("")
    : "";
}

interface SessionClient {
  activateThread(threadId: string): void;
  activateWorkspace(workspaceId: string): void;
  dispatch(command: {
    readonly content: readonly { readonly text: string; readonly type: "text" }[];
    readonly idempotencyKey: string;
    readonly threadId: string;
    readonly type: "thread.sendMessage";
  }): Promise<{ readonly message: { readonly id: string }; readonly type: string }>;
  dispose(): void;
  load(): Promise<void>;
  getSnapshot(): {
    readonly connection: string;
    readonly inputQueues: Readonly<Record<string, ThreadInputQueue>>;
    readonly transcripts: Readonly<Record<string, readonly TranscriptEntry[]>>;
  };
  subscribe(listener: () => void): () => void;
}

/** The shared client every app uses, signed in as the stack's person. */
async function sessionClient(active: VerticalStack): Promise<SessionClient> {
  const { HttpHostClient } = (await import("@opensteer/client/host")) as unknown as {
    HttpHostClient: new (options: {
      readonly baseUrl: URL;
      readonly fetch: typeof globalThis.fetch;
      readonly reconnectBaseDelayMs: number;
      readonly reconnectMaxDelayMs: number;
      readonly refreshIntervalMs: number;
      readonly webSocketFactory: (url: string) => unknown;
    }) => SessionClient;
  };
  const credentials = { cookie: active.sessionCookie, origin: active.hostOrigin.origin };
  return new HttpHostClient({
    baseUrl: active.hostOrigin,
    fetch: (input, init) => {
      const request = new Request(
        input instanceof Request ? input : new URL(String(input), active.hostOrigin),
        init,
      );
      for (const [name, value] of Object.entries(credentials)) request.headers.set(name, value);
      return fetch(request);
    },
    reconnectBaseDelayMs: 20,
    reconnectMaxDelayMs: 100,
    refreshIntervalMs: 0,
    webSocketFactory: (url) => new WebSocket(url, { headers: credentials }),
  });
}

async function waitForRunOf(active: VerticalStack, messageId: MessageId): Promise<RunId> {
  let runId: RunId | null = null;
  await waitFor(async () => {
    const run = await active.host.store.database
      .selectFrom("runs")
      .select("id")
      .where("seedInputId", "=", messageId)
      .executeTakeFirst();
    runId = run?.id ?? null;
    return runId !== null;
  }, "the message to start a reply");
  return runId!;
}
