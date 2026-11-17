import { expect, it } from "vitest";
import { createId, OpensteerError } from "@opensteer/core";
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
        callTool: async () => {
          failed = true;
          throw new OpensteerError({
            code: "harness_error",
            message: "Outcome unknown. Check whether it happened before trying again.",
            next: "Check the event list before retrying.",
            retryable: false,
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
    ).rejects.toMatchObject({
      message: fails
        ? "Outcome unknown. Check whether it happened before trying again. Check the event list before retrying."
        : expect.stringMatching(/Outcome unknown.*Check the event list.*app_access_request/s),
    });
    if (!fails)
      expect(await providers.blockers(context)).toMatchObject([
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
      listDiscoveryInventory: async (request: { target?: { access: "read" | "read-write" } }) => [
        {
          installation: callable.installation,
          servers: [computerServer],
          accounts: connectionId ? [{ connectionId }] : [],
          // A read-approved data app has no persisted write row; a server has all its tool rows.
          tools: server ? [read, write] : [read],
          readiness: {
            servers: [ready(request.target?.access ?? "read")],
            tools: [
              { toolId: read.id, readiness: ready("read") },
              ...(server ? [{ toolId: write.id, readiness: ready("read-write") }] : []),
            ],
          },
        },
      ],
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
      localMcp: { computerName: async () => "Studio Mac" },
    };
    const providers = new LocalProviders({
      store,
      devices: { withAvailability: async (entries: unknown) => entries },
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
    expect(provider?.unavailable).toBeUndefined();
    expect(provider?.tools.find((tool) => tool.name === read.name)?.description).not.toContain(
      "Blocked",
    );
    expect(provider?.tools.find((tool) => tool.name === "create_event")?.description).toContain(
      "another app or server grant cannot raise this task's ceiling",
    );
    const blockers = await providers.blockers(context);
    expect(blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining("create_event"),
          blocked: expect.objectContaining({
            code: "read_only_task",
            next: expect.stringContaining("task's access mode"),
          }),
        }),
      ]),
    );
    expect(blockers.some((blocker) => blocker.path?.endsWith(read.name))).toBe(false);
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
    ).rejects.toMatchObject({ message: expect.stringContaining("task's ceiling") });
  },
);
