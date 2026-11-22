import { personTaskReader } from "@opensteer/database";
import { DeviceIdSchema } from "@opensteer/core";
import { sql } from "kysely";
import {
  createId,
  ThreadAccessModeSchema,
  type HarnessInstanceId,
  type MessageId,
  type RunId,
  type Thread,
} from "@opensteer/core";
import {
  AgentConnectionStore,
  ChannelStore,
  createMemoryPass,
  needsYouPage,
  TriggerStore,
  type MemoryPassExecution,
} from "@opensteer/database";
import { writeAgentHomeSettings } from "@opensteer/database/test-support/personal";
import { startPersonalQueuedRunFixture } from "@opensteer/database/test-support/personal-run";
import { HarnessIdSchema, ModelSelectionSchema } from "@opensteer/core";
import {
  describeStore,
  testContinuationIdentity,
  testReadyHarnessCatalog,
  type StoreFixture,
  testMessagingRunnerId,
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
import type { AgentCaller } from "../mcp/agent-caller.js";
import { lastService, serveMcp } from "../mcp/connection-caller.test-support.js";
const computerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
async function fixture(
  f: StoreFixture,
  suffix: string,
  options: {
    light?: boolean;
    accessMode?: Thread["accessMode"];
  } = {},
) {
  const base = await f.createRunFixture(suffix);
  await f.store.rememberExecutionChoice(base.userId, {
    selection: {
      environmentId: base.environmentId,
      harnessInstanceId: base.harnessInstance.id,
      modelSelection: base.thread.modelSelection,
    },
  });
  await f.database
    .updateTable("runners")
    .set({
      capabilities: sql`'["trigger-program-v5"]'::jsonb`,
    })
    .where("id", "=", base.runnerId)
    .execute();
  const catalog = HarnessInstanceCatalogSchema.parse({
    ...testReadyHarnessCatalog(base.harnessInstance.id),
    ...(options.light === false
      ? {}
      : {
          lightModel: {
            providerId: "openai",
            modelId: "light",
            options: {},
          },
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
  return {
    ...base,
    catalog,
  };
}
function service(
  f: StoreFixture,
  options: {
    off?: boolean;
    clock?: import("@opensteer/shared/clock").Clock;
  } = {},
) {
  const preview = vi.fn(async () =>
    options.off ? "## Memory\nMemory: off at the person's request\n" : "",
  );
  const onError = vi.fn();
  const runners = {
    isAvailable: vi.fn(() => true),
    canRunHarness: vi.fn(() => true),
    harnessAccessModes: vi.fn(() => ThreadAccessModeSchema.options),
  };
  const instance = new MemoryPassService({
    store: f.store,
    runners,
    readAgentInstructions: preview,
    onChanged: vi.fn(),
    onError,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  return {
    instance,
    preview,
    onError,
    runners,
  };
}
async function detail(f: StoreFixture, ownerId: Trigger["createdBy"], id: Trigger["id"]) {
  const result = await f.triggers.getForOwner(id, ownerId, 25, personTaskReader);
  if (!result) throw new Error("Managed Trigger detail missing");
  return result;
}
async function role(
  f: StoreFixture,
  ownerId: Trigger["createdBy"],
  systemRole: TriggerSystemRole = "memory-light",
) {
  const found = await f.triggers.listForOwner({ reader: personTaskReader, ownerId, systemRole });
  if (!found[0]) throw new Error("Managed role missing");
  return detail(f, ownerId, found[0].id);
}
// Advance a separate scheduler clock so a tick cannot claim another role's real cron boundary.
let nextTickAt = Date.parse("2000-01-01T00:00:00.000Z");
async function tick(f: StoreFixture, base: Awaited<ReturnType<typeof fixture>>, trigger: Trigger) {
  const now = new Date(nextTickAt++);
  await f.database
    .updateTable("triggers")
    .set({
      nextFireAt: now,
    })
    .where("id", "=", trigger.id)
    .execute();
  const occurrence = (await f.triggers.claimDueSchedules(now)).occurrences.find(
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
  return {
    occurrence,
    runnerBootId,
    ...started,
  };
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
            values: [
              {
                value: "low",
                label: "Low",
              },
              {
                value: "high",
                label: "High",
              },
            ],
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
  return {
    account,
    catalog,
  };
}
/** Holds a row so `work` can stop an admission at a known lock, then releases it. */
async function holdingRow(
  f: StoreFixture,
  table: "threads" | "syncFence",
  id: string,
  work: (release: () => void) => Promise<void>,
) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  const blocker = f.database.transaction().execute(async (transaction) => {
    // Every personal commit takes the `client_sync_state` fence first.
    if (table === "syncFence")
      await sql`select deployment_id from client_sync_state for no key update`.execute(transaction);
    else await sql`select id from threads where id = ${id} for no key update`.execute(transaction);
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
      const { rows } = await sql<{
        count: string;
      }>`select count(*) from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`.execute(f.database);
      expect(Number(rows[0]!.count)).toBe(count);
    },
    {
      timeout: 5_000,
    },
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
    content: [
      {
        type: "text",
        text: "Memory pass due",
      },
    ],
    idempotencyKey: key,
    policy: "queue",
    requestedBy: trigger.createdBy,
    source: {
      kind: "trigger",
      occurrenceId,
    },
    threadId: trigger.anchorThreadId,
    ...(memoryPass === null
      ? {}
      : {
          memoryPass: memoryPass ?? worker,
        }),
  });
}
async function delivered(
  f: StoreFixture,
  base: Awaited<ReturnType<typeof fixture>>,
  threadId: Thread["id"],
  key: string,
) {
  const { run } = await f.enqueueHumanTrigger({
    content: [
      {
        type: "text",
        text: "Dinner at eight",
      },
    ],
    idempotencyKey: key,
    requestedBy: base.userId,
    threadId,
  });
  await finish(f, run, "completed");
}
async function finish(
  f: StoreFixture,
  run: {
    readonly id: RunId;
    readonly seedInputId: MessageId;
  },
  status: "completed" | "failed",
) {
  await f.database
    .updateTable("runs")
    .set({
      status,
      completedAt: new Date(),
    })
    .where("id", "=", run.id)
    .execute();
  await f.database
    .updateTable("threadInputs")
    .set({
      state: "delivered",
      deliveredAt: new Date(),
      runId: run.id,
      updatedAt: new Date(),
    })
    .where("messageId", "=", run.seedInputId)
    .execute();
}
/** A Run's own caller, as the Run's tool token would name it once its Runner holds it. */
/** A subagent node on a started Run. */
async function subagentNode(f: StoreFixture, runId: RunId) {
  const attempt = await f.database
    .selectFrom("runAttempts")
    .select("id")
    .where("runId", "=", runId)
    .where("status", "=", "current")
    .executeTakeFirstOrThrow();
  const id = createId("executionNode");
  await f.database
    .insertInto("executionNodes")
    .values({
      id,
      attemptId: attempt.id,
      runId,
      status: "running",
      kind: "subagent",
      effort: null,
      phaseIndex: null,
      phases: sql`'[]'::jsonb`,
      title: "Subagent",
      startedAt: new Date(),
      endedAt: null,
      nativeRef: `native:${id}`,
      originCallId: null,
      parentNodeId: null,
      prompt: null,
      result: null,
      sessionRef: null,
      model: null,
    })
    .execute();
  return id;
}
async function runCaller(
  f: StoreFixture,
  base: Awaited<ReturnType<typeof fixture>>,
  runId: RunId,
  commandId: string,
  threadId: Thread["id"],
): Promise<AgentCaller> {
  await f.store.claimCommand(commandId as never, `caller-${runId}`);
  const binding = await f.bindAgentControlRun(base, runId, `caller-${runId}`, threadId);
  await f.database.updateTable("runs").set({ status: "running" }).where("id", "=", runId).execute();
  const thread = (await f.store.getThreadForOwner(threadId, base.userId))!;
  const epoch = Math.floor(Date.now() / 1000);
  return {
    kind: "run",
    key: `run:${runId}`,
    userId: base.userId,
    accessMode: thread.accessMode,
    thread,
    claims: {
      aud: "opensteer-run-tools",
      iss: "opensteer-host",
      jti: crypto.randomUUID(),
      exp: epoch + 60,
      iat: epoch,
      environmentId: binding.environmentId,
      runnerId: binding.runnerId,
      runId,
      bindingGeneration: binding.bindingGeneration,
      runnerBootId: binding.runnerBootId,
      requestedBy: base.userId,
      threadId,
    },
  } as AgentCaller;
}
function wakeText(admitted: Awaited<ReturnType<typeof wake>>) {
  return admitted.message.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
}
describeStore("managed memory passes", (it) => {
  it("regenerates changed system programs through a new revision on start", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "regenerate");
    const instance = service(f).instance;
    await instance.ensureForPersonal();
    const prior = await role(f, base.userId);
    await f.database
      .updateTable("triggerRevisions")
      .set({
        program: {
          ...memoryPassProgram("memory-light"),
          toolContractVersion: 3 as unknown as 5,
          source: "export default () => {}",
        },
      })
      .where("id", "=", prior.revision.id)
      .execute();
    await instance.reconcileMissing();
    const current = await role(f, base.userId);
    expect(current.revision.id).not.toBe(prior.revision.id);
    expect(current.revision.ordinal).toBe(prior.revision.ordinal + 1);
    expect(current.revision.program).toEqual(memoryPassProgram("memory-light"));
    await instance.reconcileMissing();
    expect((await role(f, base.userId)).revision.id).toBe(current.revision.id);
  });

  it("creates exactly one atomic pair under concurrent provisioning in the personal agent home, and never recreates paused/Done identities", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "concurrent", {
      accessMode: "approval-required",
    });
    const s = service(f);
    await Promise.all([s.instance.ensureForPersonal(), s.instance.ensureForPersonal()]);
    const rows = await f.triggers.listForOwner({ reader: personTaskReader, ownerId: base.userId });
    expect(rows).toHaveLength(2);
    const light = await role(f, base.userId);
    const nightly = await role(f, base.userId, "memory-nightly");
    expect(light.anchorThread).toMatchObject({
      accessMode: "full-access",
      createdBy: base.userId,
      environmentId: base.environmentId,
      harnessInstanceId: base.harnessInstance.id,
      parentThreadId: null,
      lineageRootThreadId: light.trigger.anchorThreadId,
      purpose: "background-job",
      listed: false,
      modelSelection: base.thread.modelSelection,
    });
    expect(nightly.anchorThread?.modelSelection).toEqual(base.thread.modelSelection);
    expect(light.revision.source).toEqual({
      kind: "schedule",
      schedule: {
        kind: "cron",
        expression: "*/30 8-22 * * *",
        timezone: computerZone,
      },
    });
    expect(nightly.revision.source).toEqual({
      kind: "schedule",
      schedule: {
        kind: "cron",
        expression: "0 3 * * *",
        timezone: computerZone,
      },
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
    await s.instance.ensureForPersonal();
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
    const tables = ["threads", "providerSessions", "commands", "clientChanges"] as const;
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
      ownerId: base.userId,
      execution: {
        environmentId: base.environmentId,
        harnessInstanceId: base.harnessInstance.id,
        modelSelection: base.thread.modelSelection,
      },
      systemRole: "memory-light" as const,
      program: memoryPassProgram("memory-light"),
      source: {
        kind: "schedule",
        schedule: {
          kind: "cron",
          expression: "0 3 * * *",
          timezone: "UTC",
        },
      } as const,
      pauseReason: null,
    };
    const before = await counts();
    await expect(
      createMemoryPass(f.database, {
        ...input,
        program: {
          ...input.program,
          source: "",
        },
      }),
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
        program: {
          ...input.program,
          source: "",
        },
      }),
    ).rejects.toThrow();
    await service(f).instance.ensureForPersonal();
    expect((await role(f, base.userId)).trigger).toMatchObject({
      id: light.trigger.id,
      status: "paused",
      pauseReason: "Paused deliberately",
    });
    expect((await role(f, base.userId, "memory-nightly")).trigger.status).toBe("active");
  });
  it("defers missing owner setup and unreadable files, but never waits on a model", async ({
    storeFixture: f,
  }) => {
    await service(f).instance.ensureForPersonal();
    const base = await fixture(f, "prerequisites", {
      light: false,
    });
    const s = service(f);
    s.preview.mockRejectedValueOnce(new Error("Storage unreadable"));
    await s.instance.ensureForPersonal();
    expect(
      await f.triggers.listForOwner({ reader: personTaskReader, ownerId: base.userId }),
    ).toEqual([]);
    // Unsettled, so the Host asks again on the next Runner registration or finished Run.
    expect(s.instance.settled).toBe(false);
    // An offline computer or an account without a light model does not
    // defer creation: each pass chooses its model when it is admitted.
    s.runners.isAvailable.mockReturnValue(false);
    await s.instance.ensureForPersonal();
    expect((await role(f, base.userId)).trigger).toMatchObject({
      status: "active",
      pauseReason: null,
    });
    expect((await role(f, base.userId, "memory-nightly")).trigger.status).toBe("active");
    await s.instance.ensureForPersonal();
    expect(s.instance.settled).toBe(true);
  });
  it("retries provisioning after a transient failure with no further Run or registration", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "transient", { light: false });
    let now = Date.now();
    const timers = new Set<{ at: number; run: () => void }>();
    const clock = {
      now: () => now,
      schedule(run: () => void, milliseconds: number) {
        const timer = { at: now + milliseconds, run };
        timers.add(timer);
        return () => timers.delete(timer);
      },
    };
    const s = service(f, { clock });
    s.preview.mockRejectedValueOnce(new Error("Runner busy"));
    s.instance.wake();
    await s.instance.idle();
    expect(
      await f.triggers.listForOwner({ reader: personTaskReader, ownerId: base.userId }),
    ).toEqual([]);
    expect(s.instance.settled).toBe(false);
    // The failed pass left a deadline: nothing else wakes it.
    expect([...timers].map((timer) => timer.at - now)).toEqual([5_000]);
    now += 5_000;
    const due = [...timers].filter((timer) => timer.at <= now);
    for (const timer of due) {
      timers.delete(timer);
      timer.run();
    }
    await s.instance.idle();
    expect((await role(f, base.userId)).trigger.status).toBe("active");
    expect(s.instance.settled).toBe(true);
    expect(timers.size).toBe(0);
    await s.instance.close();
  });
  it("creates both identities paused, with one reason, when memory is off", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "off", {
      light: false,
    });
    await service(f, {
      off: true,
    }).instance.ensureForPersonal();
    const rows = await f.triggers.listForOwner({ reader: personTaskReader, ownerId: base.userId });
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(row).toMatchObject({
        status: "paused",
        nextFireAt: null,
        pauseReason: "Memory is off at your request.",
      });
  });
  it("skips a pending offline tick after Pause on reconnect without recording a failure", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "late-pause");
    await service(f).instance.ensureForPersonal();
    const light = (await role(f, base.userId)).trigger;
    await f.database
      .updateTable("triggers")
      .set({
        nextFireAt: new Date(Date.now() - 1_000),
      })
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
    await service(f).instance.ensureForPersonal();
    const light = (await role(f, base.userId)).trigger;
    const first = await tick(f, base, light);
    const second = await tick(f, base, light);
    const results = await Promise.allSettled([
      wake(f, light, first.occurrence.id, "wake-one"),
      wake(f, light, second.occurrence.id, "wake-two"),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: {
        message: MANAGED_MEMORY_WAKE_SKIPPED,
      },
    });
    const accepted =
      results[0]!.status === "fulfilled"
        ? {
            key: "wake-one",
            tick: first,
          }
        : {
            key: "wake-two",
            tick: second,
          };
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
    await service(f).instance.ensureForPersonal();
    const light = (await role(f, base.userId)).trigger;
    const started = await tick(f, base, light);
    for (const patch of [
      {
        inputQueuePaused: true,
        inputQueuePausedBy: base.userId,
      },
      {
        doneAt: new Date(),
      },
      {
        status: "archived" as const,
      },
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
        .set({
          doneAt: null,
          inputQueuePaused: false,
          inputQueuePausedBy: null,
          status: "idle",
        })
        .where("id", "=", light.anchorThreadId)
        .execute();
    }
    await f.store.enqueueThreadInput({
      content: [
        {
          type: "text",
          text: "A later human input",
        },
      ],
      idempotencyKey: "human-pending",
      policy: "queue",
      requestedBy: base.userId,
      source: {
        kind: "human",
      },
      threadId: light.anchorThreadId,
    });
    await f.database
      .updateTable("runs")
      .set({
        status: "completed",
      })
      .where("threadId", "=", light.anchorThreadId)
      .execute();
    await f.database
      .updateTable("threadInputs")
      .set({
        state: "pending",
        runId: null,
      })
      .where("threadId", "=", light.anchorThreadId)
      .execute();
    await expect(wake(f, light, started.occurrence.id, "pending-input-wake")).rejects.toThrow(
      MANAGED_MEMORY_WAKE_SKIPPED,
    );
  });
  it("enforces managed lifetime and allows cron CAS while paused", async ({ storeFixture: f }) => {
    const base = await fixture(f, "guards");
    await service(f).instance.ensureForPersonal();
    const light = await role(f, base.userId);
    const common = {
      actorThreadId: null,
      ownerId: base.userId,
      triggerId: light.trigger.id,
    };
    await expect(
      f.triggers.setStatus({
        ...common,
        status: "archived",
      }),
    ).rejects.toThrow(MANAGED_MEMORY_REFUSAL);
    await expect(f.triggers.enqueueManual(common)).rejects.toThrow(MANAGED_MEMORY_REFUSAL);
    for (const changed of [
      {
        name: "Other",
      },
      {
        program: memoryPassProgram("memory-nightly"),
      },
      {
        source: {
          kind: "webhook" as const,
        },
      },
      {
        source: {
          kind: "watch" as const,
        },
      },
      {
        source: {
          kind: "schedule" as const,
          schedule: {
            kind: "at" as const,
            at: new Date(Date.now() + 60_000).toISOString(),
          },
        },
      },
    ]) {
      await expect(
        f.triggers.update({
          ...common,
          expectedRevisionId: light.revision.id,
          ...changed,
        }),
      ).rejects.toThrow(MANAGED_MEMORY_REFUSAL);
    }
    const nextFireAt = new Date(Date.now() + 60_000).toISOString();
    expect(
      await f.triggers.setNextFire({
        ...common,
        nextFireAt,
      }),
    ).toMatchObject({
      nextFireAt,
      status: "active",
    });
    await tick(f, base, light.trigger);
    expect(
      await f.triggers.cancelPendingOccurrences(base.userId, {
        actorThreadId: null,
        triggerId: light.trigger.id,
      }),
    ).toEqual({
      canceledOccurrenceIds: [],
    });
    await f.triggers.setStatus({
      ...common,
      status: "paused",
    });
    const updated = await f.triggers.update({
      ...common,
      expectedRevisionId: light.revision.id,
      source: {
        kind: "schedule",
        schedule: {
          kind: "cron",
          expression: "0 9 * * *",
          timezone: "UTC",
        },
      },
    });
    expect(updated.trigger).toMatchObject({
      status: "paused",
      nextFireAt: null,
    });
    await expect(
      f.triggers.update({
        ...common,
        expectedRevisionId: light.revision.id,
        source: updated.revision.source,
      }),
    ).rejects.toThrow("revision changed");
  });
  it("discovers roles before LIMIT beyond 100 ordinary Triggers and authorizes hidden anchor detail", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "discovery");
    await service(f).instance.ensureForPersonal();
    const light = await role(f, base.userId);
    for (let index = 0; index < 101; index++)
      await f.triggers.create({
        actorThreadId: null,
        anchorThreadId: base.thread.id,
        createdBy: base.userId,
        idempotencyKey: `ordinary-${index}`,
        name: `Ordinary ${index}`,
        program: memoryPassProgram("memory-light"),
        source: light.revision.source,
      });
    expect(
      (
        await f.triggers.listForOwner({
          reader: personTaskReader,
          ownerId: base.userId,
          systemRole: "memory-light",
          limit: 1,
        })
      )[0]?.id,
    ).toBe(light.trigger.id);
    expect(
      (
        await f.triggers.listForOwner({
          reader: personTaskReader,
          ownerId: base.userId,
          limit: 100,
        })
      ).filter(({ systemRole }) => systemRole),
    ).toHaveLength(2);
    await expect(
      f.triggers.getForOwner(
        light.trigger.id,
        await f.store.createUser("Another person"),
        1,
        personTaskReader,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(light.anchorThread?.id).toBe(light.trigger.anchorThreadId);
  });
  it("keeps a managed worker unlisted when a person reuses it for delegated work", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "reuse");
    await service(f).instance.ensureForPersonal();
    const light = await role(f, base.userId);
    const parent = await f.enqueueHumanTrigger({
      content: [
        {
          type: "text",
          text: "Check this with a helper",
        },
      ],
      idempotencyKey: "reuse-parent",
      requestedBy: base.userId,
      threadId: base.thread.id,
    });
    await f.store.claimCommand(parent.command.id, "reuse-parent-dispatcher");
    await f.bindAgentControlRun(base, parent.run.id, "reuse-parent", base.thread.id);
    await f.database
      .updateTable("runs")
      .set({
        status: "running",
      })
      .where("id", "=", parent.run.id)
      .execute();
    const delegated = await f.store.delegateThread({
      accessMode: light.anchorThread!.accessMode,
      createdBy: base.userId,
      environmentId: base.environmentId,
      harnessInstanceId: base.harnessInstance.id,
      idempotencyKey: "reuse-managed",
      modelSelection: light.anchorThread!.modelSelection,
      origin: {
        kind: "run",
        parentRunId: parent.run.id,
        parentThreadId: base.thread.id,
      },
      task: [
        {
          type: "text",
          text: "Check this",
        },
      ],
      threadId: light.trigger.anchorThreadId,
      title: "Check",
    });
    expect(delegated.thread.listed).toBe(false);
  });
  for (const mode of ["live", "durable"] as const)
    it(`presents an unassigned hidden worker's ${mode} Request in Needs you, preserving worker authority and denying other readers`, async ({
      storeFixture: f,
    }) => {
      const base = await fixture(f, `request-${mode}`);
      await service(f).instance.ensureForPersonal();
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
        .set({
          status: "running",
        })
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
        requestedBy: base.userId,
        requiredActor: "requester",
        payload:
          mode === "live"
            ? {
                kind: "harness.input",
              }
            : {
                kind: "machine.full-disk-access",
                machineId: DeviceIdSchema.parse(base.runnerId),
                machineName: "Memory computer",
                reason: "Read files",
              },
        presentation:
          mode === "live"
            ? {
                kind: "choice",
                title: "A question",
                options: [
                  {
                    id: "allow",
                    label: "Allow",
                    hint: "allow-once",
                  },
                ],
              }
            : {
                kind: "external",
                title: "Choose access",
                subject: {
                  kind: "machine",
                  id: base.runnerId,
                },
              },
      });
      const waiting = (await needsYouPage(f.database, { userId: base.userId, limit: 100 })).entries
        .filter((entry) => entry.kind === "request")
        .find(({ request }) => request.id === opened.request.id)!;
      expect(waiting).toMatchObject({
        originThreadId: light.anchorThreadId,
        navigationThreadId: light.anchorThreadId,
        purpose: "background-job",
        request: { originatingThreadId: light.anchorThreadId, originatingRunId: admitted.run.id },
      });
      await expect(
        needsYouPage(f.database, { userId: await f.store.createUser("Denied"), limit: 100 }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(binding.requestedBy).toBe(base.userId);
    });
  it("starts each admitted pass in a fresh native session on its own model, and never reroutes an active pass", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "fresh-pass");
    await service(f).instance.ensureForPersonal();
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
    await wake(f, light, first.occurrence.id, "first-pass", {
      harnessInstanceId: base.harnessInstance.id,
      harnessRevision: base.harnessInstance.runtimeRevision,
      modelSelection: lightModel,
    });
    await expect(
      f.database
        .selectFrom("threads")
        .select("modelSelection")
        .where("id", "=", light.anchorThreadId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ modelSelection: lightModel });
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
        modelSelection: base.thread.modelSelection,
      }),
    ).rejects.toThrow(MANAGED_MEMORY_WAKE_SKIPPED);
    expect((await role(f, base.userId)).anchorThread?.modelSelection).toEqual(lightModel);
    expect((await sessions()).find(({ active }) => active)?.id).toBe(firstSession!.id);
    await f.database
      .updateTable("runs")
      .set({
        status: "completed",
        completedAt: new Date(),
      })
      .where("id", "=", firstRun!.id)
      .execute();
    await f.database
      .updateTable("threadInputs")
      .set({
        state: "delivered",
        deliveredAt: new Date(),
        runId: firstRun!.id,
      })
      .where("messageId", "=", firstRun!.seedInputId)
      .execute();
    await delivered(f, base, base.thread.id, "chat-before-next-pass");
    const third = await tick(f, base, light);
    await wake(f, light, third.occurrence.id, "next-pass", {
      harnessInstanceId: base.harnessInstance.id,
      harnessRevision: base.harnessInstance.runtimeRevision,
      modelSelection: base.thread.modelSelection,
    });
    const [frozen, next] = await runs();
    const nextSession = (await sessions()).find(({ active }) => active);
    expect(frozen).toMatchObject({
      modelSelection: lightModel,
      providerSessionId: firstSession!.id,
    });
    expect(next).toMatchObject({
      modelSelection: base.thread.modelSelection,
      providerSessionId: nextSession?.id,
    });
    expect(nextSession).toMatchObject({
      providerSessionReference: null,
      status: "starting",
    });
    expect(nextSession!.id).not.toBe(firstSession!.id);
  });
  it("never reads a task that had no personal context into the person's memory", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "strangers");
    await service(f).instance.ensureForPersonal();
    const light = (await role(f, base.userId)).trigger;
    const first = await wake(f, light, (await tick(f, base, light)).occurrence.id, "strangers-1");
    await finish(f, first.run!, "completed");
    const task = async (title: string) =>
      (
        await f.store.createThread({
          createdBy: base.userId,
          environmentId: base.environmentId,
          harnessInstanceId: base.harnessInstance.id,
          idempotencyKey: `strangers-${title}`,
          modelSelection: base.thread.modelSelection,
          title,
        })
      ).thread;
    // A task from a channel where anyone may speak.
    await f.enrollMessagingRunner(testMessagingRunnerId, "Messaging");
    const account = await new ChannelStore(f.database).createConnection({
      account: { displayName: "Team", externalAccountId: "T-strangers", routingMode: "dedicated" },
      connection: {
        runnerId: testMessagingRunnerId,
        connectionMethod: "bring-your-own",
        displayName: "Team",
        externalIdentityId: "U-BOT-strangers",
        externalTenantId: "T-strangers",
        provider: "slack",
        transportKind: "socket",
      },
      createdBy: base.userId,
      credential: {
        encryptedPayload: Buffer.from("strangers"),
        encryptionKeyVersion: 1,
        id: createId("credential"),
        name: "Team",
        ownerId: base.userId,
        provider: "channel:slack",
      },
    });
    const anyone = await new AgentConnectionStore(f.database).createBridge({
      userId: base.userId,
      accountId: account.account.id,
      conversation: { id: "C-team", name: "#team" },
      senders: "anyone",
      accessMode: "approval-required",
      grant: { scope: "selected", tasks: true, resources: [] },
    });
    const fromStrangers = await task("From the channel");
    const own = await task("Own work");
    await f.database
      .updateTable("threads")
      .set({ originConnectionId: anyone.id })
      .where("id", "=", fromStrangers.id)
      .execute();
    await delivered(f, base, fromStrangers.id, "strangers-channel");
    await delivered(f, base, own.id, "strangers-own");
    const second = await wake(f, light, (await tick(f, base, light)).occurrence.id, "strangers-2");
    const text = wakeText(second).join("\n");
    expect(text).toContain(own.id);
    expect(text).not.toContain(fromStrangers.id);
  });

  it("never lists or reads a task without personal context to a memory pass, through its own tools", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "memory-tools");
    await service(f).instance.ensureForPersonal();
    const light = (await role(f, base.userId)).trigger;
    await serveMcp(f);
    const task = async (title: string, extra: Record<string, unknown> = {}) =>
      (
        await f.store.createThread({
          createdBy: base.userId,
          environmentId: base.environmentId,
          harnessInstanceId: base.harnessInstance.id,
          idempotencyKey: `memory-tools-${title}`,
          modelSelection: base.thread.modelSelection,
          title,
          ...extra,
        })
      ).thread;
    // A chat where anyone may speak, its task and a task made under it.
    await f.enrollMessagingRunner(testMessagingRunnerId, "Messaging");
    const account = await new ChannelStore(f.database).createConnection({
      account: { displayName: "Team", externalAccountId: "T-tools", routingMode: "dedicated" },
      connection: {
        runnerId: testMessagingRunnerId,
        connectionMethod: "bring-your-own",
        displayName: "Team",
        externalIdentityId: "U-BOT-tools",
        externalTenantId: "T-tools",
        provider: "slack",
        transportKind: "socket",
      },
      createdBy: base.userId,
      credential: {
        encryptedPayload: Buffer.from("tools"),
        encryptionKeyVersion: 1,
        id: createId("credential"),
        name: "Team",
        ownerId: base.userId,
        provider: "channel:slack",
      },
    });
    const anyone = await new AgentConnectionStore(f.database).createBridge({
      userId: base.userId,
      accountId: account.account.id,
      conversation: { id: "C-tools", name: "#tools" },
      senders: "anyone",
      accessMode: "approval-required",
      grant: { scope: "selected", tasks: true, resources: [] },
    });
    const fromStrangers = await task("From the channel", {
      authority: {
        kind: "connection",
        connectionId: anyone.id,
        userId: base.userId,
        accessMode: "approval-required",
      },
    });
    const under = await task("Under the channel's task", { parentThreadId: fromStrangers.id });
    // A task that ran without personal context before the update.
    const legacyId = `mcn_${crypto.randomUUID()}`;
    await sql`insert into agent_connections (id, user_id, label, client_name, access_mode,
        resource, token_hash, created_at, expires_at, revoked_at, "grant", grant_revision,
        consent_version, cleanup_reason, cleanup_requested_at, bridge_senders)
      values (${legacyId}, ${base.userId}, 'Messages before the update', 'Messaging',
        'approval-required', 'opensteer:bridge', null, now(), now(), now(),
        '{"scope":"selected","tasks":true,"resources":[]}'::jsonb, 2, 2, 'revoked', now(),
        'anyone')`.execute(f.database);
    const legacy = await task("Before the update");
    await f.database
      .updateTable("threads")
      .set({ originConnectionId: legacyId })
      .where("id", "=", legacy.id)
      .execute();
    const own = await task("Own work");
    // The light pass's own Run, as its Runner would hold it.
    const admitted = await wake(f, light, (await tick(f, base, light)).occurrence.id, "tools-1");
    if (!admitted.run || !admitted.command) throw new Error("Worker Run missing");
    const caller = await runCaller(
      f,
      base,
      admitted.run.id,
      admitted.command.id,
      light.anchorThreadId,
    );
    const call = (name: string, args: Record<string, unknown>, key: string) =>
      lastService!.callTool("", name, args, { caller, operationKey: key });
    const listed = (await call("opensteer_task_list", { limit: 50 }, "tools-list")) as {
      readonly tasks: readonly { readonly id: string }[];
    };
    const ids = listed.tasks.map(({ id }) => id);
    expect(ids).toContain(own.id);
    for (const hidden of [fromStrangers, under, legacy]) expect(ids).not.toContain(hidden.id);
    // Reading one reads exactly like reading a task that does not exist.
    const missing = await call(
      "opensteer_task_read",
      { taskId: createId("thread") },
      "tools-missing",
    ).catch((error: unknown) => error);
    for (const hidden of [fromStrangers, under, legacy])
      await expect(
        call("opensteer_task_read", { taskId: hidden.id }, `tools-read-${hidden.id}`),
      ).rejects.toMatchObject({
        code: (missing as { code: string }).code,
        message: (missing as Error).message,
      });
    // What the channel's task made: a Run with a subagent, a question, a worker and an automation.
    const turn = await f.store.enqueueThreadInput({
      requestedBy: base.userId,
      threadId: fromStrangers.id,
      content: [{ type: "text", text: "Work for #tools" }],
      source: { kind: "human" },
      policy: "queue",
      idempotencyKey: "tools-strangers-turn",
    });
    if (!turn.run) throw new Error("The channel's task reserved no Run");
    await startPersonalQueuedRunFixture(f.store, turn.run.id);
    const node = await subagentNode(f, turn.run.id);
    const question = await f.store.requests.create({
      callId: "tools-strangers-question",
      kind: "person.question",
      mode: "durable",
      originatingRunId: turn.run.id,
      originatingThreadId: fromStrangers.id,
      requestedBy: base.userId,
      requiredActor: "requester",
      payload: { kind: "person.question" },
      presentation: {
        kind: "form",
        title: "From #tools",
        fields: [
          { id: "answer", prompt: "Ready?", secret: false, custom: true, multiSelect: false },
        ],
      },
    });
    const strangersWorker = await f.store.delegateThread({
      accessMode: "approval-required",
      createdBy: base.userId,
      environmentId: base.environmentId,
      harnessInstanceId: base.harnessInstance.id,
      idempotencyKey: "tools-strangers-worker",
      modelSelection: base.thread.modelSelection,
      origin: { kind: "run", parentRunId: turn.run.id, parentThreadId: fromStrangers.id },
      task: [{ type: "text", text: "Work for #tools" }],
      title: "Worker for #tools",
    });
    // An automation in the chat's task, as one made before such lineages were refused one: made
    // on the person's task, then held in the chat's task and lineage, as its row would be.
    const automation = await new TriggerStore(f.database).create({
      actorThreadId: null,
      anchorThreadId: own.id,
      createdBy: base.userId,
      idempotencyKey: "tools-strangers-automation",
      name: "Briefing for #tools",
      program: {
        toolContractVersion: 5,
        language: "javascript",
        source: "export default () => {}",
      },
      source: {
        kind: "schedule",
        schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
      },
    });
    await f.database
      .updateTable("triggers")
      .set({ anchorThreadId: fromStrangers.id, originConnectionId: anyone.id })
      .where("id", "=", automation.trigger.id)
      .execute();
    const hiddenTasks = [fromStrangers, under, legacy, strangersWorker.thread];
    // A person's automation on their own task, one of whose downstream Runs is in the chat's task.
    const ownAutomation = await new TriggerStore(f.database).create({
      actorThreadId: null,
      anchorThreadId: own.id,
      createdBy: base.userId,
      idempotencyKey: "tools-own-automation",
      name: "My briefing",
      program: {
        toolContractVersion: 5,
        language: "javascript",
        source: "export default () => {}",
      },
      source: {
        kind: "schedule",
        schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
      },
    });
    const ownOccurrence = await new TriggerStore(f.database).enqueueManual({
      actorThreadId: null,
      ownerId: base.userId,
      triggerId: ownAutomation.trigger.id,
    });
    const chainId = createId("causalChain");
    await f.database
      .insertInto("causalChains")
      .values({
        id: chainId,
        maxDelegations: 10,
        maxAutonomousRuns: 10,
        rootMessageId: null,
        rootOccurrenceId: ownOccurrence.id,
        usedDelegations: 0,
        usedAutonomousRuns: 0,
      })
      .execute();
    await f.database
      .updateTable("triggerOccurrences")
      .set({ causalChainId: chainId })
      .where("id", "=", ownOccurrence.id)
      .execute();
    await f.database
      .updateTable("runs")
      .set({ causalChainId: chainId })
      .where("id", "=", turn.run.id)
      .execute();
    // The pass's own task tree reads as the pass: a worker it delegated to. A task it created for
    // the person is an ordinary task of theirs, and reads as one (below).
    const passWorker = await f.store.delegateThread({
      accessMode: "approval-required",
      createdBy: base.userId,
      environmentId: base.environmentId,
      harnessInstanceId: base.harnessInstance.id,
      idempotencyKey: "tools-pass-worker",
      modelSelection: base.thread.modelSelection,
      origin: {
        kind: "run",
        parentRunId: admitted.run.id,
        parentThreadId: light.anchorThreadId,
      },
      task: [{ type: "text", text: "Look through the tasks" }],
      title: "Pass worker",
    });
    const passTask = await task("Made by the pass");
    const sent = await f.store.enqueueThreadInput({
      requestedBy: base.userId,
      threadId: passTask.id,
      content: [{ type: "text", text: "Look through the tasks" }],
      source: { kind: "agent", runId: admitted.run.id },
      policy: "queue",
      idempotencyKey: "tools-pass-task",
    });
    if (!sent.run || !sent.command) throw new Error("The pass's task reserved no Run");
    const readers = {
      pass: caller,
      "a worker the pass delegated to": await runCaller(
        f,
        base,
        passWorker.run.id,
        passWorker.command.id,
        passWorker.thread.id,
      ),
    };
    const passTaskCaller = await runCaller(f, base, sent.run.id, sent.command.id, passTask.id);
    const outcome = (promise: Promise<unknown>) =>
      promise.then(
        (value) => ({ value }),
        (error: { code?: string; message?: string }) => ({
          error: { code: error.code, message: error.message },
        }),
      );
    for (const [who, reader] of Object.entries(readers)) {
      let key = 0;
      const ask = (name: string, args: Record<string, unknown>) =>
        outcome(
          lastService!.callTool("", name, args, {
            caller: reader,
            operationKey: `tools-${who}-${name}-${key++}`,
          }),
        );
      const tasks = (await ask("opensteer_task_list", { limit: 50 })) as {
        value: { tasks: readonly { id: string }[] };
      };
      const listedIds = tasks.value.tasks.map(({ id }) => id);
      expect.soft(listedIds, who).toContain(own.id);
      for (const hidden of hiddenTasks) expect.soft(listedIds, who).not.toContain(hidden.id);
      for (const hidden of hiddenTasks) {
        expect
          .soft(await ask("opensteer_task_read", { taskId: hidden.id }), who)
          .toEqual(await ask("opensteer_task_read", { taskId: createId("thread") }));
        expect
          .soft(await ask("opensteer_task_list", { limit: 50, parentTaskId: hidden.id }), who)
          .toEqual(
            await ask("opensteer_task_list", { limit: 50, parentTaskId: createId("thread") }),
          );
      }
      expect
        .soft(await ask("opensteer_subagent_read", { subagentId: node }), who)
        .toEqual(await ask("opensteer_subagent_read", { subagentId: createId("executionNode") }));
      const delegationId = strangersWorker.assignment.id;
      expect
        .soft(await ask("opensteer_delegation_status", { delegationId }), who)
        .toEqual(
          await ask("opensteer_delegation_status", { delegationId: createId("delegation") }),
        );
      expect
        .soft(await ask("opensteer_delegation_wait", { delegationId, timeoutMs: 250 }), who)
        .toEqual(
          await ask("opensteer_delegation_wait", {
            delegationId: createId("delegation"),
            timeoutMs: 250,
          }),
        );
      expect
        .soft(await ask("opensteer_request_read", { requestId: question.request.id }), who)
        .toEqual(await ask("opensteer_request_read", { requestId: createId("request") }));
      const automations = (await ask("opensteer_automation_list", { limit: 50 })) as {
        value: { automations?: readonly { id: string }[]; triggers?: readonly { id: string }[] };
      };
      expect.soft(JSON.stringify(automations.value), who).not.toContain(automation.trigger.id);
      expect
        .soft(await ask("opensteer_automation_read", { automationId: automation.trigger.id }), who)
        .toEqual(await ask("opensteer_automation_read", { automationId: createId("trigger") }));
      // Every automation door reads a hidden one as missing, the controls among them.
      for (const action of ["pause", "resume", "archive", "run_now", "cancel_pending"] as const)
        expect
          .soft(
            await ask("opensteer_automation_control", {
              automationId: automation.trigger.id,
              action,
            }),
            `${who} ${action}`,
          )
          .toEqual(
            await ask("opensteer_automation_control", {
              automationId: createId("trigger"),
              action,
            }),
          );
      // A visible automation's work in a hidden task is not shown: neither its Run nor its title.
      const read = (await ask("opensteer_automation_read", {
        automationId: ownAutomation.trigger.id,
      })) as { value?: unknown };
      expect.soft(read.value, who).toBeDefined();
      expect.soft(JSON.stringify(read.value), who).not.toContain(turn.run.id);
      expect.soft(JSON.stringify(read.value), who).not.toContain("From the channel");
    }
    // A task the pass created for the person reads as any task of theirs: nothing is hidden.
    const ordinary = (await lastService!.callTool(
      "",
      "opensteer_task_list",
      { limit: 50 },
      { caller: passTaskCaller, operationKey: "tools-pass-task-list" },
    )) as { readonly tasks: readonly { readonly id: string }[] };
    expect(ordinary.tasks.map(({ id }) => id)).toContain(fromStrangers.id);
    // The person's own agents still see their tasks as before.
    const ownRun = await f.enqueueHumanTrigger({
      content: [{ type: "text", text: "Look around" }],
      idempotencyKey: "tools-own-run",
      requestedBy: base.userId,
      threadId: own.id,
    });
    const ownCaller = await runCaller(f, base, ownRun.run.id, ownRun.command.id, own.id);
    const ownListed = (await lastService!.callTool(
      "",
      "opensteer_task_list",
      { limit: 50 },
      { caller: ownCaller, operationKey: "tools-own-list" },
    )) as { readonly tasks: readonly { readonly id: string }[] };
    expect(ownListed.tasks.map(({ id }) => id)).toContain(fromStrangers.id);
  });

  it("lists what a light pass must read, with no old wakes, and skips an idle wake", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "activity");
    await service(f).instance.ensureForPersonal();
    const light = (await role(f, base.userId)).trigger;
    const thread = async (
      title: string,
      patch: {
        listed?: boolean;
      },
    ) => {
      const { thread } = await f.store.createThread({
        createdBy: base.userId,
        environmentId: base.environmentId,
        harnessInstanceId: base.harnessInstance.id,
        idempotencyKey: `activity-${title}`,
        modelSelection: base.thread.modelSelection,
        title,
      });
      if (Object.keys(patch).length === 0) return thread;
      await f.database.transaction().execute(async (transaction) => {
        await sql`set local session_replication_role = replica`.execute(transaction);
        await transaction.updateTable("threads").set(patch).where("id", "=", thread.id).execute();
      });
      return thread;
    };
    const voice = await thread("Voice", {
      listed: false,
    });
    const shared = await thread("Shared channel", {});
    const first = await wake(f, light, (await tick(f, base, light)).occurrence.id, "activity-1");
    expect(wakeText(first).join("\n")).toContain("No new tasks");
    await finish(f, first.run!, "completed");
    await expect(
      wake(f, light, (await tick(f, base, light)).occurrence.id, "activity-idle"),
    ).rejects.toThrow(MANAGED_MEMORY_WAKE_SKIPPED);
    await delivered(f, base, voice.id, "activity-voice");
    await delivered(f, base, shared.id, "activity-shared");
    await delivered(f, base, base.thread.id, "activity-chat");
    await f.enqueueHumanTrigger({
      content: [
        {
          type: "text",
          text: "Still waiting behind a Run",
        },
      ],
      idempotencyKey: "activity-waiting",
      requestedBy: base.userId,
      threadId: (await thread("Waiting", {})).id,
    });
    const next = await tick(f, base, light);
    const second = await wake(f, light, next.occurrence.id, "activity-2");
    const text = wakeText(second).join("\n");
    // The pass takes its connected-source positions from the Run that completed.
    expect(text).toContain(`Run ${first.run!.id}`);
    expect(text).toContain(`"Voice": taskId ${voice.id}, 1 new messages`);
    expect(text).toContain(`taskId ${base.thread.id}, 1 new messages`);
    expect(text).toContain(shared.id);
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
    // A light-pass boundary can arrive while the nightly fixture starts.
    await f.database
      .updateTable("triggers")
      .set({ nextFireAt: new Date(Date.now() - 1_000) })
      .where("id", "=", light.id)
      .execute();
    const other = await f.store.enqueueThreadInput({
      content: [
        {
          type: "text",
          text: "Unrelated work",
        },
      ],
      idempotencyKey: "activity-other-trigger",
      policy: "queue",
      requestedBy: base.userId,
      source: {
        kind: "trigger",
        occurrenceId: (await tick(f, base, nightly)).occurrence.id,
      },
      threadId: light.anchorThreadId,
    });
    await finish(f, other.run!, "completed");
    const retried = await wake(f, light, (await tick(f, base, light)).occurrence.id, "activity-3");
    expect(wakeText(retried).join("\n")).toContain(`"Voice": taskId ${voice.id}, 2 new messages`);

    // A published report is readable before any Run consumes it.
    await finish(f, retried.run!, "completed");
    const reported = await thread("Reported", {});
    await f.store.enqueueThreadInput({
      content: [
        {
          type: "text",
          text: "The ferry is booked",
        },
      ],
      idempotencyKey: "activity-report",
      policy: "report",
      requestedBy: base.userId,
      source: {
        kind: "human",
      },
      threadId: reported.id,
    });
    const after = await wake(f, light, (await tick(f, base, light)).occurrence.id, "activity-4");
    expect(wakeText(after).join("\n")).toContain(
      `"Reported": taskId ${reported.id}, 1 new messages`,
    );
  });
  it("keeps a first pass's window across a retry", async ({ storeFixture: f }) => {
    const base = await fixture(f, "first-window");
    await service(f).instance.ensureForPersonal();
    const light = (await role(f, base.userId)).trigger;
    const since = (admitted: Awaited<ReturnType<typeof wake>>) =>
      Date.parse(/(\S+Z), as this is your first pass/.exec(wakeText(admitted).join("\n"))![1]!);
    const first = await wake(f, light, (await tick(f, base, light)).occurrence.id, "first-1");
    await finish(f, first.run!, "failed");
    // The retry comes hours later; its window still starts where the first wake's did.
    await sql`update messages set created_at = created_at - interval '3 hours'
      where thread_id = ${light.anchorThreadId}`.execute(f.database);
    const retry = await wake(f, light, (await tick(f, base, light)).occurrence.id, "first-2");
    expect(since(retry)).toBeLessThanOrEqual(since(first) - 3 * 60 * 60 * 1000 + 1_000);
  });
  it("replays an accepted pass's wake without choosing its model again", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "accepted-replay");
    const s = service(f);
    await s.instance.ensureForPersonal();
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

    // This retry reads the person's settings only after the other retry's pass commits.
    const read = f.store.getAgentHomeSettings.bind(f.store);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const held = vi
      .spyOn(f.store, "getAgentHomeSettings")
      .mockImplementationOnce(async (userId) => {
        await released;
        return read(userId);
      });
    const retry = s.instance.admissionSelection(occurrence.id, worker);
    await vi.waitFor(() => expect(held).toHaveBeenCalled(), {
      timeout: 5_000,
    });
    const accepted = await wake(f, light.trigger, occurrence.id, "accepted");
    const committed = await durable();
    expect(committed.runs).toEqual([
      {
        id: accepted.run!.id,
      },
    ]);
    // Nothing is usable any more, but this occurrence's pass is already decided.
    await writeAgentHomeSettings(f.database, {
      backgroundModels: { excludedAccounts: [claude.id] },
    });
    release();
    await expect(retry).resolves.toBeUndefined();
    held.mockRestore();
    const assertReplays = async () => {
      expect((await role(f, base.userId)).trigger.waitingReason).toBeNull();
      await expect(s.instance.admissionSelection(occurrence.id, worker)).resolves.toBeUndefined();
      const replayed = await wake(f, light.trigger, occurrence.id, "accepted", null);
      expect(replayed).toMatchObject({
        wasDuplicate: true,
        message: {
          id: accepted.message.id,
        },
      });
      expect(await durable()).toEqual(committed);
    };
    await assertReplays();

    // A failed pass stays that occurrence's pass: its wake never starts another.
    await f.database
      .updateTable("runs")
      .set({
        status: "failed",
        completedAt: new Date(),
      })
      .where("id", "=", accepted.run!.id)
      .execute();
    await assertReplays();
  });
  it("settles a retry's waiting decision behind an admission still in flight", async ({
    storeFixture: f,
  }) => {
    const base = await fixture(f, "in-flight");
    const s = service(f);
    await s.instance.ensureForPersonal();
    const light = await role(f, base.userId);
    const { occurrence } = await tick(f, base, light.trigger);
    await writeAgentHomeSettings(f.database, {
      backgroundModels: { excludedAccounts: [base.harnessInstance.id] },
    });
    // Admission holds the occurrence until the personal mutation fence is released.
    await holdingRow(f, "syncFence", "personal", async (release) => {
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
    await s.instance.ensureForPersonal();
    const light = await role(f, base.userId);
    const { occurrence } = await tick(f, base, light.trigger);
    await writeAgentHomeSettings(f.database, {
      backgroundModels: { excludedAccounts: [base.harnessInstance.id] },
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
    await s.instance.ensureForPersonal();
    const light = await role(f, base.userId);
    const worker = light.anchorThread!;
    const { occurrence } = await tick(f, base, light.trigger);
    const { account: claude, catalog } = await claudeAccount(f, base);
    const moveEndpoint = async (baseUrl: string) => {
      const moved = await f.store.updateHarnessInstance({
        id: claude.id,
        config: {
          baseUrl,
        },
      });
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
      const refused = expect(change).rejects.toMatchObject({
        code: "conflict",
        retryable: true,
      });
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
    const base = await fixture(f, "resolution", {
      light: false,
    });
    const { account: claude } = await claudeAccount(f, base);
    // The remembered model retains the person's explicit options.
    const chatModel = ModelSelectionSchema.parse({
      providerId: "openai",
      modelId: base.thread.modelSelection.modelId,
      options: {},
    });
    await f.database
      .updateTable("threads")
      .set({
        modelSelection: sql`${JSON.stringify(chatModel)}::jsonb`,
      })
      .where("id", "=", base.thread.id)
      .execute();
    const s = service(f);
    const onChanged = vi.fn();
    const instance = new MemoryPassService({
      store: f.store,
      runners: s.runners,
      readAgentInstructions: s.preview,
      onChanged,
      onError: vi.fn(),
    });
    await instance.ensureForPersonal();
    const light = await role(f, base.userId);
    const nightly = await role(f, base.userId, "memory-nightly");
    const exclude = (...excludedAccounts: HarnessInstanceId[]) =>
      writeAgentHomeSettings(f.database, { backgroundModels: { excludedAccounts } });

    // The Trigger's creator, personal owner, is the principal. Light has no remembered
    // fallback: with Claude excluded by them, it waits.
    await exclude(claude.id);
    const lightTick = await tick(f, base, light.trigger);
    await expect(
      instance.admissionSelection(lightTick.occurrence.id, light.anchorThread!),
    ).rejects.toThrow(MANAGED_MEMORY_WAKE_SKIPPED);
    expect(onChanged).toHaveBeenCalledWith();
    expect((await role(f, base.userId)).trigger).toMatchObject({
      status: "active",
      pauseReason: null,
      waitingReason: memoryPassWaitingReason,
    });
    expect(
      (
        await f.triggers.listForOwner({
          reader: personTaskReader,
          ownerId: base.userId,
          systemRole: "memory-light",
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
          options: {
            effort: "high",
          },
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

    // Nightly ranks no usable deep model here, so it ends with the remembered model.
    const nightlyTick = await tick(f, base, nightly.trigger);
    expect(
      await instance.admissionSelection(nightlyTick.occurrence.id, nightly.anchorThread!),
    ).toEqual({
      harnessInstanceId: base.thread.harnessInstanceId,
      harnessRevision: base.harnessInstance.runtimeRevision,
      modelSelection: chatModel,
    });
    expect((await role(f, base.userId, "memory-nightly")).trigger.waitingReason).toBeNull();
    // the remembered model is an original, never an override: excluding its account drops it.
    await exclude(base.thread.harnessInstanceId);
    await expect(
      instance.admissionSelection(nightlyTick.occurrence.id, nightly.anchorThread!),
    ).rejects.toThrow(MANAGED_MEMORY_WAKE_SKIPPED);
    expect((await role(f, base.userId, "memory-nightly")).trigger.waitingReason).toBe(
      memoryPassWaitingReason,
    );
    await exclude();
    // A person's deep list comes before the recommended order and the remembered choice.
    await writeAgentHomeSettings(f.database, {
      backgroundModels: {
        deep: [
          {
            engine: HarnessIdSchema.parse("claude"),
            model: ModelSelectionSchema.shape.modelId.parse("claude-haiku-5-5"),
          },
        ],
      },
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
    await writeAgentHomeSettings(f.database, {});

    // Memory turned off stays off while models come and go.
    await f.database
      .updateTable("triggers")
      .set({
        pauseReason: "Memory is off at your request.",
        status: "paused",
        nextFireAt: null,
      })
      .where("id", "=", nightly.trigger.id)
      .execute();
    await f.store.recordHarnessCatalogs({
      environmentId: base.environmentId,
      expectedRevisions: new Map([[base.harnessInstance.id, base.harnessInstance.runtimeRevision]]),
      catalogs: [
        {
          ...base.catalog,
          models: [],
        },
      ],
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
