import { describe, expect, it } from "vitest";
import { PortableFsRenewalFencesSchema, PortableFsRenewalScopeSchema } from "./schemas.js";

describe("PortableFsRenewalScopeSchema", () => {
  it("matches the Manager's 200-byte ASCII renewal-scope contract", () => {
    expect(PortableFsRenewalScopeSchema.safeParse("a".repeat(200)).success).toBe(true);
    expect(
      PortableFsRenewalScopeSchema.safeParse("machine-private-state:runner_123/example.test")
        .success,
    ).toBe(true);
    expect(PortableFsRenewalScopeSchema.safeParse("a".repeat(201)).success).toBe(false);
    expect(PortableFsRenewalScopeSchema.safeParse("machine-private-state:runner_é").success).toBe(
      false,
    );
    expect(PortableFsRenewalScopeSchema.safeParse("cloud private state").success).toBe(false);
  });
});

describe("PortableFsRenewalFencesSchema", () => {
  it("accepts exactly 1..4096 positive safe-integer entries", () => {
    const fence = { epoch: 1, scope: "machine-private-state:runner" };
    expect(PortableFsRenewalFencesSchema.safeParse({ fences: [] }).success).toBe(false);
    expect(PortableFsRenewalFencesSchema.safeParse({ fences: [fence] }).success).toBe(true);
    expect(
      PortableFsRenewalFencesSchema.safeParse({ fences: Array(4_096).fill(fence) }).success,
    ).toBe(true);
    expect(
      PortableFsRenewalFencesSchema.safeParse({ fences: Array(4_097).fill(fence) }).success,
    ).toBe(false);
    expect(
      PortableFsRenewalFencesSchema.safeParse({ fences: [{ ...fence, epoch: 0 }] }).success,
    ).toBe(false);
    expect(
      PortableFsRenewalFencesSchema.safeParse({
        fences: [{ ...fence, epoch: Number.MAX_SAFE_INTEGER }],
      }).success,
    ).toBe(true);
    expect(
      PortableFsRenewalFencesSchema.safeParse({
        fences: [{ ...fence, epoch: Number.MAX_SAFE_INTEGER + 1 }],
      }).success,
    ).toBe(false);
  });
});
