import { describe, expect, it } from "vitest";
import {
  createId,
  createToolArguments,
  ModelSelectionSchema,
  type IntegrationCallSubject,
} from "@opensteer/core";
import { computerUseActHeadline, formatComputerUseResultHead } from "@opensteer/protocol";
import type {
  DelegationEntry,
  MessageEntry,
  ReasoningEntry,
  RequestReceiptEntry,
  RunEntry,
  SelectionEntry,
  ToolEntry,
  TranscriptEntry,
} from "./client.js";
import {
  activityFeedPresentation,
  conversationActivityTurn,
  conversationTurn,
  conversationRows,
  silentRunLabel,
  conversationTurnRevealing,
  activityStepHead,
  displayCommand,
  groupTranscriptEntries,
  toolBody,
  toolArgumentsText,
  toolPresentation,
  toolStatusLabel,
  turnFolds,
  turnState,
  turnComputer,
  turnWords,
  workRows,
  workSummary,
  type TranscriptGroup,
  type Turn,
} from "./agent-activity-model.js";
import { threadActivityIndicator } from "./thread-activity.js";
import { visibleTranscript } from "./transcript.js";
import {
  mockComputerUseSlack,
  mockComputerUseSubject,
  mockComputerUseToolRefs,
  mockComputerUseTurn,
} from "../mock/mock-computer-use-transcript.js";

let sequence = 0;

function at(second: number): string {
  return new Date(Date.UTC(2026, 7, 16, 10, 0, second)).toISOString();
}

function tool(overrides: Partial<ToolEntry> = {}): ToolEntry {
  sequence += 1;
  return {
    arguments: {},
    callId: `call-${sequence}`,
    completedAt: at(4),
    createdAt: at(1),
    id: `tool:run-a:call-${sequence}`,
    integration: null,
    isError: false,
    kind: "tool",
    output: undefined,
    runId: "run-a",
    state: "done",
    streamText: "",
    tool: { name: "shell", namespace: "codex" },
    ...overrides,
  };
}

function command(text: string, overrides: Partial<ToolEntry> = {}): ToolEntry {
  return tool({ arguments: { command: text }, ...overrides });
}

function reasoning(overrides: Partial<ReasoningEntry> = {}): ReasoningEntry {
  sequence += 1;
  return {
    completedAt: at(3),
    createdAt: at(0),
    id: `reasoning:run-a:block-${sequence}`,
    kind: "reasoning",
    runId: "run-a",
    state: "done",
    text: "Inspect the relevant files.",
    ...overrides,
  };
}

function message(overrides: Partial<MessageEntry> = {}): MessageEntry {
  sequence += 1;
  return {
    author: { cause: "test", kind: "platform" },
    body: "Done.",
    createdAt: at(5),
    id: `message-${sequence}`,
    kind: "message",
    messageKind: "assistant",
    runId: "run-a",
    ...overrides,
  };
}

function input(overrides: Partial<MessageEntry> = {}): MessageEntry {
  return message({
    author: { displayName: "Owner", kind: "human", principalId: "user:user-1" },
    body: "Look this up",
    messageKind: "input",
    ...overrides,
  });
}

function run(overrides: Partial<RunEntry> = {}): RunEntry {
  return {
    createdAt: at(0),
    error: null,
    id: "run:run-a",
    kind: "run",
    replyMessageId: null,
    runId: "run-a",
    status: "completed",
    ...overrides,
  };
}

function request(overrides: Partial<RequestReceiptEntry> = {}): RequestReceiptEntry {
  sequence += 1;
  return {
    createdAt: at(2),
    id: `request:request-${sequence}`,
    kind: "request",
    outcome: "Allowed",
    requestId: `request-${sequence}`,
    requestKind: "harness.approval",
    runId: "run-a",
    title: "Run pnpm test",
    ...overrides,
  };
}

function delegation(overrides: Partial<DelegationEntry> = {}): DelegationEntry {
  return {
    childRunId: "run-child",
    childThread: { id: "thread-child", title: "Sales Agent", workspaceId: "workspace-sales" },
    createdAt: at(5),
    delegationId: "delegation-1",
    delivery: { resultMessageId: createId("message"), status: "delivered" },
    failure: null,
    id: "delegation:delegation-1",
    kind: "delegation",
    outcome: "completed",
    resultPreview: "Inspection complete.",
    runId: "run-a",
    taskPreview: "Inspect the sales integrations.",
    ...overrides,
  };
}

function turns(entries: readonly TranscriptEntry[]): Turn[] {
  return groupTranscriptEntries(entries).flatMap((group) =>
    group.kind === "turn" ? [group.turn] : [],
  );
}

function shape(groups: readonly TranscriptGroup[]): unknown[] {
  return groups.map((group) =>
    group.kind === "turn"
      ? {
          key: group.key,
          reply: group.turn.reply?.id ?? null,
          run: group.turn.run?.status ?? null,
          work: group.turn.work.map((entry) => entry.id),
        }
      : `${group.kind}:${group.entry.id}`,
  );
}

describe("groupTranscriptEntries", () => {
  it("keeps model, reasoning and account changes out of the conversation, including saved history", () => {
    const selected: SelectionEntry = {
      createdAt: at(0),
      harnessInstanceId: "codex-personal",
      id: "selection-1",
      kind: "selection",
      modelSelection: ModelSelectionSchema.parse({
        modelId: "gpt-6.1-sol",
        options: { effort: "high" },
        providerId: "openai",
      }),
      providerSessionId: "session-1",
      runId: null,
    };
    const changes: SelectionEntry[] = [
      selected,
      {
        ...selected,
        id: "selection-2",
        modelSelection: { ...selected.modelSelection, options: { effort: "xhigh" } },
      },
      { ...selected, harnessInstanceId: "codex-work", id: "selection-3" },
      {
        ...selected,
        id: "selection-4",
        modelSelection: ModelSelectionSchema.parse({
          ...selected.modelSelection,
          modelId: "gpt-mini",
        }),
      },
    ];
    expect(groupTranscriptEntries(changes)).toEqual([]);
    expect(visibleTranscript(changes, null)).toEqual([]);
    expect(visibleTranscript(changes, null, { conversation: true })).toEqual([]);

    const ask = input({ runId: null });
    const answer = message({ runId: null });
    expect(shape(groupTranscriptEntries([ask, ...changes, answer]))).toEqual([
      `message:${ask.id}`,
      `message:${answer.id}`,
    ]);
  });

  it("makes one turn of a Run: all it did and wrote in order, and the reply the Host named", () => {
    const ask = input();
    const thought = reasoning();
    const first = command("ls");
    const note = message({ body: "Switching approach." });
    const second = command("pnpm test", { createdAt: at(6) });
    const answer = message({ body: "All green.", createdAt: at(7) });
    const groups = groupTranscriptEntries([
      ask,
      run({ replyMessageId: answer.id }),
      thought,
      first,
      note,
      second,
      answer,
    ]);

    expect(shape(groups)).toEqual([
      `message:${ask.id}`,
      {
        key: "turn:run:run-a",
        reply: answer.id,
        run: "completed",
        work: [thought.id, first.id, note.id, second.id, answer.id],
      },
    ]);
  });

  it("names no reply while the Run is live, and keeps what streams where it arrived", () => {
    const step = command("ls");
    const streaming = message({ body: "Looking", id: "stream:run-a", streaming: true });
    const live = run({ status: "running" });

    expect(turns([live, step, streaming])[0]).toMatchObject({
      reply: null,
      work: [step, streaming],
    });

    const next = command("pwd", { createdAt: at(6), completedAt: null, state: "running" });
    expect(turns([live, step, streaming, next])[0]).toMatchObject({
      reply: null,
      work: [step, streaming, next],
    });
  });

  it("preserves message position when a Run's reply came before its last step", () => {
    const summary = message({ body: "Here is the summary." });
    const verify = command("pnpm test", { createdAt: at(6) });
    const [settled] = turns([run({ replyMessageId: summary.id }), reasoning(), summary, verify]);
    expect(settled?.reply).toBe(summary);
    expect(settled?.work.slice(-2)).toEqual([summary, verify]);

    // While the Run is live the same words are narration: more may follow.
    const [live] = turns([run({ status: "running" }), reasoning(), summary, verify]);
    expect(live).toMatchObject({ reply: null });
    expect(live?.work).toContain(summary);
  });

  it("keeps a decision receipt after the message that preceded it", () => {
    const note = message({ body: "Waiting for that decision." });
    const receipt = request({ createdAt: at(6) });
    const [turn] = turns([run({ replyMessageId: note.id }), note, receipt]);
    expect(turn).toMatchObject({ reply: note, work: [note, receipt] });
  });

  it("splits a Run around a message sent into it, and gives the outcome to its last stretch", () => {
    const before = command("ls");
    const steer = input({ body: "Also check the tests", runId: "run-a" });
    const after = command("pnpm test", { completedAt: null, state: "running" });
    const groups = groupTranscriptEntries([run({ status: "running" }), before, steer, after]);

    expect(shape(groups)).toEqual([
      { key: "turn:run:run-a", reply: null, run: null, work: [before.id] },
      `message:${steer.id}`,
      { key: `turn:${after.id}`, reply: null, run: "running", work: [after.id] },
    ]);
    const [earlier, later] = turns([run({ status: "running" }), before, steer, after]);
    expect(earlier && turnState(earlier)).toBe("settled");
    expect(later && turnState(later)).toBe("live");
  });

  it("keeps another Thread's late result from absorbing the reply or moving the outcome", () => {
    const step = command("ls");
    const answer = message({ body: "Delegated and done." });
    const settled = delegation();
    const groups = groupTranscriptEntries([
      run({ replyMessageId: answer.id, usage: { inputTokens: 10, outputTokens: 2 } }),
      step,
      answer,
      settled,
    ]);

    expect(shape(groups)).toEqual([
      { key: "turn:run:run-a", reply: answer.id, run: "completed", work: [step.id, answer.id] },
      `delegation:${settled.id}`,
    ]);
  });

  it("shows a Run that has started but produced nothing yet, and one that finished without a reply", () => {
    expect(shape(groupTranscriptEntries([run({ status: "starting" })]))).toEqual([
      { key: "turn:run:run-a", reply: null, run: "starting", work: [] },
    ]);
    expect(shape(groupTranscriptEntries([run({ status: "completed" })]))).toEqual([
      { key: "turn:run:run-a", reply: null, run: "completed", work: [] },
    ]);
    // Its reply is on a page not loaded: nothing here to show, and nothing missing.
    expect(groupTranscriptEntries([run({ replyMessageId: "earlier-page" })])).toEqual([]);
    expect(shape(groupTranscriptEntries([run({ error: null, status: "interrupted" })]))).toEqual([
      { key: "turn:run:run-a", reply: null, run: "interrupted", work: [] },
    ]);
  });

  it("keeps messages with no Run on their own, and different Runs apart", () => {
    const orphan = message({ runId: null });
    const a = command("ls");
    const b = command("pwd", { id: "tool:run-b:x", runId: "run-b" });
    expect(shape(groupTranscriptEntries([a, orphan, b]))).toEqual([
      { key: `turn:${a.id}`, reply: null, run: null, work: [a.id] },
      `message:${orphan.id}`,
      { key: `turn:${b.id}`, reply: null, run: null, work: [b.id] },
    ]);
  });

  it("keeps a turn's key while it streams", () => {
    const live = run({ status: "running" });
    const early = groupTranscriptEntries([live])[0]?.key;
    const later = groupTranscriptEntries([
      live,
      reasoning({ state: "streaming" }),
      command("ls"),
    ])[0]?.key;
    expect(early).toBe("turn:run:run-a");
    expect(later).toBe(early);
  });

  it("keeps a later stretch's key when an earlier page arrives", () => {
    const before = command("ls");
    const steer = input({ body: "Also check the tests", runId: "run-a" });
    const after = command("pnpm test");
    const loaded = groupTranscriptEntries([after]).at(-1)?.key;
    const paged = groupTranscriptEntries([run(), before, steer, after]).at(-1)?.key;
    expect(loaded).toBe(`turn:${after.id}`);
    expect(paged).toBe(loaded);
  });
});

