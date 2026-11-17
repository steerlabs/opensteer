import { readFileSync } from "node:fs";
import { createId, DeviceIdSchema, PhoneDisplayDefinitionIdSchema } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  PhoneDisplayActionsSchema,
  PhoneDisplayObservationSchema,
  IphoneScreenObservationSchema,
  PhoneDisplayActResultSchema,
  getPhoneDisplayCodec,
  validatePhoneDisplayActions,
} from "./phone-display.js";
import { AndroidPhoneDispatchActParamsSchema } from "./android-phone.js";
import {
  HostToIntegrationsModuleMessageSchema,
  IntegrationsModuleEventSchema,
} from "./computer-apps.js";

const observation = {
  capturedAt: "2026-10-01T00:00:00Z",
  elementCount: 0,
  foreground: { label: "Notes", appId: "com.example.notes" },
  geometry: { width: 390, height: 844 },
  locked: null,
  secureLock: null,
  observationId: "observation-1",
  rotation: 0,
  screen: "on",
  screenshot: null,
  screenshotUnavailable: "not-requested",
  tree: "",
  truncated: false,
};
const fence = {
  auxiliaryStreamId: "rax_00000000-0000-4000-8000-000000000001",
  bootId: "rbt_00000000-0000-4000-8000-000000000002",
  connectionGeneration: 1,
  connectionId: "rcn_00000000-0000-4000-8000-000000000003",
  connectionLeaseId: "rls_00000000-0000-4000-8000-000000000004",
  module: "integrations",
  runnerId: createId("runner"),
};
const target = { deviceId: "dev_00000000-0000-4000-8000-000000000005", driverGeneration: 2 };

