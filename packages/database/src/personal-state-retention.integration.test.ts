import { createId } from "@opensteer/core";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { sql } from "kysely";
import { expect, test } from "vitest";
import { commitPersonalMutation, installPersonalMutationHooks } from "./personal-mutation.js";
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
    // Later commits in another scope fill the feed to its row cap, one row each.
    const fill = 4096 - (state.retainedChangeCount + 2);
    await sql`insert into client_changes(deployment_id,sequence,scope_key,ordinal,entity_kind,entity_id,operation,payload,created_at)
      select ${run.deploymentId}, n+${head}::bigint, 'node:retention-fill', 0, 'item', 'fill-'||n, 'remove', '{}', clock_timestamp()
      from generate_series(1,${fill}) n`.execute(database);
    const filled = (BigInt(head) + BigInt(fill)).toString();
    await database
      .updateTable("clientSyncState")
      .set({ sequence: filled, retainedChangeCount: 4096 })
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
    await commitPersonalMutation(database, async (_tx, mutation) => {
      mutation.change({
        scopeKey: "node:retention-fill",
        entityKind: "item",
        entityId: "tail",
        operation: "remove",
      });
    });
    pruneFinished.resolve();
    expect(await oldReplay).toMatchObject({
      kind: "replay",
      commits: [
        {
          fromSequence: state.sequence,
          throughSequence: head,
          changes: [{ entityId: "one" }, { entityId: "two" }],
        },
        { fromSequence: head, throughSequence: filled, changes: [] },
      ],
    });
    // One prune frees a whole chunk: 513 rows, rounded up to whole commits.
    const floor = (BigInt(head) + BigInt(511 - state.retainedChangeCount)).toString();
    expect(
      await readPersonalScopeCut(database, { ...read, snapshot: async () => "repaired" }),
    ).toMatchObject({
      kind: "snapshot",
      snapshot: "repaired",
      state: { prunedThroughSequence: floor, retainedChangeCount: 4096 + 1 - 513 },
    });
    const resourceHead = await commitPersonalMutation(database, async (_tx, mutation) => {
      mutation.bumpResource("settings");
      return mutation.sequence;
    });
    expect(
      await readPersonalScopeCut(database, {
        ...read,
        cursor: { ...cursor, afterSequence: floor },
      }),
    ).toMatchObject({
      kind: "replay",
      state: {
        sequence: resourceHead,
        prunedThroughSequence: floor,
        retainedChangeCount: 4096 + 1 - 513,
        resourceRevisions: { settings: resourceHead },
      },
      commits: [{ fromSequence: floor, throughSequence: resourceHead, changes: [] }],
    });
  } finally {
    pruneFinished.resolve();
    await fixture.close();
  }
});

test("a scope that exceeds its commit budget is reset and repaired by snapshot", async () => {
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
      for (let i = 0; i < 100; i++) {
        const id = createId("thread");
        mutation.change(
          {
            scopeKey: "shell",
            entityKind: "task",
            entityId: id,
            operation: "upsert",
          },
          () => {
            built++;
            return {
              id,
              title: "•",
              revision: mutation.sequence,
              status: "idle",
              purpose: "task",
              askedAt: mutation.state.now.toISOString(),
              doneAt: null,
              pendingRequestCount: 0,
              lastReplyPreview: "\u0001".repeat(1050),
              failurePreview: null,
              latestRunCompletedAt: null,
            };
          },
        );
      }
    });
    expect(built).toBeLessThan(12);
    expect(
      await database.selectFrom("clientChanges").select(["entityId", "operation"]).execute(),
    ).toEqual([{ entityId: "scope", operation: "reset" }]);
    expect(
      await readPersonalScopeCut(database, {
        viewerId: run.userId,
        scope: { kind: "shell" },
        cursor,
        snapshot: async () => "repaired",
      }),
    ).toMatchObject({ kind: "snapshot", snapshot: "repaired" });
  } finally {
    await fixture.close();
  }
});

test("retention rounds up to a complete commit and purges old scope cursors", async () => {
  const fixture = await createPersonalStateFixture("retention-rounded");
  const { database, run } = fixture;
  const removeHooks = installPersonalMutationHooks(database, {
    wake() {},
    suspend: () => ({ committed() {}, rolledBack() {} }),
    onFailure(error) {
      throw error;
    },
  });
  try {
    const initial = await database
      .selectFrom("clientSyncState")
      .selectAll()
      .executeTakeFirstOrThrow();
    await sql`insert into client_changes(deployment_id,sequence,scope_key,ordinal,entity_kind,entity_id,operation,payload,created_at)
      select ${run.deploymentId}, n+${initial.sequence}::bigint, 'shell', i, 'task', 'fixture-'||i, 'remove', '{}', clock_timestamp()
      from generate_series(1,32) n cross join generate_series(0,127) i`.execute(database);
    await database
      .updateTable("clientSyncState")
      .set({
        sequence: (BigInt(initial.sequence) + 32n).toString(),
        retainedChangeCount: 4096,
      })
      .execute();
    await commitPersonalMutation(database, async (_tx, mutation) => {
      mutation.change({
        scopeKey: "shell",
        operation: "remove",
        entityKind: "task",
        entityId: "tail",
      });
    });
    const point = await database
      .selectFrom("clientSyncState")
      .selectAll()
      .executeTakeFirstOrThrow();
    // The cut frees a 512-row chunk and rounds up to the fifth whole commit.
    expect(point.prunedThroughSequence).toBe((BigInt(initial.sequence) + 5n).toString());
    expect(point.retainedChangeCount).toBe(4096 - 5 * 128 + 1);
    const purged = await commitPersonalMutation(database, async (_tx, mutation) => {
      mutation.purge(`thread:${run.threadId}`);
      return mutation.sequence;
    });
    const read = (afterSequence: string) =>
      readPersonalScopeCut(database, {
        viewerId: run.userId,
        scope: { kind: "shell" },
        cursor: {
          deploymentId: point.deploymentId,
          viewerId: run.userId,
          epoch: point.epoch,
          scopeKey: "shell",
          afterSequence,
        },
        snapshot: async () => "repaired",
      });
    expect(await read(point.sequence)).toMatchObject({ kind: "snapshot", snapshot: "repaired" });
    expect(await read(purged)).toMatchObject({
      kind: "replay",
      state: { retainedChangeCount: 0 },
      commits: [],
    });
  } finally {
    removeHooks();
    await fixture.close();
  }
});