describe("conversationTurn", () => {
  const usage = { cachedInputTokens: 115_456, inputTokens: 1_565, outputTokens: 1_424 };
  const live = run({ status: "running", usage });
  const view = (entries: TranscriptEntry[]) => {
    const [turn] = turns(entries);
    if (!turn) throw new Error("Missing turn");
    return conversationTurn(turn);
  };

  it("keeps the answer being written out of the steps, streamed or recorded", () => {
    const streaming = message({ body: "Here", id: "stream:run-a", streaming: true });
    const recorded = message({ body: "Here it is." });
    for (const answer of [streaming, recorded]) {
      expect(view([live, answer])).toMatchObject({ composing: true, detailed: false, steps: [] });
    }
    // Usage alone is nothing to open, however the turn ended.
    expect(view([run({ replyMessageId: recorded.id, usage }), recorded])).toMatchObject({
      detailed: false,
      reply: recorded,
      steps: [],
    });
  });

  it("offers what came before the answer, and only that", () => {
    const preamble = message({ body: "Let me check." });
    const check = command("ls", { createdAt: at(6), completedAt: null, state: "running" });
    expect(view([live, preamble, check])).toMatchObject({
      detailed: true,
      steps: [preamble, check],
    });

    const answer = message({
      body: "Two files.",
      id: "stream:run-a",
      createdAt: at(7),
      streaming: true,
    });
    const done = { ...check, completedAt: at(4), state: "done" as const };
    expect(view([live, preamble, done, answer]).steps).toEqual([preamble, done]);

    // A second message makes the first one something said on the way.
    const second = message({ body: "Writing it up." });
    expect(view([live, preamble, second]).steps).toEqual([preamble]);
  });

  it("counts thinking and subagents as steps", () => {
    const thinking = reasoning({ completedAt: null, state: "streaming" });
    expect(view([live, thinking])).toMatchObject({ detailed: true, steps: [thinking] });

    const researcher: TranscriptEntry = {
      completedAt: null,
      createdAt: at(2),
      id: "node:researcher",
      kind: "node",
      model: null,
      nodeId: "researcher",
      originCallId: null,
      parentNodeId: null,
      prompt: "Research it.",
      result: null,
      runId: "run-a",
      status: "running",
      title: "researcher",
    };
    expect(view([live, researcher]).detailed).toBe(true);
  });

  it("leaves the Host's reply to name the answer once the Run has ended", () => {
    const summary = message({ body: "Here is the summary." });
    const verify = command("pnpm test");
    expect(view([run({ replyMessageId: summary.id, usage }), summary, verify])).toMatchObject({
      detailed: true,
      reply: summary,
      steps: [verify],
    });

    // Without a reply, what it wrote is among its steps, however it ended.
    const partial = message({ body: "Half an answer" });
    for (const status of ["failed", "interrupted", "completed"] as const) {
      expect(view([run({ status, usage }), partial])).toMatchObject({
        composing: false,
        detailed: true,
        reply: null,
        steps: [partial],
      });
    }
  });

  it("keeps a waiting or stopping turn's last message among its steps", () => {
    const question = message({ body: "Which account?" });
    expect(view([run({ status: "waiting" }), question]).steps).toEqual([question]);
    expect(view([run({ status: "running", stopping: true }), question]).steps).toEqual([question]);
  });
});

/*
 * A conversation while its Run takes the person's next message. What can go
 * wrong: the typing stays above a message that joined the reply in progress,
 * so it reads as if the reply ignores it; an earlier stretch whose step is
 * still running types too, and the reader sees two typing bubbles; the reply
 * an earlier turn already gave stops being a reply once the Run goes on.
 */
describe("a reply that a message joined", () => {
  it("types after the message that joined, and only there", () => {
    const ask = input({ body: "What's on Thursday?", runId: "run-a" });
    const checking = command("calendar", { completedAt: null, state: "running" });
    const joined = input({ body: "Keep it short", runId: "run-a" });
    const groups = groupTranscriptEntries([ask, run({ status: "running" }), checking, joined]);
    expect(shape(groups)).toEqual([
      `message:${ask.id}`,
      { key: "turn:run:run-a", reply: null, run: null, work: [checking.id] },
      `message:${joined.id}`,
      { key: `turn:after:${joined.id}`, reply: null, run: "running", work: [] },
    ]);
    const composing = groups.flatMap((group) =>
      group.kind === "turn" ? [conversationTurn(group.turn).composing] : [],
    );
    expect(composing).toEqual([false, true]);
  });

  it("keeps an earlier turn's reply a reply after a follow-up joins its Run", () => {
    const first = message({ body: "Design review at 2." });
    const joined = input({ body: "And Friday?", runId: "run-a" });
    const lookup = command("calendar friday");
    const second = message({ body: "Friday is clear." });
    const live = run({ status: "running", turnReplyMessageIds: [first.id] });
    const before = [run({ status: "running" }), command("calendar"), first, joined, lookup];
    const replies = (entries: TranscriptEntry[]) =>
      turns(entries).map((turn) => conversationTurn(turn).reply?.id ?? null);
    expect(replies([live, ...before.slice(1)])).toEqual([first.id, null]);
    expect(
      replies([
        run({ replyMessageId: second.id, turnReplyMessageIds: [first.id] }),
        ...before.slice(1),
        second,
      ]),
    ).toEqual([first.id, second.id]);
  });
});

/*
 * Activity: what a reply did, opened on request. What can go wrong: the
 * header opens an older reply while one is being written; the steps a Run
 * took before a message joined it are lost because they sit in a stretch with
 * no reply; a reply's Activity includes the reply itself or another reply's
 * steps; a link to a step finds no reply to open.
 */
