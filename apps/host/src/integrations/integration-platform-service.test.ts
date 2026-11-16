import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import {
  caller,
  now,
  materialized,
  computerDefinition,
  usePlatformFixtures,
  platform,
  computerConnectionSummary,
  integrationRequest,
  adapterWithInvoke,
  configObject,
  callable,
  computerCallable,
  mailInvocation,
} from "./integration-platform-service.test-support.js";
import { type IntegrationPlatformTestOptions } from "./integration-platform.test-support.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {} from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  IntegrationDefinitionSchema,
  createIntegrationId,
  integrationDefinitionSummary,
  integrationInstallManifestSummary,
  type IntegrationAdapter,
  type IntegrationInstallation,
  type IntegrationServer,
} from "@opensteer/integration-core";
import { googleIntegrations } from "@opensteer/integration-catalog";
import { type IntegrationAdapterCredentialMaterializer } from "@opensteer/integration-core/ports";
import { integrationDefinitionDigest } from "@opensteer/integration-core/digest";
import { createOpenApiAdapter, openApiAdapter } from "@opensteer/integration-adapters";
import {
  type CallableIntegrationTool,
  type IntegrationPlatformStore,
  type PreparedIntegrationInstallFulfillment,
} from "@opensteer/database";
import {
  OpensteerError,
  RequestJsonObjectSchema,
  createId,
  type AgentEvent,
  type Request,
} from "@opensteer/core";

import { describe, expect, it, vi } from "vitest";
import { IntegrationAuthorizationRequiredError } from "./integration-platform-service.js";
import type {} from "../devices/device-service.js";

/** A call with no Run behind it, as a Trigger occurrence makes. */
usePlatformFixtures();

