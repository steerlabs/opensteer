import {
  BrowserPageContentPartSchema,
  createId,
  DeviceIdSchema,
  MessageViewSchema,
  RequestSchema,
} from "@opensteer/core";
import { TranscriptItemSchema, type TranscriptItem } from "@opensteer/protocol/transcript";
import { expect, it } from "vitest";
import { conversationTurn, groupTranscriptEntries, workSummary } from "./agent-activity-model.js";
import type { TranscriptEntry } from "./client.js";
import { nodeTranscriptCard, transcriptCard } from "./transcript-item-view.js";
import { requestReceipt, visibleTranscript } from "./transcript.js";

const time = "2026-11-17T18:00:00.000Z";
const endedAt = "2026-11-17T19:00:02.000Z";
const threadId = createId("thread");
const runId = createId("run");
const attemptId = createId("runAttempt");
const base = {
  createdAt: time,
  position: "1",
  revision: "1",
  runId,
  attemptId,
  nodeId: null,
  isTurnStart: false,
};

function message(preview: string) {
  const messageId = createId("message");
  return {
    ...base,
    kind: "message" as const,
    messageKind: "assistant" as const,
    id: messageId,
    messageId,
    view: { preview },
  } satisfies TranscriptItem;
}

function itemCard(item: TranscriptItem, live = false) {
  const card = transcriptCard(TranscriptItemSchema.parse(item), undefined, live);
  if (!card) throw new Error(`Missing ${item.kind} card`);
  return card;
}

function tool(status: string) {
  return {
    ...base,
    kind: "tool" as const,
    id: "tool:check",
    toolCallId: "check",
    tool: { name: "Bash", namespace: "claude" },
    view: { status },
  } satisfies TranscriptItem;
}

function run(status: string, replyMessageId = message("").messageId) {
  return itemCard({
    ...base,
    id: `run:${runId}`,
    kind: "run",
    replyMessageId: status === "running" ? null : replyMessageId,
    view: { status },
  });
}

function turn(entries: readonly TranscriptEntry[]) {
  const group = groupTranscriptEntries(entries).findLast(({ kind }) => kind === "turn");
  if (group?.kind !== "turn") throw new Error("Expected a Run turn");
  return group.turn;
}

it("offers Claude's tool while the same draft streams before or after it", () => {
  const active = run("running");
  const check = itemCard(tool("done"));
  const answer = message("Let me check. Two files.");
  const draft = itemCard(answer, true);
  for (const entries of [
    [active, draft, check],
    [active, check, draft],
  ]) {
    expect(conversationTurn(turn(entries))).toMatchObject({ composing: true, steps: [check] });
  }
  expect(
    conversationTurn(turn([run("completed", answer.id), itemCard(answer), check])),
  ).toMatchObject({
    composing: false,
    steps: [check],
    reply: { id: answer.id },
  });
});

it("offers Codex's recorded preamble and tool, and leaves a plain reply closed", () => {
  const preamble = itemCard(message("Let me check."));
  const check = itemCard({ ...tool("done"), tool: { name: "shell", namespace: "codex" } });
  const answer = message("Two files.");
  for (const [activity, response] of [
    [run("running"), itemCard(answer, true)],
    [run("running"), itemCard(answer)],
    [run("completed", answer.id), itemCard(answer)],
  ] as const) {
    expect(conversationTurn(turn([activity, preamble, check, response])).steps).toEqual([
      preamble,
      check,
    ]);
    expect(conversationTurn(turn([activity, response]))).toMatchObject({
      detailed: false,
      steps: [],
    });
  }
});

it("keeps a pending Request off the transcript and draws its terminal receipt at the same identity", () => {
  const requestId = createId("request");
  const pending = {
    ...base,
    id: `request:${requestId}`,
    kind: "request" as const,
    requestId,
    requestKind: "harness.approval" as const,
    view: { status: "pending" },
  };
  expect(visibleTranscript([itemCard(pending)], null)).toEqual([]);
  const receipt = itemCard({
    ...pending,
    revision: "2",
    createdAt: endedAt,
    view: { status: "declined", title: "Publish externally", preview: "Declined · Cancel" },
  });
  expect(visibleTranscript([receipt], null)).toEqual([
    {
      id: pending.id,
      createdAt: endedAt,
      runId,
      kind: "request",
      requestKind: "harness.approval",
      requestId,
      title: "Publish externally",
      outcome: "Declined · Cancel",
      declined: true,
    },
  ]);
});

it("renders a stopped tool without an error and reads its structured body on demand", () => {
  const item = tool("stopped");
  expect(itemCard(item)).toMatchObject({
    id: item.id,
    callId: "check",
    state: "stopped",
    isError: false,
    output: undefined,
  });
  expect(itemCard(tool("failed"))).toMatchObject({ state: "failed", isError: true });
  const text = `Checked the file.\n${"🙂".repeat(4000)}`;
  const completed = tool("done");
  expect(itemCard(completed)).toMatchObject({ callId: "check", output: undefined });
  expect(
    transcriptCard(completed, {
      kind: "tool",
      arguments: { command: "pnpm test", cwd: "/workspace" },
      output: { text },
    }),
  ).toMatchObject({
    id: completed.id,
    tool: completed.tool,
    arguments: { command: "pnpm test", cwd: "/workspace" },
    output: { text },
    state: "done",
  });
});

