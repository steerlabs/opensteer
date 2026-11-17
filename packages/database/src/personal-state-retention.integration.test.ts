import { withTimeout } from "@opensteer/shared/withTimeout";
import { expect, test } from "vitest";
import { commitPersonalMutation } from "./personal-mutation.js";
import { createPersonalStateFixture } from "./personal-state.test-support.js";
import {
  authorizedSyncState,
  readPersonalScopeCut,
  withPersonalSyncRead,
} from "./personal-sync-store.js";

test("a replay cut either sees its whole commit or the new retention floor", async () => {
  const fixture = await createPersonalStateFixture("retention-cut");
  const { database, run } = fixture;
  const cutCaptured = Promise.withResolvers<void>();
  const pruneFinished = Promise.withResolvers<void>();
  try {
    const state = await database
      .selectFrom("clientSyncState")
      .selectAll()
      .executeTakeFirstOrThrow();
    const cursor = {
      afterSequence: state.sequence,
      viewerId: run.userId,
      epoch: state.epoch,
      scopeKey: "shell" as const,
      deploymentId: state.deploymentId,
    };
    const head = await commitPersonalMutation(database, async (_tx, mutation) => {
      for (const entityId of ["one", "two"])
        mutation.change({
          scopeKey: "shell",
          entityKind: "task",
          entityId,
          operation: "remove",
        });
      return mutation.sequence;
    });
    await database
      .updateTable("clientChanges")
      .set({ createdAt: new Date("2000-01-01") })
      .where("sequence", "=", head)
      .execute();
    const read = {
      viewerId: run.userId,
      scope: { kind: "shell" as const },
      cursor,
      snapshot: async () => {
        throw new Error("Expected replay");
      },
    };
    const oldReplay = withPersonalSyncRead(database, async (tx) => {
      await authorizedSyncState(tx, run.userId);
      cutCaptured.resolve();
      await withTimeout(pruneFinished.promise, 2000, {
        timeoutError: () => new Error("Retention commit did not finish"),
      });
      return readPersonalScopeCut(tx, read);
    });
    await withTimeout(cutCaptured.promise, 2000, {
      timeoutError: () => new Error("Old replay did not capture its cut"),
    });
    await commitPersonalMutation(database, async () => undefined);
    pruneFinished.resolve();
    expect(await oldReplay).toMatchObject({
      kind: "replay",
      commits: [
        {
          fromSequence: state.sequence,
          throughSequence: head,
          changes: [{ entityId: "one" }, { entityId: "two" }],
        },
      ],
    });
    expect(await readPersonalScopeCut(database, read)).toMatchObject({
      kind: "snapshot-required",
      state: { prunedThroughSequence: head, retainedChangeCount: 0 },
    });
    const resourceHead = await commitPersonalMutation(database, async (_tx, mutation) => {
      mutation.bumpResource("settings");
      return mutation.sequence;
    });
    expect(
      await readPersonalScopeCut(database, { ...read, cursor: { ...cursor, afterSequence: head } }),
    ).toMatchObject({
      kind: "replay",
      state: {
        sequence: resourceHead,
        prunedThroughSequence: head,
        retainedChangeCount: 0,
        resourceRevisions: { settings: resourceHead },
      },
      commits: [{ fromSequence: head, throughSequence: resourceHead, changes: [] }],
    });
  } finally {
    pruneFinished.resolve();
    await fixture.close();
  }
});

test("a scope that exceeds its commit budget gets one invalidation", async () => {
  const fixture = await createPersonalStateFixture("oversize-scope");
  const { database, run } = fixture;
  try {
    const state = await database
      .selectFrom("clientSyncState")
      .selectAll()
      .executeTakeFirstOrThrow();
    const cursor = {
      afterSequence: state.sequence,
      viewerId: run.userId,
      epoch: state.epoch,
      scopeKey: "shell" as const,
      deploymentId: state.deploymentId,
    };
    let built = 0;
    await commitPersonalMutation(database, async (_tx, mutation) => {
      for (let i = 0; i < 100; i++)
        mutation.change(
          {
            scopeKey: "shell",
            entityKind: "task",
            entityId: `task-${i}`,
            operation: "upsert",
          },
          () => {
            built++;
            return { title: "a".repeat(6000) };
          },
        );
    });
    expect(built).toBeLessThan(12);
    expect(
      await database.selectFrom("clientChanges").select(["entityId", "operation"]).execute(),
    ).toEqual([{ entityId: "scope", operation: "invalidate" }]);
    expect(
      await readPersonalScopeCut(database, {
        viewerId: run.userId,
        scope: { kind: "shell" },
        cursor,
        snapshot: async () => {
          throw new Error("Expected replay");
        },
      }),
    ).toMatchObject({ kind: "snapshot-required", reason: "scope-invalidated" });
  } finally {
    await fixture.close();
  }
});
