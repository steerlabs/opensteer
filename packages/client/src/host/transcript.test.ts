import {
  RunnerIdSchema,
  SequenceSchema,
  createId,
  type AgentEventView as AgentEvent,
  type MessageId,
  type Request,
  type RunId,
  type ThreadInputQueue,
} from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  conversationTurn,
  groupTranscriptEntries,
  workRows,
  workSummary,
} from "./agent-activity-model.js";
import type { TranscriptEntry } from "./client.js";
import { LiveStreamLedger } from "./live-progress.js";
import {
  finishRunEntries,
  foldLiveRun,
  foldTranscriptEvent,
  isTerminalRunEntryStatus,
  mergeTranscriptSegments,
  visibleTranscript,
} from "./transcript.js";

const now = "2026-08-09T20:00:00.000Z";
const environmentId = createId("environment");
const workspaceId = createId("workspace");
const threadId = createId("thread");
const runId = createId("run");

function event<Type extends AgentEvent["type"]>(
  type: Type,
  data: Extract<AgentEvent, { type: Type }>["data"],
  overrides: { createdAt?: string; runId?: AgentEvent["runId"] } = {},
): Extract<AgentEvent, { type: Type }> {
  return {
    createdAt: overrides.createdAt ?? now,
    data,
    environmentId,
    eventId: createId("event"),
    runId: "runId" in overrides ? overrides.runId : runId,
    sequence: "1",
    threadId,
    type,
    workspaceId,
  } as Extract<AgentEvent, { type: Type }>;
}

function fold(events: readonly AgentEvent[], initial: TranscriptEntry[] = []): TranscriptEntry[] {
  return events.reduce(foldTranscriptEvent, initial);
}

type LiveText =
  | { readonly stream: "assistant"; readonly text: string }
  | { readonly blockId: string; readonly stream: "reasoning"; readonly text: string }
  | { readonly callId: string; readonly stream: "tool"; readonly text: string };

const assistantText = (text: string): LiveText => ({ stream: "assistant", text });
const reasoningText = (blockId: string, text: string): LiveText => ({
  blockId,
  stream: "reasoning",
  text,
});
const toolText = (callId: string, text: string): LiveText => ({ callId, stream: "tool", text });

/**
 * What a client draws from a Run: durable events folded in order, and live
 * text appended at the offsets each stream has reached, through the same
 * ledger and fold the session client uses.
 */
function play(steps: readonly (AgentEvent | LiveText)[]): TranscriptEntry[] {
  const ledger = new LiveStreamLedger();
  const lengths = new Map<string, number>();
  let entries: TranscriptEntry[] = [];
  // Live text follows the durable event before it, as the Host sends it.
  let after: AgentEvent["sequence"] = SequenceSchema.parse("1");
  for (const step of steps) {
    if ("eventId" in step) {
      entries = foldTranscriptEvent(entries, step);
      ledger.complete(step);
      after = step.sequence;
      if (step.type === "assistant.message") lengths.delete("assistant");
      if (step.type === "reasoning.completed") lengths.delete(`reasoning:${step.data.blockId}`);
      if (step.type === "tool.completed") lengths.delete(`tool:${step.data.callId}`);
      continue;
    }
    if (!step.text) continue;
    const key =
      step.stream === "assistant"
        ? "assistant"
        : step.stream === "reasoning"
          ? `reasoning:${step.blockId}`
          : `tool:${step.callId}`;
    const at = lengths.get(key) ?? 0;
    lengths.set(key, at + step.text.length);
    const { changed } = ledger.apply({
      afterSequence: after,
      progress: { items: [{ ...step, at, op: "append" }], runId, threadId, workspaceId },
    });
    if (changed) entries = foldLiveRun(entries, changed, now);
  }
  return entries;
}

function request(): Extract<Request, { status: "pending" }> {
  return {
    callId: "approval-1",
    cancellationReason: null,
    createdAt: now,
    id: createId("request"),
    kind: "harness.approval",
    mode: "live",
    originatingOccurrenceId: null,
    originatingRunId: runId,
    originatingThreadId: threadId,
    originatingWorkspaceId: workspaceId,
    payload: { kind: "harness.approval" },
    presentation: {
      detail: "Publish the release",
      kind: "choice",
      options: [
        { hint: "reject-once", id: "reject", label: "Not now" },
        { hint: "confirm", id: "allow", label: "Publish" },
      ],
      risk: "high",
      title: "Publish externally",
    },
    requestedBy: createId("user"),
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
    targetWorkspaceId: workspaceId,
  };
}

