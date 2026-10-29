import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ModelSelectionSchema, type RunId, type ThreadId } from "@opensteer/core";
import { HarnessRegistry, isolatedServiceHarnessRuntimeBoundary } from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
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
  options: { effort: "low" },
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
  Array.from({ length: count }, (_value, index) => `m${message}t${index} `).join("");
const reasoningText = (message: number) =>
  Array.from({ length: reasoningDeltas }, (_value, index) => `r${message}d${index} `).join("");
const liveDeltaCount =
  messages * (deltasPerMessage + reasoningDeltas + commandsPerMessage * commandDeltas);

interface TranscriptEntryView {
  readonly body?: string;
  readonly id: string;
  readonly kind: string;
  readonly messageKind?: string;
  readonly output?: { readonly text: string };
  readonly runId?: string | null;
  readonly state?: string;
  readonly status?: string;
  readonly streamText?: string;
  readonly streaming?: boolean;
  readonly text?: string;
}

interface LiveClient {
  activateThread(threadId: string): void;
  activateWorkspace(workspaceId: string): void;
  dispose(): void;
  getSnapshot(): { readonly transcripts: Record<string, readonly TranscriptEntryView[]> };
  load(): Promise<void>;
}

integration("live streaming across the deployment", () => {
  let stack: VerticalStack | undefined;
  const clients: LiveClient[] = [];
  const sockets: WebSocket[] = [];
  const temporary: string[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.dispose();
    for (const socket of sockets.splice(0)) socket.terminate();
    await stack?.close();
    stack = undefined;
    for (const path of temporary.splice(0)) await rm(path, { force: true, recursive: true });
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
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      maxConcurrentRuns,
      runTimeoutMs: 60_000,
    });
    return stack;
  }

  async function viewer(threadId: ThreadId, workspaceId: string): Promise<LiveClient> {
    const active = stack!;
    const clientModulePath = "@opensteer/client/host";
    const { HttpHostClient } = (await import(clientModulePath)) as {
      HttpHostClient: new (options: {
        readonly baseUrl: URL;
        readonly fetch: typeof globalThis.fetch;
        readonly reconnectBaseDelayMs: number;
        readonly reconnectMaxDelayMs: number;
        readonly refreshIntervalMs: number;
        readonly webSocketFactory: (url: string) => unknown;
      }) => LiveClient;
    };
    const client = new HttpHostClient({
      baseUrl: active.hostOrigin,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("cookie", active.sessionCookie);
        headers.set("origin", active.hostOrigin.origin);
        return fetch(input, { ...init, headers });
      },
      reconnectBaseDelayMs: 20,
      reconnectMaxDelayMs: 100,
      refreshIntervalMs: 0,
      webSocketFactory: (url) => {
        const socket = new WebSocket(url, {
          headers: { cookie: active.sessionCookie, origin: active.hostOrigin.origin },
        });
        sockets.push(socket);
        return socket;
      },
    });
    clients.push(client);
    await client.load();
    client.activateWorkspace(workspaceId);
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

  async function liveAssistant(threadId: ThreadId): Promise<string | undefined> {
    const read = await stack!.api["thread.live.get"]({ threadId });
    if (!read.ok) throw new Error(read.error.message);
    const item = read.data.runs
      .flatMap((run) => run.progress.items)
      .find((candidate) => candidate.stream === "assistant");
    return item?.text;
  }

  it("streams a long turn live without storing deltas, to early, late and reconnecting readers alike", async () => {
    const outputDirectory =
      process.env.OPENSTEER_EXECUTION_PLANE_E2E_OUTPUT ??
      join(tmpdir(), "opensteer-execution-plane-evidence", randomUUID());
    await mkdir(outputDirectory, { recursive: true });
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-live-"));
    temporary.push(scratch);
    const releaseFile = join(scratch, "release");
    const active = await start(releaseFile);
    const workspace = await active.createWorkspace("Live streaming");
    const threadId = await active.createThread({
      modelSelection,
      title: "Stream a long answer",
      workspaceId: workspace.id,
    });
    const early = await viewer(threadId, workspace.id);

    const queued = await active.queueMessage({ text: "Write at length.", threadId });
    const runId = queued.runId!;
    const heldText = messageText(0, heldAfterDeltas);
    const streamEntry = (client: LiveClient) =>
      client.getSnapshot().transcripts[threadId]?.find((entry) => entry.id === `stream:${runId}`);

    // The turn is held mid-answer: the early reader has drawn exactly what was
    // streamed, and the Host serves the same text to a reader asking now.
    await waitFor(() => streamEntry(early)?.body === heldText, 30_000, "early reader stream");
    expect(streamEntry(early)).toMatchObject({ messageKind: "assistant", streaming: true });
    expect(await liveAssistant(threadId)).toBe(heldText);
    const reasoning = (client: LiveClient) =>
      client
        .getSnapshot()
        .transcripts[threadId]?.find((entry) => entry.id === `reasoning:${runId}:long-reasoning-0`);
    expect(reasoning(early)).toMatchObject({ state: "done", text: reasoningText(0) });

    // A reader that arrives mid-stream draws the whole stream so far.
    const late = await viewer(threadId, workspace.id);
    await waitFor(() => streamEntry(late)?.body === heldText, 30_000, "late reader stream");

    // A reader whose connection drops mid-stream resumes on the same text.
    for (const socket of sockets) socket.terminate();
    await delay(200);
    await waitFor(() => streamEntry(early)?.body === heldText, 30_000, "reconnected stream");

    await writeFile(releaseFile, "");
    await waitFor(async () => (await runStatus(runId)).status === "completed", 60_000, "run end");

    // A conversation draws a message's text trimmed; the stream draws it as sent.
    const expectedMessages = Array.from({ length: messages }, (_value, index) =>
      messageText(index).trim(),
    );
    for (const client of [early, late]) {
      await waitFor(
        () =>
          (client.getSnapshot().transcripts[threadId] ?? []).some(
            (entry) => entry.kind === "run" && entry.status === "completed",
          ),
        30_000,
        "reader saw the run complete",
      );
      const entries = (client.getSnapshot().transcripts[threadId] ?? []).filter(
        (entry) => entry.runId === runId,
      );
      expect(entries.filter((entry) => entry.streaming === true)).toEqual([]);
      expect(
        entries
          .filter((entry) => entry.kind === "message" && entry.messageKind === "assistant")
          .map((entry) => entry.body),
      ).toEqual(expectedMessages);
      expect(
        entries.filter((entry) => entry.kind === "reasoning").map((entry) => entry.text),
      ).toEqual(Array.from({ length: messages }, (_value, index) => reasoningText(index)));
      const tools = entries.filter((entry) => entry.kind === "tool");
      expect(tools).toHaveLength(messages * commandsPerMessage);
      expect(tools.every((tool) => tool.state === "done")).toBe(true);
    }

    // Nothing streamed reached the durable log: only completions did.
    const stored = await active.host.store.database
      .selectFrom("workspaceEvents")
      .select(["runnerOrdinal", "type"])
      .where("runId", "=", runId)
      .where("runnerOrdinal", "is not", null)
      .orderBy("runnerOrdinal", "asc")
      .execute();
    const storedTypes = stored.map((row) => row.type);
    expect(storedTypes.filter((type) => type.endsWith(".delta"))).toEqual([]);
    const counts = Object.fromEntries(
      [...new Set(storedTypes)].map((type) => [type, storedTypes.filter((t) => t === type).length]),
    );
    expect(counts).toMatchObject({
      "assistant.message": messages,
      "reasoning.completed": messages,
      "run.completed": 1,
      "run.started": 1,
      "tool.completed": messages * commandsPerMessage,
      "tool.started": messages * commandsPerMessage,
    });
    expect(stored.map((row) => row.runnerOrdinal)).toEqual(stored.map((_row, index) => index));
    expect(liveDeltaCount).toBeGreaterThan(2_048);

    await writeFile(
      join(outputDirectory, "live-streaming.json"),
      JSON.stringify(
        {
          durableRunnerEvents: stored.length,
          durableTypeCounts: counts,
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
    const workspace = await active.createWorkspace("Interrupted stream");
    const threadId = await active.createThread({
      modelSelection,
      title: "Stop mid-answer",
      workspaceId: workspace.id,
    });
    const queued = await active.queueMessage({ text: "Write at length.", threadId });
    const runId = queued.runId!;
    const heldText = messageText(0, heldAfterDeltas);
    await waitFor(async () => (await liveAssistant(threadId)) === heldText, 30_000, "held stream");

    await active.interruptRun(threadId, runId);
    await waitFor(async () => (await runStatus(runId)).status === "interrupted", 30_000, "stop");

    // A reader opening the Thread afterwards sees what the turn had said.
    const reader = await viewer(threadId, workspace.id);
    await waitFor(
      () =>
        (reader.getSnapshot().transcripts[threadId] ?? []).some(
          (entry) => entry.kind === "message" && entry.body === heldText.trim(),
        ),
      30_000,
      "durable partial answer",
    );
    const stored = await active.host.store.database
      .selectFrom("workspaceEvents")
      .select("type")
      .where("runId", "=", runId)
      .where("runnerOrdinal", "is not", null)
      .orderBy("runnerOrdinal", "asc")
      .execute();
    const types = stored.map((row) => row.type);
    expect(types.indexOf("assistant.message")).toBeLessThan(types.indexOf("run.interrupted"));
    expect(await liveAssistant(threadId)).toBeUndefined();
  }, 120_000);

  it("fails only the Run whose event the Host refuses, keeping the Runner and its other Runs", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "opensteer-live-"));
    temporary.push(scratch);
    const releaseFile = join(scratch, "release");
    const active = await start(releaseFile, 2);
    const workspace = await active.createWorkspace("Refusal isolation");
    const refusedThread = await active.createThread({
      modelSelection,
      title: "Refused",
      workspaceId: workspace.id,
    });
    const healthyThread = await active.createThread({
      modelSelection,
      title: "Healthy",
      workspaceId: workspace.id,
    });
    const refused = (await active.queueMessage({ text: "Go.", threadId: refusedThread })).runId!;
    const healthy = (await active.queueMessage({ text: "Go.", threadId: healthyThread })).runId!;
    const heldText = messageText(0, heldAfterDeltas);
    await waitFor(
      async () =>
        (await liveAssistant(refusedThread)) === heldText &&
        (await liveAssistant(healthyThread)) === heldText,
      30_000,
      "both runs held",
    );
    const connectionBefore = await active.host.store.database
      .selectFrom("runners")
      .select("connectionGeneration")
      .executeTakeFirstOrThrow();

    // The refused Run's binding is no longer current, so the Host refuses the
    // next event its engine reports.
    await sql`
      update provider_sessions
      set lease_expires_at = now() - interval '1 second'
      where id = (select provider_session_id from runs where id = ${refused})
    `.execute(active.host.store.database);
    await writeFile(releaseFile, "");

    await waitFor(async () => (await runStatus(refused)).status === "failed", 30_000, "refused");
    await waitFor(async () => (await runStatus(healthy)).status === "completed", 60_000, "healthy");
    expect((await runStatus(refused)).failure).toMatchObject({ code: "runner_event_refused" });
    const connectionAfter = await active.host.store.database
      .selectFrom("runners")
      .select("connectionGeneration")
      .executeTakeFirstOrThrow();
    expect(connectionAfter.connectionGeneration).toBe(connectionBefore.connectionGeneration);
    const healthyMessages = await active.host.store.database
      .selectFrom("workspaceEvents")
      .select("type")
      .where("runId", "=", healthy)
      .where("type", "=", "assistant.message")
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
