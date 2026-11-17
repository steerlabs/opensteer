import { createId, type Request, type RequestFormField } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { assertRequestResponse } from "./command-store.js";

function question(field: Partial<RequestFormField>): Request {
  return {
    callId: "call",
    cancellationReason: null,
    createdAt: "2026-11-15T12:00:00.000Z",
    id: createId("request"),
    kind: "harness.input",
    mode: "live",
    originatingOccurrenceId: null,
    originatingRunId: createId("run"),
    originatingThreadId: createId("thread"),
    payload: { kind: "harness.input" },
    presentation: {
      kind: "form",
      title: "More information needed",
      fields: [
        {
          choices: [{ label: "Staging", value: "Staging" }],
          custom: false,
          id: "q",
          multiSelect: false,
          prompt: "Where?",
          secret: false,
          ...field,
        },
      ],
    },
    requestedBy: createId("user"),
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
  };
}
const answer = (value: string) => ({ kind: "form" as const, answers: { q: [value] } });

describe("an engine question's answer", () => {
  it("takes the person's own words where the engine offers them, and only there", () => {
    expect(() =>
      assertRequestResponse(question({ custom: true }), answer("Preview"), false),
    ).not.toThrow();
    expect(() => assertRequestResponse(question({}), answer("Preview"), false)).toThrow(
      "Where? is not one of the offered choices",
    );
  });

  it("keeps a secret answer off every channel but the live one", () => {
    const secret = question({ choices: undefined, secret: true });
    expect(() => assertRequestResponse(secret, answer("hunter2"), false)).toThrow(
      "Secret answers require the live response channel",
    );
    expect(() => assertRequestResponse(secret, answer("hunter2"), true)).not.toThrow();
  });
});
