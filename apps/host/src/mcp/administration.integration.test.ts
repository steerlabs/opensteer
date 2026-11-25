import {
  enrollTestRunner,
  type StoreFixture,
  testModelSelection,
  testReadyHarnessCatalog,
  personalBrowserRepository,
} from "@opensteer/database/test-support/store";
import { createId, DeviceIdSchema, type UserId } from "@opensteer/core";
import { AgentConnectionStore, BrowserSourceStore, commandAdmission } from "@opensteer/database";
import { startPersonalQueuedRunFixture } from "@opensteer/database/test-support/personal-run";
import { describeStore } from "@opensteer/database/test-support/store";
import { RealtimeHub } from "@opensteer/orchestration";
import { randomUUID } from "node:crypto";
import type { HostApiCommand } from "@opensteer/protocol";
import { expect, vi } from "vitest";
import { ShellSessionIdSchema } from "@opensteer/protocol";
import {
  AdministrationService,
  type AdministrationDependencies,
} from "../administration/administration-service.js";
import { BrowserService } from "../browser/browser-service.js";
import { agentCommandRegistry } from "../commands/agent-door.js";
import { AdministrationToolHandlers } from "./handlers/administration.js";
import { CommandTools } from "./handlers/commands.js";
import { agentToolHandlers } from "./handlers/index.js";
import type { AgentToolHandlers } from "./handlers/types.js";
import type { AgentCaller } from "./agent-caller.js";
import { OpensteerMcpService } from "./opensteer-mcp-service.js";

async function mcp(
  dependencies: AdministrationDependencies,
  fixture: Pick<
    Awaited<ReturnType<StoreFixture["createRunFixture"]>>,
    "userId" | "environmentId" | "runnerId" | "harnessInstance"
  >,
) {
  const { userId, environmentId, runnerId, harnessInstance } = fixture;
  const { store } = dependencies;
  const { thread } = await store.createThread({
    createdBy: userId,
    environmentId,
    harnessInstanceId: harnessInstance.id,
    modelSelection: testModelSelection,
    accessMode: "full-access",
    title: "Administration",
    idempotencyKey: randomUUID(),
  });
  const queued = await store.enqueueThreadInput({
    threadId: thread.id,
    requestedBy: userId,
    source: { kind: "human" },
    policy: "queue",
    content: [{ type: "text", text: "Manage settings" }],
    idempotencyKey: randomUUID(),
  });
  if (!queued.run) throw new Error("Administration Run did not queue");
  const { runId, bindingGeneration, runnerBootId } = await startPersonalQueuedRunFixture(
    store,
    queued.run.id,
  );
  const epoch = Math.floor(Date.now() / 1000);
  const native: AgentCaller = {
    kind: "run",
    key: `run:${runId}`,
    userId,
    accessMode: "full-access",
    thread,
    claims: {
      aud: "opensteer-run-tools",
      iss: "opensteer-host",
      jti: randomUUID(),
      exp: epoch + 60,
      iat: epoch,
      environmentId,
      runnerId,
      runId,
      bindingGeneration,
      runnerBootId,
      requestedBy: userId,
      threadId: thread.id,
    },
  };
  const connections = new AgentConnectionStore(dependencies.store.database);
  const connection = await connections.create({
    userId,
    label: "Administration test",
    clientName: "Administration test",
    accessMode: "full-access",
    resource: "https://home.test",
    expiresAt: new Date(Date.now() + 60_000),
  });
  await connections.activate(connection.id, randomUUID());
  const caller: AgentCaller = {
    kind: "connection",
    grant: { scope: "everything" },
    grantRevision: 1,
    connectionId: connection.id,
    key: `connection:${connection.id}`,
    userId,
    accessMode: "full-access",
  };
  const administration = new AdministrationToolHandlers(
    new AdministrationService(dependencies, vi.fn()),
    () => true,
  );
  // The administration tools A5 removed are Home commands sent with opensteer_command now.
  const handlers = agentToolHandlers({
    administration,
    commands: new CommandTools({
      database: dependencies.store.database,
      registry: agentCommandRegistry(administration.service),
      requests: () => undefined,
      administration,
      secretDigestKey: Buffer.alloc(32, 0x33),
    }),
  } as never);
  const service = new OpensteerMcpService({
    callers: { authenticate: async () => native },
    handlers: handlers as AgentToolHandlers,
    store: dependencies.store,
    publicUrl: new URL("http://127.0.0.1"),
  });
  return {
    connection,
    service,
    expectRemoved: async (
      name: string,
      input: Record<string, unknown>,
      operationKey = randomUUID(),
    ) => {
      const options = { operationKey, caller };
      const removed = await service.callToolResult("token", name, input, options);
      const unknown = await service.callToolResult("token", "unknown_fixture_tool", input, options);
      expect(JSON.stringify(removed)).toBe(JSON.stringify(unknown));
      expect(removed).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "not_found" } },
      });
    },
    call: async (name: string, input: Record<string, unknown>, operationKey = randomUUID()) => {
      const command = removedToolCommand(name, input, environmentId);
      const result = await service.callTool(
        "token",
        command ? "opensteer_command" : name,
        command ? { command } : input,
        { operationKey },
      );
      if (typeof result === "string") throw new Error(`${name} returned text, not a record`);
      return result;
    },
  };
}
/** The command a removed administration tool sent, as its handler built it before A5. */
function removedToolCommand(
  name: string,
  input: Record<string, unknown>,
  environmentId: string,
): Record<string, unknown> | undefined {
  switch (name) {
    case "opensteer_ai_account_update": {
      const common = { environmentId, harnessInstanceId: input.aiAccountId };
      switch (input.action) {
        case "rename":
          return { type: "harness.rename", ...common, name: input.name };
        case "enable":
        case "disable":
          return { type: "harness.enabled.set", ...common, enabled: input.action === "enable" };
        case "set_default":
          return { type: "harness.default.set", ...common };
        default: {
          const limits = input.modelLimits as { modelId: string; limits: unknown };
          return {
            type: "harness.model.configure",
            ...common,
            nativeModelId: limits.modelId,
            settings: limits.limits,
          };
        }
      }
    }
    case "opensteer_defaults_update":
      return { type: "execution.preferences.remember", ...input };
    case "computer_update":
      return { type: "machine.rename", machineId: input.computerId, name: input.name };
    case "computer_remove":
      return input.target === "computer"
        ? { type: "machine.revoke", machineId: input.computerId }
        : { type: "machine.access.session.stop", sessionId: input.sessionId };
    case "browser_profile_update":
      return { type: "browser.profile.rename", profileId: input.profileId, name: input.name };
    case "browser_profile_remove":
      switch (input.target) {
        case "profile":
          return { type: "browser.profile.delete", profileId: input.profileId };
        case "history":
          return { type: "browser.history.clear", profileId: input.profileId };
        case "history_url":
          return { type: "browser.history.remove", profileId: input.profileId, url: input.url };
        default:
          return { type: "browser.site.remove", site: input.site };
      }
    default:
      return undefined;
  }
}
function realtime() {
  const hub = new RealtimeHub();
  return { hub, sendToUsers: vi.spyOn(hub, "sendToUsers") };
}

