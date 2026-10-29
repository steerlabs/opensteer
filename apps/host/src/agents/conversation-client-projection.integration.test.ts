import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  ModelSelectionSchema,
  createId,
  type MessageId,
  type RequestId,
  type RequestResponse,
  type ThreadId,
  type ThreadInputQueue,
} from "@opensteer/core";
import {
  BoundedEventStream,
  HarnessRegistry,
  isolatedServiceHarnessRuntimeBoundary,
  type HarnessAdapter,
  type HarnessDriver,
  type HarnessEvent,
  type HarnessRunInput,
  type HarnessSession,
  type HarnessSessionContext,
  type HarnessSteerInput,
} from "@opensteer/harness";
import { CodexHarnessDriver } from "@opensteer/harness-codex";
import {
  conversationActivityTurn,
  conversationRows,
  conversationTurnRevealing,
  groupTranscriptEntries,
  visibleTranscript,
  type ConversationRow,
  type MessageEntry,
  type TranscriptEntry,
} from "@opensteer/client/host";
import { computerUseNow } from "@opensteer/client/integrations";
import type { MachineSummary } from "@opensteer/protocol";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startVerticalStack, type VerticalStack } from "./vertical-stack.test-support.js";

/*
 * What the shared client draws of a Chat while the Host hands the person's
 * messages to the reply under way, read by the real `HttpHostClient` every app
 * uses, signed in to a real Host whose Runner drives an engine this test
 * scripts step by step. A reload is a second client loading the same Chat.
 *
 * What can go wrong:
 *   - a message joins the reply, and the reply's row (and the Activity open on
 *     it) is renamed when the reply's first step after the message lands, so
 *     a phone remounts it and its typing starts over, and the Activity closes
 *     on "no longer loaded";
 *   - the stretch of the reply before the message, which said nothing of its
 *     own, is drawn as a row between the person's two messages;
 *   - the engine refuses a message it was handed while it goes on working, and
 *     the live client keeps the message where the reply took it, drawing the
 *     reply's later work under a message it never received, while a reload
 *     shows it waiting at the end;
 *   - the waiting message is labelled as delivered or failed, drawn twice, or
 *     moved more than once when the next reply takes it.
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

interface Journey {
  readonly name: string;
  readonly [fact: string]: unknown;
}

integration("what the shared client draws of a Chat a person keeps writing to", () => {
  let stack: VerticalStack | undefined;
  const clients: SessionClient[] = [];
  const journeys: Journey[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) client.dispose();
    await stack?.close();
    stack = undefined;
  }, 60_000);

  afterAll(async () => {
    const directory =
      process.env.OPENSTEER_CONVERSATION_CLIENT_OUTPUT ??
      join(tmpdir(), "opensteer-conversation-client", randomUUID());
    await mkdir(directory, { recursive: true });
    const artifact = join(directory, "client-projection-journeys.json");
    await writeFile(artifact, JSON.stringify(journeys, null, 2) + "\n");
    console.info(`Conversation client journeys: ${artifact}`);
  });

  async function chatWith(engine: ScriptedEngine) {
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
        registry.registerDriver(engine.driver());
        return registry;
      },
      harnessRuntimeBoundary: isolatedServiceHarnessRuntimeBoundary,
      runTimeoutMs: 30_000,
    });
    const threadId = await stack.createThread({
      home: true,
      modelSelection,
      title: "Chat",
      workspaceId: stack.mainWorkspaceId,
    });
    const client = await signedIn(stack, threadId);
    clients.push(client);
    return { active: stack, client, threadId };
  }

  /** A fresh client loading the same Chat, as a refreshed page or relaunched app does. */
  async function reload(client: SessionClient, threadId: ThreadId) {
    const fresh = await signedIn(stack!, threadId);
    try {
      await vi.waitFor(
        () =>
          expect(fresh.getSnapshot().transcripts[threadId]?.length ?? 0).toBeGreaterThanOrEqual(
            client.getSnapshot().transcripts[threadId]?.length ?? 0,
          ),
        { timeout: 15_000 },
      );
      return view(fresh, threadId);
    } finally {
      fresh.dispose();
    }
  }

  it("keeps one row and one Activity for a reply from the moment a message joins it until it answers", async () => {
    const engine = new ScriptedEngine();
    const { client, threadId } = await chatWith(engine);
    const frames = recordFrames(client, threadId);

    const first = await send(client, threadId, "Plan the trip to Lisbon");
    const reply = await engine.nextRun();
    const note = reply.say("Checking flights first.");
    reply.step("Looking at flights for Thursday.");
    await shown(client, threadId, (entries) => entries.some((entry) => entry.kind === "reasoning"));

    const joined = await send(client, threadId, "Also book the hotel");
    expect(await engine.steeredWith("Also book the hotel")).toBe(true);
    await shown(client, threadId, (entries) => messageIn(entries, joined)?.runId === reply.runId);
    const atJoin = view(client, threadId);
    const replyRow = `turn:after:${joined}`;
    // What the reply did before the message said nothing of its own, so the
    // person's two messages stand together, and the reply goes on below them.
    expect(rowNames(atJoin.rows)).toEqual([first, joined, replyRow]);
    // A link to what it said on the way names the turn it was said in.
    const linked = conversationTurnRevealing(atJoin.groups, note);
    expect(linked).toBe(`turn:run:${reply.runId}`);
    expect(
      conversationActivityTurn(atJoin.groups, { key: linked!, kind: "turn" })?.steps.map(
        ({ id }) => id,
      ),
    ).toEqual(
      conversationActivityTurn(atJoin.groups, { kind: "latest" })?.steps.map(({ id }) => id),
    );

    reply.step("Comparing hotels near the Alfama.");
    await shown(
      client,
      threadId,
      (entries) => entries.filter((entry) => entry.kind === "reasoning").length === 2,
    );
    const atStep = view(client, threadId);
    expect(rowNames(atStep.rows)).toEqual([first, joined, replyRow]);
    const opened = conversationActivityTurn(atStep.groups, { key: linked!, kind: "turn" });
    expect(opened?.live).toBe(true);
    expect(opened?.steps.map((step) => step.kind)).toEqual(["message", "reasoning", "reasoning"]);
    expect(conversationTurnRevealing(atStep.groups, note)).toBe(linked);

    const answer = reply.reply("Flights on Thursday and a hotel in the Alfama.");
    await shown(client, threadId, (entries) =>
      entries.some((entry) => entry.kind === "run" && entry.status === "completed"),
    );
    const answered = view(client, threadId);
    const activity = conversationActivityTurn(answered.groups, { key: linked!, kind: "turn" });
    expect(activity?.reply?.id).toBe(answer);
    expect(activity?.steps.map((step) => step.kind)).toEqual(["message", "reasoning", "reasoning"]);
    expect(rowNames(answered.rows)).toEqual([first, joined, replyRow]);

    // From the frame the reply first stood after the message, it was the one
    // row after it, under one name, in every frame drawn.
    const since = frames.findIndex((frame) => frame.includes(replyRow));
    expect(since).toBeGreaterThanOrEqual(0);
    for (const frame of frames.slice(since)) expect(frame).toEqual([first, joined, replyRow]);

    const reloaded = await reload(client, threadId);
    expect(rowNames(reloaded.rows)).toEqual(rowNames(answered.rows));
    expect(reloaded.groups.map(({ key }) => key)).toEqual(answered.groups.map(({ key }) => key));
    journeys.push({
      answer,
      first,
      frames,
      joined,
      linked,
      name: "one-row-per-reply",
      note,
      replyRow,
    });
  }, 120_000);

  it("draws a message the reply could not take as waiting at the end, live as after a reload, until the next reply takes it", async () => {
    const engine = new ScriptedEngine({ refuse: (text) => text.startsWith("[refuse]") });
    const { active, client, threadId } = await chatWith(engine);
    const frames = recordFrames(client, threadId);

    const first = await send(client, threadId, "Plan the trip to Lisbon");
    const reply = await engine.nextRun();
    reply.step("Looking at flights for Thursday.");
    await shown(client, threadId, (entries) => entries.some((entry) => entry.kind === "reasoning"));

    const refused = await send(client, threadId, "[refuse] Also book the hotel");
    await vi.waitFor(
      async () =>
        expect(await inputState(active, refused)).toMatchObject({ runId: null, state: "pending" }),
      { timeout: 15_000 },
    );
    expect(engine.refused).toEqual(["[refuse] Also book the hotel"]);
    // The live client hears the input is waiting again and rereads the queue.
    await shown(client, threadId, (entries, queue) => {
      const message = messageIn(entries, refused);
      return (
        message?.runId === null &&
        (queue?.items.some(({ input }) => input.messageId === refused) ?? false)
      );
    });
    const waiting = view(client, threadId);
    expect(waiting.visibleIds.at(-1)).toBe(refused);
    expect(rowNames(waiting.rows).at(-1)).toBe(refused);
    // The reply at work stands above the message it never received.
    const live = waiting.rows.findIndex(
      ({ group }) =>
        group.kind === "turn" && group.turn.runId === reply.runId && group.turn.run !== null,
    );
    expect(live).toBeGreaterThanOrEqual(0);
    expect(live).toBeLessThan(rowNames(waiting.rows).indexOf(refused));
    expect(messageIn(waiting.entries, refused)?.delivery).toBeUndefined();

    // The reply goes on working: what it does is drawn above the waiting message.
    reply.step("Comparing flight times.");
    await shown(
      client,
      threadId,
      (entries) => entries.filter((entry) => entry.kind === "reasoning").length === 2,
    );
    const working = view(client, threadId);
    expect(working.visibleIds.at(-1)).toBe(refused);
    expect(rowNames(working.rows).at(-1)).toBe(refused);
    const reloadedWhileWorking = await reload(client, threadId);
    expect(reloadedWhileWorking.visibleIds).toEqual(working.visibleIds);
    expect(reloadedWhileWorking.groups.map(({ key }) => key)).toEqual(
      working.groups.map(({ key }) => key),
    );
    expect(rowNames(reloadedWhileWorking.rows)).toEqual(rowNames(working.rows));

    // The reply answers what it was given; the next one takes the message.
    const answer = reply.reply("Thursday's 9:40 flight is the best fit.");
    const next = await engine.nextRun();
    expect(next.texts).toEqual(["[refuse] Also book the hotel"]);
    const nextAnswer = next.reply("Booked a hotel in the Alfama.");
    await shown(client, threadId, (entries) => messageIn(entries, nextAnswer) !== undefined);
    const settledView = view(client, threadId);
    expect(settledView.visibleIds.slice(-3)).toEqual([answer, refused, nextAnswer]);
    // Receipt names the Run even before a background snapshot can repair it.
    expect(messageIn(settledView.entries, refused)).toMatchObject({
      published: true,
      runId: next.runId,
    });
    // The next reply keeps the row under the message it took.
    expect(rowNames(settledView.rows).slice(-2)).toEqual([refused, `turn:after:${refused}`]);
    expect(messageIn(settledView.entries, refused)?.delivery).toBeUndefined();
    const reloaded = await reload(client, threadId);
    expect(reloaded.visibleIds).toEqual(settledView.visibleIds);
    expect(rowNames(reloaded.rows)).toEqual(rowNames(settledView.rows));
    expect(messageIn(reloaded.entries, refused)).toMatchObject({
      published: true,
      runId: next.runId,
    });

    // In every frame it is drawn once, and from the moment it waited at the
    // end nothing drawn above it ever moved below it.
    const waitedAt = frames.findIndex((frame) => frame.at(-1) === refused && frame.includes(first));
    expect(waitedAt).toBeGreaterThanOrEqual(0);
    for (const frame of frames) {
      expect(frame.filter((name) => name === refused).length).toBeLessThanOrEqual(1);
    }
    const above = new Set(frames[waitedAt]!.slice(0, frames[waitedAt]!.indexOf(refused)));
    for (const frame of frames.slice(waitedAt)) {
      const position = frame.indexOf(refused);
      expect(position).toBeGreaterThanOrEqual(0);
      for (const name of above) {
        if (frame.includes(name)) expect(frame.indexOf(name)).toBeLessThan(position);
      }
    }
    journeys.push({
      answer,
      first,
      frames,
      name: "refused-hand-off-waits",
      receivedInput: messageIn(settledView.entries, refused),
      reloadedInput: messageIn(reloaded.entries, refused),
      nextAnswer,
      refused,
      steered: engine.steered,
    });
  }, 120_000);
});

