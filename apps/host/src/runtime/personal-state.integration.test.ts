import { createId } from "@opensteer/core";
import { agentHomeFilesCapability } from "@opensteer/protocol";
import { sql } from "kysely";
import { ExecutionCoordinator } from "@opensteer/orchestration";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "@opensteer/database/connection";
import { seedPersonalFixture } from "@opensteer/database/test-support/personal";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { installPersonalMutationHooks } from "@opensteer/database/personal-mutation";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, it, vi } from "vitest";
import { Pool } from "pg";
import {
  AutomationFailureStore,
  ChannelStore,
  isEligibleBrowserRunner,
  OpensteerStore,
} from "@opensteer/database";
import {
  ContinuationService,
  type IntegrationInventorySource,
} from "../agents/continuation-service.js";
import { ChannelService } from "../channels/channel-service.js";
import type { MessagingRelayHub } from "../channels/messaging-relay-hub.js";
import {
  DisplayStreamHub,
  type DisplayStreamHubOptions,
} from "../computer-use/display-stream-hub.js";
import type { CredentialService } from "../identity/credential-service.js";
import { AutomationFailureService } from "../triggers/automation-failure-service.js";
import { executionLeaseDrain } from "./execution-leases.js";
import { initializePersonalState } from "./personal-state.js";

it("invalidates Personal settings resources once when the hosting computer first makes personal settings ready", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "personal-state-notice-")));
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url });
  try {
    const config = { agentHome: join(directory, "agent-home") };
    const personal = await seedPersonalFixture(database, config.agentHome);
    await database.deleteFrom("personalSettings").execute();
    await database
      .updateTable("runners")
      .set({ revokedAt: new Date() })
      .where("id", "=", personal.runnerId)
      .execute();
    const notices: string[] = [];
    const syncState = () =>
      database
        .selectFrom("clientSyncState")
        .select(["sequence", "resourceRevisions"])
        .executeTakeFirstOrThrow();
    const before = await syncState();
    let latestHead = before.sequence;
    const committed: Promise<unknown>[] = [];
    const unhook = installPersonalMutationHooks(database, {
      wake: ({ head }) => {
        if (head === latestHead) return;
        latestHead = head;
        notices.push(head);
        committed.push(
          database.selectFrom("personalSettings").select("ownerId").executeTakeFirstOrThrow(),
        );
      },
      onFailure: (error) => {
        throw error;
      },
    });
    const initialize = () =>
      initializePersonalState(database, { ...config, environmentId: personal.environmentId });
    expect(await initialize()).toBeNull();
    expect(notices).toEqual([]);
    await database
      .updateTable("runners")
      .set({ revokedAt: null })
      .where("id", "=", personal.runnerId)
      .execute();
    const services = await Promise.all([initialize(), initialize()]);
    expect(services.every(Boolean)).toBe(true);
    const after = await syncState();
    expect(notices).toEqual([after.sequence]);
    expect(after.resourceRevisions.settings).toBe(after.sequence);
    expect(after.resourceRevisions.settings).not.toBe(before.resourceRevisions.settings);
    expect(await Promise.all(committed)).toEqual([{ ownerId: personal.userId }]);
    await initialize();
    expect(notices).toHaveLength(1);
    // Reconciling ready settings must not queue behind, or hold, the Deployment sync fence.
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fence = database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("clientSyncState")
        .select("deploymentId")
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      held.resolve();
      await release.promise;
    });
    void fence.catch(held.reject);
    try {
      await held.promise;
      await withTimeout(initialize(), 2_000, {
        timeoutError: () => new Error("Reconciling ready settings waited on the sync fence"),
      });
    } finally {
      release.resolve();
      await fence;
    }
    expect(notices).toHaveLength(1);
    unhook();
  } finally {
    await database.destroy();
    await clone.drop();
    await rm(directory, { recursive: true, force: true });
  }
});

it("initializes Home from the hosting report and refuses a later path change", async () => {
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url });
  try {
    const personal = await seedPersonalFixture(database, "/configured-home");
    await database.deleteFrom("personalSettings").execute();
    await database
      .updateTable("runners")
      .set({
        capabilities: sql<readonly string[]>`${JSON.stringify([agentHomeFilesCapability])}::jsonb`,
      })
      .where("id", "=", personal.runnerId)
      .execute();
    const config = { agentHome: "/configured-home", environmentId: personal.environmentId };
    await expect(initializePersonalState(database, config)).resolves.toBeNull();
    await expect(
      initializePersonalState(database, {
        ...config,
        reportedAgentHome: { computerId: createId("runner"), path: "/other" },
      }),
    ).resolves.toBeNull();
    const reportedAgentHome = { computerId: personal.runnerId, path: "/canonical-home" };
    const initialized = await initializePersonalState(database, { ...config, reportedAgentHome });
    expect(initialized?.options.agentHome).toEqual(reportedAgentHome);
    await expect(
      initializePersonalState(database, {
        ...config,
        reportedAgentHome: { ...reportedAgentHome, path: "/other-home" },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await initializePersonalState(database, config))?.options.agentHome).toEqual(
      reportedAgentHome,
    );
  } finally {
    await database.destroy();
    await clone.drop();
  }
});