describe("foldTranscriptEvent", () => {
  it("accumulates live answer text into one streaming draft and replaces it in place", () => {
    const streamed = play([
      event("run.started", { status: "running" }),
      assistantText("Working"),
      assistantText(" on it."),
      event("tool.started", {
        arguments: { command: "ls" },
        callId: "call-1",
        tool: { name: "shell", namespace: "codex" },
      }),
    ]);
    expect(streamed.map((entry) => entry.id)).toEqual([
      `run:${runId}`,
      `stream:${runId}`,
      `tool:${runId}:call-1`,
    ]);
    expect(streamed[1]).toMatchObject({
      body: "Working on it.",
      kind: "message",
      messageKind: "assistant",
      runId,
      streaming: true,
    });

    const messageId = createId("message");
    const final = foldTranscriptEvent(
      streamed,
      event("assistant.message", {
        content: [{ text: "Working on it. Done.", type: "text" }],
        messageId,
      }),
    );
    // The final message takes over the draft's slot, ahead of the tool entry.
    expect(final.map((entry) => entry.id)).toEqual([
      `run:${runId}`,
      messageId,
      `tool:${runId}:call-1`,
    ]);
    expect(final[1]).toMatchObject({ body: "Working on it. Done.", kind: "message" });
    expect(final[1]).not.toHaveProperty("streaming", true);
  });

  it("streams live reasoning and lets the completed text win over the accumulation", () => {
    const streaming = play([
      reasoningText("block-1", "First thought. "),
      reasoningText("block-1", "Second thought."),
    ]);
    expect(streaming).toEqual([
      expect.objectContaining({
        id: `reasoning:${runId}:block-1`,
        kind: "reasoning",
        state: "streaming",
        text: "First thought. Second thought.",
      }),
    ]);

    const completed = foldTranscriptEvent(
      streaming,
      event("reasoning.completed", { blockId: "block-1", text: "The authoritative summary." }),
    );
    expect(completed).toEqual([
      expect.objectContaining({
        completedAt: now,
        state: "done",
        text: "The authoritative summary.",
      }),
    ]);
  });

  it("keeps the streamed reasoning text when the completed event carries none", () => {
    const entries = play([
      reasoningText("block-1", "Streamed thinking."),
      event("reasoning.completed", { blockId: "block-1", text: "" }),
    ]);
    expect(entries).toEqual([
      expect.objectContaining({ state: "done", text: "Streamed thinking." }),
    ]);
  });

  it("starts no thought for a reasoning block that has said nothing yet", () => {
    expect(play([reasoningText("block-1", "")])).toEqual([]);
    expect(play([reasoningText("block-1", ""), reasoningText("block-1", "Checking.")])).toEqual([
      expect.objectContaining({ state: "streaming", text: "Checking." }),
    ]);
  });

  it("carries the subject the Host named for an integration call through its lifecycle", () => {
    const subject = {
      account: "This computer",
      computerApp: {
        app: "Slack",
        bundleId: "com.tinyspeck.slackmacgap",
        computer: "Alex's Mac",
        runnerId: createId("runner"),
      },
      effect: "write" as const,
      integration: "Computer use",
      operation: { name: "act", title: "Act" },
    };
    const started = event("tool.started", {
      arguments: { arguments: {}, toolRef: "igr_x.itl_y.z" },
      callId: "call-1",
      integration: subject,
      tool: { name: "integration_call", namespace: "opensteer.integrations" },
    });
    const completed = event("tool.completed", {
      callId: "call-1",
      isError: false,
      output: { text: "Looked at Slack" },
    });
    expect(play([started, toolText("call-1", "."), completed])).toEqual([
      expect.objectContaining({ integration: subject, state: "done" }),
    ]);
    const { integration: _firstSubject, ...firstStart } = started.data;
    const restated = fold([
      { ...started, data: { ...firstStart, arguments: {} } },
      started,
      completed,
    ]);
    expect(restated).toEqual([
      expect.objectContaining({
        arguments: started.data.arguments,
        integration: subject,
        state: "done",
      }),
    ]);
    expect(workRows(restated.filter((entry) => entry.kind === "tool"))).toHaveLength(1);
    // A page that begins after the call started never saw its subject; the older page did.
    const merged = mergeTranscriptSegments(fold([started]), fold([completed]));
    expect(merged).toEqual([expect.objectContaining({ integration: subject, state: "done" })]);
    // An event recorded before the Host named subjects has none.
    const { integration: _subject, ...unnamed } = started.data;
    expect(fold([{ ...started, data: unnamed }])).toEqual([
      expect.objectContaining({ integration: null }),
    ]);
  });

  it("folds a tool lifecycle while preserving structured arguments and output", () => {
    const entries = play([
      event("tool.started", {
        arguments: { command: "pnpm test", cwd: "/workspace" },
        callId: "call-1",
        tool: { name: "shell", namespace: "codex" },
      }),
      toolText("call-1", "12 passed\n"),
      toolText("call-1", '{"warnings":0}'),
      event("tool.completed", {
        callId: "call-1",
        isError: false,
        output: { text: "12 passed\n" },
      }),
    ]);
    expect(entries).toEqual([
      expect.objectContaining({
        arguments: { command: "pnpm test", cwd: "/workspace" },
        callId: "call-1",
        completedAt: now,
        id: `tool:${runId}:call-1`,
        integration: null,
        isError: false,
        kind: "tool",
        tool: { name: "shell", namespace: "codex" },
        output: { text: "12 passed\n" },
        runId,
        state: "done",
        streamText: '12 passed\n{"warnings":0}',
      }),
    ]);
  });

  // The ways a receipt could fail: repeating its status ("Declined · Not now")
  // when the Request offered one way to decline; telling two ways to decline
  // apart by nothing; dropping which option fulfilled it; inventing a decision
  // a response did not carry.
  it("keeps pending Requests out of history and adds one compact terminal receipt", () => {
    const pending = request();
    const opened = fold([
      event("request.opened", { request: pending }),
      event("request.updated", { request: pending }),
    ]);
    // A live Request holds its Run from when it opened, which is kept but never drawn.
    expect(opened).toEqual([
      {
        createdAt: pending.createdAt,
        id: `request:${pending.id}`,
        kind: "request-wait",
        requestId: pending.id,
        runId,
      },
    ]);
    expect(visibleTranscript(opened, null)).toEqual([]);
    expect(
      fold([event("request.cancelled", { requestId: pending.id, reason: "source-closed" })]),
    ).toEqual([
      expect.objectContaining({
        outcome: "Cancelled · source-closed",
        requestId: pending.id,
        title: "Request",
      }),
    ]);

    const resolved: Request = {
      ...pending,
      resolvedAt: now,
      resolvedBy: pending.requestedBy,
      response: { kind: "choice", optionId: "reject" },
      status: "declined",
    };
    expect(fold([event("request.resolved", { request: resolved })])).toEqual([
      expect.objectContaining({
        kind: "request",
        outcome: "Declined",
        requestId: pending.id,
        title: "Publish externally",
        waitedSince: pending.createdAt,
      }),
    ]);

    // An engine that offers both rejecting the call and cancelling the turn
    // declines either way; only the option says which.
    const cancelled: Request = {
      ...resolved,
      presentation: {
        ...pending.presentation,
        kind: "choice",
        options: [
          { hint: "allow-once", id: "allow", label: "Allow once" },
          { hint: "reject-once", id: "reject", label: "Reject" },
          { hint: "cancel", id: "cancel", label: "Cancel" },
        ],
      },
      response: { kind: "choice", optionId: "cancel" },
    };
    expect(fold([event("request.resolved", { request: cancelled })])).toEqual([
      expect.objectContaining({ outcome: "Declined · Cancel", requestId: pending.id }),
    ]);

    const fulfilled: Request = {
      ...pending,
      resolvedAt: now,
      resolvedBy: pending.requestedBy,
      response: { kind: "choice", optionId: "allow" },
      status: "fulfilled",
    };
    expect(fold([event("request.resolved", { request: fulfilled })])).toEqual([
      expect.objectContaining({ outcome: "Fulfilled · Publish", requestId: pending.id }),
    ]);

    const withdrawn: Request = {
      ...pending,
      resolvedAt: now,
      resolvedBy: pending.requestedBy,
      status: "withdrawn",
    };
    expect(fold([event("request.resolved", { request: withdrawn })])).toEqual([
      expect.objectContaining({ outcome: "Withdrawn", requestId: pending.id }),
    ]);

    // The ways a cancelled wait could fail: the Run counted as working while it
    // waited; a reload that splits the opening from the cancellation across
    // two pages remembering a different wait than the live fold did.
    const runEnded = event(
      "request.cancelled",
      { requestId: pending.id, reason: "run-ended" },
      { createdAt: "2026-08-09T21:00:00.000Z" },
    );
    const waited = expect.objectContaining({
      kind: "request",
      outcome: "Cancelled · run-ended",
      requestId: pending.id,
      waitedSince: pending.createdAt,
    });
    expect(fold([runEnded], opened)).toEqual([waited]);
    expect(mergeTranscriptSegments(opened, fold([runEnded]))).toEqual([waited]);
  });

  it("counts no wait a Stop ended as work, live or reloaded across two pages", () => {
    const pending = { ...request(), createdAt: "2026-08-09T20:00:02.000Z" };
    const opening = [
      event("run.started", { status: "running" }),
      event("tool.started", {
        arguments: { command: "pnpm publish" },
        callId: pending.callId,
        tool: { name: "shell", namespace: "codex" },
      }),
      event("request.opened", { request: pending }, { createdAt: pending.createdAt }),
    ];
    const stopped = { createdAt: "2026-08-09T21:00:02.000Z" };
    const ending = [
      event("request.cancelled", { requestId: pending.id, reason: "run-ended" }, stopped),
      event("run.interrupted", { status: "interrupted" }, stopped),
    ];
    const label = (entries: readonly TranscriptEntry[]) => {
      const [group] = groupTranscriptEntries(entries);
      if (group?.kind !== "turn") throw new Error("Expected the Run's turn");
      return workSummary(group.turn).label;
    };
    expect(label(fold([...opening, ...ending]))).toBe("Worked for 2s");
    expect(label(mergeTranscriptSegments(fold(opening), fold(ending)))).toBe("Worked for 2s");
  });

  it("names the decision an externally resolved Request was answered with", () => {
    const pending = request();
    const externalPresentation = {
      detail: "Messages and Mail are needed for the inbox sweep",
      kind: "external",
      subject: { id: createId("runner"), kind: "machine" },
      title: "Allow full access on Mac mini",
    } as const;
    const declined: Request = {
      ...pending,
      kind: "machine.full-disk-access",
      mode: "durable",
      payload: {
        kind: "machine.full-disk-access",
        machineId: RunnerIdSchema.parse(createId("runner")),
        machineName: "Mac mini",
        reason: "Messages and Mail are needed for the inbox sweep",
      },
      presentation: externalPresentation,
      resolvedAt: now,
      resolvedBy: pending.requestedBy,
      response: { kind: "external", value: { decision: "declined" } },
      status: "declined",
    };
    expect(fold([event("request.resolved", { request: declined })])).toEqual([
      expect.objectContaining({ outcome: "Declined", requestId: pending.id }),
    ]);
    // A durable Request left its Run working, so nothing waited on its answer.
    expect(fold([event("request.resolved", { request: declined })])[0]).not.toHaveProperty(
      "waitedSince",
    );

    const fulfilled: Request = {
      ...declined,
      response: { kind: "external", value: { decision: "fulfilled" } },
      status: "fulfilled",
    };
    expect(fold([event("request.resolved", { request: fulfilled })])).toEqual([
      expect.objectContaining({ outcome: "Allowed", requestId: pending.id }),
    ]);

    // A response carrying no decision says only that it was resolved.
    const bare: Request = { ...fulfilled, response: { kind: "external" } };
    expect(fold([event("request.resolved", { request: bare })])).toEqual([
      expect.objectContaining({ outcome: "Fulfilled", requestId: pending.id }),
    ]);
  });

  it("shows a Run recovery while keeping model-control messages out of the transcript", () => {
    const resultMessageId = createId("message");
    const continuationMessageId = createId("message");
    const recoveryMessageId = createId("message");
    const entries = fold([
      event("message.created", {
        input: null,
        message: {
          author: {
            displayName: "Sales Agent",
            kind: "agent",
            runId,
            threadId: createId("thread"),
            workspaceId,
            workspaceName: "Sales",
          },
          content: [{ text: 'Delegated Thread result\n{"outcome":"completed"}', type: "text" }],
          createdAt: now,
          id: resultMessageId,
          kind: "run-result",
          runId: null,
          sequence: SequenceSchema.parse("1"),
          threadId,
        },
      }),
      event("message.created", {
        input: null,
        message: {
          author: { cause: "context-window", kind: "platform" },
          content: [{ text: "Continue from the durable state.", type: "text" }],
          createdAt: now,
          id: continuationMessageId,
          kind: "continuation",
          runId: null,
          sequence: SequenceSchema.parse("2"),
          threadId,
        },
      }),
      event("message.created", {
        input: null,
        message: {
          author: { cause: "run-recovery", kind: "platform" },
          content: [{ text: "Your conversation is intact. Continue the task.", type: "text" }],
          createdAt: now,
          id: recoveryMessageId,
          kind: "continuation",
          runId,
          sequence: SequenceSchema.parse("3"),
          threadId,
        },
      }),
    ]);

    expect(entries).toEqual([
      expect.objectContaining({
        id: recoveryMessageId,
        kind: "message",
        messageKind: "continuation",
        body: "Your conversation is intact. Continue the task.",
        author: { cause: "run-recovery", kind: "platform" },
      }),
    ]);
  });

  it("marks refused and uncertain steers on their original message", () => {
    const messageId = createId("message");
    const input = {
      assignmentId: null,
      cancelReason: null,
      causalChainId: createId("causalChain"),
      createdAt: now,
      deliveredAt: null,
      messageId,
      policy: "steer" as const,
      replyTarget: null,
      runId,
      state: "claimed" as const,
      threadId,
      updatedAt: now,
    };
    const created = event("message.created", {
      input,
      message: {
        author: {
          displayName: "Owner",
          kind: "human" as const,
          principalId: "pri_00000000-0000-4000-8000-000000000099",
          userId: createId("user"),
        },
        content: [{ text: "Change direction", type: "text" as const }],
        createdAt: now,
        id: messageId,
        kind: "input" as const,
        runId,
        sequence: SequenceSchema.parse("1"),
        threadId,
      },
    });

    const refused = fold([
      created,
      event("thread-input.updated", {
        input: { ...input, cancelReason: "steer-refused", state: "cancelled" },
      }),
    ]);
    expect(refused[0]).toMatchObject({
      body: "Change direction",
      delivery: { reason: "Steer was not delivered: steer refused.", status: "failed" },
    });

    const uncertain = fold([
      created,
      event("thread-input.updated", { input: { ...input, state: "unknown" } }),
    ]);
    expect(uncertain[0]).toMatchObject({
      delivery: { reason: "Message delivery could not be confirmed.", status: "unconfirmed" },
    });

    const promotedQueueUncertain = fold([
      created,
      event("thread-input.updated", {
        input: { ...input, policy: "queue", state: "unknown" },
      }),
    ]);
    expect(promotedQueueUncertain[0]).toMatchObject({
      delivery: { reason: "Message delivery could not be confirmed.", status: "unconfirmed" },
    });

    const confirmed = fold([
      created,
      event("thread-input.updated", { input: { ...input, state: "unknown" } }),
      event("thread-input.updated", {
        input: { ...input, deliveredAt: now, state: "delivered" },
      }),
    ]);
    expect(confirmed[0]).not.toHaveProperty("delivery");

    const promotedQueueEnded = fold([
      created,
      event("thread-input.updated", {
        input: {
          ...input,
          cancelReason: "run-ended-delivery-unknown",
          policy: "queue",
          state: "cancelled",
        },
      }),
    ]);
    expect(promotedQueueEnded[0]).toMatchObject({ delivery: { status: "failed" } });
  });

  it("projects one typed delegation settlement without exposing its model message", () => {
    const delegationId = createId("delegation");
    const childRunId = createId("run");
    const childThreadId = createId("thread");
    const entries = fold([
      event("delegation.settled", {
        childRunId,
        childThread: { id: childThreadId, title: "Sales Agent", workspaceId },
        delegationId,
        delivery: { resultMessageId: createId("message"), status: "delivered" },
        failure: null,
        outcome: "completed",
        resultPreview: "Inspection complete.",
        taskPreview: "Inspect the available integrations.",
      }),
    ]);

    expect(entries).toEqual([
      expect.objectContaining({
        childRunId,
        childThread: expect.objectContaining({ id: childThreadId, title: "Sales Agent" }),
        id: `delegation:${delegationId}`,
        kind: "delegation",
        outcome: "completed",
        resultPreview: "Inspection complete.",
      }),
    ]);
  });

  it("stops tool calls a failed run left open, without calling them errors", () => {
    const running = play([
      event("run.started", { status: "running" }),
      reasoningText("block-1", "Thinking…"),
      event("tool.started", {
        arguments: { command: "ls" },
        callId: "call-1",
        tool: { name: "shell", namespace: "codex" },
      }),
      assistantText("Partial answer"),
    ]);
    const failed = foldTranscriptEvent(
      running,
      event("run.failed", {
        code: "runner_lost",
        message: "The Runner disconnected.",
        retryable: true,
        status: "failed",
      }),
    );
    expect(failed.find((entry) => entry.kind === "run")).toMatchObject({
      error: { code: "runner_lost", message: "The Runner disconnected.", retryable: true },
      status: "failed",
    });
    expect(failed.find((entry) => entry.kind === "tool")).toMatchObject({
      isError: false,
      state: "stopped",
    });
    expect(failed.find((entry) => entry.kind === "reasoning")).toMatchObject({ state: "done" });
    expect(failed.find((entry) => entry.kind === "message")).toMatchObject({ streaming: false });
    expect(isTerminalRunEntryStatus("failed")).toBe(true);
    expect(isTerminalRunEntryStatus("running")).toBe(false);
  });

  it("re-folds an already projected completed event idempotently", () => {
    const events = [
      event("run.started", { status: "running" }),
      event("tool.started", {
        arguments: { path: "docs/plan.md" },
        callId: "call-1",
        tool: { name: "read_file", namespace: "test" },
      }),
      event("tool.completed", { callId: "call-1", isError: false, output: { text: "# Plan" } }),
      event("run.completed", { replyMessageId: null, status: "completed" }),
    ];
    const once = fold(events);
    const twice = fold([events[2]!, events[3]!], once);
    expect(twice).toEqual(once);
  });
});

