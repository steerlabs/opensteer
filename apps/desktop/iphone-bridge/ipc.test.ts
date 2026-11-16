import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  iphoneNativeRequestSchema,
  iphoneNativeMessageSchema,
} from "../../../packages/protocol/src/iphone-bridge.js";

describe("iPhone native IPC golden fixtures", () => {
  const fixtures: unknown = JSON.parse(
    readFileSync(new URL("./testdata/ipc-golden.json", import.meta.url), "utf8"),
  );
  it("accepts the locally authored Go/TS messages", () => {
    expect(Array.isArray(fixtures)).toBe(true);
    if (!Array.isArray(fixtures)) throw new Error("Expected fixture array");
    for (const fixture of fixtures) {
      expect(
        iphoneNativeRequestSchema.safeParse(fixture).success ||
          iphoneNativeMessageSchema.safeParse(fixture).success,
      ).toBe(true);
    }
  });
  it("rejects extra fields and stale cancellation targets", () => {
    const request = {
      kind: "request",
      protocolVersion: 1,
      id: 2,
      timeoutMs: 1000,
      method: "request.cancel",
      params: { requestId: 2 },
    };
    expect(iphoneNativeRequestSchema.safeParse(request).success).toBe(false);
    expect(
      iphoneNativeRequestSchema.safeParse({
        ...request,
        params: { requestId: 1, secret: "sentinel" },
      }).success,
    ).toBe(false);
  });
});
