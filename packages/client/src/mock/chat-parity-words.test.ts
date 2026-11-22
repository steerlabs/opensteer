import { describe, expect, it } from "vitest";
import { HostClientRequestError } from "../host/client.js";
import { homeFailureText } from "../host/failure-text.js";
import { rpcErrorStatus } from "../host/host-session-client.js";
import recorded from "./chat-parity.fixture.json" with { type: "json" };
import type { ChatParityRecord } from "./chat-parity.js";

/**
 * Every refusal the Home gave in the parity script is drawn as the Home's own sentence: a screen
 * words a failed call through `homeFailureText`, which keeps a refusal's sentence for the person.
 */
const record = recorded as unknown as ChatParityRecord;
const refusals = record.steps.flatMap((step) =>
  step.answer.ok || step.answer.code === null ? [] : [{ step: step.name, ...step.answer }],
);

describe("the Home's refusals in the parity script", () => {
  it("has refusals to check", () => {
    expect(refusals.length).toBeGreaterThan(3);
  });
  it.each(refusals)("draws $step as the Home's sentence", ({ code, message }) => {
    const refusal = new HostClientRequestError({
      code: code!,
      message,
      provenance: "host",
      status: rpcErrorStatus(code!),
    });
    expect(homeFailureText(refusal, "the app's own words")).toBe(message);
  });
});
