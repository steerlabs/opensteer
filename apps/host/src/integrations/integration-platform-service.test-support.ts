import { mkdtemp, rm } from "node:fs/promises";
import {
  createIntegrationPlatform,
  type IntegrationPlatformTestHarness,
  type IntegrationPlatformTestOptions,
} from "./integration-platform.test-support.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AesGcmSecretVault, StaticEncryptionKeyProvider } from "@opensteer/access/host";
import type {} from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  IntegrationDefinitionSchema,
  createIntegrationId,
  integrationDefinitionSummary,
  isComputerAppDefinition,
  type IntegrationAdapter,
  type IntegrationConnectionSummary,
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
import { type CallableIntegrationTool, type IntegrationPlatformStore } from "@opensteer/database";
import { createId, type AgentEvent, type Request } from "@opensteer/core";
import { type MachineAppStatus } from "@opensteer/protocol";

import { afterEach, beforeEach, vi } from "vitest";
import type { ComputerAppHub } from "../computer-apps/computer-app-hub.js";
import type { ComputerUseGateway } from "../devices/device-service.js";
import type { RunToolContext, ToolCaller } from "../agents/tool-caller.js";

/** A call with no Run behind it, as a Trigger occurrence makes. */
export const caller: ToolCaller = { run: null, threadId: createId("thread") };
export const runCaller = (run: RunToolContext): ToolCaller => ({
  run: {
    ...run,
    aud: "opensteer-run-tools",
    bindingGeneration: 1,
    environmentId: createId("environment"),
    exp: 2_000_000_000,
    iat: 1_900_000_000,
    iss: "opensteer-host",
    jti: "test",

    requestedBy: createId("user"),
    runnerBootId: "boot",
    runnerId: createId("runner"),
  },
  threadId: run.threadId,
});

export const now = "2026-08-13T12:00:00.000Z";
export const materialized = {
  authMethodId: "oauth",
  connectionMethod: "managed-oauth" as const,
  credentialGeneration: 1,
  credentialValues: { accessToken: "fresh-token" },
  definitionId: "mail",
  grantedScopes: ["mail.send"],
  provider: "mail",
};
export const computerDefinitionCandidate = computerAppIntegrations[0]!;
if (!isComputerAppDefinition(computerDefinitionCandidate)) {
  throw new Error("Computer definition invalid");
}
export const computerDefinition = computerDefinitionCandidate;