describe("conversation Activity", () => {
  const firstAsk = input({ body: "What's on Thursday?", runId: "run-a" });
  const firstThought = reasoning();
  const firstLookup = command("calendar thursday");
  const firstReply = message({ body: "Design review at 2." });
  const secondAsk = input({ body: "Draft a note to Maya", runId: "run-b" });
  const preamble = message({ body: "Drafting it now.", runId: "run-b" });
  const drafting = command("draft", {
    createdAt: at(6),
    completedAt: null,
    runId: "run-b",
    state: "running",
  });
  const firstRun = run({ replyMessageId: firstReply.id });
  const answered = [firstAsk, firstRun, firstThought, firstLookup, firstReply];
  const secondRun = run({ id: "run:run-b", runId: "run-b", status: "running" });

  it("opens on the reply in progress, and on the latest reply once there is none", () => {
    const live = groupTranscriptEntries([...answered, secondAsk, secondRun, preamble, drafting]);
    const now = conversationActivityTurn(live, { kind: "latest" });
    expect(now).toMatchObject({ key: "turn:run:run-b", live: true, reply: null });
    expect(now?.steps.map(({ id }) => id)).toEqual([preamble.id, drafting.id]);

    const idle = groupTranscriptEntries(answered);
    const latest = conversationActivityTurn(idle, { kind: "latest" });
    expect(latest).toMatchObject({ key: "turn:run:run-a", live: false, reply: firstReply });
    expect(latest?.steps.map(({ id }) => id)).toEqual([firstThought.id, firstLookup.id]);
  });

  it("opens one reply's own steps by its turn, and nothing for a turn it does not hold", () => {
    const groups = groupTranscriptEntries([...answered, secondAsk, secondRun, preamble, drafting]);
    const chosen = conversationActivityTurn(groups, { key: "turn:run:run-a", kind: "turn" });
    expect(chosen?.steps.map(({ id }) => id)).toEqual([firstThought.id, firstLookup.id]);
    expect(chosen?.turn.reply).toBe(firstReply);
    expect(conversationActivityTurn(groups, { key: "turn:gone", kind: "turn" })).toBeNull();
    expect(conversationActivityTurn([], { kind: "latest" })).toBeNull();
  });

  it("gathers a reply's steps from every stretch of its Run since the reply before it", () => {
    const before = command("calendar");
    const joined = input({ body: "Keep it short", runId: "run-a" });
    const after = command("draft");
    const reply = message({ body: "Here it is." });
    const groups = groupTranscriptEntries([
      firstAsk,
      run({ replyMessageId: reply.id }),
      before,
      joined,
      after,
      reply,
    ]);
    const viaReply = conversationActivityTurn(groups, { key: `turn:${after.id}`, kind: "turn" });
    const viaEarlier = conversationActivityTurn(groups, { key: "turn:run:run-a", kind: "turn" });
    expect(viaReply?.steps.map(({ id }) => id)).toEqual([before.id, after.id]);
    expect(viaEarlier?.key).toBe(viaReply?.key);
    expect(viaReply?.reply).toBe(reply);

    // A turn that answered while its Run went on is an exchange of its own.
    const early = message({ body: "On it." });
    const split = groupTranscriptEntries([
      firstAsk,
      run({ replyMessageId: reply.id, turnReplyMessageIds: [early.id] }),
      before,
      early,
      joined,
      after,
      reply,
    ]);
    expect(
      conversationActivityTurn(split, { key: "turn:run:run-a", kind: "turn" })?.steps.map(
        ({ id }) => id,
      ),
    ).toEqual([before.id]);
    expect(conversationActivityTurn(split, { kind: "latest" })?.steps.map(({ id }) => id)).toEqual([
      after.id,
    ]);
  });

  it("finds the reply whose Activity holds a message said on the way", () => {
    const onTheWay = message({ body: "Checking your calendar." });
    const groups = groupTranscriptEntries([
      firstAsk,
      run({ replyMessageId: firstReply.id }),
      onTheWay,
      firstLookup,
      firstReply,
    ]);
    expect(conversationTurnRevealing(groups, onTheWay.id)).toBe("turn:run:run-a");
    // The reply itself is in the conversation; nothing needs opening for it.
    expect(conversationTurnRevealing(groups, firstReply.id)).toBeNull();
    expect(conversationTurnRevealing(groups, "message-elsewhere")).toBeNull();
  });

  it("types once, in the reply at work, when a waiting message is drawn after it", () => {
    const waiting = input({ body: "And Friday?", runId: null });
    const groups = groupTranscriptEntries([firstAsk, secondRun, drafting, waiting]);
    expect(groups.at(-1)).toMatchObject({ kind: "message" });
    expect(threadActivityIndicator("working", { conversation: true, groups })).toBeNull();
  });
});

describe("workSummary", () => {
  it.each(["queued", "starting", "running", "waiting"] as const)(
    "only holds queued activity behind a paused queue (%s)",
    (status) => {
      const entries = [run({ status })];
      const paused = groupTranscriptEntries(entries, { inputQueuePaused: true })[0];
      const resumed = groupTranscriptEntries(entries, { inputQueuePaused: false })[0];
      expect(paused?.kind).toBe("turn");
      expect(resumed?.kind).toBe("turn");
      if (paused?.kind !== "turn" || resumed?.kind !== "turn") throw new Error("Missing turn");
      expect(turnState(paused.turn)).toBe(
        status === "queued" ? "settled" : status === "waiting" ? "waiting" : "live",
      );
      expect(conversationTurn(paused.turn).composing).toBe(
        status === "starting" || status === "running",
      );
      if (status === "queued") {
        expect(workSummary(paused.turn)).toBeNull();
        expect(turnState(resumed.turn)).toBe("live");
        expect(conversationTurn(resumed.turn).composing).toBe(true);
      }
    },
  );

  it("says what is happening while live", () => {
    const live = run({ status: "running" });
    const turn = (entries: TranscriptEntry[]): Turn => turns([live, ...entries])[0]!;

    expect(workSummary(turn([]))).toMatchObject({ label: "Working", state: "live" });
    expect(workSummary(turns([run({ status: "starting" })])[0]!)?.label).toBe("Starting");
    expect(workSummary(turn([reasoning({ completedAt: null, state: "streaming" })]))?.label).toBe(
      "Thinking",
    );
    expect(
      workSummary(turn([command("pnpm test", { completedAt: null, state: "running" })]))?.label,
    ).toBe("Running a command");
    expect(
      workSummary(
        turn([
          tool({
            arguments: { command: "pnpm test", description: "Run the unit tests." },
            completedAt: null,
            state: "running",
            tool: { name: "Bash", namespace: "claude" },
          }),
        ]),
      )?.label,
    ).toBe("Run the unit tests");
    expect(
      workSummary(turn([command("ls"), message({ id: "stream:run-a", streaming: true })]))?.label,
    ).toBe("Writing");
    expect(workSummary(turns([run({ status: "waiting" })])[0]!)).toMatchObject({
      label: "Waiting for you",
      state: "waiting",
    });
    expect(workSummary(turns([run({ status: "running", stopping: true })])[0]!)).toMatchObject({
      label: "Stopping",
      state: "stopping",
    });
  });

  it("says only how long the work took once settled", () => {
    const summary = workSummary(
      turns([
        run(),
        reasoning(),
        command("ls", { completedAt: at(20) }),
        command("pnpm test", { isError: true, state: "failed" }),
        tool({ arguments: { file_path: "a.ts" }, tool: { name: "Read", namespace: "claude" } }),
        tool({ arguments: { file_path: "b.ts" }, tool: { name: "Edit", namespace: "claude" } }),
        tool({ arguments: { file_path: "b.ts" }, tool: { name: "Write", namespace: "claude" } }),
        tool({ arguments: { query: "x" }, tool: { name: "WebSearch", namespace: "claude" } }),
        message(),
      ])[0]!,
    );
    expect(summary).toEqual({ label: "Worked for 20s", state: "settled" });
  });

  // A turn that only answered once drew a bare "Thought" under its reply.
  it("has no status line for a turn that settled on its reply alone", () => {
    const reply = message();
    for (const status of ["completed", "failed", "interrupted"] as const) {
      expect(workSummary(turns([run({ replyMessageId: reply.id, status }), reply])[0]!)).toBeNull();
    }
    expect(
      workSummary(turns([run({ replyMessageId: reply.id }), reasoning(), reply])[0]!)?.label,
    ).toBe("Thought for 3s");
    expect(workSummary(turns([run({ endedAt: at(9), startedAt: at(1) })])[0]!)?.label).toBe(
      "Worked for 8s",
    );
    expect(workSummary(turns([run()])[0]!)?.label).toBe("Worked");
  });

  // The ways it could fail: a decision made long after the Run ended counted as
  // work; the time an engine stood waiting on a live Request counted as work;
  // two waits at once taken off twice.
  it("does not count the time a person took to decide", () => {
    const decidedHoursLater = new Date(Date.UTC(2026, 7, 16, 12, 17, 0)).toISOString();
    expect(
      workSummary(
        turns([
          run(),
          reasoning(),
          command("ls", { completedAt: at(5) }),
          request({ createdAt: decidedHoursLater, requestKind: "integration.install" }),
        ])[0]!,
      )?.label,
    ).toBe("Worked for 5s");

    const approved = request({ createdAt: at(32), waitedSince: at(2) });
    const waitedOnce = [run(), reasoning(), command("pnpm publish", { completedAt: at(40) })];
    expect(workSummary(turns([...waitedOnce, approved])[0]!)?.label).toBe("Worked for 10s");
    expect(
      workSummary(
        turns([...waitedOnce, approved, request({ createdAt: at(35), waitedSince: at(10) })])[0]!,
      )?.label,
    ).toBe("Worked for 7s");
  });
});

describe("a task's turn", () => {
  // The ways it could fail: a live turn showing every step as it streams; a
  // turn split by a message keeping its steps open; folding hiding what the
  // agent wrote along the way; a reply alone growing a "Worked" line.
  it("folds every step behind its status line and keeps everything the agent wrote", () => {
    const note = message({ body: "Checking tonight first.", id: "note" });
    const reply = message({ body: "Dhamaka has 9:45.", id: "reply" });
    const working = turns([
      run({ status: "running" }),
      note,
      command("ls", { completedAt: null, state: "running" }),
    ])[0]!;
    expect(turnFolds(working)).toBe(true);
    expect(turnWords(working)).toEqual([note]);
    expect(workSummary(working)?.label).toBe("Running a command");

    const answered = turns([run({ replyMessageId: "reply" }), note, command("ls"), reply])[0]!;
    expect(turnWords(answered)).toEqual([note, reply]);
    expect(workSummary(answered)?.label).toBe("Worked for 4s");

    const joined = groupTranscriptEntries([
      run({ status: "running" }),
      command("ls"),
      input({ body: "Check tonight first." }),
    ]).find((group) => group.kind === "turn");
    if (joined?.kind !== "turn") throw new Error("Missing turn");
    expect(joined.turn.continued).toBe(true);
    expect(turnFolds(joined.turn)).toBe(true);

    // Words alone, however many, leave nothing to open.
    const spoken = turns([run({ replyMessageId: "reply" }), note, reply])[0]!;
    expect(turnFolds(spoken)).toBe(false);
    expect(workSummary(spoken)).toBeNull();
  });
});