/* ---- The engine ---- */

/**
 * An engine whose every Run the test drives: a step, a reply, nothing until
 * asked. It is the Codex driver as far as the Runner can tell — its catalog,
 * capabilities and sign-in come from the Codex driver and its fake app server
 * — while sessions are scripted, so a message the engine is handed mid-turn
 * can be refused as an engine that cannot take it now would.
 */
class ScriptedEngine {
  readonly refused: string[] = [];
  readonly steered: string[] = [];
  readonly #refuse: (text: string) => boolean;
  readonly #runs: ScriptedRun[] = [];
  readonly #waiting: ((run: ScriptedRun) => void)[] = [];
  #taken = 0;

  constructor(options: { readonly refuse?: (text: string) => boolean } = {}) {
    this.#refuse = options.refuse ?? (() => false);
  }

  driver(): HarnessDriver {
    const codex = new CodexHarnessDriver({
      launch: { arguments: [fakeCodexAppServer], executable: process.execPath },
    });
    return {
      accessModes: codex.accessModes,
      authenticate: (context, selection) => codex.authenticate(context, selection),
      capabilities: codex.capabilities,
      configSchema: codex.configSchema,
      environmentVariables: codex.environmentVariables,
      inspect: (context) => codex.inspect(context),
      kind: codex.kind,
      logout: (context, selection) => codex.logout(context, selection),
      modelCommandLaunch: (context) => codex.modelCommandLaunch(context),
      prepare: (context) => codex.prepare(context),
      providerStoreScope: codex.providerStoreScope,
      removeProfile: (context) => codex.removeProfile(context),
      sources: codex.sources,
      create: async (context): Promise<HarnessAdapter> => {
        const adapter = await codex.create(context);
        return {
          capabilities: adapter.capabilities,
          close: () => adapter.close(),
          instanceId: adapter.instanceId,
          resumeSession: async (reference) => new ScriptedSession(this, reference),
          startSession: async () => new ScriptedSession(this, `scripted-${randomUUID()}`),
        };
      },
    };
  }

