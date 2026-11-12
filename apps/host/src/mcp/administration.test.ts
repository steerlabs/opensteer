import { createId, emptyExecutionPreferences, type Thread } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import { describe, expect, it, vi } from "vitest";
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

function fixture() {
  const userId = createId("user"),
    environmentId = createId("environment"),
    harnessInstanceId = createId("harnessInstance"),
    machineId = createId("runner"),
    profileId = createId("browserProfile"),
    grantId = crypto.randomUUID();
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
    key: "connection:test",
    connectionId: "test",
    userId,

    accessMode: "full-access",
  };
  const realtime = { broadcast: vi.fn(), publish: vi.fn(), publishNotificationPreference: vi.fn() };
  const platform = {
    store: {
      getConnectionKind: vi.fn(async () => "provider-account"),
      listGrants: vi.fn(async () => []),
      listInstallations: vi.fn(async () => []),
      listMcpOAuthConnections: vi.fn(async () => []),
      revokeMcpOAuthConnection: vi.fn(),
      plugins: {
        listForUser: vi.fn(async () => [{ id: "p", name: "Plugin", config: { token: "secret" } }]),
        setActivation: vi.fn(),
      },
      specialists: {
        list: vi.fn(async () => []),
        summaries: vi.fn(async () => []),
        remove: vi.fn(),
      },
    },
    revokeGrant: vi.fn(),
    uninstallIntegration: vi.fn(),
  };
  const store = {
    replayAdministrationCommand: vi.fn(async () => undefined),
    userById: vi.fn(async () => ({ instanceRole: "administrator", disabledAt: null })),

    listEnvironmentsForUser: vi.fn(async () => [{ id: environmentId, kind: "local" }]),
    listHarnessInstances: vi.fn(async () => [harness]),
    getHarnessInstance: vi.fn(async () => harness),
    updateHarnessInstance: vi.fn(async () => harness),
    getExecutionPreferences: vi.fn(async () => emptyExecutionPreferences),
    rememberExecutionChoice: vi.fn(async () => ({
      ...emptyExecutionPreferences,
      accessMode: "approval-required",
    })),
    listRunners: vi.fn(async () => ({
      runners: [{ id: machineId, name: "Mac", revokedAt: null }],
      nextCursor: null,
    })),
    effectiveMachineOwner: vi.fn(async () => ({ effectiveOwner: userId })),
    listActiveShellSessions: vi.fn(async () => []),

    renameRunner: vi.fn(),
    notificationState: {
      timeZoneFor: vi.fn(async () => null),
      setTimeZone: vi.fn(async () => "UTC"),
    },
  };
  const deps = {
    store,
    realtime,
    integrations: {
      platform,
      service: { disconnect: vi.fn(async () => ({ disconnected: true, secret: "secret" })) },
    },
    channels: {
      service: {
        setConnectionStatus: vi.fn(),
        dashboard: vi.fn(async () => ({ connections: [], bindings: [] })),
      },
    },
    browser: {
      renameProfile: vi.fn(async () => ({ id: profileId, name: "Work", token: "secret" })),
    },
    runners: { isRunnerConnected: vi.fn(() => true) },
  };
  const service = new AdministrationService(deps as unknown as AdministrationDependencies, vi.fn());
  const handlers = administrationToolHandlers(
    new AdministrationToolHandlers(service, async () => []),
  );
  const mcp = new OpensteerMcpService({
    callers: { authenticate: async () => caller },
    handlers: handlers as AgentToolHandlers,
    publicUrl: new URL("http://127.0.0.1"),
    store: {} as never,
  });
  const inputs = {
    settings_write: { action: "rename", environmentId, harnessInstanceId, name: "Engine" },
    computer_write: { action: "rename", machineId, name: "Mac" },
    integration_manage: { action: "disconnect", connectionId },
    channel_manage: { action: "pause", connectionId },
    plugin_manage: { action: "enable", pluginId: "p" },
    browser_profile_write: { action: "rename", profileId, name: "Work" },
    settings_read: {},
    computer_list: {},
  };
  return {
    mcp,
    service,
    deps,
    inputs,
    profileId,
    grantId,
    userId,
    caller: () => caller,
    setCaller: (value: AgentCaller) => {
      caller = value;
    },
  };
}
const mutations = [
  "settings_write",
  "computer_write",
  "integration_manage",
  "channel_manage",
  "plugin_manage",
  "browser_profile_write",
] as const;
describe("administration through the MCP service", () => {
  it.each(mutations)("executes %s and refuses the same action below full-access", async (name) => {
    const f = fixture();
    expect(
      await f.mcp.callTool("token", name, f.inputs[name], { operationKey: "write" }),
    ).toMatchObject({ ok: true });
    f.setCaller({ ...f.caller(), accessMode: "approval-required" });
    await expect(
      f.mcp.callTool("token", name, f.inputs[name], { operationKey: "write" }),
    ).rejects.toThrow("Changing settings requires full-access");
  });
  it.each(["settings_read", "computer_list"] as const)(
    "allows %s without full-access",
    async (name) => {
      const f = fixture();
      f.setCaller({ ...f.caller(), accessMode: "approval-required" });
      expect(await f.mcp.callTool("token", name, {}, { operationKey: "read" })).toBeDefined();
    },
  );
  it("remembers an access preference without changing the caller's authority", async () => {
    const f = fixture();
    await f.mcp.callTool(
      "token",
      "settings_write",
      { action: "remember_execution", accessMode: "approval-required" },
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
        "settings_write",
        { action: "remember_execution", accessMode: "full-access" },
        { operationKey: "raise" },
      ),
    ).rejects.toThrow("Changing settings requires full-access");
    expect(f.deps.store.rememberExecutionChoice).toHaveBeenCalledOnce();
  });
  it("strips config, tokens and nested plugin launch details", async () => {
    const f = fixture();
    for (const [name, input] of [
      ["settings_read", {}],
      ["plugin_manage", { action: "list" }],
      ["browser_profile_write", f.inputs.browser_profile_write],
    ] as const) {
      expect(
        JSON.stringify(await f.mcp.callTool("token", name, input, { operationKey: name })),
      ).not.toMatch(/secret|apiKey|config|token/);
    }
  });
  it("lists specialists without refreshing or binding resources", async () => {
    const f = fixture();
    await f.mcp.callTool("token", "plugin_manage", { action: "list" }, { operationKey: "list" });
    expect(f.deps.integrations.platform.store.specialists.list).not.toHaveBeenCalled();
    expect(f.deps.integrations.platform.store.specialists.summaries).toHaveBeenCalledOnce();
  });
  it("applies the same administration to a Run without requiring a fake person session", async () => {
    const f = fixture();
    const base = f.caller();
    f.setCaller({ ...base, kind: "run", thread: {} as Thread, claims: {} as never });
    await f.mcp.callTool("token", "computer_write", f.inputs.computer_write, {
      operationKey: "run",
    });
    expect(f.deps.store.renameRunner).toHaveBeenCalledOnce();
  });
  it("rechecks the access ceiling before reading an administration replay", async () => {
    const f = fixture();
    f.setCaller({ ...f.caller(), accessMode: "approval-required" });
    await expect(
      f.mcp.callTool("token", "computer_write", f.inputs.computer_write, { operationKey: "once" }),
    ).rejects.toThrow("Changing settings requires full-access");
    expect(f.deps.store.replayAdministrationCommand).not.toHaveBeenCalled();
    expect(f.deps.store.renameRunner).not.toHaveBeenCalled();
  });
});
