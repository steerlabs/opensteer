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
import { AutomationFailureStore, ChannelStore, OpensteerStore } from "@opensteer/database";
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

it("runs no PostgreSQL queries from idle queue and execution owners for five minutes", async () => {
  const clone = await cloneTestDatabase("host");
  const pool = new Pool({ connectionString: clone.url, idleTimeoutMillis: 0 });
  const database = createDatabase({ connectionString: clone.url }, pool);
  const store = new OpensteerStore(database);
  const channelStore = new ChannelStore(database);
  const failureStore = new AutomationFailureStore(database);
  const channelPlanned = Promise.withResolvers<void>();
  const continuationPlanned = Promise.withResolvers<void>();
  const failuresPlanned = Promise.withResolvers<void>();
  const onError = vi.fn();
  const nextIngressDeadline = channelStore.nextIngressDeadline.bind(channelStore);
  const nextContinuationDeadline = store.requests.nextContinuationDeadline.bind(store.requests);
  vi.spyOn(channelStore, "nextIngressDeadline").mockImplementation(async () => {
    const result = await nextIngressDeadline();
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
  const acquisitions = vi.fn();
  pool.on("acquire", acquisitions);
  const channels = new ChannelService({
    canonicalOrigin: "https://opensteer.test",
    channels: channelStore,
    credentials: {} as CredentialService,
    relay: {} as MessagingRelayHub,
    runners: {
      canRunHarness: () => false,
      identityForEnvironment: () => undefined,
      isAvailable: () => false,
    },
    store,
    onExecutionQueued() {},
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
      Promise.all([channelPlanned.promise, continuationPlanned.promise, failuresPlanned.promise]),
      2_000,
      { timeoutError: () => new Error("Idle owners did not finish their startup reads") },
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    display = new DisplayStreamHub({} as DisplayStreamHubOptions);
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
      continuations.close(),
      automationFailures.close(),
      leases.close(),
    ]);
    await database.destroy();
    await clone.drop();
  }
});
