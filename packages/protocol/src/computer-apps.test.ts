import { createId } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import { describe, expect, it } from "vitest";
import {
  ComputerAppRemedySchema,
  HostToIntegrationsModuleMessageSchema,
  IntegrationsModuleEventSchema,
  computerAppMaxStatusEntries,
} from "./computer-apps.js";
import { hostApi } from "./host-api.js";
import { MachineAppStatusSchema } from "./machines.js";

const fence = {
  auxiliaryStreamId: "rax_00000000-0000-4000-8000-000000000001",
  bootId: "rbt_00000000-0000-4000-8000-000000000002",
  connectionGeneration: 1,
  connectionId: "rcn_00000000-0000-4000-8000-000000000003",
  connectionLeaseId: "rls_00000000-0000-4000-8000-000000000004",
  module: "integrations",
  runnerId: createId("runner"),
} as const;

describe("computer app auxiliary frames", () => {
  it("bounds owner window picker frames and keeps them independent of sessions and leases", () => {
    const app = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null };
    const request = {
      ...fence,
      type: "host.integrations.computer-app-windows",
      requestId: "windows-1",
      app,
      timeoutMs: 30_000,
    };
    expect(HostToIntegrationsModuleMessageSchema.parse(request)).toEqual(request);
    for (const patch of [
      { timeoutMs: 0 },
      { timeoutMs: 30_001 },
      { sessionId: "session" },
      { leaseDurationMs: 30_000 },
      { app: { ...app, extra: true } },
    ])
      expect(
        HostToIntegrationsModuleMessageSchema.safeParse({ ...request, ...patch }).success,
      ).toBe(false);
    const window = {
      id: 42,
      title: "List",
      focused: true,
      main: true,
      minimized: false,
      onScreen: true,
    };
    const response = {
      ...fence,
      type: "runner.integrations.computer-app-windows-result",
      requestId: "windows-1",
      result: { kind: "ok", value: { windows: [window] } },
    };
    expect(IntegrationsModuleEventSchema.parse(response)).toEqual(response);
    for (const windows of [Array(65).fill(window), [{ ...window, ref: "private" }]])
      expect(
        IntegrationsModuleEventSchema.safeParse({
          ...response,
          result: { kind: "ok", value: { windows } },
        }).success,
      ).toBe(false);
    expect(
      IntegrationsModuleEventSchema.parse({
        ...response,
        result: { kind: "error", code: "app-not-allowed", message: "That app is not allowed." },
      }),
    ).toMatchObject({
      result: { kind: "error", code: "app-not-allowed", message: "That app is not allowed." },
    });
    const rpc = hostApi["computer.app.windows"];
    const machineId = fence.runnerId;
    expect(rpc.payload.parse({ machineId, app })).toEqual({ machineId, app });
    expect(rpc.payload.safeParse({ machineId, app, extra: true }).success).toBe(false);
    expect(rpc.success.parse({ windows: [{ ...window, future: true }], future: true })).toEqual({
      windows: [window],
    });
  });

  it("round-trips invoke, cancel, status, and result frames", () => {
    const invoke = {
      ...fence,
      access: "read-write",
      arguments: { text: "Hello", to: { address: "person@example.com" } },
      contract: "a".repeat(43),
      definitionId: "apple-messages",
      operation: "send_message",
      requestId: "invoke-1",
      timeoutMs: 30_000,
      type: "host.integrations.invoke",
    } as const;
    const cancel = {
      ...fence,
      requestId: "invoke-1",
      type: "host.integrations.cancel",
    } as const;
    const status = {
      ...fence,
      apps: [
        {
          definitionId: "apple-messages",
          operations: [
            {
              detail: null,
              operation: "send_message",
              remedy: null,
              state: "ready",
            },
          ],
        },
      ],
      type: "runner.integrations.status",
    } as const;
    const result = {
      ...fence,
      requestId: "invoke-1",
      result: { kind: "ok", value: { accepted: true } },
      type: "runner.integrations.result",
    } as const;

    expect(HostToIntegrationsModuleMessageSchema.parse(invoke)).toEqual(invoke);
    expect(HostToIntegrationsModuleMessageSchema.parse(cancel)).toEqual(cancel);
    expect(IntegrationsModuleEventSchema.parse(status)).toEqual(status);
    expect(IntegrationsModuleEventSchema.parse(result)).toEqual(result);
  });

  it("names every remedy a computer can ask a person for", () => {
    expect(ComputerAppRemedySchema.options).toEqual([
      "full-disk-access",
      "automation",
      "accessibility",
      "screen-recording",
      "contacts",
      "calendars",
      "reminders",
    ]);
    expect(ComputerAppRemedySchema.safeParse("full-disk").success).toBe(false);
  });

  it("rejects unknown result codes and oversized status inventories", () => {
    expect(
      IntegrationsModuleEventSchema.safeParse({
        ...fence,
        requestId: "invoke-1",
        result: { code: "offline", kind: "error", message: "No stream" },
        type: "runner.integrations.result",
      }).success,
    ).toBe(false);

    expect(
      IntegrationsModuleEventSchema.safeParse({
        ...fence,
        apps: Array.from({ length: computerAppMaxStatusEntries + 1 }, (_, index) => ({
          definitionId: `app-${index}`,
          operations: [],
        })),
        type: "runner.integrations.status",
      }).success,
    ).toBe(false);
  });

  it("keeps Runner status strict and Host machine status forward tolerant at every level", () => {
    const operation = {
      detail: null,
      operation: "send_message",
      remedy: "automation",
      state: "permission-required",
    } as const;
    expect(
      IntegrationsModuleEventSchema.safeParse({
        ...fence,
        apps: [
          {
            definitionId: "apple-messages",
            operations: [{ ...operation, futureOperationFact: true }],
          },
        ],
        type: "runner.integrations.status",
      }).success,
    ).toBe(false);
    expect(
      MachineAppStatusSchema.parse({
        definitionId: "apple-messages",
        futureAppFact: true,
        operations: [{ ...operation, futureOperationFact: true }],
      }),
    ).toEqual({ definitionId: "apple-messages", operations: [operation] });
  });

  it("carries the computer connection command and its tolerant connection result", () => {
    const command = {
      idempotencyKey: "set-messages-on-mac",
      input: {
        kind: "app",
        app: null,
        access: "read-write",
        definitionId: "apple-messages",
        runnerId: fence.runnerId,
      },
      type: "integration.computer.setup.set",
    } as const;
    // A bounded computer app carries no GUI identity.
    expect(hostApi["commands.dispatch"].payload.parse(command)).toEqual({
      ...command,
      input: { ...command.input, app: null },
    });

    const connection = {
      accountIdentifier: null,
      applicationSource: null,
      authMethodId: "computer",
      authorizationDigest: null,
      computer: {
        access: "read-write",
        app: null,
        runnerId: fence.runnerId,
        blockedAt: null,
        policyRevision: null,
      },
      connectionMethod: "computer",
      createdAt: "2026-09-17T12:00:00.000Z",
      definitionId: "apple-messages",
      displayName: "Mac mini",
      externalIdentityId: null,
      externalTenantId: null,
      grantedScopes: [],
      id: createIntegrationId("connection"),
      provider: "apple-messages",
      providerApplicationId: null,
      status: "connected",
      statusDetail: null,
      statusReason: null,
      updatedAt: "2026-09-17T12:00:00.000Z",
    } as const;
    expect(
      hostApi["commands.dispatch"].success.parse({
        connection: { ...connection, addedLater: true },
        type: "integration.computer.setup.set",
      }),
    ).toEqual({ connection, type: "integration.computer.setup.set" });
  });
});

