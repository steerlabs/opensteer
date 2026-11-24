import { HttpHostClient, type MessageEntry, type WebSocketClient } from "@opensteer/client/host";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ModelSelectionSchema, type RunId, type ThreadId } from "@opensteer/core";
import { HarnessRegistry } from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";

/*
 * Streaming as people see it, across the whole deployment: a Codex engine
 * (the fake app-server) streams thousands of deltas through a real Runner and
 * Host into the shared client every surface uses. Nothing streamed is stored;
 * every reader, early or late, draws the same text; and a Run the Host refuses
 * fails alone, without costing its Runner the connection or its other Runs.
 */

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const fakeCodexAppServer = fileURLToPath(
  new URL(
    "../../../../packages/harness-codex/src/test-fixtures/fake-codex-app-server.mjs",
    import.meta.url,
  ),
);
const modelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: {
    effort: "low",
  },
  providerId: "openai",
});

// The long-stream scenario's shape (fake-codex-app-server.mjs).
const messages = 3;
const deltasPerMessage = 1_200;
const heldAfterDeltas = 200;
const reasoningDeltas = 300;
const commandsPerMessage = 7;
const commandDeltas = 30;
const messageText = (message: number, count = deltasPerMessage) =>
  Array.from(
    {
      length: count,
    },
    (_value, index) => `m${message}t${index} `,
  ).join("");
const reasoningText = (message: number) =>
  Array.from(
    {
      length: reasoningDeltas,
    },
    (_value, index) => `r${message}d${index} `,
  ).join("");
const liveDeltaCount =
  messages * (deltasPerMessage + reasoningDeltas + commandsPerMessage * commandDeltas);
