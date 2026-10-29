import { createHash, randomUUID } from "node:crypto";
import {
  emptyExecutionPreferences,
  executionHistoryLimit,
  HarnessIdSchema,
  ModelSelectionSchema,
  createId,
  type EnvironmentId,
  type HarnessInstanceId,
} from "@opensteer/core";
import {
  HarnessInstanceCatalogSchema,
  maxHarnessInstancesPerEnvironment,
} from "@opensteer/protocol";
import { MAX_PENDING_TRIGGER_OCCURRENCES } from "@opensteer/triggers";
import { sql } from "kysely";
import { expect } from "vitest";
import { administratorDirectoryProjectionMigration } from "./migrations.js";
import {
  acquireDeploymentAuthorityLease,
  admitTriggerControlRequest,
  AccountDirectoryStore,
  agentControlActionLimits,
  migrateToLatest,
} from "./index.js";
import {
  describeStore,
  testModelSelection,
  testContinuationIdentity,
  testWorkspaceProfile,
  portableFsBacking,
  enrollTestRunner,
  pendingEvent,
} from "./store.integration.test-support.js";

describeStore("PostgreSQL store", (it) => {
  it("trims a person's execution history to the limit, dropping the oldest", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const userId = await store.createUser("Alex");
    const environmentId = createId("environment");
    const harnessInstanceId = createId("harnessInstance");
    const selectionFor = (index: number) => ({
      environmentId,
      harnessInstanceId,
      modelSelection: ModelSelectionSchema.parse({
        modelId: `model-${index}`,
        options: {},
        providerId: "openai",
      }),
    });

    let preferences = emptyExecutionPreferences;
    for (let index = 0; index <= executionHistoryLimit; index += 1) {
      preferences = await store.rememberExecutionChoice(userId, {
        selection: selectionFor(index),
      });
    }

    expect(preferences.history).toHaveLength(executionHistoryLimit);
    expect(preferences.history[0]).toEqual(selectionFor(executionHistoryLimit));
    expect(preferences.history.at(-1)).toEqual(selectionFor(1));
    await expect(store.getExecutionPreferences(userId)).resolves.toEqual(preferences);
  });

  it("does not publish a catalog after its profile revision changes or is removed", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const environmentId = await store.createEnvironment({ kind: "local", name: "Laptop" });
    const harness = await store.createHarnessInstance({
      config: { model: "old" },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Native",
      stateKind: "isolated",
    });
    const catalog = HarnessInstanceCatalogSchema.parse({
      continuationIdentity: testContinuationIdentity,
      driverKind: "native",
      harnessInstanceId: harness.id,
      models: [
        {
          displayName: "GPT-5.6 Sol",
          isDefault: true,
          modelId: "gpt-5.6-sol",
          options: [],
          providerId: "openai",
        },
      ],
      status: "ready",
    });

    const reconfigured = await store.updateHarnessInstance({
      config: { model: "new" },
      id: harness.id,
    });
    await expect(
      store.recordHarnessCatalogs({
        catalogs: [catalog],
        environmentId,
        expectedRevisions: new Map([[harness.id, harness.runtimeRevision]]),
      }),
    ).resolves.toEqual([]);
    await expect(store.getHarnessCatalog(environmentId, harness.id)).resolves.toBeNull();

    await expect(
      store.recordHarnessCatalogs({
        catalogs: [catalog],
        environmentId,
        expectedRevisions: new Map([[harness.id, reconfigured.runtimeRevision]]),
      }),
    ).resolves.toEqual([catalog]);
    await expect(store.getHarnessCatalog(environmentId, harness.id)).resolves.toMatchObject({
      status: "ready",
    });

    const disabled = await store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Disabled",
      stateKind: "isolated",
    });
    const turnedOff = await store.updateHarnessInstance({ id: disabled.id, enabled: false });
    const elsewhere = await store.createEnvironment({ kind: "local", name: "Elsewhere" });
    const foreign = await store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("native"),
      environmentId: elsewhere,
      name: "Other owner",
      stateKind: "isolated",
    });
    await expect(
      store.recordHarnessCatalogs({
        environmentId,
        catalogs: [
          catalog,
          { ...catalog, harnessInstanceId: disabled.id },
          { ...catalog, harnessInstanceId: foreign.id },
        ],
        expectedRevisions: new Map([
          [harness.id, reconfigured.runtimeRevision],
          [disabled.id, turnedOff.runtimeRevision],
          [foreign.id, foreign.runtimeRevision],
        ]),
      }),
    ).resolves.toEqual([catalog]);
    expect(
      (await store.listHarnessCatalogs([environmentId, elsewhere])).map(
        (record) => record.harnessInstanceId,
      ),
    ).toEqual([harness.id]);
    await expect(
      store.recordHarnessCatalogs({ environmentId, catalogs: [], expectedRevisions: new Map() }),
    ).resolves.toEqual([]);

    await store.removeHarnessInstance(environmentId, harness.id);
    await expect(
      store.recordHarnessCatalogs({
        catalogs: [catalog],
        environmentId,
        expectedRevisions: new Map([[harness.id, reconfigured.runtimeRevision]]),
      }),
    ).resolves.toEqual([]);
    await expect(store.getHarnessCatalog(environmentId, harness.id)).resolves.toBeNull();
  });

  it("keeps harness instances environment-scoped and revisions runtime-specific", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const firstEnvironmentId = await store.createEnvironment({ kind: "local", name: "Laptop" });
    const secondEnvironmentId = await store.createEnvironment({ kind: "managed", name: "Cloud" });
    const harness = await store.createHarnessInstance({
      config: { endpoint: "https://one.invalid" },
      driverKind: HarnessIdSchema.parse("opencode"),
      environmentId: firstEnvironmentId,
      name: "OpenCode",
      stateKind: "isolated",
    });
    expect(harness).toMatchObject({
      environmentId: firstEnvironmentId,
      runtimeRevision: 1,
      stateKind: "isolated",
    });
    expect(
      await store.listHarnessInstances({ environmentIds: [firstEnvironmentId], limit: 100 }),
    ).toHaveLength(1);
    expect(
      await store.listHarnessInstances({ environmentIds: [secondEnvironmentId], limit: 100 }),
    ).toEqual([]);
    expect(await store.listHarnessInstances({ environmentIds: [] })).toEqual([]);

    const renamed = await store.updateHarnessInstance({ id: harness.id, name: "OpenCode Work" });
    expect(renamed).toMatchObject({ name: "OpenCode Work", runtimeRevision: 1 });
    const reconfigured = await store.updateHarnessInstance({
      config: { endpoint: "https://two.invalid" },
      id: harness.id,
    });
    expect(reconfigured).toMatchObject({
      config: { endpoint: "https://two.invalid" },
      runtimeRevision: 2,
    });
    const disabled = await store.updateHarnessInstance({ enabled: false, id: harness.id });
    expect(disabled).toMatchObject({ enabled: false, runtimeRevision: 2 });
    const reenabled = await store.updateHarnessInstance({ enabled: true, id: harness.id });
    expect(reenabled).toMatchObject({ enabled: true, runtimeRevision: 2 });
    const removed = await store.removeHarnessInstance(firstEnvironmentId, harness.id);
    expect(removed).toMatchObject({ enabled: false });
    expect(removed.removedAt).toBeInstanceOf(Date);
    await expect(
      store.listHarnessInstances({ environmentIds: [firstEnvironmentId] }),
    ).resolves.toEqual([]);
  });

  it("rejects stale model configuration writes and keeps the winning revision", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const environmentId = await store.createEnvironment({ kind: "local", name: "Model Mac" });
    const harness = await store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Endpoint",
      stateKind: "isolated",
    });
    const writes = await Promise.allSettled([
      store.updateHarnessInstance({
        id: harness.id,
        expectedRuntimeRevision: 1,
        config: { model: "first" },
      }),
      store.updateHarnessInstance({
        id: harness.id,
        expectedRuntimeRevision: 1,
        config: { model: "second" },
      }),
    ]);
    expect(writes.filter((write) => write.status === "fulfilled")).toHaveLength(1);
    const refused = writes.find((write) => write.status === "rejected");
    expect(refused).toMatchObject({ status: "rejected", reason: { code: "conflict" } });
    expect(await store.getHarnessInstance(harness.id)).toMatchObject({ runtimeRevision: 2 });
  });

  it("does not replace configuration underneath active work", async ({ storeFixture }) => {
    const { startRunFixture, store } = storeFixture;
    const fixture = await startRunFixture("harness-config-busy");
    await expect(
      store.updateHarnessInstance({
        id: fixture.harnessInstance.id,
        config: { models: { local: { contextWindow: 32768 } } },
      }),
    ).rejects.toMatchObject({ code: "conflict", retryable: true });
    expect(await store.getHarnessInstance(fixture.harnessInstance.id)).toMatchObject({
      runtimeRevision: 1,
    });
  });

  it("turns a disabled profile's stale catalog off with it", async ({ storeFixture }) => {
    const { store } = storeFixture;
    const environmentId = await store.createEnvironment({ kind: "local", name: "Laptop" });
    const harness = await store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Native",
      stateKind: "isolated",
    });
    await store.recordHarnessCatalogs({
      catalogs: [
        HarnessInstanceCatalogSchema.parse({
          continuationIdentity: testContinuationIdentity,
          driverKind: "native",
          harnessInstanceId: harness.id,
          models: [
            {
              displayName: "GPT-5.6 Sol",
              isDefault: true,
              modelId: "gpt-5.6-sol",
              options: [],
              providerId: "openai",
            },
          ],
          status: "ready",
        }),
      ],
      environmentId,
      expectedRevisions: new Map([[harness.id, harness.runtimeRevision]]),
    });
    expect(await store.getHarnessCatalog(environmentId, harness.id)).not.toBeNull();
    await store.updateHarnessInstance({ enabled: false, id: harness.id });
    expect(await store.getHarnessCatalog(environmentId, harness.id)).toBeNull();
  });

  it("refuses to turn an AI engine off while a Run is still bound to it", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store } = storeFixture;
    const fixture = await startRunFixture("harness-disable-busy");
    await expect(
      store.updateHarnessInstance({ enabled: false, id: fixture.harnessInstance.id }),
    ).rejects.toMatchObject({ code: "conflict", retryable: true });
    // The refusal and the write are one transaction, so nothing is half-applied.
    expect(await store.getHarnessInstance(fixture.harnessInstance.id)).toMatchObject({
      enabled: true,
    });
    // A rename is not a withdrawal of the profile, so it is never refused.
    await expect(
      store.updateHarnessInstance({ id: fixture.harnessInstance.id, name: "Native (busy)" }),
    ).resolves.toMatchObject({ enabled: true, name: "Native (busy)" });

    await store.commitRunnerEvent({
      environmentId: fixture.environmentId,
      event: pendingEvent({
        bindingGeneration: fixture.bindingGeneration,
        data: { status: "completed" },
        environmentId: fixture.environmentId,
        ordinal: 1,
        runId: fixture.run.id,
        threadId: fixture.thread.id,
        type: "run.completed",
        workspaceId: fixture.workspace.id,
      }),
      runnerBootId: fixture.runnerBootId,
      runnerId: fixture.runnerId,
    });
    await expect(
      store.updateHarnessInstance({ enabled: false, id: fixture.harnessInstance.id }),
    ).resolves.toMatchObject({ enabled: false });
  });

  it("refuses to bind a Run to an AI engine that has been turned off", async ({ storeFixture }) => {
    const { createRunFixture, store, enqueueHumanTrigger } = storeFixture;
    const fixture = await createRunFixture("harness-disable-binding");
    await store.updateHarnessInstance({ enabled: false, id: fixture.harnessInstance.id });
    const turn = await enqueueHumanTrigger({
      content: [{ text: "Start the work", type: "text" }],
      idempotencyKey: "harness-disable-binding-turn",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await store.claimCommand(turn.command.id, "harness-disable-binding-dispatcher");
    // The other half of the fence: the profile has to still be enabled at the
    // instant the binding commits, not merely when the dispatcher looked.
    await expect(
      store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: fixture.harnessInstance.id,
        leaseTokenHash: "harness-disable-binding-lease",
        membershipGeneration: 1,
        runnerBootId: "boot-harness-disable-binding",
        runnerId: fixture.runnerId,
        runId: turn.run.id,
        threadId: fixture.thread.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("serializes turning an AI engine off against a Run binding to it", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, database, store } = storeFixture;
    const fixture = await createRunFixture("harness-disable-race");
    // A Run already committed while the profile was enabled. The locks below
    // stand in for its binding transaction still finishing: environment first,
    // then profile, which is the same order lifecycle writes use.
    await enqueueHumanTrigger({
      content: [{ text: "Start the work", type: "text" }],
      idempotencyKey: "harness-disable-race-turn",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    // Stands in for a dispatch that is mid-binding: the share lock
    // `acquireExecutionBinding` takes on the profile row before it commits.
    const binder = await database.startTransaction().execute();
    let binderOpen = true;
    try {
      await binder
        .selectFrom("executionEnvironments")
        .select("id")
        .where("id", "=", fixture.environmentId)
        .forShare()
        .execute();
      await binder
        .selectFrom("harnessInstances")
        .select("enabled")
        .where("id", "=", fixture.harnessInstance.id)
        .forShare()
        .execute();
      const disable = store.updateHarnessInstance({
        enabled: false,
        id: fixture.harnessInstance.id,
      });
      void disable.catch(() => undefined);
      // Prove lifecycle is waiting at the environment fence before releasing it.
      await expect
        .poll(async () => {
          const result = await sql<{
            waiting: number;
          }>`select count(*)::integer as waiting from pg_stat_activity
          where datname = current_database() and application_name = 'opensteer-integration-test'
          and wait_event_type = 'Lock' and query like '%from "execution_environments"%'`.execute(
            database,
          );
          return result.rows[0]!.waiting;
        })
        .toBe(1);
      binderOpen = false;
      await binder.commit().execute();
      await expect(disable).rejects.toMatchObject({ code: "conflict", retryable: true });
      expect(await store.getHarnessInstance(fixture.harnessInstance.id)).toMatchObject({
        enabled: true,
      });
    } finally {
      if (binderOpen) await binder.rollback().execute();
    }
  });

  it("admits one existing-CLI profile per driver on a work location", async ({ storeFixture }) => {
    const { store, database } = storeFixture;
    const environmentId = await store.createEnvironment({ kind: "local", name: "Laptop" });
    const otherEnvironmentId = await store.createEnvironment({ kind: "local", name: "Desktop" });
    const ambient = await store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("codex"),
      environmentId,
      name: "Codex — Existing CLI",
      stateKind: "ambient",
    });
    // The second ambient profile is refused as a conflict the settings surface
    // can render, never as a raw unique-violation reaching the caller as a 500.
    await expect(
      store.createHarnessInstance({
        config: {},
        driverKind: HarnessIdSchema.parse("codex"),
        environmentId,
        name: "Codex — Existing CLI again",
        stateKind: "ambient",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    // Only the pairing is exclusive: another driver, another work location, and
    // an isolated profile of the same driver all remain admissible.
    await expect(
      store.createHarnessInstance({
        config: {},
        driverKind: HarnessIdSchema.parse("codex"),
        environmentId,
        name: "Codex — Private",
        stateKind: "isolated",
      }),
    ).resolves.toMatchObject({ stateKind: "isolated" });
    await expect(
      store.createHarnessInstance({
        config: {},
        driverKind: HarnessIdSchema.parse("codex"),
        environmentId: otherEnvironmentId,
        name: "Codex — Existing CLI",
        stateKind: "ambient",
      }),
    ).resolves.toMatchObject({ environmentId: otherEnvironmentId });

    // The index is the authority, not the pre-check: a writer that bypasses the
    // store is refused by the database itself.
    await expect(
      sql`
        insert into harness_instances(
          id, environment_id, driver_kind, name, config, state_kind, source_id,
          runtime_revision, enabled
        )
        values (
          ${createId("harnessInstance")}, ${environmentId}, 'codex', 'Direct', '{}'::jsonb,
          'ambient', 'codex', 1, true
        )
      `.execute(database),
    ).rejects.toThrow(/harness_instances_one_ambient_per_driver/);

    // Removing the ambient profile frees its driver's slot on that work
    // location, which a tombstone that kept the slot would not.
    await store.removeHarnessInstance(environmentId, ambient.id);
    await expect(
      store.createHarnessInstance({
        config: {},
        driverKind: HarnessIdSchema.parse("codex"),
        environmentId,
        name: "Codex — Existing CLI",
        stateKind: "ambient",
      }),
    ).resolves.toMatchObject({ stateKind: "ambient" });
  });

  it("gives every driver on a work location exactly one default account", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const environmentId = await store.createEnvironment({ kind: "local", name: "Laptop" });
    const otherEnvironmentId = await store.createEnvironment({ kind: "local", name: "Desktop" });
    async function defaults(ids: readonly HarnessInstanceId[]): Promise<boolean[]> {
      const found = await Promise.all(ids.map(async (id) => store.getHarnessInstance(id)));
      return found.map((harness) => harness?.isDefault ?? false);
    }
    async function codex(name: string, environment = environmentId) {
      return store.createHarnessInstance({
        config: {},
        driverKind: HarnessIdSchema.parse("codex"),
        environmentId: environment,
        name,
        stateKind: "isolated",
      });
    }
    const initiallyDisabled = await store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("codex"),
      enabled: false,
      environmentId,
      name: "Codex disabled",
      stateKind: "isolated",
    });
    expect(initiallyDisabled.isDefault).toBe(false);
    // The first enabled account of a pair is the only usable candidate there
    // is, so it takes the default; every later one arrives as an alternative.
    const first = await codex("Codex");
    const second = await codex("Codex 2");
    expect([first.isDefault, second.isDefault]).toEqual([true, false]);
    // The pair is (work location, driver): another driver and another work
    // location each get their own first default.
    await expect(
      store.createHarnessInstance({
        config: {},
        driverKind: HarnessIdSchema.parse("claude"),
        environmentId,
        name: "Claude Code",
        stateKind: "isolated",
      }),
    ).resolves.toMatchObject({ isDefault: true });
    await expect(codex("Codex elsewhere", otherEnvironmentId)).resolves.toMatchObject({
      isDefault: true,
    });

    // Turning off the default atomically promotes the oldest enabled survivor.
    await expect(
      store.updateHarnessInstance({ enabled: false, id: first.id }),
    ).resolves.toMatchObject({ isDefault: false });
    expect(await defaults([initiallyDisabled.id, first.id, second.id])).toEqual([
      false,
      false,
      true,
    ]);
    // With every account off there is no default. The first one enabled into
    // that empty pair claims it, while enabling later accounts leaves it put.
    await store.updateHarnessInstance({ enabled: false, id: second.id });
    expect(await defaults([initiallyDisabled.id, first.id, second.id])).toEqual([
      false,
      false,
      false,
    ]);
    await store.updateHarnessInstance({ enabled: true, id: initiallyDisabled.id });
    await store.updateHarnessInstance({ enabled: true, id: first.id });
    await store.updateHarnessInstance({ enabled: true, id: second.id });
    expect(await defaults([initiallyDisabled.id, first.id, second.id])).toEqual([
      true,
      false,
      false,
    ]);

    // Choosing a default moves it: the pair never holds two, which the partial
    // unique index enforces underneath this.
    expect(
      await store.setDefaultHarnessInstance({ environmentId, harnessInstanceId: second.id }),
    ).toMatchObject({ id: second.id, isDefault: true });
    expect(await defaults([first.id, second.id])).toEqual([false, true]);
    // Repeating the choice is the same choice.
    await expect(
      store.setDefaultHarnessInstance({ environmentId, harnessInstanceId: second.id }),
    ).resolves.toMatchObject({ id: second.id, isDefault: true });

    // A profile that is turned off can never be selected for a Run, so naming
    // it the default would record an answer nothing can use.
    await store.updateHarnessInstance({ enabled: false, id: first.id });
    await expect(
      store.setDefaultHarnessInstance({ environmentId, harnessInstanceId: first.id }),
    ).rejects.toMatchObject({ code: "conflict" });
    // A profile of another work location is not this one's to name.
    await expect(
      store.setDefaultHarnessInstance({
        environmentId: otherEnvironmentId,
        harnessInstanceId: second.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });

    // Retiring the default hands it to the oldest live profile of the pair
    // rather than leaving the driver without one.
    await store.updateHarnessInstance({ enabled: true, id: first.id });
    const third = await codex("Codex 3");
    await store.removeHarnessInstance(environmentId, second.id);
    expect(await defaults([initiallyDisabled.id, first.id, second.id, third.id])).toEqual([
      true,
      false,
      false,
      false,
    ]);
    // A removed profile is nobody's default, and cannot be made one.
    await expect(
      store.setDefaultHarnessInstance({ environmentId, harnessInstanceId: second.id }),
    ).rejects.toMatchObject({ code: "not_found" });

    // Removing the last profile of a pair leaves nothing to promote.
    await store.removeHarnessInstance(environmentId, initiallyDisabled.id);
    expect(await defaults([first.id, third.id])).toEqual([true, false]);
    await store.removeHarnessInstance(environmentId, first.id);
    expect(await defaults([third.id])).toEqual([true]);
    await store.removeHarnessInstance(environmentId, third.id);
    expect(
      (await store.listHarnessInstances({ environmentIds: [environmentId] })).filter(
        (harness) => harness.driverKind === "codex",
      ),
    ).toEqual([]);
  });

  it("serializes concurrent enables so exactly one account claims an empty default", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const environmentId = await store.createEnvironment({ kind: "local", name: "Laptop" });
    const profiles = await Promise.all(
      ["Codex A", "Codex B"].map((name) =>
        store.createHarnessInstance({
          config: {},
          driverKind: HarnessIdSchema.parse("codex"),
          enabled: false,
          environmentId,
          name,
          stateKind: "isolated",
        }),
      ),
    );
    expect(profiles.map(({ isDefault }) => isDefault)).toEqual([false, false]);

    const blocker = await database.startTransaction().execute();
    let blockerOpen = true;
    try {
      await blocker
        .selectFrom("executionEnvironments")
        .select("id")
        .where("id", "=", environmentId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const enables = profiles.map(({ id }) => store.updateHarnessInstance({ enabled: true, id }));
      const settled = Promise.allSettled(enables);
      await expect(
        Promise.race([
          settled.then(() => "settled" as const),
          new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 250)),
        ]),
      ).resolves.toBe("blocked");

      blockerOpen = false;
      await blocker.commit().execute();
      await expect(settled).resolves.toEqual([
        expect.objectContaining({ status: "fulfilled" }),
        expect.objectContaining({ status: "fulfilled" }),
      ]);
      const stored = await Promise.all(profiles.map(({ id }) => store.getHarnessInstance(id)));
      expect(stored.filter((profile) => profile?.isDefault)).toHaveLength(1);
      expect(stored.every((profile) => profile?.enabled)).toBe(true);
    } finally {
      if (blockerOpen) await blocker.rollback().execute();
    }
  });

  it("returns the same profile when a create is retried under one idempotency key", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const userId = await store.createUser("Alex");
    const environmentId = await store.createEnvironment({ kind: "local", name: "Laptop" });
    const input = {
      config: {},
      driverKind: HarnessIdSchema.parse("codex"),
      environmentId,
      idempotency: { key: "harness-create-retry", requestedBy: userId },
      name: "Codex",
      stateKind: "isolated" as const,
    };
    const first = await store.createHarnessInstance(input);
    // A retried click is the same intent, so it resolves to the row the first
    // attempt produced instead of leaving a second profile behind.
    expect(await store.createHarnessInstance(input)).toEqual(first);
    expect(await store.listHarnessInstances({ environmentIds: [environmentId] })).toHaveLength(1);

    // Reusing one key for a different request is a mistake, not a retry.
    await expect(
      store.createHarnessInstance({ ...input, name: "Codex Work" }),
    ).rejects.toMatchObject({ code: "conflict" });

    // Keys belong to the person who sent them; another person's identical key
    // is another request.
    const otherUserId = await store.createUser("Ada");
    const other = await store.createHarnessInstance({
      ...input,
      idempotency: { key: "harness-create-retry", requestedBy: otherUserId },
    });
    expect(other.id).not.toBe(first.id);

    // Reconciles and seeding create profiles with no requester at all, and are
    // untouched by any of this.
    await expect(
      store.createHarnessInstance({
        config: {},
        driverKind: HarnessIdSchema.parse("native"),
        environmentId,
        name: "Native",
        stateKind: "isolated",
      }),
    ).resolves.toMatchObject({ environmentId });
    expect(await store.listHarnessInstances({ environmentIds: [environmentId] })).toHaveLength(3);
  });

  it("caps a work location's AI engines at what one reconcile can carry", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const environmentId = await store.createEnvironment({ kind: "local", name: "Laptop" });
    const filler = Array.from({ length: maxHarnessInstancesPerEnvironment - 1 }, (_, index) => ({
      config: sql<never>`'{}'::jsonb`,
      driverKind: HarnessIdSchema.parse("native"),
      enabled: true,
      environmentId,
      id: createId("harnessInstance"),
      isDefault: false,
      name: `Native ${index}`,
      runtimeRevision: 1,
      sourceId: "native",
      stateKind: "isolated" as const,
    }));
    await database.insertInto("harnessInstances").values(filler).execute();
    // One below the cap the profile set still fits in a reconcile message.
    const last = await store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Native at the cap",
      stateKind: "isolated",
    });
    await expect(
      store.createHarnessInstance({
        config: {},
        driverKind: HarnessIdSchema.parse("native"),
        environmentId,
        name: "One too many",
        stateKind: "isolated",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    // Another work location has its own allowance.
    const otherEnvironmentId = await store.createEnvironment({ kind: "local", name: "Desktop" });
    await expect(
      store.createHarnessInstance({
        config: {},
        driverKind: HarnessIdSchema.parse("native"),
        environmentId: otherEnvironmentId,
        name: "Native elsewhere",
        stateKind: "isolated",
      }),
    ).resolves.toMatchObject({ environmentId: otherEnvironmentId });
    // A tombstone never rides the wire, so removing one frees a slot.
    await store.removeHarnessInstance(environmentId, last.id);
    await expect(
      store.createHarnessInstance({
        config: {},
        driverKind: HarnessIdSchema.parse("native"),
        environmentId,
        name: "Native again",
        stateKind: "isolated",
      }),
    ).resolves.toMatchObject({ environmentId });
    expect(
      await store.listHarnessInstances({ environmentIds: [environmentId], limit: 1_000 }),
    ).toHaveLength(maxHarnessInstancesPerEnvironment);
  });

  it("serializes concurrent profile creation at the wire cap", async ({ storeFixture }) => {
    const { store, database } = storeFixture;
    const environmentId = await store.createEnvironment({ kind: "local", name: "Laptop" });
    await database
      .insertInto("harnessInstances")
      .values(
        Array.from({ length: maxHarnessInstancesPerEnvironment - 1 }, (_, index) => ({
          config: sql<never>`'{}'::jsonb`,
          driverKind: HarnessIdSchema.parse("native"),
          enabled: true,
          environmentId,
          id: createId("harnessInstance"),
          isDefault: false,
          name: `Native ${index}`,
          runtimeRevision: 1,
          sourceId: "native",
          stateKind: "isolated" as const,
        })),
      )
      .execute();

    // Hold the exact parent row profile creation uses as its per-environment
    // fence, then release two competing writers together. One may fill slot
    // 100; the other must count again after it and receive the product conflict.
    const blocker = await database.startTransaction().execute();
    let blockerOpen = true;
    try {
      await blocker
        .selectFrom("executionEnvironments")
        .select("id")
        .where("id", "=", environmentId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const creates = ["First contender", "Second contender"].map((name) =>
        store.createHarnessInstance({
          config: {},
          driverKind: HarnessIdSchema.parse("native"),
          environmentId,
          name,
          stateKind: "isolated",
        }),
      );
      const settled = Promise.allSettled(creates);
      await expect(
        Promise.race([
          settled.then(() => "settled" as const),
          new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 250)),
        ]),
      ).resolves.toBe("blocked");

      blockerOpen = false;
      await blocker.commit().execute();
      const results = await settled;
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejected = results.find(({ status }) => status === "rejected");
      expect(rejected).toMatchObject({
        reason: { code: "conflict" },
        status: "rejected",
      });
      expect(
        await store.listHarnessInstances({ environmentIds: [environmentId], limit: 1_000 }),
      ).toHaveLength(maxHarnessInstancesPerEnvironment);
    } finally {
      if (blockerOpen) await blocker.rollback().execute();
    }
  });

  it("refuses to rewrite a harness profile's identity behind the store", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const environmentId = await store.createEnvironment({ kind: "local", name: "Laptop" });
    const otherEnvironmentId = await store.createEnvironment({ kind: "local", name: "Desktop" });
    const harness = await store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("codex"),
      environmentId,
      name: "Codex",
      stateKind: "isolated",
    });
    await expect(
      database
        .updateTable("harnessInstances")
        .set({ environmentId: otherEnvironmentId })
        .where("id", "=", harness.id)
        .execute(),
    ).rejects.toThrow(/environment, driver, and state kind are immutable/);
    await expect(
      database
        .updateTable("harnessInstances")
        .set({ driverKind: HarnessIdSchema.parse("claude") })
        .where("id", "=", harness.id)
        .execute(),
    ).rejects.toThrow(/environment, driver, and state kind are immutable/);
    await expect(
      database
        .updateTable("harnessInstances")
        .set({ stateKind: "ambient" })
        .where("id", "=", harness.id)
        .execute(),
    ).rejects.toThrow(/environment, driver, and state kind are immutable/);
    await expect(
      database
        .updateTable("harnessInstances")
        .set({ runtimeRevision: 2 })
        .where("id", "=", harness.id)
        .execute(),
    ).resolves.toBeDefined();
    await expect(
      database
        .updateTable("harnessInstances")
        .set({ runtimeRevision: 1 })
        .where("id", "=", harness.id)
        .execute(),
    ).rejects.toThrow(/runtime revision cannot decrease/);
    await store.removeHarnessInstance(environmentId, harness.id);
    await expect(
      database
        .updateTable("harnessInstances")
        .set({ removedAt: null })
        .where("id", "=", harness.id)
        .execute(),
    ).rejects.toThrow(/removed harness instance cannot be restored/);
  });

  it("removes a retired harness profile without losing the Threads it ran", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const fixture = await createRunFixture("harness-removal-lifecycle");
    await enqueueHumanTrigger({
      content: [{ text: "Run once on this engine", type: "text" }],
      idempotencyKey: "harness-removal-run",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });

    // A Thread that is still open keeps its engine: removal would strand work
    // that can still be resumed.
    await expect(
      store.removeHarnessInstance(fixture.environmentId, fixture.harnessInstance.id),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(store.getHarnessInstance(fixture.harnessInstance.id)).resolves.toMatchObject({
      enabled: true,
      removedAt: null,
    });

    await database
      .updateTable("threads")
      .set({ status: "archived", updatedAt: new Date() })
      .where("id", "=", fixture.thread.id)
      .execute();

    const removed = await store.removeHarnessInstance(
      fixture.environmentId,
      fixture.harnessInstance.id,
    );
    expect(removed.removedAt).toBeInstanceOf(Date);
    expect(removed.enabled).toBe(false);
    expect(await store.listHarnessInstances({ environmentIds: [fixture.environmentId] })).toEqual(
      [],
    );
    expect(await store.listHarnessCatalogs([fixture.environmentId])).toEqual([]);

    // The archive still names the engine that ran it, and the Run history it
    // points at is still readable.
    const archived = await store.getThreadForOwner(fixture.thread.id, fixture.userId);
    expect(archived).toMatchObject({
      harnessInstanceId: fixture.harnessInstance.id,
      status: "archived",
    });

    // A repeated removal is the retry of a Runner cleanup that never happened,
    // so it settles on the same tombstone rather than failing.
    const repeated = await store.removeHarnessInstance(
      fixture.environmentId,
      fixture.harnessInstance.id,
    );
    expect(repeated.removedAt?.getTime()).toBe(removed.removedAt?.getTime());

    // A tombstone is refused by name, by the wrong work location, and by every
    // path that would put new work on it.
    const otherEnvironmentId = await store.createEnvironment({
      kind: "local",
      name: "Elsewhere",
    });
    await expect(
      store.removeHarnessInstance(otherEnvironmentId, fixture.harnessInstance.id),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      store.updateHarnessInstance({ enabled: true, id: fixture.harnessInstance.id }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      store.createThread({
        createdBy: fixture.userId,
        environmentId: fixture.environmentId,
        harnessInstanceId: fixture.harnessInstance.id,
        idempotencyKey: "thread-after-harness-removal",
        modelSelection: testModelSelection,
        title: "After removal",
        workspaceId: fixture.workspace.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("defaults access to full, inherits it for children, and snapshots it per Run", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store } = storeFixture;
    const fixture = await createRunFixture("access-mode");
    expect(fixture.thread.accessMode).toBe("full-access");

    const beforeUpdate = await enqueueHumanTrigger({
      content: [{ text: "Run with the original mode", type: "text" }],
      idempotencyKey: "access-mode-before-update",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(beforeUpdate.run.accessMode).toBe("full-access");

    const updated = await store.updateThreadAccessMode({
      accessMode: "auto",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(updated.thread.accessMode).toBe("auto");
    expect(updated.event).toMatchObject({
      data: { accessMode: "auto" },
      threadId: fixture.thread.id,
      type: "thread.access-mode-updated",
    });

    await store.claimCommand(beforeUpdate.command.id, "access-mode-dispatcher");
    await store.failCommand(beforeUpdate.command.id, "Complete the original access snapshot");

    const afterUpdate = await enqueueHumanTrigger({
      content: [{ text: "Run with the updated mode", type: "text" }],
      idempotencyKey: "access-mode-after-update",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(afterUpdate.run.accessMode).toBe("auto");
    expect(beforeUpdate.run.accessMode).toBe("full-access");

    const child = await store.createThread({
      createdBy: fixture.userId,
      environmentId: fixture.environmentId,
      harnessInstanceId: fixture.harnessInstance.id,
      idempotencyKey: "access-mode-child",
      modelSelection: testModelSelection,
      parentThreadId: fixture.thread.id,
      title: "Inherited access",
      workspaceId: fixture.workspace.id,
    });
    expect(child.thread.accessMode).toBe("auto");

    const noChange = await store.updateThreadAccessMode({
      accessMode: "auto",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(noChange.event).toBeUndefined();
  });

  it("creates one stable Deployment identity and rejects incidental authority changes", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const hostInstanceId = createId("hostInstance");
    const first = await store.ensureDeployment({
      canonicalOrigin: "https://host.example",
      hostInstanceId,
      deploymentShape: testWorkspaceProfile,
    });
    const restarted = await store.ensureDeployment({
      canonicalOrigin: "https://host.example",
      hostInstanceId,
      deploymentShape: testWorkspaceProfile,
    });

    expect(restarted).toEqual(first);
    expect(first).toMatchObject({
      activeHostInstanceId: hostInstanceId,
      canonicalOrigin: "https://host.example",
      lifecycle: "active",
    });
    await expect(
      store.ensureDeployment({
        canonicalOrigin: "https://changed.example",
        hostInstanceId,
        deploymentShape: testWorkspaceProfile,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.ensureDeployment({
        canonicalOrigin: "https://host.example",
        hostInstanceId: createId("hostInstance"),
        deploymentShape: testWorkspaceProfile,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const firstLease = await acquireDeploymentAuthorityLease(database);
    try {
      await expect(acquireDeploymentAuthorityLease(database)).rejects.toMatchObject({
        code: "conflict",
      });
    } finally {
      await firstLease.close();
    }
    const replacementLease = await acquireDeploymentAuthorityLease(database);
    await replacementLease.close();
  });

  it("creates and pins a control-plane-provisioned Deployment identity", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const deploymentId = createId("deployment");
    const hostInstanceId = createId("hostInstance");
    const provisioned = await store.ensureDeployment({
      canonicalOrigin: "https://managed.example",
      deploymentId,
      hostInstanceId,
      deploymentShape: testWorkspaceProfile,
    });
    expect(provisioned).toMatchObject({
      activeHostInstanceId: hostInstanceId,
      canonicalOrigin: "https://managed.example",
      id: deploymentId,
    });
    await expect(
      store.ensureDeployment({
        canonicalOrigin: "https://managed.example",
        deploymentId: createId("deployment"),
        hostInstanceId,
        deploymentShape: testWorkspaceProfile,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps a Personal deployment's Main Runner and invitations owner-only", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    await store.ensureDeployment({
      canonicalOrigin: "https://personal.test",
      hostInstanceId: createId("hostInstance"),
      deploymentShape: {
        defaultWorkspaceBacking: "local-directory",
        kind: "personal" as const,
      },
    });
    const ownerId = await store.createUser("Personal owner");
    const otherId = await store.createUser("Persisted second user");
    await database
      .updateTable("users")
      .set({ instanceRole: "administrator" })
      .where("id", "=", ownerId)
      .executeTakeFirstOrThrow();
    const environmentId = createId("environment");
    await enrollTestRunner(store, {
      createdBy: ownerId,
      environmentId,
      name: "Personal Main",
      runnerId: createId("runner"),
      tokenSuffix: "personal-main-authority",
    });
    expect((await store.listEnvironmentsForUser(ownerId)).map(({ id }) => id)).toEqual([
      environmentId,
    ]);
    expect(await store.listEnvironmentsForUser(otherId)).toEqual([]);
    expect(await store.environmentIsAvailableToUser(environmentId, ownerId)).toBe(true);
    expect(await store.environmentIsAvailableToUser(environmentId, otherId)).toBe(false);

    const main = await store.createWorkspace({
      backing: {
        bindingId: createId("workspaceBinding"),
        generation: 1,
        kind: "local-directory",
        ownerEnvironmentId: environmentId,
        storageAuthorityId: createId("storageAuthority"),
      },
      capacityPolicy: { kind: "host-filesystem" },
      createdBy: ownerId,
      idempotencyKey: "personal-main-workspace",
      name: "Main",
      status: "ready",
    });
    const specialized = await store.createWorkspace({
      backing: {
        bindingId: createId("workspaceBinding"),
        generation: 1,
        kind: "local-directory",
        ownerEnvironmentId: environmentId,
        storageAuthorityId: createId("storageAuthority"),
      },
      capacityPolicy: { kind: "host-filesystem" },
      createdBy: ownerId,
      idempotencyKey: "personal-specialized-workspace",
      kind: "specialized",
      name: "Research",
      status: "ready",
    });
    expect(main.kind).toBe("main");
    await database
      .insertInto("workspaceMemberships")
      .values({
        generation: 1,
        id: createId("workspaceMembership"),
        invitedBy: ownerId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        role: "collaborator",
        state: "active",
        updatedAt: new Date(),
        userId: otherId,
        workspaceId: specialized.id,
      })
      .executeTakeFirstOrThrow();
    const harness = await store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Native",
      stateKind: "isolated",
    });
    await expect(
      store.createThread({
        createdBy: otherId,
        environmentId,
        harnessInstanceId: harness.id,
        idempotencyKey: "personal-second-user-thread",
        modelSelection: testModelSelection,
        title: "Forbidden",
        workspaceId: specialized.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      store.createWorkspaceInvitation({
        createdBy: ownerId,
        expiresAt: new Date(Date.now() + 60_000),
        idempotencyKey: "personal-invitation-forbidden",
        intendedEmail: null,
        requestFingerprint: "sha256:personal-invitation-forbidden",
        role: "collaborator",
        selector: "personal-invitation-selector-0001",
        tokenHash: "sha256:personal-invitation-secret",
        type: "link",
        workspaceId: specialized.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });

    const legacySelector = "personal-legacy-invitation-0001";
    await database
      .insertInto("workspaceInvitations")
      .values({
        acceptedAt: null,
        acceptedBy: null,
        createdAt: new Date(),
        createdBy: ownerId,
        expiresAt: new Date(Date.now() + 60_000),
        id: createId("workspaceInvitation"),
        idempotencyKey: "personal-legacy-invitation",
        intendedEmail: null,
        requestFingerprint: "sha256:personal-legacy-invitation",
        revokedAt: null,
        revokedBy: null,
        role: "collaborator",
        selector: legacySelector,
        tokenHash: "sha256:personal-legacy-secret",
        type: "link",
        workspaceId: specialized.id,
      })
      .executeTakeFirstOrThrow();
    await expect(
      store.acceptWorkspaceInvitation({
        selector: legacySelector,
        tokenHash: "sha256:personal-legacy-secret",
        userEmail: `${otherId}@test.invalid`,
        userEmailVerified: true,
        userId: otherId,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("lists a machine's own local-directory Workspaces and no other", async ({ storeFixture }) => {
    const { store } = storeFixture;
    const ownerId = await store.createUser("Local directory owner");
    const mine = await store.createEnvironment({ kind: "local", name: "This computer" });
    const theirs = await store.createEnvironment({ kind: "local", name: "Another computer" });
    const localWorkspace = (environmentId: EnvironmentId, key: string) =>
      store.createWorkspace({
        backing: {
          bindingId: createId("workspaceBinding"),
          generation: 1,
          kind: "local-directory",
          ownerEnvironmentId: environmentId,
          storageAuthorityId: createId("storageAuthority"),
        },
        capacityPolicy: { kind: "host-filesystem" },
        createdBy: ownerId,
        idempotencyKey: key,
        kind: "specialized" as const,
        name: key,
        status: "ready" as const,
      });
    const here = await localWorkspace(mine, "local-listing-here");
    const away = await localWorkspace(theirs, "local-listing-away");
    const shared = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "local_listing_shared",
      },
      capacityPolicy: {
        blockHardLimitBytes: 512 * 1_024 * 1_024,
        inodeHardLimit: 50_000,
        kind: "hard-quota",
      },
      createdBy: ownerId,
      idempotencyKey: "local-listing-shared",
      kind: "specialized",
      name: "Shared",
      status: "ready",
    });

    // The owning environment is a generated column off the backing, so a
    // PortableFS Workspace can never be attributed to a machine.
    expect((await store.listLocalWorkspacesForEnvironments([mine])).map(({ id }) => id)).toEqual([
      here.id,
    ]);
    expect(
      (await store.listLocalWorkspacesForEnvironments([mine, theirs])).map(({ id }) => id).sort(),
    ).toEqual([away.id, here.id].sort());
    expect(await store.listLocalWorkspacesForEnvironments([])).toEqual([]);
    expect(
      (await store.listLocalWorkspacesForEnvironments([mine, theirs])).some(
        ({ id }) => id === shared.id,
      ),
    ).toBe(false);

    // A deleted Workspace has no directory left to reconcile against.
    await store.requestWorkspaceDeletion({
      purgeAfter: new Date(Date.now() - 1),
      requestedBy: ownerId,
      workspaceId: here.id,
    });
    await store.markWorkspaceDeleted({ workspaceId: here.id });
    expect(await store.listLocalWorkspacesForEnvironments([mine])).toEqual([]);
  });

  it("projects only upstream account membership into the publish outbox", async ({
    storeFixture,
  }) => {
    const { createRunFixture, database, store } = storeFixture;
    const fixture = await createRunFixture("directory-projection");
    const directory = new AccountDirectoryStore(database);
    await directory.configureProvider({
      issuer: "https://account.opensteer.test",
      providerId: "oidc:opensteer-account",
    });
    await expect(
      directory.configureProvider({
        issuer: "https://account.opensteer.test",
        providerId: "oidc:opensteer-account",
      }),
    ).resolves.toBeUndefined();
    await expect(
      directory.configureProvider({
        issuer: "https://different-account.test",
        providerId: "oidc:opensteer-account",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await database
      .insertInto("authAccounts")
      .values({
        accessToken: null,
        accessTokenExpiresAt: null,
        accountId: "private-subject",
        createdAt: new Date(),
        id: createId("authAccount"),
        idToken: null,
        password: null,
        providerId: "oidc:operator-private",
        refreshToken: null,
        refreshTokenExpiresAt: null,
        scope: "openid email profile",
        updatedAt: new Date(),
        userId: fixture.userId,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("authAccounts")
      .values({
        accessToken: null,
        accessTokenExpiresAt: null,
        accountId: "account-subject",
        createdAt: new Date(),
        id: createId("authAccount"),
        idToken: null,
        password: null,
        providerId: "oidc:opensteer-account",
        refreshToken: null,
        refreshTokenExpiresAt: null,
        scope: "openid email profile",
        updatedAt: new Date(),
        userId: fixture.userId,
      })
      .executeTakeFirstOrThrow();

    await directory.refreshUser(fixture.userId);
    const present = await directory.claimPending();
    expect(present).toEqual([
      expect.objectContaining({
        accountId: "account-subject",
        generation: 1,
        present: true,
        providerId: "oidc:opensteer-account",
        userId: fixture.userId,
      }),
    ]);
    expect(present.some((projection) => projection.accountId === "private-subject")).toBe(false);
    const firstProjection = present[0]!;
    expect(firstProjection.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    const retryAt = new Date(Date.now() + 1_000);
    expect(
      await directory.fail({
        ...firstProjection,
        error: "temporary control-plane failure",
        nextAttemptAt: retryAt,
      }),
    ).toBe(true);
    const retried = await directory.claimPending({ now: new Date(retryAt.getTime() + 1) });
    expect(retried).toHaveLength(1);
    expect(retried[0]?.generation).toBe(firstProjection.generation);
    expect(retried[0]?.observedAt).toBe(firstProjection.observedAt);
    expect(await directory.complete(retried[0]!)).toBe(true);

    const replacementOwnerId = await store.createUser("Replacement owner");
    await database
      .insertInto("workspaceMemberships")
      .values({
        generation: 1,
        id: createId("workspaceMembership"),
        invitedBy: fixture.userId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        role: "owner",
        state: "active",
        updatedAt: new Date(),
        userId: replacementOwnerId,
        workspaceId: fixture.workspace.id,
      })
      .executeTakeFirstOrThrow();
    await store.changeWorkspaceMembership({
      actorId: replacementOwnerId,
      state: "revoked",
      targetUserId: fixture.userId,
      workspaceId: fixture.workspace.id,
    });
    expect(await directory.claimPending()).toEqual([
      expect.objectContaining({
        accountId: "account-subject",
        generation: 2,
        present: false,
      }),
    ]);
  });

  it("projects enabled administrators without requiring a Workspace membership", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("directory-administrator");
    const administratorId = await store.createUser("Deployment administrator");
    const memberId = await store.createUser("Deployment member");
    const providerId = "oidc:opensteer-account";
    const directory = new AccountDirectoryStore(database);
    await directory.configureProvider({
      issuer: "https://account.opensteer.test",
      providerId,
    });
    await database
      .updateTable("users")
      .set({ instanceRole: "administrator", updatedAt: new Date() })
      .where("id", "=", administratorId)
      .executeTakeFirstOrThrow();
    for (const [accountId, userId] of [
      ["administrator-subject", administratorId],
      ["member-subject", memberId],
    ] as const) {
      await database
        .insertInto("authAccounts")
        .values({
          accessToken: null,
          accessTokenExpiresAt: null,
          accountId,
          createdAt: new Date(),
          id: createId("authAccount"),
          idToken: null,
          password: null,
          providerId,
          refreshToken: null,
          refreshTokenExpiresAt: null,
          scope: "openid",
          updatedAt: new Date(),
          userId,
        })
        .executeTakeFirstOrThrow();
    }
    const projection = (accountId: string) =>
      database
        .selectFrom("accountDirectoryProjections")
        .select(["generation", "present"])
        .where("providerId", "=", providerId)
        .where("accountId", "=", accountId)
        .executeTakeFirst();

    await database
      .deleteFrom("accountDirectoryProjections")
      .where("providerId", "=", providerId)
      .where("accountId", "=", "administrator-subject")
      .execute();
    await administratorDirectoryProjectionMigration.up(database);
    const migratedAdministrator = await projection("administrator-subject");
    expect(migratedAdministrator).toMatchObject({ present: true });
    await administratorDirectoryProjectionMigration.up(database);
    await expect(projection("administrator-subject")).resolves.toEqual(migratedAdministrator);
    await expect(projection("member-subject")).resolves.toBeUndefined();

    await database
      .insertInto("workspaceMemberships")
      .values({
        generation: 1,
        id: createId("workspaceMembership"),
        invitedBy: fixture.userId,
        joinedAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        role: "collaborator",
        state: "active",
        updatedAt: new Date(),
        userId: memberId,
        workspaceId: fixture.workspace.id,
      })
      .executeTakeFirstOrThrow();
    await expect(projection("member-subject")).resolves.toMatchObject({ present: true });

    await database
      .updateTable("users")
      .set({ disabledAt: new Date(), updatedAt: new Date() })
      .where("id", "=", administratorId)
      .executeTakeFirstOrThrow();
    await expect(projection("administrator-subject")).resolves.toMatchObject({ present: false });

    await database
      .updateTable("users")
      .set({ disabledAt: null, instanceRole: "user", updatedAt: new Date() })
      .where("id", "=", administratorId)
      .executeTakeFirstOrThrow();
    await expect(projection("administrator-subject")).resolves.toMatchObject({ present: false });

    await database
      .updateTable("users")
      .set({ instanceRole: "administrator", updatedAt: new Date() })
      .where("id", "=", administratorId)
      .executeTakeFirstOrThrow();
    const promoted = await projection("administrator-subject");
    expect(promoted).toMatchObject({ present: true });
    await migrateToLatest(database);
    await expect(projection("administrator-subject")).resolves.toEqual(promoted);
  });

  it("does not dispatch queued turns while Workspace storage is unavailable", async ({
    storeFixture,
  }) => {
    const { createRunFixture, enqueueHumanTrigger, store, database } = storeFixture;
    const fixture = await createRunFixture("storage-dispatch-gate");
    const turn = await enqueueHumanTrigger({
      content: [{ text: "Wait for durable storage", type: "text" }],
      idempotencyKey: "storage-dispatch-gate-turn",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect((await store.listPendingCommands()).map(({ id }) => id)).toContain(turn.command.id);

    await store.setWorkspaceStorageState({
      issue: {
        code: "manager-unavailable",
        message: "Workspace storage is unavailable.",
        occurredAt: new Date().toISOString(),
        retryable: true,
      },
      status: "unavailable",
      workspaceId: fixture.workspace.id,
    });
    expect((await store.listPendingCommands()).map(({ id }) => id)).not.toContain(turn.command.id);
    await expect(
      store.claimCommand(turn.command.id, "storage-dispatch-gate-direct"),
    ).resolves.toBeNull();
    await expect(
      store.claimNextCommand(fixture.environmentId, "storage-dispatch-gate-next"),
    ).resolves.toBeNull();
    await expect(
      database
        .selectFrom("runs")
        .select("status")
        .where("id", "=", turn.run.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "queued" });

    // Storage that comes back on demand keeps its queued turn visible to the
    // coordinator; only storage that will not recover on its own hides it.
    for (const status of ["archiving", "archived"] as const) {
      await store.setWorkspaceStorageState({
        issue: null,
        status,
        workspaceId: fixture.workspace.id,
      });
      expect((await store.listPendingCommands()).map(({ id }) => id)).toContain(turn.command.id);
      await expect(
        store.claimCommand(turn.command.id, `storage-dispatch-gate-${status}`),
      ).resolves.toBeNull();
    }

    const expectedBacking = portableFsBacking(fixture.workspace);
    await store.setWorkspaceProvisioningResult({
      backing: expectedBacking,
      expectedBacking,
      status: "ready",
      workspaceId: fixture.workspace.id,
    });
    expect((await store.listPendingCommands()).map(({ id }) => id)).toContain(turn.command.id);
    await expect(
      store.claimCommand(turn.command.id, "storage-dispatch-gate-ready"),
    ).resolves.toMatchObject({
      command: { id: turn.command.id },
      events: [
        { type: "thread-input.updated" },
        { data: { status: "starting" }, type: "run.status" },
      ],
    });
  });

  it("tracks Workspace activity without changing updated_at and excludes active Runs from archive", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, database, enqueueHumanTrigger } = storeFixture;
    const fixture = await createRunFixture("workspace-archive-eligibility");
    const before = await store.getWorkspace(fixture.workspace.id);
    // Activity only ever moves forward, and a new row already counts as active
    // as of its creation, so the observed activity has to be later than that.
    const activityAt = new Date(Date.now() + 60_000);
    const idleBefore = new Date(activityAt.getTime() + 60_000);

    await store.noteWorkspaceActivity(fixture.workspace.id, activityAt);

    const after = await store.getWorkspace(fixture.workspace.id);
    expect(after?.updatedAt).toBe(before?.updatedAt);
    await expect(
      database
        .selectFrom("workspaces")
        .select("lastActivityAt")
        .where("id", "=", fixture.workspace.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ lastActivityAt: activityAt });
    expect(
      (await store.listArchiveEligibleWorkspaces({ idleBefore, limit: 100 })).map(({ id }) => id),
    ).toContain(fixture.workspace.id);

    await enqueueHumanTrigger({
      content: [{ text: "Keep this Workspace awake", type: "text" }],
      idempotencyKey: "workspace-archive-eligibility-turn",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    expect(await store.listArchiveEligibleWorkspaces({ idleBefore, limit: 100 })).toEqual([]);
  });

  it("never regresses a Workspace activity timestamp", async ({ storeFixture }) => {
    const { createRunFixture, store, database } = storeFixture;
    const fixture = await createRunFixture("workspace-activity-monotonicity");
    const newer = new Date(Date.now() + 120_000);
    const older = new Date(Date.now() + 60_000);

    await store.noteWorkspaceActivity(fixture.workspace.id, newer);
    await store.noteWorkspaceActivity(fixture.workspace.id, older);

    await expect(
      database
        .selectFrom("workspaces")
        .select("lastActivityAt")
        .where("id", "=", fixture.workspace.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ lastActivityAt: newer });
  });

  it("claims a ready idle PortableFS Workspace for archiving and advances its fence", async ({
    storeFixture,
  }) => {
    const { store, database } = storeFixture;
    const ownerId = await store.createUser("Archive claim owner");
    const idleBefore = new Date(Date.now() + 60_000);
    const workspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "workspace_archive_claim",
      },
      capacityPolicy: {
        blockHardLimitBytes: 512 * 1_024 * 1_024,
        inodeHardLimit: 50_000,
        kind: "hard-quota",
      },
      createdBy: ownerId,
      idempotencyKey: "workspace-archive-claim",
      name: "Archive claim",
      status: "ready",
    });

    const first = await store.claimPortableFsWorkspaceForArchive({
      backingGeneration: 1,
      idleBefore,
      workspaceId: workspace.id,
    });
    expect(portableFsBacking(first)).toEqual({
      ...portableFsBacking(workspace),
      generation: 2,
    });
    // The counter must stay a JSON number: a text assignment would leave the
    // backing unparseable on the next read.
    await expect(
      sql<{
        readonly generationType: string;
      }>`select jsonb_typeof(backing -> 'generation') as "generationType" from workspaces where id = ${workspace.id}`
        .execute(database)
        .then((result) => result.rows[0]),
    ).resolves.toEqual({ generationType: "number" });

    // A stale snapshot cannot claim: the generation it observed is gone.
    await expect(
      store.claimPortableFsWorkspaceForArchive({
        backingGeneration: 1,
        idleBefore,
        workspaceId: workspace.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    await store.setWorkspaceStorageState({
      issue: null,
      status: "archived",
      workspaceId: workspace.id,
    });
    await expect(
      store.claimPortableFsWorkspaceForArchive({
        backingGeneration: 2,
        idleBefore,
        workspaceId: workspace.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(portableFsBacking((await store.getWorkspace(workspace.id))!).generation).toBe(2);

    const localEnvironmentId = await store.createEnvironment({
      kind: "local",
      name: "Archive claim laptop",
    });
    const localWorkspace = await store.createWorkspace({
      backing: {
        bindingId: createId("workspaceBinding"),
        generation: 1,
        kind: "local-directory",
        ownerEnvironmentId: localEnvironmentId,
        storageAuthorityId: createId("storageAuthority"),
      },
      capacityPolicy: { kind: "host-filesystem" },
      createdBy: ownerId,
      idempotencyKey: "workspace-archive-claim-local",
      kind: "specialized",
      name: "Local archive claim",
      status: "ready",
    });
    await expect(
      store.claimPortableFsWorkspaceForArchive({
        backingGeneration: 1,
        idleBefore,
        workspaceId: localWorkspace.id,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      store.claimPortableFsWorkspaceForArchive({
        backingGeneration: 1,
        idleBefore,
        workspaceId: createId("workspace"),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses an archive claim for a still-ready Workspace that is back in use", async ({
    storeFixture,
  }) => {
    const { createRunFixture, store, enqueueHumanTrigger } = storeFixture;
    const fixture = await createRunFixture("archive-claim-in-use");
    const idleBefore = new Date(Date.now() + 60_000);
    const enrollmentId = "44444444-4444-4444-8444-444444444444";
    const backing = portableFsBacking(fixture.workspace);
    const claimAt = (backingGeneration: number) =>
      store.claimPortableFsWorkspaceForArchive({
        backingGeneration,
        idleBefore,
        workspaceId: fixture.workspace.id,
      });

    // A non-terminal Run: the listing snapshot can predate the turn by minutes,
    // and archiving would detach a filesystem a Run still needs.
    const turn = await enqueueHumanTrigger({
      content: [{ text: "Started after the listing", type: "text" }],
      idempotencyKey: "archive-claim-in-use-turn",
      requestedBy: fixture.userId,
      threadId: fixture.thread.id,
    });
    await expect(claimAt(backing.generation)).rejects.toMatchObject({ code: "conflict" });

    // A live machine mount outlives its Run, and the archive must evict it
    // before a later pass can claim the Workspace.
    await store.claimCommand(turn.command.id, "archive-claim-in-use-dispatcher");
    const mount = await store.recordWorkspaceMount({
      authorizedBy: fixture.userId,
      enrollmentId,
      environmentId: fixture.environmentId,
      membershipGeneration: 1,
      runnerId: fixture.runnerId,
      volumeId: backing.volumeId,
      workspaceId: fixture.workspace.id,
      workspaceBackingGeneration: backing.generation,
    });
    await store.failCommand(turn.command.id, "dispatch failed");
    await expect(claimAt(backing.generation)).rejects.toMatchObject({ code: "conflict" });

    // With the Run terminal and the mount revoked, the same Workspace claims.
    await store.requestWorkspaceMountRevocations({
      reason: "archive-eviction",
      workspaceMountIds: [mount.id],
    });
    await store.completeMountEnrollmentRevocation(enrollmentId, "REVOKED");
    await expect(claimAt(backing.generation)).resolves.toMatchObject({
      id: fixture.workspace.id,
    });

    // Fresh activity alone disqualifies a Workspace that is otherwise idle.
    await store.noteWorkspaceActivity(fixture.workspace.id, new Date(idleBefore.getTime() + 1_000));
    await expect(claimAt(backing.generation + 1)).rejects.toMatchObject({ code: "conflict" });
    expect(portableFsBacking((await store.getWorkspace(fixture.workspace.id))!).generation).toBe(
      backing.generation + 1,
    );
  });

  it("admits exactly one of two concurrent archive claims for the same Workspace", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const ownerId = await store.createUser("Concurrent archive claim owner");
    const idleBefore = new Date(Date.now() + 60_000);
    const workspace = await store.createWorkspace({
      backing: {
        generation: 1,
        kind: "portablefs",
        serviceId: "test-portablefs",
        volumeId: "workspace_archive_claim_race",
      },
      capacityPolicy: {
        blockHardLimitBytes: 512 * 1_024 * 1_024,
        inodeHardLimit: 50_000,
        kind: "hard-quota",
      },
      createdBy: ownerId,
      idempotencyKey: "workspace-archive-claim-race",
      name: "Archive claim race",
      status: "ready",
    });

    const claims = await Promise.allSettled([
      store.claimPortableFsWorkspaceForArchive({
        backingGeneration: 1,
        idleBefore,
        workspaceId: workspace.id,
      }),
      store.claimPortableFsWorkspaceForArchive({
        backingGeneration: 1,
        idleBefore,
        workspaceId: workspace.id,
      }),
    ]);

    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    const rejected = claims.find((claim) => claim.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "conflict" });
    // Exactly one fence advance: the loser never reached the storage authority.
    expect(portableFsBacking((await store.getWorkspace(workspace.id))!).generation).toBe(2);
  });

  it("persists immutable Trigger revisions and executes each durable occurrence once", async ({
    storeFixture,
  }) => {
    const { createRunFixture, triggers, store } = storeFixture;
    const fixture = await createRunFixture("trigger-lifecycle");
    const scheduledAt = new Date(Date.now() - 1_000).toISOString();
    const created = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.thread.id,
      createdBy: fixture.userId,
      idempotencyKey: "trigger-lifecycle-create",
      name: "Daily work",
      program: {
        toolContractVersion: 2,
        language: "typescript",
        source: "export default async function ({ event }) { return event.payload; }",
      },
      source: {
        kind: "schedule",
        schedule: { at: scheduledAt, kind: "at", payload: { n: 1 } },
      },
    });
    const duplicate = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.thread.id,
      createdBy: fixture.userId,
      idempotencyKey: "trigger-lifecycle-create",
      name: "Daily work",
      program: {
        toolContractVersion: 2,
        language: "typescript",
        source: "export default async function ({ event }) { return event.payload; }",
      },
      source: {
        kind: "schedule",
        schedule: { at: scheduledAt, kind: "at", payload: { n: 1 } },
      },
    });
    expect(duplicate.wasDuplicate).toBe(true);
    expect(duplicate.trigger.id).toBe(created.trigger.id);

    const due = (await triggers.claimDueSchedules(new Date())).occurrences;
    expect(due).toHaveLength(1);
    const occurrence = due[0];
    if (!occurrence) throw new Error("Expected scheduled Trigger occurrence");
    expect(occurrence.event).toMatchObject({
      payload: { n: 1 },
      source: { kind: "schedule" },
      trigger: { revisionId: created.revision.id },
    });
    expect((await triggers.claimDueSchedules(new Date())).occurrences).toHaveLength(0);

    const claimed = await store.claimCommand(occurrence.commandId, "test-trigger-dispatcher");
    expect(claimed?.command.type).toBe("trigger.execute");
    const started = await triggers.startExecution({
      commandId: occurrence.commandId,
      runnerBootId: "boot-trigger-lifecycle",
      runnerId: fixture.runnerId,
    });
    expect(started.context.workspace.id).toBe(fixture.workspace.id);
    expect(started.context.revision.id).toBe(created.revision.id);
    await expect(
      triggers.assertActiveExecutionBinding({
        environmentId: fixture.environmentId,
        executionGeneration: started.executionGeneration,
        occurrenceId: occurrence.id,
        requestedBy: fixture.userId,
        runnerBootId: "boot-trigger-lifecycle",
        runnerId: fixture.runnerId,
        threadId: fixture.thread.id,
        workspaceId: fixture.workspace.id,
      }),
    ).resolves.toBeUndefined();
    await expect(
      triggers.failActiveForRunnerDisconnect({
        activeOccurrenceIds: [createId("triggerOccurrence")],
        runnerBootId: "boot-trigger-lifecycle",
        runnerId: fixture.runnerId,
      }),
    ).resolves.toBe(0);
    const completed = await triggers.completeExecution({
      executionGeneration: started.executionGeneration,
      output: {
        completedAt: new Date().toISOString(),
        error: null,
        exitCode: 0,
        occurrenceId: occurrence.id,
        result: { n: 1 },
        status: "succeeded",
        stderr: "",
        stdout: "done\n",
      },
      runnerBootId: "boot-trigger-lifecycle",
      runnerId: fixture.runnerId,
    });
    expect(completed).toMatchObject({ result: { n: 1 }, status: "succeeded", stdout: "done\n" });
    await expect(
      triggers.assertActiveExecutionBinding({
        environmentId: fixture.environmentId,
        executionGeneration: started.executionGeneration,
        occurrenceId: occurrence.id,
        requestedBy: fixture.userId,
        runnerBootId: "boot-trigger-lifecycle",
        runnerId: fixture.runnerId,
        threadId: fixture.thread.id,
        workspaceId: fixture.workspace.id,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("deduplicates webhook deliveries before creating Runner commands", async ({
    storeFixture,
  }) => {
    const { createRunFixture, triggers } = storeFixture;
    const fixture = await createRunFixture("trigger-webhook");
    const created = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.thread.id,
      createdBy: fixture.userId,
      idempotencyKey: "trigger-webhook-create",
      name: "Git provider",
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => null",
      },
      source: { kind: "webhook" },
      webhookRouteKey: "wh_12345678901234567890123456789012",
      webhookSecretHash: "a".repeat(64),
    });
    const first = await triggers.enqueueWebhook({
      deliveryId: "delivery-1",
      headers: { "x-github-event": "push" },
      method: "POST",
      payload: { ref: "main" },
      routeKey: created.trigger.webhookRouteKey ?? "",
    });
    const duplicate = await triggers.enqueueWebhook({
      deliveryId: "delivery-1",
      headers: { "x-github-event": "push" },
      method: "POST",
      payload: { ref: "main" },
      routeKey: created.trigger.webhookRouteKey ?? "",
    });
    expect(first.wasDuplicate).toBe(false);
    expect(duplicate.wasDuplicate).toBe(true);
    expect(duplicate.occurrence.id).toBe(first.occurrence.id);
  });

  it("caps the pending webhook backlog while still answering retries of admitted deliveries", async ({
    storeFixture,
  }) => {
    const { createRunFixture, triggers } = storeFixture;
    const fixture = await createRunFixture("trigger-backlog");
    const created = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.thread.id,
      createdBy: fixture.userId,
      idempotencyKey: "trigger-backlog-create",
      name: "Busy webhook",
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => null",
      },
      source: { kind: "webhook" },
      webhookRouteKey: "wh_backlog0123456789012345678901234",
      webhookSecretHash: "b".repeat(64),
    });
    const routeKey = created.trigger.webhookRouteKey ?? "";
    for (let index = 0; index < MAX_PENDING_TRIGGER_OCCURRENCES; index += 1) {
      const admitted = await triggers.enqueueWebhook({
        deliveryId: `backlog-${index}`,
        headers: {},
        method: "POST",
        payload: { index },
        routeKey,
      });
      expect(admitted.wasDuplicate).toBe(false);
    }
    await expect(
      triggers.enqueueWebhook({
        deliveryId: "backlog-over-cap",
        headers: {},
        method: "POST",
        payload: null,
        routeKey,
      }),
    ).rejects.toMatchObject({
      code: "resource_exhausted",
      details: { pendingLimit: MAX_PENDING_TRIGGER_OCCURRENCES },
    });
    // A sender retrying an already-admitted delivery must still see its answer:
    // the cap gates new work, not the idempotent reply to accepted work.
    await expect(
      triggers.enqueueWebhook({
        deliveryId: "backlog-0",
        headers: {},
        method: "POST",
        payload: { index: 0 },
        routeKey,
      }),
    ).resolves.toMatchObject({ wasDuplicate: true });
    await expect(
      triggers.enqueueManual({
        actorThreadId: null,
        ownerId: fixture.userId,
        triggerId: created.trigger.id,
      }),
    ).rejects.toMatchObject({ code: "resource_exhausted" });
  });

  it("collapses queued schedule ticks while letting a running Occurrence overlap the next one", async ({
    storeFixture,
  }) => {
    const { createRunFixture, triggers, store } = storeFixture;
    const fixture = await createRunFixture("trigger-collapse");
    const created = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.thread.id,
      createdBy: fixture.userId,
      idempotencyKey: "trigger-collapse-create",
      name: "Every minute",
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => null",
      },
      source: {
        kind: "schedule",
        schedule: { expression: "* * * * *", kind: "cron", timezone: "UTC" },
      },
    });
    const firstTick = (await triggers.claimDueSchedules(new Date(Date.now() + 120_000)))
      .occurrences;
    expect(firstTick).toHaveLength(1);
    const queued = firstTick[0];
    if (!queued) throw new Error("Expected a scheduled Trigger occurrence");
    const afterFirst = await triggers.getForOwner(created.trigger.id, fixture.userId, 25, {
      kind: "user",
    });
    const firstNextFireAt = afterFirst?.trigger.nextFireAt ?? null;
    expect(firstNextFireAt).not.toBeNull();

    // The queued tick still says everything a newer tick would, so the clock
    // advances without stacking a second pending Occurrence behind it.
    expect((await triggers.claimDueSchedules(new Date(Date.now() + 240_000))).occurrences).toEqual(
      [],
    );
    const afterCollapse = await triggers.getForOwner(created.trigger.id, fixture.userId, 25, {
      kind: "user",
    });
    expect(Date.parse(afterCollapse?.trigger.nextFireAt ?? "")).toBeGreaterThan(
      Date.parse(firstNextFireAt ?? ""),
    );
    expect(afterCollapse?.occurrences).toHaveLength(1);

    await store.claimCommand(queued.commandId, "trigger-collapse-dispatcher");
    await triggers.startExecution({
      commandId: queued.commandId,
      runnerBootId: "boot-trigger-collapse",
      runnerId: fixture.runnerId,
    });
    const overlapping = (await triggers.claimDueSchedules(new Date(Date.now() + 360_000)))
      .occurrences;
    expect(overlapping).toHaveLength(1);
    expect(overlapping[0]?.id).not.toBe(queued.id);
  });

  it("cancels pending Occurrences without disturbing work a Runner already claimed", async ({
    storeFixture,
  }) => {
    const { createRunFixture, triggers, database, store } = storeFixture;
    const fixture = await createRunFixture("trigger-cancel");
    const created = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.thread.id,
      createdBy: fixture.userId,
      idempotencyKey: "trigger-cancel-create",
      name: "Cancelable webhook",
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => null",
      },
      source: { kind: "webhook" },
      webhookRouteKey: "wh_cancel01234567890123456789012345",
      webhookSecretHash: "c".repeat(64),
    });
    const routeKey = created.trigger.webhookRouteKey ?? "";
    const delivered = [];
    for (const deliveryId of ["cancel-1", "cancel-2", "cancel-3"]) {
      delivered.push(
        (
          await triggers.enqueueWebhook({
            deliveryId,
            headers: {},
            method: "POST",
            payload: { deliveryId },
            routeKey,
          })
        ).occurrence,
      );
    }
    const [single, claimedByRunner, remaining] = delivered;
    if (!single || !claimedByRunner || !remaining) throw new Error("Expected three Occurrences");

    await expect(
      triggers.cancelPendingOccurrences(fixture.userId, {
        actorThreadId: null,
        occurrenceId: single.id,
        triggerId: created.trigger.id,
      }),
    ).resolves.toEqual({ canceledOccurrenceIds: [single.id] });
    await expect(
      database
        .selectFrom("triggerOccurrences")
        .select(["completedAt", "status"])
        .where("id", "=", single.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ status: "canceled" });
    await expect(
      database
        .selectFrom("commands")
        .select("status")
        .where("id", "=", single.commandId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "failed" });
    await expect(
      store.claimCommand(single.commandId, "trigger-cancel-dispatcher"),
    ).resolves.toBeNull();

    // A Command already claimed belongs to the Runner: cancelling must leave it
    // alone and report only the Occurrences it actually took.
    expect(
      await store.claimCommand(claimedByRunner.commandId, "trigger-cancel-dispatcher"),
    ).not.toBeNull();
    await triggers.startExecution({
      commandId: claimedByRunner.commandId,
      runnerBootId: "boot-trigger-cancel",
      runnerId: fixture.runnerId,
    });
    await expect(
      triggers.cancelPendingOccurrences(fixture.userId, {
        actorThreadId: null,
        triggerId: created.trigger.id,
      }),
    ).resolves.toEqual({ canceledOccurrenceIds: [remaining.id] });
    await expect(
      database
        .selectFrom("triggerOccurrences")
        .select("status")
        .where("id", "=", claimedByRunner.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "running" });
    await expect(
      triggers.cancelPendingOccurrences(fixture.userId, {
        actorThreadId: null,
        triggerId: created.trigger.id,
      }),
    ).resolves.toEqual({ canceledOccurrenceIds: [] });
    await expect(
      triggers.cancelPendingOccurrences(await store.createUser("Cancel stranger"), {
        actorThreadId: null,
        triggerId: created.trigger.id,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("re-arms a Trigger only when its source changes", async ({ storeFixture }) => {
    const { createRunFixture, triggers } = storeFixture;
    const fixture = await createRunFixture("trigger-rearm");
    const firesAt = new Date(Date.now() + 3_600_000).toISOString();
    const created = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.thread.id,
      createdBy: fixture.userId,
      idempotencyKey: "trigger-rearm-create",
      name: "One shot",
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => null",
      },
      source: { kind: "schedule", schedule: { at: firesAt, kind: "at" } },
    });
    expect(created.trigger.nextFireAt).toBe(new Date(firesAt).toISOString());

    const renamed = await triggers.update({
      actorThreadId: null,
      expectedRevisionId: created.revision.id,
      name: "One shot, renamed",
      ownerId: fixture.userId,
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => 1",
      },
      triggerId: created.trigger.id,
    });
    expect(renamed.trigger.nextFireAt).toBe(created.trigger.nextFireAt);

    // A source that names an instant already past stays past. Re-arming it here
    // is what used to make one-shot Triggers fire again on every edit.
    const elapsed = await triggers.update({
      actorThreadId: null,
      expectedRevisionId: renamed.revision.id,
      ownerId: fixture.userId,
      source: {
        kind: "schedule",
        schedule: { at: new Date(Date.now() - 1_000).toISOString(), kind: "at" },
      },
      triggerId: created.trigger.id,
    });
    expect(elapsed.trigger.nextFireAt).toBeNull();
    expect((await triggers.claimDueSchedules(new Date())).occurrences).toEqual([]);

    const rescheduled = await triggers.update({
      actorThreadId: null,
      expectedRevisionId: elapsed.revision.id,
      ownerId: fixture.userId,
      source: {
        kind: "schedule",
        schedule: { expression: "0 * * * *", kind: "cron", timezone: "UTC" },
      },
      triggerId: created.trigger.id,
    });
    expect(Date.parse(rescheduled.trigger.nextFireAt ?? "")).toBeGreaterThan(Date.now());
  });

  it("pauses a due Trigger whose execution authority is momentarily unavailable", async ({
    storeFixture,
  }) => {
    const { createRunFixture, triggers, database } = storeFixture;
    const fixture = await createRunFixture("trigger-authority-pause");
    const created = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.thread.id,
      createdBy: fixture.userId,
      idempotencyKey: "trigger-authority-pause-create",
      name: "Hourly report",
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => null",
      },
      source: {
        kind: "schedule",
        schedule: { expression: "* * * * *", kind: "cron", timezone: "UTC" },
      },
    });
    await database
      .updateTable("runners")
      .set({ revokedAt: new Date() })
      .where("id", "=", fixture.runnerId)
      .execute();
    expect((await triggers.claimDueSchedules(new Date(Date.now() + 120_000))).occurrences).toEqual(
      [],
    );
    const paused = await triggers.getForOwner(created.trigger.id, fixture.userId, 25, {
      kind: "user",
    });
    expect(paused?.trigger).toMatchObject({ nextFireAt: null, status: "paused" });
    expect(paused?.occurrences).toEqual([]);

    await database
      .updateTable("runners")
      .set({ revokedAt: null })
      .where("id", "=", fixture.runnerId)
      .execute();
    const resumed = await triggers.setStatus({
      actorThreadId: null,
      ownerId: fixture.userId,
      status: "active",
      triggerId: created.trigger.id,
    });
    expect(Date.parse(resumed.nextFireAt ?? "")).toBeGreaterThan(Date.now());
    expect(
      (await triggers.claimDueSchedules(new Date(Date.now() + 120_000))).occurrences,
    ).toHaveLength(1);
  });

  it("bounds the Trigger control path per Occurrence and charges an exact retry once", async ({
    storeFixture,
  }) => {
    const { createRunFixture, triggers, store, database } = storeFixture;
    const fixture = await createRunFixture("trigger-admission");
    const created = await triggers.create({
      actorThreadId: null,
      anchorThreadId: fixture.thread.id,
      createdBy: fixture.userId,
      idempotencyKey: "trigger-admission-create",
      name: "Control caller",
      program: {
        toolContractVersion: 2,
        language: "javascript",
        source: "export default async () => null",
      },
      source: { kind: "webhook" },
      webhookRouteKey: "wh_admission012345678901234567890123",
      webhookSecretHash: "d".repeat(64),
    });
    const { occurrence } = await triggers.enqueueWebhook({
      deliveryId: "admission-1",
      headers: {},
      method: "POST",
      payload: null,
      routeKey: created.trigger.webhookRouteKey ?? "",
    });
    await store.claimCommand(occurrence.commandId, "trigger-admission-dispatcher");
    const execution = await triggers.startExecution({
      commandId: occurrence.commandId,
      runnerBootId: "boot-trigger-admission",
      runnerId: fixture.runnerId,
    });
    const triggerBinding = {
      environmentId: fixture.environmentId,
      executionGeneration: execution.executionGeneration,
      requestedBy: fixture.userId,
      runnerBootId: "boot-trigger-admission",
      runnerId: fixture.runnerId,
      threadId: fixture.thread.id,
      workspaceId: fixture.workspace.id,
    };
    const exactInput = {
      ...triggerBinding,
      action: "trigger.write" as const,
      occurrenceId: occurrence.id,
      requestFingerprint: createHash("sha256").update("exact-trigger-write").digest("hex"),
      requestId: randomUUID(),
    };
    const retries = await Promise.all(
      Array.from({ length: 4 }, async () => admitTriggerControlRequest(database, exactInput)),
    );
    expect(retries.filter(({ wasDuplicate }) => !wasDuplicate)).toHaveLength(1);
    expect(retries.filter(({ wasDuplicate }) => wasDuplicate)).toHaveLength(3);
    await expect(
      admitTriggerControlRequest(database, {
        ...exactInput,
        requestFingerprint: createHash("sha256").update("changed-trigger-write").digest("hex"),
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    const remaining = agentControlActionLimits["trigger.write"] - 1;
    await Promise.all(
      Array.from({ length: remaining }, async (_, index) =>
        admitTriggerControlRequest(database, {
          ...triggerBinding,
          action: "trigger.write",
          occurrenceId: occurrence.id,
          requestFingerprint: createHash("sha256").update(`write-${index}`).digest("hex"),
          requestId: randomUUID(),
        }),
      ),
    );
    await expect(
      admitTriggerControlRequest(database, {
        ...triggerBinding,
        action: "trigger.write",
        occurrenceId: occurrence.id,
        requestFingerprint: createHash("sha256").update("write-over-limit").digest("hex"),
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "resource_exhausted",
      details: {
        actionClass: "trigger.write",
        limit: agentControlActionLimits["trigger.write"],
      },
    });
    // Reads are a separate class and a separate Occurrence is a separate ledger.
    await expect(
      admitTriggerControlRequest(database, {
        ...triggerBinding,
        action: "trigger.read",
        occurrenceId: occurrence.id,
        requestFingerprint: createHash("sha256").update("read-after-write").digest("hex"),
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({ actionClass: "trigger.read", wasDuplicate: false });
    // A Trigger program reaches Thread operations too: without a class of their
    // own a program could delegate in an unbounded loop.
    await Promise.all(
      Array.from({ length: agentControlActionLimits["thread.delegate"] }, async (_, index) =>
        admitTriggerControlRequest(database, {
          ...triggerBinding,
          action: "thread.delegate",
          occurrenceId: occurrence.id,
          requestFingerprint: createHash("sha256").update(`delegate-${index}`).digest("hex"),
          requestId: randomUUID(),
        }),
      ),
    );
    await expect(
      admitTriggerControlRequest(database, {
        ...triggerBinding,
        action: "thread.delegate",
        occurrenceId: occurrence.id,
        requestFingerprint: createHash("sha256").update("delegate-over-limit").digest("hex"),
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "resource_exhausted",
      details: {
        actionClass: "thread.delegate",
        limit: agentControlActionLimits["thread.delegate"],
      },
    });
    await expect(
      admitTriggerControlRequest(database, {
        ...triggerBinding,
        action: "thread.message",
        occurrenceId: occurrence.id,
        requestFingerprint: createHash("sha256").update("message-after-delegate").digest("hex"),
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({ actionClass: "thread.message", wasDuplicate: false });
    await expect(
      admitTriggerControlRequest(database, {
        ...triggerBinding,
        action: "trigger.write",
        occurrenceId: createId("triggerOccurrence"),
        requestFingerprint: createHash("sha256").update("unknown-occurrence").digest("hex"),
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