/*
 * What a conversation offers behind a turn, from each engine's real order.
 * Failure modes: where the live draft happens to sit (where its text first
 * arrived, or after the durable page a reload drew) decides what is a step;
 * the answer being written shows among the steps; what a Run consumed makes a
 * plain answer openable.
 */
describe("a conversation turn in each engine's order", () => {
  const view = (entries: readonly TranscriptEntry[]) => {
    const turn = groupTranscriptEntries(entries).findLast((group) => group.kind === "turn");
    if (turn?.kind !== "turn") throw new Error("Missing turn");
    return conversationTurn(turn.turn);
  };
  // In the Host's order, so a recorded message closes the draft before it.
  const ordered = <Event extends AgentEvent>(sequence: string, recorded: Event): Event => ({
    ...recorded,
    sequence: SequenceSchema.parse(sequence),
  });
  const started = ordered("1", event("run.started", { status: "running" }));
  const check = ordered(
    "3",
    event("tool.started", {
      arguments: { command: "ls" },
      callId: "call-1",
      tool: { name: "Bash", namespace: "claude" },
    }),
  );
  const checked = ordered(
    "4",
    event("tool.completed", { callId: "call-1", isError: false, output: { text: "a.ts b.ts" } }),
  );
  const answerId = createId("message");
  const answered = ordered(
    "5",
    event("assistant.message", {
      content: [{ text: "Two files.", type: "text" }],
      messageId: answerId,
    }),
  );
  const usage = ordered("6", event("run.usage", { inputTokens: 1_565, outputTokens: 1_424 }));
  const completed = ordered(
    "7",
    event("run.completed", { replyMessageId: answerId, status: "completed" }),
  );

  it("offers only Claude's tool while one draft streams around it, live or reloaded", () => {
    // Claude streams all it says into one draft and records it once, at the end.
    const live = play([
      started,
      assistantText("Let me check. "),
      check,
      checked,
      assistantText("Two"),
    ]);
    const reloaded = play([started, check, checked, assistantText("Let me check. Two")]);
    for (const entries of [live, reloaded]) {
      expect(view(entries)).toMatchObject({ composing: true, detailed: true });
      expect(view(entries).steps.map((entry) => entry.id)).toEqual([`tool:${runId}:call-1`]);
    }
    const done = play([
      started,
      assistantText("Let me check. "),
      check,
      checked,
      assistantText("Two files."),
      answered,
      usage,
      completed,
    ]);
    expect(view(done)).toMatchObject({ composing: false, reply: { id: answerId } });
    expect(view(done).steps.map((entry) => entry.id)).toEqual([`tool:${runId}:call-1`]);
  });

  it("offers Codex's recorded preamble and tool, never the answer being written or just recorded", () => {
    const preambleId = createId("message");
    const before = [
      started,
      assistantText("Let me check."),
      ordered(
        "2",
        event("assistant.message", {
          content: [{ text: "Let me check.", type: "text" }],
          messageId: preambleId,
        }),
      ),
      check,
      checked,
    ];
    const expected = [preambleId, `tool:${runId}:call-1`];
    for (const entries of [
      play([...before, assistantText("Two")]),
      play([...before, assistantText("Two files."), answered]),
      play([...before, assistantText("Two files."), answered, usage]),
    ]) {
      expect(view(entries).steps.map((entry) => entry.id)).toEqual(expected);
    }
    const done = play([...before, assistantText("Two files."), answered, usage, completed]);
    expect(view(done)).toMatchObject({ reply: { id: answerId } });
    expect(view(done).steps.map((entry) => entry.id)).toEqual(expected);
  });

  it("has nothing to open behind a plain answer, however far it has got", () => {
    const steps = [started, assistantText("Two files."), answered, usage, completed];
    for (let reached = 2; reached <= steps.length; reached += 1) {
      expect(view(play(steps.slice(0, reached)))).toMatchObject({ detailed: false, steps: [] });
    }
  });
});