  /** The next Run the Runner executes, once it has. */
  nextRun(): Promise<ScriptedRun> {
    const index = this.#taken;
    this.#taken += 1;
    const ready = this.#runs[index];
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  async steeredWith(text: string): Promise<boolean> {
    await vi.waitFor(() => expect(this.steered).toContain(text), { timeout: 15_000 });
    return true;
  }

  began(run: ScriptedRun): void {
    this.#runs.push(run);
    const waiter = this.#waiting.shift();
    waiter?.(run);
  }

  takes(text: string): boolean {
    if (this.#refuse(text)) {
      this.refused.push(text);
      return false;
    }
    this.steered.push(text);
    return true;
  }
}

class ScriptedSession implements HarnessSession {
  readonly events: AsyncIterable<HarnessEvent>;
  readonly providerSessionReference: string;
  readonly #engine: ScriptedEngine;
  readonly #stream = new BoundedEventStream<HarnessEvent>({ maxBytes: 1_000_000, maxItems: 500 });
  #run: ScriptedRun | null = null;

  constructor(engine: ScriptedEngine, reference: string) {
    this.#engine = engine;
    this.providerSessionReference = reference;
    this.events = this.#stream;
  }

  async execute(input: HarnessRunInput): Promise<void> {
    const run = new ScriptedRun(input, (event) =>
      this.#stream.publish(event, { delivery: "must-deliver" }),
    );
    this.#run = run;
    this.#engine.began(run);
    await run.ended;
  }