describe("Opensteer's own steps", () => {
  const opensteer = (name: string, args: Record<string, unknown> = {}) =>
    toolPresentation(tool({ arguments: args, tool: { name, namespace: "opensteer" } }));

  it("say what an action did, not which tool did it", () => {
    expect(opensteer("browser_tab_write", { action: "restore", tabIds: ["t1"] })).toMatchObject({
      activeLabel: "Restoring tabs",
      hint: "",
      label: "Restored tabs",
    });
    expect(opensteer("thread_write", { action: "rename", title: "Tonight" })).toMatchObject({
      hint: "Tonight",
      hintKind: "prose",
      label: "Renamed a task",
    });
    expect(opensteer("trigger_write", { action: "pause_all" }).label).toBe("Changed an automation");
    expect(opensteer("thread_message").label).toBe("Sent a message");
  });
});

describe("workRows", () => {
  it("keeps reasoning between separate tool groups in arrival order", () => {
    const opening = reasoning();
    const first = command("ls");
    const between = reasoning();
    const second = command("pwd", { isError: true, state: "failed" });
    const rows = workRows([opening, first, between, second]);

    expect(rows.map((row) => row.key)).toEqual([
      `reasoning:${opening.id}`,
      `row:${first.id}`,
      `reasoning:${between.id}`,
      `row:${second.id}`,
    ]);
    expect(rows[1]).toMatchObject({
      entries: [first],
      head: { errors: 0, icon: "terminal", label: "Ran a command", tone: "done" },
      kind: "steps",
    });
    expect(rows[0]).toMatchObject({ kind: "reasoning", entry: opening });
    expect(rows[2]).toMatchObject({ kind: "reasoning", entry: between });
  });

  it("gathers reads, searches and listings as exploring, across engines", () => {
    const rows = workRows([
      tool({ arguments: { file_path: "a.ts" }, tool: { name: "Read", namespace: "claude" } }),
      tool({ arguments: { pattern: "foo" }, tool: { name: "grep", namespace: "opencode" } }),
      tool({ arguments: { path: "src" }, tool: { name: "ls", namespace: "pi" } }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      head: { detail: "1 file, 2 searches", icon: "search", label: "Explored" },
    });
  });

  it("lets a note, a decision, or a different kind of step start a new row", () => {
    const note = message({ body: "Page control is off; reading the public page." });
    const decided = request();
    const rows = workRows([
      command("ls"),
      note,
      command("pwd"),
      decided,
      reasoning(),
      tool({
        arguments: { fresh: true },
        tool: { name: "browser_session_open", namespace: "opensteer" },
      }),
      reasoning(),
    ]);
    expect(rows.map((row) => (row.kind === "steps" ? row.head.label : row.kind))).toEqual([
      "Ran a command",
      "note",
      "Ran a command",
      "Run pnpm test",
      "reasoning",
      "Opened a browser",
      "reasoning",
    ]);
    expect(rows.at(-1)).toMatchObject({ kind: "reasoning" });
  });
});

/*
 * How a `sign_in` step could mislead the reader:
 * - a failed, declined, unavailable or not-signed-in result reads as done
 *   (a check, tone done, or "Done");
 * - a result the client cannot read, or an error, reads as signed in;
 * - a code the agent is fetching reads as a failure, or as signed in;
 * - a pending result reads as signed in, or loses what it waits for;
 * - its words differ from the Request card's for the same outcome.
 */
describe.each(["sign_in", "browser_sign_in"])("a %s step", (name) => {
  const signIn = (result: unknown, overrides: Partial<ToolEntry> = {}) =>
    tool({
      arguments: { reason: "Download the invoice", sessionId: "bss_1", site: "https://github.com" },
      output: { text: JSON.stringify(result) },
      tool: { name, namespace: "opensteer" },
      ...overrides,
    });
  const head = (entry: ToolEntry) => {
    const { detail, icon, label, tone } = activityStepHead(entry);
    return { detail, icon, label, status: toolStatusLabel(entry), tone };
  };

  it("says it signed in only when it did", () => {
    expect(
      head(signIn({ method: "saved-password", site: "https://github.com", status: "signed-in" })),
    ).toEqual({
      detail: "With your saved password",
      icon: "check-circle",
      label: "Signed in to github.com",
      status: "Done",
      tone: "done",
    });
    expect(
      head(signIn({ method: "person", site: "https://github.com", status: "signed-in" })),
    ).toMatchObject({ icon: "check-circle", label: "You signed in to github.com", tone: "done" });
    expect(
      head(
        signIn({
          profileName: null,
          site: "https://github.com",
          sourceName: "Work",
          status: "applied",
        }),
      ),
    ).toMatchObject({ detail: "From Work", label: "Signed in to github.com", tone: "done" });
  });

  it.each([
    [
      { reason: "wrong-password", site: "https://github.com", status: "failed" },
      "github.com didn’t accept the saved password",
    ],
    [
      { reason: "unsupported-page", site: "https://github.com", status: "failed" },
      "Opensteer couldn’t find where to sign in on github.com",
    ],
    [
      { reason: "needs-approval", site: "https://github.com", status: "unavailable" },
      "A task or automation can’t ask you to allow a sign-in",
    ],
    [
      { reason: "no-code-expected", site: "https://github.com", status: "unavailable" },
      "No sign-in was waiting for a code",
    ],
    [
      { reason: "needs-fresh-session", site: "https://github.com", status: "unavailable" },
      "This needs a new browser session. Ask your agent to open one and try again",
    ],
    [
      { reason: "session-closed", site: "https://github.com", status: "unavailable" },
      "The agent’s browser closed",
    ],
    [
      { site: "https://github.com", status: "not-signed-in" },
      "Chrome isn’t signed in to github.com",
    ],
  ])("never reads %o as done", (result, detail) => {
    expect(head(signIn(result))).toEqual({
      detail,
      icon: "alert-circle",
      label: "Couldn’t sign in to github.com",
      status: "Didn’t sign in",
      tone: "stopped",
    });
  });

  it("says a decline as the card does", () => {
    expect(head(signIn({ requestId: createId("request"), status: "declined" }))).toMatchObject({
      icon: "alert-circle",
      label: "Not allowed",
      status: "Didn’t sign in",
      tone: "stopped",
    });
  });

  it("says a code the agent is fetching, and what a pending sign-in waits for", () => {
    expect(
      head(
        signIn({
          expiresAt: "2026-10-13T12:05:00.000Z",
          site: "https://github.com",
          status: "needs-code",
        }),
      ),
    ).toMatchObject({
      icon: "browser",
      label: "github.com sent a code; the agent is getting it",
      status: "Done",
      tone: "done",
    });
    const requestId = createId("request");
    expect(
      head(signIn({ replayed: false, requestId, status: "pending", waitingFor: "approval" })),
    ).toMatchObject({ icon: "browser", label: "Asked you to sign in to github.com" });
    expect(
      head(signIn({ replayed: false, requestId, status: "pending", waitingFor: "person" })),
    ).toMatchObject({ label: "github.com needs you to finish signing in" });
    expect(
      head(signIn({ replayed: true, requestId, status: "pending", waitingFor: "code" })),
    ).toMatchObject({ label: "github.com needs you to finish signing in" });
    expect(head(signIn({ requestId, status: "resolved" }))).toMatchObject({
      detail: "Already answered",
      label: "Asked to sign in to github.com",
    });
  });

  it.each([
    { code: "123456", site: "https://github.com", reason: "Read the invoice" },
    '{"site":"https://github.com","code":"123456"}',
    '{"site":"https://github.com","code":"123',
  ])("masks a one-time code in displayed step arguments: %o", (arguments_) => {
    const entry = signIn({ status: "needs-code" }, { arguments: arguments_ });
    const body = toolBody(entry);
    expect(body.argumentsText).not.toContain("123");
    expect(body.argumentsText).toContain("[hidden]");
    expect(entry.arguments).toEqual(arguments_);
  });

  it("never reads unreadable output, an error or a stopped call as signed in", () => {
    expect(head(signIn({ site: "https://github.com", status: "signed-in" }))).toMatchObject({
      icon: "browser",
      label: "Tried to sign in to github.com",
    });
    expect(
      head(signIn("signed in", { output: { text: "Signed in to github.com" } })),
    ).toMatchObject({ icon: "browser", label: "Tried to sign in to github.com" });
    expect(
      head(
        signIn(
          { method: "saved-password", site: "https://github.com", status: "signed-in" },
          { isError: true, state: "failed" },
        ),
      ),
    ).toMatchObject({ label: "Tried to sign in to github.com", tone: "error" });
    expect(
      head(signIn(null, { completedAt: null, output: undefined, state: "running" })),
    ).toMatchObject({ label: "Signing in to github.com", tone: "running" });
  });
});

describe("toolPresentation", () => {
  it("reads every engine's shell the same way", () => {
    const presentations = [
      ["codex", "shell"],
      ["claude", "Bash"],
      ["cursor", "shell"],
      ["pi", "bash"],
      ["pi", "powershell"],
      ["opencode", "bash"],
    ].map(([namespace, name]) =>
      toolPresentation(
        tool({ arguments: { command: "pnpm test" }, tool: { name: name!, namespace: namespace! } }),
      ),
    );
    for (const presentation of presentations) {
      expect(presentation).toEqual(presentations[0]);
    }
    expect(presentations[0]).toMatchObject({
      command: "pnpm test",
      hint: "pnpm test",
      icon: "terminal",
      kind: "command",
      label: "Ran a command",
    });
  });

  it("uses the engine's own description of a command", () => {
    expect(
      toolPresentation(
        tool({
          arguments: { command: "cd /repo && pnpm test", description: "run the unit tests." },
          tool: { name: "bash", namespace: "opencode" },
        }),
      ),
    ).toMatchObject({
      activeLabel: "Run the unit tests",
      command: "cd /repo && pnpm test",
      describes: true,
      hint: "pnpm test",
      label: "Run the unit tests",
    });
  });

  it("reads what Codex parsed a command to be", () => {
    const codex = (commandActions: unknown[]): ToolEntry =>
      tool({ arguments: { command: "/bin/zsh -lc 'cat src/a.ts'", commandActions } });

    expect(
      toolPresentation(
        codex([{ command: "cat src/a.ts", name: "a.ts", path: "src/a.ts", type: "read" }]),
      ),
    ).toMatchObject({
      command: "cat src/a.ts",
      hint: "src/a.ts",
      icon: "file",
      kind: "read",
      label: "Read a.ts",
      paths: ["src/a.ts"],
    });
    expect(
      toolPresentation(
        codex([{ command: "rg foo src", path: "src", query: "foo", type: "search" }]),
      ),
    ).toMatchObject({ kind: "search", label: "Searched for foo" });
    expect(
      toolPresentation(codex([{ command: "ls src", path: "src", type: "listFiles" }])),
    ).toMatchObject({ kind: "list", label: "Listed files" });
    // Mixed or unknown parts are a command.
    expect(
      toolPresentation(
        codex([
          { command: "cat a.ts", name: "a.ts", path: "a.ts", type: "read" },
          { command: "pnpm test", type: "unknown" },
        ]),
      ),
    ).toMatchObject({ kind: "command", label: "Ran a command" });
  });

  it("presents fitted tool arguments without losing their meaning", () => {
    const script = `python3 - <<'PY'\n# script head\n${"# process another row\n".repeat(30_000)}print("script tail")\nPY`;
    // Codex joins the command with shlex, which double-quotes a script holding a `'`.
    const wrapped = `/bin/zsh -lc "${script.replace(/[\\"$`]/gu, "\\$&")}"`;
    const codex = (command: string, commandActions: unknown[]): ToolEntry =>
      tool({ arguments: createToolArguments({ command, cwd: "/repo", commandActions }) });
    const fitted = toolPresentation(codex(wrapped, [{ type: "unknown" }]));
    expect(fitted.kind).toBe("command");
    expect(fitted.command?.slice(0, 31)).toBe(script.slice(0, 31));
    expect(fitted.command?.endsWith('print("script tail")\nPY')).toBe(true);
    expect(fitted.command).toMatch(/\n… \d+ bytes omitted …\n/u);

    const smallScript = 'python3 -c "print(1)"';
    const generic = toolPresentation(codex(smallScript, [{ type: "unknown" }]));
    expect(generic).toEqual(
      toolPresentation(codex(smallScript, [{ type: "unknown", command: smallScript }])),
    );
    expect(generic).toMatchObject({
      command: smallScript,
      kind: "command",
      label: "Ran a command",
    });

    const write = tool({
      arguments: createToolArguments({
        content: "x".repeat(1_024 * 1_024),
        file_path: "src/report.py",
      }),
      tool: { name: "Write", namespace: "claude" },
    });
    expect(toolPresentation(write)).toMatchObject({
      label: "Edited report.py",
      paths: ["src/report.py"],
    });
    expect(toolBody(write).argumentsText.length).toBeLessThanOrEqual(20_001);
    expect(toolBody(write).argumentsText).toContain('"file_path": "src/report.py"');

    const integration = tool({
      arguments: createToolArguments({
        toolRef: "igr_private.itl_private.operation",
        arguments: { rows: Array.from({ length: 20_000 }, (_, id) => ({ id })) },
      }),
      tool: { name: "integration_call", namespace: "opensteer.integrations" },
    });
    expect(integration.arguments).toMatchObject({
      arguments: expect.stringMatching(/… \d+ bytes omitted …/u),
    });
    const input = toolArgumentsText(integration);
    expect(input).toContain('{"id":19999}');
    expect(input).not.toMatch(/toolRef|igr_private/u);
    expect(toolBody(integration).argumentsText).toBe(input);
    expect(input.length).toBeLessThanOrEqual(20_001);
  });

  it("names each engine's file tools by what they do", () => {
    const cases: [string, string, Record<string, unknown>, string][] = [
      ["claude", "Read", { file_path: "a.ts" }, "read"],
      ["cursor", "read", { path: "a.ts" }, "read"],
      ["pi", "read", { path: "a.ts" }, "read"],
      ["opencode", "read", { filePath: "a.ts" }, "read"],
      ["claude", "Grep", { pattern: "x" }, "search"],
      ["cursor", "glob", { globPattern: "*.ts" }, "list"],
      ["pi", "find", { pattern: "*.ts" }, "list"],
      ["codex", "apply_patch", { changes: { "a.ts": {} } }, "edit"],
      ["opencode", "write", { filePath: "a.ts" }, "edit"],
      ["claude", "WebSearch", { query: "opencode" }, "web-search"],
      ["opencode", "webfetch", { url: "https://example.com" }, "web-page"],
      ["claude", "TodoWrite", { todos: [] }, "plan"],
      ["claude", "Task", { description: "Review" }, "delegate"],
    ];
    for (const [namespace, name, args, kind] of cases) {
      expect(toolPresentation(tool({ arguments: args, tool: { name, namespace } })).kind).toBe(
        kind,
      );
    }
    expect(
      toolPresentation(
        tool({
          arguments: { file_path: "src/app.ts" },
          tool: { name: "Edit", namespace: "claude" },
        }),
      ),
    ).toMatchObject({ hint: "src/app.ts", label: "Edited app.ts", paths: ["src/app.ts"] });
  });

  it("tells a Codex page visit from a web search", () => {
    expect(
      toolPresentation(
        tool({
          arguments: {
            action: { type: "openPage", url: "https://en.wikipedia.org/wiki/OpenCode" },
          },
          tool: { name: "web_search", namespace: "codex" },
        }),
      ),
    ).toMatchObject({ hint: "https://en.wikipedia.org/wiki/OpenCode", kind: "web-page" });
    expect(
      toolPresentation(
        tool({
          arguments: { action: { query: "opencode", type: "search" }, query: "opencode" },
          tool: { name: "web_search", namespace: "codex" },
        }),
      ),
    ).toMatchObject({ hint: "opencode", kind: "web-search", label: "Searched the web" });
  });

  it("reads an unknown tool by its own name", () => {
    expect(
      toolPresentation(
        tool({
          arguments: { target: "release" },
          tool: { name: "acme_do_thing", namespace: "future" },
        }),
      ),
    ).toMatchObject({ hint: "release", icon: "sparkles", kind: "tool", label: "Acme do thing" });
    expect(
      toolPresentation(tool({ tool: { name: "list_channels", namespace: "mcp:acme" } })),
    ).toMatchObject({ icon: "puzzle", label: "List channels" });
  });

  it("gives Codex and Claude plan updates the same presentation", () => {
    const codex = tool({
      arguments: { plan: [{ status: "in_progress", step: "Wire the reducer" }] },
      tool: { name: "update_plan", namespace: "codex.dynamic" },
    });
    const claude = tool({
      arguments: { todos: [{ content: "Wire the reducer", status: "in_progress" }] },
      tool: { name: "TodoWrite", namespace: "claude" },
    });
    expect(toolPresentation(codex)).toEqual(toolPresentation(claude));
    expect(toolPresentation(codex)).toMatchObject({
      hint: "Wire the reducer",
      label: "Updated the plan",
    });
  });
});