/*
 * History read over HTTP can tell the ledger a stream completed before any of
 * the Run's live frames arrive. Failure modes:
 * - a completion for a Run the ledger has never seen is forgotten, and a late
 *   frame from before it draws the stale partial beside the final answer;
 * - remembering that completion must not block the Run's next stream;
 * - a completion read for a Run that already ended must not bring it back.
 */
describe("LiveStreamLedger completions", () => {
  const at = (sequence: string) => SequenceSchema.parse(sequence);
  const frame = (afterSequence: string, text: string, frameRunId = runId) => ({
    afterSequence: at(afterSequence),
    progress: {
      items: [{ at: 0, op: "append" as const, stream: "assistant" as const, text }],
      runId: frameRunId,
      threadId,
      workspaceId,
    },
  });
  const answered = (sequence: string, eventRunId = runId) => ({
    ...event(
      "assistant.message",
      { content: [{ text: "Alpha done.", type: "text" }], messageId: createId("message") },
      { runId: eventRunId },
    ),
    sequence: at(sequence),
  });

  it("remembers a completion for a Run it has not seen stream", () => {
    const ledger = new LiveStreamLedger();
    ledger.complete(answered("2"));

    expect(ledger.apply(frame("1", "Alpha ")).changed).toBeNull();
    expect(ledger.threadRuns(threadId)).toEqual([]);
    expect(ledger.apply(frame("2", "Beta")).changed?.streams).toEqual([
      { key: { stream: "assistant" }, length: 4, tail: "Beta" },
    ]);
  });

  it("does not bring back a Run that ended when an older completion is read", () => {
    const ended = createId("run");
    const ledger = new LiveStreamLedger();
    ledger.complete({
      ...event("run.completed", { replyMessageId: null, status: "completed" }, { runId: ended }),
      sequence: at("5"),
    });
    ledger.complete(answered("4", ended));

    expect(ledger.apply(frame("6", "late", ended)).changed).toBeNull();
    expect(ledger.threadRuns(threadId)).toEqual([]);
  });
});