it("tells the owner a Home still waiting for Agent home is not ready, and no one else anything new", async () => {
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url });
  try {
    const personal = await seedPersonalFixture(database, "/configured-home");
    await database.deleteFrom("personalSettings").execute();
    await database
      .updateTable("runners")
      .set({
        capabilities: sql<readonly string[]>`${JSON.stringify([agentHomeFilesCapability])}::jsonb`,
      })
      .where("id", "=", personal.runnerId)
      .execute();
    const config = { agentHome: "/configured-home", environmentId: personal.environmentId };
    await expect(initializePersonalState(database, config)).resolves.toBeNull();
    // An owner-only read in the window: the owner hears "not ready", retryable.
    await expect(
      isEligibleBrowserRunner(database, personal.userId, personal.runnerId),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "The hosting computer is not ready.",
      retryable: true,
    });
    // Anyone else is still refused as not the owner.
    await expect(
      isEligibleBrowserRunner(database, createId("user"), personal.runnerId),
    ).rejects.toMatchObject({ code: "forbidden" });
    await initializePersonalState(database, {
      ...config,
      reportedAgentHome: { computerId: personal.runnerId, path: "/canonical-home" },
    });
    await expect(
      isEligibleBrowserRunner(database, personal.userId, personal.runnerId),
    ).resolves.toBeTypeOf("boolean");
    // A disabled owner of a started Home is refused, not told to wait.
    await database
      .updateTable("users")
      .set({ disabledAt: new Date() })
      .where("id", "=", personal.userId)
      .execute();
    await expect(
      isEligibleBrowserRunner(database, personal.userId, personal.runnerId),
    ).rejects.toMatchObject({ code: "forbidden" });
  } finally {
    await database.destroy();
    await clone.drop();
  }
});

it("runs no PostgreSQL queries from idle queue and execution owners for five minutes", async () => {
  const clone = await cloneTestDatabase("host");
  const pool = new Pool({ connectionString: clone.url, idleTimeoutMillis: 0 });
  const database = createDatabase({ connectionString: clone.url }, pool);
  const store = new OpensteerStore(database);
  const channelStore = new ChannelStore(database);
  const failureStore = new AutomationFailureStore(database);
  const coordinatorPlanned = Promise.withResolvers<void>();
  const channelPlanned = Promise.withResolvers<void>();
  const continuationPlanned = Promise.withResolvers<void>();
  const failuresPlanned = Promise.withResolvers<void>();
  const onError = vi.fn();
  const nextIngressDeadline = channelStore.nextIngressDeadline.bind(channelStore);
  const nextContinuationDeadline = store.requests.nextContinuationDeadline.bind(store.requests);
  vi.spyOn(channelStore, "nextIngressDeadline").mockImplementation(async (asOf) => {
    const result = await nextIngressDeadline(asOf);
    channelPlanned.resolve();
    return result;
  });
  vi.spyOn(store.requests, "nextContinuationDeadline").mockImplementation(async (...args) => {
    const result = await nextContinuationDeadline(...args);
    continuationPlanned.resolve();
    return result;
  });
  const nextFailureDeadline = failureStore.nextDeadline.bind(failureStore);
  vi.spyOn(failureStore, "nextDeadline").mockImplementation(async () => {
    const result = await nextFailureDeadline();
    failuresPlanned.resolve();
    return result;
  });
  const listPendingCommands = store.listPendingCommands.bind(store);
  const coordinator = new ExecutionCoordinator({
    dispatcher: { isAvailable: () => false, dispatch: vi.fn() },
    dispatcherId: "idle-fixture",
    maxConcurrentRuns: 1,
    maxConcurrentTriggerPrograms: 1,
    maxQueuedBytes: 1024,
    maxQueuedCommands: 8,
    store,
  });
  vi.spyOn(store, "listPendingCommands").mockImplementation(async (...args) => {
    const result = await listPendingCommands(...args);
    coordinatorPlanned.resolve();
    return result;
  });
  const acquisitions = vi.fn();
  pool.on("acquire", acquisitions);
  const channels = new ChannelService({
    channels: channelStore,
    credentials: {} as CredentialService,
    relay: {} as MessagingRelayHub,
    bridgeTools: () => ({ callTool: async () => ({}) }),
    store,
    onError,
  });
  const continuations = new ContinuationService({
    commands: { enqueueThreadInput: vi.fn() },
    integrations: {} as IntegrationInventorySource,
    onError,
    requests: store.requests,
  });
  const automationFailures = new AutomationFailureService({
    commands: { enqueueThreadInput: vi.fn() },
    onError,
    store: failureStore,
  });
  const leases = executionLeaseDrain(store, () => {}, onError);
  let display: DisplayStreamHub | undefined;
  try {
    await seedPersonalFixture(database, "/agent-home");
    acquisitions.mockClear();
    const planned = withTimeout(
      Promise.all([
        channelPlanned.promise,
        continuationPlanned.promise,
        failuresPlanned.promise,
        coordinatorPlanned.promise,
      ]),
      2_000,
      { timeoutError: () => new Error("Idle owners did not finish their startup reads") },
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    display = new DisplayStreamHub({} as DisplayStreamHubOptions);
    coordinator.start();
    channels.start();
    continuations.start();
    automationFailures.start();
    leases.start();
    await Promise.all([planned, leases.settled()]);
    expect(onError).not.toHaveBeenCalled();
    expect(acquisitions.mock.calls.length).toBeGreaterThan(0);
    acquisitions.mockClear();

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(acquisitions).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
    display?.close();
    await Promise.all([
      channels.close(),
      coordinator.stop(),
      continuations.close(),
      automationFailures.close(),
      leases.close(),
    ]);
    await database.destroy();
    await clone.drop();
  }
});
