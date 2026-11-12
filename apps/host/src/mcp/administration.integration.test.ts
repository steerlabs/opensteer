import { personalBrowserRepository } from "@opensteer/database/test-support/store";
import { createId, SpecialistManifestSchema, type UserId } from "@opensteer/core";
import {
  IntegrationPlatformStore,
  BrowserSourceStore,
  IntegrationStore,
} from "@opensteer/database";
import { describeStore } from "@opensteer/database/test-support/store";
import { createIntegrationId } from "@opensteer/integration-core";
import { RealtimeHub } from "@opensteer/orchestration";
import type { HostToClientMessage } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import type { HostApiCommand } from "@opensteer/protocol";
import { expect, vi } from "vitest";
import { sql } from "kysely";
import { ShellSessionIdSchema } from "@opensteer/protocol";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntegrationPlatformService } from "../integrations/integration-platform-service.js";
import { IntegrationService } from "../integrations/integration-service.js";
import {
  AdministrationService,
  type AdministrationDependencies,
} from "../administration/administration-service.js";
import { BrowserService } from "../browser/browser-service.js";
import { ChannelService } from "../channels/channel-service.js";
import {
  AdministrationToolHandlers,
  administrationToolHandlers,
} from "./handlers/administration.js";
import type { AgentToolHandlers } from "./handlers/types.js";
import type { AgentCaller } from "./agent-caller.js";
import { OpensteerMcpService } from "./opensteer-mcp-service.js";

function mcp(dependencies: AdministrationDependencies, userId: UserId) {
  const caller: AgentCaller = {
    kind: "connection",
    connectionId: "administration-test",
    key: "connection:administration-test",
    userId,
    accessMode: "full-access",
  };
  const handlers = administrationToolHandlers(
    new AdministrationToolHandlers(
      new AdministrationService(dependencies, vi.fn()),
      async () => [],
    ),
  );
  const service = new OpensteerMcpService({
    callers: { authenticate: async () => caller },
    handlers: handlers as AgentToolHandlers,
    store: dependencies.store,
    publicUrl: new URL("http://127.0.0.1"),
  });
  return {
    service,
    call: async (name: string, input: Record<string, unknown>) => {
      const result = await service.callTool("token", name, input, { operationKey: randomUUID() });
      if (typeof result === "string") throw new Error(`${name} returned text, not a record`);
      return result;
    },
  };
}
function realtime(store: AdministrationDependencies["store"], userId: UserId) {
  const hub = new RealtimeHub({ store });
  const messages: HostToClientMessage[] = [];
  const release = hub.registerConnection(userId, createId("authSession"), {
    id: randomUUID(),
    send: async (message) => {
      messages.push(message);
    },
    close: () => {},
  });
  return { hub, messages, release };
}

async function retryAfterPersonChange(
  agent: ReturnType<typeof mcp>,
  name: string,
  input: Record<string, unknown>,
  change: () => Promise<unknown>,
  observe: () => Promise<unknown>,
  different: Record<string, unknown>,
) {
  const keyed = { ...input, operationKey: randomUUID() };
  const original = await agent.call(name, keyed);
  await change();
  const afterPerson = await observe();
  expect(await agent.call(name, keyed)).toEqual(original);
  expect(await observe()).toEqual(afterPerson);
  await expect(agent.call(name, { ...keyed, ...different })).rejects.toMatchObject({
    code: "conflict",
  });
  expect(await observe()).toEqual(afterPerson);
}

