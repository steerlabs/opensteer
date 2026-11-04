import { createId, SpecialistManifestSchema, type UserId } from "@opensteer/core";
import { IntegrationPlatformStore } from "@opensteer/database";
import { describeStore } from "@opensteer/database/test-support/store";
import { createIntegrationId } from "@opensteer/integration-core";
import { RealtimeHub } from "@opensteer/orchestration";
import type { HostToClientMessage } from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import {
  AdministrationService,
  type AdministrationDependencies,
} from "../administration/administration-service.js";
import { BrowserService } from "../browser/browser-service.js";
import { ChannelService } from "../channels/channel-service.js";
import { WorkspaceDeletionService } from "../workspace/workspace-deletion-service.js";
import {
  AdministrationToolHandlers,
  administrationToolHandlers,
} from "./handlers/administration.js";
import type { AgentToolHandlers } from "./handlers/index.js";
import type { AgentCaller } from "./agent-caller.js";
import { OpensteerMcpService } from "./opensteer-mcp-service.js";

function mcp(dependencies: AdministrationDependencies, userId: UserId) {
  let caller: AgentCaller = {
    kind: "connection",
    connectionId: "administration-test",
    key: "connection:administration-test",
    userId,
    accessMode: "full-access",
    reach: { kind: "user" },
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
    call: (name: string, input: Record<string, unknown>) =>
      service.callTool("token", name, input, { operationKey: randomUUID() }),
    scope: (workspaceId: Parameters<typeof dependencies.store.getWorkspaceForOwner>[0]) => {
      caller = { ...caller, reach: { kind: "workspace", workspaceId } };
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

describeStore("MCP administration", (it) => {
  it("refuses Main deletion, deletes and recovers a Project, and notifies another device", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("admin-project");
    const project = await f.createProjectWorkspace(run.userId, "admin-project-target");
    const other = await f.createProjectWorkspace(run.userId, "admin-other");
    const rt = realtime(f.store, run.userId);
    const deletion = new WorkspaceDeletionService({
      drivers: { local: { destroy: vi.fn() } },
      store: f.store,
      retentionDays: 7,
      onError: (error) => {
        throw error;
      },
      onWorkspaceEvent: (event) => rt.hub.publish(event),
      terminateRuns: async () => {},
    });
    const agent = mcp(
      {
        store: f.store,
        realtime: rt.hub,
        workspaces: { setIcon: f.store.setWorkspaceIcon.bind(f.store) },
        workspaceDeletion: deletion,
        apps: { stopWorkspace: vi.fn() },
        integrations: { platform: { store: new IntegrationPlatformStore(f.database) } },
      } as unknown as AdministrationDependencies,
      run.userId,
    );
    try {
      await expect(
        agent.call("project_write", { action: "delete", workspaceId: run.workspace.id }),
      ).rejects.toThrow("Main cannot be deleted");
      const markInput = {
        action: "set_icon",
        workspaceId: project.id,
        icon: "folder",
        operationKey: "mark-once",
      };
      const marked = await agent.call("project_write", markInput);
      expect(await agent.call("project_write", markInput)).toEqual(marked);
      await expect(
        agent.call("project_write", { ...markInput, icon: "code" }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(
        await f.database
          .selectFrom("commands")
          .select("id")
          .where("type", "=", "workspace.icon.set")
          .execute(),
      ).toHaveLength(1);
      expect(await f.store.getWorkspaceForOwner(project.id, run.userId)).toMatchObject({
        icon: "folder",
      });
      const mark = await f.database
        .selectFrom("commands")
        .select("authoritySource")
        .where("type", "=", "workspace.icon.set")
        .executeTakeFirstOrThrow();
      expect(mark.authoritySource).toMatchObject({ kind: "mcp", callerKind: "connection" });
      await agent.call("project_write", { action: "delete", workspaceId: project.id });
      expect(await f.store.getWorkspaceForOwner(project.id, run.userId)).toMatchObject({
        status: "deleting",
      });
      await agent.call("project_write", { action: "recover", workspaceId: project.id });
      expect(await f.store.getWorkspaceForOwner(project.id, run.userId)).toMatchObject({
        status: "unavailable",
      });
      await vi.waitFor(
        () =>
          expect(
            rt.messages.filter((message) => message.type === "host.machines.changed"),
            "another device never received the administration change",
          ).toHaveLength(4),
        { timeout: 2000 },
      );
      expect(
        rt.messages.filter((message) => message.type === "host.plugins-changed"),
        "Settings on another device was never told the Project's plugin places changed",
      ).toHaveLength(1);
      agent.scope(project.id);
      await expect(
        agent.call("project_write", { action: "delete", workspaceId: other.id }),
      ).rejects.toThrow("outside the caller's reach");
      expect(await f.store.getWorkspaceForOwner(other.id, run.userId)).toMatchObject({
        status: "ready",
      });
    } finally {
      rt.release();
      await agent.service.close();
    }
  });
  it("erases history, revokes a profile grant and preserves the scoped connection's boundary", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("admin-browser");
    const project = await f.createProjectWorkspace(run.userId, "admin-browser-target");
    const profile = await f.store.createBrowserProfile({
      ownerId: run.userId,
      name: "Private",
      idempotencyKey: "private-profile",
    });
    const grant = await f.store.createBrowserProfileGrant({
      access: "read-write",
      createdBy: run.userId,
      profileId: profile.id,
      workspaceId: project.id,
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
      hostOrigin: new URL("http://127.0.0.1"),
      repository: f.store,
      signer: {} as never,
      onSessionsChanged: () => {},
      onWorkspaceEvent: (event) => rt.hub.publish(event),
      onProfilesChanged: (ownerId, workspaceId) =>
        rt.hub.publishBrowserSessionsChanged(workspaceId, [ownerId], "browser.profiles"),
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
      expect(listed.profiles).toEqual([{ id: profile.id, name: "Private" }]);
      expect(JSON.stringify(listed)).not.toContain("storageInstanceId");
      await agent.call("browser_profile_write", {
        action: "rename",
        profileId: profile.id,
        name: "Work",
      });
      await agent.call("browser_profile_write", { action: "clear_history", profileId: profile.id });
      expect((await f.store.browserHistory.list(profile.id, run.userId)).entries).toEqual([]);
      agent.scope(run.workspace.id);
      await expect(
        agent.call("browser_profile_write", { action: "revoke_grant", grantId: grant.grantId }),
      ).rejects.toThrow("outside the caller's reach");
      agent.scope(project.id);
      await expect(
        agent.call("browser_profile_write", {
          action: "rename",
          profileId: profile.id,
          name: "Other",
        }),
      ).rejects.toThrow("user-wide reach");
      await agent.call("browser_profile_write", { action: "revoke_grant", grantId: grant.grantId });
      expect(await f.store.listActiveBrowserProfileGrants(run.userId)).toEqual([]);
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
  it("revokes the durable computer identity before closing its transports", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("admin-computer");
    await f.database
      .updateTable("users")
      .set({ instanceRole: "administrator" })
      .where("id", "=", run.userId)
      .execute();
    const revoked = vi.fn(async () => {
      const runner = await f.database
        .selectFrom("runners")
        .select("revokedAt")
        .where("id", "=", run.runnerId)
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
      browser: { abandonSession: vi.fn() },
      integrations: { continuations: { notify: vi.fn() } },
      realtime: { broadcast: vi.fn(), publish: vi.fn() },
    };
    const agent = mcp(deps as unknown as AdministrationDependencies, run.userId);
    try {
      await agent.call("computer_write", { action: "revoke", machineId: run.runnerId });
      expect(revoked).toHaveBeenCalledOnce();
      expect(await f.store.effectiveMachineOwner(run.runnerId)).toBeNull();
    } finally {
      await agent.service.close();
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
      onWorkspaceEvent: () => {},
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
      await agent.call("channel_manage", {
        action: "pause",
        connectionId: configured.connection.id,
      });
      expect((await channels.dashboard(run.userId)).connections[0]).toMatchObject({
        status: "paused",
      });
      await agent.call("channel_manage", {
        action: "resume",
        connectionId: configured.connection.id,
      });
      const resumed = (await channels.dashboard(run.userId)).bindings[0]!;
      expect(resumed.accessPolicy).toEqual(configured.binding.accessPolicy);
      expect(resumed.executionPolicy).toEqual(configured.binding.executionPolicy);
      const revoke = {
        action: "revoke_binding",
        bindingId: configured.binding.id,
        operationKey: "revoke-binding-once",
      };
      await agent.call("channel_manage", revoke);
      expect(await agent.call("channel_manage", revoke)).toEqual({ ok: true });
      expect(
        (
          await f.database
            .selectFrom("channelBindings")
            .select("status")
            .where("id", "=", configured.binding.id)
            .executeTakeFirstOrThrow()
        ).status,
      ).toBe("revoked");
      expect(changed).toHaveBeenCalledTimes(3);
    } finally {
      await agent.service.close();
      await channels.close();
    }
  });
  it("lists specialist summaries without creating bindings and reverses plugin activation", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("admin-plugin");
    const project = await f.createProjectWorkspace(run.userId, "admin-plugin-target");
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
      workspaceId: project.id,
      pluginId,
      actorUserId: run.userId,
    });
    const profile = await f.store.createBrowserProfile({
      ownerId: run.userId,
      name: "Research",
      idempotencyKey: "admin-research",
    });
    await f.store.createBrowserProfileGrant({
      access: "read-write",
      createdBy: run.userId,
      profileId: profile.id,
      workspaceId: project.id,
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
      await agent.call("plugin_manage", { action: "list", workspaceId: project.id });
      expect(
        (
          await f.database
            .selectFrom("specialists")
            .select("bindings")
            .where("id", "=", specialist.id)
            .executeTakeFirstOrThrow()
        ).bindings,
      ).toEqual([]);
      await agent.call("plugin_manage", {
        action: "deactivate",
        workspaceId: project.id,
        pluginId,
      });
      expect(await platform.plugins.current(project.id)).toEqual([]);
      await agent.call("plugin_manage", { action: "activate", workspaceId: project.id, pluginId });
      expect(await platform.plugins.current(project.id)).toHaveLength(1);
    } finally {
      await agent.service.close();
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
        workspaceId: run.workspace.id,
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
      await agent.call("integration_manage", {
        action: "revoke_grant",
        workspaceId: run.workspace.id,
        grantId,
      });
      expect(
        await platform.listGrants({ ownerUserId: run.userId, workspaceId: run.workspace.id }),
      ).toEqual([]);
      expect(
        await f.database
          .selectFrom("integrationGrants")
          .select(["id", "status", "revokedAt"])
          .where("id", "=", grantId)
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ id: grantId, status: "revoked", revokedAt: expect.any(Date) });
      expect(await f.database.selectFrom("integrationGrants").select("id").execute()).toHaveLength(
        1,
      );
    } finally {
      await agent.service.close();
    }
  });
});