describe("displayCommand", () => {
  it("unwraps the login shell an engine runs every command in", () => {
    expect(displayCommand(`/bin/zsh -lc "cat '/Applications/Opensteer Beta.app/SKILL.md'"`)).toBe(
      "cat '/Applications/Opensteer Beta.app/SKILL.md'",
    );
    expect(displayCommand(`bash -lc 'rg "foo bar" src'`)).toBe(`rg "foo bar" src`);
    expect(displayCommand(`/bin/bash -c 'echo '\\''hi'\\'''`)).toBe("echo 'hi'");
    expect(displayCommand(`zsh -lc "echo \\"\\$HOME\\""`)).toBe(`echo "$HOME"`);
    expect(displayCommand("sh -c ls -la")).toBe("ls -la");
    expect(displayCommand("  pnpm test  ")).toBe("pnpm test");
    expect(displayCommand("python -c 'print(1)'")).toBe("python -c 'print(1)'");
    // More than one quoted word is more than a script; it is shown as run.
    expect(displayCommand(`sh -c 'echo $0' 'arg'`)).toBe(`'echo $0' 'arg'`);
    expect(displayCommand(`bash -c "echo "hi" there"`)).toBe(`"echo "hi" there"`);
  });

  it("unwraps an argv command too", () => {
    expect(
      toolPresentation(tool({ arguments: { command: ["bash", "-lc", "pnpm build"] } })).command,
    ).toBe("pnpm build");
    expect(toolPresentation(tool({ arguments: { command: ["git", "status"] } })).command).toBe(
      "git status",
    );
    expect(
      toolPresentation(tool({ arguments: { command: ["git", "commit", "-m", "it's done"] } }))
        .command,
    ).toBe(`git commit -m 'it'\\''s done'`);
  });
});

describe("activityStepHead", () => {
  it("offers a browser's surface only once it opened", () => {
    const opened = tool({
      arguments: { fresh: true },
      tool: { name: "browser_session_open", namespace: "opensteer" },
    });
    expect(activityStepHead(opened).surface).toBe("browser");
    expect(
      activityStepHead({ ...opened, completedAt: null, state: "running" }).surface,
    ).toBeUndefined();
    expect(activityStepHead({ ...opened, isError: true, state: "failed" }).surface).toBeUndefined();
  });
  it("never marks a sign-in that did not sign in as done", () => {
    const signIn = {
      requestKind: "browser.password-sign-in" as const,
      title: "Sign in to github.com",
    };
    expect(activityStepHead(request({ ...signIn, succeeded: true })).icon).toBe("check-circle");
    expect(activityStepHead(request({ ...signIn, succeeded: false }))).toMatchObject({
      icon: "alert-circle",
      tone: "stopped",
    });
    // A Request whose answer is only a decision keeps the decided mark.
    expect(activityStepHead(request()).icon).toBe("check-circle");
  });
});

