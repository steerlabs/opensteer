import { expect, it, vi } from "vitest";
import { createId, DeviceIdSchema, ToolBlockedError } from "@opensteer/core";
import { DeviceAccessRefusal } from "../administration/device-access.js";
import { resolveIntegrationReadiness } from "@opensteer/integration-core/readiness";
import { deviceDefinitions } from "@opensteer/integration-catalog/devices";
import { isComputerAppDefinition } from "@opensteer/integration-core/computer-app";
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
    expect(provider?.blocked).toBeUndefined();
    // The reason is said once, in the tool's blocker; its description stays its own.
    for (const tool of provider?.tools ?? [])
      expect(tool.description).not.toMatch(/Blocked|ceiling/u);
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

it.each([
  ["READY", null, null],
  ["INTEGRATION_UNAVAILABLE", "Main computer is offline.", "Main computer is offline."],
  ["ACCESS_GRANT_REQUIRED", null, "Agents need access. Request it from a task."],
] as const)(
  "lists the owner’s %s server without loading tool schemas",
  async (code, detail, unavailable) => {
    const definition = deviceDefinitions.find(({ id }) => id === "apple-calendar")!;
    const base = computerCallable("read", definition);
    const server = { ...base.server, transport: { type: "runner", runnerId: "run_mac" } };
    const tool = { ...base.tool, connectionId: null };
    const readiness = {
      code,
      detail,
      requiredAccess: code === "ACCESS_GRANT_REQUIRED" ? "read" : null,
      serverId: server.id,
    };
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
      {
        id: `app_server_${server.id}`,
        unavailable,
        tools: unavailable ? [] : [{ name: tool.name, readOnly: true }],
      },
    ]);
    expect(getToolSchemas).not.toHaveBeenCalled();
  },
);

it.each([
  [
    "without a grant",
    {
      code: "ACCESS_GRANT_REQUIRED",
      detail: null,
      requiredAccess: "read",
    },
    { code: "access_required", next: expect.stringContaining("app_access_request") },
  ],
  [
    "needing an update",
    {
      code: "INTEGRATION_UNAVAILABLE",
      detail: "Update Opensteer on Test iPhone to use its apps.",
      requiredAccess: null,
    },
    {
      code: "unavailable",
      message: "Update Opensteer on Test iPhone to use its apps.",
      next: "The person finishes this on Test iPhone. Tell them what the message says, and continue without Calendar on Test iPhone until then.",
    },
  ],
] as const)(
  "lists a device app %s with its tools and one blocker, and refuses its calls so",
  async (_, state, expected) => {
    const definition = deviceDefinitions.find(({ id }) => id === "apple-calendar")!;
    const callable = computerCallable("read", definition);
    const readiness = {
      ...state,
      serverId: callable.server.id,
      connectionId: callable.grant.connectionId,
    };
    const store = {
      listDiscoveryInventory: async () => [
        {
          installation: callable.installation,
          servers: [callable.server],
          accounts: [{ connectionId: callable.grant.connectionId }],
          tools: [callable.tool],
          readiness: { servers: [readiness], tools: [{ toolId: callable.tool.id, readiness }] },
        },
      ],
      listCallableTools: async () => [],
      getDeviceComputerConnectionForCall: async () => ({
        deviceId: "dev_phone",
        runnerName: "Test iPhone",
        access: "read",
      }),
    };
    const callTool = vi.fn();
    const providers = new LocalProviders({
      store,
      devices: {
        withAvailability: async (entries: unknown) => entries,
        localDiscoveryFacts: () => ({ connectionFor: store.getDeviceComputerConnectionForCall }),
        localDeviceAccessBlocked: async () => undefined,
        callTool,
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
    expect(provider).toMatchObject({ blocked: expected });
    expect(provider).not.toHaveProperty("toolBlockers");
    // Its tools come from Opensteer's definition, whatever keeps them now.
    if (!isComputerAppDefinition(definition)) throw new Error("Calendar is a computer app");
    expect(provider!.tools.map(({ name }) => name)).toEqual(
      definition.config.operations.map(({ name }) => name),
    );
    for (const tool of provider!.tools)
      expect(tool.description).not.toContain(provider!.blocked!.message);
    expect(
      await providers.call(
        {
          ...context,
          execution: "execution",
          plugin: provider!.id,
          tool: callable.tool.name,
          input: {},
        },
        AbortSignal.timeout(5_000),
        async () => {
          throw new Error("Unexpected approval");
        },
      ),
    ).toEqual({ kind: "blocked", blocked: provider!.blocked });
    expect(callTool).not.toHaveBeenCalled();
  },
);

it("lists a server awaiting its approved launch as blocked, and refuses its calls so", async () => {
  const definition = deviceDefinitions.find(({ id }) => id === "apple-calendar")!;
  const base = computerCallable("read", definition);
  const server = { ...base.server, transport: { type: "runner", runnerId: "run_mac" } };
  const tool = { ...base.tool, connectionId: null };
  const readiness = { code: "READY", serverId: server.id, connectionId: null };
  const callTool = vi.fn();
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
    },
    devices: {
      withAvailability: async (entries: unknown) => entries,
      localDiscoveryFacts: () => ({
        localServers: async () => [
          {
            id: server.id,
            approvedLaunchDigest: "approved",
            launchDigest: "changed",
            declined: false,
            status: "needs-attention",
            deviceId: "dev_mac",
            runnerName: "Studio Mac",
            statusDetail: "Waiting for approval on the computer that runs it.",
            installationTitle: "Living Room TV",
            pluginName: "living-room-tv",
          },
        ],
      }),
    },
    localServers: { callTool },
    authority: {
      caller: () => ({ kind: "run", userId: createId("user"), thread: { id: createId("thread") } }),
    },
  } as unknown as ConstructorParameters<typeof LocalProviders>[0]);
  const context = { caller: "test", mode: "automatic" as const };
  const [provider] = await providers.providers(context);
  const waiting = {
    code: "setup_required",
    message: "Waiting for approval on the computer that runs it.",
    next: "Wait for the person to review it on the computer that runs it.",
  };
  expect(provider).toMatchObject({ blocked: waiting, tools: [{ name: tool.name }] });
  expect(
    await providers.call(
      { ...context, execution: "execution", plugin: provider!.id, tool: tool.name, input: {} },
      AbortSignal.timeout(5_000),
      async () => {
        throw new Error("Unexpected approval");
      },
    ),
  ).toEqual({ kind: "blocked", blocked: waiting });
  expect(callTool).not.toHaveBeenCalled();
});

