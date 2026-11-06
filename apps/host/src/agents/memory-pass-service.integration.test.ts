import { sql } from "kysely";
import {
  createId,
  TimeZoneSchema,
  ThreadAccessModeSchema,
  type HarnessInstanceId,
  type MessageId,
  type RunId,
  type Thread,
} from "@opensteer/core";
import { createMemoryPass, type MemoryPassExecution } from "@opensteer/database";
import { createTestWorkspace } from "@opensteer/database/test-support/workspace";
import { HarnessIdSchema, ModelSelectionSchema } from "@opensteer/core";
import {
  describeStore,
  enrollTestRunner,
  testContinuationIdentity,
  testReadyHarnessCatalog,
  type StoreFixture,
} from "@opensteer/database/test-support/store";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import {
  MANAGED_MEMORY_REFUSAL,
  MANAGED_MEMORY_WAKE_SKIPPED,
  type Trigger,
  type TriggerSystemRole,
} from "@opensteer/triggers";
import { expect, vi } from "vitest";
import { MemoryPassService, memoryPassWaitingReason } from "./memory-pass-service.js";
import { memoryPassProgram } from "./memory-pass-program.js";

async function fixture(
  f: StoreFixture,
  suffix: string,
  options: {
    home?: boolean;
    light?: boolean;
    zone?: boolean;
    accessMode?: Thread["accessMode"];
  } = {},
) {
  const base = await (async () => {
    if (!(await f.database.selectFrom("runners").select("id").executeTakeFirst()))
      return f.createRunFixture(suffix);
    const userId = await f.store.createUser("Another person");
    const environmentId = createId("environment");
    const runnerId = createId("runner");
    await enrollTestRunner(f.store, {
      createdBy: userId,
      ownerUserId: userId,
      environmentId,
      runnerId,
      runnerKind: "managed",
      name: suffix,
      tokenSuffix: suffix,
    });
    const workspace = await createTestWorkspace(f.store, {
      createdBy: userId,
      kind: "main",
      name: "Main",
      status: "ready",
      idempotencyKey: `main-${suffix}`,
      backing: {
        kind: "local-directory",
        generation: 1,
        bindingId: createId("workspaceBinding"),
        ownerEnvironmentId: environmentId,
        storageAuthorityId: createId("storageAuthority"),
      },
    });
    const harnessInstance = await f.store.createHarnessInstance({
      config: {},
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Native",
      stateKind: "isolated",
    });
    const thread = (
      await f.store.createThread({
        createdBy: userId,
        environmentId,
        harnessInstanceId: harnessInstance.id,
        idempotencyKey: `thread-${suffix}`,
        modelSelection: ModelSelectionSchema.parse({
          providerId: "openai",
          modelId: "gpt-5.6-sol",
          options: {},
        }),
        title: suffix,
        workspaceId: workspace.id,
      })
    ).thread;
    return { userId, environmentId, runnerId, workspace, harnessInstance, thread };
  })();
  const chat =
    options.home === false
      ? null
      : (
          await f.store.createThread({
            createdBy: base.userId,
            environmentId: base.environmentId,
            harnessInstanceId: base.harnessInstance.id,
            home: true,
            idempotencyKey: `chat-${suffix}`,
            modelSelection: base.thread.modelSelection,
            accessMode: options.accessMode ?? "full-access",
            title: "Chat",
            workspaceId: base.workspace.id,
          })
        ).thread;
  if (options.zone !== false)
    await f.store.notificationState.setTimeZone({
      userId: base.userId,
      timeZone: TimeZoneSchema.parse("America/New_York"),
    });
  await f.database
    .updateTable("runners")
    .set({ capabilities: sql`'["trigger-program-v3"]'::jsonb` })
    .where("id", "=", base.runnerId)
    .execute();
  const catalog = HarnessInstanceCatalogSchema.parse({
    ...testReadyHarnessCatalog(base.harnessInstance.id),
    ...(options.light === false
      ? {}
      : {
          lightModel: { providerId: "openai", modelId: "light", options: {} },
          models: [
            ...testReadyHarnessCatalog(base.harnessInstance.id).models,
            {
              displayName: "Light",
              isDefault: false,
              providerId: "openai",
              modelId: "light",
              nativeModelId: "native-light",
              options: [],
            },
          ],
        }),
  });
  await f.store.recordHarnessCatalogs({
    environmentId: base.environmentId,
    catalogs: [catalog],
    expectedRevisions: new Map([[base.harnessInstance.id, base.harnessInstance.runtimeRevision]]),
  });
  return { ...base, chat, catalog };
}
function service(f: StoreFixture, options: { off?: boolean; batchSize?: number } = {}) {
  const preview = vi.fn(async () => ({
    bytes: Buffer.from(options.off ? "## Memory\nMemory: off at the person's request\n" : ""),
    metadata: {
      contentType: "text/markdown",
      etag: '"1"',
      modifiedAt: null,
      sizeBytes: 0,
      truncated: false,
    },
  }));
  const onError = vi.fn();
  const runners = {
    isAvailable: vi.fn(() => true),
    canRunHarness: vi.fn(() => true),
    harnessAccessModes: vi.fn(() => ThreadAccessModeSchema.options),
  };
  const instance = new MemoryPassService({
    store: f.store,
    runners,
    files: { preview },
    onEvent: vi.fn(),
    onChanged: vi.fn(),
    onError,
    ...(options.batchSize ? { batchSize: options.batchSize } : {}),
  });
  return { instance, preview, onError, runners };
}
async function detail(f: StoreFixture, ownerId: Trigger["createdBy"], id: Trigger["id"]) {
  const result = await f.triggers.getForOwner(id, ownerId, 25, { kind: "user" });
  if (!result) throw new Error("Managed Trigger detail missing");
  return result;
}
async function role(
  f: StoreFixture,
  ownerId: Trigger["createdBy"],
  systemRole: TriggerSystemRole = "memory-light",
) {
  const found = await f.triggers.listForOwner({ ownerId, systemRole, scope: { kind: "user" } });
  if (!found[0]) throw new Error("Managed role missing");
  return detail(f, ownerId, found[0].id);
}
async function tick(f: StoreFixture, base: Awaited<ReturnType<typeof fixture>>, trigger: Trigger) {
  await f.database
    .updateTable("triggers")
    .set({ nextFireAt: new Date(Date.now() - 1_000) })
    .where("id", "=", trigger.id)
    .execute();
  const occurrence = (await f.triggers.claimDueSchedules()).occurrences.find(
    ({ triggerId }) => triggerId === trigger.id,
  );
  if (!occurrence) throw new Error("Due managed tick missing");
  await f.store.claimCommand(occurrence.commandId, `claim-${occurrence.id}`);
  const runnerBootId = `boot-${occurrence.id}`;
  const started = await f.triggers.startExecution({
    commandId: occurrence.commandId,
    runnerBootId,
    runnerId: base.runnerId,
  });
  return { occurrence, runnerBootId, ...started };
}
/** A real engine's account: the maintained light ranking reaches its small model. */
async function claudeAccount(f: StoreFixture, base: Awaited<ReturnType<typeof fixture>>) {
  const account = await f.store.createHarnessInstance({
    config: {},
    driverKind: HarnessIdSchema.parse("claude"),
    environmentId: base.environmentId,
    name: "Claude",
    stateKind: "isolated",
  });
  const catalog = HarnessInstanceCatalogSchema.parse({
    driverKind: "claude",
    harnessInstanceId: account.id,
    status: "ready",
    continuationIdentity: {
      driverKind: "claude",
      continuationKey: "runner:v1:" + "a".repeat(43),
    },
    models: [
      {
        displayName: "Claude Haiku 5.5",
        isDefault: true,
        providerId: "anthropic",
        modelId: "claude-haiku-5-5",
        nativeModelId: "claude-haiku-5-5",
        options: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            values: [{ value: "low", label: "Low" }],
          },
        ],
      },
    ],
  });
  await f.store.recordHarnessCatalogs({
    environmentId: base.environmentId,
    expectedRevisions: new Map([[account.id, account.runtimeRevision]]),
    catalogs: [catalog],
  });
  return { account, catalog };
}
/** Holds a row so `work` can stop an admission at a known lock, then releases it. */
async function holdingRow(
  f: StoreFixture,
  table: "threads" | "workspaces",
  id: string,
  work: (release: () => void) => Promise<void>,
) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  const blocker = f.database.transaction().execute(async (transaction) => {
    await sql`select id from ${sql.table(table)} where id = ${id} for no key update`.execute(
      transaction,
    );
    held();
    await released;
  });
  try {
    await holding;
    await work(release);
  } finally {
    release();
    await blocker;
  }
}
function lockWaiters(f: StoreFixture, count: number) {
  return vi.waitFor(
    async () => {
      const { rows } = await sql<{ count: string }>`select count(*) from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`.execute(f.database);
      expect(Number(rows[0]!.count)).toBe(count);
    },
    { timeout: 5_000 },
  );
}
/** The Host resolves each pass's model; by default this one keeps the worker's. */
async function wake(
  f: StoreFixture,
  trigger: Trigger,
  occurrenceId: ReturnType<typeof createId<"triggerOccurrence">>,
  key: string,
  memoryPass?: MemoryPassExecution | null,
) {
  const worker = await f.database
    .selectFrom("threads")
    .innerJoin("harnessInstances", "harnessInstances.id", "threads.harnessInstanceId")
    .select([
      "threads.harnessInstanceId",
      "threads.modelSelection",
      "harnessInstances.runtimeRevision as harnessRevision",
    ])
    .where("threads.id", "=", trigger.anchorThreadId)
    .executeTakeFirstOrThrow();
  return f.store.enqueueThreadInput({
    content: [{ type: "text", text: "Memory pass due" }],
    idempotencyKey: key,
    policy: "queue",
    requestedBy: trigger.createdBy,
    source: { kind: "trigger", occurrenceId },
    threadId: trigger.anchorThreadId,
    ...(memoryPass === null ? {} : { memoryPass: memoryPass ?? worker }),
  });
}

