import { describe, expect, it } from "vitest";
import { AuthMethodSchema, AuthMethodViewSchema, renderAuthPlacements } from "./auth-method.js";

describe("AuthMethodSchema", () => {
  it("accepts strict computer authority and exposes a tolerant response view", () => {
    const method = { id: "computer", kind: "computer", label: "This computer" } as const;
    expect(AuthMethodSchema.parse(method)).toEqual(method);
    expect(AuthMethodSchema.safeParse({ ...method, future: true }).success).toBe(false);
    expect(AuthMethodViewSchema.parse({ ...method, future: true })).toEqual(method);
  });
});

describe("renderAuthPlacements", () => {
  it("renders multi-value HTTP Basic credentials without storing a composite secret", () => {
    expect(
      renderAuthPlacements(
        [
          {
            carrier: "header",
            encoding: "base64",
            name: "Authorization",
            prefix: "Basic ",
            separator: ":",
            variables: ["accountSid", "authToken"],
          },
        ],
        { accountSid: "AC123", authToken: "secret" },
      ).headers,
    ).toEqual({ Authorization: "Basic QUMxMjM6c2VjcmV0" });
  });

  it("fails closed when one component is absent", () => {
    expect(() =>
      renderAuthPlacements(
        [
          {
            carrier: "header",
            encoding: "base64",
            name: "Authorization",
            separator: ":",
            variables: ["accountSid", "authToken"],
          },
        ],
        { accountSid: "AC123" },
      ),
    ).toThrow('missing credential value "authToken"');
  });
});
