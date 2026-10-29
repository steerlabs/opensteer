import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  IntegrationToolsMcpService,
  type IntegrationToolsTokenService,
  type TriggerIntegrationToolsTokenService,
} from "./integration-tools-mcp-service.js";
import { generateKeyPairSync } from "node:crypto";
import {
  IntegrationDefinitionSchema,
  createIntegrationId,
  integrationDefinitionSummary,
  integrationInstallManifestSummary,
  isComputerAppDefinition,
  type IntegrationAdapter,
  type IntegrationConnectionSummary,
  type IntegrationGrant,
  type IntegrationInstallation,
  type IntegrationServer,
  type IntegrationTool,
  type IntegrationToolMaterial,
} from "@opensteer/integration-core";
import { computerAppTools } from "@opensteer/integration-core/computer-app-tools";
import { computerAppIntegrations } from "@opensteer/integration-catalog";
import { type IntegrationAdapterCredentialMaterializer } from "@opensteer/integration-core/ports";
import {
  integrationDefinitionDigest,
  integrationSchemaDigest,
} from "@opensteer/integration-core/digest";
import { createOpenApiAdapter, openApiAdapter } from "@opensteer/integration-adapters";
import {
  ComputerAppNotOfferedError,
  type CallableIntegrationTool,
  type ComputerAppAccessDecision,
  type IntegrationPlatformStore,
  type PreparedIntegrationInstallFulfillment,
} from "@opensteer/database";
import {
  OpensteerError,
  createToolOutput,
  RequestJsonObjectSchema,
  createId,
  type AgentEvent,
  type Request,
} from "@opensteer/core";
import {
  computerUseUpdateMacSentence,
  computerUseUpdateSentence,
  mintComputerUseSessionId,
  type MachineAppStatus,
} from "@opensteer/protocol";
import {
  computerAppApprovalKeyId,
  signComputerAppApprovalKeyChallenge,
} from "@opensteer/runner-auth";
import { describe, expect, it, vi } from "vitest";
import {
  IntegrationAuthorizationRequiredError,
  IntegrationPlatformService,
} from "./integration-platform-service.js";
import type {
  ComputerAppHub,
  ComputerAppInvokeOutcome,
} from "../computer-apps/computer-app-hub.js";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { validateJsonSchema } from "@opensteer/integration-adapters";
import {
  ComputerUseError,
  ComputerUseService,
  type ComputerUseServiceOptions,
} from "../computer-use/computer-use-service.js";
import type {
  ComputerUseGateway,
  RunToolContext,
  ToolCaller,
} from "./integration-platform-service.js";

/** A call with no Run behind it, as a Trigger occurrence makes. */
const caller: ToolCaller = { run: null, threadId: createId("thread") };
const runCaller = (run: RunToolContext): ToolCaller => ({
  run: {
    ...run,
    aud: "opensteer-integration-tools",
    bindingGeneration: 1,
    capabilityProfileId: "main",
    environmentId: createId("environment"),
    exp: 2_000_000_000,
    iat: 1_900_000_000,
    iss: "opensteer-host",
    jti: "test",
    membershipGeneration: 1,
    requestedBy: createId("user"),
    runnerBootId: "boot",
    runnerId: createId("runner"),
    workspaceId: createId("workspace"),
  },
  threadId: run.threadId,
});

const now = "2026-08-13T12:00:00.000Z";
const materialized = {
  authMethodId: "oauth",
  connectionMethod: "managed-oauth" as const,
  credentialGeneration: 1,
  credentialValues: { accessToken: "fresh-token" },
  definitionId: "mail",
  grantedScopes: ["mail.send"],
  provider: "mail",
};
const computerDefinitionCandidate = computerAppIntegrations[0]!;
if (!isComputerAppDefinition(computerDefinitionCandidate)) {
  throw new Error("Computer definition invalid");
}
const computerDefinition = computerDefinitionCandidate;

function computerStatus(
  observation: Omit<MachineAppStatus["operations"][number], "operation"> = {
    detail: null,
    remedy: null,
    state: "ready",
  },
  operations = computerDefinition.config.operations.map(({ name }) => name),
): MachineAppStatus {
  return {
    definitionId: computerDefinition.id,
    operations: operations.map((operation) => ({ operation, ...observation })),
  };
}

describe("IntegrationPlatformService definition reconciliation", () => {
  it("materializes a computer app without an adapter snapshot or server tools", async () => {
    const install = vi.fn(async (input: Parameters<IntegrationPlatformStore["install"]>[0]) => ({
      installation: {
        ...input.installation,
        createdAt: now,
        revision: 1,
        updatedAt: now,
      },
      requestEvents: [],
    }));
    const service = platform({
      adapters: [],
      definitions: [computerDefinition],
      store: {
        install,
        listInstallations: vi.fn(async () => []),
        listTools: vi.fn(async () => []),
      },
    });

    await service.installCatalogDefinition({
      actorUserId: createId("user"),
      definitionId: computerDefinition.id,
      digest: integrationDefinitionDigest(computerDefinition),
      requestId: "install-computer-app",
    });

    const material = install.mock.calls[0]![0];
    expect(material.adapterSnapshot).toBeNull();
    expect(material.servers).toEqual([
      expect.objectContaining({
        catalog: { definitions: {}, tools: [] },
        connectionRequirement: { definitionId: computerDefinition.id, kind: "computer" },
        status: "active",
        transport: { definitionId: computerDefinition.id, type: "computer" },
      }),
    ]);
    const connectionId = createIntegrationId("connection");
    expect(material.computerConnectionTools?.(connectionId, "read")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ connectionId, name: "list_conversations" }),
      ]),
    );
    expect(material.computerConnectionTools?.(connectionId, "read")).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "send_message" })]),
    );
  });

  it("does not auto-install catalog entries and retries needs-attention snapshots", async () => {
    const healthyDefinition = IntegrationDefinitionSchema.parse({
      adapter: "graphql",
      authMethods: [{ id: "none", kind: "none", label: "No authentication" }],
      config: { version: 1 },
      description: "A local test integration",
      id: "healthy",
      name: "Healthy",
      provider: "healthy",
    });
    const failingDefinition = IntegrationDefinitionSchema.parse({
      adapter: "openapi",
      authMethods: [{ id: "none", kind: "none", label: "No authentication" }],
      config: { specUrl: "https://127.0.0.1/private-openapi.json" },
      description: "A spec that the SSRF policy rejects",
      id: "failing-spec",
      name: "Failing Spec",
      provider: "failing-spec",
    });
    const testAdapter: IntegrationAdapter = {
      credentialDisclosure() {
        return { destinations: ["https://api.example.com"], check: true };
      },
      async checkHealth() {
        return { healthy: true };
      },
      async invokeTool() {
        return { kind: "ok", value: {} };
      },
      kind: "graphql",
      parseConfig: (config) => config,
      snapshotConfig: async (config) => configObject(config),
      async resolveTools() {
        return {
          definitions: {},
          tools: [
            {
              description: "Ping the integration",
              inputSchema: { type: "object" },
              name: "ping",
            },
          ],
        };
      },
    };
    const installations: IntegrationInstallation[] = [];
    const openApiFetch = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("public fetch rejected"))
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            info: { title: "Recovered API", version: "1" },
            openapi: "3.1.0",
            paths: {
              "/ping": { get: { operationId: "ping", responses: { 200: {} } } },
            },
            servers: [{ url: "https://api.example.test" }],
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
      );
    const install = vi.fn(async (input: Parameters<IntegrationPlatformStore["install"]>[0]) => {
      const installation = {
        ...input.installation,
        createdAt: now,
        revision: 1,
        updatedAt: now,
      } satisfies IntegrationInstallation;
      const index = installations.findIndex(({ id }) => id === installation.id);
      if (index === -1) installations.push(installation);
      else installations[index] = installation;
      return { installation, requestEvents: [] };
    });
    const service = platform({
      adapters: [testAdapter, createOpenApiAdapter(openApiFetch)],
      definitions: [healthyDefinition, failingDefinition],
      store: {
        install,
        listInstallations: vi.fn(async () => installations),
        listTools: vi.fn(async () => []),
      },
    });

    expect(await service.ensureBuiltIns({ actorUserId: null, requestId: "startup-empty" })).toEqual(
      [],
    );
    const healthy = await service.installCatalogDefinition({
      actorUserId: createId("user"),
      definitionId: healthyDefinition.id,
      digest: integrationDefinitionDigest(healthyDefinition),
      requestId: "install-healthy",
    });
    const failing = await service.installCatalogDefinition({
      actorUserId: createId("user"),
      definitionId: failingDefinition.id,
      digest: integrationDefinitionDigest(failingDefinition),
      requestId: "install-failing",
    });
    expect([healthy, failing]).toEqual([
      expect.objectContaining({ name: "healthy", status: "active" }),
      expect.objectContaining({ name: "failing-spec", status: "needs-attention" }),
    ]);
    const healthyInstall = install.mock.calls[0]?.[0];
    expect(healthyInstall?.adapterSnapshot).toMatchObject({
      adapter: "graphql",
      config: { version: 1 },
      definitionId: "healthy",
    });
    expect(healthyInstall?.installation.manifest).toMatchObject({
      definition: { id: "healthy" },
    });
    expect(healthyInstall?.installation.manifest).not.toHaveProperty("resolvedConfig");
    expect(healthyInstall?.installation.manifest.definition).not.toHaveProperty("config");
    expect(install.mock.calls[1]?.[0].adapterSnapshot).toBeNull();
    expect(install.mock.calls[1]?.[0].servers[0]?.statusDetail).toContain("public");

    const reconciled = await service.ensureBuiltIns({ actorUserId: null, requestId: "startup" });
    expect(reconciled).toEqual([
      expect.objectContaining({ name: "healthy", status: "active" }),
      expect.objectContaining({ name: "failing-spec", status: "active" }),
    ]);
    const current = await service.ensureBuiltIns({ actorUserId: null, requestId: "startup-again" });
    expect(current).toEqual(reconciled);
    expect(install).toHaveBeenCalledTimes(3);
    expect(openApiFetch).toHaveBeenCalledTimes(2);
  });
});

describe("IntegrationPlatformService uninstall", () => {
  it("takes affected Runner admission turns in stable order", async () => {
    const installationId = createIntegrationId("installation");
    const first = createId("runner");
    const second = createId("runner");
    const ordered = [first, second].sort((left, right) => left.localeCompare(right));
    const events: string[] = [];
    const uninstall = vi.fn(async () => {
      events.push("uninstall");
      return {
        cancelledRequestIds: [],
        installation: {} as IntegrationInstallation,
        removedConnectionIds: [],
        removedApps: [],
        removedServerIds: [],
        requestEvents: [],
      };
    });
    const service = platform({
      adapters: [],
      computerApps: {
        appStatus: vi.fn(),
        attached: vi.fn(),
        send: vi.fn(),
        withRunnerAdmission: vi.fn(async (runnerId, task) => {
          events.push(`enter:${runnerId}`);
          try {
            return await task();
          } finally {
            events.push(`exit:${runnerId}`);
          }
        }),
      },
      store: {
        listComputerRunnerIdsForInstallation: vi.fn(async () => [second, first, second]),
        uninstall,
      },
    });

    await service.uninstallIntegration({
      actorUserId: createId("user"),
      installationId,
      requestId: "stable-uninstall",
    });

    expect(events).toEqual([
      `enter:${ordered[0]}`,
      `enter:${ordered[1]}`,
      "uninstall",
      `exit:${ordered[1]}`,
      `exit:${ordered[0]}`,
    ]);
  });
});