/* ---- Computer use and the integration gateway ---- */

const agent: MessageEntry["author"] = { cause: "test", kind: "platform" };
const slackRun = run({ createdAt: "2026-08-06T23:28:03.500Z", id: "run:run-cu", runId: "run-cu" });

function slackTurn(state: "running" | "settled", entries?: TranscriptEntry[]): Turn {
  const turn = entries ?? mockComputerUseTurn({ agent, runId: "run-cu", state });
  // A completed Run names its reply as the Host does: the last message it wrote.
  const reply = turn.findLast((entry) => entry.kind === "message");
  const [only] = turns([
    state === "running"
      ? { ...slackRun, status: "running" }
      : { ...slackRun, replyMessageId: reply?.id ?? null, status: "completed" },
    ...turn,
  ]);
  if (!only) throw new Error("The Computer use session is one turn");
  return only;
}

function rowShape(rows: readonly ReturnType<typeof workRows>[number][]): unknown[] {
  return rows.map((row) =>
    row.kind === "steps"
      ? {
          detail: row.head.detail,
          errors: row.head.errors,
          group: row.group,
          label: row.head.label,
          steps: row.entries.length,
          tone: row.head.tone,
        }
      : row.kind,
  );
}

function gatewayTools(turn: Turn): ToolEntry[] {
  return turn.work.filter((entry): entry is ToolEntry => entry.kind === "tool");
}

function result(
  performed: readonly string[] | null,
  options: { app?: string; stoppedBecause?: string } = {},
): string {
  return `${formatComputerUseResultHead({
    appName: options.app ?? "Slack",
    elementCount: 214,
    geometry: { height: 904, width: 1440 },
    snapshot: "4cf039beba5b8d92",
    performed,
    stoppedBecause: options.stoppedBecause ?? null,
    truncated: false,
    windowTitle: "general - Slack",
  })}\n[0] window "general - Slack" (0,0 1440×904)`;
}

/** A batch that stopped with no observation to show for it, as the Host words it. */
function withoutObservation(performed: readonly string[], stoppedBecause: string): string {
  return `${computerUseActHeadline({ performed, stoppedBecause })}\n${performed.length} action${performed.length === 1 ? "" : "s"} completed before the batch stopped. The failed action may also have partially changed the app; observe the app before acting further.`;
}

function computerStep(
  operation: "act" | "observe",
  overrides: Partial<ToolEntry> & { place?: IntegrationCallSubject["computerApp"] } = {},
): ToolEntry {
  const { place, ...rest } = overrides;
  return tool({
    arguments: { arguments: {}, toolRef: mockComputerUseToolRefs[0] },
    integration: mockComputerUseSubject(operation, place ?? mockComputerUseSlack),
    output: { text: result(operation === "observe" ? null : ['Clicked "Save"']) },
    tool: { name: "integration_call", namespace: "opensteer.integrations" },
    ...rest,
  });
}

describe("a Computer use turn", () => {
  it("reads the real Slack session as the agent's note, one lookup row, one Slack row and its reply", () => {
    const turn = slackTurn("settled");
    expect(rowShape(workRows(turn.work))).toEqual([
      "note",
      {
        detail: 'for "Computer use" and "Slack"',
        errors: 1,
        group: "integrations",
        label: "Listed apps on a Mac",
        steps: 3,
        tone: "done",
      },
      {
        // Looking up how to act is in the row, but it was not done in Slack.
        detail: "9 steps on Alex's MacBook Pro",
        errors: 1,
        group: "computer",
        label: "Used Slack",
        steps: 10,
        tone: "done",
      },
      "note",
    ]);
    expect(turn.reply).toBe(turn.work.at(-1));
  });

  it("says only how long it worked, however many of its steps failed", () => {
    expect(workSummary(slackTurn("settled"))).toEqual({
      label: "Worked for 1m 22s",
      state: "settled",
    });
  });

  it("never shows an integration reference", () => {
    for (const state of ["running", "settled"] as const) {
      const turn = slackTurn(state);
      const shown = [
        ...workRows(turn.work).flatMap((row) =>
          row.kind === "steps" ? [row.head.label, row.head.detail] : [],
        ),
        ...gatewayTools(turn).flatMap((entry) => {
          const head = activityStepHead(entry);
          const body = toolBody(entry);
          const feed = activityFeedPresentation(entry);
          const presentation = toolPresentation(entry);
          return [
            head.label,
            head.detail,
            presentation.activeLabel,
            presentation.hint,
            body.summary,
            body.argumentsText,
            feed.detail,
          ];
        }),
        workSummary(turn)?.label,
      ];
      for (const text of shown) {
        expect(text).not.toMatch(/igr_|itl_/u);
        for (const reference of mockComputerUseToolRefs) expect(text).not.toContain(reference);
      }
    }
  });

  it("keeps the live step in the Slack row's head while it runs", () => {
    const acting = slackTurn("running");
    const rows = workRows(acting.work);
    // The live step says what it is doing, once: the head names the app, the
    // detail and the turn's status name the action, and nothing names the
    // step before it.
    expect(rowShape(rows).at(-1)).toEqual({
      detail: "Clicking in Slack",
      errors: 1,
      group: "computer",
      label: "Using Slack",
      steps: 9,
      tone: "running",
    });
    const [, , slack] = rows;
    if (slack?.kind !== "steps") throw new Error("expected the Slack row");
    expect(activityStepHead(slack.entries.at(-1)!).label).toBe("Clicking in Slack");
    // The turn's own status says where, because nothing beside it does.
    expect(workSummary(acting)).toMatchObject({
      label: "Clicking in Slack on Alex's MacBook Pro",
      state: "live",
    });
    // The row keeps its key as the turn streams, so a reader's open row stays open.
    expect(rows.at(-1)?.key).toBe(workRows(slackTurn("settled").work).at(-2)?.key);

    const settled = mockComputerUseTurn({ agent, runId: "run-cu", state: "settled" });
    const lastLook = settled.at(-2);
    if (lastLook?.kind !== "tool") throw new Error("expected the final observe");
    const looking = slackTurn("running", [
      ...settled.slice(0, -2),
      { ...lastLook, completedAt: null, output: undefined, state: "running" },
    ]);
    expect(rowShape(workRows(looking.work)).at(-1)).toMatchObject({
      detail: "Looking at Slack",
      label: "Using Slack",
      tone: "running",
    });
    expect(workSummary(looking)?.label).toBe("Looking at Slack on Alex's MacBook Pro");
  });

  it("paints a row by its latest step", () => {
    const stopped = computerStep("act", {
      isError: true,
      output: {
        text: result([], { stoppedBecause: "Another window of this app came to the front." }),
      },
      state: "failed",
    });
    const [recovered] = workRows([stopped, computerStep("observe")]);
    expect(recovered).toMatchObject({ head: { errors: 0, label: "Used Slack", tone: "done" } });
    const [endedOnStop] = workRows([computerStep("observe"), stopped]);
    expect(endedOnStop).toMatchObject({ head: { errors: 0, tone: "stopped" } });
    const broken = computerStep("act", {
      isError: true,
      output: { text: withoutObservation(['Clicked "Send"'], "Slack quit.") },
      state: "failed",
    });
    const [endedOnError] = workRows([computerStep("observe"), broken]);
    expect(endedOnError).toMatchObject({ head: { errors: 1, tone: "error" } });
    const [partly] = workRows([
      computerStep("act", {
        isError: true,
        output: {
          text: result(['Clicked "Save"'], {
            stoppedBecause: "Another window of this app came to the front.",
          }),
        },
        state: "failed",
      }),
    ]);
    expect(partly).toMatchObject({
      head: {
        errors: 0,
        label: 'Clicked "Save", then stopped. Another window of this app came to the front.',
        tone: "stopped",
      },
    });
  });

  it("keeps two apps, and one app on two Macs, apart", () => {
    const notes = {
      app: "Notes",
      bundleId: "com.apple.Notes",
      computer: "Alex's MacBook Pro",
      runnerId: mockComputerUseSlack.runnerId,
    };
    const interleaved = workRows([
      computerStep("observe"),
      computerStep("observe", { place: notes, output: { text: result(null, { app: "Notes" }) } }),
      computerStep("act"),
    ]);
    expect(interleaved.map((row) => (row.kind === "steps" ? row.head.label : row.kind))).toEqual([
      "Looked at Slack",
      "Looked at Notes",
      'Clicked "Save"',
    ]);

    const mini = { ...mockComputerUseSlack, computer: "Mac mini", runnerId: createId("runner") };
    const twoMacs = workRows([
      computerStep("observe"),
      computerStep("act"),
      computerStep("observe", { place: mini }),
      computerStep("act", { place: mini }),
    ]);
    expect(twoMacs.map((row) => (row.kind === "steps" ? row.head.detail : row.kind))).toEqual([
      "2 steps on Alex's MacBook Pro",
      "2 steps on Mac mini",
    ]);
    const sameName = workRows([
      computerStep("observe"),
      computerStep("act"),
      computerStep("observe", { place: { ...mini, computer: mockComputerUseSlack.computer } }),
      computerStep("act", { place: { ...mini, computer: mockComputerUseSlack.computer } }),
    ]);
    expect(sameName).toHaveLength(2);
  });

  it("lets a thought with words in it stand between Computer use steps", () => {
    const first = computerStep("observe");
    const thought = reasoning({ text: "**The Opensteer workspace is index 19**" });
    const rows = workRows([first, thought, computerStep("act"), computerStep("observe")]);
    expect(rows.map((row) => row.key)).toEqual([
      `row:${first.id}`,
      `reasoning:${thought.id}`,
      expect.stringMatching(/^row:/u),
    ]);
  });
});