it("carries usage on the terminal Run without losing its reply or failure", () => {
  const replyMessageId = createId("message");
  const failure = {
    code: "runner_lost",
    message: "The Runner disconnected.",
    retryable: true,
    status: "failed" as const,
  };
  const usage = { costUsd: 0.0873, inputTokens: 18430, outputTokens: 1265 };
  expect(
    itemCard({
      ...base,
      kind: "run",
      id: `run:${runId}`,
      view: { status: "failed" },
      replyMessageId,
      failure,
      usage,
      endedAt,
    }),
  ).toMatchObject({
    runId,
    status: "failed",
    replyMessageId,
    error: failure,
    usage,
    endedAt,
  });
});

it("hides model-control bodies and keeps Run recovery and addressed publications", () => {
  const item = message("Control text");
  const body = (kind: string, cause: string, text: string, addressedToUserId?: string) => ({
    kind: "message" as const,
    message: MessageViewSchema.parse({
      id: item.id,
      threadId,
      runId,
      kind,
      author:
        kind === "run-result" || kind === "assistant"
          ? { kind: "agent", displayName: "Opensteer", runId, threadId }
          : { kind: "platform", cause },
      content: [{ type: "text", text }],
      sequence: "1",
      createdAt: time,
      addressedToUserId,
    }),
  });
  expect(
    transcriptCard(item, body("run-result", "assignment-result", "Private result")),
  ).toBeUndefined();
  expect(transcriptCard(item, body("continuation", "context-window", "Continue"))).toBeUndefined();
  expect(
    transcriptCard(item, body("continuation", "run-recovery", "Your conversation is intact.")),
  ).toMatchObject({
    messageKind: "continuation",
    author: { kind: "platform", cause: "run-recovery" },
    body: "Your conversation is intact.",
  });
  const addressed = transcriptCard(
    item,
    body("assistant", "transcript", "Milestone.", createId("user")),
  );
  if (addressed?.kind !== "message") throw new Error("Missing addressed message");
  const groups = groupTranscriptEntries([
    run("running"),
    itemCard(message("Still drafting"), true),
    addressed,
  ]);
  expect(groups.find((group) => group.kind === "message")).toMatchObject({
    kind: "message",
    key: item.id,
    entry: { body: "Milestone.", addressedToUserId: addressed.addressedToUserId },
  });
});

it("keeps a completed delegation as one typed assignment card", () => {
  const delegationId = createId("delegation");
  const childRunId = createId("run");
  const worker = {
    id: createId("thread"),
    environmentId: createId("environment"),
    pendingRequests: 0,
    status: "idle" as const,
    title: "Sales Agent",
    icon: null,
  };
  const assignment = {
    id: delegationId,
    origin: "run" as const,
    parentThreadId: threadId,
    initialRunId: childRunId,
    currentRunId: childRunId,
    currentRunStatus: "completed" as const,
    workerThread: worker,
    objectivePreview: "Inspect the available integrations.",
    resultPreview: "Inspection complete.",
    status: "completed" as const,
    returnStatus: "delivered" as const,
    modelLabel: null,
    updatedAt: endedAt,
    createdAt: time,
    finishedAt: endedAt,
    revision: 2,
  };
  const id = `assignment:${delegationId}`;
  const card = itemCard({
    ...base,
    runId: null,
    id,
    kind: "assignment",
    delegationId,
    assignment,
    view: {},
  });
  expect(groupTranscriptEntries([card])).toEqual([
    {
      kind: "assignment",
      key: id,
      entry: { id, kind: "assignment", runId: null, createdAt: time, assignment },
    },
  ]);
});