describe("finishRunEntries", () => {
  it("only touches entries that belong to the finished run", () => {
    const otherRunId = createId("run");
    const entries = fold([
      event("tool.started", {
        arguments: {},
        callId: "call-1",
        tool: { name: "shell", namespace: "codex" },
      }),
      event(
        "tool.started",
        { arguments: {}, callId: "call-2", tool: { name: "shell", namespace: "codex" } },
        { runId: otherRunId },
      ),
    ]);
    const finished = finishRunEntries(entries, runId);
    expect(finished[0]).toMatchObject({ isError: false, state: "stopped" });
    expect(finished[1]).toMatchObject({ state: "running" });
  });
});

describe("mergeTranscriptSegments", () => {
  it("recovers the started fields of a tool call split across page boundaries", () => {
    const earlier = fold([
      event("message.created", {
        input: {
          assignmentId: null,
          cancelReason: null,
          causalChainId: createId("causalChain"),
          createdAt: "2026-08-09T19:00:00.000Z",
          deliveredAt: now,
          messageId: createId("message"),
          policy: "queue",
          replyTarget: null,
          runId,
          state: "delivered",
          threadId,
          updatedAt: now,
        },
        message: {
          author: {
            displayName: "Owner",
            kind: "human",
            principalId: "user:test-owner",
            userId: createId("user"),
          },
          content: [{ text: "Do the work", type: "text" }],
          createdAt: "2026-08-09T19:00:00.000Z",
          id: createId("message"),
          kind: "input",
          runId,
          sequence: SequenceSchema.parse("1"),
          threadId,
        },
      }),
      event(
        "tool.started",
        {
          arguments: { command: "pnpm build" },
          callId: "call-1",
          tool: { name: "shell", namespace: "codex" },
        },
        { createdAt: "2026-08-09T19:01:00.000Z" },
      ),
    ]);
    // The later page only saw the completion, so the entry lacks its
    // started-time fields.
    const later = fold([
      event("tool.completed", { callId: "call-1", isError: false, output: { text: "exit 0" } }),
      event("run.completed", { replyMessageId: null, status: "completed" }),
    ]);

    const merged = mergeTranscriptSegments(earlier, later);
    expect(merged.map((entry) => entry.kind)).toEqual(["message", "tool", "run"]);
    expect(merged[1]).toMatchObject({
      arguments: { command: "pnpm build" },
      createdAt: "2026-08-09T19:01:00.000Z",
      tool: { name: "shell", namespace: "codex" },
      output: { text: "exit 0" },
      state: "done",
    });
  });

  it("keeps a lifecycle entry in the slot it first arrived in", () => {
    const earlier = fold([
      event("run.started", { status: "running" }),
      event("tool.started", {
        arguments: { command: "pnpm test" },
        callId: "call-1",
        tool: { name: "shell", namespace: "codex" },
      }),
    ]);
    const note = createId("message");
    const later = fold([
      event("assistant.message", {
        content: [{ text: "Tests are slow.", type: "text" }],
        messageId: note,
      }),
      event("tool.completed", { callId: "call-1", isError: false, output: { text: "ok" } }),
      event("run.usage", { inputTokens: 10, outputTokens: 2 }),
      event("run.completed", { replyMessageId: null, status: "completed" }),
    ]);

    const merged = mergeTranscriptSegments(earlier, later);
    expect(merged.map((entry) => entry.kind)).toEqual(["run", "tool", "message"]);
    expect(merged[0]).toMatchObject({ createdAt: now, status: "completed" });
    expect(merged[1]).toMatchObject({ state: "done" });
  });

  it("settles what the older page left open once the newer page shows the Run ended", () => {
    const earlier = fold([
      event("run.started", { status: "running" }),
      event("tool.started", {
        arguments: { command: "sleep 100" },
        callId: "call-1",
        tool: { name: "shell", namespace: "codex" },
      }),
    ]);
    const later = fold([
      event("run.usage", { inputTokens: 1, outputTokens: 1 }),
      event("run.interrupted", { status: "interrupted" }),
    ]);

    const merged = mergeTranscriptSegments(earlier, later);
    expect(merged.find((entry) => entry.kind === "tool")).toMatchObject({ state: "stopped" });
    expect(merged.find((entry) => entry.kind === "run")).toMatchObject({ status: "interrupted" });
  });

  it("keeps earlier-only entries ahead of the later segment", () => {
    const earlier = fold([event("run.started", { status: "running" })]);
    const later = fold([
      event("assistant.message", {
        content: [{ text: "Done.", type: "text" }],
        messageId: createId("message"),
      }),
    ]);
    expect(mergeTranscriptSegments(earlier, later).map((entry) => entry.kind)).toEqual([
      "run",
      "message",
    ]);
  });
});