export function computerStatus(
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

let testDataDirectory: string;
export const services: IntegrationPlatformTestHarness[] = [];

/** Gives each test its own data folder and closes every platform it built. */
export function usePlatformFixtures(): void {
  beforeEach(async () => {
    testDataDirectory = await mkdtemp(join(tmpdir(), "personal-platform-test-"));
  });
  afterEach(async () => {
    try {
      for (const service of services.splice(0)) await service.close();
    } finally {
      await rm(testDataDirectory, { recursive: true, force: true });
    }
  });
}

export type ApprovalHubMember = "reportsApp" | "machinesFor" | "compatibilityReason";

createId("user");
export function platform(input: {
  readonly listConnections?: (
    ownerUserId: ReturnType<typeof createId<"user">>,
  ) => Promise<readonly IntegrationConnectionSummary[]>;
  readonly adapters: readonly IntegrationAdapter[];
  readonly computerApps?: Partial<Pick<ComputerAppHub, ApprovalHubMember>> &
    Pick<ComputerAppHub, "appStatus" | "attached" | "send" | "withRunnerAdmission">;
  readonly computerUse?: ComputerUseGateway;
  readonly nativeTabs?: IntegrationPlatformTestOptions["nativeTabs"];
  readonly definitions?: readonly ReturnType<typeof IntegrationDefinitionSchema.parse>[];
  readonly isRunnerConnected?: (runnerId: ReturnType<typeof createId<"runner">>) => boolean;
  readonly mcpImageContent?: () => Promise<boolean>;
  readonly mcpOauth?: IntegrationPlatformTestOptions["mcpOauth"];
  readonly markAdapterAuthorizationRequired?: () => Promise<void>;
  readonly materializeForAdapter?: IntegrationAdapterCredentialMaterializer["materializeForAdapter"];
  readonly onDeploymentEvent?: (event: AgentEvent) => void;
  readonly onConnectionsChanged?: () => void;
  readonly onSettingsChanged?: IntegrationPlatformTestOptions["onSettingsChanged"];
  readonly onRequestsChanged?: () => void;
  readonly store?: Partial<IntegrationPlatformStore>;
}): IntegrationPlatformTestHarness {
  const service = createIntegrationPlatform({
    listConnections: input.listConnections ?? (async () => []),
    secretVault: new AesGcmSecretVault(
      new StaticEncryptionKeyProvider(new Map([[1, randomBytes(32)]]), 1),
    ),
    adapters: input.adapters,
    authorizationSource: { providerAuthorizations: vi.fn(async () => ({})) },
    computerApps: {
      requireAgentAccess: async () => {},
      removePluginData: async () => {},
      reportsApp: () => "offline",
      compatibilityReason: () => null,
      machinesFor: () => [],
      openMcpSession: vi.fn(),
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
    ...(input.nativeTabs ? { nativeTabs: input.nativeTabs } : {}),
    computerToolEnabled: () => true,
    computerUseVersion: () => 2,
    ...(input.mcpImageContent ? { mcpImageContent: input.mcpImageContent } : {}),
    dataDirectory: testDataDirectory,
    ...(input.definitions ? { definitions: input.definitions } : { definitions: [] }),
    isRunnerConnected: input.isRunnerConnected ?? vi.fn(() => true),
    mcpOauth: input.mcpOauth ?? {
      providerFor: vi.fn(async () => Promise.reject(new Error("unused"))),
    },
    onDeploymentEvent: input.onDeploymentEvent ?? vi.fn(),
    onConnectionsChanged: input.onConnectionsChanged ?? vi.fn(),
    onSettingsChanged: input.onSettingsChanged ?? vi.fn(async () => undefined),
    onRequestsChanged: input.onRequestsChanged ?? vi.fn(),
    store: (input.store
      ? {
          connections: { assertOwner: vi.fn(async () => undefined) },
          computerAppRunner: vi.fn(async () => null),
          listGrants: vi.fn(async () => []),
          // A fake's Request methods serve both stores the platform reads them from.
          ...(input.store.requests ? { integrationRequests: input.store.requests } : {}),
          ...input.store,
        }
      : {
          connections: { assertOwner: vi.fn(async () => undefined) },
          getToolInvocation: vi.fn(async () => mailInvocation),
          computerAppRunner: vi.fn(async () => null),
          install: vi.fn(),
          listInstallations: vi.fn(async () => []),
        }) as IntegrationPlatformStore,
  });
  services.push(service);
  return service;
}

export function computerConnectionSummary(
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

export function computerCallable(
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

export function integrationRequest(
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
    requiredActor: "requester",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status,
  } as Request;
}

export function adapterWithInvoke(
  invokeTool: IntegrationAdapter["invokeTool"],
): IntegrationAdapter {
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

export function configObject(config: unknown): Readonly<Record<string, unknown>> {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new TypeError("Test integration config must be an object");
  }
  return config as Readonly<Record<string, unknown>>;
}

/** What the store reads for one call of `callable()`'s tool. */
export const mailInvocation = {
  adapterSnapshot: { adapter: "graphql", config: {}, definitionId: "mail" },
  installationRevision: 1,
  schemaDigest: "a".repeat(43),
  status: "active",
  target: null,
  toolGeneration: 1,
} as const;

/** A tool row as the platform lists it: its schemas only digested. */
export function listedTool(material: IntegrationToolMaterial): Omit<IntegrationTool, "serverId"> {
  const { inputSchema, outputSchema, ...listed } = material;
  return { ...listed, schemaDigest: integrationSchemaDigest({ inputSchema, outputSchema }) };
}

export function callable(): CallableIntegrationTool {
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
