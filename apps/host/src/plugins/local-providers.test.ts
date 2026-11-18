import { expect, it, vi } from "vitest";
import { createId, ToolBlockedError } from "@opensteer/core";
import { resolveIntegrationReadiness } from "@opensteer/integration-core/readiness";
import { deviceDefinitions } from "@opensteer/integration-catalog/devices";
import { computerCallable } from "../devices/device-service.test-support.js";
import { LocalProviders } from "./local-providers.js";

it.each([false, true])(
  "preserves an uncertain local write when the readiness recheck fails=%s",
  async (fails) => {
    const definition = deviceDefinitions.find((definition) => definition.id === "apple-calendar")!;
    const callable = computerCallable("write", definition);
    let failed = false;
    const store = {
      listDiscoveryInventory: async () => {
        if (failed && fails) throw new Error("inventory down");
        const readiness = {
          code: failed ? "ACCESS_GRANT_REQUIRED" : "READY",
          serverId: callable.server.id,
          connectionId: callable.grant.connectionId,
          requiredAccess: failed ? "read-write" : null,
          detail: null,
        };
        return [
          {
            installation: callable.installation,
            servers: [callable.server],
            accounts: [{ connectionId: callable.grant.connectionId }],
            tools: [callable.tool],
            readiness: { servers: [readiness], tools: [{ toolId: callable.tool.id, readiness }] },
          },
        ];
      },
      listCallableTools: async () => (failed ? [] : [callable]),
      getDeviceComputerConnectionForCall: async () => ({
        deviceId: "dev_mac",
        runnerName: "Studio Mac",
        access: "read-write",
      }),
    };
    const providers = new LocalProviders({
      store,
      devices: {
        withAvailability: async (entries: unknown) => entries,
        localDiscoveryFacts: () => ({ connectionFor: store.getDeviceComputerConnectionForCall }),
        callTool: async () => {
          failed = true;
          throw new ToolBlockedError({
            code: "outcome_unknown",
            message: "Outcome unknown. Check whether it happened before trying again.",
            next: "Check the event list before retrying.",
          });
        },
      },
      localServers: {},
      authority: {
        caller: () => ({
          kind: "run",
          userId: createId("user"),
          thread: { id: createId("thread") },
        }),
      },
    } as unknown as ConstructorParameters<typeof LocalProviders>[0]);
    const context = { caller: "test", mode: "automatic" as const };
    const [provider] = await providers.providers(context);
    expect(provider).toBeDefined();
    await expect(
      providers.call(
        {
          ...context,
          execution: "execution",
          plugin: provider!.id,
          tool: callable.tool.name,
          input: {},
        },
        AbortSignal.timeout(5000),
        async () => {
          throw new Error("Unexpected approval");
        },
      ),
    ).resolves.toEqual({
      kind: "blocked",
      blocked: {
        code: "outcome_unknown",
        message: "Outcome unknown. Check whether it happened before trying again.",
        next: "Check the event list before retrying.",
      },
    });
    if (!fails)
      expect(await providers.providers(context)).toMatchObject([
        {
          blocked: {
            code: "access_required",
            next: expect.stringContaining('"dataApp":"calendar"'),
          },
        },
      ]);
  },
);

it.each([false, true])(
  "keeps readable operations usable and explains task ceilings for local server=%s",
  async (server) => {
    const definition = deviceDefinitions.find((definition) => definition.id === "apple-calendar")!;
    const callable = computerCallable("read", definition);
    const computerServer = server
      ? {
          ...callable.server,
          transport: { type: "runner", runnerId: "run_mac" },
          connectionRequirement: { kind: "none" as const },
        }
      : callable.server;
    const connectionId = server ? null : callable.grant.connectionId;
    const read = { ...callable.tool, connectionId };
    const write = {
      ...read,
      id: "tool_write",
      name: "create_event",
      annotations: { readOnlyHint: false },
    };
    const ready = (access: "read" | "read-write") =>
      resolveIntegrationReadiness({
        connectionRequirement: computerServer.connectionRequirement,
        connections: connectionId
          ? [
              {
                id: connectionId,
                connectionKind: "computer",
                definitionId: definition.id,
                status: "connected",
                integrationServerId: computerServer.id,
              },
            ]
          : [],
        hasAccess: () => true,
        runAccess: "read",
        installationStatus: "active",
        requiredAccess: access,
        requiredConnectionId: connectionId,
        serverId: computerServer.id,
        serverStatus: "active",
      });
    const store = {
      listDiscoveryInventory: vi.fn(async () => [
        {
          installation: callable.installation,
          servers: [computerServer],
          accounts: connectionId ? [{ connectionId }] : [],
          // A read-approved data app has no persisted write row; a server has all its tool rows.
          tools: server ? [read, write] : [read],
          readiness: {
            servers: [ready("read")],
            forTarget: (_server: string, target: { access: "read" | "read-write" }) =>
              ready(target.access),
            tools: [
              { toolId: read.id, readiness: ready("read") },
              ...(server ? [{ toolId: write.id, readiness: ready("read-write") }] : []),
            ],
          },
        },
      ]),
      listCallableTools: async () => [
        {
          ...callable,
          server: computerServer,
          tool: read,
          grant: { ...callable.grant, connectionId },
        },
      ],
      getDeviceComputerConnectionForCall: async () => ({
        deviceId: "dev_mac",
        runnerName: "Studio Mac",
        access: "read",
      }),
      getToolSchemas: async () => ({ inputSchema: { type: "object" } }),
      localMcp: { list: async () => [] },
    };
    const providers = new LocalProviders({
      store,
      devices: {
        withAvailability: async (entries: unknown) => entries,
        localDiscoveryFacts: () => ({
          connectionFor: store.getDeviceComputerConnectionForCall,
          localServers: store.localMcp.list,
        }),
      },
      localServers: {},
      authority: {
        caller: () => ({
          kind: "run",
          userId: createId("user"),
          thread: { id: createId("thread") },
        }),
      },
    } as unknown as ConstructorParameters<typeof LocalProviders>[0]);
    const context = { caller: "test", mode: "automatic" as const };
    const [provider] = await providers.providers(context);
    expect(store.listDiscoveryInventory).toHaveBeenCalledTimes(1);
    expect(provider?.unavailable).toBeUndefined();
    expect(provider?.tools.find((tool) => tool.name === read.name)?.description).not.toContain(
      "Blocked",
    );
    expect(provider?.tools.find((tool) => tool.name === "create_event")?.description).toContain(
      "another app or server grant cannot raise this task's ceiling",
    );
    expect(provider?.toolBlockers).toMatchObject({
      create_event: {
        code: "read_only_task",
        next: expect.stringContaining("task's access mode"),
      },
    });
    expect(provider?.toolBlockers).not.toHaveProperty(read.name);
    await expect(
      providers.call(
        {
          ...context,
          execution: "execution",
          plugin: provider!.id,
          tool: "create_event",
          input: {},
        },
        AbortSignal.timeout(5000),
        async () => {
          throw new Error("Unexpected approval");
        },
      ),
    ).resolves.toMatchObject({
      kind: "blocked",
      blocked: { code: "read_only_task", next: expect.stringContaining("task's ceiling") },
    });
  },
);

