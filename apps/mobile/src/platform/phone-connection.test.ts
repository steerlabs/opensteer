import { expect, test, vi } from "vitest";
import { BrowserRelayToHostMessageSchema } from "@opensteer/protocol/browser-relay";

const native = vi.hoisted(() => ({
  sendRelay: vi.fn(async (input: { epoch: number; message: unknown }) => {
    if (typeof input.message !== "string") throw new TypeError("Native relay requires JSON text.");
    return JSON.parse(input.message) as unknown;
  }),
  addListener: () => ({ remove() {} }),
}));
vi.mock("expo", () => ({ requireOptionalNativeModule: () => native }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
import { phoneConnection } from "./phone-connection.js";

test("every phone relay variant crosses the native boundary without converting nested JSON through Any", async () => {
  const uuid = "11111111-1111-4111-8111-111111111111";
  const fence = {
    runnerId: `rnr_${uuid}`,
    bootId: `rbt_${uuid}`,
    connectionId: `rcn_${uuid}`,
    connectionLeaseId: `rls_${uuid}`,
    connectionGeneration: 1,
    auxiliaryStreamId: `rax_${uuid}`,
    module: "browser",
  };
  const capability = {
    runtimeId: "phone",
    capabilityGeneration: 1,
    capabilityLeaseId: `bcl_${uuid}`,
  };
  const channelId = `bch_${uuid}`;
  const binding = {
    version: 1,
    deploymentId: `dep_${uuid}`,
    profileId: `bpr_${uuid}`,
    runnerId: fence.runnerId,
    storageInstanceId: uuid,
    bindingId: uuid,
    engine: "android-webview",
  };
  const error = { code: "conflict", message: "Fixture refusal.", retryable: false };
  const snapshot = {
    type: "browser.snapshot",
    access: "read-write",
    dialog: null,
    sessionId: `bsn_${uuid}`,
    state: "ready",
  };
  const request = { ...fence, requestId: "request" };
  const channel = { ...fence, capability, channelId };
  const fixtures = [
    { ...fence, type: "runner.auxiliary.heartbeat", sentAt: "2026-11-10T12:00:00.000Z" },
    {
      ...fence,
      type: "browser.profile.inventory",
      storageInstanceId: uuid,
      engine: "android-webview",
      profiles: [],
      complete: true,
    },
    ...["pending-restart", "deleted"].map((erasure) => ({
      ...fence,
      type: "browser.profile.inventory",
      storageInstanceId: uuid,
      engine: "android-webview",
      profiles: [
        { phase: "ready", binding },
        { phase: "deleted", binding, deletionId: uuid, erasure },
      ],
      complete: true,
    })),
    ...["pending-restart", "deleted"].map((state) => ({
      ...request,
      type: "browser.profile.delete.result",
      capability,
      binding,
      deletionId: uuid,
      state,
    })),
    { ...request, type: "browser.health", browserRuntime: null },
    {
      ...request,
      type: "browser.health",
      browserRuntime: {
        checkedAt: "2026-11-10T12:00:00.000Z",
        detail: null,
        runtimeId: "phone",
        sessionId: null,
        state: "ready",
      },
    },
    ...["capability.accepted", "capability.revoked"].map((type) => ({
      ...request,
      type,
      capability,
    })),
    { ...request, ...channel, type: "browser.attached" },
    {
      ...request,
      ...channel,
      type: "browser.attached",
      initialPage: { operationKey: "start", surfaceId: "tab", navigation: "submitted" },
    },
    { ...channel, type: "browser.server-message", message: snapshot },
    {
      ...channel,
      type: "browser.server-message",
      message: {
        ...snapshot,
        dialog: { id: uuid, message: "Fixture", surfaceId: "tab", type: "confirm" },
        targetedStreamingVersion: 1,
        inputLanesVersion: 1,
        navigationAttributionVersion: 1,
        basicInput: 1,
        surfaceState: 1,
      },
    },
    {
      ...channel,
      type: "browser.server-message",
      message: {
        type: "cdp.result",
        requestId: uuid,
        result: {
          result: { type: "object", value: null, description: undefined },
          nested: [null, { x: 1.25, y: -0.5 }, [true, false]],
          maximum: Number.MAX_SAFE_INTEGER,
        },
      },
    },
    { ...channel, type: "browser.closed", code: 1000, reason: "Closed." },
    { ...channel, type: "browser.closed", code: 1000, reason: "Closed.", requestId: "close" },
    { ...channel, type: "browser.channel-error", error },
    { ...request, type: "browser.command-error", channelId: null, error },
    { ...request, type: "browser.command-error", channelId, error },
  ];
  const covered = new Set<string>();
  for (const fixture of fixtures) {
    const message = BrowserRelayToHostMessageSchema.parse(fixture);
    covered.add(message.type);
    await phoneConnection.sendRelay({ epoch: 7, message });
    const sent = native.sendRelay.mock.calls.at(-1)![0];
    expect(sent.epoch).toBe(7);
    expect(JSON.parse(sent.message as string)).toStrictEqual(JSON.parse(JSON.stringify(message)));
  }
  expect(covered).toEqual(
    new Set(BrowserRelayToHostMessageSchema.options.map((option) => option.shape.type.value)),
  );
});
