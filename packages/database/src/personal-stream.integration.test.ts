import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createId,
  HarnessIdSchema,
  ModelSelectionSchema,
  SequenceSchema,
  type AgentEvent,
} from "@opensteer/core";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import {
  appendHostDeploymentEvent,
  deploymentEventsAfter,
  deploymentHead,
} from "./deployment-events.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { cloneTestDatabase } from "./test-database.test-support.js";

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "opensteer-personal-stream-")));
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url, maxConnections: 4 });
  try {
    const personal = await seedPersonalFixture(database, directory);
    const { id: principalId } = await database
      .selectFrom("principals")
      .select("id")
      .where("userId", "=", personal.userId)
      .executeTakeFirstOrThrow();
    const harnessInstanceId = createId("harnessInstance");
    const threadId = createId("thread");
    await database
      .insertInto("harnessInstances")
      .values({
        id: harnessInstanceId,
        environmentId: personal.environmentId,
        driverKind: HarnessIdSchema.parse("native"),
        name: "Fixture",
        config: {},
        runtimeRevision: 1,
        stateKind: "ambient",
        enabled: true,
        isDefault: true,
        sourceId: "native",
        removedAt: null,
      })
      .execute();
    await database
      .insertInto("threads")
      .values({
        id: threadId,
        lineageRootThreadId: threadId,
        parentThreadId: null,
        purpose: "task",
        folderComputerId: personal.runnerId,
        folderPath: directory,
        teamId: null,
        channelId: null,
        threadRootId: null,
        listed: true,
        title: "Task",
        icon: null,
        iconSource: "chosen",
        color: "blue",
        environmentId: personal.environmentId,
        harnessInstanceId,
        modelSelection: ModelSelectionSchema.parse({
          providerId: "openai",
          modelId: "fixture",
          options: {},
        }),
        status: "idle",
        createdBy: personal.userId,
        createdByPrincipalId: principalId,
      })
      .execute();
    return {
      ...personal,
      database,
      directory,
      threadId,
      event: {
        type: "thread.input-queue-updated",
        environmentId: personal.environmentId,
        threadId,
        runId: null,
        data: { paused: false },
      } as const,
      close: async () => {
        await database.destroy();
        await clone.drop();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await database.destroy();
    await clone.drop();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

it("orders the Deployment stream transactionally and resumes without rollback gaps", async () => {
  const f = await fixture();
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let first: Promise<AgentEvent> | undefined;
  let second: Promise<AgentEvent> | undefined;
  try {
    first = withPersonalTransaction(f.database, async (tx) => {
      const event = await appendHostDeploymentEvent(tx, f.event);
      ready.resolve();
      await withTimeout(release.promise, 5_000, {
        timeoutError: () => new Error("The first event transaction was never released"),
      });
      return event;
    });
    await withTimeout(ready.promise, 5_000, {
      timeoutError: () => new Error("The first event never acquired the Deployment fence"),
    });
    second = withPersonalTransaction(f.database, (tx) =>
      appendHostDeploymentEvent(tx, { ...f.event, data: { paused: true } }),
    );
    expect(await deploymentHead(f.database)).toBe("0");
    release.resolve();
    const committed = await Promise.all([first, second]);
    expect(committed.map((event) => event.sequence)).toEqual(["1", "2"]);
    await expect(
      withPersonalTransaction(f.database, async (tx) => {
        await appendHostDeploymentEvent(tx, f.event);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const third = await withPersonalTransaction(f.database, (tx) =>
      appendHostDeploymentEvent(tx, f.event),
    );
    expect(third.sequence).toBe("3");
    const page = await deploymentEventsAfter(f.database, {
      deploymentId: f.deploymentId,
      afterSequence: SequenceSchema.parse("0"),
      maxItems: 1,
    });
    expect(page).toMatchObject({ resync: false, throughSequence: "1", hasMore: true });
    const resumed = await deploymentEventsAfter(f.database, {
      deploymentId: f.deploymentId,
      afterSequence: page.throughSequence,
    });
    expect(resumed.events.map((event) => event.sequence)).toEqual(["2", "3"]);
    expect(
      await deploymentEventsAfter(f.database, {
        deploymentId: createId("deployment"),
        afterSequence: SequenceSchema.parse("0"),
      }),
    ).toMatchObject({ resync: true, events: [] });
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
    await f.close();
  }
});
