import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { AndroidPhoneActionSchema, AndroidPhoneDispatchActParamsSchema } from "./android-phone.js";
import {
  ComputerUseActionSchema,
  ComputerUseDispatchActParamsSchema,
  ComputerUseHelloResultSchema,
  ComputerUseSessionActParamsSchema,
  ComputerUseBridgeFrameSchema,
} from "./computer-use.js";
import {
  HostToIntegrationsModuleMessageSchema,
  IntegrationsModuleEventSchema,
} from "./computer-apps.js";
import {
  LoginEnvelopeBindingSchema,
  LoginReceiverKeySchema,
  LoginTextSchema,
  PasswordSignInAuthorityCommandSchema,
  SessionlessPasswordSignInRequestPayloadSchema,
  SealedLoginEnvelopeSchema,
} from "./password-sign-in.js";
import {
  PasswordsBrokerHelloParamsSchema,
  PasswordsBrokerHelloResultSchema,
  PasswordsBrokerSignInReleaseParamsSchema,
  PasswordsBrokerSignInReleaseV5ParamsSchema,
  PasswordsBrokerSignInRequestV5ParamsSchema,
  passwordsBrokerRequests,
} from "./passwords-broker.js";

// Pin the trust boundary before native consumers implement it: references are
// agent input, while ciphertext is internal dispatch input.
const login = { loginRef: "lgn_0123456789abcdef0123456789abcdef", field: "password" } as const;
const binding = {
  version: 1,
  connectionId: "receiver-connection-1",
  connectionGeneration: 1,
  runId: createId("run"),
  sessionId: "cus_00000000-0000-4000-8000-000000000001",
  actId: "cai:00000000-0000-4000-8000-000000000002",
  actionIndex: 0,
  field: "password",
  expiresAt: 1_800_000_060_000,
} as const;
const receiver = {
  version: 1,
  connectionId: binding.connectionId,
  connectionGeneration: 1,
  publicKey: "B" + "A".repeat(86),
} as const;
const envelope = {
  binding,
  senderPublicKey: receiver.publicKey,
  salt: "A".repeat(43),
  nonce: "A".repeat(16),
  ciphertext: "YWJj",
  tag: "A".repeat(22),
};
const app = {
  access: "read-write",
  identity: { bundleId: "com.opensteer.fixture", displayName: "Fixture", teamId: null },
};

it("keeps references at agent admission and sealed values at device dispatch", () => {
  for (const schema of [AndroidPhoneActionSchema, ComputerUseActionSchema]) {
    expect(schema.parse({ type: "type", text: login })).toMatchObject({ text: login });
    expect(schema.safeParse({ type: "type", text: { sealed: envelope } }).success).toBe(false);
    for (const text of [{ ...login, field: "totp" }, { ...login, value: "secret" }, {}]) {
      expect(schema.safeParse({ type: "type", text }).success).toBe(false);
    }
  }
  for (const schema of [AndroidPhoneDispatchActParamsSchema, ComputerUseDispatchActParamsSchema]) {
    const params = {
      actions: [{ type: "type", text: { sealed: envelope } }],
      ...(schema === AndroidPhoneDispatchActParamsSchema
        ? { includeScreenshot: false, observationId: "obs-1" }
        : { snapshot: "obs-1", window: "window-1" }),
      loginContext: { runId: binding.runId, actId: binding.actId },
    };
    expect(schema.safeParse(params).success).toBe(true);
    expect(schema.safeParse({ ...params, loginContext: undefined }).success).toBe(false);
    expect(
      schema.safeParse({ ...params, loginContext: { ...params.loginContext, actId: "other" } })
        .success,
    ).toBe(false);
    expect(schema.safeParse({ ...params, actions: [{ type: "type", text: login }] }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...params, actions: [{ type: "wait", ms: 5001 }] }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        actions: [{ type: "type", text: "literal" }],
        ...(schema === AndroidPhoneDispatchActParamsSchema
          ? { includeScreenshot: false, observationId: "obs-1" }
          : { snapshot: "obs-1", window: "window-1" }),
      }).success,
    ).toBe(true);
  }
  expect(
    ComputerUseSessionActParamsSchema.safeParse({
      actions: [{ type: "type", text: { sealed: envelope } }],
      app,
      snapshot: "obs-1",
      window: "window-1",
      sessionId: binding.sessionId,
      loginContext: { runId: binding.runId, actId: binding.actId },
    }).success,
  ).toBe(true);
  expect(LoginTextSchema.safeParse({ ...login, sealed: envelope }).success).toBe(false);
});

it("carries session-independent authority frames on the authenticated integrations and desktop bridges", () => {
  const fence = {
    runnerId: createId("runner"),
    bootId: "rbt_00000000-0000-4000-8000-000000000001",
    connectionId: "rcn_00000000-0000-4000-8000-000000000002",
    connectionLeaseId: "rls_00000000-0000-4000-8000-000000000003",
    connectionGeneration: 1,
    auxiliaryStreamId: "rax_00000000-0000-4000-8000-000000000004",
    module: "integrations",
  };
  const command = { type: "signin.probe", site: "https://example.com" };
  expect(
    HostToIntegrationsModuleMessageSchema.safeParse({
      ...fence,
      type: "host.integrations.password-sign-in",
      requestId: "pw:1",
      timeoutMs: 5000,
      command,
    }).success,
  ).toBe(true);
  expect(
    IntegrationsModuleEventSchema.safeParse({
      ...fence,
      type: "runner.integrations.password-sign-in-result",
      requestId: "pw:1",
      result: { type: "signin.probe.result", passwords: "has-login" },
    }).success,
  ).toBe(true);
  expect(
    ComputerUseBridgeFrameSchema.safeParse({
      kind: "request",
      id: 1,
      method: "passwords.control",
      params: command,
    }).success,
  ).toBe(true);
  expect(
    ComputerUseBridgeFrameSchema.safeParse({
      kind: "request",
      id: 2,
      method: "passwords.capabilities",
      params: {},
    }).success,
  ).toBe(true);
  expect(
    ComputerUseBridgeFrameSchema.safeParse({
      kind: "event",
      event: "passwords.event",
      params: { type: "login.ended", operationId: "00000000-0000-4000-8000-000000000001" },
    }).success,
  ).toBe(true);
});

