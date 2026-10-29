import { describe, expect, it } from "vitest";
import { integrationAuthorizationError } from "./authorization-outcome.js";

describe("integrationAuthorizationError", () => {
  it("does not expose an unknown diagnostic", () => {
    expect(integrationAuthorizationError("failed", "provider-secret-body")).toBe(
      "The provider could not complete authorization. Try again.",
    );
  });
});
