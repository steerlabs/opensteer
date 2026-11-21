import { createId, DeviceIdSchema, emptyExecutionPreferences, type Thread } from "@opensteer/core";
import { type OpensteerStore } from "@opensteer/database";
import { createIntegrationId } from "@opensteer/integration-core";
import { machineAccessPolicyDefault } from "@opensteer/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AdministrationService,
  type AdministrationDependencies,
} from "../administration/administration-service.js";
import {
  AdministrationToolHandlers,
  administrationToolHandlers,
} from "./handlers/administration.js";
import type { AgentToolHandlers } from "./handlers/types.js";
import type { AgentCaller } from "./agent-caller.js";
import { OpensteerMcpService } from "./opensteer-mcp-service.js";
import { localServerToolHandlers } from "./handlers/local-servers.js";
import type { LocalServerRegistry } from "../local-servers/local-server-registry.js";

const userId = createId("user");
let owner: Awaited<
  ReturnType<typeof import("../runtime/personal-owner.test-support.js").createPersonalOwnerFixture>
>;
beforeAll(async () => {
  owner = await (
    await import("../runtime/personal-owner.test-support.js")
  ).createPersonalOwnerFixture(userId);
});
afterAll(async () => {
  await owner?.close();
});
function fixture() {
  const environmentId = createId("environment"),
    harnessInstanceId = createId("harnessInstance"),
    machineId = createId("runner"),
    profileId = createId("browserProfile"),
    grantId = crypto.randomUUID();
  const deviceId = DeviceIdSchema.parse(machineId);
  const connectionId = createIntegrationId("connection");
  const harness = {
    id: harnessInstanceId,
    environmentId,
    name: "Engine",
    driverKind: "codex",
    enabled: true,
    isDefault: true,
    config: { apiKey: "secret", models: {} },
    runtimeRevision: 1,
    sourceId: "own",
    stateKind: "ambient",
  };
  let caller: AgentCaller = {
    kind: "connection",
    grant: { scope: "everything" },
    grantRevision: 1,
    key: "connection:test",
    connectionId: "test",
    userId,

    accessMode: "full-access",
  };
  const realtime = { broadcast: vi.fn(), publish: vi.fn(), publishNotificationPreference: vi.fn() };
  const store = {
    database: owner.database,
    replayAdministrationCommand: vi.fn(async () => undefined),

    listEnvironmentsForUser: vi.fn(async () => [
      { id: environmentId, kind: "local", runnerId: machineId },
    ]),
    listAgentHarnessInstancesForUser: vi.fn(async () => [harness]),
    listHarnessInstances: vi.fn(async () => [harness]),
    getHarnessInstance: vi.fn(async () => harness),
    updateHarnessInstance: vi.fn(async () => harness),
    getExecutionPreferences: vi.fn(async () => emptyExecutionPreferences),
    rememberExecutionChoice: vi.fn(async () => ({
      ...emptyExecutionPreferences,
      accessMode: "approval-required",
    })),
    listDevices: vi.fn<OpensteerStore["listDevices"]>(async () => ({
      devices: [
        {
          id: deviceId,
          deploymentId: owner.deployment.id,
          name: "Mac",
          kind: "home",
          platform: "macos",
          form: "desktop",
          ownerKind: "user",
          ownerUserId: userId,
          accessPolicy: machineAccessPolicyDefault,
          accessPolicyRevision: 1,
          removedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      nextCursor: null,
    })),
    listDeviceDrivers: vi.fn<OpensteerStore["listDeviceDrivers"]>(async () => [
      { deviceId, runnerId: machineId, role: "self", generation: 1, detachedAt: null },
    ]),
    listRunners: vi.fn(async () => ({
      runners: [
        {
          id: machineId,
          name: "Mac",
          lastSeenAt: null,
          revokedAt: null,
          kind: "local",
          ownerKind: "user",
          capabilities: ["shell"],
          accessPolicy: { reach: "nobody", commands: false, forwarding: false, shares: [] },
          allowedModules: [],
          moduleDescriptors: {},
        },
      ],
      nextCursor: null,
    })),
    effectiveMachineOwner: vi.fn(async () => ({ effectiveOwner: userId })),
    listActiveShellSessions: vi.fn(async () => []),

    renameDevice: vi.fn<OpensteerStore["renameDevice"]>(),
    notificationState: {
      timeZoneFor: vi.fn(async () => null),
      setTimeZone: vi.fn(async () => "UTC"),
    },
    ownerProfile: { read: vi.fn(async () => ({ ownerId: userId, name: "Ada", account: null })) },
  };
  const deps = {
    integrations: { devices: { deviceConnections: async () => [] } },
    store,
    realtime,
    channels: {
      service: {
        setConnectionStatus: vi.fn(),
        dashboard: vi.fn(async () => ({ connections: [], accounts: [], bindings: [] })),
      },
    },
    browser: {
      renameProfile: vi.fn(async () => ({ id: profileId, name: "Work", token: "secret" })),
      listAgentProfiles: vi.fn(async () => [{ id: profileId, name: "Work", home: null }]),
    },
    browserSources: { listState: vi.fn(async () => ({ sources: [], sites: [] })) },
    runners: {
      isRunnerConnected: vi.fn(() => true),
      asleepSince: vi.fn(() => null),
      agentsStoppedSince: vi.fn(() => null),
      moduleReadiness: vi.fn(() => undefined),
    },
    computerApps: {
      status: vi.fn(() => []),
      attached: vi.fn(() => false),
      deviceStatus: vi.fn(() => null),
    },
  };
  const service = new AdministrationService(deps as unknown as AdministrationDependencies, vi.fn());
  const handlers = {
    ...administrationToolHandlers(
      new AdministrationToolHandlers(service, (id) => id === environmentId),
    ),
    ...localServerToolHandlers({
      remove: vi.fn(async () => ({ ok: true as const })),
      list: async () => [],
    } as unknown as LocalServerRegistry),
  };
  const mcp = new OpensteerMcpService({
    callers: { authenticate: async () => caller },
    handlers: handlers as AgentToolHandlers,
    publicUrl: new URL("http://127.0.0.1"),
    store: {} as never,
  });
  const inputs = {
    opensteer_ai_account_update: {
      aiAccountId: harnessInstanceId,
      action: "rename",
      name: "Engine",
    },
    computer_update: { computerId: machineId, name: "Mac" },
    local_server_remove: { name: "tv" },
    opensteer_messaging_bridge_update: { bridgeId: connectionId, paused: true },
    browser_profile_update: { profileId, name: "Work" },
  };
  const asNativeRun = () => {
    caller = {
      kind: "run",
      key: "run:test",
      userId,
      accessMode: caller.accessMode,
      thread: { id: createId("thread") } as Thread,
      claims: {} as never,
    };
  };
  return {
    mcp,
    service,
    deps,
    inputs,
    profileId,
    grantId,
    userId,
    machineId,
    caller: () => caller,
    asNativeRun,
    setCaller: (value: AgentCaller) => {
      caller = value;
    },
  };
}
const mutations = [
  "opensteer_ai_account_update",
  "computer_update",
  "local_server_remove",
  "opensteer_messaging_bridge_update",
  "browser_profile_update",
] as const;
const reads = ["computer_list", "browser_profile_list", "local_server_list"] as const;
async function expectRemoved(
  f: ReturnType<typeof fixture>,
  name: string,
  input: Record<string, unknown>,
) {
  const options = { operationKey: "verify-removed" };
  const removed = await f.mcp.callToolResult("token", name, input, options);
  const unknown = await f.mcp.callToolResult("token", "unknown_fixture_tool", input, options);
  expect(JSON.stringify(removed)).toBe(JSON.stringify(unknown));
  expect(removed).toMatchObject({
    isError: true,
    structuredContent: { error: { code: "not_found" } },
  });
}

describe("administration through the MCP service", () => {
  it.each(mutations)("executes %s for a full-access Run only", async (name) => {
    const f = fixture();
    await expectRemoved(f, name, f.inputs[name]);
    f.setCaller({ ...f.caller(), accessMode: "approval-required" });
    await expectRemoved(f, name, f.inputs[name]);
    f.setCaller({ ...f.caller(), accessMode: "full-access" });
    f.asNativeRun();
    expect(
      await f.mcp.callTool("token", name, f.inputs[name], { operationKey: "write" }),
    ).toMatchObject({ ok: true });
    f.setCaller({ ...f.caller(), accessMode: "approval-required" });
    await expect(
      f.mcp.callTool("token", name, f.inputs[name], { operationKey: "write" }),
    ).rejects.toThrow("Changing settings requires full-access");
  });
  it.each(reads)("allows %s for a Run without full access", async (name) => {
    const f = fixture();
    await expectRemoved(f, name, {});
    f.asNativeRun();
    f.setCaller({ ...f.caller(), accessMode: "approval-required" });
    expect(await f.mcp.callTool("token", name, {}, { operationKey: "read" })).toBeDefined();
  });
  it.each(["opensteer_defaults_read", "opensteer_messaging_bridge_list"])(
    "keeps the person's settings read %s available to Runs only",
    async (name) => {
      const f = fixture();
      await expectRemoved(f, name, {});
      f.setCaller({ ...f.caller(), accessMode: "approval-required" });
      await expectRemoved(f, name, {});
      f.asNativeRun();
      expect(await f.mcp.callTool("token", name, {}, { operationKey: "read" })).toBeDefined();
      f.setCaller({ ...f.caller(), accessMode: "full-access" });
      expect(await f.mcp.callTool("token", name, {}, { operationKey: "read" })).toBeDefined();
    },
  );
  it("names the hosting computer once, by the same ID as its tools", async () => {
    const f = fixture();
    await expectRemoved(f, "computer_list", {});
    f.asNativeRun();
    expect(
      await f.mcp.callTool("token", "computer_list", {}, { operationKey: "computers" }),
    ).toMatchObject({
      computers: [{ computerId: f.machineId, hosting: true, canRunTasks: true }],
    });
  });
  it("remembers an access preference without changing the caller's authority", async () => {
    const f = fixture();
    await expectRemoved(f, "opensteer_defaults_update", { accessMode: "approval-required" });
    f.setCaller({ ...f.caller(), accessMode: "approval-required" });
    await expectRemoved(f, "opensteer_defaults_update", { accessMode: "full-access" });
    f.setCaller({ ...f.caller(), accessMode: "full-access" });
    f.asNativeRun();
    await f.mcp.callTool(
      "token",
      "opensteer_defaults_update",
      { accessMode: "approval-required" },
      { operationKey: "preference" },
    );
    expect(f.deps.store.rememberExecutionChoice).toHaveBeenCalledWith(
      f.userId,
      {
        accessMode: "approval-required",
      },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(f.caller().accessMode).toBe("full-access");
    f.setCaller({ ...f.caller(), accessMode: "approval-required" });
    await expect(
      f.mcp.callTool(
        "token",
        "opensteer_defaults_update",
        { accessMode: "full-access" },
        { operationKey: "raise" },
      ),
    ).rejects.toThrow("Changing settings requires full-access");
    expect(f.deps.store.rememberExecutionChoice).toHaveBeenCalledOnce();
  });
  it("strips provider config and browser session tokens", async () => {
    const f = fixture();
    await expectRemoved(f, "opensteer_defaults_read", {});
    await expectRemoved(f, "browser_profile_update", f.inputs.browser_profile_update);
    f.asNativeRun();
    for (const [name, input] of [
      ["opensteer_defaults_read", {}],
      ["browser_profile_update", f.inputs.browser_profile_update],
    ] as const) {
      expect(
        JSON.stringify(await f.mcp.callTool("token", name, input, { operationKey: name })),
      ).not.toMatch(/secret|apiKey|config|token/);
    }
  });
  it("applies the same administration to a Run without requiring a fake person session", async () => {
    const f = fixture();
    const base = f.caller();
    f.setCaller({ ...base, kind: "run", thread: {} as Thread, claims: {} as never });
    await f.mcp.callTool("token", "computer_update", f.inputs.computer_update, {
      operationKey: "run",
    });
    expect(f.deps.store.renameDevice).toHaveBeenCalledOnce();
  });
  it("rechecks the access ceiling before reading an administration replay", async () => {
    const f = fixture();
    const replay = () =>
      f.mcp.callTool("token", "computer_update", f.inputs.computer_update, {
        operationKey: "once",
      });
    await expectRemoved(f, "computer_update", f.inputs.computer_update);
    f.asNativeRun();
    const first = await replay();
    expect(first).toMatchObject({ ok: true });
    f.deps.store.replayAdministrationCommand.mockResolvedValueOnce({
      output: { type: "machine.rename", ok: true },
    } as never);
    expect(await replay()).toEqual(first);
    expect(f.deps.store.renameDevice).toHaveBeenCalledOnce();
    f.setCaller({ ...f.caller(), accessMode: "approval-required" });
    f.deps.store.replayAdministrationCommand.mockClear();
    await expect(replay()).rejects.toThrow("Changing settings requires full-access");
    expect(f.deps.store.replayAdministrationCommand).not.toHaveBeenCalled();
    expect(f.deps.store.renameDevice).toHaveBeenCalledOnce();
  });
});