describe("IntegrationPlatformService computer connections", () => {
  it("refuses a non-administrator when the app is not installed", async () => {
    const service = platform({
      adapters: [],
      definitions: [computerDefinition],
      store: { listInstallations: vi.fn(async () => []) },
    });
    await expect(
      service.computerAppApprovals.setComputerConnection({
        kind: "app",
        app: null,
        access: "read",
        actorUserId: createId("user"),
        definitionId: computerDefinition.id,
        isAdministrator: false,
        requestId: "computer-on",
        runnerId: createId("runner"),
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: `Ask an administrator to add ${computerDefinition.name} to this Deployment.`,
    });
  });

  it("refuses an offline create but allows an offline access change", async () => {
    const runnerId = createId("runner");
    const installed = {
      ...computerCallable().installation,
      provenance: {
        definitionDigest: integrationDefinitionDigest(computerDefinition),
        definitionId: computerDefinition.id,
      },
    };
    const connection = {
      ...computerConnectionSummary("read-write"),
      computer: {
        blockedAt: null,
        policyRevision: null,
        access: "read-write" as const,
        app: null,
        runnerId,
      },
    };
    let existing = false;
    const setComputerConnection = vi.fn(
      async (input: Parameters<IntegrationPlatformStore["setComputerConnection"]>[0]) => {
        if (!existing && !input.createIfMissing) {
          throw new ComputerAppNotOfferedError("Studio Mac");
        }
        return {
          connection,
          created: false,
          fulfilledRequestIds: [],
          grants: [],
          requestEvents: [],
          reissuedSetupRequestId: null,
          sessionReset: null,
        };
      },
    );
    const service = platform({
      adapters: [],
      computerApps: {
        appStatus: vi.fn(() => null),
        attached: vi.fn(() => false),
        send: vi.fn(),
        withRunnerAdmission: vi.fn(async (_runnerId, task) => task()),
      },
      definitions: [computerDefinition],
      store: {
        listInstallations: vi.fn(async () => [installed]),
        setComputerConnection,
      },
    });
    const input = {
      kind: "app" as const,
      app: null,
      access: "read-write" as const,
      actorUserId: createId("user"),
      definitionId: computerDefinition.id,
      isAdministrator: false,
      requestId: "computer-change",
      runnerId,
    };

    await expect(service.computerAppApprovals.setComputerConnection(input)).rejects.toMatchObject({
      code: "conflict",
      message: `Studio Mac is offline. Turn ${computerDefinition.name} on when it is back.`,
    });
    existing = true;
    await expect(service.computerAppApprovals.setComputerConnection(input)).resolves.toEqual(
      connection,
    );
    expect(setComputerConnection).toHaveBeenCalledTimes(2);
  });

  it("revokes a computer connection inside Runner admission and publishes cancellations", async () => {
    const callable = computerCallable();
    const runnerId = createId("runner");
    const requestEvent = { type: "request.cancelled" } as AgentEvent;
    let admitted = false;
    const revokeComputerConnection = vi.fn(async () => {
      expect(admitted).toBe(true);
      return {
        cancelledRequestIds: [createId("request")],
        connectionIds: [callable.grant.connectionId!],
        removedApps: [],
        requestEvents: [requestEvent],
      };
    });
    const onWorkspaceEvent = vi.fn();
    const service = platform({
      adapters: [],
      computerApps: {
        appStatus: vi.fn(),
        attached: vi.fn(),
        send: vi.fn(),
        withRunnerAdmission: vi.fn(async (_runnerId, task) => {
          admitted = true;
          try {
            return await task();
          } finally {
            admitted = false;
          }
        }),
      },
      onWorkspaceEvent,
      store: {
        getComputerConnectionForCall: vi.fn(async () => ({
          access: "read" as const,
          connection: computerConnectionSummary("read"),
          runnerId,
          runnerName: "Studio Mac",
          deviceProfile: null,
          runnerRevoked: false,
        })),
        revokeComputerConnection,
      },
    });
    await expect(
      service.computerAppApprovals.disconnectComputerConnection({
        connectionId: callable.grant.connectionId!,
        ownerUserId: callable.grant.ownerUserId as ReturnType<typeof createId<"user">>,
        requestId: "disconnect-computer",
      }),
    ).resolves.toEqual({ notice: null, revokedUpstream: false });
    expect(onWorkspaceEvent).toHaveBeenCalledWith(requestEvent);
  });
});

describe("IntegrationPlatformService computer invocation", () => {
  function invocationFixture(input: {
    readonly connectionAccess?: "read" | "read-write";
    readonly grantAccess?: "read" | "read-write";
    readonly moduleAttached?: boolean;
    readonly outcome: ComputerAppInvokeOutcome | Promise<ComputerAppInvokeOutcome>;
    readonly revoked?: boolean;
    readonly runnerConnected?: boolean;
    readonly stale?: boolean;
  }) {
    const baseCallable = computerCallable("write");
    const callable: CallableIntegrationTool = {
      ...baseCallable,
      grant: {
        ...baseCallable.grant,
        access: input.grantAccess ?? "read-write",
      } as IntegrationGrant,
      installation: input.stale
        ? {
            ...baseCallable.installation,
            provenance: {
              ...baseCallable.installation.provenance,
              definitionDigest: "x".repeat(43),
            },
          }
        : baseCallable.installation,
    };
    const runnerId = createId("runner");
    const connection = {
      ...computerConnectionSummary(input.connectionAccess ?? "read-write"),
      computer: {
        blockedAt: null,
        policyRevision: null,
        access: input.connectionAccess ?? "read-write",
        app: null,
        runnerId,
      },
      id: callable.grant.connectionId!,
    };
    let admitted = false;
    const send = vi.fn(async () => {
      expect(admitted).toBe(true);
      return { outcome: Promise.resolve(input.outcome) };
    });
    const listCallableTools = vi.fn(async () => [callable]);
    const service = platform({
      adapters: [],
      computerApps: {
        appStatus: vi.fn(() => null),
        attached: vi.fn(() => input.moduleAttached ?? false),
        send,
        withRunnerAdmission: vi.fn(async (_runnerId, task) => {
          admitted = true;
          try {
            return await task();
          } finally {
            admitted = false;
          }
        }),
      },
      definitions: [computerDefinition],
      isRunnerConnected: vi.fn(() => input.runnerConnected ?? false),
      store: {
        getComputerConnectionForCall: vi.fn(async () => ({
          access: input.connectionAccess ?? "read-write",
          connection,
          runnerId,
          runnerName: "Studio Mac",
          deviceProfile: null,
          runnerRevoked: input.revoked ?? false,
        })),
        listCallableTools,
      },
    });
    return { callable, listCallableTools, send, service };
  }

  it.each([
    ["offline", "Studio Mac is offline. Apple Messages will work again when it is back."],
    [
      "permission-required",
      "Allow Opensteer to control Messages in System Settings › Privacy & Security › Automation on Studio Mac.",
    ],
    ["unsupported", "Update Opensteer on Studio Mac to use Send message."],
    [
      "outcome-unknown",
      "Studio Mac did not confirm this. Check whether it happened before trying again.",
    ],
    ["lost", "Studio Mac did not answer. Try again."],
    ["busy", "Studio Mac is busy with other requests. Try again in a moment."],
    ["invalid-arguments", "Recipient is invalid."],
    ["failed", "Messages failed safely."],
  ] as const)("maps %s to its agent-facing sentence", async (code, expected) => {
    const { callable, service } = invocationFixture({
      outcome: {
        code,
        kind: "error",
        message:
          code === "permission-required"
            ? "Allow Opensteer to control Messages in System Settings › Privacy & Security › Automation."
            : code === "invalid-arguments" || code === "failed"
              ? expected
              : "runner detail",
        retryable: code === "busy" || code === "lost" || code === "offline",
      },
    });
    const result = await service.callTool(
      callable,
      {
        text: "hello",
        to: { address: "a@example.test" },
      },
      caller,
    );
    expect(result).toMatchObject({ content: [{ text: expected, type: "text" }], isError: true });
  });

  it("does not call an online computer offline when its integrations stream drops", async () => {
    const { callable, service } = invocationFixture({
      outcome: {
        code: "offline",
        kind: "error",
        message: "The integrations stream is not attached.",
        retryable: true,
      },
      runnerConnected: true,
    });

    await expect(
      service.callTool(callable, { text: "hello", to: { address: "a@example.test" } }, caller),
    ).resolves.toMatchObject({
      content: [
        {
          text: "Opensteer's integrations service is unavailable on Studio Mac.",
          type: "text",
        },
      ],
      isError: true,
    });
  });

  it.each([
    ["read" as const, "read-write" as const],
    ["read-write" as const, "read" as const],
  ])(
    "requires both the connection and grant to cover writes",
    async (connectionAccess, grantAccess) => {
      const { callable, send, service } = invocationFixture({
        connectionAccess,
        grantAccess,
        outcome: { kind: "ok", value: {} },
      });
      await expect(
        service.callTool(callable, { text: "hello", to: { address: "a@example.test" } }, caller),
      ).rejects.toBeInstanceOf(IntegrationAuthorizationRequiredError);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each(["revoked", "downgraded", "narrowed"] as const)(
    "re-resolves %s authority inside admission before sending",
    async (label) => {
      const { callable, listCallableTools, send, service } = invocationFixture({
        outcome: { kind: "ok", value: {} },
      });
      const authority: CallableIntegrationTool[] =
        label === "revoked"
          ? []
          : label === "downgraded"
            ? [
                {
                  ...callable,
                  grant: { ...callable.grant, access: "read" } as IntegrationGrant,
                },
              ]
            : [{ ...callable, tool: { ...callable.tool, schemaDigest: "z".repeat(43) } }];
      listCallableTools.mockResolvedValue(authority);

      await expect(
        service.callTool(callable, { text: "hello", to: { address: "a@example.test" } }, caller),
      ).rejects.toBeInstanceOf(IntegrationAuthorizationRequiredError);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("refuses a revoked Runner and a stale installed definition before sending", async () => {
    const revoked = invocationFixture({ outcome: { kind: "ok", value: {} }, revoked: true });
    await expect(
      revoked.service.callTool(
        revoked.callable,
        {
          text: "hello",
          to: { address: "a@example.test" },
        },
        caller,
      ),
    ).rejects.toBeInstanceOf(IntegrationAuthorizationRequiredError);
    expect(revoked.send).not.toHaveBeenCalled();

    const stale = invocationFixture({ outcome: { kind: "ok", value: {} }, stale: true });
    await expect(
      stale.service.callTool(
        stale.callable,
        {
          text: "hello",
          to: { address: "a@example.test" },
        },
        caller,
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("being updated"),
    });
    expect(stale.send).not.toHaveBeenCalled();
  });

  it("releases admission before awaiting the computer's answer", async () => {
    let resolve!: (outcome: ComputerAppInvokeOutcome) => void;
    const outcome = new Promise<ComputerAppInvokeOutcome>((settle) => {
      resolve = settle;
    });
    const { callable, service } = invocationFixture({ outcome });
    const call = service.callTool(
      callable,
      {
        text: "hello",
        to: { address: "a@example.test" },
      },
      caller,
    );
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    resolve({ kind: "ok", value: { accepted: true } });
    await expect(call).resolves.toMatchObject({ structuredContent: { accepted: true } });
  });

  it.each(["revoke", "downgrade", "narrow", "disconnect", "uninstall"] as const)(
    "does not send a resolved write when %s wins before admission",
    async (mutation) => {
      const callable = computerCallable("write");
      const runnerId = createId("runner");
      const connection = {
        ...computerConnectionSummary("read-write"),
        computer: {
          blockedAt: null,
          policyRevision: null,
          access: "read-write" as const,
          app: null,
          runnerId,
        },
        id: callable.grant.connectionId!,
      };
      let authority: CallableIntegrationTool[] = [callable];
      let connectionAccess: "read" | "read-write" = "read-write";
      let connected = true;
      let releaseLookup!: () => void;
      let markLookupStarted!: () => void;
      const lookupGate = new Promise<void>((resolve) => {
        releaseLookup = resolve;
      });
      const lookupStarted = new Promise<void>((resolve) => {
        markLookupStarted = resolve;
      });
      let connectionReads = 0;
      const getComputerConnectionForCall = vi.fn(async () => {
        connectionReads += 1;
        const result = connected
          ? {
              access: connectionAccess,
              connection: {
                ...connection,
                computer: {
                  blockedAt: null,
                  policyRevision: null,
                  access: connectionAccess,
                  app: null,
                  runnerId,
                },
              },
              runnerId,
              runnerName: "Studio Mac",
              deviceProfile: null,
              runnerRevoked: false,
            }
          : null;
        if (connectionReads === 1) {
          markLookupStarted();
          await lookupGate;
        }
        return result;
      });
      let tail = Promise.resolve<unknown>(undefined);
      const admissionCalls: ReturnType<typeof createId<"runner">>[] = [];
      const withRunnerAdmission = <Result>(
        admittedRunnerId: ReturnType<typeof createId<"runner">>,
        task: () => Promise<Result> | Result,
      ): Promise<Result> => {
        admissionCalls.push(admittedRunnerId);
        const turn = tail.then(task, task);
        tail = turn.then(
          () => undefined,
          () => undefined,
        );
        return turn;
      };
      const send = vi.fn();
      const store = {
        createGrant: vi.fn(async () => {
          authority = [
            {
              ...callable,
              grant: { ...callable.grant, access: "read" } as IntegrationGrant,
            },
          ];
          return authority[0]!.grant as IntegrationGrant;
        }),
        getComputerConnectionForCall,
        listCallableTools: vi.fn(async () => authority),
        listComputerRunnerIdsForInstallation: vi.fn(async () => [runnerId]),
        listGrants: vi.fn(async () => [callable.grant as IntegrationGrant]),
        listInstallations: vi.fn(async () => [callable.installation]),
        revokeComputerConnection: vi.fn(async () => {
          connected = false;
          authority = [];
          return {
            cancelledRequestIds: [],
            connectionIds: [connection.id],
            removedApps: [],
            requestEvents: [],
            reissuedSetupRequestId: null,
            sessionReset: null,
          };
        }),
        revokeGrant: vi.fn(async () => {
          authority = [];
        }),
        setComputerConnection: vi.fn(async () => {
          connectionAccess = "read";
          authority = [];
          return {
            connection,
            created: false,
            fulfilledRequestIds: [],
            grants: [],
            requestEvents: [],
            reissuedSetupRequestId: null,
            sessionReset: null,
          };
        }),
        uninstall: vi.fn(async () => {
          connected = false;
          authority = [];
          return {
            cancelledRequestIds: [],
            installation: callable.installation,
            removedConnectionIds: [connection.id],
            removedApps: [],
            removedServerIds: [callable.server.id],
            requestEvents: [],
          };
        }),
      };
      const service = platform({
        adapters: [],
        computerApps: {
          appStatus: vi.fn(() => computerStatus()),
          attached: vi.fn(() => true),
          send,
          withRunnerAdmission,
        },
        definitions: [computerDefinition],
        store,
      });
      const call = service.callTool(
        callable,
        {
          text: "hello",
          to: { address: "a@example.test" },
        },
        caller,
      );
      await lookupStarted;
      if (mutation === "revoke") {
        await service.revokeGrant({
          grantId: callable.grant.id,
          ownerUserId: callable.grant.ownerUserId as ReturnType<typeof createId<"user">>,
          requestId: "revoke-race",
          workspaceId: callable.grant.workspaceId as ReturnType<typeof createId<"workspace">>,
        });
      } else if (mutation === "downgrade") {
        await service.createGrant({
          access: "read",
          alias: callable.grant.alias,
          connectionId: callable.grant.connectionId,
          createdBy: callable.grant.ownerUserId as ReturnType<typeof createId<"user">>,
          installationId: callable.installation.id,
          isDefault: true,
          ownerUserId: callable.grant.ownerUserId as ReturnType<typeof createId<"user">>,
          workspaceId: callable.grant.workspaceId as ReturnType<typeof createId<"workspace">>,
        });
      } else if (mutation === "narrow") {
        await service.computerAppApprovals.setComputerConnection({
          kind: "app",
          app: null,
          access: "read",
          actorUserId: callable.grant.ownerUserId as ReturnType<typeof createId<"user">>,
          definitionId: computerDefinition.id,
          isAdministrator: false,
          requestId: "narrow-race",
          runnerId,
        });
      } else if (mutation === "disconnect") {
        await service.computerAppApprovals.disconnectComputerConnection({
          connectionId: callable.grant.connectionId!,
          ownerUserId: callable.grant.ownerUserId as ReturnType<typeof createId<"user">>,
          requestId: "disconnect-race",
        });
      } else {
        await service.uninstallIntegration({
          actorUserId: callable.grant.ownerUserId as ReturnType<typeof createId<"user">>,
          installationId: callable.installation.id,
          requestId: "uninstall-race",
        });
      }
      releaseLookup();

      await expect(call).rejects.toBeInstanceOf(IntegrationAuthorizationRequiredError);
      expect(send).not.toHaveBeenCalled();
      expect(admissionCalls).toContain(runnerId);
    },
  );
});

describe("IntegrationPlatformService computer discovery", () => {
  it.each([
    [
      false,
      false,
      null,
      "INTEGRATION_UNAVAILABLE",
      "Studio Mac is offline. Apple Messages will work again when it is back.",
    ],
    [
      true,
      false,
      null,
      "INTEGRATION_UNAVAILABLE",
      "Opensteer's integrations service is unavailable on Studio Mac.",
    ],
    [
      true,
      true,
      computerStatus({
        detail: "Messages needs Full access.",
        remedy: "full-disk-access",
        state: "permission-required",
      }),
      "INTEGRATION_UNAVAILABLE",
      "Messages needs Full access on Studio Mac.",
    ],
    [true, true, computerStatus(), "READY", null],
  ] as const)(
    "overlays connected=%s attached=%s status=%o without removing tools",
    async (runnerConnected, attached, status, expectedCode, expectedDetail) => {
      const callable = computerCallable("read");
      const runnerId = createId("runner");
      const connectionId = callable.grant.connectionId!;
      const readiness = {
        code: "READY" as const,
        connectionId,
        detail: null,
        provider: null,
        requiredAccess: null,
        serverId: callable.server.id,
      };
      const inventory = [
        {
          accounts: [
            { access: "read" as const, account: "Studio Mac", connectionId, isDefault: true },
          ],
          installation: callable.installation,
          readiness: {
            servers: [readiness],
            tools: [{ readiness, toolId: callable.tool.id }],
          },
          servers: [callable.server],
          skills: [],
          tools: [callable.tool],
        },
      ];
      const service = platform({
        adapters: [],
        isRunnerConnected: vi.fn(() => runnerConnected),
        computerApps: {
          appStatus: vi.fn(() => status),
          attached: vi.fn(() => attached),
          send: vi.fn(),
          withRunnerAdmission: vi.fn(),
        },
        store: {
          getComputerConnectionForCall: vi.fn(async () => ({
            access: "read" as const,
            connection: {
              ...computerConnectionSummary("read"),
              computer: {
                blockedAt: null,
                policyRevision: null,
                access: "read" as const,
                app: null,
                runnerId,
              },
              id: connectionId,
            },
            runnerId,
            runnerName: "Studio Mac",
            deviceProfile: null,
            runnerRevoked: false,
          })),
          listDiscoveryInventory: vi.fn(async () => inventory),
        },
      });

      const [entry] = await service.listDiscoveryInventory({
        ownerUserId: callable.grant.ownerUserId as ReturnType<typeof createId<"user">>,
        threadId: createId("thread"),
        workspaceId: createId("workspace"),
      });
      expect(entry?.readiness.servers[0]).toMatchObject({
        code: expectedCode,
        detail: expectedDetail,
      });
      expect(entry?.readiness.tools[0]?.readiness).toMatchObject({
        code: expectedCode,
        detail: expectedDetail,
      });
      expect(entry?.tools).toEqual([callable.tool]);
      expect(entry?.accounts[0]?.account).toBe("Studio Mac");
    },
  );

  it("keeps send ready when reading needs permission and keeps the server ready", async () => {
    const callable = computerCallable("read");
    const connectionId = callable.grant.connectionId!;
    const runnerId = createId("runner");
    if (!isComputerAppDefinition(computerDefinition))
      throw new Error("Computer definition invalid");
    const sendTool = listedTool(
      computerAppTools(computerDefinition, "read-write", connectionId).find(
        ({ name }) => name === "send_message",
      )!,
    );
    const readiness = {
      code: "READY" as const,
      connectionId,
      detail: null,
      provider: null,
      requiredAccess: null,
      serverId: callable.server.id,
    };
    const readBlocked = computerStatus({
      detail: "Messages needs Full access.",
      remedy: "full-disk-access",
      state: "permission-required",
    });
    const mixedStatus: MachineAppStatus = {
      ...readBlocked,
      operations: readBlocked.operations.map((operation) =>
        operation.operation === "send_message"
          ? { detail: null, operation: operation.operation, remedy: null, state: "ready" }
          : operation,
      ),
    };
    const service = platform({
      adapters: [],
      computerApps: {
        appStatus: vi.fn(() => mixedStatus),
        attached: vi.fn(() => true),
        send: vi.fn(),
        withRunnerAdmission: vi.fn(),
      },
      definitions: [computerDefinition],
      store: {
        getComputerConnectionForCall: vi.fn(async () => ({
          access: "read-write" as const,
          connection: {
            ...computerConnectionSummary("read-write"),
            computer: {
              blockedAt: null,
              policyRevision: null,
              access: "read-write" as const,
              app: null,
              runnerId,
            },
            id: connectionId,
          },
          runnerId,
          runnerName: "Studio Mac",
          deviceProfile: null,
          runnerRevoked: false,
        })),
        listDiscoveryInventory: vi.fn(async () => [
          {
            accounts: [
              {
                access: "read-write" as const,
                account: "Studio Mac",
                connectionId,
                isDefault: true,
              },
            ],
            installation: callable.installation,
            readiness: {
              servers: [readiness],
              tools: [
                { readiness, toolId: callable.tool.id },
                { readiness, toolId: sendTool.id },
              ],
            },
            servers: [callable.server],
            skills: [],
            tools: [callable.tool, { ...sendTool, serverId: callable.server.id }],
          },
        ]),
      },
    });

    const [entry] = await service.listDiscoveryInventory({
      ownerUserId: callable.grant.ownerUserId as ReturnType<typeof createId<"user">>,
      threadId: createId("thread"),
      workspaceId: createId("workspace"),
    });
    expect(entry?.readiness.servers[0]?.code).toBe("READY");
    expect(entry?.readiness.tools).toEqual([
      {
        readiness: expect.objectContaining({
          code: "INTEGRATION_UNAVAILABLE",
          detail: "Messages needs Full access on Studio Mac.",
        }),
        toolId: callable.tool.id,
      },
      { readiness, toolId: sendTool.id },
    ]);
  });

  it("keeps send unavailable when the attached computer does not report the app", async () => {
    const callable = computerCallable("write");
    const connectionId = callable.grant.connectionId!;
    const runnerId = createId("runner");
    const readiness = {
      code: "READY" as const,
      connectionId,
      detail: null,
      provider: null,
      requiredAccess: null,
      serverId: callable.server.id,
    };
    const service = platform({
      adapters: [],
      computerApps: {
        appStatus: vi.fn(() => null),
        attached: vi.fn(() => true),
        send: vi.fn(),
        withRunnerAdmission: vi.fn(),
      },
      definitions: [computerDefinition],
      store: {
        getComputerConnectionForCall: vi.fn(async () => ({
          access: "read-write" as const,
          connection: {
            ...computerConnectionSummary("read-write"),
            computer: {
              blockedAt: null,
              policyRevision: null,
              access: "read-write" as const,
              app: null,
              runnerId,
            },
            id: connectionId,
          },
          runnerId,
          runnerName: "Studio Mac",
          deviceProfile: null,
          runnerRevoked: false,
        })),
        listDiscoveryInventory: vi.fn(async () => [
          {
            accounts: [
              {
                access: "read-write" as const,
                account: "Studio Mac",
                connectionId,
                isDefault: true,
              },
            ],
            installation: callable.installation,
            readiness: {
              servers: [readiness],
              tools: [{ readiness, toolId: callable.tool.id }],
            },
            servers: [callable.server],
            skills: [],
            tools: [callable.tool],
          },
        ]),
      },
    });

    const [entry] = await service.listDiscoveryInventory({
      ownerUserId: callable.grant.ownerUserId as ReturnType<typeof createId<"user">>,
      threadId: createId("thread"),
      workspaceId: createId("workspace"),
    });
    expect(entry?.readiness.servers[0]).toMatchObject({
      code: "INTEGRATION_UNAVAILABLE",
      detail: "Apple Messages is unavailable on Studio Mac.",
    });
    expect(entry?.readiness.tools[0]?.readiness).toMatchObject({
      code: "INTEGRATION_UNAVAILABLE",
      detail: "Apple Messages is unavailable on Studio Mac.",
    });
  });

  /*
   * A phone's readiness is said from its state, in a sentence about the phone:
   * never the phone's own "Paused on the phone" with " on Pixel 7" bolted on,
   * and never as an app that will work again on a computer.
   */

  it("preserves an access requirement while the computer is offline", async () => {
    const callable = computerCallable("write");
    const connectionId = callable.grant.connectionId!;
    const readiness = {
      code: "ACCESS_GRANT_REQUIRED" as const,
      connectionId,
      detail: null,
      provider: null,
      requiredAccess: "read-write" as const,
      serverId: callable.server.id,
    };
    const getComputerConnectionForCall = vi.fn();
    const service = platform({
      adapters: [],
      computerApps: {
        appStatus: vi.fn(() => null),
        attached: vi.fn(() => false),
        send: vi.fn(),
        withRunnerAdmission: vi.fn(),
      },
      store: {
        getComputerConnectionForCall,
        listDiscoveryInventory: vi.fn(async () => [
          {
            accounts: [
              {
                access: "read-write" as const,
                account: "Studio Mac",
                connectionId,
                isDefault: true,
              },
            ],
            installation: callable.installation,
            readiness: {
              servers: [readiness],
              tools: [{ readiness, toolId: callable.tool.id }],
            },
            servers: [callable.server],
            skills: [],
            tools: [callable.tool],
          },
        ]),
      },
    });

    const [entry] = await service.listDiscoveryInventory({
      ownerUserId: callable.grant.ownerUserId as ReturnType<typeof createId<"user">>,
      threadId: createId("thread"),
      workspaceId: createId("workspace"),
    });
    expect(entry?.readiness.servers).toEqual([readiness]);
    expect(entry?.readiness.tools).toEqual([{ readiness, toolId: callable.tool.id }]);
    expect(getComputerConnectionForCall).not.toHaveBeenCalled();
  });

  it("makes an operation unavailable when the Runner omits its readiness", async () => {
    const callable = computerCallable("write");
    const connectionId = callable.grant.connectionId!;
    const runnerId = createId("runner");
    const readiness = {
      code: "READY" as const,
      connectionId,
      detail: null,
      provider: null,
      requiredAccess: null,
      serverId: callable.server.id,
    };
    const service = platform({
      adapters: [],
      computerApps: {
        appStatus: vi.fn(() => computerStatus(undefined, ["list_conversations", "read_messages"])),
        attached: vi.fn(() => true),
        send: vi.fn(),
        withRunnerAdmission: vi.fn(),
      },
      definitions: [computerDefinition],
      store: {
        getComputerConnectionForCall: vi.fn(async () => ({
          access: "read-write" as const,
          connection: {
            ...computerConnectionSummary("read-write"),
            computer: {
              blockedAt: null,
              policyRevision: null,
              access: "read-write" as const,
              app: null,
              runnerId,
            },
            id: connectionId,
          },
          runnerId,
          runnerName: "Studio Mac",
          deviceProfile: null,
          runnerRevoked: false,
        })),
        listDiscoveryInventory: vi.fn(async () => [
          {
            accounts: [
              {
                access: "read-write" as const,
                account: "Studio Mac",
                connectionId,
                isDefault: true,
              },
            ],
            installation: callable.installation,
            readiness: {
              servers: [readiness],
              tools: [{ readiness, toolId: callable.tool.id }],
            },
            servers: [callable.server],
            skills: [],
            tools: [callable.tool],
          },
        ]),
      },
    });

    const [entry] = await service.listDiscoveryInventory({
      ownerUserId: callable.grant.ownerUserId as ReturnType<typeof createId<"user">>,
      threadId: createId("thread"),
      workspaceId: createId("workspace"),
    });
    expect(entry?.readiness.servers[0]?.code).toBe("INTEGRATION_UNAVAILABLE");
    expect(entry?.readiness.tools[0]?.readiness.code).toBe("INTEGRATION_UNAVAILABLE");
  });

  it("does not make a read-only connection ready from an unexposed send operation", async () => {
    const callable = computerCallable("read");
    const connectionId = callable.grant.connectionId!;
    const runnerId = createId("runner");
    const readiness = {
      code: "READY" as const,
      connectionId,
      detail: null,
      provider: null,
      requiredAccess: null,
      serverId: callable.server.id,
    };
    const service = platform({
      adapters: [],
      computerApps: {
        appStatus: vi.fn(() =>
          computerStatus({
            detail: "Messages needs Full access.",
            remedy: "full-disk-access",
            state: "permission-required",
          }),
        ),
        attached: vi.fn(() => true),
        send: vi.fn(),
        withRunnerAdmission: vi.fn(),
      },
      definitions: [computerDefinition],
      store: {
        getComputerConnectionForCall: vi.fn(async () => ({
          access: "read" as const,
          connection: {
            ...computerConnectionSummary("read"),
            computer: {
              blockedAt: null,
              policyRevision: null,
              access: "read" as const,
              app: null,
              runnerId,
            },
            id: connectionId,
          },
          runnerId,
          runnerName: "Studio Mac",
          deviceProfile: null,
          runnerRevoked: false,
        })),
        listDiscoveryInventory: vi.fn(async () => [
          {
            accounts: [
              { access: "read" as const, account: "Studio Mac", connectionId, isDefault: true },
            ],
            installation: callable.installation,
            readiness: {
              servers: [readiness],
              tools: [{ readiness, toolId: callable.tool.id }],
            },
            servers: [callable.server],
            skills: [],
            tools: [callable.tool],
          },
        ]),
      },
    });

    const [entry] = await service.listDiscoveryInventory({
      ownerUserId: callable.grant.ownerUserId as ReturnType<typeof createId<"user">>,
      threadId: createId("thread"),
      workspaceId: createId("workspace"),
    });
    expect(entry?.readiness.servers[0]).toMatchObject({
      code: "INTEGRATION_UNAVAILABLE",
      detail: "Messages needs Full access on Studio Mac.",
    });
    expect(entry?.readiness.tools[0]?.readiness).toMatchObject({
      code: "INTEGRATION_UNAVAILABLE",
      detail: "Messages needs Full access on Studio Mac.",
    });
  });
});

describe("IntegrationPlatformService adapter invocation", () => {
  it("discovers authenticated GraphQL tools for only the exact connection definition", async () => {
    const ownerUserId = createId("user");
    const connectionId = createIntegrationId("connection");
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    const definition = IntegrationDefinitionSchema.parse({
      adapter: "graphql",
      authMethods: [
        {
          id: "api-key",
          inputs: [{ label: "API key", secret: true, variable: "apiKey" }],
          kind: "api-key",
          label: "API key",
          placements: [
            { carrier: "header", name: "Authorization", prefix: "Bearer ", variable: "apiKey" },
          ],
        },
      ],
      config: {
        endpoint: "https://api.example.test/graphql",
      },
      description: "Authenticated GraphQL test integration",
      id: "issues-graphql",
      name: "Issues GraphQL",
      provider: "issues",
    });
    const resolveTools = vi.fn(async () => ({
      definitions: {},
      tools: [
        {
          description: "List issues",
          inputSchema: { type: "object" },
          name: "query.issues",
        },
      ],
    }));
    const reconcileProviderConnectionTools = vi.fn(async () => undefined);
    const service = platform({
      adapters: [
        {
          ...adapterWithInvoke(async () => ({ kind: "ok", value: {} })),
          resolveTools,
        },
      ],
      definitions: [definition],
      materializeForAdapter: vi.fn(async () => ({
        authMethodId: "api-key",
        connectionMethod: "managed-oauth" as const,
        credentialGeneration: 1,
        credentialValues: { apiKey: "secret" },
        definitionId: definition.id,
        grantedScopes: [],
        provider: definition.provider,
      })),
      store: {
        listInstallations: vi.fn(async () => [
          {
            createdAt: now,
            description: definition.description,
            id: installationId,
            manifest: { definition: integrationDefinitionSummary(definition) },
            name: definition.id,
            provenance: { definitionId: definition.id },
            revision: 1,
            sourceKind: "built-in",
            status: "active",
            title: definition.name,
            trust: "built-in",
            updatedAt: now,
            version: "1",
          } satisfies IntegrationInstallation,
        ]),
        listServers: vi.fn(async () => [
          {
            connectionRequirement: {
              definitionId: definition.id,
              kind: "provider",
              provider: definition.provider,
              providerApplicationRequired: false,
            },
            id: serverId,
            installationId,
            name: "default",
            status: "active",
            statusDetail: null,
            toolGeneration: 1,
            transport: { adapter: "graphql", definitionId: definition.id, type: "adapter" },
            updatedAt: now,
          } satisfies IntegrationServer,
        ]),
        reconcileProviderConnectionTools,
      },
    });

    await service.reconcileProviderConnectionTools({ connectionId, ownerUserId });

    expect(resolveTools).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId,
        credentialValues: { apiKey: "secret" },
      }),
    );
    expect(reconcileProviderConnectionTools).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId,
        definitionId: definition.id,
        ownerUserId,
        serverId,
        catalog: {
          definitions: {},
          tools: [expect.objectContaining({ connectionId, name: "query.issues" })],
        },
      }),
    );
  });

  it("maps insufficient scopes into a preset reconnect instruction", async () => {
    const adapter: IntegrationAdapter = {
      credentialDisclosure() {
        return { destinations: ["https://api.example.com"], check: true };
      },
      async checkHealth() {
        return { healthy: true };
      },
      async invokeTool() {
        return {
          code: "oauth_scope_insufficient",
          details: { missingScopes: ["mail.send"] },
          kind: "error",
          message: "scope missing",
        };
      },
      kind: "graphql",
      parseConfig: (config) => config,
      snapshotConfig: async (config) => configObject(config),
      async resolveTools() {
        return { definitions: {}, tools: [] };
      },
    };
    const materializeForAdapter = vi.fn(async () => ({
      authMethodId: "oauth",
      connectionMethod: "managed-oauth" as const,
      credentialGeneration: 1,
      credentialValues: { accessToken: "secret-token" },
      definitionId: "mail",
      grantedScopes: ["mail.read"],
      provider: "mail",
    }));
    const service = platform({ adapters: [adapter], materializeForAdapter });
    const result = (await service.callTool(callable(), {}, caller)) as {
      readonly content: readonly { readonly text: string; readonly type: string }[];
    };
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("Granted scopes: mail.read");
    expect(text).toContain("Reconnect Mail and approve all requested permissions");
    expect(text).not.toContain("secret-token");
  });

  it("reports an unconfirmed adapter write as unknown without a retry", async () => {
    const invokeTool = vi.fn<IntegrationAdapter["invokeTool"]>().mockResolvedValue({
      code: "upstream_timeout",
      details: { outcomeUnknown: true },
      kind: "error",
      message: "Timed out",
    });
    const service = platform({
      adapters: [adapterWithInvoke(invokeTool)],
      materializeForAdapter: async () => materialized,
    });
    const response = await service.callTool(callable(), {}, caller);
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toContain("outcome is unknown");
    expect(invokeTool).toHaveBeenCalledTimes(1);
  });

  it("does not mark a thrown adapter write as retryable", async () => {
    const service = platform({
      adapters: [
        adapterWithInvoke(async () => {
          throw new Error("Connection lost");
        }),
      ],
      materializeForAdapter: async () => materialized,
    });
    await expect(service.callTool(callable(), {}, caller)).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining("outcome is unknown"),
    });
  });

  it("keeps reads retryable after a thrown adapter response", async () => {
    const operation = callable();
    const service = platform({
      adapters: [
        adapterWithInvoke(async () => {
          throw new Error("Connection lost");
        }),
      ],
      materializeForAdapter: async () => materialized,
    });
    await expect(
      service.callTool(
        { ...operation, tool: { ...operation.tool, annotations: { readOnlyHint: true } } },
        {},
        caller,
      ),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("force-refreshes once after a 401 and invokes only one retry", async () => {
    const invokeTool = vi
      .fn<IntegrationAdapter["invokeTool"]>()
      .mockResolvedValueOnce({
        code: "upstream_http_error",
        details: { status: 401 },
        kind: "error",
        message: "expired",
      })
      .mockResolvedValueOnce({ kind: "ok", value: { recovered: true } });
    const materializeForAdapter = vi.fn(async (input: { readonly forceRefresh?: boolean }) => ({
      authMethodId: "oauth",
      connectionMethod: "managed-oauth" as const,
      credentialGeneration: 1,
      credentialValues: { accessToken: input.forceRefresh ? "new-token" : "old-token" },
      definitionId: "mail",
      grantedScopes: ["mail.send"],
      provider: "mail",
    }));
    const service = platform({
      adapters: [adapterWithInvoke(invokeTool)],
      materializeForAdapter,
    });

    const result = await service.callTool(callable(), {}, caller);
    expect(result.structuredContent).toEqual({ recovered: true });
    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(materializeForAdapter).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ forceRefresh: true }),
    );
  });

  it("sends the agent to reauthorization when the 401 refresh proves the grant is dead", async () => {
    const invokeTool = vi.fn<IntegrationAdapter["invokeTool"]>().mockResolvedValue({
      code: "upstream_http_error",
      details: { status: 401 },
      kind: "error",
      message: "expired",
    });
    const materializeForAdapter = vi.fn(async (input: { readonly forceRefresh?: boolean }) => {
      if (input.forceRefresh) {
        throw new OpensteerError({ code: "conflict", message: "Reauthorization required" });
      }
      return {
        authMethodId: "oauth",
        connectionMethod: "managed-oauth" as const,
        credentialGeneration: 1,
        credentialValues: { accessToken: "old-token" },
        definitionId: "mail",
        grantedScopes: ["mail.send"],
        provider: "mail",
      };
    });
    const markAdapterAuthorizationRequired = vi.fn(async () => undefined);
    const service = platform({
      adapters: [adapterWithInvoke(invokeTool)],
      markAdapterAuthorizationRequired,
      materializeForAdapter,
    });

    await expect(service.callTool(callable(), {}, caller)).rejects.toBeInstanceOf(
      IntegrationAuthorizationRequiredError,
    );
    // The refresh already marked the connection; a second marking would claim evidence it lacks.
    expect(markAdapterAuthorizationRequired).not.toHaveBeenCalled();
  });

  it("surfaces a transient 401 refresh failure instead of the upstream rejection", async () => {
    const invokeTool = vi.fn<IntegrationAdapter["invokeTool"]>().mockResolvedValue({
      code: "upstream_http_error",
      details: { status: 401 },
      kind: "error",
      message: "expired",
    });
    const materializeForAdapter = vi.fn(async (input: { readonly forceRefresh?: boolean }) => {
      if (input.forceRefresh) {
        throw new OpensteerError({
          code: "workspace_unavailable",
          message: "The provider token refresh did not complete; this may be temporary — retry.",
          retryable: true,
        });
      }
      return {
        authMethodId: "oauth",
        connectionMethod: "managed-oauth" as const,
        credentialGeneration: 1,
        credentialValues: { accessToken: "old-token" },
        definitionId: "mail",
        grantedScopes: ["mail.send"],
        provider: "mail",
      };
    });
    const markAdapterAuthorizationRequired = vi.fn(async () => undefined);
    const service = platform({
      adapters: [adapterWithInvoke(invokeTool)],
      markAdapterAuthorizationRequired,
      materializeForAdapter,
    });

    await expect(service.callTool(callable(), {}, caller)).rejects.toMatchObject({
      code: "workspace_unavailable",
      message: expect.stringContaining("may be temporary"),
      retryable: true,
    });
    expect(markAdapterAuthorizationRequired).not.toHaveBeenCalled();
  });

  it("refuses an operation rematerialized since its toolRef before credentials or execution", async () => {
    for (const invocation of [
      null,
      { ...mailInvocation, schemaDigest: "b".repeat(43) },
      { ...mailInvocation, status: "disabled" as const },
      { ...mailInvocation, installationRevision: 2 },
      { ...mailInvocation, toolGeneration: 2 },
    ]) {
      const invokeTool = vi.fn<IntegrationAdapter["invokeTool"]>();
      const materializeForAdapter = vi.fn();
      const service = platform({
        adapters: [adapterWithInvoke(invokeTool)],
        materializeForAdapter,
        store: { getToolInvocation: vi.fn(async () => invocation) },
      });

      await expect(
        service.callTool(callable(), { unexpected: true }, caller),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "Integration operation changed; search and describe it again",
      });
      expect(materializeForAdapter).not.toHaveBeenCalled();
      expect(invokeTool).not.toHaveBeenCalled();
    }
  });
});

