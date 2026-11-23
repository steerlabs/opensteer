import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  iphoneNativeRequestSchema,
  iphoneNativeMessageSchema,
} from "../../../packages/protocol/src/iphone-bridge.js";

describe.each([
  "ipc-golden.json",
  "screen-ipc-golden.json",
  "display-ipc-golden.json",
  "ipc-wifi-golden.json",
  "ipc-setup-golden.json",
])("iPhone native IPC golden fixtures: %s", (filename) => {
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
});

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

it("uses identical init/refresh root bounds and strict reveal references", () => {
  for (const roots of [null, Array(9).fill("/Restore"), [""], ["x".repeat(4097)]]) {
    for (const method of ["init", "images.refresh"]) {
      const params =
        method === "init"
          ? { privateRoot: "/private/root", imageRoots: roots }
          : { imageRoots: roots };
      expect(
        iphoneNativeRequestSchema.safeParse({
          kind: "request",
          protocolVersion: 1,
          id: 1,
          timeoutMs: 1000,
          method,
          params,
        }).success,
      ).toBe(false);
    }
  }
  expect(
    iphoneNativeRequestSchema.safeParse({
      kind: "request",
      protocolVersion: 1,
      id: 1,
      timeoutMs: 1000,
      method: "setup.revealDeveloperMode",
      params: { localPhoneId: "phone", nativeEpoch: 0 },
    }).success,
  ).toBe(false);
});

it("accepts additive display methods, media states and action variants", () => {
  const streamId = "dsp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ref = { bindingToken: "binding", nativeEpoch: 1, streamId };
  const request = { kind: "request", protocolVersion: 1, id: 3, timeoutMs: 1000 };
  for (const [method, fields] of Object.entries({
    start: { maxLongSide: 1280, maxFps: 30 },
    demand: { maxFps: 20 },
    refresh: {},
    stop: {},
    input: { events: [{ kind: "pointer", phase: "down", x: 0.5, y: 0.2, t: 1 }] },
    inputReset: {},
    power: { action: "wake" },
  })) {
    expect(
      iphoneNativeRequestSchema.safeParse({
        ...request,
        method: `display.${method}`,
        params: { ...ref, ...fields },
      }).success,
    ).toBe(true);
  }
  expect(
    iphoneNativeRequestSchema.safeParse({
      ...request,
      method: "display.input",
      params: { ...ref, geometry: 1, events: [] },
    }).success,
  ).toBe(false);
  // A6: text paste, command, and copy require a UUID editing contextId on both TS and Go sides.
  const contextId = "00000000-0000-4000-8000-000000000001";
  for (const event of [
    { kind: "paste", text: "hi" },
    { kind: "command", command: "selectAll" },
    { kind: "copy" },
  ]) {
    expect(
      iphoneNativeRequestSchema.safeParse({
        ...request,
        method: "display.input",
        params: { ...ref, geometry: 1, events: [event] },
      }).success,
    ).toBe(false);
    expect(
      iphoneNativeRequestSchema.safeParse({
        ...request,
        method: "display.input",
        params: { ...ref, geometry: 1, events: [{ ...event, contextId }] },
      }).success,
    ).toBe(true);
  }
  const target = { nodeId: "test-node" };
  const actions = [
    { kind: "tap", target, count: 2 },
    { kind: "swipe", target, to: { x: 0, y: 10 }, edge: "top", durationMs: 150 },
    { kind: "navigate", button: "quickSettings" },
    { kind: "pinch", target, scale: 1.2, durationMs: 150 },
    { kind: "key", key: "a", modifiers: ["command"] },
    { kind: "terminate", appId: "example.app" },
  ];
  const perform = {
    ...request,
    method: "phone.perform",
    params: {
      bindingToken: "b",
      nativeEpoch: 1,
      sessionId: "s",
      observationToken: "o",
      geometryRevision: 1,
      actions,
    },
  };
  expect(iphoneNativeRequestSchema.safeParse(perform).success).toBe(true);
  expect(
    iphoneNativeRequestSchema.safeParse({
      ...perform,
      params: { ...perform.params, actions: [{ ...actions[0], count: 3 }] },
    }).success,
  ).toBe(false);
  expect(
    iphoneNativeMessageSchema.safeParse({
      kind: "event",
      bootId: "boot",
      sequence: 1,
      event: "display.state",
      displayState: {
        streamId,
        state: "protected",
        generation: 1,
        width: 0,
        height: 0,
        rotation: 90,
      },
    }).success,
  ).toBe(true);
  for (const result of [
    { socketPath: "/private/native.sock" },
    { outcome: "stale", reason: "stale" },
    { outcome: "dispatched" },
  ]) {
    expect(iphoneNativeMessageSchema.safeParse({ kind: "response", id: 3, result }).success).toBe(
      true,
    );
  }
});
