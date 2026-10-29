import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { HostToClientMessageSchema, WorkspaceSnapshotSchema } from "./index.js";

const now = "2026-08-22T12:00:00.000Z";

function pendingRequest() {
  const workspaceId = createId("workspace");
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
    originatingWorkspaceId: workspaceId,
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
    targetWorkspaceId: workspaceId,
  } as const;
}

describe("Request protocol", () => {
  it("uses Request naming in Workspace snapshots", () => {
    const request = pendingRequest();
    const thread = {
      accessMode: "full-access",
      capabilityProfileId: "main",
      continuationIdentity: null,
      createdAt: now,
      createdBy: request.requestedBy,
      doneAt: null,
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
      role: "work",
      status: "waiting",
      title: "Request test",
      updatedAt: now,
      workspaceId: request.originatingWorkspaceId,
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
      notificationPreferences: [],
      messageWindows: [],
      messages: [],
      pendingRequests: [request],
      pendingRequestWindow: { ...emptyWindow, itemCount: 1, totalItems: 1 },
      runQueue: [],
      sequence: "0",
      serializedBytes: 1,
      threadWindow: { ...emptyWindow, itemCount: 1, totalItems: 1 },
      threads: [thread],
      workspace: {
        capacity: { kind: "host-filesystem" },
        createdAt: now,
        id: request.originatingWorkspaceId,
        homeThreadId: request.originatingThreadId,
        icon: null,
        kind: "main",
        location: { environmentId: createId("environment"), kind: "machine", name: null },
        name: "Main",
        status: "ready",
        storageIssue: null,
        updatedAt: now,
      },
    } as const;
    expect(WorkspaceSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      WorkspaceSnapshotSchema.parse({
        ...snapshot,
        unexpectedWindow: snapshot.pendingRequestWindow,
        unexpectedRequests: snapshot.pendingRequests,
      }),
    ).toEqual(snapshot);
    expect(
      WorkspaceSnapshotSchema.safeParse({ ...snapshot, pendingRequests: undefined }).success,
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
    const workspaceId = createId("workspace");
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
      workspaceId,
    } as const;

    expect(
      HostToClientMessageSchema.parse({
        events: [event],
        futureFrameField: true,
        type: "host.events",
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
          workspaceId,
        },
      ],
      type: "host.events",
    });
    expect(HostToClientMessageSchema.safeParse({ type: "host.future-frame" }).success).toBe(false);
    expect(
      HostToClientMessageSchema.safeParse({
        reason: "future-reason",
        type: "host.resync-required",
        workspaceId,
      }).success,
    ).toBe(false);
  });
});