describe("phone display contracts", () => {
  it("keeps Device IDs distinct while accepting migrated Runner spellings", () => {
    expect(DeviceIdSchema.parse(createId("runner"))).toMatch(/^rnr_/);
    expect(DeviceIdSchema.parse(createId("device"))).toMatch(/^dev_/);
    for (const id of [createId("user"), "dev_bad", "rnr_bad"])
      expect(DeviceIdSchema.safeParse(id).success).toBe(false);
  });

  it("has exactly two strict codecs and rejects unknown identities and Android aliases on iPhone", () => {
    for (const definitionId of ["android-phone", "iphone-screen"])
      expect(
        getPhoneDisplayCodec(PhoneDisplayDefinitionIdSchema.parse(definitionId)).definitionId,
      ).toBe(definitionId);
    expect(PhoneDisplayDefinitionIdSchema.safeParse("future-phone").success).toBe(false);
    expect(() => getPhoneDisplayCodec("future-phone")).toThrow();
    expect(() =>
      getPhoneDisplayCodec("iphone-screen").parseActions([
        { type: "launch", packageName: "com.example.notes" },
      ]),
    ).toThrow();
    expect(() =>
      getPhoneDisplayCodec("iphone-screen").parseActions([{ type: "wake", extra: true }]),
    ).toThrow();
  });

  it("validates advertised navigation, actions and login text before dispatch", () => {
    const capabilities = {
      actions: ["navigate", "type", "launch"],
      navigationButtons: [{ id: "home", label: "Home" }],
      wake: false,
      input: true,
      loginText: false,
    } as const;
    expect(() =>
      validatePhoneDisplayActions([{ type: "navigate", to: "home" }], capabilities),
    ).not.toThrow();
    for (const actions of [
      [{ type: "navigate", to: "recents" }],
      [{ type: "wake" }],
      [{ type: "type", text: { loginRef: `lgn_${"a".repeat(32)}`, field: "password" } }],
    ])
      expect(() => validatePhoneDisplayActions(actions, capabilities)).toThrow();
    expect(() =>
      validatePhoneDisplayActions([{ type: "launch", appId: "opaque" }], {
        ...capabilities,
        input: false,
      }),
    ).toThrow();
  });

  it("round-trips opaque app IDs through the Android package codec with original defaults", () => {
    const codec = getPhoneDisplayCodec("android-phone");
    const canonical = {
      actions: [
        { type: "launch", appId: "com.example.notes" },
        { type: "tap", target: { x: 1, y: 2 } },
      ],
      observationId: "observation-1",
      includeScreenshot: true,
    };
    const encoded = codec.encodeActParams(canonical);
    expect(encoded).toEqual(
      AndroidPhoneDispatchActParamsSchema.parse({
        ...canonical,
        actions: [
          { type: "launch", packageName: "com.example.notes" },
          { type: "tap", target: { x: 1, y: 2 } },
        ],
      }),
    );
    expect(codec.parseActions([{ type: "launch", packageName: "com.example.notes" }])).toEqual([
      { type: "launch", appId: "com.example.notes" },
    ]);
    const inventory = { apps: [{ label: "Notes", appId: "com.example.notes" }], total: 1 };
    expect(
      codec.decodeResult("installed_apps", codec.encodeResult("installed_apps", inventory)),
    ).toEqual(inventory);
    const result = { observation: { ...observation, locked: false, secureLock: false } };
    const wire = codec.encodeResult("observe", result);
    expect(wire).toMatchObject({
      observation: { foreground: { packageName: "com.example.notes" } },
    });
    expect(codec.decodeResult("observe", wire)).toEqual(result);
    expect(() =>
      codec.encodeActParams({ ...canonical, actions: [{ type: "navigate", to: "custom" }] }),
    ).toThrow();
  });

  it("preserves Android protected content validation when decoding", () => {
    const codec = getPhoneDisplayCodec("android-phone");
    expect(() =>
      codec.decodeResult("observe", {
        observation: {
          ...observation,
          locked: false,
          secureLock: false,
          foreground: { label: "Opensteer", packageName: "com.opensteer.agentphone" },
          tree: "private",
        },
      }),
    ).toThrow();
  });

  it("bounds timed batches and rejects stale or protected iPhone content", () => {
    expect(
      PhoneDisplayActionsSchema.safeParse(
        Array.from({ length: 9 }, () => ({ type: "wait", ms: 5000 })),
      ).success,
    ).toBe(false);
    expect(PhoneDisplayObservationSchema.parse(observation)).toEqual(observation);
    expect(
      IphoneScreenObservationSchema.safeParse({ ...observation, locked: true, tree: "private" })
        .success,
    ).toBe(false);
    expect(
      IphoneScreenObservationSchema.safeParse({
        ...observation,
        locked: true,
        screen: "off",
        screenshotUnavailable: "screen-off",
      }).success,
    ).toBe(true);
    expect(
      PhoneDisplayObservationSchema.safeParse({
        ...observation,
        screenshotUnavailable: "protected",
        tree: "private",
      }).success,
    ).toBe(false);
    expect(
      PhoneDisplayObservationSchema.safeParse({
        ...observation,
        geometry: { width: 10001, height: 1 },
      }).success,
    ).toBe(false);
    expect(
      PhoneDisplayActResultSchema.safeParse({
        observation: null,
        error: { code: "stale-observation", message: "Stale" },
        performed: ["Tapped"],
      }).success,
    ).toBe(false);
  });

  it.each([
    { tree: "private", elementCount: 1 },
    {
      screenshot: { base64: "YWJj", mime: "image/jpeg", width: 390, height: 844 },
      screenshotUnavailable: null,
    },
  ])("hides iPhone content until its lock state is explicitly unlocked: %j", (content) => {
    const unlocked = { ...observation, ...content, locked: false };
    expect(IphoneScreenObservationSchema.safeParse(unlocked).success).toBe(true);
    expect(IphoneScreenObservationSchema.safeParse({ ...unlocked, locked: null }).success).toBe(
      false,
    );
    expect(
      IphoneScreenObservationSchema.safeParse({
        ...observation,
        screenshotUnavailable: "protected",
      }).success,
    ).toBe(true);
  });

  it("requires paired target fields and an external route for iPhone screen operations", () => {
    const frame = {
      ...fence,
      ...target,
      type: "host.integrations.computer-use",
      definitionId: "iphone-screen",
      operation: "observe",
      access: "read",
      app: null,
      params: {},
      requestId: "request-1",
      runId: createId("run"),
      sessionId: "cus_00000000-0000-4000-8000-000000000006",
      threadTitle: null,
      timeoutMs: 10000,
    };
    expect(HostToIntegrationsModuleMessageSchema.parse(frame)).toEqual(frame);
    for (const patch of [
      { deviceId: undefined },
      { driverGeneration: undefined },
      { driverGeneration: 0 },
      { driverGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { app: { bundleId: "x", displayName: "X", teamId: null } },
      { operation: "session_open" },
    ])
      expect(HostToIntegrationsModuleMessageSchema.safeParse({ ...frame, ...patch }).success).toBe(
        false,
      );
    expect(
      HostToIntegrationsModuleMessageSchema.safeParse({ ...frame, definitionId: "android-phone" })
        .success,
    ).toBe(false);
    const result = {
      ...fence,
      ...target,
      type: "runner.integrations.computer-use-result",
      requestId: "request-1",
      result: { kind: "ok", value: {} },
    };
    expect(IntegrationsModuleEventSchema.parse(result)).toEqual(result);
    expect(
      IntegrationsModuleEventSchema.safeParse({ ...result, driverGeneration: undefined }).success,
    ).toBe(false);
  });

  it("round-trips assignment replacements and per-device status without hardware identity", () => {
    const assignment = {
      deviceId: target.deviceId,
      generation: 2,
      role: "screen",
      definitionId: "iphone-screen",
    };
    for (const assignments of [[], [assignment]]) {
      const frame = { ...fence, type: "host.integrations.device-drivers", drivers: assignments };
      expect(HostToIntegrationsModuleMessageSchema.parse(frame)).toEqual(frame);
    }
    const status = {
      ...fence,
      ...target,
      type: "runner.integrations.device-status",
      definitionId: "iphone-screen",
      operations: [],
      availability: { state: "unavailable", reason: { kind: "locked" } },
      navigationButtons: [{ id: "home", label: "Home" }],
      actions: ["tap", "navigate"],
      wake: false,
      lock: null,
      displayVersion: 1,
      ownerViewVersion: 1,
      inputVersion: 1,
      powerVersion: null,
    };
    expect(IntegrationsModuleEventSchema.parse(status)).toEqual(status);
    expect(
      IntegrationsModuleEventSchema.safeParse({ ...status, hardwareId: "forbidden" }).success,
    ).toBe(false);
    expect(
      IntegrationsModuleEventSchema.safeParse({
        ...status,
        availability: { state: "unavailable", reason: { kind: "future" } },
      }).success,
    ).toBe(false);
  });

  it("keeps the Kotlin Android4 fixtures byte-identical through the frame parsers", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../../../apps/agent-phone/app/src/test/resources/wire-fixture.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { integrations: Record<string, unknown> };
    for (const frame of Object.values(fixture.integrations)) {
      expect(JSON.stringify(IntegrationsModuleEventSchema.parse(frame))).toBe(
        JSON.stringify(frame),
      );
    }
  });
});