describe("run usage", () => {
  it("attaches usage to the Run it names without disturbing its lifecycle", () => {
    const entries = fold([
      event("run.started", { status: "running" }),
      event("run.usage", { costUsd: 0.0873, inputTokens: 18_430, outputTokens: 1_265 }),
      event("run.completed", { replyMessageId: null, status: "completed" }),
    ]);

    expect(entries.find((entry) => entry.kind === "run")).toMatchObject({
      status: "completed",
      usage: { costUsd: 0.0873, inputTokens: 18_430, outputTokens: 1_265 },
    });
  });

  it("ignores usage for a Run the transcript has never seen", () => {
    expect(fold([event("run.usage", { inputTokens: 10, outputTokens: 2 })])).toEqual([]);
  });
});

describe("queued input outcomes", () => {
  const messageId = createId("message");
  const input = {
    assignmentId: null,
    cancelReason: null,
    causalChainId: createId("causalChain"),
    createdAt: now,
    deliveredAt: null,
    messageId,
    policy: "queue" as const,
    replyTarget: null,
    runId: null,
    state: "pending" as const,
    threadId,
    updatedAt: now,
  };
  const created = event(
    "message.created",
    {
      input,
      message: {
        author: {
          displayName: "Owner",
          kind: "human" as const,
          principalId: "user:test-owner",
          userId: createId("user"),
        },
        content: [{ text: "After this, rename the branch", type: "text" as const }],
        createdAt: now,
        id: messageId,
        kind: "input" as const,
        runId: null,
        sequence: SequenceSchema.parse("1"),
        threadId,
      },
    },
    { runId: null },
  );

  it("replaces a withdrawn message with a marker the conversation never shows", () => {
    const withdrawal = event(
      "thread-input.updated",
      { input: { ...input, cancelReason: "withdrawn", state: "cancelled" } },
      { runId: null },
    );
    const entries = fold([created, withdrawal]);
    expect(entries).toEqual([
      { createdAt: input.updatedAt, id: input.messageId, kind: "withdrawn" },
    ]);
    expect(visibleTranscript(entries, null)).toEqual([]);

    // The message can sit on an earlier page than its withdrawal; the marker
    // the later page folded still cancels it when the pages are joined.
    const merged = mergeTranscriptSegments(fold([created]), fold([withdrawal]));
    expect(visibleTranscript(merged, null)).toEqual([]);
  });

  it("says a queued message cancelled before its turn was not sent", () => {
    const stopped = fold([
      created,
      event(
        "thread-input.updated",
        { input: { ...input, cancelReason: "run-ended-before-start", state: "cancelled" } },
        { runId: null },
      ),
    ]);
    expect(stopped).toEqual([
      expect.objectContaining({
        body: "After this, rename the branch",
        delivery: { reason: "Not sent: run ended before start.", status: "failed" },
      }),
    ]);

    const unexplained = fold([
      created,
      event("thread-input.updated", { input: { ...input, state: "cancelled" } }, { runId: null }),
    ]);
    expect(unexplained[0]).toMatchObject({ delivery: { reason: "Not sent.", status: "failed" } });
  });

  /*
   * Placement. What can go wrong: a queued message stays inside the turn that
   * was running when it was sent; joining two history pages puts it back where
   * it was sent; a placement whose creation sits on an older page is dropped.
   */
  describe("placement", () => {
    const replyId = createId("message");
    const reply = event("message.created", {
      input: null,
      message: {
        author: {
          displayName: "Opensteer",
          kind: "agent" as const,
          runId,
          threadId,
          workspaceId,
          workspaceName: "Main",
        },
        content: [{ text: "Still working", type: "text" as const }],
        createdAt: now,
        id: replyId,
        kind: "assistant" as const,
        runId,
        sequence: SequenceSchema.parse("2"),
        threadId,
      },
    });
    const placed = event(
      "message.placed",
      { message: { ...created.data.message, sequence: SequenceSchema.parse("3") } },
      { runId: createId("run") },
    );

    it("moves a queued message to where a Run took it", () => {
      expect(fold([created, reply, placed]).map(({ id }) => id)).toEqual([replyId, messageId]);
    });

    it("keeps the later place when the creation sits on an older page", () => {
      const merged = mergeTranscriptSegments(fold([created, reply]), fold([placed]));
      expect(merged.map(({ id }) => id)).toEqual([replyId, messageId]);
      expect(merged[1]).toMatchObject({ body: "After this, rename the branch", kind: "message" });
    });

    it("shows a placed message whose creation this page never saw", () => {
      expect(fold([reply, placed]).map(({ id }) => id)).toEqual([replyId, messageId]);
    });
  });

  it("leaves a message untouched while a Run holds its input", () => {
    const claimed = fold([
      created,
      event("thread-input.updated", { input: { ...input, runId, state: "claimed" } }),
    ]);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).not.toHaveProperty("delivery");
  });
});

describe("visibleTranscript", () => {
  const queuedId = createId("message");
  const shownId = createId("message");
  const entries: TranscriptEntry[] = [
    {
      author: { displayName: "Owner", kind: "human", principalId: "user:test-owner" },
      body: "Do the work",
      createdAt: now,
      id: shownId,
      kind: "message",
      messageKind: "input",
      runId,
    },
    {
      createdAt: now,
      error: null,
      id: `run:${runId}`,
      kind: "run",
      replyMessageId: null,
      runId,
      status: "running",
    },
    {
      author: { displayName: "Owner", kind: "human", principalId: "user:test-owner" },
      body: "And then this",
      createdAt: now,
      id: queuedId,
      kind: "message",
      messageKind: "input",
      runId: null,
    },
  ];

  function queue(items: ThreadInputQueue["items"]): ThreadInputQueue {
    return { items, paused: false, steerRunId: runId, threadId };
  }

  function queued(id: typeof queuedId): ThreadInputQueue["items"][number] {
    return {
      canCancel: true,
      canMove: true,
      canSteer: true,
      input: {
        assignmentId: null,
        cancelReason: null,
        causalChainId: createId("causalChain"),
        createdAt: now,
        deliveredAt: null,
        messageId: id,
        policy: "queue",
        replyTarget: null,
        runId: null,
        state: "pending",
        threadId,
        updatedAt: now,
      },
      message: {
        author: { displayName: "Owner", kind: "human", principalId: "user:test-owner" },
        content: [{ text: "And then this", type: "text" }],
        createdAt: now,
        id,
        kind: "input",
        runId: null,
        sequence: SequenceSchema.parse("2"),
        threadId,
      },
    };
  }

  it("hides exactly the messages the queue still holds", () => {
    const visible = visibleTranscript(entries, queue([queued(queuedId)]));
    expect(visible.map((entry) => entry.id)).toEqual([shownId, `run:${runId}`]);
  });
});

