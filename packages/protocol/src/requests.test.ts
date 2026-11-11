import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  ClientToHostMessageSchema,
  HostToClientMessageSchema,
  DeploymentSnapshotSchema,
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
      folder: { computerId: createId("runner"), path: "/tmp/task" },
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
    const snapshot = {
      readStates: [],
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
    expect(DeploymentSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(DeploymentSnapshotSchema.parse({ ...snapshot, messagesOmitted: true })).toEqual({
      ...snapshot,
      messagesOmitted: true,
    });
    expect(
      DeploymentSnapshotSchema.safeParse({ ...snapshot, messagesOmitted: false }).success,
    ).toBe(false);
    expect(
      DeploymentSnapshotSchema.safeParse({
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
      DeploymentSnapshotSchema.parse({
        ...snapshot,
        unexpectedWindow: snapshot.pendingRequestWindow,
        unexpectedRequests: snapshot.pendingRequests,
      }),
    ).toEqual(snapshot);
    expect(
      DeploymentSnapshotSchema.safeParse({ ...snapshot, pendingRequests: undefined }).success,
    ).toBe(false);

    expect(
      HostToClientMessageSchema.parse({
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
      HostToClientMessageSchema.parse({
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
    expect(HostToClientMessageSchema.safeParse({ type: "host.future-frame" }).success).toBe(false);
    expect(
      HostToClientMessageSchema.safeParse({
        reason: "future-reason",
        type: "host.resync-required",
      }).success,
    ).toBe(false);
  });
});
