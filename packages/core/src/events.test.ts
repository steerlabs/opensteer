import { describe, expect, it } from "vitest";
import {
  AgentEventSchema,
  AgentEventViewSchema,
  runnerEventDataSchemas,
  createId,
} from "./index.js";

const createdAt = "2026-08-23T20:00:00.000Z";
const environmentId = createId("environment");
const workspaceId = createId("workspace");
const threadId = createId("thread");
const runId = createId("run");

function event<T>(type: string, data: T) {
  return {
    createdAt,
    data,
    environmentId,
    eventId: createId("event"),
    runId,
    sequence: "1",
    threadId,
    type,
    workspaceId,
  };
}

describe("Agent event contracts", () => {
  it("validates Host Thread status strictly and tolerates additive view fields", () => {
    const changed = {
      ...event("thread.state-changed", {
        inputQueuePaused: false,
        pendingRequests: 0,
        status: "waiting",
      }),
      runId: null,
    };
    expect(AgentEventSchema.parse(changed)).toEqual(changed);
    expect(AgentEventSchema.safeParse({ ...changed, data: { status: "unknown" } }).success).toBe(
      false,
    );
    const extended = { ...changed, data: { ...changed.data, future: true } };
    expect(AgentEventSchema.safeParse(extended).success).toBe(false);
    expect(AgentEventViewSchema.parse(extended)).toEqual(changed);
  });

  it("keeps delegation outcome separate from result delivery", () => {
    const delegationId = createId("delegation");
    const childRunId = createId("run");
    const childThreadId = createId("thread");
    const resultMessageId = createId("message");
    const settled = event("delegation.settled", {
      childRunId,
      childThread: { id: childThreadId, title: "Sales Agent", workspaceId },
      delegationId,
      delivery: { resultMessageId, status: "delivered" },
      failure: null,
      outcome: "completed",
      resultPreview: "Inspection complete.",
      taskPreview: "Inspect the sales integrations.",
    });

    expect(AgentEventSchema.parse(settled)).toEqual(settled);
    expect(
      AgentEventSchema.safeParse({
        ...settled,
        data: {
          ...settled.data,
          delivery: { reason: "authority-unavailable", status: "delivered" },
        },
      }).success,
    ).toBe(false);
  });

  it("bounds delegation previews by UTF-8 bytes", () => {
    const settled = event("delegation.settled", {
      childRunId: createId("run"),
      childThread: { id: createId("thread"), title: "Worker", workspaceId },
      delegationId: createId("delegation"),
      delivery: { reason: "execution-authority-unavailable", status: "undeliverable" },
      failure: null,
      outcome: "completed",
      resultPreview: null,
      taskPreview: "🙂".repeat(513),
    });

    expect(AgentEventSchema.safeParse(settled).success).toBe(false);
  });

  it("requires canonical tool identity and rejects the legacy display string", () => {
    const started = event("tool.started", {
      arguments: { task: "Inspect integrations" },
      callId: "call-1",
      tool: { name: "thread_delegate", namespace: "opensteer" },
    });

    expect(AgentEventSchema.parse(started)).toEqual(started);
    expect(
      AgentEventSchema.safeParse({
        ...started,
        data: { arguments: {}, callId: "call-1", name: "thread_delegate" },
      }).success,
    ).toBe(false);
  });

  it("requires canonical bounded tool output and keeps streaming text out of the log", () => {
    const completed = event("tool.completed", {
      callId: "call-1",
      isError: false,
      output: { text: "12 tests passed" },
    });

    expect(AgentEventSchema.parse(completed)).toEqual(completed);
    expect(
      AgentEventSchema.safeParse({
        ...completed,
        data: { callId: "call-1", isError: false, output: { stdout: "legacy" } },
      }).success,
    ).toBe(false);
    // Streaming text is live progress, never a durable event.
    for (const type of ["assistant.delta", "reasoning.delta", "tool.delta"]) {
      expect(
        AgentEventSchema.safeParse({ ...completed, data: { callId: "call-1", text: "12" }, type })
          .success,
      ).toBe(false);
    }
  });

  it("states a Run's usage as whole non-negative counts and nothing it was not told", () => {
    const minimal = event("run.usage", { inputTokens: 18_430, outputTokens: 1_265 });
    const complete = event("run.usage", {
      cacheWriteTokens: 1_984,
      cachedInputTokens: 12_760,
      costUsd: 0.0873,
      inputTokens: 18_430,
      outputTokens: 1_265,
      reasoningTokens: 640,
    });

    expect(AgentEventSchema.parse(minimal)).toEqual(minimal);
    expect(AgentEventSchema.parse(complete)).toEqual(complete);
    for (const data of [
      { inputTokens: 18_430 },
      { inputTokens: -1, outputTokens: 1_265 },
      { inputTokens: 18_430.5, outputTokens: 1_265 },
      { inputTokens: Number.MAX_SAFE_INTEGER + 2, outputTokens: 1_265 },
      { costUsd: -0.01, inputTokens: 18_430, outputTokens: 1_265 },
      { costUsd: Number.POSITIVE_INFINITY, inputTokens: 18_430, outputTokens: 1_265 },
      { inputTokens: 18_430, outputTokens: 1_265, totalTokens: 19_695 },
    ]) {
      expect(AgentEventSchema.safeParse(event("run.usage", data)).success).toBe(false);
    }
  });
});

it("requires the seed author durably, accepts older Host omissions, and keeps it out of Runner data", () => {
  const startedBy = { kind: "platform", cause: "assignment-result" };
  for (const [type, data] of [
    ["run.started", { status: "running" }],
    ["run.status", { status: "starting" }],
    ["run.restarted", { attempt: 2, reason: "steer" }],
    ["run.phase", { phase: "turn" }],
    ["run.completed", { status: "completed", replyMessageId: null }],
    ["run.failed", { status: "failed", code: "test", message: "Failed", retryable: false }],
    ["run.interrupted", { status: "interrupted" }],
  ] as const) {
    expect(AgentEventSchema.safeParse(event(type, data)).success).toBe(false);
    expect(AgentEventViewSchema.safeParse(event(type, data)).success).toBe(true);
    expect(AgentEventSchema.safeParse(event(type, { ...data, startedBy })).success).toBe(true);
  }
  expect(runnerEventDataSchemas["run.completed"].parse({ status: "completed" })).toEqual({
    status: "completed",
  });
});
