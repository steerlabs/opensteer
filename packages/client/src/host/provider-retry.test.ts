import { describe, expect, it } from "vitest";
import { providerRetryDetail, providerRetryLabel } from "./provider-retry.js";

describe("provider retry formatting", () => {
  it("formats attempt/maxAttempts labels and open-ended attempt labels", () => {
    expect(
      providerRetryLabel({
        status: "retrying",
        attempt: 2,
        maxAttempts: 5,
        message: "At capacity",
      }),
    ).toBe("Retrying (2/5)");
    expect(
      providerRetryLabel({
        status: "retrying",
        attempt: 3,
        maxAttempts: null,
        message: "Overloaded",
      }),
    ).toBe("Retrying (attempt 3)");
  });

  it("formats retry detail with optional delay in seconds or minutes", () => {
    expect(
      providerRetryDetail({
        status: "retrying",
        attempt: 1,
        maxAttempts: 5,
        retryDelayMs: 7_000,
        message: "Selected model is at capacity.",
      }),
    ).toBe("Selected model is at capacity. · 7s retry delay");
    expect(
      providerRetryDetail({
        status: "retrying",
        attempt: 2,
        maxAttempts: 5,
        retryDelayMs: 308_000,
        message: "Selected model is at capacity.",
      }),
    ).toBe("Selected model is at capacity. · 5m 8s retry delay");
    expect(
      providerRetryDetail({
        status: "retrying",
        attempt: 1,
        maxAttempts: null,
        retryDelayMs: 120_000,
        message: "Rate limited",
      }),
    ).toBe("Rate limited · 2m retry delay");
    expect(
      providerRetryDetail({
        status: "retrying",
        attempt: 1,
        maxAttempts: null,
        message: "   ",
      }),
    ).toBe("Provider is retrying");
  });
});
