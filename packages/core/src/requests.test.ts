import { describe, expect, it } from "vitest";
import {
  AgentEventSchema,
  PendingRequestSchema,
  RequestSchema,
  RequestViewSchema,
  readableRequestList,
  ResolvedRequestEventSchema,
  createId,
  formatRequestOperationDetail,
  requestOperationCallsHeading,
  requestOperationCallsMaxLength,
  requestOperationContextMaxLength,
  requestTextMaxLength,
  requestReasonMaxLength,
  requestIsAgentAnswerable,
  RequestKindSchema,
  requestFormAnswersProblem,
  type RequestFormField,
} from "./index.js";

const createdAt = "2026-08-22T12:00:00.000Z";

it("keeps every character of a maximum-length script in Request plain detail", () => {
  const calls = "x".repeat(requestOperationCallsMaxLength - 1) + "!";
  const titleLine = `\n\nThe page's title: "🔎"`;
  const detail = formatRequestOperationDetail({
    summary: "s".repeat(requestOperationContextMaxLength + 100),
    titleLine,
    calls,
    reason: "Optional reason",
  });
  expect(detail).toHaveLength(requestTextMaxLength);
  expect(detail).toBe(
    "s".repeat(requestOperationContextMaxLength - titleLine.length) +
      titleLine +
      requestOperationCallsHeading +
      calls,
  );
});

describe("agent answer classification", () => {
  const decisions = {
    "harness.approval": false,
    "harness.input": true,
    "browser.access": false,
    "browser.sign-in": false,
    "browser.password-sign-in": false,
    "integration.access": false,
    "machine.full-disk-access": false,
    "device.access": false,
    "computer.app.access": false,
    "plugin.account": false,
    "plugin.approval": false,
    "plugin.input": false,
    "person.question": false,
  };
  it("deliberately classifies every Request kind", () => {
    expect(Object.keys(decisions).sort()).toEqual([...RequestKindSchema.options].sort());
    for (const kind of RequestKindSchema.options) {
      expect(
        requestIsAgentAnswerable({
          kind,
          presentation: {
            kind: "form",
            title: "Question",
            fields: [
              { id: "answer", prompt: "Which?", custom: false, multiSelect: false, secret: false },
            ],
          },
        }),
      ).toBe(decisions[kind]);
    }
  });
  it("keeps secret fields and native subagent questions human-only", () => {
    const question = {
      kind: "harness.input" as const,
      presentation: {
        kind: "form" as const,
        title: "Question",
        fields: [
          { id: "answer", prompt: "Which?", custom: false, multiSelect: false, secret: true },
        ],
      },
    };
    expect(requestIsAgentAnswerable(question)).toBe(false);
    expect(
      requestIsAgentAnswerable({
        ...question,
        presentation: {
          ...question.presentation,
          fields: [{ ...question.presentation.fields[0]!, secret: false }],
        },
        originatingNodeId: createId("executionNode"),
      }),
    ).toBe(false);
  });
});

describe("question answers", () => {
  const choice = (overrides: Partial<RequestFormField> = {}): RequestFormField => ({
    choices: [
      { label: "Batches", value: "Batches" },
      { label: "All at once", value: "All at once" },
    ],
    custom: false,
    id: "q",
    multiSelect: false,
    prompt: "How?",
    secret: false,
    ...overrides,
  });

  it("takes an offered choice, and a typed answer only where the person may type", () => {
    expect(requestFormAnswersProblem([choice()], { q: ["Batches"] })).toBeNull();
    expect(requestFormAnswersProblem([choice()], { q: ["Tonight"] })).toBe(
      "How? is not one of the offered choices",
    );
    expect(requestFormAnswersProblem([choice({ custom: true })], { q: ["Tonight"] })).toBeNull();
  });

  it("lets a typed answer stand alone, never beside choices or blank", () => {
    const field = choice({ custom: true, multiSelect: true });
    expect(requestFormAnswersProblem([field], { q: ["Batches", "Tonight"] })).toBe(
      "How? needs one typed answer",
    );
    expect(requestFormAnswersProblem([field], { q: ["  "] })).toBe("How? needs one typed answer");
    expect(requestFormAnswersProblem([field], { q: ["Batches", "All at once"] })).toBeNull();
  });

  it("holds single choice to one, refuses repeats, gaps and questions it never asked", () => {
    expect(requestFormAnswersProblem([choice()], { q: ["Batches", "All at once"] })).toBe(
      "How? takes exactly one choice",
    );
    expect(
      requestFormAnswersProblem([choice({ multiSelect: true })], { q: ["Batches", "Batches"] }),
    ).toBe("How? repeats a choice");
    expect(requestFormAnswersProblem([choice()], {})).toBe("How? is not answered");
    expect(requestFormAnswersProblem([choice()], { q: ["Batches"], other: ["x"] })).toBe(
      "other is not one of its questions",
    );
  });

  it("types an open question's answer", () => {
    const open = choice({ choices: undefined });
    expect(requestFormAnswersProblem([open], { q: ["Tuesday"] })).toBeNull();
    expect(requestFormAnswersProblem([open], { q: [""] })).toBe("How? needs one typed answer");
  });
});

function pendingApproval() {
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
  } as const;
}

describe("Request contracts", () => {
  it("keeps the settlement session server-side while projecting its device label", () => {
    const request = {
      ...pendingApproval(),
      settlementProvenance: { sessionId: "session", deviceLabel: "iPhone" },
    };
    expect(RequestSchema.parse(request).settlementProvenance).toEqual(request.settlementProvenance);
    expect(RequestViewSchema.parse(request).settlementProvenance).toEqual({
      deviceLabel: "iPhone",
    });
  });
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
      kind: "integration.access",
      mode: "durable",
      payload: {
        kind: "integration.access",
        installationId: null,
        manifest: { kind: "catalog" },
        reason: "The schedule needs Calendar",
        access: "read",
        requestedConnectionId: null,
        requestedServerId: null,
      },
      presentation: {
        kind: "external",
        subject: { id: "calendar", kind: "integration.access" },
        title: "Calendar access",
      },
      requiredActor: "owner",
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
        reason: "The task needs the signed-in calendar",
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
            custom: false,
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

describe("Personal Passwords Requests", () => {
  const modern = () => ({
    ...pendingApproval(),
    mode: "durable",
    kind: "browser.password-sign-in",
    payload: {
      kind: "browser.password-sign-in",
      scope: "personal",
      permissionVersion: 6,
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
