import { describeStore } from "@opensteer/database/test-support/store";
import { IntegrationPlatformStore } from "@opensteer/database";
import { createIntegrationId } from "@opensteer/integration-core";
import { expect, vi } from "vitest";
import { IntegrationToolHandlers } from "../mcp/handlers/integrations.js";
import type { AgentCaller } from "../mcp/agent-caller.js";
import type { IntegrationPlatformService } from "./integration-platform-service.js";

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
    });
    const caller = {
      kind: "run",
      key: `run:${run.run.id}`,
      userId: run.userId,
      accessMode: run.thread.accessMode,
      reach: { kind: "user" },
      thread: run.thread,
      claims: {
        requestedBy: run.userId,

        threadId: run.thread.id,
        runId: run.run.id,
      },
    } as unknown as AgentCaller;
    const listCallableTools = () =>
      store.listCallableTools({
        ownerUserId: run.userId,

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

          threadId: run.thread.id,
          providerAuthorizations: {},
        }),
    } as unknown as IntegrationPlatformService;
    const handlers = new IntegrationToolHandlers({
      definitions: [],
      onEvent: () => undefined,
      platform,
    });
    if (!issued) throw new Error("Issued tool missing");
    const call = () =>
      handlers.integration_call({
        caller,
        input: {
          ...(issued.grant.connectionId ? { account: issued.grant.connectionId } : {}),
          arguments: {},
          operation: issued.tool.name,
        },
        operationKey: "call",
        signal: AbortSignal.timeout(5000),
      });
    expect(await call()).toMatchObject({ content: [{ text: "called" }] });
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
    await expect(call()).rejects.toThrow("Integration operation is no longer available");
    expect(callTool).toHaveBeenCalledTimes(1);
    await store.settings.setEnabled(run.userId, {
      type: "settings.plugin.enabled.set",
      target,
      expectedRevision: await revision(),
      enabled: true,
      idempotencyKey: "on",
    });
    expect(await call()).toMatchObject({ content: [{ text: "called" }] });
    expect(callTool).toHaveBeenCalledTimes(2);
  });
});