describeStore("MCP administration", (it) => {
  for (const action of [
    "rename",
    "set_enabled",
    "set_default",
    "configure_model",
    "remember_execution",
    "set_time_zone",
    "computer_rename",
  ] as const) {
    it(`replays ${action} after a person changes it and refuses changed input`, async ({
      storeFixture: f,
    }) => {
      const run = await f.createRunFixture(`retry-${action}`);
      const other = await f.store.createHarnessInstance({
        config: {},
        driverKind: run.harnessInstance.driverKind,
        environmentId: run.environmentId,
        name: "Other",
        stateKind: "isolated",
      });
      const service = new AdministrationService(
        {
          store: f.store,
          realtime: { broadcast: vi.fn(), publishNotificationPreference: vi.fn() },
          runners: {
            identityForEnvironment: () => ({
              modules: {
                agents: {
                  harnessDrivers: [
                    {
                      driverKind: run.harnessInstance.driverKind,
                      readiness: "configured",
                      sources: [{ sourceId: run.harnessInstance.sourceId, modelSettings: true }],
                    },
                  ],
                },
              },
            }),
          },
        } as unknown as AdministrationDependencies,
        vi.fn(),
      );
      const agent = mcp(service.dependencies, run.userId);
      const common = {
        environmentId: run.environmentId,
        harnessInstanceId: run.harnessInstance.id,
      };
      let name = "settings_write";
      let input: Record<string, unknown> = { action, ...common };
      let different: Record<string, unknown> = {};
      let person: HostApiCommand;
      let observe: () => Promise<unknown> = () =>
        f.store.getHarnessInstance(run.harnessInstance.id);
      switch (action) {
        case "rename":
          input.name = "A";
          different = { name: "Changed" };
          person = { type: "harness.rename", ...common, name: "B", idempotencyKey: randomUUID() };
          break;
        case "set_enabled":
          input.enabled = false;
          different = { enabled: true };
          person = {
            type: "harness.enabled.set",
            ...common,
            enabled: true,
            idempotencyKey: randomUUID(),
          };
          break;
        case "set_default":
          input.harnessInstanceId = other.id;
          different = { harnessInstanceId: run.harnessInstance.id };
          person = { type: "harness.default.set", ...common, idempotencyKey: randomUUID() };
          observe = () => f.store.listHarnessInstances({ environmentIds: [run.environmentId] });
          break;
        case "configure_model":
          await f.store.updateHarnessInstance({
            id: run.harnessInstance.id,
            config: { models: { test: { contextWindow: 1000 } } },
          });
          input.nativeModelId = "test";
          input.settings = { contextWindow: 2000 };
          different = { settings: { contextWindow: 4000 } };
          person = {
            type: "harness.model.configure",
            ...common,
            nativeModelId: "test",
            settings: { contextWindow: 3000 },
            idempotencyKey: randomUUID(),
          };
          break;
        case "remember_execution":
          input = { action, accessMode: "approval-required" };
          different = { accessMode: "full-access" };
          person = {
            type: "execution.preferences.remember",
            accessMode: "full-access",
            idempotencyKey: randomUUID(),
          };
          observe = () => f.store.getExecutionPreferences(run.userId);
          break;
        case "set_time_zone":
          input = { action, timeZone: "UTC" };
          different = { timeZone: "Europe/Paris" };
          person = {
            type: "viewer.timeZone.update",
            timeZone: "America/New_York",
            idempotencyKey: randomUUID(),
          };
          observe = () => f.store.notificationState.timeZoneFor(run.userId);
          break;
        case "computer_rename":
          name = "computer_write";
          input = { action: "rename", machineId: run.runnerId, name: "A" };
          different = { name: "Changed" };
          person = {
            type: "machine.rename",
            machineId: run.runnerId,
            name: "B",
            idempotencyKey: randomUUID(),
          };
          observe = () =>
            f.database
              .selectFrom("runners")
              .select(["name", "updatedAt"])
              .where("id", "=", run.runnerId)
              .executeTakeFirstOrThrow();
          break;
      }
      try {
        await retryAfterPersonChange(
          agent,
          name,
          input,
          () => service.execute({ kind: "person", userId: run.userId }, person),
          observe,
          different,
        );
      } finally {
        await agent.service.close();
      }
    });
  }

  it("rolls back the domain write with its result and serializes concurrent command keys", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("atomic-admin");
    const before = await f.database
      .selectFrom("runners")
      .select("name")
      .where("id", "=", run.runnerId)
      .executeTakeFirstOrThrow();
    const identity = {
      requestedBy: run.userId,
      idempotencyKey: randomUUID(),
      type: "machine.rename",
      request: { machineId: run.runnerId, name: "A" },
      authoritySource: { kind: "mcp", callerKey: "test" },
    };
    await expect(
      f.store.renameRunner(run.runnerId, run.userId, "A", {
        allowDeployment: true,
        administration: {
          ...identity,
          output: () => {
            throw new Error("Result could not be recorded");
          },
        },
      }),
    ).rejects.toThrow("Result could not be recorded");
    expect(
      await f.database
        .selectFrom("runners")
        .select("name")
        .where("id", "=", run.runnerId)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    expect(await f.store.replayAdministrationCommand(identity)).toBeUndefined();
    const results = await Promise.allSettled([
      f.store.renameRunner(run.runnerId, run.userId, "A", {
        allowDeployment: true,
        administration: identity,
      }),
      f.store.renameRunner(run.runnerId, run.userId, "Changed", {
        allowDeployment: true,
        administration: { ...identity, request: { ...identity.request, name: "Changed" } },
      }),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { code: "conflict" },
    });
  });

  it("erases personal browser history with replay and notifies other devices", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("admin-browser");
    const browserRunnerId = await f.enrollBrowserRunner(run.userId, "Browser");
    const profile = await f.store.createBrowserProfile({
      ownerId: run.userId,
      name: "Private",
      idempotencyKey: "private-profile",
    });
    await f.store.browserHistory.recordVisit({
      ownerId: run.userId,
      profileId: profile.id,
      title: "Private",
      url: "https://example.test/history",
      typed: true,
    });
    const rt = realtime(f.store, run.userId);
    const browser = new BrowserService({
      deploymentId: run.deploymentId,
      hostOrigin: new URL("http://127.0.0.1"),
      repository: personalBrowserRepository(f.store),
      signer: {} as never,
      onSessionsChanged: () => {},
      onDeploymentEvent: (event) => rt.hub.publish(event),
      onProfilesChanged: (ownerId) =>
        rt.hub.publishBrowserSessionsChanged([ownerId], "browser.profiles"),
      onHistoryChanged: (ownerId, profileId) =>
        rt.hub.sendToUsers([ownerId], { type: "host.browser-history-changed", profileId }),
    });
    const agent = mcp(
      {
        store: f.store,
        browser,
        browserSources: { listState: async () => ({ sites: [] }) },
        realtime: rt.hub,
      } as unknown as AdministrationDependencies,
      run.userId,
    );
    try {
      const listed = await agent.call("browser_profile_write", { action: "list" });
      expect(listed.profiles).toEqual([
        {
          id: profile.id,
          name: "Private",
          home: { runnerId: browserRunnerId, name: "Browser", reachable: false },
        },
      ]);
      expect(JSON.stringify(listed)).not.toContain("storageInstanceId");
      await retryAfterPersonChange(
        agent,
        "browser_profile_write",
        { action: "rename", profileId: profile.id, name: "A" },
        () => browser.renameProfile({ ownerId: run.userId, profileId: profile.id, name: "B" }),
        () => f.store.getBrowserProfile(profile.id, run.userId),
        { name: "Changed" },
      );
      const visit = () =>
        f.store.browserHistory.recordVisit({
          ownerId: run.userId,
          profileId: profile.id,
          title: "New navigation",
          url: "https://example.test/history",
          typed: true,
        });
      const history = () => f.store.browserHistory.list(profile.id, run.userId);
      await retryAfterPersonChange(
        agent,
        "browser_profile_write",
        { action: "clear_history", profileId: profile.id },
        visit,
        history,
        { action: "remove_history", url: "https://example.test/history" },
      );
      await retryAfterPersonChange(
        agent,
        "browser_profile_write",
        { action: "remove_history", profileId: profile.id, url: "https://example.test/history" },
        visit,
        history,
        { url: "https://example.test/other" },
      );
      expect(
        JSON.stringify(
          await f.database
            .selectFrom("commands")
            .select("payload")
            .where("type", "=", "browser.history.remove")
            .execute(),
        ),
      ).not.toContain("https://example.test/history");
      await vi.waitFor(
        () =>
          expect(
            rt.messages.some((message) => message.type === "host.browser-history-changed"),
            "history change never reached the other device",
          ).toBe(true),
        { timeout: 2000 },
      );
    } finally {
      rt.release();
      await agent.service.close();
      await browser.close();
    }
  });
  it("replays profile deletion and remembered-site removal after the person replaces them", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("browser-delete-retry");
    await f.enrollBrowserRunner(run.userId, "Browser");
    const profile = await f.store.createBrowserProfile({
      ownerId: run.userId,
      name: "Old",
      idempotencyKey: "old-profile",
    });
    const browser = new BrowserService({
      deploymentId: run.deploymentId,
      hostOrigin: new URL("http://127.0.0.1"),
      repository: personalBrowserRepository(f.store),
      signer: {} as never,
      onSessionsChanged: vi.fn(),
      onDeploymentEvent: vi.fn(),
      onProfilesChanged: vi.fn(),
    });
    const sources = new BrowserSourceStore(f.database);
    const sourceId = createId("browserSource");
    await f.database
      .insertInto("browserSources")
      .values({
        id: sourceId,
        ownerId: run.userId,
        name: "Chrome",
        tokenHash: "a".repeat(64),
        revokedAt: null,
        lastSeenAt: null,
      })
      .execute();
    const site = {
      ownerId: run.userId,
      deploymentId: run.deploymentId,
      site: "https://example.test",
      preferredSourceId: sourceId,
    };
    await sources.upsertGrant(site);
    const agent = mcp(
      {
        store: f.store,
        browser,
        browserSources: { removeSite: sources.removeGrant.bind(sources) },
        realtime: { broadcast: vi.fn() },
      } as unknown as AdministrationDependencies,
      run.userId,
    );
    try {
      await retryAfterPersonChange(
        agent,
        "browser_profile_write",
        { action: "delete", profileId: profile.id },
        () =>
          f.store.createBrowserProfile({
            ownerId: run.userId,
            name: "Replacement",
            idempotencyKey: "new-profile",
          }),
        () => f.store.listBrowserProfiles(run.userId),
        { action: "rename", name: "Changed" },
      );
      await retryAfterPersonChange(
        agent,
        "browser_profile_write",
        { action: "remove_site", site: site.site },
        () => sources.upsertGrant(site),
        () =>
          f.database
            .selectFrom("browserSiteGrants")
            .selectAll()
            .where("ownerId", "=", run.userId)
            .execute(),
        { site: "https://other.test" },
      );
    } finally {
      await agent.service.close();
      await browser.close();
    }
  });

  it("replays stopping a session even when the person opens one under a previously absent ID", async ({
    storeFixture: f,
  }) => {
    const run = await f.startRunFixture("session-retry");
    const sessionId = ShellSessionIdSchema.parse(`shs_${randomUUID()}`);
    const agent = mcp(
      {
        store: f.store,
        shellControl: {
          end: (
            id: typeof sessionId,
            reason: "stopped-by-owner",
            options: { idempotency: { key: string; requestedBy: UserId } },
          ) => f.store.endShellSession({ sessionId: id, reason, ...options }),
        },
      } as unknown as AdministrationDependencies,
      run.userId,
    );
    try {
      await retryAfterPersonChange(
        agent,
        "computer_write",
        { action: "stop_session", sessionId },
        () =>
          f.store.reserveShellSession({
            sessionId,
            requestedBy: run.userId,
            runnerId: run.runnerId,
            callerRunnerId: run.runnerId,
            callerMachineName: "Test",
            policyRevision: 1,
            runId: run.run.id,
            threadId: run.thread.id,
            threadTitle: "Test",
            startedAt: new Date(),
          }),
        () => f.store.getShellSession(sessionId),
        { sessionId: `shs_${randomUUID()}` },
      );
    } finally {
      await agent.service.close();
    }
  });

  it("revokes the durable computer identity before closing its transports", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("admin-computer");
    const targetRunnerId = await f.enrollBrowserRunner(run.userId, "Removed computer");
    await f.database
      .updateTable("runners")
      .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
      .where("id", "=", targetRunnerId)
      .execute();
    const profile = await f.store.createBrowserProfile({
      ownerId: run.userId,
      name: "Removed browser",
      homeRunnerId: targetRunnerId,
      idempotencyKey: "removed-profile",
    });
    await f.store.bindBrowserProfile({
      version: 1,
      deploymentId: (await f.store.getDeployment())!.id,
      runnerId: targetRunnerId,
      profileId: profile.id,
      bindingId: randomUUID(),
      storageInstanceId: randomUUID(),
      engine: "chromium",
    });
    const session = await f.store.createBrowserSession({
      id: `bsn_${randomUUID()}` as import("@opensteer/protocol").BrowserSessionId,
      runnerId: targetRunnerId,
      profileId: profile.id,
      placementKey: `runner:${targetRunnerId}:browser`,
      origin: "agent",
      ownerId: run.userId,
      runtimeId: "browser",
    });
    const rt = realtime(f.store, run.userId);
    const browser = new BrowserService({
      deploymentId: run.deploymentId,
      hostOrigin: new URL("https://host.test"),
      repository: personalBrowserRepository(f.store),
      signer: {} as never,
      onSessionsChanged: () => undefined,
      onDeploymentEvent: () => undefined,
      onProfilesChanged: (ownerId) =>
        rt.hub.publishBrowserSessionsChanged([ownerId], "browser.profiles"),
    });
    const abandonSession = vi.spyOn(browser, "abandonSession");
    const revoked = vi.fn(async () => {
      const runner = await f.database
        .selectFrom("runners")
        .select("revokedAt")
        .where("id", "=", targetRunnerId)
        .executeTakeFirstOrThrow();
      expect(runner.revokedAt).toBeInstanceOf(Date);
    });
    const deps = {
      store: f.store,
      shellControl: {
        withMachineAdmission: async (_id: unknown, effect: () => Promise<unknown>) => effect(),
        endMachineSessions: vi.fn(),
      },
      computerApps: {
        withRunnerAdmission: async (_id: unknown, effect: () => Promise<unknown>) => effect(),
        detachRunner: vi.fn(),
      },
      runners: { revoke: revoked },
      channels: { relay: { forget: vi.fn() } },
      browser,
      integrations: { continuations: { notify: vi.fn() } },
      realtime: rt.hub,
    };
    const agent = mcp(deps as unknown as AdministrationDependencies, run.userId);
    try {
      await retryAfterPersonChange(
        agent,
        "computer_write",
        { action: "revoke", machineId: targetRunnerId },
        () => f.store.rememberExecutionChoice(run.userId, { accessMode: "approval-required" }),
        () =>
          f.database
            .selectFrom("runners")
            .select(["revokedAt", "connectionGeneration"])
            .where("id", "=", targetRunnerId)
            .executeTakeFirstOrThrow(),
        { machineId: createId("runner") },
      );
      expect(revoked).toHaveBeenCalledOnce();
      expect(abandonSession).toHaveBeenCalledWith(session.id);
      expect(await f.store.getBrowserProfile(profile.id, run.userId)).toBeNull();
      expect(rt.messages).toContainEqual({
        type: "host.browser-sessions-changed",
      });
      expect(rt.messages).toContainEqual({ type: "host.machines.changed" });
      expect(await f.store.effectiveMachineOwner(targetRunnerId)).toBeNull();
    } finally {
      await agent.service.close();
      await browser.close();
      rt.release();
    }
  });
  it("pauses/resumes existing channels and revokes a binding without changing its policies", async ({
    storeFixture: f,
  }) => {
    const {
      configured,
      fixture: run,
      channels: store,
    } = await f.createChannelDeliveryFixture("admin-channel");
    const changed = vi.fn();
    const channels = new ChannelService({
      canonicalOrigin: "http://127.0.0.1",
      store: f.store,
      channels: store,
      credentials: {} as never,
      relay: { connectedRunnerIds: () => [], supports: () => true } as never,
      runners: {} as never,
      onExecutionQueued: () => {},
      onDeploymentEvent: () => {},
      onChanged: changed,
    });
    const agent = mcp(
      {
        store: f.store,
        channels: { service: channels },
        realtime: { broadcast: vi.fn() },
      } as unknown as AdministrationDependencies,
      run.userId,
    );
    try {
      const observe = () => channels.dashboard(run.userId);
      await retryAfterPersonChange(
        agent,
        "channel_manage",
        { action: "pause", connectionId: configured.connection.id },
        () => channels.setConnectionStatus(configured.connection.id, run.userId, "connected"),
        observe,
        { action: "resume" },
      );
      await retryAfterPersonChange(
        agent,
        "channel_manage",
        { action: "resume", connectionId: configured.connection.id },
        () => channels.setConnectionStatus(configured.connection.id, run.userId, "paused"),
        observe,
        { action: "pause" },
      );
      const resumed = (await channels.dashboard(run.userId)).bindings[0]!;
      expect(resumed.accessPolicy).toEqual(configured.binding.accessPolicy);
      expect(resumed.executionPolicy).toEqual(configured.binding.executionPolicy);
      const revoke = {
        action: "revoke_binding",
        bindingId: configured.binding.id,
        operationKey: "revoke-binding-once",
      };
      await retryAfterPersonChange(
        agent,
        "channel_manage",
        revoke,
        () => channels.setConnectionStatus(configured.connection.id, run.userId, "connected"),
        observe,
        { action: "pause", connectionId: configured.connection.id },
      );
      expect(
        (
          await f.database
            .selectFrom("channelBindings")
            .select("status")
            .where("id", "=", configured.binding.id)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe("revoked");
      expect(changed).toHaveBeenCalledTimes(6);
    } finally {
      await agent.service.close();
      await channels.close();
    }
  });
  it("lists ready specialist summaries and reverses the personal plugin switch", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("admin-plugin");
    const platform = new IntegrationPlatformStore(f.database);
    const pluginId = randomUUID();
    await platform.plugins.install({
      id: pluginId,
      name: "admin-research",
      actorUserId: run.userId,
      source: {},
      digest: "a".repeat(64),
      manifest: { name: "admin-research" },
      specialistManifest: SpecialistManifestSchema.parse({
        version: 1,
        models: [{ engine: "codex", model: "test" }],
        access: [{ type: "browser-profile", level: "read", reason: "Research" }],
      }),
    });
    const specialist = await platform.specialists.add({
      pluginId,
      actorUserId: run.userId,
    });
    await f.enrollBrowserRunner(run.userId, "Browser");
    await f.store.createBrowserProfile({
      ownerId: run.userId,
      name: "Research",
      idempotencyKey: "admin-research",
    });
    const agent = mcp(
      {
        store: f.store,
        integrations: { platform: { store: platform } },
        realtime: { broadcast: vi.fn() },
      } as unknown as AdministrationDependencies,
      run.userId,
    );
    try {
      await agent.call("plugin_manage", { action: "list" });
      expect(
        (
          await f.database
            .selectFrom("specialists")
            .select("status")
            .where("id", "=", specialist.id)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe("ready");
      await retryAfterPersonChange(
        agent,
        "plugin_manage",
        { action: "disable", pluginId },
        () => setPluginEnabled(platform, run.userId, pluginId, true),
        () => platform.settings.detail(run.userId, { kind: "plugin", pluginId }),
        { action: "enable" },
      );
      await retryAfterPersonChange(
        agent,
        "plugin_manage",
        { action: "enable", pluginId },
        () => setPluginEnabled(platform, run.userId, pluginId, false),
        () => platform.settings.detail(run.userId, { kind: "plugin", pluginId }),
        { action: "disable" },
      );
    } finally {
      await agent.service.close();
    }
  });
  it("replays plugin update/removal and specialist removal after a person replaces their state", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("plugin-retries");
    const store = new IntegrationPlatformStore(f.database);
    const directory = await mkdtemp(join(tmpdir(), "opensteer-admin-plugin-"));
    const source = join(directory, "source");
    await mkdir(source);
    const platform = new IntegrationPlatformService({
      store,
      dataDirectory: join(directory, "data"),
      listConnections: async () => [],
      definitions: [],
      adapters: [],
      computerApps: {},
      credentialMaterializer: {},
      authorizationSource: {},
      mcpOauth: {},
      secretVault: {},
      isRunnerConnected: () => false,
      onDeploymentEvent: vi.fn(),
      onConnectionsChanged: vi.fn(),
      onRequestsChanged: vi.fn(),
    } as unknown as ConstructorParameters<typeof IntegrationPlatformService>[0]);
    const agent = mcp(
      {
        store: f.store,
        integrations: { platform },
        realtime: { broadcast: vi.fn() },
      } as unknown as AdministrationDependencies,
      run.userId,
    );
    const manifest = (description: string) =>
      writeFile(
        join(source, "plugin.json"),
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "admin-retry",
          description,
        }),
      );
    try {
      await manifest("Initial");
      const installed = await platform.installAgentPlugin({
        actorUserId: run.userId,
        directory: source,
        requestId: randomUUID(),
      });
      const pluginId = installed.installation.pluginId!;
      const observe = () =>
        f.database.selectFrom("plugins").selectAll().where("id", "=", pluginId).executeTakeFirst();
      await manifest("Agent update");
      await retryAfterPersonChange(
        agent,
        "plugin_manage",
        { action: "update", pluginId, directory: source },
        async () => {
          await manifest("Person update");
          await platform.installAgentPlugin({
            actorUserId: run.userId,
            directory: source,
            pluginId,
            requestId: randomUUID(),
          });
        },
        observe,
        { directory: join(directory, "different") },
      );
      const specialistManifest = SpecialistManifestSchema.parse({
        version: 1,
        models: [{ engine: "codex", model: "test" }],
        access: [],
      });
      await store.plugins.update({
        pluginId,
        digest: "b".repeat(64),
        manifest: { name: "admin-retry" },
        specialistManifest,
      });
      const specialist = await store.specialists.add({
        pluginId,
        actorUserId: run.userId,
      });
      store.specialists.setRemovalHandler(async () => {});
      await retryAfterPersonChange(
        agent,
        "plugin_manage",
        { action: "remove_specialist", specialistId: specialist.id },
        () =>
          store.specialists.add({
            pluginId,
            actorUserId: run.userId,
          }),
        () => store.specialists.summaries(run.userId),
        { specialistId: randomUUID() },
      );
      await retryAfterPersonChange(
        agent,
        "plugin_manage",
        { action: "remove", pluginId },
        () =>
          store.plugins.install({
            id: pluginId,
            name: "admin-retry",
            actorUserId: run.userId,
            source: {},
            digest: "c".repeat(64),
            manifest: { name: "admin-retry" },
          }),
        observe,
        { pluginId: randomUUID() },
      );
    } finally {
      await agent.service.close();
      await platform.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replays a provider disconnection after the person reconnects the same account", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("disconnect-retry");
    const repository = new IntegrationStore(f.database);
    let connectionId = createIntegrationId("connection");
    const connect = (reconnect: boolean) =>
      repository.connectApiKey({
        ownerUserId: run.userId,
        reconnect,
        requestId: randomUUID(),
        credentialProvider: "integration:github",
        credential: { envelope: Buffer.from("fixture-encrypted"), keyVersion: 1 },
        connection: {
          id: connectionId,
          accountIdentifier: "test",
          applicationSource: { kind: "api-key" },
          authMethodId: "token",
          authorizationDigest: "a".repeat(43),
          computer: null,
          connectionMethod: "api-key",
          definitionId: "github",
          displayName: "Test",
          externalIdentityId: "test",
          externalTenantId: null,
          grantedScopes: [],
          provider: "github",
          providerApplicationId: null,
          status: "connected",
          statusDetail: null,
          statusReason: null,
        },
      });
    await connect(false);
    const integrations = new IntegrationService({
      repository,
      definitions: [],
      attempts: {},
      deploymentPosture: async () => ({ kind: "personal" }),
      onConnectionConnected: vi.fn(),
      publicUrl: new URL("http://127.0.0.1"),
      vault: { seal: async () => ({ envelope: Buffer.from("fixture-revoked"), keyVersion: 1 }) },
    } as unknown as ConstructorParameters<typeof IntegrationService>[0]);
    const agent = mcp(
      {
        store: f.store,
        integrations: {
          service: integrations,
          platform: { store: new IntegrationPlatformStore(f.database) },
        },
        realtime: { broadcast: vi.fn() },
      } as unknown as AdministrationDependencies,
      run.userId,
    );
    try {
      await retryAfterPersonChange(
        agent,
        "integration_manage",
        { action: "disconnect", connectionId },
        async () => {
          connectionId = createIntegrationId("connection");
          await connect(false);
        },
        () => repository.listConnections(run.userId),
        { connectionId: createIntegrationId("connection") },
      );
    } finally {
      await agent.service.close();
    }
  });

  it("replays MCP account disconnection and integration uninstall after person changes", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("integration-uninstall-retry");
    const store = new IntegrationPlatformStore(f.database);
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    const installation = {
      id: installationId,
      name: "retry-mcp",
      description: "Test",
      manifest: {},
      provenance: {},
      sourceKind: "remote-mcp",
      status: "active",
      title: "Test",
      trust: "administrator-approved",
      version: null,
    } as const;
    const install = () =>
      store.install({
        actorUserId: run.userId,
        adapterSnapshot: null,
        requestId: randomUUID(),
        installation,
        servers: [
          {
            id: serverId,
            name: "default",
            status: "active",
            statusDetail: null,
            connectionRequirement: { kind: "mcp-oauth" },
            catalog: { definitions: {}, tools: [] },
            transport: {
              type: "streamable-http",
              url: "https://mcp.example.test/mcp",
              headers: {},
            },
          },
        ],
      });
    await install();
    const connectionId = createIntegrationId("connection");
    await f.database
      .insertInto("integrationConnections")
      .values({
        id: connectionId,
        ownerUserId: run.userId,
        connectionKind: "mcp-oauth",
        connectionMethod: "managed-oauth",
        integrationServerId: serverId,
        displayName: "Test MCP",
        provider: `mcp:${serverId}`,
        accountIdentifier: null,
        applicationSource: null,
        authMethodId: null,
        authorizationDigest: null,
        capabilities: sql`'[]'::jsonb`,
        credentialId: null,
        externalIdentityId: null,
        externalTenantId: null,
        grantedScopes: sql`'[]'::jsonb`,
        integrationDefinitionId: null,
        providerApplicationId: null,
        runnerId: null,
        status: "connected",
        statusDetail: null,
        transportKind: null,
      })
      .execute();
    const platform = new IntegrationPlatformService({
      store,
      dataDirectory: "unused",
      listConnections: async () => [],
      definitions: [],
      adapters: [],
      computerApps: {},
      credentialMaterializer: {},
      authorizationSource: {},
      mcpOauth: {},
      secretVault: {},
      isRunnerConnected: () => false,
      onDeploymentEvent: vi.fn(),
      onConnectionsChanged: vi.fn(),
      onRequestsChanged: vi.fn(),
    } as unknown as ConstructorParameters<typeof IntegrationPlatformService>[0]);
    const agent = mcp(
      {
        store: f.store,
        integrations: { platform },
        realtime: { broadcast: vi.fn() },
      } as unknown as AdministrationDependencies,
      run.userId,
    );
    try {
      await retryAfterPersonChange(
        agent,
        "integration_manage",
        { action: "disconnect", connectionId },
        () =>
          f.database
            .updateTable("integrationConnections")
            .set({ status: "connected", displayName: "Person reconnected" })
            .where("id", "=", connectionId)
            .execute(),
        () => store.listMcpOAuthConnections(run.userId),
        { connectionId: createIntegrationId("connection") },
      );
      await retryAfterPersonChange(
        agent,
        "integration_manage",
        { action: "uninstall", installationId },
        install,
        () => store.listInstallations(),
        { installationId: createIntegrationId("installation") },
      );
    } finally {
      await agent.service.close();
      await platform.close();
    }
  });

  it("revokes an existing integration grant without making another", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("admin-integration");
    const platform = new IntegrationPlatformStore(f.database);
    const installationId = createIntegrationId("installation");
    await platform.install({
      actorUserId: run.userId,
      adapterSnapshot: null,
      installation: {
        id: installationId,
        description: "Fixture",
        manifest: {},
        name: "admin-integration",
        provenance: {},
        sourceKind: "built-in",
        status: "active",
        title: "Fixture",
        trust: "administrator-approved",
        version: null,
      },
      requestId: "fixture-install",
      servers: [],
    });
    const grantId = createIntegrationId("grant");
    await f.database
      .insertInto("integrationGrants")
      .values({
        id: grantId,
        ownerUserId: run.userId,
        installationId,
        connectionId: null,
        alias: "Fixture",
        access: "read",
        isDefault: true,
        createdBy: run.userId,
        status: "active",
      })
      .execute();
    const revokeGrant = vi.fn((input: Parameters<typeof platform.revokeGrant>[0]) =>
      platform.revokeGrant(input),
    );
    const agent = mcp(
      {
        store: f.store,
        integrations: { platform: { store: platform, revokeGrant } },
        realtime: { broadcast: vi.fn() },
      } as unknown as AdministrationDependencies,
      run.userId,
    );
    try {
      await retryAfterPersonChange(
        agent,
        "integration_manage",
        { action: "revoke_grant", grantId },
        async () => {
          await f.database
            .insertInto("integrationGrants")
            .values({
              id: createIntegrationId("grant"),
              ownerUserId: run.userId,
              installationId,
              connectionId: null,
              alias: "Replacement",
              access: "read",
              isDefault: true,
              createdBy: run.userId,
              status: "active",
            })
            .execute();
        },
        () => platform.listGrants({ ownerUserId: run.userId }),
        { grantId: createIntegrationId("grant") },
      );
      expect(await platform.listGrants({ ownerUserId: run.userId })).toHaveLength(1);
      expect(
        await f.database
          .selectFrom("integrationGrants")
          .select(["id", "status", "revokedAt"])
          .where("id", "=", grantId)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ id: grantId, status: "revoked", revokedAt: expect.any(Date) });
      expect(await f.database.selectFrom("integrationGrants").select("id").execute()).toHaveLength(
        2,
      );
    } finally {
      await agent.service.close();
    }
  });
});

async function setPluginEnabled(
  platform: IntegrationPlatformStore,
  owner: UserId,
  pluginId: string,
  enabled: boolean,
) {
  const target = { kind: "plugin" as const, pluginId };
  const detail = await platform.settings.detail(owner, target);
  return platform.settings.setEnabled(owner, {
    type: "settings.plugin.enabled.set",
    idempotencyKey: randomUUID(),
    target,
    enabled,
    expectedRevision: detail.row.placement.revision,
  });
}