async function retryAfterPersonChange(
  agent: Awaited<ReturnType<typeof mcp>>,
  name: string,
  input: Record<string, unknown>,
  change: () => Promise<unknown>,
  observe: () => Promise<unknown>,
  different: Record<string, unknown>,
) {
  const key = randomUUID();
  await agent.expectRemoved(name, input, key);
  const original = await agent.call(name, input, key);
  await change();
  await agent.expectRemoved(name, input, key);
  const afterPerson = await observe();
  expect(await agent.call(name, input, key)).toEqual(original);
  expect(await observe()).toEqual(afterPerson);
  await expect(agent.call(name, { ...input, ...different }, key)).rejects.toMatchObject({
    code: "conflict",
  });
  expect(await observe()).toEqual(afterPerson);
}

describeStore("MCP administration", (it) => {
  for (const [name, change, refusal] of [
    // A mode that no longer reaches asks the person: authority-changed, as the tools map it.
    [
      "mode lowered",
      { accessMode: "approval-required" },
      { code: "forbidden", reason: "authority-changed" },
    ],
    // A grant that no longer names the Home's devices reads as not there at all.
    [
      "grant narrowed",
      { grant: { scope: "selected", tasks: true, resources: [] } },
      { code: "not_found", message: "That item is unavailable." },
    ],
  ] as const) {
    it(`refuses settings writes and replays with stale MCP authority after ${name}`, async ({
      storeFixture: fixture,
    }) => {
      const run = await fixture.createRunFixture("settings-fence");
      const agent = await mcp(
        {
          store: fixture.store,
          realtime: { broadcast: vi.fn() },
        } as unknown as AdministrationDependencies,
        run,
      );
      try {
        const key = randomUUID();
        const command = { computerId: run.runnerId, name: "Before" };
        await agent.expectRemoved("computer_update", command, key);
        await agent.call("computer_update", command, key);
        await new AgentConnectionStore(fixture.database).update(run.userId, {
          connectionId: agent.connection.id,
          expectedRevision: 1,
          ...change,
        });
        await agent.expectRemoved("computer_update", command, key);
        await agent.expectRemoved("computer_update", { ...command, name: "After" });
        await expect(
          fixture.store.renameRunner(run.runnerId, run.userId, "After", {
            allowDeployment: true,
            administration: {
              requestedBy: run.userId,
              idempotencyKey: randomUUID(),
              type: "machine.rename",
              request: { machineId: run.runnerId, name: "After" },
              authoritySource: { kind: "mcp" },
              ...commandAdmission({
                ownerUserId: run.userId,
                callerKey: `connection:${agent.connection.id}`,
                command: {
                  type: "machine.rename",
                  idempotencyKey: randomUUID(),
                  machineId: run.runnerId as never,
                  name: "After",
                },
              }),
            },
          }),
        ).rejects.toMatchObject(refusal);
        expect(
          await fixture.database
            .selectFrom("runners")
            .select("name")
            .where("id", "=", run.runnerId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ name: "Before" });
      } finally {
        await agent.service.close();
      }
    });
  }

  for (const action of [
    "rename",
    "disable",
    "set_default",
    "set_model_limits",
    "remember_execution",
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
      // A Run may administer another account while it is working on its own.
      await f.store.recordHarnessCatalogs({
        catalogs: [testReadyHarnessCatalog(other.id)],
        environmentId: run.environmentId,
        expectedRevisions: new Map([[other.id, other.runtimeRevision]]),
      });
      const agent = await mcp(service.dependencies, { ...run, harnessInstance: other });
      const common = {
        environmentId: run.environmentId,
        harnessInstanceId: run.harnessInstance.id,
      };
      let name = "opensteer_ai_account_update";
      let input: Record<string, unknown> = { action, aiAccountId: run.harnessInstance.id };
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
        case "disable":
          different = { action: "enable" };
          person = {
            type: "harness.enabled.set",
            ...common,
            enabled: true,
            idempotencyKey: randomUUID(),
          };
          break;
        case "set_default":
          input.aiAccountId = other.id;
          different = { aiAccountId: run.harnessInstance.id };
          person = { type: "harness.default.set", ...common, idempotencyKey: randomUUID() };
          observe = () => f.store.listHarnessInstances({ environmentIds: [run.environmentId] });
          break;
        case "set_model_limits":
          await f.store.updateHarnessInstance({
            id: run.harnessInstance.id,
            config: { models: { test: { contextWindow: 1000 } } },
          });
          input.modelLimits = { modelId: "test", limits: { contextWindow: 2000 } };
          different = { modelLimits: { modelId: "test", limits: { contextWindow: 4000 } } };
          person = {
            type: "harness.model.configure",
            ...common,
            nativeModelId: "test",
            settings: { contextWindow: 3000 },
            idempotencyKey: randomUUID(),
          };
          break;
        case "remember_execution":
          name = "opensteer_defaults_update";
          input = { accessMode: "approval-required" };
          different = { accessMode: "full-access" };
          person = {
            type: "execution.preferences.remember",
            accessMode: "full-access",
            idempotencyKey: randomUUID(),
          };
          observe = () => f.store.getExecutionPreferences(run.userId);
          break;
        case "computer_rename":
          name = "computer_update";
          input = { computerId: run.runnerId, name: "A" };
          different = { name: "Changed" };
          person = {
            type: "machine.rename",
            machineId: DeviceIdSchema.parse(run.runnerId),
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
    const rt = realtime();
    const browser = new BrowserService({
      deploymentId: run.deploymentId,
      hostOrigin: new URL("http://127.0.0.1"),
      repository: personalBrowserRepository(f.store),
      signer: {} as never,
      onSessionsChanged: () => {},
      onHistoryChanged: (ownerId, profileId) =>
        rt.hub.sendToUsers([ownerId], { type: "host.browser-history-changed", profileId }),
    });
    const agent = await mcp(
      {
        store: f.store,
        browser,
        browserSources: { listState: async () => ({ sites: [] }) },
        realtime: rt.hub,
      } as unknown as AdministrationDependencies,
      run,
    );
    try {
      await agent.expectRemoved("browser_profile_list", {});
      const listed = await agent.call("browser_profile_list", {});
      expect(listed.profiles).toEqual([
        {
          id: profile.id,
          name: "Private",
          home: { computerId: browserRunnerId, name: "Browser", reachable: false },
        },
      ]);
      expect(JSON.stringify(listed)).not.toContain("storageInstanceId");
      await retryAfterPersonChange(
        agent,
        "browser_profile_update",
        { profileId: profile.id, name: "A" },
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
        "browser_profile_remove",
        { target: "history", profileId: profile.id },
        visit,
        history,
        { target: "history_url", url: "https://example.test/history" },
      );
      await retryAfterPersonChange(
        agent,
        "browser_profile_remove",
        { target: "history_url", profileId: profile.id, url: "https://example.test/history" },
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
            rt.sendToUsers.mock.calls.some(
              ([owners, message]) =>
                [...owners].includes(run.userId) && message.type === "host.browser-history-changed",
            ),
            "history change never reached the other device",
          ).toBe(true),
        { timeout: 2000 },
      );
    } finally {
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
    const agent = await mcp(
      {
        store: f.store,
        browser,
        browserSources: { removeSite: sources.removeGrant.bind(sources) },
        realtime: { broadcast: vi.fn(), publishConnectionsChanged: vi.fn() },
      } as unknown as AdministrationDependencies,
      run,
    );
    try {
      await retryAfterPersonChange(
        agent,
        "browser_profile_remove",
        { target: "profile", profileId: profile.id },
        () =>
          f.store.createBrowserProfile({
            ownerId: run.userId,
            name: "Replacement",
            idempotencyKey: "new-profile",
          }),
        () => f.store.listBrowserProfiles(run.userId),
        { target: "history" },
      );
      await retryAfterPersonChange(
        agent,
        "browser_profile_remove",
        { target: "site", site: site.site },
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
    const agent = await mcp(
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
      run,
    );
    try {
      await retryAfterPersonChange(
        agent,
        "computer_remove",
        { target: "session", sessionId },
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
    const targetRunnerId = createId("runner");
    await f.database
      .updateTable("personalRemoteAccess")
      .set({ mode: "private", routeOrigin: "https://personal.mcp.test", generation: 1 })
      .execute();
    await enrollTestRunner(f.store, {
      createdBy: run.userId,
      environmentId: run.environmentId,
      runnerId: targetRunnerId,
      runnerKind: "local",
      allowedModules: ["browser", "integrations", "messaging", "shell"],
      modules: { browser: { runtimeId: "browser", wireVersion: 2 } },
      name: "Removed computer",
      tokenSuffix: targetRunnerId,
    });
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
    const rt = realtime();
    const browser = new BrowserService({
      deploymentId: run.deploymentId,
      hostOrigin: new URL("https://host.test"),
      repository: personalBrowserRepository(f.store),
      signer: {} as never,
      onSessionsChanged: () => undefined,
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
      authenticator: { identity: { announceSessionsEnded: vi.fn() } },
      store: f.store,
      shellControl: {
        withMachineAdmission: async (_id: unknown, effect: () => Promise<unknown>) => effect(),
        endMachineSessions: vi.fn(),
      },
      publishDeploymentEvent: vi.fn(),
      computerApps: {
        withDeviceAdmissions: async (_ids: unknown, effect: () => Promise<unknown>) => effect(),
        forgetDevice: vi.fn(),
        refreshDeviceDrivers: async () => {},
        withRunnerAdmission: async (_id: unknown, effect: () => Promise<unknown>) => effect(),
        detachRunner: vi.fn(),
      },
      runners: { revoke: revoked },
      channels: { relay: { forget: vi.fn() } },
      browser,
      integrations: { continuations: { notify: vi.fn() } },
      realtime: rt.hub,
    };
    const before = await f.database
      .selectFrom("clientSyncState")
      .select("resourceRevisions")
      .executeTakeFirstOrThrow();
    const agent = await mcp(deps as unknown as AdministrationDependencies, run);
    try {
      await retryAfterPersonChange(
        agent,
        "computer_remove",
        { target: "computer", computerId: targetRunnerId },
        () => f.store.rememberExecutionChoice(run.userId, { accessMode: "approval-required" }),
        () =>
          f.database
            .selectFrom("runners")
            .select(["revokedAt", "connectionGeneration"])
            .where("id", "=", targetRunnerId)
            .executeTakeFirstOrThrow(),
        { computerId: createId("runner") },
      );
      expect(revoked).toHaveBeenCalledOnce();
      expect(abandonSession).toHaveBeenCalledWith(session.id);
      expect(await f.store.getBrowserProfile(profile.id, run.userId)).toBeNull();
      const after = await f.database
        .selectFrom("clientSyncState")
        .select("resourceRevisions")
        .executeTakeFirstOrThrow();
      expect(BigInt(after.resourceRevisions.machine)).toBeGreaterThan(
        BigInt(before.resourceRevisions.machine),
      );
      expect(BigInt(after.resourceRevisions["browser-profile"])).toBeGreaterThan(
        BigInt(before.resourceRevisions["browser-profile"]),
      );
      expect(await f.store.effectiveMachineOwner(targetRunnerId)).toBeNull();
    } finally {
      await agent.service.close();
      await browser.close();
    }
  });
});