describe("Computer use on a phone", () => {
  const pixel = { computer: "Pixel 7", runnerId: createId("runner") };
  const observation =
    "Observation 4cf039beba5b8d92 of Pixel 7 — 12 elements. Screenshot 1080×2400 px; all coordinates are screenshot pixels.";
  function phoneStep(
    operation: "act" | "observe",
    overrides: Partial<ToolEntry> = {},
    phone = pixel,
  ): ToolEntry {
    return computerStep(operation, {
      integration: {
        ...mockComputerUseSubject(operation),
        computerApp: null,
        phone,
      },
      output: {
        text:
          operation === "observe"
            ? `Looked at Pixel 7\n${observation}`
            : `Tapped "Save".\n${observation}`,
      },
      ...overrides,
    });
  }
  function phoneTurn(entries: ToolEntry[], live = true): Turn {
    const [turn] = turns([run({ status: live ? "running" : "completed" }), ...entries]);
    if (!turn) throw new Error("Expected a phone turn");
    return turn;
  }

  it("groups calls and descriptions by phone, counts only calls and names the phone once", () => {
    const lookup = phoneStep("act", {
      output: { text: "{}" },
      tool: { name: "integration_describe", namespace: "opensteer.integrations" },
    });
    const calls = Array.from({ length: 6 }, () => phoneStep("act"));
    const entries = [lookup, ...calls];
    expect(rowShape(workRows(entries))).toEqual([
      {
        detail: "6 steps",
        errors: 0,
        group: "computer",
        label: "Used Pixel 7",
        steps: 7,
        tone: "done",
      },
    ]);
    expect(toolPresentation(lookup).kind).toBe("computer");
    expect(activityFeedPresentation(lookup).detail).toBe("Pixel 7");
    const live = phoneStep("act", {
      arguments: { arguments: { actions: [{ type: "tap", target: { index: 1 } }] } },
      completedAt: null,
      output: undefined,
      state: "running",
    });
    expect(rowShape(workRows([...entries, live]))).toMatchObject([
      { detail: "Tapping", group: "computer", label: "Using Pixel 7", tone: "running" },
    ]);
    expect(workSummary(phoneTurn([live]))?.label).toBe("Tapping on Pixel 7");
    expect(turnComputer(phoneTurn([live]))).toEqual({ action: "Tapping", kind: "phone", ...pixel });
    expect(turnComputer(phoneTurn(calls))).toEqual({ action: "Using", kind: "phone", ...pixel });
    expect(workSummary(phoneTurn(calls))?.label).toBe("Using Pixel 7");
  });

  it.each([
    ["tap", "Tapping"],
    ["longPress", "Pressing"],
    ["swipe", "Swiping"],
    ["drag", "Dragging"],
    ["type", "Typing"],
    ["clear", "Clearing a field"],
    ["navigate", "Navigating"],
    ["launch", "Opening an app"],
    ["scroll", "Scrolling"],
    ["wake", "Waking the screen"],
    ["wait", "Waiting"],
  ])("names a phone %s batch", (type, label) => {
    const entry = phoneStep("act", {
      arguments: { arguments: { actions: [{ type: "wait", ms: 1 }, { type }] } },
      output: undefined,
      state: "running",
    });
    expect(toolPresentation(entry)).toMatchObject({ activeLabel: label, kind: "computer" });
    expect(workSummary(phoneTurn([entry]))?.label).toBe(`${label} on Pixel 7`);
  });

  it("reads observations and act headlines, failures and stops as Computer use", () => {
    const look = phoneStep("observe");
    expect(toolPresentation(look)).toMatchObject({ kind: "computer", label: "Looked at Pixel 7" });
    expect(activityFeedPresentation(look)).toMatchObject({
      label: "Looked at Pixel 7",
      detail: "",
    });
    expect(workSummary(phoneTurn([{ ...look, output: undefined, state: "running" }]))?.label).toBe(
      "Looking at Pixel 7",
    );
    const act = phoneStep("act");
    expect(activityFeedPresentation(act)).toMatchObject({
      label: 'Tapped "Save".',
      detail: "Pixel 7",
    });
    const failed = phoneStep("act", {
      isError: true,
      output: { text: "Phone offline." },
      state: "failed",
    });
    expect(activityStepHead(failed)).toMatchObject({
      label: "Couldn't use Pixel 7",
      detail: "Phone offline.",
      tone: "error",
    });
    expect(turnComputer(phoneTurn([failed]))).toBeNull();
    const stopped = phoneStep("act", { output: undefined, state: "stopped" });
    expect(toolPresentation(stopped).label).toBe("Stopped using Pixel 7");
    const partial = phoneStep("act", {
      isError: true,
      output: {
        text: `${computerUseActHeadline({ performed: ['Tapped "Save"'], stoppedBecause: "Screen changed." })}\n${observation}`,
      },
      state: "failed",
    });
    expect(activityStepHead(partial)).toMatchObject({ errors: 0, tone: "stopped" });
  });

  it("keeps phones with the same name and a Mac in the same turn apart", () => {
    const other = { ...pixel, runnerId: createId("runner") };
    const entries = [
      phoneStep("observe"),
      phoneStep("act"),
      phoneStep("observe", {}, other),
      phoneStep("act", {}, other),
      computerStep("observe"),
      computerStep("act"),
    ];
    expect(rowShape(workRows(entries))).toMatchObject([
      { label: "Used Pixel 7", detail: "2 steps", steps: 2 },
      { label: "Used Pixel 7", detail: "2 steps", steps: 2 },
      { label: "Used Slack", detail: "2 steps on Alex's MacBook Pro", steps: 2 },
    ]);
  });
});

describe("integration gateway steps", () => {
  const gateway = (name: string, overrides: Partial<ToolEntry> = {}): ToolEntry =>
    tool({ tool: { name, namespace: "opensteer.integrations" }, ...overrides });

  const capturedRequest = {
    arguments: {
      integration: "proposed-7ac7ca3ad8eeeedd",
      account: "con_59e71764-5698-405b-a31f-9091abe4eb37",
      access: "read",
      reason:
        "Reconnect this same TMDB account because the single movie-details call failed authorization; I will stop without making another test call.",
    },
    output: {
      text: '{"kind":"integration.access","replayed":false,"requestId":"req_77de1886-077c-48ee-818c-82fe34ead67c","status":"pending"}\nThe user has been asked in Opensteer. This request is durable: continue other useful work or end your turn — a message will arrive on this thread when the user resolves it. Do not submit this request again.',
    },
  } satisfies Partial<ToolEntry>;

  it.each([
    { arguments: capturedRequest.arguments, target: "integration access" },
    {
      arguments: { catalog: "google-gmail", reason: "Read the requested email." },
      target: "integration access",
    },
    {
      arguments: {
        app: "com.tinyspeck.slackmacgap",
        kind: "computer-app",
        reason: "Read the requested Slack message.",
      },
      target: "app access on a Mac",
    },
    {
      arguments: { kind: "computer-app", reason: "Read the requested app." },
      target: "app access on a Mac",
    },
  ])(
    "labels a request for $target without naming its argument target",
    ({ arguments: args, target }) => {
      const entry = gateway("integration_request", { ...capturedRequest, arguments: args });
      const reason = args.reason;
      expect(toolPresentation(entry)).toMatchObject({
        activeLabel: `Requesting ${target}`,
        hint: reason,
        hintKind: "prose",
        kind: "integration-request",
        label: `Requested ${target}`,
      });
      for (const state of ["done", "running", "failed", "stopped"] as const) {
        const request = { ...entry, isError: state === "failed", state };
        expect(activityStepHead(request)).toMatchObject({
          detail: reason,
          errors: state === "failed" ? 1 : 0,
          label: `${state === "running" ? "Requesting" : "Requested"} ${target}`,
          tone: state === "failed" ? "error" : state,
        });
        expect(toolBody(request)).toEqual({
          argumentsText: JSON.stringify(args, null, 2),
          collapsed: true,
          command: null,
          output: state === "running" ? "" : capturedRequest.output.text,
          outputLabel: {
            done: "Output",
            failed: "Error",
            running: "Output so far",
            stopped: "Output before it stopped",
          }[state],
          summary: "",
        });
      }
    },
  );

  it("reads a call recorded before the Host named its subject as a call, and nothing more", () => {
    const old = gateway("integration_call", {
      arguments: { arguments: {}, toolRef: mockComputerUseToolRefs[0] },
      output: { text: result(null) },
    });
    expect(toolPresentation(old)).toMatchObject({
      activeLabel: "Calling an integration",
      hint: "",
      icon: "puzzle",
      kind: "integration-call",
      label: "Called an integration",
    });
    expect(toolBody(old)).toMatchObject({ argumentsText: "", collapsed: true, summary: "" });
    const failed = gateway("integration_call", {
      isError: true,
      output: {
        text: result([], { stoppedBecause: "Another window of this app came to the front." }),
      },
      state: "failed",
    });
    expect(activityStepHead(failed)).toMatchObject({ errors: 1, tone: "error" });
    expect(
      toolPresentation(
        gateway("integration_describe", { arguments: { toolRef: "igr_x.itl_y.z" } }),
      ),
    ).toMatchObject({ hint: "", label: "Looked up an integration" });
    expect(workRows([old, old]).map((row) => row.kind)).toEqual(["steps", "steps"]);
  });

  it("gathers adjacent lookups into one row", () => {
    const rows = workRows([
      gateway("integration_search", { arguments: { query: "gmail" } }),
      gateway("integration_search", { arguments: { query: "calendar" } }),
    ]);
    expect(rows).toMatchObject([
      {
        group: "integrations",
        head: {
          detail: 'for "gmail" and "calendar"',
          detailKind: "prose",
          icon: "puzzle",
          label: "Looked up integrations",
        },
      },
    ]);
    expect(
      workRows([
        gateway("integration_search", { arguments: { query: "gmail" } }),
        gateway("integration_search", { arguments: { query: "gmail" } }),
        gateway("integration_search", { arguments: { query: "calendar" } }),
        gateway("integration_search", { arguments: { query: "drive" } }),
      ])[0],
    ).toMatchObject({ head: { detail: 'for "gmail", "calendar" and "drive"' } });
    expect(
      toolPresentation(gateway("integration_search", { arguments: { query: "gmail" } })),
    ).toMatchObject({
      activeLabel: "Searching integrations",
      hint: 'for "gmail"',
      hintKind: "prose",
      label: "Searched integrations",
    });
    expect(toolPresentation(gateway("integration_search", { arguments: {} })).hint).toBe("");
  });

  it("keeps a gateway result closed, and out of the Workspace activity feed", () => {
    const [, , listed] = gatewayTools(slackTurn("settled"));
    expect(toolBody(listed!)).toMatchObject({ collapsed: true, outputLabel: "Output" });
    expect(toolBody(listed!).output).toContain("toolRefs");
    const described = gateway("integration_describe", {
      arguments: { toolRef: "igr_a.itl_b.c" },
      output: { text: '{"toolRef":"igr_a.itl_b.c","inputSchema":{}}' },
    });
    for (const entry of [listed!, described]) {
      expect(activityFeedPresentation(entry).detail).not.toMatch(/igr_|itl_|toolRef/u);
    }
    expect(activityFeedPresentation(described)).toMatchObject({
      detail: "",
      label: "Looked up an integration",
    });
  });

  it("gives an unknown gateway tool no hint from its arguments", () => {
    expect(
      toolPresentation(gateway("integration_future", { arguments: { toolRef: "igr_a.itl_b.c" } })),
    ).toMatchObject({ hint: "", icon: "puzzle", label: "Integration future" });
  });
});