describe("IntegrationPlatformService proposals", () => {
  const inlineSpec = JSON.stringify({
    info: { title: "Proposed API", version: "1.0.0" },
    openapi: "3.1.0",
    paths: { "/widgets": { get: { operationId: "widgets.list", responses: { 200: {} } } } },
    servers: [{ url: "https://api.example.test" }],
  });

  it("auto-detects inline OpenAPI and returns the pinned preview", async () => {
    const service = platform({ adapters: [openApiAdapter] });
    const outcome = await service.propose({ source: inlineSpec });
    if (outcome.status !== "supported") throw new Error("Inline OpenAPI must be supported");
    expect(outcome).toMatchObject({
      manifest: {
        authMethods: ["none"],
        kind: "openapi",
        preview: { operationCount: 1, title: "Proposed API" },
        source: { type: "inline" },
      },
      selectedAuth: "none",
    });
    expect(outcome).not.toHaveProperty("authNote");
    expect(outcome.manifest.digest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("refuses an OAuth-only OpenAPI document and names catalog alternatives instead", async () => {
    const service = platform({
      adapters: [openApiAdapter],
      definitions: [
        catalogDefinition({ id: "spotify-rest", provider: "spotify" }),
        catalogDefinition({ id: "linear", provider: "linear" }),
      ],
    });
    const outcome = await service.propose({
      source: JSON.stringify({
        components: {
          securitySchemes: {
            oauth: { flows: { authorizationCode: {} }, type: "oauth2" },
          },
        },
        info: { title: "Spotify", version: "1.0.0" },
        openapi: "3.1.0",
        paths: { "/tracks": { get: { operationId: "tracks.list", responses: { 200: {} } } } },
        servers: [{ url: "https://api.spotify.com/v1" }],
      }),
    });

    expect(outcome).toEqual({
      catalogAlternatives: ["spotify-rest"],
      detectedAuth: "oauth",
      reason: expect.stringContaining("OAuth-only APIs need a catalog definition"),
      status: "unsupported",
    });
  });

  it("reads a capitalized HTTP bearer scheme as an API credential", async () => {
    const service = platform({ adapters: [openApiAdapter] });
    const outcome = await service.propose({
      source: JSON.stringify({
        components: { securitySchemes: { token: { scheme: "Bearer", type: "http" } } },
        info: { title: "Capital API", version: "1.0.0" },
        openapi: "3.1.0",
        paths: { "/widgets": { get: { operationId: "widgets.list", responses: { 200: {} } } } },
        servers: [{ url: "https://api.example.test" }],
      }),
    });
    if (outcome.status !== "supported") throw new Error("A bearer document must be supported");

    expect(outcome.selectedAuth).toBe("api-key");
    expect(outcome.manifest.authMethods).toEqual(["api-key"]);
  });

  it("follows a local $ref to the scheme it names", async () => {
    const service = platform({ adapters: [openApiAdapter] });
    const outcome = await service.propose({
      source: JSON.stringify({
        components: {
          schemas: { BearerToken: { scheme: "bearer", type: "http" } },
          securitySchemes: { token: { $ref: "#/components/schemas/BearerToken" } },
        },
        info: { title: "Referenced API", version: "1.0.0" },
        openapi: "3.1.0",
        paths: { "/widgets": { get: { operationId: "widgets.list", responses: { 200: {} } } } },
        servers: [{ url: "https://api.example.test" }],
      }),
    });
    if (outcome.status !== "supported") throw new Error("A referenced scheme must be supported");

    expect(outcome.selectedAuth).toBe("api-key");
    expect(outcome.manifest.authMethods).toEqual(["api-key"]);
  });

  /**
   * Reading an unresolvable scheme as "no authentication" is what installs an
   * integration that can never authenticate a call, so detection fails closed.
   */
  it("refuses a document whose security scheme cannot be resolved", async () => {
    const service = platform({ adapters: [openApiAdapter] });
    const outcome = await service.propose({
      source: JSON.stringify({
        components: { securitySchemes: { token: { $ref: "#/components/schemas/Missing" } } },
        info: { title: "Dangling API", version: "1.0.0" },
        openapi: "3.1.0",
        paths: { "/widgets": { get: { operationId: "widgets.list", responses: { 200: {} } } } },
        servers: [{ url: "https://api.example.test" }],
      }),
    });

    expect(outcome).toEqual({
      catalogAlternatives: [],
      detectedAuth: "unrecognized",
      reason: expect.stringContaining('security scheme "token"'),
      status: "unsupported",
    });
  });

  it("refuses a document declaring a credential kind it cannot carry", async () => {
    const service = platform({ adapters: [openApiAdapter] });
    const outcome = await service.propose({
      source: JSON.stringify({
        components: { securitySchemes: { login: { scheme: "basic", type: "http" } } },
        info: { title: "Basic API", version: "1.0.0" },
        openapi: "3.1.0",
        paths: { "/widgets": { get: { operationId: "widgets.list", responses: { 200: {} } } } },
        servers: [{ url: "https://api.example.test" }],
      }),
    });

    expect(outcome).toMatchObject({ detectedAuth: "unrecognized", status: "unsupported" });
  });

  /**
   * The approval card's payload column is bounded and the document is not, so a
   * document that inspects cleanly must never fail when its Request is stored.
   */
  it("keeps the stored summary of an enormous document inside the Request payload bound", async () => {
    const service = platform({ adapters: [openApiAdapter] });
    const paths = Object.fromEntries(
      Array.from({ length: 2_000 }, (_unused, index) => [
        `/widgets/${index}`,
        {
          get: {
            operationId: `widgets.get${index}`,
            responses: { 200: {} },
            tags: [`tag-${index}-${"long".repeat(40)}`],
          },
        },
      ]),
    );
    const outcome = await service.propose({
      source: JSON.stringify({
        info: { title: "Enormous API", version: "1.0.0" },
        openapi: "3.1.0",
        paths,
        servers: Array.from({ length: 500 }, (_unused, index) => ({
          url: `https://api-${index}.example.test`,
        })),
      }),
    });
    if (outcome.status !== "supported") throw new Error("A large document must be supported");

    const summary = integrationInstallManifestSummary({
      kind: "proposal",
      proposal: outcome.manifest,
    });
    expect(() => RequestJsonObjectSchema.parse(summary)).not.toThrow();
    expect(summary.kind === "proposal" && summary.proposal.preview).toMatchObject({
      // The counted facts survive whole; only the lists are shortened.
      operationCount: 2_000,
      title: "Enormous API",
      truncated: true,
    });
  });

  it("selects api-key for a dual-auth document and says the OAuth scheme is unused", async () => {
    const service = platform({ adapters: [openApiAdapter] });
    const outcome = await service.propose({
      source: JSON.stringify({
        components: {
          securitySchemes: {
            key: { in: "header", name: "X-Api-Key", type: "apiKey" },
            oauth: { flows: { authorizationCode: {} }, type: "oauth2" },
          },
        },
        info: { title: "Dual API", version: "1.0.0" },
        openapi: "3.1.0",
        paths: { "/widgets": { get: { operationId: "widgets.list", responses: { 200: {} } } } },
        servers: [{ url: "https://api.example.test" }],
      }),
    });
    if (outcome.status !== "supported") throw new Error("A dual-auth document must be supported");

    expect(outcome.selectedAuth).toBe("api-key");
    expect(outcome.authNote).toContain("proposals do not support");
    expect(outcome.manifest.authMethods).toEqual(["api-key", "oauth"]);
  });

  it("refuses to install an OAuth-only proposal even when a manifest claims otherwise", async () => {
    const service = platform({ adapters: [openApiAdapter] });
    const oauthOnly = JSON.stringify({
      components: {
        securitySchemes: { oauth: { flows: { authorizationCode: {} }, type: "oauth2" } },
      },
      info: { title: "OAuth Only", version: "1.0.0" },
      openapi: "3.1.0",
      paths: { "/widgets": { get: { operationId: "widgets.list", responses: { 200: {} } } } },
    });

    await expect(
      service.installProposal({
        actorUserId: createId("user"),
        manifest: {
          authMethods: ["oauth"],
          digest: "a".repeat(43),
          kind: "openapi",
          preview: {},
          source: { content: oauthOnly, type: "inline" },
        },
        requestId: "resolve",
      }),
    ).rejects.toThrow("OAuth-only APIs need a catalog definition");
  });

  it("refuses installation when the inspected digest does not match", async () => {
    const service = platform({ adapters: [openApiAdapter] });
    await expect(
      service.installProposal({
        actorUserId: createId("user"),
        manifest: {
          authMethods: ["none"],
          digest: "a".repeat(43),
          kind: "openapi",
          preview: {},
          source: { content: inlineSpec, type: "inline" },
        },
        requestId: "resolve",
      }),
    ).rejects.toThrow("fresh proposal");
  });

  it("installs one immutable private runtime snapshot without publishing executable config", async () => {
    const install = vi.fn(async (input: Parameters<IntegrationPlatformStore["install"]>[0]) => ({
      installation: {
        ...input.installation,
        createdAt: now,
        revision: 1,
        updatedAt: now,
      },
      requestEvents: [],
    }));
    const service = platform({
      adapters: [openApiAdapter],
      store: {
        install,
        listInstallations: vi.fn(async () => []),
        listTools: vi.fn(async () => []),
      },
    });
    const outcome = await service.propose({ source: inlineSpec });
    if (outcome.status !== "supported") throw new Error("Inline OpenAPI must be supported");

    await service.installProposal({
      actorUserId: createId("user"),
      manifest: outcome.manifest,
      requestId: "resolve",
    });

    const stored = install.mock.calls[0]?.[0];
    expect(stored?.adapterSnapshot).toMatchObject({
      adapter: "openapi",
      config: { inline: { paths: { "/widgets": expect.any(Object) } } },
      definitionId: expect.stringMatching(/^proposed-/u),
    });
    expect(stored?.adapterSnapshot).not.toHaveProperty("definition");
    expect(stored?.installation.manifest).not.toHaveProperty("resolvedConfig");
    expect(stored?.installation.manifest.definition).not.toHaveProperty("config");
    const publicProposal = stored?.installation.manifest.proposal as
      { readonly source?: Readonly<Record<string, unknown>> } | undefined;
    expect(publicProposal).toMatchObject({
      source: { type: "inline" },
    });
    expect(publicProposal?.source).not.toHaveProperty("content");
  });

  /**
   * A refused proposal has to say which endpoint failed and why; a generic
   * adapter error left the agent retrying the same unreachable URL forever.
   */
  it("names the GraphQL endpoint and the cause when introspection fails", async () => {
    const service = platform({ adapters: [openApiAdapter] });

    await expect(
      service.propose({ kind: "graphql", source: "https://127.0.0.1/graphql" }),
    ).rejects.toThrow(
      "GraphQL introspection of https://127.0.0.1/graphql failed: Egress destination resolved to a non-public address",
    );
  });

  it("names the MCP endpoint and the cause when the probe fails", async () => {
    const service = platform({ adapters: [openApiAdapter] });

    await expect(service.propose({ kind: "mcp", source: "https://127.0.0.1/mcp" })).rejects.toThrow(
      "MCP probe of https://127.0.0.1/mcp failed:",
    );
  });

  it("reports every attempted kind when auto-detection finds no usable source", async () => {
    const service = platform({ adapters: [openApiAdapter] });

    await expect(service.propose({ source: "https://127.0.0.1/anything" })).rejects.toThrow(
      /https:\/\/127\.0\.0\.1\/anything is not a usable MCP, OpenAPI, or GraphQL integration \(.*mcp:.*openapi:.*graphql:.*\)/su,
    );
  });

  it("gives an installed api-key proposal a posture no administrator has to configure", async () => {
    const install = vi.fn(async (input: Parameters<IntegrationPlatformStore["install"]>[0]) => ({
      installation: { ...input.installation, createdAt: now, revision: 1, updatedAt: now },
      requestEvents: [],
    }));
    const service = platform({
      adapters: [openApiAdapter],
      store: {
        install,
        listInstallations: vi.fn(async () => []),
        listTools: vi.fn(async () => []),
      },
    });
    const outcome = await service.propose({
      source: JSON.stringify({
        components: {
          securitySchemes: { key: { in: "header", name: "X-Api-Key", type: "apiKey" } },
        },
        info: { title: "Keyed API", version: "1.0.0" },
        openapi: "3.1.0",
        paths: { "/widgets": { get: { operationId: "widgets.list", responses: { 200: {} } } } },
        servers: [{ url: "https://api.example.test" }],
      }),
    });
    if (outcome.status !== "supported") throw new Error("An api-key document must be supported");

    const installation = await service.installProposal({
      actorUserId: createId("user"),
      manifest: outcome.manifest,
      requestId: "resolve",
    });

    // A proposal never carries provider identity, so readiness can never reach
    // ADMIN_CONFIGURATION_REQUIRED and the install is never needs-attention.
    expect(installation.status).toBe("active");
    expect(install.mock.calls[0]?.[0].servers[0]).toMatchObject({
      connectionRequirement: {
        definitionId: expect.stringMatching(/^proposed-/u),
        kind: "provider",
        providerApplicationRequired: false,
      },
      status: "active",
    });
  });

  it("re-materializes the same installation identity when one document is proposed twice", async () => {
    const installations: IntegrationInstallation[] = [];
    const install = vi.fn(async (input: Parameters<IntegrationPlatformStore["install"]>[0]) => {
      const installation = {
        ...input.installation,
        createdAt: now,
        revision: installations.length + 1,
        updatedAt: now,
      } satisfies IntegrationInstallation;
      const index = installations.findIndex(({ name }) => name === installation.name);
      if (index === -1) installations.push(installation);
      else installations[index] = installation;
      return { installation, requestEvents: [] };
    });
    const service = platform({
      adapters: [openApiAdapter],
      store: {
        install,
        listInstallations: vi.fn(async () => installations),
        listTools: vi.fn(async () => []),
      },
    });
    const first = await service.propose({ source: inlineSpec });
    const second = await service.propose({ source: inlineSpec });
    if (first.status !== "supported" || second.status !== "supported") {
      throw new Error("Inline OpenAPI must be supported");
    }
    expect(second.manifest.digest).toBe(first.manifest.digest);

    const installed = await service.installProposal({
      actorUserId: createId("user"),
      manifest: first.manifest,
      requestId: "resolve-first",
    });
    const reinstalled = await service.installProposal({
      actorUserId: createId("user"),
      manifest: second.manifest,
      requestId: "resolve-second",
    });

    // The deployment-unique slug is the document digest, so the second approval
    // updates the row rather than colliding with it.
    expect(reinstalled.id).toBe(installed.id);
    expect(reinstalled.name).toBe(installed.name);
    expect(installations).toHaveLength(1);
  });
});

describe("IntegrationPlatformService Request resolution", () => {
  it("refuses a foreign or nonexistent fulfillment connection before resolving", async () => {
    const pending = integrationRequest("integration.access", "pending");
    const connectionId = createIntegrationId("connection");
    const resolveIntegrationAccessRequest = vi.fn();
    const service = platform({
      adapters: [],
      store: {
        getConnectionKind: vi.fn(async () => null),
        requests: {
          get: vi.fn(async () => pending),
          resolveIntegrationAccessRequest,
        } as never,
      },
    });

    await expect(
      service.resolveRequest({
        requestId: pending.id,
        resolvedBy: pending.requestedBy,
        response: { kind: "external", value: { connectionId, decision: "fulfilled" } },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(resolveIntegrationAccessRequest).not.toHaveBeenCalled();
  });

  it("refuses read-write fulfillment through a read-only computer ceiling", async () => {
    const connectionId = createIntegrationId("connection");
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    const base = integrationRequest("integration.access", "pending");
    const pending: Request = {
      ...base,
      payload: {
        access: "read-write",
        installationId,
        kind: "integration.access",
        manifest: null,
        requestedConnectionId: null,
        reason: "Send a message",
        requestedServerId: serverId,
      },
    };
    const resolveIntegrationAccessRequest = vi.fn();
    const service = platform({
      adapters: [],
      computerApps: {
        appStatus: vi.fn(),
        attached: vi.fn(),
        send: vi.fn(),
        withRunnerAdmission: vi.fn(async (_runnerId, task) => task()),
      },
      store: {
        getComputerConnectionForCall: vi.fn(async () => ({
          access: "read" as const,
          connection: computerConnectionSummary("read"),
          runnerId: createId("runner"),
          runnerName: "Studio Mac",
          deviceProfile: null,
          runnerRevoked: false,
        })),
        getConnectionKind: vi.fn(async () => "computer" as const),
        listServers: vi.fn(async () => [
          {
            ...computerCallable().server,
            id: serverId,
            installationId,
          },
        ]),
        requests: {
          get: vi.fn(async () => pending),
          resolveIntegrationAccessRequest,
        } as never,
      },
    });

    await expect(
      service.resolveRequest({
        requestId: pending.id,
        resolvedBy: pending.requestedBy,
        response: { kind: "external", value: { connectionId, decision: "fulfilled" } },
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Studio Mac allows reading only. Allow sending there first.",
    });
    expect(resolveIntegrationAccessRequest).not.toHaveBeenCalled();
  });

  it("routes a server choice as pending access progress", async () => {
    const pending = integrationRequest("integration.access", "pending");
    const requestedServerId = createIntegrationId("server");
    const updated = {
      ...pending,
      payload:
        pending.payload.kind === "integration.access"
          ? { ...pending.payload, requestedServerId }
          : pending.payload,
    };
    const event = { type: "request.updated" } as AgentEvent;
    const selectIntegrationAccessServer = vi.fn(async () => ({
      events: [event],
      request: updated,
    }));
    const resolveIntegrationAccessRequest = vi.fn();
    const installForIntegrationAccessRequest = vi.fn();
    const onWorkspaceEvent = vi.fn();
    const service = platform({
      adapters: [],
      onWorkspaceEvent,
      store: {
        requests: {
          get: vi.fn(async () => pending),
          installForIntegrationAccessRequest,
          resolveIntegrationAccessRequest,
          selectIntegrationAccessServer,
        } as never,
      },
    });

    await expect(
      service.resolveRequest({
        requestId: pending.id,
        resolvedBy: pending.requestedBy,
        response: { kind: "choice", optionId: `server:${requestedServerId}` },
      }),
    ).resolves.toMatchObject({
      grant: null,
      installation: null,
      request: { id: pending.id, status: "pending" },
    });
    expect(selectIntegrationAccessServer).toHaveBeenCalledWith({
      requestId: pending.id,
      requestedServerId,
      resolvedBy: pending.requestedBy,
    });
    expect(resolveIntegrationAccessRequest).not.toHaveBeenCalled();
    expect(installForIntegrationAccessRequest).not.toHaveBeenCalled();
    expect(onWorkspaceEvent).toHaveBeenCalledWith(event);
  });

  it("binds an already reviewed installation without fetching its source again", async () => {
    const base = integrationRequest("integration.access", "pending");
    if (base.payload.kind !== "integration.access") throw new Error("Expected access request");
    const pending = {
      ...base,
      payload: { ...base.payload, installationId: null, manifest: { kind: "proposal" } },
    } satisfies Request;
    const installation: IntegrationInstallation = {
      id: createIntegrationId("installation"),
      name: "reviewed-source",
      title: "Reviewed source",
      description: "Already approved by an administrator",
      sourceKind: "proposed",
      status: "active",
      trust: "administrator-approved",
      version: "reviewed-digest",
      manifest: {},
      provenance: { artifactDigest: "reviewed-digest" },
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const event = { type: "request.updated" } as AgentEvent;
    const loadManifest = vi.fn();
    const install = vi.fn();
    const reuse = vi.fn(async () => ({ installation, request: pending, requestEvents: [event] }));
    const onWorkspaceEvent = vi.fn();
    const service = platform({
      adapters: [],
      onWorkspaceEvent,
      store: {
        listTools: vi.fn(async () => []),
        requests: {
          get: vi.fn(async () => pending),
          tryBindExistingIntegrationAccessInstallation: reuse,
          loadIntegrationAccessInstallManifest: loadManifest,
          installForIntegrationAccessRequest: install,
        } as never,
      },
    });
    await expect(
      service.resolveRequest({
        requestId: pending.id,
        resolvedBy: pending.requestedBy,
        response: { kind: "choice", optionId: "installed" },
      }),
    ).resolves.toMatchObject({ installation, request: { id: pending.id, status: "pending" } });
    expect(reuse).toHaveBeenCalledOnce();
    expect(loadManifest).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(onWorkspaceEvent).toHaveBeenCalledWith(event);
  });

  it("installs a preinstall access choice but keeps the access Request pending", async () => {
    const definition = IntegrationDefinitionSchema.parse({
      adapter: "graphql",
      authMethods: [{ id: "none", kind: "none", label: "No authentication" }],
      config: { endpoint: "https://calendar.example.test/graphql" },
      description: "Requested calendar integration",
      id: "requested-calendar-access",
      name: "Requested Calendar",
      provider: "calendar",
    });
    const manifest = {
      definition: integrationDefinitionSummary(definition),
      digest: integrationDefinitionDigest(definition),
      kind: "catalog" as const,
    };
    const pending = {
      ...integrationRequest("integration.access", "pending"),
      payload: {
        access: "read-write" as const,
        installationId: null,
        kind: "integration.access" as const,
        manifest: RequestJsonObjectSchema.parse(integrationInstallManifestSummary(manifest)),
        reason: "Read and update the calendar",
        requestedConnectionId: null,
        requestedServerId: null,
      },
      presentation: {
        detail: "Read and update the calendar",
        kind: "choice" as const,
        options: [
          { hint: "reject-once" as const, id: "declined", label: "Not now" },
          { hint: "confirm" as const, id: "installed", label: "Install" },
        ],
        risk: "high" as const,
        title: "Install Requested Calendar?",
      },
      requiredActor: "requester" as const,
    } satisfies Request;
    const installEvent = { type: "request.updated" } as AgentEvent;
    const installForIntegrationAccessRequest = vi.fn(
      async (input: { readonly preparedFulfillment?: PreparedIntegrationInstallFulfillment }) => ({
        installation: {
          ...input.preparedFulfillment!.material.installation,
          createdAt: now,
          revision: 1,
          updatedAt: now,
        },
        request: pending,
        requestEvents: [installEvent],
      }),
    );
    const resolveIntegrationAccessRequest = vi.fn();
    const onWorkspaceEvent = vi.fn();
    const service = platform({
      adapters: [adapterWithInvoke(async () => ({ kind: "ok", value: {} }))],
      definitions: [definition],
      onWorkspaceEvent,
      store: {
        listInstallations: vi.fn(async () => []),
        listTools: vi.fn(async () => []),
        requests: {
          get: vi.fn(async () => pending),
          installForIntegrationAccessRequest,
          loadIntegrationAccessInstallManifest: vi.fn(async () => manifest),
          tryBindExistingIntegrationAccessInstallation: vi.fn(async () => null),
          resolveIntegrationAccessRequest,
        } as never,
      },
    });

    const result = await service.resolveRequest({
      requestId: pending.id,
      resolvedBy: pending.requestedBy,
      response: { kind: "choice", optionId: "installed" },
    });

    expect(result).toMatchObject({
      installation: { provenance: { definitionId: definition.id } },
      request: { id: pending.id, response: null, status: "pending" },
    });
    expect(installForIntegrationAccessRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedFulfillment: expect.objectContaining({ approvalManifest: manifest }),
        requestId: pending.id,
        resolvedBy: pending.requestedBy,
      }),
    );
    expect(resolveIntegrationAccessRequest).not.toHaveBeenCalled();
    expect(onWorkspaceEvent).toHaveBeenCalledWith(installEvent);
  });

  it("proves the saved account still works before it tells the agent the account is connected", async () => {
    const connectionId = createIntegrationId("connection");
    const pending = integrationRequest("integration.access", "pending");
    const order: string[] = [];
    const materializeForAdapter = vi
      .fn<IntegrationAdapterCredentialMaterializer["materializeForAdapter"]>()
      .mockImplementation(async () => {
        order.push("verify");
        return materialized;
      });
    const resolveIntegrationAccessRequest = vi.fn(async () => {
      order.push("resolve");
      return {
        events: [{} as AgentEvent],
        grant: null,
        request: { ...pending, resolvedAt: now, status: "fulfilled" as const },
      };
    });
    const service = platform({
      adapters: [],
      materializeForAdapter,
      store: {
        getConnectionKind: vi.fn(async () => "provider-account" as const),
        requests: {
          get: vi.fn(async () => pending),
          resolveIntegrationAccessRequest,
        } as never,
      },
    });

    await service.resolveRequest({
      requestId: pending.id,
      resolvedBy: pending.requestedBy,
      response: { kind: "external", value: { connectionId, decision: "fulfilled" } },
    });

    expect(materializeForAdapter).toHaveBeenCalledWith({
      connectionId,
      operation: "connection.verify",
      ownerUserId: pending.requestedBy,
    });
    expect(order).toEqual(["verify", "resolve"]);
  });

  it("leaves the Request pending when the saved account needs reauthorization", async () => {
    const connectionId = createIntegrationId("connection");
    const pending = integrationRequest("integration.access", "pending");
    const resolveIntegrationAccessRequest = vi.fn();
    const service = platform({
      adapters: [],
      materializeForAdapter: vi
        .fn<IntegrationAdapterCredentialMaterializer["materializeForAdapter"]>()
        .mockRejectedValue(
          new OpensteerError({ code: "conflict", message: "Reauthorization required" }),
        ),
      store: {
        getConnectionKind: vi.fn(async () => "provider-account" as const),
        requests: {
          get: vi.fn(async () => pending),
          resolveIntegrationAccessRequest,
        } as never,
      },
    });

    await expect(
      service.resolveRequest({
        requestId: pending.id,
        resolvedBy: pending.requestedBy,
        response: { kind: "external", value: { connectionId, decision: "fulfilled" } },
      }),
    ).rejects.toMatchObject({ code: "conflict", message: "Reauthorization required" });
    expect(resolveIntegrationAccessRequest).not.toHaveBeenCalled();
  });

  it("leaves the Request pending when account verification is transiently unavailable", async () => {
    const connectionId = createIntegrationId("connection");
    const pending = integrationRequest("integration.access", "pending");
    const resolveIntegrationAccessRequest = vi.fn();
    const service = platform({
      adapters: [],
      materializeForAdapter: vi
        .fn<IntegrationAdapterCredentialMaterializer["materializeForAdapter"]>()
        .mockRejectedValue(
          new OpensteerError({
            code: "workspace_unavailable",
            message: "The provider token refresh did not complete; this may be temporary — retry.",
            retryable: true,
          }),
        ),
      store: {
        getConnectionKind: vi.fn(async () => "provider-account" as const),
        requests: {
          get: vi.fn(async () => pending),
          resolveIntegrationAccessRequest,
        } as never,
      },
    });

    await expect(
      service.resolveRequest({
        requestId: pending.id,
        resolvedBy: pending.requestedBy,
        response: { kind: "external", value: { connectionId, decision: "fulfilled" } },
      }),
    ).rejects.toMatchObject({ code: "workspace_unavailable", retryable: true });
    expect(resolveIntegrationAccessRequest).not.toHaveBeenCalled();
  });

  it("fulfills an MCP OAuth account without materializing a provider credential", async () => {
    const connectionId = createIntegrationId("connection");
    const pending = integrationRequest("integration.access", "pending");
    const materializeForAdapter =
      vi.fn<IntegrationAdapterCredentialMaterializer["materializeForAdapter"]>();
    const resolveIntegrationAccessRequest = vi.fn(async () => ({
      events: [{} as AgentEvent],
      grant: null,
      request: { ...pending, resolvedAt: now, status: "fulfilled" as const },
    }));
    const service = platform({
      adapters: [],
      materializeForAdapter,
      store: {
        getConnectionKind: vi.fn(async () => "mcp-oauth" as const),
        requests: {
          get: vi.fn(async () => pending),
          resolveIntegrationAccessRequest,
        } as never,
      },
    });

    await expect(
      service.resolveRequest({
        requestId: pending.id,
        resolvedBy: pending.requestedBy,
        response: { kind: "external", value: { connectionId, decision: "fulfilled" } },
      }),
    ).resolves.toMatchObject({ request: { status: "fulfilled" } });
    expect(materializeForAdapter).not.toHaveBeenCalled();
    expect(resolveIntegrationAccessRequest).toHaveBeenCalled();
  });

  it("declines an access Request without touching any saved account", async () => {
    const pending = integrationRequest("integration.access", "pending");
    const materializeForAdapter =
      vi.fn<IntegrationAdapterCredentialMaterializer["materializeForAdapter"]>();
    const getConnectionKind = vi.fn(async () => "provider-account" as const);
    const service = platform({
      adapters: [],
      materializeForAdapter,
      store: {
        getConnectionKind,
        requests: {
          get: vi.fn(async () => pending),
          resolveIntegrationAccessRequest: vi.fn(async () => ({
            events: [{} as AgentEvent],
            grant: null,
            request: { ...pending, resolvedAt: now, status: "declined" as const },
          })),
        } as never,
      },
    });

    await service.resolveRequest({
      requestId: pending.id,
      resolvedBy: pending.requestedBy,
      response: { kind: "external", value: { decision: "declined" } },
    });

    expect(getConnectionKind).not.toHaveBeenCalled();
    expect(materializeForAdapter).not.toHaveBeenCalled();
  });

  it("keeps a catalog approval envelope separate from installed metadata", async () => {
    const definition = IntegrationDefinitionSchema.parse({
      adapter: "graphql",
      authMethods: [{ id: "none", kind: "none", label: "No authentication" }],
      config: { endpoint: "https://calendar.example.test/graphql" },
      description: "Requested calendar integration",
      id: "requested-calendar",
      name: "Requested Calendar",
      provider: "calendar",
    });
    const manifest = {
      definition: integrationDefinitionSummary(definition),
      digest: integrationDefinitionDigest(definition),
      kind: "catalog" as const,
    };
    const pending = integrationRequest("integration.install", "pending");
    const event = {} as AgentEvent;
    const resolveIntegrationInstallRequest = vi.fn(
      async (input: { readonly preparedFulfillment?: PreparedIntegrationInstallFulfillment }) => {
        const prepared = input.preparedFulfillment!;
        return {
          events: [event],
          installation: {
            ...prepared.material.installation,
            createdAt: now,
            revision: 1,
            updatedAt: now,
          },
          request: { ...pending, resolvedAt: now, status: "fulfilled" as const },
          requestEvents: [],
        };
      },
    );
    const service = platform({
      adapters: [adapterWithInvoke(async () => ({ kind: "ok", value: {} }))],
      definitions: [definition],
      store: {
        listInstallations: vi.fn(async () => []),
        listTools: vi.fn(async () => []),
        requests: {
          get: vi.fn(async () => pending),
          loadIntegrationInstallManifest: vi.fn(async () => manifest),
          resolveIntegrationInstallRequest,
        } as never,
      },
    });

    await expect(
      service.resolveRequest({
        requestId: pending.id,
        resolvedBy: createId("user"),
        response: { kind: "choice", optionId: "installed" },
      }),
    ).resolves.toMatchObject({
      installation: { manifest: { definition: { id: definition.id } } },
      request: { status: "fulfilled" },
    });

    const prepared = resolveIntegrationInstallRequest.mock.calls[0]?.[0].preparedFulfillment;
    expect(prepared?.approvalManifest).toEqual(manifest);
    expect(prepared?.material.installation.manifest).toEqual({
      definition: integrationDefinitionSummary(definition),
    });
    expect(prepared?.material.installation.manifest).not.toHaveProperty("digest");
    expect(prepared?.material.installation.manifest).not.toHaveProperty("kind");
  });

  it("prepares an installation outside the transaction and atomically resolves the Request", async () => {
    const inlineSpec = JSON.stringify({
      info: { title: "Requested API", version: "1.0.0" },
      openapi: "3.1.0",
      paths: { "/records": { get: { operationId: "records.list", responses: { 200: {} } } } },
      servers: [{ url: "https://api.example.test" }],
    });
    const proposalService = platform({ adapters: [openApiAdapter] });
    const proposed = await proposalService.propose({ source: inlineSpec });
    if (proposed.status !== "supported") throw new Error("Inline OpenAPI must be supported");
    const manifest = { kind: "proposal" as const, proposal: proposed.manifest };
    const pending = integrationRequest("integration.install", "pending");
    const event = {} as AgentEvent;
    const cancelledAccessEvent = { type: "request.cancelled" } as AgentEvent;
    const resolveIntegrationInstallRequest = vi.fn(
      async (input: { readonly preparedFulfillment?: PreparedIntegrationInstallFulfillment }) => {
        const prepared = input.preparedFulfillment!;
        return {
          events: [event],
          installation: {
            ...prepared.material.installation,
            createdAt: now,
            revision: 1,
            updatedAt: now,
          },
          request: { ...pending, resolvedAt: now, status: "fulfilled" as const },
          requestEvents: [cancelledAccessEvent],
        };
      },
    );
    const onWorkspaceEvent = vi.fn();
    const service = platform({
      adapters: [openApiAdapter],
      onWorkspaceEvent,
      store: {
        listInstallations: vi.fn(async () => []),
        listTools: vi.fn(async () => []),
        requests: {
          get: vi.fn(async () => pending),
          loadIntegrationInstallManifest: vi.fn(async () => manifest),
          resolveIntegrationInstallRequest,
        } as never,
      },
    });

    const result = await service.resolveRequest({
      requestId: pending.id,
      resolvedBy: createId("user"),
      response: { kind: "choice", optionId: "installed" },
    });

    expect(result.installation).toMatchObject({ sourceKind: "proposed", status: "active" });
    expect(onWorkspaceEvent).toHaveBeenNthCalledWith(1, cancelledAccessEvent);
    expect(onWorkspaceEvent).toHaveBeenNthCalledWith(2, event);
    expect(resolveIntegrationInstallRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        preparedFulfillment: expect.objectContaining({
          approvalManifest: manifest,
          material: expect.objectContaining({
            adapterSnapshot: expect.objectContaining({ adapter: "openapi" }),
            installation: expect.objectContaining({
              manifest: expect.not.objectContaining({ kind: "proposal" }),
            }),
          }),
        }),
        requestId: pending.id,
        response: { kind: "choice", optionId: "installed" },
      }),
    );
    expect(onWorkspaceEvent).toHaveBeenCalledWith(event);
  });
});

describe("IntegrationPlatformService Main access Request fulfillment", () => {
  it("fulfills a satisfied access Request with the arriving connection and publishes its event", async () => {
    const connectionId = createIntegrationId("connection");
    const tool = callable();
    const pending = integrationRequest("integration.access", "pending");
    const event = {} as AgentEvent;
    const resolveIntegrationAccessRequest = vi.fn(async () => ({
      events: [event],
      grant: null,
      request: { ...pending, resolvedAt: now, status: "fulfilled" as const },
    }));
    const onWorkspaceEvent = vi.fn();
    const service = platform({
      adapters: [],
      materializeForAdapter: vi
        .fn<IntegrationAdapterCredentialMaterializer["materializeForAdapter"]>()
        .mockResolvedValue(materialized),
      onWorkspaceEvent,
      store: {
        getConnectionKind: vi.fn(async () => "provider-account" as const),
        mainAccess: vi.fn(async () => "inherited" as const),
        isConnectionUsableForAccessRequest: vi.fn(async () => true),
        listCallableTools: vi.fn(async () => [
          {
            ...tool,
            grant: { ...tool.grant, connectionId },
          },
        ]),
        listGrantedSkills: vi.fn(async () => []),
        requests: {
          listPendingIntegrationAccessRequests: vi.fn(async () => [
            {
              access: "read",
              installationId: tool.installation.id,
              request: pending,
              requestedServerId: tool.server.id,
            },
          ]),
          resolveIntegrationAccessRequest,
        } as never,
      },
    });

    await expect(
      service.fulfillSatisfiedMainAccessRequests({
        connectionId,
        ownerUserId: pending.requestedBy,
      }),
    ).resolves.toEqual([pending.id]);

    expect(resolveIntegrationAccessRequest).toHaveBeenCalledWith({
      providerAuthorizations: {},
      requestId: pending.id,
      resolvedBy: pending.requestedBy,
      response: { kind: "external", value: { connectionId, decision: "fulfilled" } },
    });
    expect(onWorkspaceEvent).toHaveBeenCalledWith(event);
  });

  it("fulfills a connection-only Request with the exact arriving connection", async () => {
    const connectionId = createIntegrationId("connection");
    const pending = integrationRequest("integration.access", "pending");
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    const resolveIntegrationAccessRequest = vi.fn(async () => ({
      events: [{} as AgentEvent],
      grant: null,
      request: { ...pending, resolvedAt: now, status: "fulfilled" as const },
    }));
    const isConnectionUsableForAccessRequest = vi.fn(async () => true);
    const service = platform({
      adapters: [],
      materializeForAdapter: vi
        .fn<IntegrationAdapterCredentialMaterializer["materializeForAdapter"]>()
        .mockResolvedValue(materialized),
      store: {
        getConnectionKind: vi.fn(async () => "provider-account" as const),
        mainAccess: vi.fn(async () => "inherited" as const),
        isConnectionUsableForAccessRequest,
        requests: {
          listPendingIntegrationAccessRequests: vi.fn(async () => [
            {
              access: "read",
              installationId,
              request: pending,
              requestedConnectionId: connectionId,
              requestedServerId: serverId,
            },
          ]),
          resolveIntegrationAccessRequest,
        } as never,
      },
    });

    await service.fulfillSatisfiedMainAccessRequests({
      connectionId,
      ownerUserId: pending.requestedBy,
    });

    expect(isConnectionUsableForAccessRequest).toHaveBeenCalledWith({
      connectionId,
      installationId,
      ownerUserId: pending.requestedBy,
      providerAuthorizations: {},
      requestedServerId: serverId,
    });
    expect(resolveIntegrationAccessRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        response: { kind: "external", value: { connectionId, decision: "fulfilled" } },
      }),
    );
  });

  it("leaves specialized and unsatisfied Main Requests pending", async () => {
    const connectionId = createIntegrationId("connection");
    const specialized = integrationRequest("integration.access", "pending");
    const unsatisfied = {
      ...integrationRequest("integration.access", "pending"),
      targetWorkspaceId: createId("workspace"),
    };
    const resolveIntegrationAccessRequest = vi.fn();
    const mainAccess = vi.fn(async ({ workspaceId }: { readonly workspaceId: string }) =>
      Promise.resolve(
        workspaceId === unsatisfied.targetWorkspaceId ? ("inherited" as const) : null,
      ),
    );
    const service = platform({
      adapters: [],
      store: {
        mainAccess,
        isConnectionUsableForAccessRequest: vi.fn(async () => false),
        listCallableTools: vi.fn(async () => []),
        listGrantedSkills: vi.fn(async () => []),
        requests: {
          listPendingIntegrationAccessRequests: vi.fn(async () => [
            {
              access: "read",
              installationId: createIntegrationId("installation"),
              request: specialized,
              requestedServerId: null,
            },
            {
              access: "read-write",
              installationId: createIntegrationId("installation"),
              request: unsatisfied,
              requestedServerId: createIntegrationId("server"),
            },
          ]),
          resolveIntegrationAccessRequest,
        } as never,
      },
    });

    await service.fulfillSatisfiedMainAccessRequests({
      connectionId,
      ownerUserId: specialized.requestedBy,
    });

    expect(resolveIntegrationAccessRequest).not.toHaveBeenCalled();
  });

  it("leaves a Main Request pending when the arriving connection fails verification", async () => {
    const connectionId = createIntegrationId("connection");
    const pending = integrationRequest("integration.access", "pending");
    const resolveIntegrationAccessRequest = vi.fn();
    const service = platform({
      adapters: [],
      materializeForAdapter: vi
        .fn<IntegrationAdapterCredentialMaterializer["materializeForAdapter"]>()
        .mockRejectedValue(
          new OpensteerError({ code: "conflict", message: "Reauthorization required" }),
        ),
      store: {
        getConnectionKind: vi.fn(async () => "provider-account" as const),
        mainAccess: vi.fn(async () => "inherited" as const),
        isConnectionUsableForAccessRequest: vi.fn(async () => true),
        requests: {
          listPendingIntegrationAccessRequests: vi.fn(async () => [
            {
              access: "read",
              installationId: createIntegrationId("installation"),
              request: pending,
              requestedServerId: createIntegrationId("server"),
            },
          ]),
          resolveIntegrationAccessRequest,
        } as never,
      },
    });

    await expect(
      service.fulfillSatisfiedMainAccessRequests({
        connectionId,
        ownerUserId: pending.requestedBy,
      }),
    ).resolves.toEqual([]);
    expect(resolveIntegrationAccessRequest).not.toHaveBeenCalled();
  });

  it("silently tolerates a conflict after a satisfied Request races", async () => {
    const connectionId = createIntegrationId("connection");
    const pending = integrationRequest("integration.access", "pending");
    const service = platform({
      adapters: [],
      materializeForAdapter: vi
        .fn<IntegrationAdapterCredentialMaterializer["materializeForAdapter"]>()
        .mockResolvedValue(materialized),
      store: {
        getConnectionKind: vi.fn(async () => "provider-account" as const),
        mainAccess: vi.fn(async () => "inherited" as const),
        isConnectionUsableForAccessRequest: vi.fn(async () => true),
        requests: {
          listPendingIntegrationAccessRequests: vi.fn(async () => [
            {
              access: "read",
              installationId: createIntegrationId("installation"),
              request: pending,
              requestedServerId: createIntegrationId("server"),
            },
          ]),
          resolveIntegrationAccessRequest: vi.fn(async () => {
            throw new OpensteerError({ code: "conflict", message: "Request changed" });
          }),
        } as never,
      },
    });

    await expect(
      service.fulfillSatisfiedMainAccessRequests({
        connectionId,
        ownerUserId: pending.requestedBy,
      }),
    ).resolves.toEqual([]);
  });
});

function catalogDefinition(input: { readonly id: string; readonly provider: string }) {
  return IntegrationDefinitionSchema.parse({
    adapter: "openapi",
    authMethods: [
      {
        id: "api-key",
        inputs: [{ label: "API key", secret: true, variable: "apiKey" }],
        kind: "api-key",
        label: "API key",
        placements: [{ carrier: "header", name: "Authorization", variable: "apiKey" }],
      },
    ],
    config: {},
    description: `${input.provider} catalog preset`,
    id: input.id,
    name: input.provider,
    provider: input.provider,
  });
}

describe("IntegrationPlatformService connection reaction", () => {
  function pendingMainRequest() {
    const pending = integrationRequest("integration.access", "pending");
    const resolveIntegrationAccessRequest = vi.fn(async () => ({
      events: [{} as AgentEvent],
      grant: null,
      request: { ...pending, resolvedAt: now, status: "fulfilled" as const },
    }));
    const requests = {
      listPendingIntegrationAccessRequests: vi.fn(async () => [
        {
          access: "read",
          installationId: createIntegrationId("installation"),
          request: pending,
          requestedServerId: createIntegrationId("server"),
        },
      ]),
      resolveIntegrationAccessRequest,
    };
    return { pending, requests, resolveIntegrationAccessRequest };
  }

  it("discovers a provider connection's tools, then settles the Requests it satisfies", async () => {
    const connectionId = createIntegrationId("connection");
    const { pending, requests, resolveIntegrationAccessRequest } = pendingMainRequest();
    const materializeForAdapter = vi
      .fn<IntegrationAdapterCredentialMaterializer["materializeForAdapter"]>()
      .mockResolvedValue(materialized);
    const service = platform({
      adapters: [],
      materializeForAdapter,
      store: {
        getConnectionKind: vi.fn(async () => "provider-account" as const),
        mainAccess: vi.fn(async () => "inherited" as const),
        isConnectionUsableForAccessRequest: vi.fn(async () => true),
        listInstallations: vi.fn(async () => []),
        requests: requests as never,
      },
    });

    await expect(
      service.connectionConnected({ connectionId, ownerUserId: pending.requestedBy }),
    ).resolves.toEqual([pending.id]);

    expect(materializeForAdapter.mock.calls.map(([call]) => call.operation)).toEqual([
      "schema.discovery",
      "connection.verify",
    ]);
    expect(resolveIntegrationAccessRequest).toHaveBeenCalledOnce();
  });

  it("settles Requests for an MCP connection without provider tool discovery", async () => {
    const connectionId = createIntegrationId("connection");
    const { pending, requests, resolveIntegrationAccessRequest } = pendingMainRequest();
    const materializeForAdapter = vi
      .fn<IntegrationAdapterCredentialMaterializer["materializeForAdapter"]>()
      .mockRejectedValue(new Error("MCP connections carry no adapter credential"));
    const service = platform({
      adapters: [],
      materializeForAdapter,
      store: {
        getConnectionKind: vi.fn(async () => "mcp-oauth" as const),
        mainAccess: vi.fn(async () => "inherited" as const),
        isConnectionUsableForAccessRequest: vi.fn(async () => true),
        requests: requests as never,
      },
    });

    await expect(
      service.connectionConnected({ connectionId, ownerUserId: pending.requestedBy }),
    ).resolves.toEqual([pending.id]);

    expect(materializeForAdapter).not.toHaveBeenCalled();
    expect(resolveIntegrationAccessRequest).toHaveBeenCalledOnce();
  });

  it("settles nothing when the connection's tools cannot be discovered", async () => {
    const connectionId = createIntegrationId("connection");
    const { pending, requests, resolveIntegrationAccessRequest } = pendingMainRequest();
    const service = platform({
      adapters: [],
      materializeForAdapter: vi
        .fn<IntegrationAdapterCredentialMaterializer["materializeForAdapter"]>()
        .mockRejectedValue(new OpensteerError({ code: "conflict", message: "Reconnect" })),
      store: {
        getConnectionKind: vi.fn(async () => "provider-account" as const),
        mainAccess: vi.fn(async () => "inherited" as const),
        isConnectionUsableForAccessRequest: vi.fn(async () => true),
        requests: requests as never,
      },
    });

    await expect(
      service.connectionConnected({ connectionId, ownerUserId: pending.requestedBy }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(resolveIntegrationAccessRequest).not.toHaveBeenCalled();
  });
});

describe("IntegrationPlatformService computer app setup expiry", () => {
  it("publishes replacement and opened events with one continuation wake", async () => {
    const guiDefinitionCandidate = computerAppIntegrations.find(({ id }) => id === "macos-app");
    if (!guiDefinitionCandidate || !isComputerAppDefinition(guiDefinitionCandidate)) {
      throw new Error("The macos-app definition is missing from the catalog.");
    }
    const ownerUserId = createId("user");
    const runnerId = createId("runner");
    const threadId = createId("thread");
    const workspaceId = createId("workspace");
    const runId = createId("run");
    const requestId = createId("request");
    const notes = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null };
    const request = {
      callId: "computer-app-live-event",
      cancellationReason: null,
      createdAt: now,
      id: requestId,
      kind: "computer.app.access",
      mode: "durable",
      originatingOccurrenceId: null,
      originatingRunId: runId,
      originatingThreadId: threadId,
      originatingWorkspaceId: workspaceId,
      payload: {
        access: "read",
        app: notes,
        definitionId: "macos-app",
        kind: "computer.app.access",
        runnerId,
        setupRequestId: "setup-request",
        workspaceId,
      },
      presentation: {
        kind: "external",
        subject: { id: "setup-request", kind: "computer-app-setup" },
        title: "Wants to use Notes",
      },
      requestedBy: ownerUserId,
      requiredActor: "workspace-owner",
      resolvedAt: null,
      resolvedBy: null,
      response: null,
      status: "pending",
      targetWorkspaceId: workspaceId,
    } as Request;
    const openedEvent = {
      createdAt: now,
      data: { request },
      id: createId("event"),
      runId,
      threadId,
      type: "request.opened",
      workspaceId,
    } as unknown as AgentEvent;
    const replacementEvent = {
      createdAt: now,
      data: { requestId: createId("request") },
      id: createId("event"),
      runId,
      threadId,
      type: "request.resolved",
      workspaceId,
    } as unknown as AgentEvent;
    const onWorkspaceEvent = vi.fn();
    const onRequestsChanged = vi.fn();
    const requestComputerAppAccess = vi.fn(async (): Promise<ComputerAppAccessDecision> => ({
      kind: "computer",
      replayed: false,
      request,
      requestEvents: [replacementEvent, openedEvent],
      setupRequest: {} as never,
    }));
    const service = platform({
      adapters: [],
      computerApps: {
        attached: () => true,
        approvalRelayRefusal: () => null,
        relaysComputerAppApprovals: () => true,
        withRunnerAdmission: async (_id, task) => task(),
        appStatus: () => null,
        send: vi.fn(),
      },
      computerUse: {
        eligibleMachines: async (_owner: unknown, definitionId: string) =>
          definitionId === "macos-app"
            ? [{ runnerId, name: "Alex's Mac", state: "ready", ready: true }]
            : [],
        threadTitle: async () => "Read my notes",
        resolveApp: vi.fn(async () => ({
          allowed: true,
          identity: notes,
          path: "/System/Applications/Notes.app",
          reason: null,
          risk: "standard",
          running: false,
        })),
      } as unknown as ComputerUseGateway,
      definitions: [guiDefinitionCandidate],
      onRequestsChanged,
      onWorkspaceEvent,
      store: {
        requestComputerAppAccess,
        getComputerUsePolicy: async () => ({
          appApproval: "ask",
          approvalKeyId: null,
          revision: 0,
        }),
      },
    });

    await service.computerAppApprovals.requestComputerAppAccess({
      reason: "Read my notes",
      access: "read",
      app: "Notes",
      originatingRunId: runId,
      ownerUserId,
      runnerId,
      threadId,
      workspaceId,
    });

    expect(onWorkspaceEvent).toHaveBeenNthCalledWith(1, replacementEvent);
    expect(onWorkspaceEvent).toHaveBeenNthCalledWith(2, openedEvent);
    expect(onRequestsChanged).toHaveBeenCalledOnce();

    requestComputerAppAccess.mockResolvedValueOnce({
      kind: "computer",
      replayed: true,
      request,
      requestEvents: [],
      setupRequest: {} as never,
    });
    await service.computerAppApprovals.requestComputerAppAccess({
      reason: "Read my notes",
      access: "read",
      app: "Notes",
      originatingRunId: runId,
      ownerUserId,
      runnerId,
      threadId,
      workspaceId,
    });
    expect(onWorkspaceEvent).toHaveBeenCalledTimes(2);
    expect(onRequestsChanged).toHaveBeenCalledOnce();
  });

  it.each(["offline", "connecting", "absent", "reported"] as const)(
    "only asks an iPhone for an app it reports: %s",
    async (availability) => {
      const definition = computerAppIntegrations.find(({ id }) => id === "apple-calendar")!;
      const runnerId = createId("runner");
      const requestComputerAppSetup = vi.fn(async () => ({
        request: { id: "setup-request", runnerId } as never,
        settlement: { grants: [], requestEvents: [], requestIds: [] },
      }));
      let insideAdmission = false;
      const reportsApp = vi.fn(() => {
        expect(insideAdmission).toBe(true);
        return availability;
      });
      const service = platform({
        adapters: [],
        definitions: [definition],
        computerApps: {
          appStatus: () => null,
          attached: () => availability !== "offline",
          reportsApp,
          send: vi.fn(),
          withRunnerAdmission: async (_runnerId, task) => {
            insideAdmission = true;
            try {
              return await task();
            } finally {
              insideAdmission = false;
            }
          },
        },
        store: {
          computerAppRunner: async () => ({
            deviceProfile: "iphone",
            publicKeyFingerprint: "phone-key",
          }),
          requestComputerAppSetup,
        },
      });
      const asking = service.computerAppApprovals.requestComputerAppSetup({
        kind: "app",
        app: null,
        access: "read",
        actorUserId: createId("user"),
        definitionId: definition.id,
        runnerId,
      });
      if (availability === "reported") {
        await expect(asking).resolves.toMatchObject({ id: "setup-request" });
        expect(requestComputerAppSetup).toHaveBeenCalledOnce();
      } else {
        const messages = {
          offline: "Open Opensteer on this iPhone and keep it open, then try again.",
          connecting: "Opensteer on this iPhone is still connecting. Try again in a moment.",
          absent:
            "This version of Opensteer on this iPhone doesn't offer Calendar. Update Opensteer on this iPhone.",
        };
        await expect(asking).rejects.toMatchObject({
          code: "conflict",
          message: messages[availability],
        });
        expect(requestComputerAppSetup).not.toHaveBeenCalled();
      }
      expect(reportsApp).toHaveBeenCalledWith(runnerId, definition.id);
    },
  );

  it("publishes request settlements produced by setup replacement and cancellation", async () => {
    const replacementEvent = { type: "request.resolved" } as AgentEvent;
    const cancellationEvent = { type: "request.resolved" } as AgentEvent;
    const requestComputerAppSetup = vi.fn(async () => ({
      request: { id: "setup-request" } as never,
      settlement: {
        grants: [],
        requestEvents: [replacementEvent],
        requestIds: [createId("request")],
      },
    }));
    const cancelComputerAppSetup = vi.fn(async () => ({
      grants: [],
      requestEvents: [cancellationEvent],
      requestIds: [createId("request")],
      runnerId: null,
    }));
    const onWorkspaceEvent = vi.fn();
    const onRequestsChanged = vi.fn();
    const service = platform({
      adapters: [],
      definitions: [computerDefinition],
      onRequestsChanged,
      onWorkspaceEvent,
      store: { cancelComputerAppSetup, requestComputerAppSetup },
    });

    await service.computerAppApprovals.requestComputerAppSetup({
      kind: "app",
      app: null,
      access: "read",
      actorUserId: createId("user"),
      definitionId: computerDefinition.id,
      runnerId: createId("runner"),
    });
    await service.computerAppApprovals.cancelComputerAppSetup({
      ownerUserId: createId("user"),
      requestId: "setup-request",
    });

    expect(onWorkspaceEvent).toHaveBeenNthCalledWith(1, replacementEvent);
    expect(onWorkspaceEvent).toHaveBeenNthCalledWith(2, cancellationEvent);
    expect(onRequestsChanged).toHaveBeenCalledTimes(2);
  });

  it("declines the Requests of approvals nobody answered and delivers their continuations", async () => {
    const requestEvent = {
      createdAt: now,
      data: { requestId: createId("request") },
      id: createId("event"),
      type: "request.declined",
      workspaceId: createId("workspace"),
    } as unknown as AgentEvent;
    const expireComputerAppSetupRequests = vi.fn(async () => ({
      grants: [],
      requestEvents: [requestEvent],
      requestIds: [createId("request")],
      runnerIds: [],
    }));
    const onWorkspaceEvent = vi.fn();
    const onRequestsChanged = vi.fn();
    const onConnectionsChanged = vi.fn();
    const service = platform({
      adapters: [],
      onConnectionsChanged,
      onRequestsChanged,
      onWorkspaceEvent,
      store: { expireComputerAppSetupRequests },
    });

    await service.computerAppApprovals.expireComputerAppSetupRequests();

    expect(expireComputerAppSetupRequests).toHaveBeenCalledOnce();
    expect(onWorkspaceEvent).toHaveBeenCalledWith(requestEvent);
    // The same two a cancel fires: the Thread hears, and the list is stale.
    expect(onRequestsChanged).toHaveBeenCalledOnce();
    expect(onConnectionsChanged).toHaveBeenCalledOnce();
  });

  it("says nothing when no approval had expired", async () => {
    const onRequestsChanged = vi.fn();
    const service = platform({
      adapters: [],
      onRequestsChanged,
      store: {
        expireComputerAppSetupRequests: vi.fn(async () => ({
          grants: [],
          requestEvents: [],
          requestIds: [],
          runnerIds: [],
        })),
      },
    });

    await service.computerAppApprovals.expireComputerAppSetupRequests();

    expect(onRequestsChanged).not.toHaveBeenCalled();
  });
});

describe("IntegrationPlatformService computer use gateway", () => {
  const guiDefinitionCandidate = computerAppIntegrations.find(({ id }) => id === "macos-app");
  if (!guiDefinitionCandidate || !isComputerAppDefinition(guiDefinitionCandidate)) {
    throw new Error("The macos-app definition is missing from the catalog.");
  }
  const guiDefinition = guiDefinitionCandidate;
  const phoneDefinitionCandidate = computerAppIntegrations.find(({ id }) => id === "android-phone");
  if (!phoneDefinitionCandidate || !isComputerAppDefinition(phoneDefinitionCandidate)) {
    throw new Error("The android-phone definition is missing from the catalog.");
  }
  const phoneDefinition = phoneDefinitionCandidate;
  const notes = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null };
  const baseCallable = computerCallable("read");

  function observation(overrides: Record<string, unknown> = {}) {
    return {
      app: notes,
      capturedAt: now,
      elementCount: 2,
      focusChanged: false,
      geometry: { width: 800, height: 600 },
      snapshot: "obs-1",
      windows: [],
      blockedBy: [],
      alone: false,
      screenshot: {
        base64: "AAAA",
        height: 300,
        mime: "image/jpeg" as const,
        width: 400,
      },
      tree: '[0] window "Notes" (0,0 800x600)',
      truncated: false,
      window: {
        ref: "window-1",
        id: 7,
        frame: { height: 600, width: 800, x: 0, y: 0 },
        scale: 2,
        title: "Shopping",
      },
      ...overrides,
    };
  }

  function guiFixture(
    input: {
      readonly connectionAccess?: "read" | "read-write";
      readonly grantAccess?: "read" | "read-write";
      readonly beforeSend?: () => Promise<void>;
      readonly mcpImageContent?: boolean;
      readonly observation?: Record<string, unknown> | null;
      readonly operation?: "act" | "observe";
      /** The whole Android phone "Pixel 7" rather than Notes on "Alex's Mac". */
      readonly phone?: boolean;
      readonly passwords?: ComputerUseServiceOptions["passwords"];
      readonly revoke?: () => void;
      readonly resultError?: ComputerUseError;
      readonly performed?: readonly string[];
      readonly refusal?: ComputerUseError;
      readonly revoked?: () => boolean;
      readonly runnerConnected?: boolean;
      readonly settleRefusal?: ComputerUseError;
    } = {},
  ) {
    const runnerId = createId("runner");
    const definition = input.phone ? phoneDefinition : guiDefinition;
    const installation: IntegrationInstallation = {
      ...baseCallable.installation,
      manifest: {
        ...baseCallable.installation.manifest,
        definition: integrationDefinitionSummary(definition),
      },
      provenance: {
        artifactDigest: null,
        definitionDigest: integrationDefinitionDigest(definition),
        definitionId: definition.id,
        kind: "catalog",
      },
      title: "Computer use",
    };
    const operationName = input.operation ?? "observe";
    const readToolId = createIntegrationId("tool");
    const tool = computerAppTools(definition, "read-write", baseCallable.grant.connectionId!).find(
      ({ name }) => name === operationName,
    );
    if (!tool) throw new Error("The gui definition has no such tool.");
    const callable: CallableIntegrationTool = {
      ...baseCallable,
      grant: {
        ...baseCallable.grant,
        access: input.grantAccess ?? "read-write",
      } as IntegrationGrant,
      installation,
      server: {
        ...baseCallable.server,
        connectionRequirement: { definitionId: definition.id, kind: "computer" },
        transport: { definitionId: definition.id, type: "computer" },
      } as IntegrationServer,
      tool: {
        ...baseCallable.tool,
        ...listedTool(tool),
        id: baseCallable.tool.id,
        serverId: baseCallable.server.id,
      },
    };
    const connection = {
      ...computerConnectionSummary(input.connectionAccess ?? "read-write"),
      computer: {
        blockedAt: null,
        policyRevision: null,
        access: input.connectionAccess ?? "read-write",
        app: input.phone ? null : notes,
        runnerId,
      },
      definitionId: definition.id,
      id: callable.grant.connectionId!,
    };
    let admitted = false;
    const prepared: boolean[] = [];
    const dispatch = async () => {
      // The frame has to leave inside the turn that re-read the authority.
      expect(admitted).toBe(true);
      if (input.refusal) throw input.refusal;
      return {
        sessionId: mintComputerUseSessionId(),
        settle: async () => {
          if (input.settleRefusal) throw input.settleRefusal;
          return {
            error: input.resultError ?? null,
            kind: input.phone ? ("display" as const) : ("app" as const),
            observation:
              operationName === "act" && !input.phone
                ? null
                : input.observation === null
                  ? null
                  : input.phone
                    ? {
                        capturedAt: now,
                        elementCount: 2,
                        foreground: null,
                        geometry: { width: 400, height: 300 },
                        locked: false,
                        observationId: "obs-1",
                        rotation: 0,
                        screen: "on" as const,
                        screenshot: null,
                        screenshotUnavailable: "failed" as const,
                        secureLock: false,
                        tree: "phone",
                        truncated: false,
                      }
                    : observation(input.observation ?? {}),
            performed: operationName === "act" ? (input.performed ?? []) : null,
          };
        },
      };
    };
    const lease = { sessionId: mintComputerUseSessionId() };
    const mockedComputerUse = {
      closeForConnection: vi.fn(),
      eligibleMachines: vi.fn(async () => []),
      installedApps: vi.fn(async () => []),
      // The Thread's name and the Run's state are read here, so this has to
      // happen before the Mac's admission turn, never inside it.
      prepare: vi.fn(async () => {
        prepared.push(admitted);
        return lease;
      }),
      release: vi.fn(),
      resolveApp: vi.fn(),
      sendAct: vi.fn(async (...[, , , , , admit]: Parameters<ComputerUseGateway["sendAct"]>) =>
        admit ? admit(dispatch) : dispatch(),
      ),
      sendObserve: vi.fn(dispatch),
      sendWindowOperation: vi.fn(async (_lease, _target, operation) =>
        operation === "bind"
          ? {
              sessionId: lease.sessionId,
              settle: async () => ({
                kind: "app" as const,
                error: null,
                observation: null,
                performed: null,
                window: {
                  ref: "window-1",
                  id: 7,
                  title: "Shopping",
                  focused: true,
                  main: true,
                  minimized: false,
                  onScreen: true,
                  modal: false,
                  current: true,
                  frame: { x: 0, y: 0, width: 800, height: 600 },
                },
              }),
            }
          : {
              sessionId: lease.sessionId,
              settle: async () => {
                if (input.settleRefusal) throw input.settleRefusal;
                return {
                  kind: "app" as const,
                  error: null,
                  observation: observation(input.observation ?? {}),
                  performed: null,
                };
              },
            },
      ),
      stop: vi.fn(),
    } as unknown as ComputerUseGateway;
    const queue = new MutationQueue();
    const sent: unknown[] = [];
    const computerApps = {
      appStatus: vi.fn(() => null),
      attached: vi.fn(() => true),
      send: vi.fn(async () => {
        throw new Error("A gui tool never reaches the invoke path.");
      }),
      withRunnerAdmission: async <Result>(
        _runnerId: Parameters<ComputerAppHub["withRunnerAdmission"]>[0],
        task: () => Promise<Result> | Result,
      ): Promise<Result> =>
        queue.run(async () => {
          admitted = true;
          try {
            await input.beforeSend?.();
            return await task();
          } finally {
            admitted = false;
          }
        }),
    };
    const liveComputerUse = input.passwords
      ? new ComputerUseService({
          passwords: input.passwords,
          loginReceiver: () => ({
            version: 1,
            connectionId: "receiver-1",
            connectionGeneration: 1,
            publicKey: "B" + "A".repeat(86),
          }),
          hub: {
            ...computerApps,
            acknowledgeComputerUseStop: async () => true,
            machinesFor: () => [],
            sendComputerUse: async (frame) => {
              expect(admitted).toBe(true);
              sent.push(frame);
              return {
                outcome: Promise.resolve({
                  kind: "ok",
                  value: {
                    error: null,
                    ...(input.phone
                      ? {
                          observation: {
                            capturedAt: now,
                            elementCount: 2,
                            foreground: null,
                            geometry: { width: 400, height: 300 },
                            locked: false,
                            observationId: "obs-1",
                            rotation: 0,
                            screen: "on",
                            screenshot: null,
                            screenshotUnavailable: "failed",
                            secureLock: false,
                            tree: "phone",
                            truncated: false,
                          },
                        }
                      : {}),
                    performed: [],
                  },
                }),
              };
            },
          },
          authorizer: { assertActiveGrant: async () => undefined },
          listMachines: async () => [],
          machineOwners: async () => new Map(),
          onSessionsChanged: () => undefined,
          stops: { initial: [], record: async () => undefined, clear: async () => undefined },
          threadTitle: async () => "Saved login",
        })
      : null;
    const computerUse = liveComputerUse ?? mockedComputerUse;
    const service = platform({
      adapters: [],
      computerApps,
      computerUse,
      definitions: [definition],
      isRunnerConnected: vi.fn(() => input.runnerConnected ?? true),
      mcpImageContent: vi.fn(async () => input.mcpImageContent ?? true),
      store: {
        getComputerConnectionForCall: vi.fn(async () =>
          input.revoked?.()
            ? null
            : {
                access: input.connectionAccess ?? "read-write",
                connection,
                runnerId,
                runnerName: input.phone ? "Pixel 7" : "Alex's Mac",
                deviceProfile: null,
                runnerRevoked: false,
              },
        ),
        listCallableTools: vi.fn(async () => {
          if (input.revoked?.()) return [];
          if (operationName === "observe") return [callable];
          const read = computerAppTools(
            definition,
            "read-write",
            callable.grant.connectionId!,
          ).find((tool) => tool.name === "observe")!;
          return [
            callable,
            {
              ...callable,
              tool: { ...callable.tool, ...listedTool(read), id: readToolId },
            },
          ];
        }),
        computerOperations: {
          start: async (
            input: Parameters<IntegrationPlatformStore["computerOperations"]["start"]>[0],
          ) => ({
            ...input.context,
            createdAt: now,
            eventId: createId("event"),
            sequence: "1",
            type: "tool.started",
            data: {
              callId: "computer:test",
              tool: { namespace: "opensteer.integrations", name: `computer.${input.operation}` },
              arguments: {},
              integration: input.subject,
            },
          }),
          complete: async () => undefined,
        } as unknown as IntegrationPlatformStore["computerOperations"],
        listGrants: vi.fn(async () => [callable.grant as IntegrationGrant]),
        revokeGrant: vi.fn(async () => {
          input.revoke?.();
        }),
      },
    });
    return {
      callable,
      computerUse,
      lease,
      prepared,
      service,
      sent,
      liveComputerUse,
      inputSchema: tool.inputSchema,
    };
  }

  function operate(
    service: IntegrationPlatformService,
    callable: CallableIntegrationTool,
    args: Readonly<Record<string, unknown>>,
    who: ToolCaller,
    signal?: AbortSignal,
  ) {
    const phone =
      callable.server.transport.type === "computer" &&
      callable.server.transport.definitionId === "android-phone";
    const { observationId, ...rest } = args;
    const params =
      callable.tool.name === "act"
        ? phone
          ? args
          : { window: "window-1", snapshot: observationId ?? "obs-1", ...rest }
        : phone
          ? {}
          : { window: "window-1", includeScreenshot: true };
    return service.callComputerOperation(
      who,
      callable.grant.connectionId!,
      callable.tool.name,
      params,
      signal,
    );
  }

  const context = { runId: createId("run"), threadId: createId("thread") };

  it.each([false, true])(
    "revokes during a slow saved-login seal without dispatch (phone=%s)",
    async (phone) => {
      let revoked = false;
      const held =
        Promise.withResolvers<
          Awaited<ReturnType<NonNullable<ComputerUseServiceOptions["passwords"]>["seal"]>>
        >();
      const passwords = {
        validateLease: () => true,
        seal: vi.fn<NonNullable<ComputerUseServiceOptions["passwords"]>["seal"]>(
          () => held.promise,
        ),
      };
      const f = guiFixture({
        operation: "act",
        phone,
        passwords,
        revoked: () => revoked,
        revoke: () => {
          revoked = true;
        },
      });
      const who = runCaller(context);
      let call: Promise<unknown> | undefined;
      try {
        call = operate(
          f.service,
          f.callable,
          {
            observationId: "obs-1",
            actions: [
              { type: "type", text: { loginRef: `lgn_${"a".repeat(32)}`, field: "password" } },
            ],
          },
          who,
        );
        const settled = vi.fn();
        void call.then(settled, settled);
        await vi.waitFor(() => expect(passwords.seal).toHaveBeenCalledTimes(1));
        const revoke = f.service.revokeGrant({
          grantId: f.callable.grant.id,
          ownerUserId: who.run!.requestedBy,
          requestId: "revoke-during-seal",
          workspaceId: who.run!.workspaceId,
        });
        let revokedBeforeRelease = false;
        void revoke.then(() => {
          revokedBeforeRelease = true;
        });
        await vi.waitFor(() => expect(revokedBeforeRelease).toBe(true), { timeout: 500 });
        // Cancellation must settle the waiting call before the vault answers.
        await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1), { timeout: 500 });
        const sealing = passwords.seal.mock.calls[0]![0];
        held.resolve({
          type: "login.seal.result",
          status: "sealed",
          envelope: {
            binding: sealing.binding,
            senderPublicKey: sealing.receiver.publicKey,
            salt: "A".repeat(43),
            nonce: "A".repeat(16),
            ciphertext: "",
            tag: "A".repeat(22),
          },
        });
        await expect(call).rejects.toMatchObject({ code: "failed" });
        await revoke;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(f.sent).toEqual([]);
      } finally {
        held.resolve({ type: "login.seal.result", status: "expired" });
        await call?.catch(() => undefined);
        await f.liveComputerUse?.shutdown();
      }
    },
  );

  it.each([false, true])(
    "admits computer saved-login arguments from the published schema (phone=%s)",
    async (phone) => {
      const f = guiFixture({ operation: "act", phone });
      const args = {
        ...(phone ? { observationId: "obs-1" } : { window: "window-1", snapshot: "obs-1" }),
        actions: [{ type: "type", text: { loginRef: `lgn_${"a".repeat(32)}`, field: "password" } }],
      };
      expect(validateJsonSchema(f.inputSchema, args)).toEqual([]);
      const who = runCaller(context);
      let mcp: IntegrationToolsMcpService | undefined;
      const server = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const body: unknown = chunks.length
            ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
            : undefined;
          await mcp!.handle(request, response, body, "run-token");
        })().catch((error: unknown) =>
          response.destroy(error instanceof Error ? error : new Error("MCP test request failed")),
        );
      });
      const client = new Client({ name: "saved-login-contract", version: "1" });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("MCP test server did not bind");
        const url = new URL(`http://127.0.0.1:${address.port}/mcp`);
        mcp = new IntegrationToolsMcpService({
          definitions: [phone ? phoneDefinition : guiDefinition],
          getWorkspaceForOwner: async () => ({ id: who.run!.workspaceId }),
          runTokens: {
            authenticate: async () => who.run!,
          } as unknown as IntegrationToolsTokenService,
          triggerTokens: {
            authenticate: async () => {
              throw new Error("Not a trigger token");
            },
          } as unknown as TriggerIntegrationToolsTokenService,
          onWorkspaceEvent: () => undefined,
          platform: f.service,
          publicUrl: url,
        });
        await client.connect(new StreamableHTTPClientTransport(url) as unknown as Transport);
        const result = await client.callTool({
          name: "computer",
          arguments: {
            code: phone
              ? `const p=await phone("Pixel 7");await p.observe();await p.type(${JSON.stringify(args.actions[0]!.text)})`
              : `const a=await app("Notes");const w=await a.window();await w.observe();await w.type(${JSON.stringify(args.actions[0]!.text)})`,
          },
        });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
      } finally {
        await client.close();
        await mcp?.close();
        await f.service.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      expect(f.computerUse.sendAct).toHaveBeenCalledWith(
        f.lease,
        expect.any(Object),
        args,
        phone,
        expect.any(AbortSignal),
        expect.any(Function),
        expect.any(Number),
      );
    },
  );

  it("says a row the catalog has moved past is being updated, before judging its arguments", async () => {
    const { callable, computerUse, service } = guiFixture({ operation: "act" });
    Object.assign(callable.tool, { schemaDigest: "an-older-digest" });
    const stale = callable;

    await expect(
      operate(
        service,
        stale,
        { actions: [{ target: { index: 1 }, text: "milk", type: "type" }], observationId: "obs-1" },
        runCaller(context),
      ),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Computer use is being updated; search again",
    });
    expect(computerUse.prepare).not.toHaveBeenCalled();
  });

  it("keeps the live tree complete while the existing durable-output contract stays below 64 KiB", async () => {
    const tree = "界".repeat(50_000);
    const { callable, service } = guiFixture({ observation: { tree }, mcpImageContent: false });
    const result = await operate(service, callable, {}, runCaller(context));
    const text = `Looked at Notes\nObservation obs-1 of Notes (Shopping) — 2 elements. Screenshot 800×600 px; all coordinates are screenshot pixels.\n${tree}\nScreenshot unavailable in this engine.`;
    expect(result.content).toEqual([{ type: "text", text }]);
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(64 * 1024);
    const stored = createToolOutput(text);
    expect(Buffer.byteLength(stored.text, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(stored.truncation?.originalBytes).toBe(Buffer.byteLength(text, "utf8"));
  });

  it("tells a failed capture apart from an engine that shows no images", async () => {
    const { callable, service } = guiFixture({ observation: { screenshot: null } });

    const result = await operate(service, callable, {}, runCaller(context));

    expect(result.content).toEqual([
      {
        text: 'Looked at Notes\nObservation obs-1 of Notes (Shopping) — 2 elements. Screenshot 800×600 px; all coordinates are screenshot pixels.\n[0] window "Notes" (0,0 800x600)\nNo screenshot could be captured this time; the tree and its coordinates still apply.',
        type: "text",
      },
    ]);
  });

  it("says so when the app brought itself to the front", async () => {
    const { callable, service } = guiFixture({ observation: { focusChanged: true } });

    const result = await operate(service, callable, {}, runCaller(context));

    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining(
          "The app came to the front on its own; tell the person if they did not expect it.",
        ),
      }),
      expect.objectContaining({ type: "image" }),
    ]);
  });

  it("turns a refusal into a tool error with the Mac's own sentence", async () => {
    const { callable, service } = guiFixture({
      settleRefusal: new ComputerUseError(
        "unsupported",
        "The Mac is locked; ask the person to unlock it.",
      ),
    });

    await expect(operate(service, callable, {}, runCaller(context))).rejects.toMatchObject({
      code: "unsupported",
      message: "The Mac is locked; ask the person to unlock it.",
    });
  });

  /*
   * A refusal for want of permission is said in the computer's own words.
   * Failure modes:
   * - a phone's sentence, already a whole sentence about the phone — paused
   *   or a task that may only look — gets " on Pixel 7" bolted on
   *   after its full stop;
   * - a Mac's sentence, which names only the app, loses the Mac it is about.
   */
  it.each([
    ["a paused phone", "This phone is paused. Resume it in the Opensteer Agent Phone app."],
    ["a task that may only look", "This task may look at the phone but not operate it."],
  ])("says a phone's refusal for %s in the phone's own sentence", async (_name, sentence) => {
    const { callable, service } = guiFixture({
      phone: true,
      settleRefusal: new ComputerUseError("permission-required", sentence),
    });

    await expect(operate(service, callable, {}, runCaller(context))).rejects.toMatchObject({
      code: "permission-required",
      message: sentence,
    });
  });

  it("names the Mac after an app's refusal for want of permission", async () => {
    const { callable, service } = guiFixture({
      settleRefusal: new ComputerUseError(
        "permission-required",
        "Notes needs Accessibility permission.",
      ),
    });

    await expect(operate(service, callable, {}, runCaller(context))).rejects.toMatchObject({
      code: "permission-required",
      message: "Notes needs Accessibility permission on Alex's Mac.",
    });
  });

  it("names the Mac whose Opensteer is too old for window-addressed computer use", async () => {
    const { callable, service } = guiFixture({
      settleRefusal: new ComputerUseError("incompatible-version", computerUseUpdateSentence),
    });

    await expect(operate(service, callable, {}, runCaller(context))).rejects.toMatchObject({
      code: "incompatible-version",
      message: computerUseUpdateMacSentence("Alex's Mac"),
    });
  });

  it("warns the model not to repeat an action whose answer was lost", async () => {
    const { callable, service } = guiFixture({
      operation: "act",
      settleRefusal: new ComputerUseError(
        "outcome-unknown",
        "Computer use lost its connection to this Mac's helper.",
      ),
    });

    await expect(
      operate(
        service,
        callable,
        { actions: [{ keys: "Escape", type: "key" }], observationId: "obs-1" },
        runCaller(context),
      ),
    ).rejects.toMatchObject({
      code: "outcome-unknown",
      message:
        "Computer use lost its connection to this Mac's helper. The actions may already have taken effect. Do not repeat them. Observe the app before deciding the next action.",
    });
  });

  it("refuses act when the connection or the grant allows reading only", async () => {
    for (const fixture of [
      guiFixture({ connectionAccess: "read", operation: "act" }),
      guiFixture({ grantAccess: "read", operation: "act" }),
    ]) {
      await expect(
        operate(
          fixture.service,
          fixture.callable,
          { actions: [{ keys: "Escape", type: "key" }], observationId: "obs-1" },
          runCaller(context),
        ),
      ).rejects.toBeInstanceOf(IntegrationAuthorizationRequiredError);
      expect(fixture.computerUse.sendAct).not.toHaveBeenCalled();
    }
  });

  it("does not send when a removal wins before the frame leaves its admission turn", async () => {
    let removed = false;
    const { callable, computerUse, service } = guiFixture({
      // The removal commits inside the turn, before the authority is re-read,
      // which is the window a second turn for the send would have opened.
      beforeSend: async () => {
        removed = true;
      },
      revoked: () => removed,
    });

    await expect(operate(service, callable, {}, runCaller(context))).rejects.toBeInstanceOf(
      IntegrationAuthorizationRequiredError,
    );
    expect(computerUse.sendObserve).not.toHaveBeenCalled();
    // The lease a refused call never spent goes back, so its session does
    // not linger as if a call were still coming.
    expect(computerUse.release).toHaveBeenCalledOnce();
  });

  it("answers a batch the protocol schema refuses as a tool error, not a throw", async () => {
    // The published JSON schema bounds less than the protocol one does — an
    // element index past the elements one observation may name gets through it
    // — so the refusal happens inside the admission turn, with the send.
    const { callable, service } = guiFixture({
      operation: "act",
      refusal: new ComputerUseError("failed", "Those actions are not usable: index too large."),
    });

    await expect(
      operate(
        service,
        callable,
        { actions: [{ target: { index: 5_000 }, type: "click" }], observationId: "obs-1" },
        runCaller(context),
      ),
    ).rejects.toMatchObject({
      code: "failed",
      message: "Those actions are not usable: index too large.",
    });
  });

  it("returns exact partial progress without observing a Mac after input stops", async () => {
    const { callable, service } = guiFixture({
      performed: ["Pressed Escape"],
      operation: "act",
      resultError: new ComputerUseError("failed", "The second action could not be performed."),
    });
    await expect(
      operate(
        service,
        callable,
        {
          actions: [
            { type: "key", keys: "Escape" },
            { type: "key", keys: "Escape" },
          ],
          observationId: "obs-1",
        },
        runCaller(context),
      ),
    ).rejects.toMatchObject({
      code: "failed",
      performed: ["Pressed Escape"],
      value: { observation: null, performed: ["Pressed Escape"] },
    });
  });
});