  async steer(input: HarnessSteerInput): Promise<void> {
    if (this.#run === null || this.#run.over) throw new Error("No reply is under way.");
    if (!this.#engine.takes(textOf(input.input.content))) {
      throw new Error("This engine cannot take a message right now.");
    }
  }

  async interrupt(): Promise<void> {
    this.#run?.interrupt();
  }

  async resolveRequest(_requestId: RequestId, _response: RequestResponse): Promise<void> {}

  rebind(_context: HarnessSessionContext): void {}

  async releaseForReuse(): Promise<boolean> {
    return true;
  }

  async stop(): Promise<void> {
    this.#run?.interrupt();
    this.#stream.close();
  }
}

class ScriptedRun {
  readonly runId: string;
  readonly texts: readonly string[];
  over = false;
  readonly #emit: (event: HarnessEvent) => void;
  readonly #ended: { promise: Promise<void>; resolve: () => void };

  constructor(input: HarnessRunInput, emit: (event: HarnessEvent) => void) {
    this.runId = input.runId;
    this.texts = input.inputs.map((item) => textOf(item.content));
    this.#emit = emit;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    this.#ended = { promise, resolve };
    emit({ data: { status: "running" }, type: "run.started" });
  }

  get ended(): Promise<void> {
    return this.#ended.promise;
  }

  /** Says something on the way, as an agent does before it answers. */
  say(text: string): MessageId {
    const messageId = createId("message");
    this.#emit({
      data: { content: [{ text, type: "text" }], messageId },
      type: "assistant.message",
    });
    return messageId;
  }