// Failure cases: Host operation names treated as generic tools; outer script counted;
// a step pulled out of its arrival position; computer subject chips/status disappear.
describe("Host-authored computer operations", () => {
  it("recognizes the subject, keeps the outer script compact, and keeps arrival order", () => {
    const operation = tool({
      createdAt: at(2),
      tool: { name: "computer.click", namespace: "opensteer.integrations" },
      integration: mockComputerUseSubject("act"),
      output: { text: 'Clicked "Save"' },
    });
    const outer = tool({
      createdAt: at(0),
      tool: { name: "computer", namespace: "opensteer.integrations" },
      arguments: { code: "await app('Notes').window().click(1)" },
    });
    expect(toolPresentation(operation).kind).toBe("computer");
    expect(toolPresentation(outer).label).toBe("Ran computer code");
    expect(toolPresentation(outer).kind).not.toBe("computer");
    const groups = groupTranscriptEntries([operation, outer]);
    const turn = groups.find((group) => group.kind === "turn");
    // A step never moves once shown, even when its Host receipt arrived before the
    // engine reported the outer call.
    expect(turn?.kind === "turn" && turn.turn.work.map((entry) => entry.id)).toEqual([
      operation.id,
      outer.id,
    ]);
  });
});

describe("quiet Chat", () => {
  const startedBy = { kind: "platform" as const, cause: "assignment-result" };
  const rows = (entries: TranscriptEntry[], atComputer = false) =>
    conversationRows(groupTranscriptEntries(entries), { live: true, atComputer: () => atComputer });
  it("hides a returning task's silent turn, including typing and failures", () => {
    for (const status of ["running", "completed", "failed", "interrupted"] as const) {
      const entry = run({ startedBy, status });
      expect(rows([entry])).toEqual([]);
      const group = groupTranscriptEntries([entry])[0];
      if (group?.kind === "turn") expect(conversationTurn(group.turn).composing).toBe(false);
    }
  });
  it("keeps the reply, live computer use, human steers and unknown older Hosts", () => {
    const entry = run({ startedBy, replyMessageId: "reply" });
    expect(rows([entry, message({ id: "reply" })])).toHaveLength(1);
    expect(rows([run({ startedBy, status: "running" })], true)).toHaveLength(1);
    expect(rows([input(), run({ startedBy })])).toHaveLength(2);
    expect(rows([run()])).toHaveLength(1);
  });
  it("keeps outcomes when a reloaded page omits the person's steer", () => {
    for (const status of ["completed", "failed", "interrupted"] as const)
      expect(rows([run({ startedBy, personWaiting: true, status })])).toHaveLength(1);
  });
  it("does not invent elapsed time for an older Host", () => {
    expect(silentRunLabel(run({ endedAt: at(60) }))).toBe("Worked");
  });
  it("uses whole Run elapsed time for silent human work", () => {
    expect(silentRunLabel(run({ createdAt: at(60), startedAt: at(0), endedAt: at(60) }))).toBe(
      "Worked for 1m",
    );
  });
});

it("shows only decisions and failed assignments from automatic work, including standalone assignments", () => {
  const automatic = run({ startedBy: { kind: "platform", cause: "assignment-result" } });
  const task: import("./client.js").AssignmentEntry = {
    kind: "assignment",
    id: "assignment:task",
    createdAt: at(0),
    runId: automatic.runId,
    assignment: {
      id: createId("delegation"),
      createdAt: at(0),
      updatedAt: at(1),
      finishedAt: null,
      currentRunId: createId("run"),
      currentRunStatus: "running",
      initialRunId: createId("run"),
      modelLabel: null,
      objectivePreview: "Check",
      origin: "run",
      parentThreadId: createId("thread"),
      resultPreview: null,
      returnStatus: "pending",
      revision: 1,
      status: "open",
      workerThread: {
        id: createId("thread"),
        title: "Research",
        icon: null,
        environmentId: createId("environment"),
        workspaceId: createId("workspace"),
        pendingRequests: 0,
        status: "running",
      },
    },
  };
  for (const origin of ["run", "trigger", "watch"] as const) {
    for (const state of ["running", "completed", "waiting", "failed"] as const) {
      const entry = {
        ...task,
        runId: origin === "run" ? automatic.runId : null,
        assignment: {
          ...task.assignment,
          origin,
          status:
            state === "failed"
              ? ("failed" as const)
              : state === "completed"
                ? ("completed" as const)
                : ("open" as const),
          currentRunStatus: state,
        },
      };
      const groups = groupTranscriptEntries(origin === "run" ? [automatic, entry] : [entry]);
      const rows = conversationRows(groups, {
        atComputer: () => false,
        live: true,
        waitingRequests:
          state === "waiting"
            ? [
                {
                  assignments: [{ id: task.assignment.id }],
                } as import("@opensteer/core").WaitingRequest,
              ]
            : [],
      });
      expect(rows.length, `${origin} ${state}`).toBe(
        state === "waiting" || state === "failed" ? 1 : 0,
      );
    }
  }
  const returning: TranscriptEntry = {
    kind: "assignment-return",
    assignmentId: task.assignment.id,
    createdAt: at(3),
    id: "return",
    runId: automatic.runId,
    sequence: "10",
  };
  const reply = message({ id: "reply" });
  const groups = groupTranscriptEntries(
    [returning, { ...automatic, replyMessageId: reply.id }, reply],
    { assignments: { [task.assignment.id]: task.assignment } },
  );
  const turn = groups.find((group) => group.kind === "turn");
  expect(turn?.turn.source?.task?.workerThread.title).toBe("Research");
  const page = groupTranscriptEntries(
    [
      {
        ...automatic,
        startedBy: {
          kind: "platform",
          cause: "assignment-result",
          referenceId: task.assignment.id,
        },
        replyMessageId: reply.id,
      },
      reply,
    ],
    { assignments: { [task.assignment.id]: task.assignment } },
  );
  expect(page.find((group) => group.kind === "turn")?.turn.source?.task?.workerThread.title).toBe(
    "Research",
  );
});

it("a human restart or steer keeps automatic work's outcomes, and reports remain updates", () => {
  for (const status of ["completed", "failed", "interrupted", "running"] as const) {
    const automatic = run({
      status,
      attempt: 2,
      startedBy: { kind: "platform", cause: "assignment-result" },
    });
    const groups = groupTranscriptEntries([automatic, input()]);
    const turn = groups.findLast((group) => group.kind === "turn");
    expect(turn?.turn.personWaiting).toBe(true);
    expect(conversationRows(groups, { live: true, atComputer: () => false })).toHaveLength(2);
  }
  const report = input({
    runId: null,
    author: { kind: "platform", cause: "report" },
    policy: "report",
  });
  expect(
    conversationRows(groupTranscriptEntries([report]), { live: true, atComputer: () => false })[0]
      ?.group,
  ).toMatchObject({ kind: "message", entry: report });
});

it("automatic background work has no Chat indicator, while a new human input still does", () => {
  const automatic = run({
    status: "running",
    background: true,
    startedBy: { kind: "platform", cause: "assignment-result" },
  });
  expect(
    threadActivityIndicator("background", {
      conversation: true,
      groups: groupTranscriptEntries([automatic]),
    }),
  ).toBeNull();
  expect(
    threadActivityIndicator("working", {
      conversation: true,
      groups: groupTranscriptEntries([automatic, input({ runId: null })]),
    }),
  ).toEqual({ kind: "typing" });
});