integration("live streaming across the deployment", () => {
  let stack: VerticalStack | undefined;
  const clients: HttpHostClient[] = [];
  const sockets: WebSocket[] = [];
  const temporary: string[] = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) client.dispose();
    for (const socket of sockets.splice(0)) socket.terminate();
    await stack?.close();
    stack = undefined;
    for (const path of temporary.splice(0))
      await rm(path, {
        force: true,
        recursive: true,
      });
  }, 60_000);
  async function start(releaseFile: string, maxConcurrentRuns = 1): Promise<VerticalStack> {
    const harnesses = new HarnessRegistry();
    harnesses.registerDriver(
      new CodexHarnessDriver({
        launch: {
          arguments: [
            fakeCodexAppServer,
            "--scenario=long-stream-held",
            "--unique-threads",
            `--release-file=${releaseFile}`,
          ],
          executable: process.execPath,
        },
      }),
    );
    stack = await startVerticalStack({
      catalogTimeoutMs: 30_000,
      databaseUrl: databaseUrl!,
      harnessInstance: {
        config: {},
        driverKind: "codex",
        sourceId: "openai",
        stateKind: "isolated",
      },
      harnesses,
      maxConcurrentRuns,
      runTimeoutMs: 60_000,
    });
    return stack;
  }
  async function viewer(threadId: ThreadId) {
    const active = stack!;
    const client = new HttpHostClient({
      baseUrl: active.hostOrigin,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("cookie", active.sessionCookie);
        headers.set("origin", active.hostOrigin.origin);
        return fetch(input, {
          ...init,
          headers,
        });
      },
      reconnectBaseDelayMs: 20,
      reconnectMaxDelayMs: 100,
      webSocketFactory: (url) => {
        const socket = new WebSocket(url, {
          headers: {
            cookie: active.sessionCookie,
            origin: active.hostOrigin.origin,
          },
        });
        sockets.push(socket);
        return socket as unknown as WebSocketClient;
      },
    });
    clients.push(client);
    await client.load();
    client.activateThread(threadId);
    return client;
  }
  async function runStatus(runId: RunId): Promise<{
    readonly failure: unknown;
    readonly status: string;
  }> {
    return stack!.host.store.database
      .selectFrom("runs")
      .select(["failure", "status"])
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
  }
  function entries(client: HttpHostClient, threadId: ThreadId) {
    return client.getThreadTranscript(threadId)?.getSnapshot().entries ?? [];
  }
  function streamEntry(client: HttpHostClient, threadId: ThreadId) {
    return entries(client, threadId).find(
      (entry): entry is MessageEntry =>
        entry.kind === "message" && entry.messageKind === "assistant" && entry.streaming === true,
    );
  }
  function streamedText(client: HttpHostClient, threadId: ThreadId) {
    const id = streamEntry(client, threadId)?.itemId;
    return id ? client.getThreadItemText(threadId)?.get(id)?.text : undefined;
  }
  async function durableText(client: HttpHostClient, threadId: ThreadId, entry: MessageEntry) {
    const body = (await client.readTranscriptItem(threadId, entry.itemId!))?.body;
    expect(body?.kind).toBe("message");
    return body?.kind === "message"
      ? body.message.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("")
          .trim()
      : undefined;
  }
  it("streams a long turn live without storing deltas, to early, late and reconnecting readers alike", async () => {
    const outputDirectory =
      process.env.OPENSTEER_EXECUTION_PLANE_E2E_OUTPUT ??
      join(tmpdir(), "opensteer-execution-plane-evidence", randomUUID());
    await mkdir(outputDirectory, {
      recursive: true,
    });
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-live-"));
    temporary.push(scratch);
    const releaseFile = join(scratch, "release");
    const active = await start(releaseFile);
    const threadId = await active.createThread({
      modelSelection,
      title: "Stream a long answer",
    });
    const early = await viewer(threadId);
    const queued = await active.queueMessage({
      text: "Write at length.",
      threadId,
    });
    const runId = queued.runId!;
    const heldText = messageText(0, heldAfterDeltas);
    // The turn is held mid-answer: the early reader has drawn exactly what was
    // streamed, and the Host serves the same text to a reader asking now.
    await waitFor(() => streamedText(early, threadId) === heldText, 30_000, "early reader stream");
    expect(streamEntry(early, threadId)).toMatchObject({
      messageKind: "assistant",
      streaming: true,
    });
    const reasoning = entries(early, threadId).find((entry) => entry.kind === "reasoning");
    expect(reasoning).toMatchObject({ state: "done" });
    await expect(early.readTranscriptItem(threadId, reasoning!.itemId!)).resolves.toMatchObject({
      body: { kind: "text", text: reasoningText(0) },
    });

    // A reader that arrives mid-stream draws the whole stream so far.
    const late = await viewer(threadId);
    await waitFor(() => streamedText(late, threadId) === heldText, 30_000, "late reader stream");

    // A reader whose connection drops mid-stream resumes on the same text.
    for (const socket of sockets) socket.terminate();
    await delay(200);
    await waitFor(() => streamedText(early, threadId) === heldText, 30_000, "reconnected stream");
    await writeFile(releaseFile, "");
    await waitFor(async () => (await runStatus(runId)).status === "completed", 60_000, "run end");

    // A conversation draws a message's text trimmed; the stream draws it as sent.
    const expectedMessages = Array.from(
      {
        length: messages,
      },
      (_value, index) => messageText(index).trim(),
    );
    for (const client of [early, late]) {
      await waitFor(
        () =>
          entries(client, threadId).some(
            (entry) => entry.kind === "run" && entry.status === "completed",
          ),
        30_000,
        "reader saw the run complete",
      );
      while (client.getThreadTranscript(threadId)?.getSnapshot().hasMore)
        await client.loadEarlierTranscript(threadId);
      const history = entries(client, threadId).filter(
        (entry) => "runId" in entry && entry.runId === runId,
      );
      expect(
        history.filter((entry) => entry.kind === "message" && entry.streaming === true),
      ).toEqual([]);
      const answers = history.filter(
        (entry): entry is MessageEntry =>
          entry.kind === "message" && entry.messageKind === "assistant",
      );
      const fullAnswers = await Promise.all(
        answers.map((entry) => durableText(client, threadId, entry)),
      );
      expect(fullAnswers).toEqual(expectedMessages);
      const thoughts = history.filter((entry) => entry.kind === "reasoning");
      const fullThoughts = await Promise.all(
        thoughts.map(async (entry) => {
          const body = (await client.readTranscriptItem(threadId, entry.itemId!))?.body;
          return body?.kind === "text" ? body.text : entry.text;
        }),
      );
      expect(fullThoughts).toEqual(
        Array.from({ length: messages }, (_, index) => reasoningText(index)),
      );
      const tools = history.filter((entry) => entry.kind === "tool");
      expect(tools).toHaveLength(messages * commandsPerMessage);
      expect(tools.every((tool) => tool.state === "done")).toBe(true);
    }

    const database = active.host.store.database;
    const [receipts, retained, calls] = await Promise.all([
      database
        .selectFrom("runnerEventReceipts")
        .select("ordinal")
        .where("runId", "=", runId)
        .orderBy("ordinal")
        .execute(),
      database
        .selectFrom("transcriptItems")
        .select("kind")
        .where("runId", "=", runId)
        .where("visible", "=", true)
        .execute(),
      database
        .selectFrom("toolCalls")
        .select(["startedAt", "status"])
        .where("runId", "=", runId)
        .execute(),
    ]);
    // A terminal Run keeps no receipts.
    expect(receipts).toEqual([]);
    expect(retained.filter(({ kind }) => kind === "reasoning")).toHaveLength(messages);
    expect(calls).toHaveLength(messages * commandsPerMessage);
    expect(calls.every((call) => call.startedAt && call.status === "completed")).toBe(true);
    expect(liveDeltaCount).toBeGreaterThan(2_048);
    await writeFile(
      join(outputDirectory, "live-streaming.json"),
      JSON.stringify(
        {
          runnerReceipts: receipts.length,
          reasoningItems: retained.filter(({ kind }) => kind === "reasoning").length,
          toolCalls: calls.length,
          heldStreamCharacters: heldText.length,
          liveDeltasStreamed: liveDeltaCount,
          readers: ["early", "late", "reconnected"],
          runId,
          threadId,
          verifiedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    console.info(`Live streaming E2E evidence: ${outputDirectory}`);
  }, 180_000);
  it("keeps an answer interrupted mid-stream in the durable record", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-live-"));
    temporary.push(scratch);
    const active = await start(join(scratch, "release"));
    const threadId = await active.createThread({
      modelSelection,
      title: "Stop mid-answer",
    });
    const queued = await active.queueMessage({
      text: "Write at length.",
      threadId,
    });
    const runId = queued.runId!;
    const heldText = messageText(0, heldAfterDeltas);
    const early = await viewer(threadId);
    await waitFor(() => streamedText(early, threadId) === heldText, 30_000, "held stream");
    await active.interruptRun(threadId, runId);
    await waitFor(async () => (await runStatus(runId)).status === "interrupted", 30_000, "stop");

    // A reader opening the Thread afterwards sees what the turn had said.
    const reader = await viewer(threadId);
    const partialAnswer = () =>
      entries(reader, threadId).find(
        (entry): entry is MessageEntry =>
          entry.kind === "message" && entry.messageKind === "assistant" && !entry.streaming,
      );
    await waitFor(() => !!partialAnswer(), 30_000, "durable partial answer");
    expect(await durableText(reader, threadId, partialAnswer()!)).toBe(heldText.trim());
    const [partial, interrupted] = await Promise.all([
      active.host.store.database
        .selectFrom("transcriptItems")
        .innerJoin("messages", "messages.id", "transcriptItems.messageId")
        .select("transcriptItems.revision")
        .where("transcriptItems.runId", "=", runId)
        .where("messages.kind", "=", "assistant")
        .orderBy("transcriptItems.position", "desc")
        .limit(1)
        .executeTakeFirstOrThrow(),
      active.host.store.database
        .selectFrom("runs")
        .select("revision")
        .where("id", "=", runId)
        .executeTakeFirstOrThrow(),
    ]);
    expect(BigInt(partial.revision)).toBeLessThan(BigInt(interrupted.revision));
    expect(streamEntry(reader, threadId)).toBeUndefined();
  }, 120_000);
  it("fails only the Run whose event the Host refuses, keeping the Runner and its other Runs", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-live-"));
    temporary.push(scratch);
    const releaseFile = join(scratch, "release");
    const active = await start(releaseFile, 2);
    const refusedThread = await active.createThread({
      modelSelection,
      title: "Refused",
    });
    const healthyThread = await active.createThread({
      modelSelection,
      title: "Healthy",
    });
    const refused = (
      await active.queueMessage({
        text: "Go.",
        threadId: refusedThread,
      })
    ).runId!;
    const healthy = (
      await active.queueMessage({
        text: "Go.",
        threadId: healthyThread,
      })
    ).runId!;
    const heldText = messageText(0, heldAfterDeltas);
    const refusingViewer = await viewer(refusedThread);
    const healthyViewer = await viewer(healthyThread);
    await waitFor(
      () =>
        streamedText(refusingViewer, refusedThread) === heldText &&
        streamedText(healthyViewer, healthyThread) === heldText,
      30_000,
      "both runs held",
    );
    const connectionBefore = await active.host.store.database
      .selectFrom("runners")
      .select("connectionGeneration")
      .executeTakeFirstOrThrow();

    // An invalid ordinal triggers the real store's refusal without racing lease
    // recovery, which may requeue an expired Run before its next event arrives.
    const commit = active.host.store.commitRunnerEvent.bind(active.host.store);
    let refusedOrdinal: number | undefined;
    vi.spyOn(active.host.store, "commitRunnerEvent").mockImplementation((input) => {
      if (input.event.runId !== refused) return commit(input);
      refusedOrdinal ??= input.event.ordinal;
      return commit({ ...input, event: { ...input.event, ordinal: input.event.ordinal + 1 } });
    });
    await writeFile(releaseFile, "");
    await waitFor(async () => (await runStatus(refused)).status === "failed", 30_000, "refused");
    await waitFor(async () => (await runStatus(healthy)).status === "completed", 60_000, "healthy");
    expect(refusedOrdinal).toBeDefined();
    expect((await runStatus(refused)).failure).toMatchObject({
      code: "runner_event_refused",
      message: expect.stringContaining(`Expected Runner ordinal ${refusedOrdinal}`),
    });
    const connectionAfter = await active.host.store.database
      .selectFrom("runners")
      .select("connectionGeneration")
      .executeTakeFirstOrThrow();
    expect(connectionAfter.connectionGeneration).toBe(connectionBefore.connectionGeneration);
    const healthyMessages = await active.host.store.database
      .selectFrom("messages")
      .select("id")
      .where("runId", "=", healthy)
      .where("kind", "=", "assistant")
      .execute();
    expect(healthyMessages).toHaveLength(messages);
  }, 180_000);
});
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
