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
        retryable: false,
      },
      status: 400,
    });
  });
});
