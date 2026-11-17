import { expect, it } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { createDatabase } from "./connection.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { buildPersonalShellSnapshot } from "./personal-snapshot-store.js";
import { readPersonalScopeCut, withPersonalSyncRead } from "./personal-sync-store.js";
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
    reading = withPersonalSyncRead(database, async (tx) => {
      const before = await tx
        .selectFrom("clientSyncState")
        .select("sequence")
        .executeTakeFirstOrThrow();
      pinned.resolve();
      await withTimeout(written.promise, 2000, {
        timeoutError: () => new Error("Writer never held the Deployment fence"),
      });
      const page = await readPersonalScopeCut(tx, {
        viewerId: personal.userId,
        scope: { kind: "shell" },
        snapshot: (read, state) => buildPersonalShellSnapshot(read, state, personal.userId),
      });
      if (page.kind !== "snapshot") throw new Error("Expected a shell snapshot");
      const after = await tx
        .selectFrom("clientSyncState")
        .select("sequence")
        .executeTakeFirstOrThrow();
      expect(after).toEqual(before);
      expect(page.state.sequence).toBe(before.sequence);
      return { tasks: page.snapshot.tasks, needsYou: page.snapshot.attention };
    });
    void reading.catch(() => undefined);
    await withTimeout(pinned.promise, 2000, {
      timeoutError: () => new Error("Reader never captured its snapshot"),
    });
    writing = commitPersonalMutation(database, async (_tx, mutation) => {
      mutation.bumpResource("settings");
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
