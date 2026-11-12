import { HarnessIdSchema, UserIdSchema, type RunId } from "@opensteer/core";
import type { PersonalRunFixturePort } from "./store.integration.test-support.js";
import {
  testModelSelection,
  testContinuationIdentity,
  testReadyHarnessCatalog,
  pendingEvent,
} from "./store.integration.test-support.js";
import type { OpensteerStore } from "./store.js";

export function createPersonalRunFixturePort(store: OpensteerStore): PersonalRunFixturePort {
  return {
    async createTask(input) {
      const ownerId = UserIdSchema.parse(input.ownerId);
      const environment = await store.database
        .selectFrom("executionEnvironments")
        .select("id")
        .where("runnerId", "=", input.folder.computerId)
        .executeTakeFirstOrThrow();
      const harnessInstance = await store.createHarnessInstance({
        config: {},
        driverKind: HarnessIdSchema.parse("native"),
        environmentId: environment.id,
        name: `Fixture ${input.suffix}`,
        stateKind: "isolated",
      });
      await store.recordHarnessCatalogs({
        environmentId: environment.id,
        catalogs: [testReadyHarnessCatalog(harnessInstance.id)],
        expectedRevisions: new Map([[harnessInstance.id, harnessInstance.runtimeRevision]]),
      });
      const { thread } = await store.createThread({
        createdBy: ownerId,
        folder: input.folder,
        environmentId: environment.id,
        harnessInstanceId: harnessInstance.id,
        modelSelection: testModelSelection,
        idempotencyKey: `fixture:${input.suffix}`,
        title: `Task ${input.suffix}`,
      });
      return { threadId: thread.id, thread, harnessInstance };
    },
    async startTask(threadId, text) {
      const owner = await store.database
        .selectFrom("personalSettings")
        .select("ownerId")
        .executeTakeFirstOrThrow();
      const thread = await store.getThreadForOwner(threadId, owner.ownerId);
      if (!thread) throw new Error("Fixture task is missing");
      const queued = await store.enqueueThreadInput({
        requestedBy: thread.createdBy,
        threadId,
        content: [{ type: "text", text }],
        source: { kind: "human" },
        policy: "queue",
        idempotencyKey: `fixture-start:${threadId}`,
      });
      if (!queued.run || !queued.command) throw new Error("Fixture task was not queued");
      const turn = { ...queued, run: queued.run, command: queued.command };
      return { ...(await startPersonalQueuedRunFixture(store, turn.run.id)), turn };
    },
  };
}

export async function startPersonalQueuedRunFixture(store: OpensteerStore, runId: RunId) {
  const queued = await store.database
    .selectFrom("runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  const thread = await store.getThreadForOwner(queued.threadId, queued.requestedBy);
  if (!thread) throw new Error("Fixture task is missing");
  const environment = await store.getEnvironment(thread.environmentId);
  if (!environment?.runnerId) throw new Error("Fixture task has no hosting computer");
  const command = await store.database
    .selectFrom("commands")
    .select("id")
    .where("runId", "=", runId)
    .where("type", "=", "run.execute")
    .executeTakeFirstOrThrow();
  await store.claimCommand(command.id, `fixture-dispatch:${runId}`);
  const runnerBootId = "fixture-boot";
  const binding = await store.acquireExecutionBinding({
    bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
    continuationIdentity: testContinuationIdentity,
    harnessInstanceId: thread.harnessInstanceId,
    leaseTokenHash: crypto.randomUUID(),
    runnerBootId,
    runnerId: environment.runnerId,
    runId,
    threadId: thread.id,
  });
  await store.bindProviderSession({
    bindingGeneration: binding.bindingGeneration,
    harnessInstanceId: thread.harnessInstanceId,
    providerSessionId: binding.providerSessionId,
    providerSessionReference: `fixture:${thread.id}`,
    runId,
    runnerBootId,
    runnerId: environment.runnerId,
    threadId: thread.id,
  });
  await store.commitRunnerEvent({
    environmentId: thread.environmentId,
    runnerId: environment.runnerId,
    runnerBootId,
    event: pendingEvent({
      type: "run.started",
      environmentId: thread.environmentId,
      bindingGeneration: binding.bindingGeneration,
      ordinal: 0,
      runId,
      threadId: thread.id,
      data: { status: "running" },
    }),
  });
  const run = (await import("./thread-row-mappers.js")).runFromRow(
    await store.database
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", runId)
      .executeTakeFirstOrThrow(),
  );
  if (!run) throw new Error("Fixture Run is missing");
  return { runId: run.id, run, bindingGeneration: binding.bindingGeneration, runnerBootId };
}

const fixtureOwners = new WeakMap<
  import("kysely").Kysely<import("./schema.js").DatabaseSchema>,
  Promise<
    Awaited<ReturnType<typeof import("./personal-fixture.test-support.js").seedPersonalFixture>>
  >
>();
export function personalFixtureOwner(
  database: import("kysely").Kysely<import("./schema.js").DatabaseSchema>,
  databaseUrl: string,
) {
  let owner = fixtureOwners.get(database);
  if (!owner) {
    owner = (async () => {
      const { mkdtemp, realpath, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { ownTestDatabaseProducer } = await import("./test-database.test-support.js");
      const { seedPersonalFixture } = await import("./personal-fixture.test-support.js");
      const directory = await realpath(await mkdtemp(join(tmpdir(), "opensteer-personal-owner-")));
      await ownTestDatabaseProducer(databaseUrl, async () => ({
        close: () => rm(directory, { recursive: true, force: true }),
      }));
      const personal = await seedPersonalFixture(database, directory);
      return personal;
    })();
    fixtureOwners.set(database, owner);
  }
  return owner;
}
