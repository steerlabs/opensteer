import { describe, expect, it } from "vitest";
import { createId } from "./ids.js";
import {
  AssignmentSchema,
  MessageContentSchema,
  MessageSchema,
  ProviderContinuationIdentitySchema,
  runnerRunsItsDeployment,
  messageContentMaxSerializedBytes,
  messageAuthorCanWriteKind,
  type MessageAuthor,
  type MessageKind,
} from "./models.js";

describe("the Runner that is its Deployment", () => {
  it("names only a Personal Deployment's own main Runner", () => {
    const personalMain = {
      deploymentIsPersonal: true,
      ownerKind: "deployment",
      runnerKind: "main",
    } as const;

    expect(runnerRunsItsDeployment(personalMain)).toBe(true);
    expect(runnerRunsItsDeployment({ ...personalMain, deploymentIsPersonal: false })).toBe(false);
    expect(runnerRunsItsDeployment({ ...personalMain, ownerKind: "user" })).toBe(false);
    expect(runnerRunsItsDeployment({ ...personalMain, runnerKind: "local" })).toBe(false);
    expect(runnerRunsItsDeployment({ ...personalMain, runnerKind: "managed" })).toBe(false);
  });
});

describe("provider continuation privacy", () => {
  it("accepts only the Runner's opaque projection", () => {
    expect(
      ProviderContinuationIdentitySchema.safeParse({
        continuationKey: "runner:v1:8tErnQuB1d-nw979Rab9a4JN0RE_tKRvI_Rtmy45Bbo",
        driverKind: "codex",
      }).success,
    ).toBe(true);
    expect(
      ProviderContinuationIdentitySchema.safeParse({
        continuationKey: "codex:home:/Users/person/.codex",
        driverKind: "codex",
      }).success,
    ).toBe(false);
  });
});

describe("durable message content", () => {
  it("enforces the serialized byte ceiling for multibyte text", () => {
    const accepted = [{ text: "😀".repeat(84 * 1_024), type: "text" as const }];
    const rejected = [{ text: "😀".repeat(90 * 1_024), type: "text" as const }];

    expect(new TextEncoder().encode(JSON.stringify(accepted)).byteLength).toBeLessThan(
      messageContentMaxSerializedBytes,
    );
    expect(MessageContentSchema.safeParse(accepted).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(rejected)).byteLength).toBeGreaterThan(
      messageContentMaxSerializedBytes,
    );
    expect(MessageContentSchema.safeParse(rejected).success).toBe(false);
  });
});

describe("durable message authorship", () => {
  it("uses the canonical author-kind compatibility rule in MessageSchema", () => {
    const authors: readonly MessageAuthor[] = [
      { displayName: "User", kind: "human", principalId: "principal:test" },
      {
        displayName: "Research agent",
        kind: "agent",
        runId: createId("run"),
        threadId: createId("thread"),
      },
      {
        displayName: "Webhook",
        kind: "trigger",
        occurrenceId: createId("triggerOccurrence"),
        source: "webhook",
        triggerId: createId("trigger"),
      },
      { cause: "continuation", kind: "platform" },
      {
        kind: "team-member",
        actor: "human",
        teamId: createId("deployment"),
        teamUserId: createId("user"),
        displayName: "Maya",
      },
      {
        kind: "team-member",
        actor: "agent",
        teamId: createId("deployment"),
        teamUserId: createId("user"),
        displayName: "Maya",
      },
    ];
    const kinds: readonly MessageKind[] = ["input", "assistant", "run-result", "continuation"];

    for (const author of authors) {
      for (const kind of kinds) {
        const expected = messageAuthorCanWriteKind(author, kind);
        expect(
          MessageSchema.safeParse({
            author,
            content: [{ text: "Test", type: "text" }],
            createdAt: new Date().toISOString(),
            id: createId("message"),
            kind,
            runId: null,
            sequence: "1",
            threadId: createId("thread"),
          }).success,
        ).toBe(expected);
      }
    }
  });
});

describe("Assignment result receipts", () => {
  const finished = {
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:00.000Z",
    id: createId("delegation"),
    initialInputMessageId: createId("message"),
    initialRunId: createId("run"),
    objective: "Check quietly",
    origin: "run",
    parentAssignmentId: null,
    parentOccurrenceId: null,
    parentRunId: createId("run"),
    parentThreadId: createId("thread"),
    parentWatchActivationId: null,
    replyTarget: null,
    revision: 1,
    resultRunId: createId("run"),
    resultText: "",
    returnAttemptedAt: null,
    returnMessageId: null,
    returnReason: null,
    returnStatus: "delivered",
    status: "completed",
    workerThreadId: createId("thread"),
  };
  it("accepts an empty completion without a return message", () => {
    expect(AssignmentSchema.safeParse(finished).success).toBe(true);
  });
  it("requires a receipt for a nonempty delivered result", () => {
    expect(AssignmentSchema.safeParse({ ...finished, resultText: "Found something" }).success).toBe(
      false,
    );
    expect(
      AssignmentSchema.safeParse({
        ...finished,
        resultText: "Found something",
        returnMessageId: createId("message"),
      }).success,
    ).toBe(true);
    expect(
      AssignmentSchema.safeParse({
        ...finished,
        resultText: "Found something",
        returnReason: "read-by-assigner",
      }).success,
    ).toBe(true);
  });
  it("rejects empty failures", () => {
    expect(
      AssignmentSchema.safeParse({ ...finished, status: "failed", returnStatus: "pending" })
        .success,
    ).toBe(false);
  });
});
