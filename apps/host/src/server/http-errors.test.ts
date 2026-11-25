import { hostApi } from "@opensteer/protocol";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { normalizeHostError } from "./http-errors.js";

describe("normalizeHostError", () => {
  it("identifies the field that failed request validation", () => {
    const schema = z.strictObject({
      input: z.strictObject({
        source: z.strictObject({
          schedule: z.strictObject({ at: z.iso.datetime({ offset: true }) }),
        }),
      }),
    });

    const result = schema.safeParse({ input: { source: { schedule: { at: "not-a-date" } } } });
    if (result.success) throw new Error("Expected request validation to fail");

    expect(normalizeHostError(result.error)).toEqual({
      error: {
        code: "bad_request",
        message: "Request is invalid: input.source.schedule.at: Invalid ISO datetime",
        // Marked, so an app never puts the validator's report in front of a person.
        reason: "invalid-request",
        retryable: false,
      },
      status: 400,
    });
  });

  it("does not describe invalid JSON as a validation failure", () => {
    expect(normalizeHostError(new SyntaxError("Unexpected token secret"))).toEqual({
      error: {
        code: "bad_request",
        message: "Request contains invalid JSON",
        reason: "invalid-request",
        retryable: false,
      },
      status: 400,
    });
  });

  it("preserves stable automation-secret validation reasons on ZodError refusals", () => {
    const oversized = hostApi["commands.dispatch"].payload.safeParse({
      type: "trigger.secrets.set",
      idempotencyKey: "k",
      triggerId: "trg_00000000-0000-4000-8000-000000000001",
      set: { BIG: "x".repeat(65_537) },
    });
    if (oversized.success) throw new Error("Expected oversized secret to fail");
    expect(normalizeHostError(oversized.error)).toMatchObject({
      status: 400,
      error: { code: "bad_request", reason: "automation-secret-invalid-value" },
    });

    const nul = hostApi["commands.dispatch"].payload.safeParse({
      type: "trigger.secrets.set",
      idempotencyKey: "k",
      triggerId: "trg_00000000-0000-4000-8000-000000000001",
      set: { BAD: "has\0nul" },
    });
    if (nul.success) throw new Error("Expected NUL secret to fail");
    expect(normalizeHostError(nul.error)).toMatchObject({
      status: 400,
      error: { code: "bad_request", reason: "automation-secret-invalid-value" },
    });
  });
});