it("bounds every authenticated binding and binary field", () => {
  expect(SealedLoginEnvelopeSchema.safeParse(envelope).success).toBe(true);
  for (const patch of [
    { version: 2 },
    { connectionGeneration: 0 },
    { actionIndex: 32 },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { value: "secret" },
  ])
    expect(LoginEnvelopeBindingSchema.safeParse({ ...binding, ...patch }).success).toBe(false);
  for (const patch of [
    { senderPublicKey: "A" },
    { nonce: "A" },
    { salt: "A" },
    { tag: "A" },
    { ciphertext: "+++=" },
    { value: "secret" },
  ])
    expect(SealedLoginEnvelopeSchema.safeParse({ ...envelope, ...patch }).success).toBe(false);
  expect(LoginReceiverKeySchema.safeParse(receiver).success).toBe(true);
  expect(LoginReceiverKeySchema.safeParse({ ...receiver, privateKey: "secret" }).success).toBe(
    false,
  );
  expect(
    ComputerUseHelloResultSchema.safeParse({
      helperVersion: "0.1.178",
      minProtocolVersion: 10,
      protocolVersion: 10,
      routes: { windowLocation: true, windowGroups: true },
      permissions: { accessibility: "granted", screenRecording: "granted" },
      loginText: receiver,
    }).success,
  ).toBe(true);
});

it("authorizes without a session and seals only to an explicit receiver/context", () => {
  const command = {
    type: "login.authorize",
    operationId: "00000000-0000-4000-8000-000000000003",
    loginRef: login.loginRef,
    site: "https://example.com",
    workspaceId: createId("workspace"),
    expiresAt: "2027-01-15T08:01:00.000Z",
    requester: {
      deploymentId: "personal",
      deploymentName: "Personal",
      reason: "Sign in",
      threadTitle: "Task",
      workspaceName: "Main",
    },
  };
  expect(PasswordSignInAuthorityCommandSchema.safeParse(command).success).toBe(true);
  expect(
    PasswordSignInAuthorityCommandSchema.safeParse({ ...command, sessionId: "fake" }).success,
  ).toBe(false);
  expect(
    PasswordSignInAuthorityCommandSchema.safeParse({
      type: "login.seal",
      operationId: command.operationId,
      receiver,
      binding,
    }).success,
  ).toBe(true);
  expect(
    SessionlessPasswordSignInRequestPayloadSchema.safeParse({
      kind: "browser.password-sign-in",
      scope: "workspace",
      permissionVersion: 5,
      computerName: "Mac",
      runnerId: createId("runner"),
      reason: command.requester.reason,
      operationId: command.operationId,
      expiresAt: command.expiresAt,
      site: command.site,
    }).success,
  ).toBe(true);
});

it("retains v4 origin releases while giving v5 an explicit app release kind", () => {
  const transactionId = "00000000-0000-4000-8000-000000000004";
  const legacy = { transactionId, field: "password", origin: "https://example.com" };
  expect(PasswordsBrokerSignInReleaseParamsSchema.safeParse(legacy).success).toBe(true);
  expect(
    PasswordsBrokerSignInReleaseParamsSchema.safeParse({ transactionId, field: "password" })
      .success,
  ).toBe(false);
  expect(
    PasswordsBrokerSignInReleaseV5ParamsSchema.safeParse({
      transactionId,
      field: "password",
      kind: "app",
    }).success,
  ).toBe(true);
  expect(
    PasswordsBrokerSignInReleaseV5ParamsSchema.safeParse({ ...legacy, kind: "browser" }).success,
  ).toBe(true);
  expect(
    PasswordsBrokerSignInReleaseV5ParamsSchema.safeParse({ ...legacy, kind: "app" }).success,
  ).toBe(false);
  expect(passwordsBrokerRequests["signin.release"].safeParse(legacy).success).toBe(true);
  for (const protocolVersion of [4, 5]) {
    expect(
      PasswordsBrokerHelloParamsSchema.safeParse({
        protocolVersion,
        client: { version: "0.1.178" },
      }).success,
    ).toBe(true);
    expect(
      PasswordsBrokerHelloResultSchema.safeParse({
        protocolVersion,
        development: true,
        brokerVersion: "0.1.178",
      }).success,
    ).toBe(true);
  }
  const request = {
    deploymentId: "personal",
    deploymentName: "Personal",
    reason: "Sign in",
    threadTitle: "Task",
    workspaceName: "Main",
    workspaceId: createId("workspace"),
    site: "https://example.com",
    transactionId,
    expiresAt: "2027-01-15T08:01:00.000Z",
    protocolVersion: 5,
    permissionVersion: 5,
  };
  expect(PasswordsBrokerSignInRequestV5ParamsSchema.safeParse(request).success).toBe(true);
  expect(
    PasswordsBrokerSignInRequestV5ParamsSchema.safeParse({ ...request, permissionVersion: 4 })
      .success,
  ).toBe(false);
  expect(
    PasswordsBrokerSignInRequestV5ParamsSchema.safeParse({
      ...request,
      permissionVersion: undefined,
    }).success,
  ).toBe(false);
  expect(passwordsBrokerRequests["signin.request"].safeParse(request).success).toBe(true);
});