describe("agent plugin replacement", () => {
  it("replaces its own package, records its folder and skips identical snapshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "plugin-replace-"));
    try {
      await writeFile(
        join(directory, "plugin.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "mine",
        }),
      );
      const actorUserId = createId("user");
      const threadId = createId("thread");
      const owned = {
        id: "owned",
        name: "mine",
        installedBy: actorUserId,

        currentVersionId: "old",
        versions: [{ id: "old", digest: "old" }],
        activations: [],
      };
      const update = vi.fn(async (input: { digest: string }) => {
        owned.versions.push({ id: "new", digest: input.digest });
        owned.currentVersionId = "new";
      });
      const installNew = vi.fn();
      let previous: IntegrationInstallation | undefined;
      const install = vi.fn(async (input: Parameters<IntegrationPlatformStore["install"]>[0]) => {
        await input.beforeInstall?.({} as never);
        previous = { ...input.installation, createdAt: now, revision: 1, updatedAt: now };
        return { installation: previous, requestEvents: [] };
      });
      const service = platform({
        adapters: [],
        store: {
          plugins: {
            setupThread: async () => null,
            recordSetupThread: async () => undefined,
            list: async () => [owned, { ...owned, id: "other" }],
            update,
            install: installNew,
          } as never,
          localMcp: { list: async () => [], requestApprovals: async () => [] } as never,
          listInstallations: async () => (previous ? [previous] : []),
          install,
        },
      });
      const input = {
        directory,
        threadId,

        actorUserId,
        requestId: "install",
      };
      const first = await service.installAgentPlugin(input);
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: "owned",

          source: { directory },
        }),
        expect.anything(),
      );
      expect(installNew).not.toHaveBeenCalled();
      expect((await service.installAgentPlugin(input)).installation).toEqual(first.installation);
      expect(install).toHaveBeenCalledTimes(1);
      // An administration command records its result in the install, so it never skips it.
      await service.installAgentPlugin({
        ...input,
        administration: {
          authoritySource: {},
          idempotencyKey: "same",
          request: {},
          requestedBy: actorUserId,
          type: "plugin.update",
        },
      });
      expect(install).toHaveBeenCalledTimes(2);
      await mkdir(join(directory, "extra"));
      await writeFile(join(directory, "extra/code.js"), "new code");
      await service.installAgentPlugin(input);
      expect(install).toHaveBeenCalledTimes(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["moves an agent's update off a computer that left the Deployment", false],
    ["keeps an agent’s update on its current computer", true],
  ])("%s", async (_, current) => {
    const directory = await mkdtemp(join(tmpdir(), "plugin-computer-"));
    try {
      await writeFile(
        join(directory, "plugin.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "mine",
        }),
      );
      await writeFile(
        join(directory, "mcp.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
          mcpServers: { camera: { type: "stdio", command: "node", args: ["server.js"] } },
        }),
      );

      const gone = createId("runner"),
        agents = createId("runner"),
        kept = createId("runner");
      const previous = {
        id: createIntegrationId("installation"),
        pluginId: "owned",
      } as IntegrationInstallation;
      let ranOn: unknown;
      const service = platform({
        adapters: [],
        store: {
          plugins: {
            setupThread: async () => null,
            recordSetupThread: async () => undefined,
            list: async () => [
              {
                id: "owned",
                name: "mine",
                scope: "workspace",

                updatedAt: new Date(now),
                currentVersionId: "v",
                versions: [{ id: "v", digest: "old" }],
                activations: [{}],
              },
            ],
            update: vi.fn(),
          } as never,
          localMcp: {
            list: async () => [
              {
                installationId: previous.id,
                name: "retired",
                runnerId: gone,
                status: current ? "disabled" : "active",
              },
              ...(current
                ? [
                    {
                      installationId: previous.id,
                      name: "camera",
                      runnerId: kept,
                      status: "active",
                    },
                  ]
                : []),
            ],
            computerName: async (runnerId: unknown) => (runnerId === gone ? null : "Mac"),
            requestApprovals: async () => [],
          } as never,
          computerAppRunner: async () => null,
          listInstallations: async () => [previous],
          install: async (input: Parameters<IntegrationPlatformStore["install"]>[0]) => {
            ranOn = input.servers[0]?.transport;
            return {
              installation: { ...input.installation, createdAt: now, revision: 1, updatedAt: now },
              requestEvents: [],
            };
          },
        },
      });
      await service.installAgentPlugin({
        directory,

        pluginId: "owned",
        threadId: createId("thread"),
        runnerId: agents,
        actorUserId: createId("user"),
        requestId: "computer",
      });
      expect(ranOn).toMatchObject({ runnerId: current ? kept : agents, type: "runner" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("IntegrationPlatformService definition reconciliation", () => {
  it.each(["startup", "install"] as const)(
    "repairs unchanged OAuth metadata before the %s cached-installation path without rematerializing",
    async (operation) => {
      const definition = googleIntegrations.find(({ id }) => id === "google-gmail")!;
      const { hostedOAuth, ...legacy } = definition;
      void hostedOAuth;
      let installation: IntegrationInstallation = {
        createdAt: now,
        description: definition.description,
        id: createIntegrationId("installation"),
        manifest: { definition: integrationDefinitionSummary(legacy) },
        name: definition.id,
        provenance: {
          definitionId: definition.id,
          definitionDigest: integrationDefinitionDigest(definition),
        },
        revision: 3,
        sourceKind: "built-in",
        status: "disabled",
        title: definition.name,
        trust: "built-in",
        updatedAt: now,
        version: integrationDefinitionDigest(definition),
      };
      const backfillHostedOAuthMetadata = vi.fn(async () => {
        installation = {
          ...installation,
          manifest: { definition: integrationDefinitionSummary(definition) },
        };
        return 1;
      });
      const install = vi.fn();
      const service = platform({
        adapters: [],
        definitions: [definition],
        store: {
          installations: {
            backfillHostedOAuthMetadata,
          } as unknown as IntegrationPlatformStore["installations"],
          install,
          listInstallations: vi.fn(async () => [installation]),
        },
      });
      const actual =
        operation === "startup"
          ? (await service.ensureBuiltIns({ actorUserId: null, requestId: "startup" }))[0]
          : await service.installCatalogDefinition({
              actorUserId: createId("user"),
              definitionId: definition.id,
              digest: integrationDefinitionDigest(definition),
              requestId: "install",
            });

      expect(actual).toEqual(installation);
      expect(actual?.manifest.definition).toMatchObject({ hostedOAuth: definition.hostedOAuth });
      expect(actual?.status).toBe("disabled");
      expect(actual?.revision).toBe(3);
      expect(backfillHostedOAuthMetadata).toHaveBeenCalledExactlyOnceWith([definition]);
      expect(install).not.toHaveBeenCalled();
    },
  );

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
      expect.arrayContaining([expect.objectContaining({ connectionId, name: "query_messages" })]),
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
    const settingsChanged = vi.fn(
      async (_input: { installationId?: string; ownerUserId?: import("@opensteer/core").UserId }) =>
        undefined,
    );
    const service = platform({
      adapters: [testAdapter, createOpenApiAdapter(openApiFetch)],
      onSettingsChanged: settingsChanged,
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
    expect(settingsChanged.mock.calls).toEqual([
      [{ installationId: healthy.id }],
      [{ installationId: failing.id }],
      [{ installationId: failing.id }],
    ]);
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
          code: "folder_unavailable",
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
      code: "folder_unavailable",
      message: expect.stringContaining("may be temporary"),
      retryable: true,
    });
    expect(markAdapterAuthorizationRequired).not.toHaveBeenCalled();
  });

  it("refuses an operation rematerialized since it was listed before credentials or execution", async () => {
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
        message: "Integration operation changed; search again",
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
    const onDeploymentEvent = vi.fn();
    const service = platform({
      adapters: [],
      onDeploymentEvent,
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
    expect(onDeploymentEvent).toHaveBeenCalledWith(event);
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
    const onDeploymentEvent = vi.fn();
    const service = platform({
      adapters: [],
      onDeploymentEvent,
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
    expect(onDeploymentEvent).toHaveBeenCalledWith(event);
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
    const onDeploymentEvent = vi.fn();
    const service = platform({
      adapters: [adapterWithInvoke(async () => ({ kind: "ok", value: {} }))],
      definitions: [definition],
      onDeploymentEvent,
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
    expect(onDeploymentEvent).toHaveBeenCalledWith(installEvent);
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
            code: "folder_unavailable",
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
    ).rejects.toMatchObject({ code: "folder_unavailable", retryable: true });
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
    const onDeploymentEvent = vi.fn();
    const service = platform({
      adapters: [openApiAdapter],
      onDeploymentEvent,
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
    expect(onDeploymentEvent).toHaveBeenNthCalledWith(1, cancelledAccessEvent);
    expect(onDeploymentEvent).toHaveBeenNthCalledWith(2, event);
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
    expect(onDeploymentEvent).toHaveBeenCalledWith(event);
  });
});

describe("IntegrationPlatformService personal access Request fulfillment", () => {
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
    const onDeploymentEvent = vi.fn();
    const service = platform({
      adapters: [],
      materializeForAdapter: vi
        .fn<IntegrationAdapterCredentialMaterializer["materializeForAdapter"]>()
        .mockResolvedValue(materialized),
      onDeploymentEvent,
      store: {
        getConnectionKind: vi.fn(async () => "provider-account" as const),

        isConnectionUsableForAccessRequest: vi.fn(async () => true),
        listCallableTools: vi.fn(async () => [
          {
            ...tool,
            grant: { ...tool.grant, connectionId },
          },
        ]),
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
      service.fulfillSatisfiedAccessRequests({
        connectionId,
        ownerUserId: pending.requestedBy,
      }),
    ).resolves.toEqual([pending.id]);

    expect(resolveIntegrationAccessRequest).toHaveBeenCalledWith({
      providerAuthorizations: {},
      requestId: pending.id,
      resolvedBy: pending.requestedBy,
      response: {
        kind: "external",
        value: {
          connectionId,
          decision: "fulfilled",
          access: "read",
          alias: connectionId,
          isDefault: false,
        },
      },
    });
    expect(onDeploymentEvent).toHaveBeenCalledWith(event);
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

    await service.fulfillSatisfiedAccessRequests({
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
        response: {
          kind: "external",
          value: {
            connectionId,
            decision: "fulfilled",
            access: "read",
            alias: connectionId,
            isDefault: false,
          },
        },
      }),
    );
  });

  it("leaves unsatisfied Requests pending", async () => {
    const connectionId = createIntegrationId("connection");
    const project = integrationRequest("integration.access", "pending");
    const unsatisfied = {
      ...integrationRequest("integration.access", "pending"),
    };
    const resolveIntegrationAccessRequest = vi.fn();

    const service = platform({
      adapters: [],
      store: {
        isConnectionUsableForAccessRequest: vi.fn(async () => false),
        listCallableTools: vi.fn(async () => []),
        requests: {
          listPendingIntegrationAccessRequests: vi.fn(async () => [
            {
              access: "read",
              installationId: createIntegrationId("installation"),
              request: project,
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

    await service.fulfillSatisfiedAccessRequests({
      connectionId,
      ownerUserId: project.requestedBy,
    });

    expect(resolveIntegrationAccessRequest).not.toHaveBeenCalled();
  });

  it("leaves a personal Request pending when the arriving connection fails verification", async () => {
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
      service.fulfillSatisfiedAccessRequests({
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
      service.fulfillSatisfiedAccessRequests({
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

describe("IntegrationPlatformService MCP credential refresh", () => {
  it("rechecks a newer snapshot before closing a client that has since refreshed", async () => {
    let clientRevision = 7;
    const providerFor = vi.fn(async () => {
      const call = providerFor.mock.calls.length;
      if (call === 3) clientRevision = 8;
      return {
        credentialRevision: () => (call === 1 ? clientRevision : 8),
        responseRedactor: () => ({ redactText: (text: string) => text }),
      } as unknown as Awaited<
        ReturnType<IntegrationPlatformTestOptions["mcpOauth"]["providerFor"]>
      >;
    });
    const connect = vi.spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
    const close = vi.spyOn(Client.prototype, "close").mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, "callTool").mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const base = callable();
    const remote: CallableIntegrationTool = {
      ...base,
      server: {
        ...base.server,
        transport: { type: "streamable-http", url: "https://mcp.example.test", headers: {} },
      },
    };
    const service = platform({ adapters: [], mcpOauth: { providerFor } });
    try {
      await service.callTool(remote, {}, caller);
      await service.callTool(remote, {}, caller);
      expect(providerFor).toHaveBeenCalledTimes(3);
      expect(connect).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
    } finally {
      await service.close();
      vi.restoreAllMocks();
    }
  });

  it("replaces a cached client when the stored credential is newer", async () => {
    let revision = 7;
    const providerFor = vi.fn(async () => {
      const snapshot = revision;
      return {
        credentialRevision: () => snapshot,
        responseRedactor: () => ({ redactText: (text: string) => text }),
      } as unknown as Awaited<
        ReturnType<IntegrationPlatformTestOptions["mcpOauth"]["providerFor"]>
      >;
    });
    const connect = vi.spyOn(Client.prototype, "connect").mockResolvedValue(undefined);
    const close = vi.spyOn(Client.prototype, "close").mockResolvedValue(undefined);
    vi.spyOn(Client.prototype, "callTool").mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const base = callable();
    const remote: CallableIntegrationTool = {
      ...base,
      server: {
        ...base.server,
        transport: { type: "streamable-http", url: "https://mcp.example.test", headers: {} },
      },
    };
    const service = platform({ adapters: [], mcpOauth: { providerFor } });
    try {
      await service.callTool(remote, {}, caller);
      revision = 8;
      await service.callTool(remote, {}, caller);
      expect(providerFor).toHaveBeenCalledTimes(4);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await service.close();
      vi.restoreAllMocks();
    }
  });

  it("keeps concurrent calls on a client that refreshed while opening", async () => {
    const opened = Promise.withResolvers<void>();
    let storedRevision = 7;
    let firstRevision = 7;
    let closed = false;
    const providerFor = vi.fn(async () => {
      const snapshot = storedRevision;
      const first = providerFor.mock.calls.length === 1;
      return {
        credentialRevision: () => (first ? firstRevision : snapshot),
        responseRedactor: () => ({ redactText: (text: string) => text }),
      } as unknown as Awaited<
        ReturnType<IntegrationPlatformTestOptions["mcpOauth"]["providerFor"]>
      >;
    });
    const connect = vi.spyOn(Client.prototype, "connect").mockImplementation(async () => {
      await opened.promise;
    });
    const close = vi.spyOn(Client.prototype, "close").mockImplementation(async () => {
      closed = true;
    });
    vi.spyOn(Client.prototype, "callTool").mockImplementation(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (closed) throw new Error("shared client was closed");
      return { content: [{ type: "text", text: "ok" }] };
    });
    const base = callable();
    const remote: CallableIntegrationTool = {
      ...base,
      server: {
        ...base.server,
        transport: { type: "streamable-http", url: "https://mcp.example.test", headers: {} },
      },
    };
    const service = platform({ adapters: [], mcpOauth: { providerFor } });
    try {
      const first = service.callTool(remote, {}, caller);
      await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
      const second = service.callTool(remote, {}, caller);
      await vi.waitFor(() => expect(providerFor).toHaveBeenCalledTimes(2));
      storedRevision = 8;
      firstRevision = 8;
      opened.resolve();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(connect).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
    } finally {
      opened.resolve();
      await service.close();
      vi.restoreAllMocks();
    }
  });
});