/*
 * A person's own words in a conversation. What can go wrong:
 *   - a message the Host holds for a moment is hidden, and the reader sees
 *     nothing happen after Send;
 *   - it is drawn where it was sent, so a reply that lands meanwhile appears
 *     below it, and placement then jumps it below that reply;
 *   - it is drawn twice: once as its entry and once as the waiting bubble;
 *   - someone else's queued input (an automation, another agent) is drawn as
 *     the reader's own bubble;
 *   - a placement the queue read has not caught up with sends the bubble back
 *     to the tail, under what the Run that took it has since written;
 *   - a withdrawn message's marker is drawn.
 */
describe("a conversation's waiting messages", () => {
  const owner = {
    displayName: "Owner",
    kind: "human" as const,
    principalId: "user:test-owner",
    userId: createId("user"),
  };
  const firstRun = runId;
  const secondRun = createId("run");

  function pendingInput(messageId: MessageId) {
    return {
      assignmentId: null,
      cancelReason: null,
      causalChainId: createId("causalChain"),
      createdAt: now,
      deliveredAt: null,
      messageId,
      policy: "queue" as const,
      replyTarget: null,
      runId: null,
      state: "pending" as const,
      threadId,
      updatedAt: now,
    };
  }

  type Author = Extract<AgentEvent, { type: "message.created" }>["data"]["message"]["author"];

  function sent(text: string, sequence: string, author: Author = owner) {
    const messageId = createId("message");
    const input = pendingInput(messageId);
    const message = {
      author,
      content: [{ text, type: "text" as const }],
      createdAt: now,
      id: messageId,
      kind: "input" as const,
      runId: null,
      sequence: SequenceSchema.parse(sequence),
      threadId,
    };
    return {
      created: event("message.created", { input, message }, { runId: null }),
      id: messageId,
      input,
      message,
      placed: (into: RunId, at: string) =>
        event(
          "message.placed",
          { message: { ...message, runId: into, sequence: SequenceSchema.parse(at) } },
          { runId: into },
        ),
      queued: (): ThreadInputQueue["items"][number] => ({
        canCancel: true,
        canMove: true,
        canSteer: false,
        input,
        message,
      }),
    };
  }

  function waitingQueue(items: ThreadInputQueue["items"]): ThreadInputQueue {
    return { items, paused: false, steerRunId: null, threadId };
  }

  /** What the reader sees, in order: messages by id, turns by their Run. */
  function frame(entries: readonly TranscriptEntry[], queue: ThreadInputQueue | null): string[] {
    return groupTranscriptEntries(visibleTranscript(entries, queue, { conversation: true })).map(
      (group) =>
        group.kind === "turn"
          ? `turn:${group.turn.runId}${group.turn.reply ? `:${group.turn.reply.id}` : ""}`
          : `${group.kind}:${group.kind === "message" ? group.entry.id : group.key}`,
    );
  }

  const ask = sent("What's on Thursday?", "1");
  const started = event("run.started", { status: "running" }, { runId: firstRun });
  const looking = event(
    "tool.started",
    {
      arguments: { command: "calendar" },
      callId: "call-cal",
      tool: { name: "Bash", namespace: "claude" },
    },
    { runId: firstRun },
  );
  const replyId = createId("message");
  const replied = event(
    "assistant.message",
    { content: [{ text: "Design review at 2.", type: "text" }], messageId: replyId },
    { runId: firstRun },
  );
  const completed = event(
    "run.completed",
    { replyMessageId: replyId, status: "completed" },
    { runId: firstRun },
  );

  it("draws a person's waiting message as a sent bubble after everything else, once", () => {
    const followUp = sent("And Friday?", "2");
    const entries = fold([
      ask.created,
      ask.placed(firstRun, "1"),
      started,
      looking,
      followUp.created,
    ]);
    const queue = waitingQueue([followUp.queued()]);
    const visible = visibleTranscript(entries, queue, { conversation: true });
    expect(visible.filter((entry) => entry.id === followUp.id)).toHaveLength(1);
    expect(visible.at(-1)).toMatchObject({ body: "And Friday?", id: followUp.id, kind: "message" });
    // Work keeps the tray: the same queue hides the message from the transcript.
    expect(visibleTranscript(entries, queue).some((entry) => entry.id === followUp.id)).toBe(false);
  });

  it("keeps the waiting bubbles in queue order and hides what someone else queued", () => {
    const automation = sent("Nightly check", "2", {
      displayName: "Nightly",
      kind: "trigger",
      occurrenceId: createId("triggerOccurrence"),
      source: "schedule",
      triggerId: createId("trigger"),
    });
    const first = sent("First", "3");
    const second = sent("Second", "4");
    const entries = fold([
      ask.created,
      ask.placed(firstRun, "1"),
      started,
      second.created,
      automation.created,
      first.created,
    ]);
    const queue = waitingQueue([automation.queued(), first.queued(), second.queued()]);
    const ids = visibleTranscript(entries, queue, { conversation: true }).map(({ id }) => id);
    expect(ids.slice(-2)).toEqual([first.id, second.id]);
    expect(ids).not.toContain(automation.id);
  });

  it("never moves a waiting bubble above a reply the reader has seen, before or after placement", () => {
    const followUp = sent("And Friday?", "2");
    const steps: {
      readonly events: readonly AgentEvent[];
      readonly queue: ThreadInputQueue | null;
    }[] = [
      { events: [ask.created, ask.placed(firstRun, "1"), started, looking], queue: null },
      { events: [followUp.created], queue: waitingQueue([followUp.queued()]) },
      { events: [replied, completed], queue: waitingQueue([followUp.queued()]) },
      // The Host places the message for the Run that takes it; the queue read lags.
      { events: [followUp.placed(secondRun, "4")], queue: waitingQueue([followUp.queued()]) },
      {
        events: [
          event("run.started", { status: "running" }, { runId: secondRun }),
          event(
            "tool.started",
            {
              arguments: { command: "calendar friday" },
              callId: "call-fri",
              tool: { name: "Bash", namespace: "claude" },
            },
            { runId: secondRun },
          ),
        ],
        queue: waitingQueue([followUp.queued()]),
      },
      { events: [], queue: waitingQueue([]) },
    ];
    let entries: TranscriptEntry[] = [];
    const frames: string[][] = [];
    for (const step of steps) {
      entries = fold(step.events, entries);
      frames.push(frame(entries, step.queue));
    }
    expect(frames).toEqual([
      [`message:${ask.id}`, `turn:${firstRun}`],
      [`message:${ask.id}`, `turn:${firstRun}`, `message:${followUp.id}`],
      [`message:${ask.id}`, `turn:${firstRun}:${replyId}`, `message:${followUp.id}`],
      [`message:${ask.id}`, `turn:${firstRun}:${replyId}`, `message:${followUp.id}`],
      [
        `message:${ask.id}`,
        `turn:${firstRun}:${replyId}`,
        `message:${followUp.id}`,
        `turn:${secondRun}`,
      ],
      [
        `message:${ask.id}`,
        `turn:${firstRun}:${replyId}`,
        `message:${followUp.id}`,
        `turn:${secondRun}`,
      ],
    ]);
  });

  it("keeps a message that joined the running Run where it was sent", () => {
    const joined = sent("Keep it short", "2");
    const claimed = event(
      "message.created",
      {
        input: { ...joined.input, runId: firstRun, state: "claimed" as const },
        message: { ...joined.message, runId: firstRun },
      },
      { runId: null },
    );
    const entries = fold([ask.created, ask.placed(firstRun, "1"), started, looking, claimed]);
    expect(frame(entries, waitingQueue([]))).toEqual([
      `message:${ask.id}`,
      `turn:${firstRun}`,
      `message:${joined.id}`,
      // The reply in progress now answers both messages, so it is drawn after the second.
      `turn:${firstRun}`,
    ]);
  });

  it("never draws a withdrawn message's marker", () => {
    const withdrawn = sent("Never mind", "2");
    const entries = fold([
      withdrawn.created,
      event(
        "thread-input.updated",
        { input: { ...withdrawn.input, cancelReason: "withdrawn", state: "cancelled" } },
        { runId: null },
      ),
    ]);
    expect(visibleTranscript(entries, waitingQueue([]), { conversation: true })).toEqual([]);
  });

  it("says a message a Stop cancelled was not sent because the reply was stopped", () => {
    const stopped = sent("And Friday?", "2");
    const entries = fold([
      stopped.created,
      event(
        "thread-input.updated",
        { input: { ...stopped.input, cancelReason: "stopped", state: "cancelled" } },
        { runId: null },
      ),
    ]);
    expect(entries).toEqual([
      expect.objectContaining({
        delivery: { reason: "Not sent: you stopped the reply.", status: "failed" },
        id: stopped.id,
      }),
    ]);
  });
});