async function delivered(
  f: StoreFixture,
  base: Awaited<ReturnType<typeof fixture>>,
  threadId: Thread["id"],
  key: string,
) {
  const { run } = await f.enqueueHumanTrigger({
    content: [{ type: "text", text: "Dinner at eight" }],
    idempotencyKey: key,
    requestedBy: base.userId,
    threadId,
  });
  await finish(f, run, "completed");
}
async function finish(
  f: StoreFixture,
  run: { readonly id: RunId; readonly seedInputId: MessageId },
  status: "completed" | "failed",
) {
  await f.database
    .updateTable("runs")
    .set({ status, completedAt: new Date() })
    .where("id", "=", run.id)
    .execute();
  await f.database
    .updateTable("threadInputs")
    .set({ state: "delivered", deliveredAt: new Date(), runId: run.id, updatedAt: new Date() })
    .where("messageId", "=", run.seedInputId)
    .execute();
}
function wakeText(admitted: Awaited<ReturnType<typeof wake>>) {
  return admitted.message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
}

describeStore("managed memory passes", (it) => {
  it("creates exactly one atomic pair under concurrent provisioning on Chat's placement, and never recreates paused/Done identities", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "concurrent", { accessMode: "approval-required" });
    const s = service(f);
    await Promise.all([
      s.instance.ensureForMain(base.workspace.id),
      s.instance.ensureForMain(base.workspace.id),
    ]);
    const rows = await f.triggers.listForOwner({ ownerId: base.userId, scope: { kind: "user" } });
    expect(rows).toHaveLength(2);
    const light = await role(f, base.userId);
    const nightly = await role(f, base.userId, "memory-nightly");
    expect(light.anchorThread).toMatchObject({
      accessMode: "approval-required",
      inheritsMain: true,
      createdBy: base.userId,
      environmentId: base.environmentId,
      harnessInstanceId: base.harnessInstance.id,
      parentThreadId: base.chat!.id,
      lineageRootThreadId: base.chat!.lineageRootThreadId,
      role: "work",
      listed: false,
      modelSelection: base.chat!.modelSelection,
    });
    expect(nightly.anchorThread?.modelSelection).toEqual(base.chat?.modelSelection);
    expect(light.revision.source).toEqual({
      kind: "schedule",
      schedule: { kind: "cron", expression: "*/30 8-22 * * *", timezone: "America/New_York" },
    });
    expect(nightly.revision.source).toEqual({
      kind: "schedule",
      schedule: { kind: "cron", expression: "0 3 * * *", timezone: "America/New_York" },
    });
    expect(await f.database.selectFrom("runs").selectAll().execute()).toHaveLength(0);
    expect(await f.database.selectFrom("delegations").selectAll().execute()).toHaveLength(0);
    await f.triggers.setStatus({
      actorThreadId: null,
      ownerId: base.userId,
      triggerId: light.trigger.id,
      status: "paused",
    });
    await f.store.setThreadDone({
      done: true,
      idempotencyKey: "nightly-done",
      requestedBy: base.userId,
      threadId: nightly.trigger.anchorThreadId,
    });
    s.preview.mockClear();
    await s.instance.ensureForMain(base.workspace.id);
    expect(s.preview).not.toHaveBeenCalled();
    expect((await role(f, base.userId)).trigger).toMatchObject({
      id: light.trigger.id,
      status: "paused",
    });
    expect((await role(f, base.userId, "memory-nightly")).anchorThread?.doneAt).not.toBeNull();
  });

  it("rolls back Thread, session, command and events when Trigger creation fails", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "rollback");
    const tables = ["threads", "providerSessions", "commands", "workspaceEvents"] as const;
    const counts = () =>
      Promise.all(
        tables.map((table) =>
          f.database
            .selectFrom(table)
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .executeTakeFirstOrThrow(),
        ),
      );
    const input = {
      workspaceId: base.workspace.id,
      ownerId: base.userId,
      chat: base.chat!,
      systemRole: "memory-light" as const,
      program: memoryPassProgram("memory-light"),
      source: {
        kind: "schedule",
        schedule: { kind: "cron", expression: "0 3 * * *", timezone: "UTC" },
      } as const,
      pauseReason: null,
    };
    const before = await counts();
    await expect(
      createMemoryPass(f.database, { ...input, program: { ...input.program, source: "" } }),
    ).rejects.toThrow();
    expect(await counts()).toEqual(before);
    const light = await createMemoryPass(f.database, {
      ...input,
      pauseReason: "Paused deliberately",
    });
    if (!light) throw new Error("Partial pair creation missing");
    await expect(
      createMemoryPass(f.database, {
        ...input,
        systemRole: "memory-nightly",
        program: { ...input.program, source: "" },
      }),
    ).rejects.toThrow();
    await service(f).instance.ensureForMain(base.workspace.id);
    expect((await role(f, base.userId)).trigger).toMatchObject({
      id: light.trigger.id,
      status: "paused",
      pauseReason: "Paused deliberately",
    });
    expect((await role(f, base.userId, "memory-nightly")).trigger.status).toBe("active");
  });

  it("defers no Chat, no zone and unreadable files, but never waits on a model", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "prerequisites", { home: false, zone: false, light: false });
    const s = service(f);
    await s.instance.ensureForMain(base.workspace.id);
    const created = await f.store.createThread({
      createdBy: base.userId,
      environmentId: base.environmentId,
      harnessInstanceId: base.harnessInstance.id,
      home: true,
      idempotencyKey: "chat-later",
      modelSelection: base.thread.modelSelection,
      title: "Chat",
      workspaceId: base.workspace.id,
    });
    await s.instance.ensureForMain(base.workspace.id);
    expect(s.preview).not.toHaveBeenCalled();
    await f.store.notificationState.setTimeZone({
      userId: base.userId,
      timeZone: TimeZoneSchema.parse("UTC"),
    });
    s.preview.mockRejectedValueOnce(new Error("Storage unreadable"));
    await s.instance.ensureForMain(base.workspace.id);
    expect(
      await f.triggers.listForOwner({ ownerId: base.userId, scope: { kind: "user" } }),
    ).toEqual([]);
    expect(created.thread.role).toBe("conversation");
    // An offline computer or an account without a light model does not
    // defer creation: each pass chooses its model when it is admitted.
    s.runners.isAvailable.mockReturnValue(false);
    await s.instance.ensureForMain(base.workspace.id);
    expect((await role(f, base.userId)).trigger).toMatchObject({
      status: "active",
      pauseReason: null,
    });
    expect((await role(f, base.userId, "memory-nightly")).trigger.status).toBe("active");
  });

  it("creates both identities paused, with one reason, when memory is off", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "off", { light: false });
    await service(f, { off: true }).instance.ensureForMain(base.workspace.id);
    const rows = await f.triggers.listForOwner({ ownerId: base.userId, scope: { kind: "user" } });
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(row).toMatchObject({
        status: "paused",
        nextFireAt: null,
        pauseReason: "Memory is off at your request.",
      });
  });

  it("makes fair keyset progress past ineligible people and isolates a failed person's provisioning", async ({
    storeFixture: f,
  }) => {
    const people = [
      await fixture(f, "fair-a"),
      await fixture(f, "fair-b"),
      await fixture(f, "fair-c"),
    ];
    people.sort((a, b) => a.workspace.id.localeCompare(b.workspace.id));
    const s = service(f, { batchSize: 1 });
    const original = f.store.admitWorkspaceFiles.bind(f.store);
    vi.spyOn(f.store, "admitWorkspaceFiles").mockImplementation(async (workspaceId, userId) => {
      if (workspaceId === people[0]!.workspace.id) throw new Error("One person's broken storage");
      if (workspaceId === people[1]!.workspace.id) return null;
      return original(workspaceId, userId);
    });
    await s.instance.reconcileMissing();
    await s.instance.reconcileMissing();
    await s.instance.reconcileMissing();
    expect(s.onError).toHaveBeenCalledTimes(1);
    expect((await role(f, people[2]!.userId)).trigger.status).toBe("active");
  });

  it("skips a pending offline tick after Pause on reconnect without recording a failure", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "late-pause");
    await service(f).instance.ensureForMain(base.workspace.id);
    const light = (await role(f, base.userId)).trigger;
    await f.database
      .updateTable("triggers")
      .set({ nextFireAt: new Date(Date.now() - 1_000) })
      .where("id", "=", light.id)
      .execute();
    const occurrence = (await f.triggers.claimDueSchedules()).occurrences[0]!;
    await f.triggers.setStatus({
      actorThreadId: null,
      ownerId: base.userId,
      triggerId: light.id,
      status: "paused",
    });
    await f.store.claimCommand(occurrence.commandId, "reconnect");
    const started = await f.triggers.startExecution({
      commandId: occurrence.commandId,
      runnerBootId: "reconnected",
      runnerId: base.runnerId,
    });
    await expect(wake(f, light, occurrence.id, "late-wake")).rejects.toThrow(
      MANAGED_MEMORY_WAKE_SKIPPED,
    );
    await f.triggers.completeExecution({
      executionGeneration: started.executionGeneration,
      runnerBootId: "reconnected",
      runnerId: base.runnerId,
      output: {
        occurrenceId: occurrence.id,
        completedAt: new Date().toISOString(),
        error: null,
        exitCode: 0,
        result: null,
        status: "succeeded",
        stderr: "",
        stdout: "",
      },
    });
    expect((await detail(f, base.userId, light.id)).trigger).toMatchObject({
      consecutiveFailures: 0,
      status: "paused",
    });
  });

  it("admits only one competing wake and replays its accepted receipt after pause", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "wake-race");
    await service(f).instance.ensureForMain(base.workspace.id);
    const light = (await role(f, base.userId)).trigger;
    const first = await tick(f, base, light);
    const second = await tick(f, base, light);
    const results = await Promise.allSettled([
      wake(f, light, first.occurrence.id, "wake-one"),
      wake(f, light, second.occurrence.id, "wake-two"),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { message: MANAGED_MEMORY_WAKE_SKIPPED } });
    const accepted =
      results[0]!.status === "fulfilled"
        ? { key: "wake-one", tick: first }
        : { key: "wake-two", tick: second };
    await f.triggers.setStatus({
      actorThreadId: null,
      ownerId: base.userId,
      triggerId: light.id,
      status: "paused",
    });
    const replay = await wake(f, light, accepted.tick.occurrence.id, accepted.key);
    expect(replay.wasDuplicate).toBe(true);
    expect(
      await f.database
        .selectFrom("runs")
        .selectAll()
        .where("threadId", "=", light.anchorThreadId)
        .execute(),
    ).toHaveLength(1);
    expect(
      (
        await f.database
          .selectFrom("runs")
          .select("personWaited")
          .where("id", "=", replay.run!.id)
          .executeTakeFirstOrThrow()
      ).personWaited,
    ).toBe(false);
  });

  it("skips stopped, Done, archived and pending-input anchors after source authorization", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "unusable");
    await service(f).instance.ensureForMain(base.workspace.id);
    const light = (await role(f, base.userId)).trigger;
    const started = await tick(f, base, light);
    for (const patch of [
      { inputQueuePaused: true, inputQueuePausedBy: base.userId },
      { doneAt: new Date() },
      { status: "archived" as const },
    ]) {
      await f.database
        .updateTable("threads")
        .set(patch)
        .where("id", "=", light.anchorThreadId)
        .execute();
      await expect(
        wake(f, light, started.occurrence.id, `skip-${Object.keys(patch)[0]}`),
      ).rejects.toThrow(MANAGED_MEMORY_WAKE_SKIPPED);
      await f.database
        .updateTable("threads")
        .set({ doneAt: null, inputQueuePaused: false, inputQueuePausedBy: null, status: "idle" })
        .where("id", "=", light.anchorThreadId)
        .execute();
    }
    await f.store.enqueueThreadInput({
      content: [{ type: "text", text: "A later human input" }],
      idempotencyKey: "human-pending",
      policy: "queue",
      requestedBy: base.userId,
      source: { kind: "human" },
      threadId: light.anchorThreadId,
    });
    await f.database
      .updateTable("runs")
      .set({ status: "completed" })
      .where("threadId", "=", light.anchorThreadId)
      .execute();
    await f.database
      .updateTable("threadInputs")
      .set({ state: "pending", runId: null })
      .where("threadId", "=", light.anchorThreadId)
      .execute();
    await expect(wake(f, light, started.occurrence.id, "pending-input-wake")).rejects.toThrow(
      MANAGED_MEMORY_WAKE_SKIPPED,
    );
  });

  it("enforces managed lifetime, allows cron CAS while paused and preserves revocation cancellation", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "guards");
    await service(f).instance.ensureForMain(base.workspace.id);
    const light = await role(f, base.userId);
    const common = { actorThreadId: null, ownerId: base.userId, triggerId: light.trigger.id };
    await expect(f.triggers.setStatus({ ...common, status: "archived" })).rejects.toThrow(
      MANAGED_MEMORY_REFUSAL,
    );
    await expect(f.triggers.enqueueManual(common)).rejects.toThrow(MANAGED_MEMORY_REFUSAL);
    for (const changed of [
      { name: "Other" },
      { program: memoryPassProgram("memory-nightly") },
      { source: { kind: "webhook" as const } },
      { source: { kind: "watch" as const } },
      {
        source: {
          kind: "schedule" as const,
          schedule: { kind: "at" as const, at: new Date(Date.now() + 60_000).toISOString() },
        },
      },
    ]) {
      await expect(
        f.triggers.update({ ...common, expectedRevisionId: light.revision.id, ...changed }),
      ).rejects.toThrow(MANAGED_MEMORY_REFUSAL);
    }
    const nextFireAt = new Date(Date.now() + 60_000).toISOString();
    expect(await f.triggers.setNextFire({ ...common, nextFireAt })).toMatchObject({
      nextFireAt,
      status: "active",
    });
    const started = await tick(f, base, light.trigger);
    expect(
      await f.triggers.cancelPendingOccurrences(base.userId, {
        actorThreadId: null,
        triggerId: light.trigger.id,
      }),
    ).toEqual({ canceledOccurrenceIds: [] });
    await f.triggers.setStatus({ ...common, status: "paused" });
    const updated = await f.triggers.update({
      ...common,
      expectedRevisionId: light.revision.id,
      source: {
        kind: "schedule",
        schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
      },
    });
    expect(updated.trigger).toMatchObject({ status: "paused", nextFireAt: null });
    await expect(
      f.triggers.update({
        ...common,
        expectedRevisionId: light.revision.id,
        source: updated.revision.source,
      }),
    ).rejects.toThrow("revision changed");
    const remainingOwner = await f.store.createUser("Remaining owner");
    const membership = await f.database
      .selectFrom("workspaceMemberships")
      .selectAll()
      .where("workspaceId", "=", base.workspace.id)
      .where("userId", "=", base.userId)
      .executeTakeFirstOrThrow();
    await f.database
      .insertInto("workspaceMemberships")
      .values({ ...membership, id: createId("workspaceMembership"), userId: remainingOwner })
      .execute();
    await f.database
      .updateTable("workspaceMemberships")
      .set({ state: "revoked", generation: 2, revokedAt: new Date(), revokedBy: remainingOwner })
      .where("workspaceId", "=", base.workspace.id)
      .where("userId", "=", base.userId)
      .execute();
    await f.triggers.revokeForMembershipRevocation({
      membershipGeneration: 2,
      userId: base.userId,
      workspaceId: base.workspace.id,
    });
    expect(
      await f.database
        .selectFrom("triggers")
        .select(["status", "nextFireAt"])
        .where("id", "=", light.trigger.id)
        .executeTakeFirst(),
    ).toEqual({ status: "paused", nextFireAt: null });
    expect(
      await f.database
        .selectFrom("triggerOccurrences")
        .select("status")
        .where("id", "=", started.occurrence.id)
        .executeTakeFirst(),
    ).toEqual({ status: "failed" });
    expect(
      await f.triggers.getForOwner(light.trigger.id, base.userId, 1, { kind: "user" }),
    ).toBeNull();
  });

  it("discovers roles before LIMIT beyond 100 ordinary Triggers and authorizes hidden anchor detail", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "discovery");
    await service(f).instance.ensureForMain(base.workspace.id);
    const light = await role(f, base.userId);
    for (let index = 0; index < 101; index++)
      await f.triggers.create({
        actorThreadId: null,
        anchorThreadId: base.chat!.id,
        createdBy: base.userId,
        idempotencyKey: `ordinary-${index}`,
        name: `Ordinary ${index}`,
        program: memoryPassProgram("memory-light"),
        source: light.revision.source,
      });
    expect(
      (
        await f.triggers.listForOwner({
          ownerId: base.userId,
          systemRole: "memory-light",
          scope: { kind: "user" },
          limit: 1,
        })
      )[0]?.id,
    ).toBe(light.trigger.id);
    expect(
      (
        await f.triggers.listForOwner({ ownerId: base.userId, scope: { kind: "user" }, limit: 100 })
      ).filter(({ systemRole }) => systemRole),
    ).toHaveLength(2);
    expect(
      await f.triggers.getForOwner(light.trigger.id, base.userId, 1, {
        kind: "lineage",
        lineageRootThreadId: createId("thread"),
      }),
    ).toBeNull();
    expect(
      await f.triggers.getForOwner(
        light.trigger.id,
        await f.store.createUser("Another person"),
        1,
        { kind: "user" },
      ),
    ).toBeNull();
    expect(light.anchorThread?.id).toBe(light.trigger.anchorThreadId);
  });

  it("keeps a managed worker unlisted when a person reuses it for delegated work", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "reuse");
    await service(f).instance.ensureForMain(base.workspace.id);
    const light = await role(f, base.userId);
    const parent = await f.enqueueHumanTrigger({
      content: [{ type: "text", text: "Check this with a helper" }],
      idempotencyKey: "reuse-parent",
      requestedBy: base.userId,
      threadId: base.chat!.id,
    });
    await f.store.claimCommand(parent.command.id, "reuse-parent-dispatcher");
    await f.bindAgentControlRun(base, parent.run.id, "reuse-parent", base.chat!.id);
    await f.database
      .updateTable("runs")
      .set({ status: "running" })
      .where("id", "=", parent.run.id)
      .execute();
    const delegated = await f.store.delegateThread({
      accessMode: light.anchorThread!.accessMode,
      createdBy: base.userId,
      environmentId: base.environmentId,
      harnessInstanceId: base.harnessInstance.id,
      idempotencyKey: "reuse-managed",
      modelSelection: light.anchorThread!.modelSelection,
      origin: { kind: "run", parentRunId: parent.run.id, parentThreadId: base.chat!.id },
      task: [{ type: "text", text: "Check this" }],
      threadId: light.trigger.anchorThreadId,
      title: "Check",
      workspaceId: base.workspace.id,
    });
    expect(delegated.thread.listed).toBe(false);
  });

  for (const mode of ["live", "durable"] as const)
    it(`presents an unassigned hidden worker's ${mode} Request on Chat, preserving worker authority and denying other readers`, async ({
      storeFixture: f,
    }) => {
      const base = await fixture(f, `request-${mode}`);
      await service(f).instance.ensureForMain(base.workspace.id);
      const light = (await role(f, base.userId)).trigger;
      const occurrence = await tick(f, base, light);
      const admitted = await wake(f, light, occurrence.occurrence.id, `request-wake-${mode}`);
      if (!admitted.run || !admitted.command) throw new Error("Worker Run missing");
      await f.store.claimCommand(admitted.command.id, `request-dispatch-${mode}`);
      const binding = await f.bindAgentControlRun(
        base,
        admitted.run.id,
        `request-${mode}`,
        light.anchorThreadId,
      );
      await f.database
        .updateTable("runs")
        .set({ status: "running" })
        .where("id", "=", admitted.run.id)
        .execute();
      await expect(
        f.store.resolvePlaceActors({
          agentBindingIds: [`run:${admitted.run.id}`],
          ownerIds: [base.userId],
        }),
      ).resolves.toEqual([]);
      const opened = await f.store.requests.create({
        callId: `question-${mode}`,
        kind: mode === "live" ? "harness.input" : "machine.full-disk-access",
        mode,
        originatingRunId: admitted.run.id,
        originatingThreadId: light.anchorThreadId,
        originatingWorkspaceId: base.workspace.id,
        targetWorkspaceId: base.workspace.id,
        requestedBy: base.userId,
        requiredActor: "requester",
        payload:
          mode === "live"
            ? { kind: "harness.input" }
            : {
                kind: "machine.full-disk-access",
                machineId: base.runnerId,
                machineName: "Memory computer",
                reason: "Read files",
              },
        presentation:
          mode === "live"
            ? {
                kind: "choice",
                title: "A question",
                options: [{ id: "allow", label: "Allow", hint: "allow-once" }],
              }
            : {
                kind: "external",
                title: "Choose access",
                subject: { kind: "machine", id: base.runnerId },
              },
      });
      const waiting = (
        await f.store.requests.waitingOnUserPage({ userId: base.userId, limit: 100 })
      ).requests.find(({ request }) => request.id === opened.request.id)!;
      expect(waiting).toMatchObject({
        assignments: [],
        presentation: {
          threadId: base.chat!.id,
          workerThread: { id: light.anchorThreadId, title: "Memory light pass" },
        },
        request: { originatingThreadId: light.anchorThreadId, originatingRunId: admitted.run.id },
      });
      expect(
        (
          await f.store.requests.waitingOnUserPage({
            userId: await f.store.createUser("Denied"),
            limit: 100,
          })
        ).requests,
      ).toEqual([]);
      expect(binding.requestedBy).toBe(base.userId);
    });

  it("starts each admitted pass in a fresh native session on its own model, and never reroutes an active pass", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "fresh-pass");
    await service(f).instance.ensureForMain(base.workspace.id);
    const light = (await role(f, base.userId)).trigger;
    const sessions = () =>
      f.database
        .selectFrom("providerSessions")
        .selectAll()
        .where("threadId", "=", light.anchorThreadId)
        .execute();
    const runs = () =>
      f.database
        .selectFrom("runs")
        .selectAll()
        .where("threadId", "=", light.anchorThreadId)
        .orderBy("runOrdinal")
        .execute();
    const first = await tick(f, base, light);
    await expect(wake(f, light, first.occurrence.id, "unresolved", null)).rejects.toThrow(
      MANAGED_MEMORY_WAKE_SKIPPED,
    );
    const lightModel = ModelSelectionSchema.parse({
      providerId: "openai",
      modelId: "light",
      nativeModelId: "native-light",
      options: {},
    });
    const admitted = await wake(f, light, first.occurrence.id, "first-pass", {
      harnessInstanceId: base.harnessInstance.id,
      harnessRevision: base.harnessInstance.runtimeRevision,
      modelSelection: lightModel,
    });
    expect(admitted.events.map(({ type }) => type)).toContain("thread.execution-updated");
    const [firstRun] = await runs();
    const firstSession = (await sessions()).find(({ active }) => active);
    expect(firstRun).toMatchObject({
      modelSelection: lightModel,
      providerSessionId: firstSession?.id,
    });
    expect(firstSession?.providerSessionReference).toBeNull();
    await f.database
      .updateTable("providerSessions")
      .set({
        continuationIdentity: sql`${JSON.stringify(testContinuationIdentity)}::jsonb`,
        providerSessionReference: "native-first-pass",
      })
      .where("id", "=", firstSession!.id)
      .execute();

    // A later wake while the pass is active neither runs nor reroutes it.
    const second = await tick(f, base, light);
    await expect(wake(f, light, second.occurrence.id, "while-active")).rejects.toThrow(
      MANAGED_MEMORY_WAKE_SKIPPED,
    );
    await expect(
      wake(f, light, second.occurrence.id, "while-active-other-model", {
        harnessInstanceId: base.harnessInstance.id,
        harnessRevision: base.harnessInstance.runtimeRevision,
        modelSelection: base.chat!.modelSelection,
      }),
    ).rejects.toThrow(MANAGED_MEMORY_WAKE_SKIPPED);
    expect((await role(f, base.userId)).anchorThread?.modelSelection).toEqual(lightModel);
    expect((await sessions()).find(({ active }) => active)?.id).toBe(firstSession!.id);

    await f.database
      .updateTable("runs")
      .set({ status: "completed", completedAt: new Date() })
      .where("id", "=", firstRun!.id)
      .execute();
    await f.database
      .updateTable("threadInputs")
      .set({ state: "delivered", deliveredAt: new Date(), runId: firstRun!.id })
      .where("messageId", "=", firstRun!.seedInputId)
      .execute();
    await delivered(f, base, base.chat!.id, "chat-before-next-pass");
    const third = await tick(f, base, light);
    await wake(f, light, third.occurrence.id, "next-pass", {
      harnessInstanceId: base.harnessInstance.id,
      harnessRevision: base.harnessInstance.runtimeRevision,
      modelSelection: base.chat!.modelSelection,
    });
    const [frozen, next] = await runs();
    const nextSession = (await sessions()).find(({ active }) => active);
    expect(frozen).toMatchObject({
      modelSelection: lightModel,
      providerSessionId: firstSession!.id,
    });
    expect(next).toMatchObject({
      modelSelection: base.chat!.modelSelection,
      providerSessionId: nextSession?.id,
    });
    expect(nextSession).toMatchObject({ providerSessionReference: null, status: "starting" });
    expect(nextSession!.id).not.toBe(firstSession!.id);
  });

  it("lists what a light pass must read, with no old wakes, and skips an idle wake", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "activity");
    await service(f).instance.ensureForMain(base.workspace.id);
    const light = (await role(f, base.userId)).trigger;
    const thread = async (title: string, patch: { listed?: boolean; inheritsMain?: boolean }) => {
      const { thread } = await f.store.createThread({
        createdBy: base.userId,
        environmentId: base.environmentId,
        harnessInstanceId: base.harnessInstance.id,
        idempotencyKey: `activity-${title}`,
        modelSelection: base.chat!.modelSelection,
        title,
        workspaceId: base.workspace.id,
      });
      // Consent is immutable; a real shared route creates its Thread without Main.
      if (Object.keys(patch).length === 0) return thread;
      await f.database.transaction().execute(async (transaction) => {
        await sql`set local session_replication_role = replica`.execute(transaction);
        await transaction.updateTable("threads").set(patch).where("id", "=", thread.id).execute();
      });
      return thread;
    };
    const voice = await thread("Voice", { listed: false });
    const shared = await thread("Shared channel", { inheritsMain: false });

    const first = await wake(f, light, (await tick(f, base, light)).occurrence.id, "activity-1");
    expect(wakeText(first).join("\n")).toContain("No new conversations");
    await finish(f, first.run!, "completed");

    await expect(
      wake(f, light, (await tick(f, base, light)).occurrence.id, "activity-idle"),
    ).rejects.toThrow(MANAGED_MEMORY_WAKE_SKIPPED);

    await delivered(f, base, voice.id, "activity-voice");
    await delivered(f, base, shared.id, "activity-shared");
    await delivered(f, base, base.chat!.id, "activity-chat");
    await f.enqueueHumanTrigger({
      content: [{ type: "text", text: "Still waiting behind a Run" }],
      idempotencyKey: "activity-waiting",
      requestedBy: base.userId,
      threadId: (await thread("Waiting", {})).id,
    });
    const next = await tick(f, base, light);
    const second = await wake(f, light, next.occurrence.id, "activity-2");
    const text = wakeText(second).join("\n");
    expect(text).toContain(`"Voice": threadId ${voice.id}, 1 new messages`);
    expect(text).toContain(`threadId home, 1 new messages`);
    expect(text).not.toContain(shared.id);
    expect(text).not.toContain("Waiting");
    expect(text).not.toContain(light.anchorThreadId);

    await f.store.claimCommand(second.command!.id, "activity-dispatcher");
    expect((await f.store.loadRunDispatchContext(second.command!.id)).initialContext).toBeNull();

    // A replay keeps what the wake froze, though the world has moved on.
    await delivered(f, base, voice.id, "activity-after-freeze");
    const replay = await wake(f, light, next.occurrence.id, "activity-2");
    expect(wakeText(replay)).toEqual(wakeText(second));

    // A failed pass read nothing durable, so its conversations come back.
    await finish(f, second.run!, "failed");

    // Another Trigger's work on this worker says nothing about what memory read.
    await sql`update messages set created_at = created_at - interval '1 hour'
      where thread_id in (${voice.id}, ${light.anchorThreadId})`.execute(f.database);
    await sql`update thread_inputs set updated_at = updated_at - interval '1 hour'
      where thread_id in (${voice.id}, ${light.anchorThreadId})`.execute(f.database);
    const nightly = (await role(f, base.userId, "memory-nightly")).trigger;
    const other = await f.store.enqueueThreadInput({
      content: [{ type: "text", text: "Unrelated work" }],
      idempotencyKey: "activity-other-trigger",
      policy: "queue",
      requestedBy: base.userId,
      source: { kind: "trigger", occurrenceId: (await tick(f, base, nightly)).occurrence.id },
      threadId: light.anchorThreadId,
    });
    await finish(f, other.run!, "completed");

    const retried = await wake(f, light, (await tick(f, base, light)).occurrence.id, "activity-3");
    expect(wakeText(retried).join("\n")).toContain(`"Voice": threadId ${voice.id}, 2 new messages`);

    // A published report is readable before any Run consumes it.
    await finish(f, retried.run!, "completed");
    const reported = await thread("Reported", {});
    await f.store.enqueueThreadInput({
      content: [{ type: "text", text: "The ferry is booked" }],
      idempotencyKey: "activity-report",
      policy: "report",
      requestedBy: base.userId,
      source: { kind: "human" },
      threadId: reported.id,
    });
    const after = await wake(f, light, (await tick(f, base, light)).occurrence.id, "activity-4");
    expect(wakeText(after).join("\n")).toContain(
      `"Reported": threadId ${reported.id}, 1 new messages`,
    );
  });

  it("replays an accepted pass's wake without choosing its model again", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "accepted-replay");
    const s = service(f);
    await s.instance.ensureForMain(base.workspace.id);
    const light = await role(f, base.userId);
    const worker = light.anchorThread!;
    const { occurrence } = await tick(f, base, light.trigger);
    const { account: claude } = await claudeAccount(f, base);
    const durable = async () => ({
      inputs: await f.database
        .selectFrom("threadInputs")
        .select("messageId")
        .where("threadId", "=", worker.id)
        .execute(),
      runs: await f.database
        .selectFrom("runs")
        .select("id")
        .where("threadId", "=", worker.id)
        .execute(),
      sessions: await f.database
        .selectFrom("providerSessions")
        .selectAll()
        .where("threadId", "=", worker.id)
        .orderBy("id")
        .execute(),
    });

    // This retry reads the person's config only after the other retry's pass commits.
    const read = f.store.getAutomaticModelConfig.bind(f.store);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const held = vi
      .spyOn(f.store, "getAutomaticModelConfig")
      .mockImplementationOnce(async (userId) => {
        await released;
        return read(userId);
      });
    const retry = s.instance.admissionSelection(occurrence.id, worker);
    await vi.waitFor(() => expect(held).toHaveBeenCalled(), { timeout: 5_000 });
    const accepted = await wake(f, light.trigger, occurrence.id, "accepted");
    const committed = await durable();
    expect(committed.runs).toEqual([{ id: accepted.run!.id }]);
    // Nothing is usable any more, but this occurrence's pass is already decided.
    await f.store.setAutomaticModelConfig(base.userId, {
      roles: {},
      excludedAccounts: [claude.id],
    });
    release();
    await expect(retry).resolves.toBeUndefined();
    held.mockRestore();

    const assertReplays = async () => {
      expect((await role(f, base.userId)).trigger.waitingReason).toBeNull();
      await expect(s.instance.admissionSelection(occurrence.id, worker)).resolves.toBeUndefined();
      const replayed = await wake(f, light.trigger, occurrence.id, "accepted", null);
      expect(replayed).toMatchObject({ wasDuplicate: true, message: { id: accepted.message.id } });
      expect(await durable()).toEqual(committed);
    };
    await assertReplays();

    // A failed pass stays that occurrence's pass: its wake never starts another.
    await f.database
      .updateTable("runs")
      .set({ status: "failed", completedAt: new Date() })
      .where("id", "=", accepted.run!.id)
      .execute();
    await assertReplays();
  });

  it("settles a retry's waiting decision behind an admission still in flight", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "in-flight");
    const s = service(f);
    await s.instance.ensureForMain(base.workspace.id);
    const light = await role(f, base.userId);
    const { occurrence } = await tick(f, base, light.trigger);
    await f.store.setAutomaticModelConfig(base.userId, {
      roles: {},
      excludedAccounts: [base.harnessInstance.id],
    });
    // Admission holds the occurrence, then stops here until the Workspace row frees.
    await holdingRow(f, "workspaces", base.workspace.id, async (release) => {
      const admission = wake(f, light.trigger, occurrence.id, "in-flight");
      await lockWaiters(f, 1);
      const retry = s.instance.admissionSelection(occurrence.id, light.anchorThread!);
      await lockWaiters(f, 2);
      release();
      await expect(retry).resolves.toBeUndefined();
      expect((await admission).wasDuplicate).toBe(false);
    });
    expect((await role(f, base.userId)).trigger.waitingReason).toBeNull();
  });

  it("clears a waiting decision that reached the occurrence before admission", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "waiting-first");
    const s = service(f);
    await s.instance.ensureForMain(base.workspace.id);
    const light = await role(f, base.userId);
    const { occurrence } = await tick(f, base, light.trigger);
    await f.store.setAutomaticModelConfig(base.userId, {
      roles: {},
      excludedAccounts: [base.harnessInstance.id],
    });
    await expect(s.instance.admissionSelection(occurrence.id, light.anchorThread!)).rejects.toThrow(
      MANAGED_MEMORY_WAKE_SKIPPED,
    );
    expect((await role(f, base.userId)).trigger.waitingReason).toBe(memoryPassWaitingReason);
    await wake(f, light.trigger, occurrence.id, "waiting-first");
    expect((await role(f, base.userId)).trigger.waitingReason).toBeNull();
  });

  it("holds a pass to the endpoint it resolved until its Run binds", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "endpoint-fence");
    const s = service(f);
    await s.instance.ensureForMain(base.workspace.id);
    const light = await role(f, base.userId);
    const worker = light.anchorThread!;
    const { occurrence } = await tick(f, base, light.trigger);
    const { account: claude, catalog } = await claudeAccount(f, base);
    const moveEndpoint = async (baseUrl: string) => {
      const moved = await f.store.updateHarnessInstance({ id: claude.id, config: { baseUrl } });
      await f.store.recordHarnessCatalogs({
        environmentId: base.environmentId,
        expectedRevisions: new Map([[moved.id, moved.runtimeRevision]]),
        catalogs: [catalog],
      });
    };

    const chosen = (await s.instance.admissionSelection(occurrence.id, worker))!;
    await moveEndpoint("https://b.example/v1");
    await expect(wake(f, light.trigger, occurrence.id, "changed", chosen)).rejects.toThrow(
      MANAGED_MEMORY_WAKE_SKIPPED,
    );
    expect(
      await f.database
        .selectFrom("threadInputs")
        .select("messageId")
        .where("threadId", "=", worker.id)
        .execute(),
    ).toEqual([]);

    // The next resolution sees the endpoint as it is now, and that one can admit.
    const current = (await s.instance.admissionSelection(occurrence.id, worker))!;
    expect(current.harnessRevision).toBe(chosen.harnessRevision + 1);
    // Admission holds the account, then stops here until the worker's row frees. The
    // change waits behind it, and finds a queued Run that holds the endpoint from then on.
    await holdingRow(f, "threads", worker.id, async (release) => {
      const admission = wake(f, light.trigger, occurrence.id, "current", current);
      await lockWaiters(f, 1);
      const change = moveEndpoint("https://c.example/v1");
      const refused = expect(change).rejects.toMatchObject({ code: "conflict", retryable: true });
      await lockWaiters(f, 2);
      release();
      await refused;
      expect((await admission).run).toMatchObject({
        harnessInstanceId: claude.id,
        status: "queued",
      });
    });
  });

  it("resolves each pass's role when admitted, waits without pausing, and never resumes a pause", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "resolution", { light: false });
    const { account: claude } = await claudeAccount(f, base);
    // Chat's model as its account's catalog lists it, options included.
    const chatModel = ModelSelectionSchema.parse({
      providerId: "openai",
      modelId: "gpt-5.6-sol",
      options: {},
    });
    await f.database
      .updateTable("threads")
      .set({ modelSelection: sql`${JSON.stringify(chatModel)}::jsonb` })
      .where("id", "=", base.chat!.id)
      .execute();
    const s = service(f);
    const onChanged = vi.fn();
    const instance = new MemoryPassService({
      store: f.store,
      runners: s.runners,
      files: { preview: s.preview },
      onEvent: vi.fn(),
      onChanged,
      onError: vi.fn(),
    });
    await instance.ensureForMain(base.workspace.id);
    const light = await role(f, base.userId);
    const nightly = await role(f, base.userId, "memory-nightly");
    const exclude = (...excludedAccounts: HarnessInstanceId[]) =>
      f.store.setAutomaticModelConfig(base.userId, { roles: {}, excludedAccounts });

    // The Trigger's creator, Main's owner, is the principal. Light has no Chat
    // fallback: with Claude excluded by them, it waits.
    await exclude(claude.id);
    const lightTick = await tick(f, base, light.trigger);
    await expect(
      instance.admissionSelection(lightTick.occurrence.id, light.anchorThread!),
    ).rejects.toThrow(MANAGED_MEMORY_WAKE_SKIPPED);
    expect(onChanged).toHaveBeenCalledWith(base.workspace.id);
    expect((await role(f, base.userId)).trigger).toMatchObject({
      status: "active",
      pauseReason: null,
      waitingReason: memoryPassWaitingReason,
    });
    expect(
      (
        await f.triggers.listForOwner({
          ownerId: base.userId,
          systemRole: "memory-light",
          scope: { kind: "user" },
        })
      )[0]?.waitingReason,
    ).toBe(memoryPassWaitingReason);

    // The person pauses it; a model becoming usable never resumes it.
    await f.triggers.setStatus({
      actorThreadId: null,
      ownerId: base.userId,
      triggerId: light.trigger.id,
      status: "paused",
    });
    await exclude();
    expect(await instance.admissionSelection(lightTick.occurrence.id, light.anchorThread!)).toEqual(
      {
        harnessInstanceId: claude.id,
        harnessRevision: claude.runtimeRevision,
        modelSelection: expect.objectContaining({
          providerId: "anthropic",
          modelId: "claude-haiku-5-5",
          options: { effort: "low" },
        }),
      },
    );
    expect((await role(f, base.userId)).trigger).toMatchObject({
      status: "paused",
      pauseReason: null,
      waitingReason: null,
    });
    await expect(
      wake(f, light.trigger, lightTick.occurrence.id, "paused-wake", {
        harnessInstanceId: claude.id,
        harnessRevision: claude.runtimeRevision,
        modelSelection: light.anchorThread!.modelSelection,
      }),
    ).rejects.toThrow(MANAGED_MEMORY_WAKE_SKIPPED);

    // Nightly ranks no usable deep model here, so it ends with Chat's model.
    const nightlyTick = await tick(f, base, nightly.trigger);
    expect(
      await instance.admissionSelection(nightlyTick.occurrence.id, nightly.anchorThread!),
    ).toEqual({
      harnessInstanceId: base.chat!.harnessInstanceId,
      harnessRevision: base.harnessInstance.runtimeRevision,
      modelSelection: chatModel,
    });
    expect((await role(f, base.userId, "memory-nightly")).trigger.waitingReason).toBeNull();
    // Chat's model is an original, never an override: excluding its account drops it.
    await exclude(base.chat!.harnessInstanceId);
    await expect(
      instance.admissionSelection(nightlyTick.occurrence.id, nightly.anchorThread!),
    ).rejects.toThrow(MANAGED_MEMORY_WAKE_SKIPPED);
    expect((await role(f, base.userId, "memory-nightly")).trigger.waitingReason).toBe(
      memoryPassWaitingReason,
    );
    await exclude();
    // A person's deep list replaces the maintained one and comes before Chat.
    await f.store.setAutomaticModelConfig(base.userId, {
      roles: {
        deep: [
          {
            engine: HarnessIdSchema.parse("claude"),
            model: ModelSelectionSchema.shape.modelId.parse("claude-haiku-5-5"),
          },
        ],
      },
      excludedAccounts: [],
    });
    expect(
      await instance.admissionSelection(nightlyTick.occurrence.id, nightly.anchorThread!),
    ).toEqual({
      harnessInstanceId: claude.id,
      harnessRevision: claude.runtimeRevision,
      // Options left out stay out, so the engine's default applies at dispatch.
      modelSelection: {
        providerId: "anthropic",
        modelId: "claude-haiku-5-5",
        nativeModelId: "claude-haiku-5-5",
        options: {},
      },
    });
    await f.store.setAutomaticModelConfig(base.userId, { roles: {}, excludedAccounts: [] });

    // Memory turned off stays off while models come and go.
    await f.database
      .updateTable("triggers")
      .set({ pauseReason: "Memory is off at your request.", status: "paused", nextFireAt: null })
      .where("id", "=", nightly.trigger.id)
      .execute();
    await f.store.recordHarnessCatalogs({
      environmentId: base.environmentId,
      expectedRevisions: new Map([[base.harnessInstance.id, base.harnessInstance.runtimeRevision]]),
      catalogs: [{ ...base.catalog, models: [] }],
    });
    await expect(
      instance.admissionSelection(nightlyTick.occurrence.id, nightly.anchorThread!),
    ).rejects.toThrow(MANAGED_MEMORY_WAKE_SKIPPED);
    await f.store.recordHarnessCatalogs({
      environmentId: base.environmentId,
      expectedRevisions: new Map([[base.harnessInstance.id, base.harnessInstance.runtimeRevision]]),
      catalogs: [base.catalog],
    });
    await instance.admissionSelection(nightlyTick.occurrence.id, nightly.anchorThread!);
    expect((await role(f, base.userId, "memory-nightly")).trigger).toMatchObject({
      status: "paused",
      pauseReason: "Memory is off at your request.",
    });
  });
});
