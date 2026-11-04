import { describeStore } from "@opensteer/database/test-support/store";
import { IntegrationPlatformStore } from "@opensteer/database";
import { createIntegrationId } from "@opensteer/integration-core";
import { expect, vi } from "vitest";
import {
  IntegrationToolsMcpService,
  type IntegrationToolsRunScope,
  type IntegrationToolsTokenService,
  type TriggerIntegrationToolsTokenService,
} from "./integration-tools-mcp-service.js";
import type { IntegrationPlatformService } from "./integration-platform-service.js";

const gateway = vi.hoisted(() => ({
  call: undefined as
    | undefined
    | ((
        request: { params: { name: string; arguments: unknown } },
        extra: { authInfo: { extra: { scope: IntegrationToolsRunScope } }; signal: AbortSignal },
      ) => Promise<unknown>),
}));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class {
    setRequestHandler(
      schema: { shape?: { method?: { value?: string } } },
      handler: typeof gateway.call,
    ) {
      if (schema.shape?.method?.value === "tools/call") gateway.call = handler;
    }
    async close() {}
  },
}));

describeStore("Settings invocation admission", (test) => {
  test("an issued tool reference cannot invoke after Off or Main exclusion", async ({
    storeFixture: f,
  }) => {
    const run = await f.startRunFixture("settings-issued-identity");
    const store = new IntegrationPlatformStore(f.database);
    const installationId = createIntegrationId("installation");
    await store.install({
      actorUserId: run.userId,
      adapterSnapshot: null,
      requestId: "install",
      installation: {
        id: installationId,
        name: "records",
        title: "Records",
        description: "",
        version: "1",
        sourceKind: "built-in",
        status: "active",
        trust: "built-in",
        manifest: { definition: { id: "records" } },
        provenance: {},
      },
      servers: [
        {
          id: createIntegrationId("server"),
          name: "default",
          status: "active",
          statusDetail: null,
          connectionRequirement: { kind: "none" },
          transport: { type: "streamable-http", url: "https://records.example/mcp", headers: {} },
          catalog: {
            definitions: {},
            tools: [
              {
                id: createIntegrationId("tool"),
                name: "read",
                title: "Read",
                description: "",
                annotations: { readOnlyHint: true },
                connectionId: null,
                inputSchema: { type: "object" },
                outputSchema: null,
                status: "active",
              },
            ],
          },
        },
      ],
    });
    await store.createGrant({
      access: "read",
      alias: "records",
      connectionId: null,
      createdBy: run.userId,
      installationId,
      isDefault: true,
      ownerUserId: run.userId,
      providerAuthorizations: {},
      workspaceId: run.workspace.id,
    });
    const scope = {
      requestedBy: run.userId,
      workspaceId: run.workspace.id,
      threadId: run.thread.id,
      runId: run.run.id,
    } as unknown as IntegrationToolsRunScope;
    const listCallableTools = () =>
      store.listCallableTools({
        ownerUserId: run.userId,
        workspaceId: run.workspace.id,
        threadId: run.thread.id,
        providerAuthorizations: {},
      });
    const [issued] = await listCallableTools();
    expect(issued).toBeDefined();
    const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "called" }] }));
    const platform = {
      store,
      listCallableTools,
      callTool,
      listDiscoveryInventory: () =>
        store.listDiscoveryInventory({
          ownerUserId: run.userId,
          workspaceId: run.workspace.id,
          threadId: run.thread.id,
          providerAuthorizations: {},
        }),
    } as unknown as IntegrationPlatformService;
    const mcp = new IntegrationToolsMcpService({
      definitions: [],
      getWorkspaceForOwner: async () => ({ id: run.workspace.id }),
      runTokens: {} as IntegrationToolsTokenService,
      triggerTokens: {} as TriggerIntegrationToolsTokenService,
      onWorkspaceEvent: () => undefined,
      platform,
      publicUrl: new URL("http://localhost/mcp"),
    });
    const server = mcp.createServer(scope);
    try {
      if (!gateway.call || !issued) throw new Error("MCP call handler or issued tool missing");
      const request = {
        params: {
          name: "integration_call",
          arguments: {
            toolRef: `${issued.grant.id}.${issued.tool.id}.${issued.tool.schemaDigest}`,
            arguments: {},
          },
        },
      };
      const extra = { authInfo: { extra: { scope } }, signal: AbortSignal.timeout(5000) };
      expect(await gateway.call(request, extra)).toMatchObject({ content: [{ text: "called" }] });
      expect(callTool).toHaveBeenCalledTimes(1);
      const target = { kind: "service" as const, definitionId: "records" };
      const revision = async () =>
        (await store.settings.detail(run.userId, target)).row.placement.revision;
      await store.settings.setEnabled(run.userId, {
        type: "settings.plugin.enabled.set",
        target,
        expectedRevision: await revision(),
        enabled: false,
        idempotencyKey: "off",
      });
      expect(await gateway.call(request, extra)).toMatchObject({ isError: true });
      expect(callTool).toHaveBeenCalledTimes(1);
      await store.settings.setEnabled(run.userId, {
        type: "settings.plugin.enabled.set",
        target,
        expectedRevision: await revision(),
        enabled: true,
        idempotencyKey: "on",
      });
      expect(await gateway.call(request, extra)).toMatchObject({ content: [{ text: "called" }] });
      await store.settings.setPlacement(
        run.userId,
        {
          type: "settings.plugin.placement.set",
          target,
          expectedRevision: await revision(),
          mainIncluded: false,
          projects: [],
          personalEverywhere: null,
          idempotencyKey: "exclude-main",
        },
        {},
      );
      expect(await gateway.call(request, extra)).toMatchObject({ isError: true });
      expect(callTool).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
      await mcp.close();
    }
  });
});
