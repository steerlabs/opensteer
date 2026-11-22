import { describe, expect, it } from "vitest";
import { HostClientRequestError } from "./client.js";
import { homeFailureText } from "./failure-text.js";

const refusal = (code: string, message: string, extra: { reason?: string; status?: number } = {}) =>
  new HostClientRequestError({
    code,
    message,
    status: extra.status ?? 409,
    provenance: "host",
    ...(extra.reason ? { reason: extra.reason } : {}),
  });

describe("the words a person reads for a failed call to a Home", () => {
  it("passes the Home's own refusal sentence through as it is", () => {
    expect(
      homeFailureText(
        refusal("conflict", "Another chat already answers in this conversation."),
        "x",
      ),
    ).toBe("Another chat already answers in this conversation.");
    expect(homeFailureText(refusal("not_found", "Thread not found", { status: 404 }), "x")).toBe(
      "Thread not found",
    );
  });

  it("never passes a validator's report, an internal error, or a failure that is not the Home's", () => {
    const fallback = "Something went wrong.";
    expect(
      homeFailureText(
        refusal("bad_request", "Request is invalid: access.route: Active mode needs a route", {
          reason: "invalid-request",
          status: 400,
        }),
        fallback,
      ),
    ).toBe(fallback);
    expect(
      homeFailureText(
        refusal("internal", "TypeError: x is not a function", { status: 500 }),
        fallback,
      ),
    ).toBe(fallback);
    expect(homeFailureText(new Error("ECONNRESET /Users/tim/secret"), fallback)).toBe(fallback);
    expect(
      homeFailureText(
        new HostClientRequestError({
          code: "conflict",
          message: "proxy said no",
          status: 409,
          provenance: "proxy",
        }),
        fallback,
      ),
    ).toBe(fallback);
  });
});
