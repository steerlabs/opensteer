import { describe, expect, it } from "vitest";
import { AuthMethodSchema, AuthMethodViewSchema } from "./auth-method.js";

describe("AuthMethodSchema", () => {
  it("accepts strict computer authority and exposes a tolerant response view", () => {
    const method = { id: "computer", kind: "computer", label: "This computer" } as const;
    expect(AuthMethodSchema.parse(method)).toEqual(method);
    expect(AuthMethodSchema.safeParse({ ...method, future: true }).success).toBe(false);
    expect(AuthMethodViewSchema.parse({ ...method, future: true })).toEqual(method);
  });
});
