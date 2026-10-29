import { describe, expect, it } from "vitest";
import {
  AgentEventSchema,
  PendingRequestSchema,
  RequestSchema,
  RequestViewSchema,
  readableRequestList,
  ResolvedRequestEventSchema,
  createId,
  requestReasonMaxLength,
} from "./index.js";

const createdAt = "2026-08-22T12:00:00.000Z";

function pendingApproval() {
  const workspaceId = createId("workspace");
  return {
    callId: "provider-call-1",
    cancellationReason: null,
    createdAt,
    id: createId("request"),
    kind: "harness.approval",
    mode: "live",
    originatingOccurrenceId: null,
    originatingRunId: createId("run"),
    originatingThreadId: createId("thread"),
    originatingWorkspaceId: workspaceId,
    payload: { kind: "harness.approval" },
    presentation: {
      kind: "choice",
      options: [
        { hint: "allow-once", id: "allow", label: "Allow once" },
        { hint: "reject-once", id: "reject", label: "Reject" },
      ],
      title: "Allow the provider operation?",
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

describe("Request contracts", () => {
  it("uses one Request identity and enforces the kind's lifecycle mode", () => {
    const request = pendingApproval();
    expect(PendingRequestSchema.parse(request)).toEqual(request);
    expect(request.id).toMatch(/^req_/);
    expect(PendingRequestSchema.safeParse({ ...request, mode: "durable" }).success).toBe(false);
    expect(
      PendingRequestSchema.safeParse({
        ...request,
        payload: { kind: "harness.input" },
      }).success,
    ).toBe(false);
  });

  it("admits exactly one origin, and only a Run may open a live Request", () => {
    const request = pendingApproval();
    const durableInstall = {
      ...request,
      kind: "integration.install",
      mode: "durable",
      payload: {
        kind: "integration.install",
        manifest: { kind: "catalog" },
        reason: "The schedule needs Linear",
      },
      presentation: {
        kind: "choice",
        options: [{ hint: "confirm", id: "installed", label: "Install" }],
        title: "Install Linear?",
      },
      requiredActor: "administrator",
    } as const;

    expect(
      PendingRequestSchema.parse({
        ...durableInstall,
        originatingOccurrenceId: createId("triggerOccurrence"),
        originatingRunId: null,
      }).originatingRunId,
    ).toBeNull();
    expect(PendingRequestSchema.parse(durableInstall).originatingOccurrenceId).toBeNull();
    expect(
      PendingRequestSchema.safeParse({ ...durableInstall, originatingRunId: null }).success,
    ).toBe(false);
    expect(
      PendingRequestSchema.safeParse({
        ...durableInstall,
        originatingOccurrenceId: createId("triggerOccurrence"),
      }).success,
    ).toBe(false);
    // A live Request is answered back into the process that opened it.
    expect(
      PendingRequestSchema.safeParse({
        ...request,
        originatingOccurrenceId: createId("triggerOccurrence"),
        originatingRunId: null,
      }).success,
    ).toBe(false);
  });

  it("keeps browser and integration payloads bounded and kind-specific", () => {
    const base = pendingApproval();
    const browserRequest = {
      ...base,
      kind: "browser.access",
      mode: "durable",
      payload: {
        kind: "browser.access",
        reason: "The Workspace needs the signed-in calendar",
        suggestion: { kind: "user_choice" },
      },
      presentation: {
        kind: "external",
        subject: { id: "calendar-access", kind: "browser-profile-grant" },
        title: "Grant browser access",
      },
    } as const;
    expect(RequestSchema.parse(browserRequest)).toEqual(browserRequest);
    expect(
      RequestSchema.safeParse({
        ...browserRequest,
        payload: { ...browserRequest.payload, reason: "x".repeat(requestReasonMaxLength + 1) },
      }).success,
    ).toBe(false);
  });

  it("allows redacted secret acknowledgements but rejects secret values in durable events", () => {
    const pending = {
      ...pendingApproval(),
      kind: "harness.input",
      payload: { kind: "harness.input" },
      presentation: {
        fields: [
          {
            id: "token",
            multiSelect: false,
            prompt: "Token",
            secret: true,
          },
        ],
        kind: "form",
        title: "Enter token",
      },
    } as const;
    const terminal = {
      ...pending,
      cancellationReason: null,
      resolvedAt: createdAt,
      resolvedBy: pending.requestedBy,
      response: { answers: { token: [] }, kind: "form" },
      status: "fulfilled",
    } as const;
    expect(ResolvedRequestEventSchema.parse(terminal)).toEqual(terminal);
    expect(
      ResolvedRequestEventSchema.safeParse({
        ...terminal,
        response: { answers: { token: ["do-not-persist"] }, kind: "form" },
      }).success,
    ).toBe(false);
    expect(
      AgentEventSchema.safeParse({
        createdAt,
        data: {
          request: {
            ...terminal,
            response: { answers: { token: ["do-not-persist"] }, kind: "form" },
          },
        },
        environmentId: createId("environment"),
        eventId: createId("event"),
        runId: pending.originatingRunId,
        sequence: "1",
        threadId: pending.originatingThreadId,
        type: "request.resolved",
        workspaceId: pending.originatingWorkspaceId,
      }).success,
    ).toBe(false);
  });

  it("keeps cancellation machine-readable and separate from withdrawal", () => {
    const pending = pendingApproval();
    const cancelled = RequestSchema.parse({
      ...pending,
      cancellationReason: "process-lost",
      resolvedAt: createdAt,
      status: "cancelled",
    });
    expect(cancelled).toMatchObject({ cancellationReason: "process-lost", status: "cancelled" });
    expect(ResolvedRequestEventSchema.safeParse(cancelled).success).toBe(false);
    expect(
      RequestSchema.safeParse({
        ...pending,
        cancellationReason: "process-lost",
        resolvedAt: createdAt,
        resolvedBy: pending.requestedBy,
        status: "withdrawn",
      }).success,
    ).toBe(false);
  });
});

describe("Workspace Passwords Requests", () => {
  const modern = () => ({
    ...pendingApproval(),
    mode: "durable",
    kind: "browser.password-sign-in",
    payload: {
      kind: "browser.password-sign-in",
      scope: "workspace",
      permissionVersion: 5,
      computerName: "Vault Mac",
      expiresAt: "2026-08-22T13:00:00.000Z",
      operationId: "00000000-0000-4000-8000-000000000001",
      reason: "Sign in",
      runnerId: createId("runner"),
      site: "https://example.com",
    },
    presentation: {
      kind: "external",
      subject: { kind: "browser-site", id: "https://example.com" },
      title: "Sign in to example.com?",
    },
  });
  it("reads sessionless consent and refuses incomplete scope", () => {
    const request = modern();
    expect(RequestSchema.parse(request).payload).toEqual(request.payload);
    expect(
      RequestSchema.safeParse({
        ...request,
        payload: { ...request.payload, permissionVersion: undefined },
      }).success,
    ).toBe(false);
    expect(
      RequestSchema.safeParse({ ...request, payload: { ...request.payload, scope: undefined } })
        .success,
    ).toBe(false);
  });
  it("skips unreadable Requests without losing valid neighbors", () => {
    const a = pendingApproval();
    const b = modern();
    expect(
      readableRequestList(RequestViewSchema, 100).parse([
        a,
        { ...a, kind: "future.kind" },
        b,
        null,
      ]),
    ).toEqual([a, b]);
  });
});