const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
it.each([
  { content: [image] },
  {
    content: [
      { type: "text", text: "Report" },
      image,
      { type: "resource", resource: { uri: "fixture:///report", text: "Attached" } },
    ],
    structuredContent: { rows: 2 },
  },
])("passes the sanitized MCP blocks and structured payload through the provider", async (mcp) => {
  const definition = deviceDefinitions.find((definition) => definition.id === "apple-calendar")!;
  const base = computerCallable("read", definition);
  const server = { ...base.server, transport: { type: "runner", runnerId: "run_mac" } };
  const tool = { ...base.tool, connectionId: null };
  const readiness = { code: "READY", serverId: server.id };
  const providers = new LocalProviders({
    store: {
      listDiscoveryInventory: async () => [
        {
          installation: base.installation,
          servers: [server],
          accounts: [],
          tools: [tool],
          readiness: { servers: [readiness], tools: [{ toolId: tool.id, readiness }] },
        },
      ],
      listCallableTools: async () => [
        { ...base, server, tool, grant: { ...base.grant, connectionId: null } },
      ],
      getToolSchemas: async () => ({ inputSchema: { type: "object" } }),
      localMcp: { list: async () => [] },
    },
    devices: {
      withAvailability: async (entries: unknown) => entries,
      localDiscoveryFacts: () => ({ localServers: async () => [] }),
    },
    localServers: { callTool: async () => mcp },
    authority: {
      caller: () => ({ kind: "run", userId: createId("user"), thread: { id: createId("thread") } }),
    },
  } as unknown as ConstructorParameters<typeof LocalProviders>[0]);
  const result = await providers.call(
    {
      caller: "fixture",
      mode: "automatic",
      execution: "fixture",
      plugin: `app_server_${server.id}`,
      tool: tool.name,
      input: {},
    },
    AbortSignal.timeout(5_000),
    async () => {
      throw new Error("Unexpected approval");
    },
  );
  expect(result).toEqual({ kind: "mcp", result: mcp });
});

it("lists the owner’s tool metadata without loading tool schemas", async () => {
  const definition = deviceDefinitions.find(({ id }) => id === "apple-calendar")!;
  const base = computerCallable("read", definition);
  const server = { ...base.server, transport: { type: "runner", runnerId: "run_mac" } };
  const tool = { ...base.tool, connectionId: null };
  const readiness = { code: "READY", serverId: server.id };
  const getToolSchemas = vi.fn(async () => null);
  const providers = new LocalProviders({
    store: {
      listDiscoveryInventory: async () => [
        {
          installation: base.installation,
          servers: [server],
          accounts: [],
          tools: [tool],
          readiness: { servers: [readiness], tools: [{ toolId: tool.id, readiness }] },
        },
      ],
      listCallableTools: async () => [
        { ...base, server, tool, grant: { ...base.grant, connectionId: null } },
      ],
      getToolSchemas,
    },
    devices: {
      withAvailability: async (entries: unknown) => entries,
      localDiscoveryFacts: () => ({ localServers: async () => [] }),
    },
  } as unknown as ConstructorParameters<typeof LocalProviders>[0]);
  expect(await providers.owned(createId("user"))).toMatchObject([
    { id: `app_server_${server.id}`, tools: [{ name: tool.name, readOnly: true }] },
  ]);
  expect(getToolSchemas).not.toHaveBeenCalled();
});