describe("computer app approval and discovery contracts", () => {
  it("carries policy setup, direct disable, key registration and block commands, and no signature", () => {
    const runnerId = fence.runnerId;
    const policy = { kind: "policy", runnerId, appApproval: "automatic" } as const;
    const approval = {
      requestId: "00000000-0000-4000-8000-000000000001",
      expiresAt: "2026-09-22T10:00:00Z",
      signature: "a".repeat(86),
    };
    const app = {
      access: "read",
      app: null,
      definitionId: "apple-messages",
      kind: "app",
      runnerId,
    };
    const parse = (value: unknown) => hostApi["commands.dispatch"].payload.safeParse(value);
    expect(
      parse({ idempotencyKey: "policy", type: "integration.computer.setup.request", input: policy })
        .success,
    ).toBe(true);
    // A signed consume is the Mac's answer on its own Runner stream: no client
    // command carries a signature, for an app or for the policy.
    for (const input of [policy, { ...policy, approval }, { ...app, approval }]) {
      expect(
        parse({ idempotencyKey: "signed", type: "integration.computer.setup.set", input }).success,
      ).toBe(false);
    }
    expect(
      parse({ idempotencyKey: "lower", type: "integration.computer.setup.set", input: app })
        .success,
    ).toBe(true);
    expect(
      parse({
        idempotencyKey: "key",
        type: "integration.computer.approval-key.set",
        input: {
          publicKey:
            "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAGb9ECWmEzf6FQbrBZ9w7lshQhqowtrbLDFw4rXAxZuE=\n-----END PUBLIC KEY-----\n",
          runnerId,
        },
      }).success,
    ).toBe(true);
    expect(
      parse({
        idempotencyKey: "off",
        type: "integration.computer.policy.set",
        input: { runnerId, appApproval: "ask" },
      }).success,
    ).toBe(true);
    expect(
      parse({
        idempotencyKey: "on",
        type: "integration.computer.policy.set",
        input: { runnerId, appApproval: "automatic" },
      }).success,
    ).toBe(false);
    expect(
      parse({
        idempotencyKey: "block",
        type: "integration.computer.app.block",
        connectionId: createIntegrationId("connection"),
      }).success,
    ).toBe(true);
    expect(hostApi["integration.computer.policy.get"].payload.parse({ runnerId })).toEqual({
      runnerId,
    });
  });

  it("defaults and bounds the installed-app query", () => {
    const schema = hostApi["integration.computer.apps.installed"].payload;
    expect(schema.parse({ runnerId: fence.runnerId })).toEqual({
      runnerId: fence.runnerId,
      query: "",
      limit: 50,
      offset: 0,
      icons: false,
    });
    expect(
      schema.parse({ runnerId: fence.runnerId, query: "Notes", limit: 1, offset: 20, icons: true })
        .icons,
    ).toBe(true);
    for (const input of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 0.5 }]) {
      expect(schema.safeParse({ runnerId: fence.runnerId, ...input }).success).toBe(false);
    }
  });
});
