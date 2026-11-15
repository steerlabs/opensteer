import { createId, SequenceSchema } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  ClientToHostMessageSchema,
  LegacyHostToClientMessageSchema,
  LegacyDeploymentSnapshotSchema,
} from "./index.js";

const now = "2026-08-22T12:00:00.000Z";

function pendingRequest() {
  const threadId = createId("thread");
  return {
    callId: "provider-call-1",
    cancellationReason: null,
    createdAt: now,
    id: createId("request"),
    kind: "harness.approval",
    mode: "live",
    originatingOccurrenceId: null,
    originatingRunId: createId("run"),
    originatingThreadId: threadId,

    payload: { kind: "harness.approval" },
    presentation: {
      kind: "choice",
      options: [{ hint: "allow-once", id: "allow", label: "Allow once" }],
      title: "Allow operation?",
    },
    requestedBy: createId("user"),
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
  } as const;
}

describe("Request protocol", () => {
  it("uses Request naming in Deployment snapshots", () => {
    const request = pendingRequest();
    const thread = {
      lastVisitedAt: null,
      latestRunCompletedAt: null,
      accessMode: "full-access",

      continuationIdentity: null,
      createdAt: now,
      createdBy: request.requestedBy,
      doneAt: null,
      doneReason: null,
      environmentId: createId("environment"),
      harnessInstanceId: createId("harnessInstance"),
      icon: null,
      id: request.originatingThreadId,
      inputQueuePaused: false,
      lineageRootThreadId: request.originatingThreadId,
      modelSelection: { modelId: "gpt-5.6-sol", options: {}, providerId: "openai" },
      listed: true,
      parentThreadId: null,
      pendingRequests: 1,
      providerSessionId: null,
      purpose: "task",
      teamOrigin: null,
      status: "waiting",
      title: "Request test",
      updatedAt: now,
    } as const;
    const emptyWindow = {
      byteCount: 0,
      hasMore: false,
      itemCount: 0,
      nextBefore: null,
      totalItems: 0,
    } as const;
    const emptyPage = { asOfSequence: SequenceSchema.parse("0"), tasks: [], window: emptyWindow };
    const snapshot = {
      tasks: { recent: emptyPage, active: emptyPage, done: emptyPage },
      needsYou: { count: 1, entries: [], window: emptyWindow },
      resources: {
        appTabs: [],
        browser: {
          available: false,
          profiles: [],
          placements: [],
          groups: { rows: [], complete: true },
          tabs: [],
        },
      },
      messageWindows: [],
      messages: [],
      pendingRequests: [request],
      pendingRequestWindow: { ...emptyWindow, itemCount: 1, totalItems: 1 },
      runQueue: [],
      sequence: "0",
      serializedBytes: 1,
      threadWindow: { ...emptyWindow, itemCount: 1, totalItems: 1 },
      threads: [thread],
      deploymentId: createId("deployment"),
    } as const;
    expect(LegacyDeploymentSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(LegacyDeploymentSnapshotSchema.parse({ ...snapshot, messagesOmitted: true })).toEqual({
      ...snapshot,
      messagesOmitted: true,
    });
    expect(
      LegacyDeploymentSnapshotSchema.safeParse({ ...snapshot, messagesOmitted: false }).success,
    ).toBe(false);
    expect(
      LegacyDeploymentSnapshotSchema.safeParse({
        ...snapshot,
        messagesOmitted: true,
        messageWindows: [{ ...emptyWindow, threadId: thread.id }],
      }).success,
    ).toBe(false);
    const subscription = {
      type: "client.subscribe",
      cursor: { deploymentId: createId("deployment"), apiVersion: 52, afterSequence: "0" },
      threadId: null,
    } as const;
    expect(ClientToHostMessageSchema.parse(subscription)).toEqual(subscription);
    expect(ClientToHostMessageSchema.parse({ ...subscription, snapshotMessages: "omit" })).toEqual({
      ...subscription,
      snapshotMessages: "omit",
    });
    expect(
      ClientToHostMessageSchema.safeParse({ ...subscription, snapshotMessages: "unknown" }).success,
    ).toBe(false);
    expect(
      LegacyDeploymentSnapshotSchema.parse({
        ...snapshot,
        unexpectedWindow: snapshot.pendingRequestWindow,
        unexpectedRequests: snapshot.pendingRequests,
      }),
    ).toEqual(snapshot);
    expect(
      LegacyDeploymentSnapshotSchema.safeParse({ ...snapshot, pendingRequests: undefined }).success,
    ).toBe(false);

    expect(
      LegacyHostToClientMessageSchema.parse({
        futureFrameField: true,
        snapshot: { ...snapshot, futureSnapshotField: true },
        type: "host.snapshot",
      }),
    ).toEqual({ snapshot, type: "host.snapshot" });
  });

  it("strips additive fields from Host event frames without accepting new variants", () => {
    const threadId = createId("thread");
    const event = {
      createdAt: now,
      data: { futureDataField: true, status: "running" },
      environmentId: createId("environment"),
      eventId: createId("event"),
      futureEventField: true,
      runId: createId("run"),
      sequence: "1",
      threadId,
      type: "run.started",
    } as const;

    expect(
      LegacyHostToClientMessageSchema.parse({
        events: [event],
        futureFrameField: true,
        type: "host.events",
        throughSequence: "1",
      }),
    ).toEqual({
      events: [
        {
          createdAt: now,
          data: { status: "running" },
          environmentId: event.environmentId,
          eventId: event.eventId,
          runId: event.runId,
          sequence: "1",
          threadId,
          type: "run.started",
        },
      ],
      type: "host.events",
      throughSequence: "1",
    });
    expect(LegacyHostToClientMessageSchema.safeParse({ type: "host.future-frame" }).success).toBe(
      false,
    );
    expect(
      LegacyHostToClientMessageSchema.safeParse({
        reason: "future-reason",
        type: "host.resync-required",
      }).success,
    ).toBe(false);
  });
});
