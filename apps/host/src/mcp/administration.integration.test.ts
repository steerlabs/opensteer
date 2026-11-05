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
import { WorkspaceService } from "../workspace/workspace-service.js";
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
    call: async (name: string, input: Record<string, unknown>) => {
      const result = await service.callTool("token", name, input, { operationKey: randomUUID() });
      if (typeof result === "string") throw new Error(`${name} returned text, not a record`);
      return result;
    },
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
    "set_notifications",
    "set_icon",
    "set_color",
    "computer_rename",
  ] as const) {
    it(`replays ${action} after a person changes it and refuses changed input`, async ({
      storeFixture: f,
    }) => {
      const run = await f.createRunFixture(`retry-${action}`);
      await f.database
        .updateTable("users")
        .set({ instanceRole: "administrator" })
        .where("id", "=", run.userId)
        .execute();
      const project = await f.createProjectWorkspace(run.userId, `retry-target-${action}`);
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
          workspaces: { setIcon: f.store.setWorkspaceIcon.bind(f.store) },
          commands: { setWorkspaceColor: f.store.setWorkspaceColor.bind(f.store) },
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
        case "set_notifications":
          name = "project_write";
          input = { action, workspaceId: project.id, muted: true };
          different = { muted: false };
          person = {
            type: "workspace.notifications.update",
            workspaceId: project.id,
            muted: false,
            idempotencyKey: randomUUID(),
          };
          observe = () =>
            f.store.notificationState.listWorkspacePreferences({
              userId: run.userId,
              workspaceIds: [project.id],
            });
          break;
        case "set_icon":
          name = "project_write";
          input = { action, workspaceId: project.id, icon: "folder" };
          different = { icon: "code" };
          person = {
            type: "workspace.icon.set",
            workspaceId: project.id,
            icon: "code",
            idempotencyKey: randomUUID(),
          };
          observe = () => f.store.getWorkspaceForOwner(project.id, run.userId);
          break;
        case "set_color":
          name = "project_write";
          input = { action, workspaceId: project.id, color: "blue" };
          different = { color: "green" };
          person = {
            type: "workspace.color.set",
            workspaceId: project.id,
            color: "green",
            idempotencyKey: randomUUID(),
          };
          observe = () => f.store.getWorkspaceForOwner(project.id, run.userId);
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
          () =>
            service.execute({ kind: "person", userId: run.userId, isAdministrator: true }, person),
          observe,
          different,
        );
      } finally {
        await agent.service.close();
      }
    });
  }

  it("replays Project deletion, recovery and storage retry after intervening person commands", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("project-retry");
    const project = await f.createProjectWorkspace(run.userId, "project-retry-target");
    await f.database
      .updateTable("workspaces")
      .set({
        backing: {
          ...project.backing,
          ...(run.workspace.backing.kind === "local-directory"
            ? {
                storageAuthorityId: run.workspace.backing.storageAuthorityId,
                ownerEnvironmentId: run.workspace.backing.ownerEnvironmentId,
              }
            : {}),
        },
      })
      .where("id", "=", project.id)
      .execute();
    const workspaces = new WorkspaceService({
      store: f.store,
      shape: { kind: "server", defaultWorkspaceBacking: "local-directory" },
      resolveOwnerEnvironmentId: async () => run.environmentId,
      drivers: { local: { inspect: async () => ({ status: "ready", issue: null }) } as never },
    });
    const deletion = new WorkspaceDeletionService({
      store: f.store,
      drivers: { local: { destroy: vi.fn() } },
      retentionDays: 7,
      terminateRuns: async () => {},
      onWorkspaceEvent: vi.fn(),
      onError: (error) => {
        throw error;
      },
    });
    const agent = mcp(
      {
        store: f.store,
        workspaces,
        workspaceDeletion: deletion,
        apps: { stopWorkspace: vi.fn() },
        realtime: { broadcast: vi.fn(), sendToUsers: vi.fn() },
        integrations: { platform: { store: new IntegrationPlatformStore(f.database) } },
      } as unknown as AdministrationDependencies,
      run.userId,
    );
    const observe = () => f.store.getWorkspaceForOwner(project.id, run.userId);
    try {
      await retryAfterPersonChange(
        agent,
        "project_write",
        { action: "retry_storage", workspaceId: project.id },
        () => deletion.requestDeletion(project.id, run.userId),
        observe,
        { action: "recover" },
      );
      await retryAfterPersonChange(
        agent,
        "project_write",
        { action: "recover", workspaceId: project.id },
        () => deletion.requestDeletion(project.id, run.userId),
        observe,
        { action: "delete" },
      );
      await deletion.recover(project.id, run.userId);
      await retryAfterPersonChange(
        agent,
        "project_write",
        { action: "delete", workspaceId: project.id },
        () => deletion.recover(project.id, run.userId),
        observe,
        { action: "recover" },
      );
    } finally {
      await agent.service.close();
    }
  });

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
          ).toHaveLength(3),
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
      await retryAfterPersonChange(
        agent,
        "browser_profile_write",
        { action: "revoke_grant", grantId: grant.grantId },
        () =>
          f.store.createBrowserProfileGrant({
            access: "read-write",
            createdBy: run.userId,
            profileId: profile.id,
            workspaceId: project.id,
          }),
        () => f.store.listActiveBrowserProfileGrants(run.userId),
        { action: "remove_site", workspaceId: project.id, site: "https://example.test" },
      );
      // Deletion remains a user-wide operation.
      agent.scope(project.id);

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
    const profile = await f.store.createBrowserProfile({
      ownerId: run.userId,
      name: "Old",
      idempotencyKey: "old-profile",
    });
    const browser = new BrowserService({
      hostOrigin: new URL("http://127.0.0.1"),
      repository: f.store,
      signer: {} as never,
      onSessionsChanged: vi.fn(),
      onWorkspaceEvent: vi.fn(),
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
      workspaceId: run.workspace.id,
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
        { action: "remove_site", workspaceId: run.workspace.id, site: site.site },
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
      await retryAfterPersonChange(
        agent,
        "computer_write",
        { action: "revoke", machineId: run.runnerId },
        () => f.store.rememberExecutionChoice(run.userId, { accessMode: "approval-required" }),
        () =>
          f.database
            .selectFrom("runners")
            .select(["revokedAt", "connectionGeneration"])
            .where("id", "=", run.runnerId)
            .executeTakeFirstOrThrow(),
        { machineId: createId("runner") },
      );
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
      await retryAfterPersonChange(
        agent,
        "plugin_manage",
        { action: "deactivate", workspaceId: project.id, pluginId },
        () =>
          platform.plugins.setActivation({
            workspaceId: project.id,
            pluginId,
            active: true,
            actorUserId: run.userId,
          }),
        () => platform.plugins.current(project.id),
        { action: "activate" },
      );
      await retryAfterPersonChange(
        agent,
        "plugin_manage",
        { action: "activate", workspaceId: project.id, pluginId },
        () =>
          platform.plugins.setActivation({
            workspaceId: project.id,
            pluginId,
            active: false,
            actorUserId: run.userId,
          }),
        () => platform.plugins.current(project.id),
        { action: "deactivate" },
      );
    } finally {
      await agent.service.close();
    }
  });
  it("replays plugin update/removal and specialist removal after a person replaces their state", async ({
    storeFixture: f,
  }) => {
    const run = await f.createRunFixture("plugin-retries");
    await f.database
      .updateTable("users")
      .set({ instanceRole: "administrator" })
      .where("id", "=", run.userId)
      .execute();
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
      onWorkspaceEvent: vi.fn(),
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
        workspaceId: run.workspace.id,
        pluginId,
        actorUserId: run.userId,
      });
      store.specialists.setRemovalHandler(async () => {});
      await retryAfterPersonChange(
        agent,
        "plugin_manage",
        { action: "remove_specialist", workspaceId: run.workspace.id, specialistId: specialist.id },
        () =>
          store.specialists.add({
            workspaceId: run.workspace.id,
            pluginId,
            actorUserId: run.userId,
          }),
        () => store.specialists.summaries(run.workspace.id, run.userId),
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
    await f.database
      .updateTable("users")
      .set({ instanceRole: "administrator" })
      .where("id", "=", run.userId)
      .execute();
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
      onWorkspaceEvent: vi.fn(),
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
      await retryAfterPersonChange(
        agent,
        "integration_manage",
        { action: "revoke_grant", workspaceId: run.workspace.id, grantId },
        async () => {
          await f.database
            .insertInto("integrationGrants")
            .values({
              id: createIntegrationId("grant"),
              workspaceId: run.workspace.id,
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
        () => platform.listGrants({ ownerUserId: run.userId, workspaceId: run.workspace.id }),
        { grantId: createIntegrationId("grant") },
      );
      expect(
        await platform.listGrants({ ownerUserId: run.userId, workspaceId: run.workspace.id }),
      ).toHaveLength(1);
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