describe("computer use approval key registration", () => {
  it("requires the owner's candidate key to answer on the live Mac", async () => {
    const ownerUserId = createId("user");
    const runnerId = createId("runner");
    const pair = generateKeyPairSync("ed25519");
    const foreign = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const registered = vi.fn(async () => ({
      approvalKeyId: computerAppApprovalKeyId(publicKey),
      replaced: false,
    }));
    const prove = vi.fn(
      async (
        _runnerId: ReturnType<typeof createId<"runner">>,
        challenge: Parameters<ComputerAppHub["proveComputerAppApprovalKey"]>[1],
      ) => {
        try {
          return signComputerAppApprovalKeyChallenge(pair.privateKey, challenge);
        } catch {
          return null;
        }
      },
    );
    const service = platform({
      adapters: [],
      computerApps: {
        appStatus: () => null,
        attached: () => true,
        approvalRelayRefusal: () => null,
        relaysComputerAppApprovals: () => true,
        proveComputerAppApprovalKey: prove,
        send: vi.fn(),
        withRunnerAdmission: async (_runnerId, task) => task(),
      },
      store: {
        getComputerUsePolicy: async () => ({
          appApproval: "ask",
          approvalKeyId: null,
          revision: 0,
        }),
        registerComputerUseApprovalKey: registered,
      },
    });
    const input = { ownerUserId, publicKey, requestId: "register-key", runnerId };
    await expect(
      service.computerAppApprovals.registerComputerUseApprovalKey(input),
    ).resolves.toEqual({
      approvalKeyId: computerAppApprovalKeyId(publicKey),
    });
    expect(registered).toHaveBeenCalledOnce();
    const foreignKey = foreign.publicKey.export({ format: "pem", type: "spki" }).toString();
    await expect(
      service.computerAppApprovals.registerComputerUseApprovalKey({
        ...input,
        publicKey: foreignKey,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(registered).toHaveBeenCalledOnce();
  });
});

describe("computer app approval list delivery", () => {
  it("preserves an update made while an earlier list read fails", async () => {
    const runnerId = createId("runner");
    let rejectFirst: ((error: Error) => void) | undefined;
    const first = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const read = vi
      .fn()
      .mockImplementationOnce(async () => first)
      .mockResolvedValue({ approvalKeyId: null, approvals: [] });
    const send = vi.fn(async () => true);
    const service = platform({
      adapters: [],
      computerApps: {
        appStatus: () => null,
        attached: () => true,
        approvalRelayRefusal: () => null,
        relaysComputerAppApprovals: () => true,
        send: vi.fn(async () => ({ outcome: Promise.resolve({ kind: "ok" as const, value: {} }) })),
        sendComputerAppApprovals: send,
        withRunnerAdmission: async (_runnerId, task) => task(),
      },
      store: { listComputerAppApprovalsForRunner: read },
    });
    service.computerAppApprovals.pushComputerAppApprovals(runnerId);
    service.computerAppApprovals.pushComputerAppApprovals(runnerId);
    rejectFirst?.(new Error("Temporary database error"));
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(read).toHaveBeenCalledTimes(2);
  });
});

type ApprovalHubMember =
  | "reportsApp"
  | "approvalRelayRefusal"
  | "machinesFor"
  | "proveComputerAppApprovalKey"
  | "relaysComputerAppApprovals"
  | "sendComputerAppApprovalOutcome"
  | "sendComputerAppApprovals";

function platform(input: {
  readonly listConnections?: (
    ownerUserId: ReturnType<typeof createId<"user">>,
  ) => Promise<readonly IntegrationConnectionSummary[]>;
  readonly adapters: readonly IntegrationAdapter[];
  readonly computerApps?: Partial<Pick<ComputerAppHub, ApprovalHubMember>> &
    Pick<ComputerAppHub, "appStatus" | "attached" | "send" | "withRunnerAdmission">;
  readonly computerUse?: ComputerUseGateway;
  readonly definitions?: readonly ReturnType<typeof IntegrationDefinitionSchema.parse>[];
  readonly isRunnerConnected?: (runnerId: ReturnType<typeof createId<"runner">>) => boolean;
  readonly mcpImageContent?: () => Promise<boolean>;
  readonly markAdapterAuthorizationRequired?: () => Promise<void>;
  readonly materializeForAdapter?: IntegrationAdapterCredentialMaterializer["materializeForAdapter"];
  readonly onWorkspaceEvent?: (event: AgentEvent) => void;
  readonly onConnectionsChanged?: () => void;
  readonly onRequestsChanged?: () => void;
  readonly store?: Partial<IntegrationPlatformStore>;
}): IntegrationPlatformService {
  return new IntegrationPlatformService({
    listConnections: input.listConnections ?? (async () => []),
    adapters: input.adapters,
    authorizationSource: { providerAuthorizations: vi.fn(async () => ({})) },
    computerApps: {
      reportsApp: () => "offline",
      // A Mac that relays no approvals, unless a test says otherwise.
      machinesFor: () => [],
      openMcpSession: vi.fn(),
      proveComputerAppApprovalKey: vi.fn(async () => null),
      approvalRelayRefusal: () => null,
      relaysComputerAppApprovals: () => false,
      sendComputerAppApprovalOutcome: vi.fn(async () => false),
      sendComputerAppApprovals: vi.fn(async () => false),
      ...(input.computerApps ??
        ({
          appStatus: vi.fn(() => null),
          attached: vi.fn(() => false),
          send: vi.fn(async () => ({
            outcome: Promise.resolve({
              code: "offline",
              kind: "error",
              message: "Computer is offline",
              retryable: true,
            }),
          })),
          withRunnerAdmission: vi.fn(async (_runnerId, task) => task()),
        } as Pick<ComputerAppHub, "appStatus" | "attached" | "send" | "withRunnerAdmission">)),
    },
    credentialMaterializer: {
      markAdapterAuthorizationRequired:
        input.markAdapterAuthorizationRequired ?? vi.fn(async () => undefined),
      materializeForAdapter:
        input.materializeForAdapter ?? vi.fn(async () => Promise.reject(new Error("unused"))),
    },
    ...(input.computerUse ? { computerUse: input.computerUse } : {}),
    computerToolEnabled: () => true,
    computerUseVersion: () => 2,
    ...(input.mcpImageContent ? { mcpImageContent: input.mcpImageContent } : {}),
    dataDirectory: "/tmp/opensteer-integration-test",
    ...(input.definitions ? { definitions: input.definitions } : { definitions: [] }),
    isRunnerConnected: input.isRunnerConnected ?? vi.fn(() => true),
    mcpOauth: { providerFor: vi.fn(async () => Promise.reject(new Error("unused"))) },
    onWorkspaceEvent: input.onWorkspaceEvent ?? vi.fn(),
    onConnectionsChanged: input.onConnectionsChanged ?? vi.fn(),
    onRequestsChanged: input.onRequestsChanged ?? vi.fn(),
    store: (input.store
      ? { computerAppRunner: vi.fn(async () => null), ...input.store }
      : {
          getToolInvocation: vi.fn(async () => mailInvocation),
          computerAppRunner: vi.fn(async () => null),
          install: vi.fn(),
          listInstallations: vi.fn(async () => []),
        }) as IntegrationPlatformStore,
  });
}

function computerConnectionSummary(
  access: "read" | "read-write" = "read-write",
): IntegrationConnectionSummary {
  return {
    accountIdentifier: null,
    applicationSource: null,
    authMethodId: "computer",
    authorizationDigest: null,
    computer: {
      blockedAt: null,
      policyRevision: null,
      access,
      app: null,
      runnerId: createId("runner"),
    },
    connectionMethod: "computer",
    createdAt: now,
    definitionId: computerDefinition.id,
    displayName: "Studio Mac",
    externalIdentityId: null,
    externalTenantId: null,
    grantedScopes: [],
    id: createIntegrationId("connection"),
    provider: computerDefinition.provider,
    providerApplicationId: null,
    status: "connected",
    statusDetail: null,
    statusReason: null,
    updatedAt: now,
  };
}

function computerCallable(
  effect: "read" | "write" = "read",
  computerDefinition = computerDefinitionCandidate,
): CallableIntegrationTool {
  if (!isComputerAppDefinition(computerDefinition)) throw new Error("Computer definition invalid");
  const installationId = createIntegrationId("installation");
  const serverId = createIntegrationId("server");
  const connectionId = createIntegrationId("connection");
  const operation = computerDefinition.config.operations.find(
    (candidate) => candidate.effect === effect,
  )!;
  const tool = listedTool(
    computerAppTools(computerDefinition, "read-write", connectionId).find(
      ({ name }) => name === operation.name,
    )!,
  );
  return {
    grant: {
      access: "read-write",
      alias: "Studio Mac",
      connectionId,
      createdAt: now,
      id: createIntegrationId("grant"),
      installationId,
      isDefault: true,
      ownerUserId: createId("user"),
      revokedAt: null,
      status: "active",
      workspaceId: createId("workspace"),
    },
    installation: {
      createdAt: now,
      description: computerDefinition.description,
      id: installationId,
      manifest: { definition: integrationDefinitionSummary(computerDefinition) },
      name: computerDefinition.id,
      provenance: {
        definitionDigest: integrationDefinitionDigest(computerDefinition),
        definitionId: computerDefinition.id,
      },
      revision: 1,
      sourceKind: "built-in",
      status: "active",
      title: computerDefinition.name,
      trust: "built-in",
      updatedAt: now,
      version: integrationDefinitionDigest(computerDefinition),
    },
    server: {
      connectionRequirement: { definitionId: computerDefinition.id, kind: "computer" },
      id: serverId,
      installationId,
      name: "default",
      status: "active",
      statusDetail: null,
      toolGeneration: 1,
      transport: { definitionId: computerDefinition.id, type: "computer" },
      updatedAt: now,
    },
    tool: { ...tool, serverId },
  };
}

function integrationRequest(
  kind: "integration.access" | "integration.install",
  status: "pending",
): Request {
  return {
    callId: crypto.randomUUID(),
    cancellationReason: null,
    createdAt: now,
    id: createId("request"),
    kind,
    mode: "durable",
    originatingOccurrenceId: null,
    originatingRunId: createId("run"),
    originatingThreadId: createId("thread"),
    originatingWorkspaceId: createId("workspace"),
    payload:
      kind === "integration.install"
        ? { kind, manifest: { kind: "catalog" }, reason: "Install the connector" }
        : {
            access: "read",
            installationId: createIntegrationId("installation"),
            kind,
            manifest: null,
            reason: "Use the connector",
            requestedConnectionId: null,
            requestedServerId: null,
          },
    presentation:
      kind === "integration.install"
        ? {
            kind: "choice",
            options: [
              { hint: "confirm", id: "installed", label: "Install" },
              { hint: "cancel", id: "declined", label: "Decline" },
            ],
            title: "Install integration?",
          }
        : {
            kind: "external",
            subject: { id: "integration", kind: "integration-installation" },
            title: "Integration access",
          },
    requestedBy: createId("user"),
    requiredActor: kind === "integration.install" ? "administrator" : "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status,
    targetWorkspaceId: createId("workspace"),
  } as Request;
}

function adapterWithInvoke(invokeTool: IntegrationAdapter["invokeTool"]): IntegrationAdapter {
  return {
    credentialDisclosure() {
      return { destinations: ["https://api.example.com"], check: true };
    },
    async checkHealth() {
      return { healthy: true };
    },
    invokeTool,
    kind: "graphql",
    parseConfig: (config) => config,
    snapshotConfig: async (config) => configObject(config),
    async resolveTools() {
      return { definitions: {}, tools: [] };
    },
  };
}

function configObject(config: unknown): Readonly<Record<string, unknown>> {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new TypeError("Test integration config must be an object");
  }
  return config as Readonly<Record<string, unknown>>;
}

/** What the store reads for one call of `callable()`'s tool. */
const mailInvocation = {
  adapterSnapshot: { adapter: "graphql", config: {}, definitionId: "mail" },
  installationRevision: 1,
  schemaDigest: "a".repeat(43),
  status: "active",
  target: null,
  toolGeneration: 1,
} as const;

/** A tool row as the platform lists it: its schemas only digested. */
function listedTool(material: IntegrationToolMaterial): Omit<IntegrationTool, "serverId"> {
  const { inputSchema, outputSchema, ...listed } = material;
  return { ...listed, schemaDigest: integrationSchemaDigest({ inputSchema, outputSchema }) };
}

function callable(): CallableIntegrationTool {
  const installationId = createIntegrationId("installation");
  const serverId = createIntegrationId("server");
  const connectionId = createIntegrationId("connection");
  const definition = IntegrationDefinitionSchema.parse({
    adapter: "graphql",
    authMethods: [
      {
        id: "oauth",
        kind: "oauth",
        label: "OAuth",
        oauth: {
          authorizationUrl: "https://accounts.example.test/authorize",
          clientAuth: "body",
          identity: { identityPath: "id", source: "token-response" },
          scopeSeparator: " ",
          scopes: ["mail.send"],
          tokenUrl: "https://accounts.example.test/token",
          usesPkce: true,
        },
        placements: [
          {
            carrier: "header",
            name: "Authorization",
            prefix: "Bearer ",
            variable: "accessToken",
          },
        ],
      },
    ],
    config: {},
    description: "Mail API",
    id: "mail",
    name: "Mail",
    provider: "mail",
    setupUrl: "https://example.test/setup",
  });
  if (definition.adapter === "computer") throw new Error("Test definition must use an adapter");
  return {
    grant: {
      access: "read-write",
      alias: "Work",
      connectionId,
      createdAt: now,
      id: createIntegrationId("grant"),
      installationId,
      isDefault: true,
      ownerUserId: createId("user"),
      revokedAt: null,
      status: "active",
      workspaceId: createId("workspace"),
    },
    installation: {
      createdAt: now,
      description: definition.description,
      id: installationId,
      manifest: { definition: integrationDefinitionSummary(definition) },
      name: "mail",
      provenance: {},
      revision: 1,
      sourceKind: "built-in",
      status: "active",
      title: "Mail",
      trust: "built-in",
      updatedAt: now,
      version: "1",
    },
    server: {
      connectionRequirement: {
        definitionId: "mail",
        kind: "provider",
        provider: "mail",
        providerApplicationRequired: true,
      },
      id: serverId,
      installationId,
      name: "default",
      status: "active",
      statusDetail: null,
      toolGeneration: 1,
      transport: { adapter: "graphql", definitionId: "mail", type: "adapter" },
      updatedAt: now,
    },
    tool: {
      annotations: {},
      connectionId: null,
      description: "Send mail",
      id: createIntegrationId("tool"),
      name: "send",
      schemaDigest: mailInvocation.schemaDigest,
      serverId,
      status: "active",
      title: "Send mail",
    },
  };
}

describe("computer app request matrix", () => {
  const definition = computerAppIntegrations.find(({ id }) => id === "macos-app")!;
  const identity = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null };
  function fixture(
    options: {
      connectionAccess?: "read" | "read-write";
      callableAccess?: "read" | "read-write";
      blocked?: boolean;
      offline?: boolean;
      allowed?: boolean;
      /** What the store decided under the Mac's lock. */
      decision?: "approved" | "computer" | "workspace-grant";
    } = {},
  ) {
    const runnerId = createId("runner");
    const connectionId = createIntegrationId("connection");
    const grantId = createIntegrationId("grant");
    const connection = {
      ...computerConnectionSummary(options.connectionAccess ?? "read-write"),
      id: connectionId,
      definitionId: "macos-app",
      computer: {
        access: options.connectionAccess ?? "read-write",
        app: identity,
        runnerId,
        blockedAt: options.blocked ? now : null,
        policyRevision: null,
      },
    } satisfies IntegrationConnectionSummary;
    let available = options.callableAccess;
    const refs = (access: "read" | "read-write" | undefined): CallableIntegrationTool[] =>
      !access
        ? []
        : (access === "read" ? ["observe"] : ["observe", "act"]).map(
            (name) =>
              ({
                grant: { id: grantId, connectionId },
                tool: {
                  name,
                  id: name === "observe" ? "observe-id" : "act-id",
                  schemaDigest: "digest",
                },
              }) as unknown as CallableIntegrationTool,
          );
    const request = integrationRequest("integration.access", "pending");
    const setupRequest = { id: crypto.randomUUID(), runnerId };
    let admitted = false;
    const threadReadInsideAdmission: boolean[] = [];
    const requestComputerAppAccess = vi.fn(
      async (
        input: Parameters<IntegrationPlatformStore["requestComputerAppAccess"]>[0],
      ): Promise<ComputerAppAccessDecision> => {
        switch (options.decision ?? "computer") {
          case "approved":
            available = input.access;
            return { connection, kind: "approved", requestEvents: [] };
          case "workspace-grant":
            return { kind: "workspace-grant", replayed: false, request, requestEvents: [] };
          case "computer":
            return {
              kind: "computer",
              replayed: false,
              request,
              requestEvents: [],
              setupRequest: setupRequest as never,
            };
        }
      },
    );
    // The Mac hears of its approvals as the whole list, on its own stream.
    const pushed = vi.fn(async () => true);
    const resolveApp = vi.fn(async () => ({
      allowed: options.allowed !== false,
      identity,
      reason: options.allowed === false ? "This app is off limits." : null,
      risk: "standard" as const,
      running: true,
      path: "/System/Applications/Notes.app",
    }));
    const service = platform({
      adapters: [],
      definitions: [definition],
      listConnections: async () => (options.connectionAccess ? [connection] : []),
      computerApps: {
        attached: () => !options.offline,
        appStatus: () => null,
        approvalRelayRefusal: () => null,
        relaysComputerAppApprovals: () => true,
        sendComputerAppApprovals: pushed,
        send: vi.fn(),
        withRunnerAdmission: async (_id, task) => {
          admitted = true;
          try {
            return await task();
          } finally {
            admitted = false;
          }
        },
      },
      computerUse: {
        eligibleInventory: async () => ({
          machines: [
            {
              name: "Alex's Mac",
              runnerId,
              state: options.offline ? ("offline" as const) : ("ready" as const),
              ready: !options.offline,
            },
          ],
          phones: [],
        }),
        // Only a Mac is set up here: asked for its phones, the person has none.
        eligibleMachines: async (_owner, definitionId) =>
          definitionId === "macos-app"
            ? [
                {
                  name: "Alex's Mac",
                  runnerId,
                  state: options.offline ? "offline" : "ready",
                  ready: !options.offline,
                },
              ]
            : [],
        resolveApp,
        holders: () => new Map(),
        threadTitle: async () => {
          threadReadInsideAdmission.push(admitted);
          return "Shopping list";
        },
        closeForConnection: vi.fn(),
        installedApps: vi.fn(),
        prepare: vi.fn(),
        release: vi.fn(),
        releaseSession: vi.fn(),
        sendAct: vi.fn(),
        sendObserve: vi.fn(),
        sendWindowOperation: vi.fn(),
        stop: vi.fn(),
      },
      store: {
        listCallableTools: async () => refs(available),
        listComputerAppApprovalsForRunner: async () => ({ approvalKeyId: null, approvals: [] }),
        requestComputerAppAccess,
      },
    });
    const input = {
      access: "read-write" as const,
      app: "Notes",
      reason: "Add groceries",
      callId: "call-1",
      ownerUserId: createId("user"),
      originatingRunId: createId("run"),
      runnerId,
      threadId: createId("thread"),
      workspaceId: createId("workspace"),
    };
    return {
      service,
      input,
      pushed,
      requestComputerAppAccess,
      resolveApp,
      threadReadInsideAdmission,
    };
  }

  it("reads the Thread's name before the Mac's admission turn", async () => {
    const test = fixture();
    await test.service.computerAppApprovals.requestComputerAppAccess(test.input);
    expect(test.threadReadInsideAdmission).toEqual([false]);
  });
  it("returns already available and toolRefs when the requested access is callable", async () => {
    const test = fixture({ connectionAccess: "read-write", callableAccess: "read-write" });
    expect(
      await test.service.computerAppApprovals.requestComputerAppAccess(test.input),
    ).toMatchObject({
      status: "already-available",
      toolRefs: { observe: expect.any(String), act: expect.any(String) },
    });
    expect(test.requestComputerAppAccess).not.toHaveBeenCalled();
  });
});