it("names external Request decisions and keeps a Stop's wait out of work time", () => {
  const deviceId = DeviceIdSchema.parse(createId("runner"));
  const request = {
    id: createId("request"),
    originatingThreadId: threadId,
    originatingRunId: runId,
    originatingOccurrenceId: null,
    createdAt: "2026-11-17T18:00:02.000Z",
    resolvedAt: endedAt,
    requestedBy: createId("user"),
    resolvedBy: createId("user"),
    requiredActor: "requester",
    callId: "check",
    cancellationReason: null,
    kind: "machine.full-disk-access",
    mode: "durable",
    payload: {
      kind: "machine.full-disk-access",
      machineId: deviceId,
      machineName: "Mac mini",
      reason: "Read the inbox",
    },
    presentation: {
      kind: "external",
      title: "Allow full access on Mac mini",
      detail: "Read the inbox",
      subject: { id: deviceId, kind: "machine" },
    },
  };
  for (const [status, response, outcome] of [
    ["declined", { kind: "external", value: { decision: "declined" } }, "Declined"],
    ["fulfilled", { kind: "external", value: { decision: "fulfilled" } }, "Allowed"],
    ["fulfilled", { kind: "external" }, "Fulfilled"],
  ] as const) {
    const decision = RequestSchema.parse({ ...request, status, response });
    if (decision.status === "pending") throw new Error("Expected an external decision");
    const receipt = requestReceipt(decision);
    expect(receipt).toMatchObject({ requestId: request.id, outcome });
    expect(receipt).not.toHaveProperty("waitedSince");
  }
  for (const [status, outcome] of [
    ["fulfilled", "Allowed on iPhone"],
    ["declined", "Declined on iPhone"],
  ] as const) {
    const device = RequestSchema.parse({
      ...request,
      status,
      kind: "computer.app.access",
      payload: {
        kind: "computer.app.access",
        access: "read",
        app: null,
        definitionId: "android-phone",
        deviceId,
        setupRequestId: crypto.randomUUID(),
        reason: "Read the screen",
      },
      response: { kind: "external", value: { decision: status } },
      settlementProvenance: { deviceLabel: "iPhone" },
    });
    if (device.status === "pending") throw new Error("Expected a Device decision");
    expect(requestReceipt(device).outcome).toBe(outcome);
  }
  const cancelled = RequestSchema.parse({
    ...request,
    kind: "harness.approval",
    mode: "live",
    payload: { kind: "harness.approval" },
    presentation: {
      kind: "choice",
      detail: "Publish the release",
      title: "Publish externally",
      risk: "high",
      options: [
        { hint: "reject-once", id: "reject", label: "Not now" },
        { hint: "confirm", id: "allow", label: "Publish" },
      ],
    },
    status: "cancelled",
    resolvedBy: null,
    response: null,
    cancellationReason: "run-ended",
  });
  if (cancelled.status !== "cancelled") throw new Error("Expected cancellation");
  const work = itemCard(tool("stopped"));
  if (work.kind !== "tool") throw new Error("Expected a tool card");
  expect(
    workSummary(
      turn([run("interrupted"), { ...work, completedAt: endedAt }, requestReceipt(cancelled)]),
    ),
  )?.toEqual({ label: "Worked for 2s", state: "settled" });
});

it("keeps a node's message and live reasoning in its detail card family", () => {
  const nodeId = createId("executionNode");
  const line = {
    ...base,
    id: "node-line",
    kind: "node-message" as const,
    nodeId,
    view: { preview: "Read the file", truncated: true },
  };
  expect(transcriptCard(line)).toBeUndefined();
  expect(nodeTranscriptCard(line)).toMatchObject({
    id: line.id,
    text: "Read the file",
    previewTruncated: true,
  });
  expect(
    nodeTranscriptCard(
      {
        ...base,
        id: "node-thought",
        kind: "reasoning",
        nodeId,
        blockId: "thought",
        bindingGeneration: 1,
        view: {},
      },
      true,
    ),
  ).toMatchObject({ kind: "reasoning", state: "streaming" });
  expect(nodeTranscriptCard({ ...tool("stopped"), nodeId })).toMatchObject({
    kind: "tool",
    nodeId,
    state: "stopped",
  });
});

it("draws a message's attachments, pages and places from its card, with no body read", () => {
  const attachment = {
    type: "artifact" as const,
    artifactId: "artifact-1",
    mediaType: "image/png",
    name: "shot.png",
  };
  const page = BrowserPageContentPartSchema.parse({
    type: "browser-page",
    sessionId: `bsn_${crypto.randomUUID()}`,
    tabId: "tab-1",
    title: "Docs",
    url: "https://example.com",
  });
  const place = {
    type: "phone" as const,
    machineId: DeviceIdSchema.parse(createId("device")),
    display: "main",
    name: "Pixel",
  };
  const cases = [
    { name: "an attachment-only reply", item: { ...message(""), attachments: [attachment] } },
    {
      name: "short text and an attachment",
      item: { ...message("See"), attachments: [attachment] },
    },
    { name: "pages and places", item: { ...message("Open"), pages: [page], places: [place] } },
    {
      name: "the reader's own message",
      item: {
        ...message("Here"),
        messageKind: "input" as const,
        isTurnStart: true,
        author: { kind: "human" as const, principalId: "me", displayName: "Me" },
        attachments: [attachment],
      },
    },
  ];
  for (const { name, item } of cases) {
    const card = itemCard(item);
    expect(card, name).toMatchObject({
      kind: "message",
      previewTruncated: false,
      ...("attachments" in item ? { attachments: item.attachments } : {}),
      ...("pages" in item ? { pages: item.pages, places: item.places } : {}),
    });
  }
  // References past the card's bounds stay in the body, which the card still offers.
  const cut = itemCard({
    ...message(""),
    attachments: [attachment],
    view: { preview: "", truncated: true },
  });
  expect(cut).toMatchObject({ previewTruncated: true, attachments: [attachment] });
});
