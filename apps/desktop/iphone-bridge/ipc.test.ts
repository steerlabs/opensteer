import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  iphoneNativeRequestSchema,
  iphoneNativeMessageSchema,
} from "../../../packages/protocol/src/iphone-bridge.js";

describe.each(["ipc-golden.json", "screen-ipc-golden.json"])(
  "iPhone native IPC golden fixtures: %s",
  (filename) => {
    const fixtures: unknown = JSON.parse(
      readFileSync(new URL(`./testdata/${filename}`, import.meta.url), "utf8"),
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
  },
);

it("rejects unsupported native input and mismatched image geometry", () => {
  const request = {
    kind: "request",
    protocolVersion: 1,
    id: 20,
    timeoutMs: 1000,
    method: "phone.perform",
    params: {
      bindingToken: "b",
      sessionId: "s",
      nativeEpoch: 1,
      observationToken: "o",
      geometryRevision: 1,
      actions: [],
    },
  };
  for (const actions of [
    [],
    [{ kind: "navigate", button: "back" }],
    [{ kind: "tap", target: { point: { x: -1, y: 0 } } }],
    [{ kind: "tap", target: { point: { x: 0, y: 0 }, nodeId: "n1" } }],
    [{ kind: "type", text: "x", target: null }],
  ]) {
    expect(
      iphoneNativeRequestSchema.safeParse({ ...request, params: { ...request.params, actions } })
        .success,
    ).toBe(false);
  }
  const fixtures: unknown = JSON.parse(
    readFileSync(new URL("./testdata/screen-ipc-golden.json", import.meta.url), "utf8"),
  );
  if (!Array.isArray(fixtures)) throw new Error("Expected fixture array");
  const response = iphoneNativeMessageSchema.parse(fixtures[1]);
  if (response.kind !== "response" || !("observationToken" in response.result))
    throw new Error("Expected observation");
  expect(
    iphoneNativeMessageSchema.safeParse({
      ...response,
      result: {
        ...response.result,
        screenshot: { mimeType: "image/jpeg", base64: "", width: 99, height: 200 },
      },
    }).success,
  ).toBe(false);
});