/*
 * Delivery across history pages. Each page is folded on its own, so a
 * message's outcome can sit on a later page than the message itself. What can
 * go wrong: the outcome finds no message on its page and is dropped, so a
 * stopped message reads as sent once the earlier page loads; a later
 * `delivered` cannot clear an uncertainty the earlier page recorded; the
 * outcome is drawn as an entry of its own, or duplicates the message.
 */
describe("delivery outcomes across history pages", () => {
  const messageId = createId("message");
  const input = {
    assignmentId: null,
    cancelReason: null,
    causalChainId: createId("causalChain"),
    createdAt: now,
    deliveredAt: null,
    messageId,
    policy: "queue" as const,
    replyTarget: null,
    runId: null,
    state: "pending" as const,
    threadId,
    updatedAt: now,
  };
  const created = event(
    "message.created",
    {
      input,
      message: {
        author: {
          displayName: "Owner",
          kind: "human" as const,
          principalId: "user:test-owner",
          userId: createId("user"),
        },
        content: [{ text: "And Friday?", type: "text" as const }],
        createdAt: now,
        id: messageId,
        kind: "input" as const,
        runId: null,
        sequence: SequenceSchema.parse("1"),
        threadId,
      },
    },
    { runId: null },
  );
  const reply = event("assistant.message", {
    content: [{ text: "Thursday is clear.", type: "text" }],
    messageId: createId("message"),
  });
  const stopped = event(
    "thread-input.updated",
    { input: { ...input, cancelReason: "stopped", state: "cancelled" } },
    { runId: null },
  );
  const uncertain = event(
    "thread-input.updated",
    { input: { ...input, runId, state: "unknown" } },
    { runId: null },
  );
  const delivered = event(
    "thread-input.updated",
    { input: { ...input, deliveredAt: now, runId, state: "delivered" } },
    { runId: null },
  );

  it("keeps a Stop's cancellation when the message is on the earlier page", () => {
    const merged = mergeTranscriptSegments(fold([created]), fold([reply, stopped]));
    const visible = visibleTranscript(merged, null, { conversation: true });
    expect(visible.filter((entry) => entry.id === messageId)).toEqual([
      expect.objectContaining({
        body: "And Friday?",
        delivery: { reason: "Not sent: you stopped the reply.", status: "failed" },
        kind: "message",
      }),
    ]);
    expect(visibleTranscript(merged, null).map(({ id }) => id)).toEqual(
      visible.map(({ id }) => id),
    );
    expect(groupTranscriptEntries(merged).filter((group) => group.kind === "message")).toHaveLength(
      1,
    );
  });

  it("lets a later delivery clear an uncertainty, across any pages", () => {
    // Pages loaded newest first, as the client pages back.
    const later = mergeTranscriptSegments(fold([uncertain]), fold([reply, delivered]));
    const merged = mergeTranscriptSegments(fold([created]), later);
    expect(merged.find((entry) => entry.id === messageId)).toMatchObject({ kind: "message" });
    expect(merged.find((entry) => entry.id === messageId)).not.toHaveProperty("delivery");

    // The uncertainty on the message's own page, and its confirmation later on.
    const confirmed = mergeTranscriptSegments(fold([created, uncertain]), fold([delivered]));
    expect(confirmed.find((entry) => entry.id === messageId)).not.toHaveProperty("delivery");

    const stillUncertain = mergeTranscriptSegments(fold([created]), fold([uncertain]));
    expect(stillUncertain.find((entry) => entry.id === messageId)).toMatchObject({
      delivery: { reason: "Message delivery could not be confirmed.", status: "unconfirmed" },
    });
  });

  it("draws nothing for an outcome whose message is not loaded", () => {
    const entries = fold([reply, stopped]);
    expect(visibleTranscript(entries, null).map(({ id }) => id)).toEqual([reply.data.messageId]);
    expect(visibleTranscript(entries, null, { conversation: true }).map(({ id }) => id)).toEqual([
      reply.data.messageId,
    ]);
  });
});

it("a terminal page carries the waking author without the start and later upserts preserve it", () => {
  const startedBy = { kind: "platform" as const, cause: "assignment-result" };
  const entries = fold([
    event("run.completed", { status: "completed", replyMessageId: null, startedBy }),
  ]);
  expect(entries[0]).toMatchObject({ kind: "run", startedBy });
  const updated = fold([event("run.status", { status: "completed", startedBy })], entries);
  expect(updated[0]).toMatchObject({ kind: "run", startedBy });
});

it("a phase can identify a Run first read from an older Host without reopening a settled Run", () => {
  const startedBy = { kind: "platform" as const, cause: "assignment-result" };
  for (const initial of [
    event("run.started", { status: "running" }),
    event("run.completed", { status: "completed", replyMessageId: null }),
  ]) {
    const entries = fold([initial, event("run.phase", { phase: "turn", startedBy })]);
    expect(entries[0]).toMatchObject({ startedBy, status: initial.data.status });
  }
});