it("preserves Android sealed-login binding and refuses that authority on iPhone", () => {
  const binding = {
    version: 1,
    connectionId: "receiver-connection-1",
    connectionGeneration: 1,
    runId: createId("run"),
    sessionId: "cus_00000000-0000-4000-8000-000000000001",
    actId: "cai:00000000-0000-4000-8000-000000000002",
    actionIndex: 0,
    field: "password",
    expiresAt: 1800000060000,
  };
  const envelope = {
    binding,
    senderPublicKey: `B${"A".repeat(86)}`,
    salt: "A".repeat(43),
    nonce: "A".repeat(16),
    ciphertext: "YWJj",
    tag: "A".repeat(22),
  };
  const params = {
    actions: [{ type: "type", text: { sealed: envelope } }],
    observationId: "obs-1",
    includeScreenshot: false,
    loginContext: { runId: binding.runId, actId: binding.actId },
  };
  const android = getPhoneDisplayCodec("android-phone");
  expect(android.encodeActParams(params)).toEqual(
    AndroidPhoneDispatchActParamsSchema.parse(params),
  );
  expect(() => android.encodeActParams({ ...params, loginContext: undefined })).toThrow();
  expect(() =>
    android.encodeActParams({
      ...params,
      loginContext: { ...params.loginContext, actId: "other" },
    }),
  ).toThrow();
  expect(() => getPhoneDisplayCodec("iphone-screen").encodeActParams(params)).toThrow();
  expect(() =>
    getPhoneDisplayCodec("iphone-screen").encodeActParams({
      ...params,
      loginContext: undefined,
      actions: [{ type: "type", text: { loginRef: `lgn_${"a".repeat(32)}`, field: "password" } }],
    }),
  ).toThrow();
});

it("keeps legacy Mac6 and Android4 request JSON bytes unchanged", () => {
  const mac =
    '{"bootId":"rbt_00000000-0000-4000-8000-000000000002","connectionGeneration":1,"connectionId":"rcn_00000000-0000-4000-8000-000000000003","connectionLeaseId":"rls_00000000-0000-4000-8000-000000000004","runnerId":"rnr_00000000-0000-4000-8000-000000000009","auxiliaryStreamId":"rax_00000000-0000-4000-8000-000000000001","module":"integrations","access":"read","app":{"bundleId":"com.apple.Notes","displayName":"Notes","teamId":null},"operation":"observe","params":{},"requestId":"request-1","runId":"run_00000000-0000-4000-8000-000000000010","sessionId":"cus_00000000-0000-4000-8000-000000000006","threadTitle":null,"timeoutMs":10000,"type":"host.integrations.computer-use"}';
  const android =
    '{"bootId":"rbt_00000000-0000-4000-8000-000000000002","connectionGeneration":1,"connectionId":"rcn_00000000-0000-4000-8000-000000000003","connectionLeaseId":"rls_00000000-0000-4000-8000-000000000004","runnerId":"rnr_00000000-0000-4000-8000-000000000009","auxiliaryStreamId":"rax_00000000-0000-4000-8000-000000000001","module":"integrations","access":"read-write","app":null,"definitionId":"android-phone","operation":"act","params":{"actions":[{"packageName":"com.example.notes","type":"launch"}],"observationId":"obs-1","includeScreenshot":true},"requestId":"request-1","runId":"run_00000000-0000-4000-8000-000000000010","sessionId":"cus_00000000-0000-4000-8000-000000000006","threadTitle":null,"timeoutMs":10000,"type":"host.integrations.computer-use"}';
  for (const bytes of [mac, android])
    expect(JSON.stringify(HostToIntegrationsModuleMessageSchema.parse(JSON.parse(bytes)))).toBe(
      bytes,
    );
  const wire = JSON.parse(android) as { params: unknown };
  expect(
    getPhoneDisplayCodec("android-phone").encodeActParams({
      actions: [{ type: "launch", appId: "com.example.notes" }],
      observationId: "obs-1",
      includeScreenshot: true,
    }),
  ).toEqual(wire.params);
});