  step(text: string): void {
    this.#emit({
      data: { blockId: `thought-${randomUUID()}`, text },
      type: "reasoning.completed",
    });
  }

  /** Answers and ends the Run; the reply's message id. */
  reply(text: string): MessageId {
    const messageId = createId("message");
    this.#emit({
      data: { content: [{ text, type: "text" }], messageId },
      type: "assistant.message",
    });
    this.#emit({ data: { status: "completed" }, type: "run.completed" });
    this.over = true;
    this.#ended.resolve();
    return messageId;
  }

  interrupt(): void {
    if (this.over) return;
    this.over = true;
    this.#emit({ data: { status: "interrupted" }, type: "run.interrupted" });
    this.#ended.resolve();
  }
}

/* ---- The client ---- */

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
    readonly machines: readonly MachineSummary[];
    readonly transcripts: Readonly<Record<string, readonly TranscriptEntry[]>>;
  };
  subscribe(listener: () => void): () => void;
}

/** The shared client every app uses, signed in as the stack's person, on the Chat. */
async function signedIn(active: VerticalStack, threadId: ThreadId): Promise<SessionClient> {
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
  const client = new HttpHostClient({
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
  await client.load();
  await vi.waitFor(() => expect(client.getSnapshot().connection).toBe("connected"), {
    timeout: 15_000,
  });
  client.activateWorkspace(active.mainWorkspaceId);
  client.activateThread(threadId);
  await vi.waitFor(() => expect(client.getSnapshot().inputQueues[threadId]).toBeDefined(), {
    timeout: 15_000,
  });
  return client;
}

async function send(client: SessionClient, threadId: ThreadId, text: string): Promise<MessageId> {
  const sent = await client.dispatch({
    content: [{ text, type: "text" }],
    idempotencyKey: `client-send-${randomUUID()}`,
    threadId,
    type: "thread.sendMessage",
  });
  if (sent.type !== "thread.sendMessage") throw new Error("Unexpected send answer");
  return sent.message.id as MessageId;
}

/** What a conversation shows, as both apps compute it. */
function view(client: SessionClient, threadId: string) {
  const snapshot = client.getSnapshot();
  const entries = snapshot.transcripts[threadId] ?? [];
  const queue = snapshot.inputQueues[threadId] ?? null;
  const visible = visibleTranscript(entries, queue, { conversation: true });
  const groups = groupTranscriptEntries(visible);
  return {
    entries,
    groups,
    queue,
    // This reader never presses Stop, so its Macs alone say what it is shown of a computer.
    rows: conversationRows(groups, {
      atComputer: (turn) => computerUseNow(turn, snapshot.machines) !== null,
      live: true,
    }),
    visibleIds: visible.flatMap((entry) => (entry.kind === "message" ? [entry.id] : [])),
  };
}

/** Each distinct set of rows the conversation drew, in order. */
function recordFrames(client: SessionClient, threadId: string): string[][] {
  const frames: string[][] = [];
  client.subscribe(() => {
    const names = rowNames(view(client, threadId).rows);
    const last = frames.at(-1);
    if (!last || last.join() !== names.join()) frames.push(names);
  });
  return frames;
}

function rowNames(rows: readonly ConversationRow[]): string[] {
  return rows.map(({ key }) => key);
}

function messageIn(entries: readonly TranscriptEntry[], id: string): MessageEntry | undefined {
  const entry = entries.find((candidate) => candidate.id === id);
  return entry?.kind === "message" ? entry : undefined;
}

async function shown(
  client: SessionClient,
  threadId: string,
  check: (entries: readonly TranscriptEntry[], queue: ThreadInputQueue | null) => boolean,
): Promise<void> {
  await vi.waitFor(
    () => {
      const snapshot = client.getSnapshot();
      expect(
        check(snapshot.transcripts[threadId] ?? [], snapshot.inputQueues[threadId] ?? null),
      ).toBe(true);
    },
    { interval: 25, timeout: 15_000 },
  );
}

function inputState(active: VerticalStack, messageId: MessageId) {
  return active.host.store.database
    .selectFrom("threadInputs")
    .select(["cancelReason", "runId", "state"])
    .where("messageId", "=", messageId)
    .executeTakeFirstOrThrow();
}

function textOf(content: readonly { readonly type: string; readonly text?: unknown }[]): string {
  return content
    .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("");
}
