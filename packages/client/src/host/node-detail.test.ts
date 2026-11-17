import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { subagentDetail, type NodeDetailSnapshot } from "./node-detail.js";
import { nodeTranscriptCard } from "./transcript-item-view.js";
import type { SubagentReader } from "./subagent-model.js";

const time = "2026-11-17T18:00:00.000Z";
const threadId = createId("thread");
const nodeId = createId("executionNode");
const childId = createId("executionNode");
const runId = createId("run");
const attemptId = createId("runAttempt");
const base = {
  createdAt: time,
  position: "1",
  revision: "1",
  runId,
  attemptId,
  isTurnStart: false,
};
const subject = {
  ...base,
  kind: "node" as const,
  id: `node:${nodeId}`,
  nodeId: null,
  executionNodeId: nodeId,
  view: {},
  node: {
    id: nodeId,
    kind: "subagent" as const,
    parentNodeId: null,
    runId,
    attemptId,
    status: "completed" as const,
    model: "gpt-6",
    effort: "high",
    phaseIndex: null,
    phases: [],
    title: "Check the parser",
    prompt: "Review the parser",
    result: "The result",
    startedAt: time,
    endedAt: time,
    usage: null,
  },
};
const reader: SubagentReader = {
  assignments: {},
  connection: "connected",
  environments: [],
  network: "unknown",
  threads: [],
  waitingRequests: [],
};

it("presents every detail state with an immediate card, nested cards and one result", () => {
  const summary = nodeTranscriptCard(subject);
  const child = nodeTranscriptCard({
    ...subject,
    executionNodeId: childId,
    id: `node:${childId}`,
    nodeId,
    node: {
      ...subject.node,
      id: childId,
      parentNodeId: nodeId,
      title: "Nested helper",
      status: "running",
      result: null,
      endedAt: null,
    },
  });
  const message = nodeTranscriptCard({
    ...base,
    kind: "node-message",
    id: "result-line",
    nodeId,
    view: { preview: "The result" },
  });
  if (summary?.kind !== "node" || child?.kind !== "node" || !message)
    throw new Error("Missing node cards");
  const raw: NodeDetailSnapshot = {
    nodeId,
    threadId,
    node: null,
    status: "loading",
    entries: [],
    hasMore: false,
    loadingOlder: false,
    error: null,
  };
  for (const status of ["loading", "error", "unavailable", "missing", "closed"] as const) {
    expect(subagentDetail({ ...raw, status }, summary, reader)).toMatchObject({
      state: status === "closed" ? "missing" : status,
      card: { title: "Check the parser" },
      prompt: "Review the parser",
      parent: { threadId, title: "Parent conversation" },
    });
  }
  expect(subagentDetail({ ...raw, status: "ready" }, summary, reader)).toMatchObject({
    state: "summary-only",
    result: "The result",
  });
  expect(
    subagentDetail(
      {
        ...raw,
        status: "ready",
        node: summary,
        entries: [message, child],
        hasMore: true,
        loadingOlder: true,
      },
      summary,
      reader,
    ),
  ).toMatchObject({
    state: "ready",
    card: { tone: "finished" },
    result: null,
    hasEarlier: true,
    loadingEarlier: true,
    entries: [
      { kind: "message", text: "The result" },
      { kind: "agent", card: { title: "Nested helper" } },
    ],
  });
  expect(
    subagentDetail({ ...raw, nodeId: childId, status: "ready", node: child }, child, {
      ...reader,
      transcripts: { [threadId]: [summary] },
    }).parent,
  ).toEqual({ title: "Check the parser", nodeId, threadId });
});