it.each([
  ["a connected agent", true],
  ["a task of the person's", false],
] as const)("words the apps switch turned off mid-call for %s", async (_, connection) => {
  const definition = deviceDefinitions.find((definition) => definition.id === "apple-calendar")!;
  const callable = computerCallable("read", definition);
  const readiness = {
    code: "READY",
    serverId: callable.server.id,
    connectionId: callable.grant.connectionId,
    requiredAccess: null,
    detail: null,
  };
  const store = {
    listDiscoveryInventory: async () => [
      {
        installation: callable.installation,
        servers: [callable.server],
        accounts: [{ connectionId: callable.grant.connectionId }],
        tools: [callable.tool],
        readiness: { servers: [readiness], tools: [{ toolId: callable.tool.id, readiness }] },
      },
    ],
    listCallableTools: async () => [callable],
    getDeviceComputerConnectionForCall: async () => ({
      deviceId: "dev_mac",
      runnerName: "Studio Mac",
      access: "read",
    }),
  };
  const userId = createId("user");
  const providers = new LocalProviders({
    store,
    devices: {
      withAvailability: async (entries: unknown) => entries,
      localDiscoveryFacts: () => ({ connectionFor: store.getDeviceComputerConnectionForCall }),
      // The person turns the Mac's apps off after the call was admitted, before it is sent.
      callTool: async () => {
        throw new DeviceAccessRefusal(
          "device-access-off",
          DeviceIdSchema.parse(createId("runner")),
          "apps",
          "Studio Mac",
        );
      },
    },
    localServers: {},
    authority: {
      caller: () =>
        connection
          ? { kind: "connection", userId, connectionId: "connection", key: "connection:x" }
          : { kind: "run", userId, thread: { id: createId("thread") } },
      session: () =>
        connection
          ? { operation: { bindingId: "session:x", taskId: createId("thread") } }
          : undefined,
    },
  } as unknown as ConstructorParameters<typeof LocalProviders>[0]);
  const context = { caller: "test", mode: "automatic" as const };
  const [provider] = await providers.providers(context);
  const called = await providers.call(
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
  );
  expect(called).toMatchObject({
    kind: "blocked",
    blocked: {
      message: connection
        ? "Apps access is off on Studio Mac. The person can turn it on in Opensteer."
        : "apps is off. Use computer_access_request if needed.",
    },
  });
  if (connection) expect(JSON.stringify(called)).not.toContain("computer_access_request");
});
