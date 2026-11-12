import { expect, it } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { createDatabase } from "./connection.js";
import { NotificationStateStore } from "./notification-state.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { withPersonalTransaction } from "./personal-transaction.js";
import { deploymentSnapshot } from "./snapshot-store.js";
import { cloneTestDatabase, ownTestDatabaseProducer } from "./test-database.test-support.js";

it("reads a consistent personal page while a writer holds the Deployment fence", async () => {
  const clone = await cloneTestDatabase("host");
  const releaseWriter = Promise.withResolvers<void>();
  let reading: Promise<unknown> | undefined;
  let writing: Promise<unknown> | undefined;
  try {
    const { database } = await ownTestDatabaseProducer(clone.url, async () => {
      const database = createDatabase({ connectionString: clone.url });
      return { database, close: () => database.destroy() };
    });
    const personal = await seedPersonalFixture(database, "/tmp/personal-page-fixture");
    const pinned = Promise.withResolvers<void>();
    const written = Promise.withResolvers<void>();
    reading = database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (tx) => {
        const before = await tx
          .selectFrom("deploymentEventState")
          .select("sequence")
          .executeTakeFirstOrThrow();
        pinned.resolve();
        await withTimeout(written.promise, 2000, {
          timeoutError: () => new Error("Writer never held the Deployment fence"),
        });
        const page = await deploymentSnapshot(tx, new NotificationStateStore(database), {
          viewerId: personal.userId,
          readResources: async () => ({
            appTabs: [],
            browser: {
              available: false,
              groups: { rows: [], complete: true },
              tabs: [],
              profiles: [],
              placements: [],
            },
          }),
        });
        const after = await tx
          .selectFrom("deploymentEventState")
          .select("sequence")
          .executeTakeFirstOrThrow();
        expect(after).toEqual(before);
        expect(page.sequence).toBe(before.sequence);
        return { tasks: page.tasks.recent.tasks, needsYou: page.needsYou.entries };
      });
    void reading.catch(() => undefined);
    await withTimeout(pinned.promise, 2000, {
      timeoutError: () => new Error("Reader never captured its snapshot"),
    });
    writing = withPersonalTransaction(database, async (tx) => {
      await tx.updateTable("deploymentEventState").set({ sequence: "1" }).execute();
      written.resolve();
      await withTimeout(releaseWriter.promise, 4000, {
        timeoutError: () => new Error("Writer was never released"),
      });
    });
    void writing.catch(() => undefined);
    await expect(
      withTimeout(reading, 2000, {
        timeoutError: () => new Error("A pure page read waited on the Deployment mutation fence"),
      }),
    ).resolves.toEqual({ tasks: [], needsYou: [] });
  } finally {
    releaseWriter.resolve();
    try {
      await writing;
    } finally {
      await reading?.catch(() => undefined);
      await clone.drop();
    }
  }
});
