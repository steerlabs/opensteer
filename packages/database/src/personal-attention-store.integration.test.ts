import { expect, test } from "vitest";
import { sql } from "kysely";
import { createId } from "@opensteer/core";
import { refreshLatestRunCompletion, unreadTaskSql } from "./personal-attention-store.js";
import { applyStoppedRunsNotNews } from "./personal-state-schema.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { createPersonalStateFixture } from "./personal-state.test-support.js";

test("clearing an already-read completion stamps a head even when the unread count stays zero", async () => {
  const fixture = await createPersonalStateFixture("read-completion-cleared");
  const { database, run } = fixture;
  try {
    const prior = new Date("2000-01-01");
    await database
      .updateTable("threads")
      .set({ latestRunCompletedAt: prior })
      .where("id", "=", run.threadId)
      .execute();
    await database
      .insertInto("threadVisits")
      .values({
        threadId: run.threadId,
        userId: run.userId,
        lastVisitedAt: new Date("2000-01-02"),
        updatedAt: new Date(),
      })
      .execute();
    await commitPersonalMutation(database, (tx, mutation) =>
      refreshLatestRunCompletion(tx, mutation, run.threadId, 0),
    );
    const head = await database
      .selectFrom("clientSyncState")
      .select(["sequence", "unreadTaskCount"])
      .executeTakeFirstOrThrow();
    const thread = await database
      .selectFrom("threads")
      .select(["revision", "latestRunCompletedAt"])
      .where("id", "=", run.threadId)
      .executeTakeFirstOrThrow();
    expect(head.unreadTaskCount).toBe(0);
    expect(thread).toEqual({ revision: head.sequence, latestRunCompletedAt: null });
    expect(
      await database
        .selectFrom("clientChanges")
        .select("scopeKey")
        .where("sequence", "=", head.sequence)
        .orderBy("scopeKey")
        .execute(),
    ).toEqual([{ scopeKey: "shell" }, { scopeKey: `thread:${run.threadId}` }]);
  } finally {
    await fixture.close();
  }
});

test("a Run its owner stopped is never news; one the Host ended is", async () => {
  const fixture = await createPersonalStateFixture("stopped-not-news");
  const { database, run } = fixture;
  try {
    const ended = new Date("2000-01-03");
    await database
      .updateTable("runs")
      .set({ status: "interrupted", startedAt: new Date("2000-01-01"), completedAt: ended })
      .where("id", "=", run.runId)
      .execute();
    // The owner last looked before the Run ended, so news would make it unread.
    await database
      .insertInto("threadVisits")
      .values({
        threadId: run.threadId,
        userId: run.userId,
        lastVisitedAt: new Date("2000-01-02"),
        updatedAt: new Date(),
      })
      .execute();
    const stoppedBy = async (kind: string, key = `stop:${kind}`) => {
      await sql`delete from commands where run_id=${run.runId} and type='run.interrupt'`.execute(
        database,
      );
      await sql`insert into commands(id,environment_id,thread_id,run_id,requested_by,actor_principal_id,
          authority_source,idempotency_key,type,payload,status)
        select ${createId("command")},environment_id,thread_id,run_id,requested_by,actor_principal_id,
          jsonb_build_object('kind',${kind}::text),${key},'run.interrupt',
          jsonb_build_object('type','run.interrupt','runId',run_id,'threadId',thread_id),'succeeded'
        from commands where run_id=${run.runId} and type='run.execute' limit 1`.execute(database);
      await commitPersonalMutation(database, async (tx, mutation) =>
        refreshLatestRunCompletion(
          tx,
          mutation,
          run.threadId,
          Number(
            (
              await tx
                .selectFrom("threads")
                .select(unreadTaskSql.as("unread"))
                .where("id", "=", run.threadId)
                .executeTakeFirstOrThrow()
            ).unread,
          ),
        ),
      );
      return {
        news: (
          await database
            .selectFrom("threads")
            .select("latestRunCompletedAt")
            .where("id", "=", run.threadId)
            .executeTakeFirstOrThrow()
        ).latestRunCompletedAt,
        unread: (
          await database
            .selectFrom("clientSyncState")
            .select("unreadTaskCount")
            .executeTakeFirstOrThrow()
        ).unreadTaskCount,
      };
    };
    // The Host, an agent or a teammate cut it short: the owner hears of it.
    expect(await stoppedBy("request-hold")).toEqual({ news: ended, unread: 1 });
    expect(await stoppedBy("thread-agent")).toEqual({ news: ended, unread: 1 });
    expect(await stoppedBy("team-cancel")).toEqual({ news: ended, unread: 1 });
    // Ended before it started, it has nothing to show, whoever ended it.
    await database
      .updateTable("runs")
      .set({ startedAt: null })
      .where("id", "=", run.runId)
      .execute();
    expect(await stoppedBy("request-hold")).toEqual({ news: null, unread: 0 });
    await database
      .updateTable("runs")
      .set({ startedAt: new Date("2000-01-01") })
      .where("id", "=", run.runId)
      .execute();
    expect(await stoppedBy("request-hold")).toEqual({ news: ended, unread: 1 });
    // The owner pressed Stop, from this computer or another: nothing to read.
    expect(await stoppedBy("user-session")).toEqual({ news: null, unread: 0 });
    // A Run that ended by itself is news again.
    await sql`delete from commands where run_id=${run.runId} and type='run.interrupt'`.execute(
      database,
    );
    await database
      .updateTable("runs")
      .set({ status: "completed" })
      .where("id", "=", run.runId)
      .execute();
    expect(await stoppedBy("request-hold")).toEqual({ news: ended, unread: 1 });

    // A Host from before this rule labelled every Stop the person's own and stored each as news.
    // Migrating restores who stopped it from the key its writer gave, then recomputes.
    await database
      .updateTable("runs")
      .set({ status: "interrupted" })
      .where("id", "=", run.runId)
      .execute();
    const migrated = async (key: string) => {
      await stoppedBy("user-session", key);
      await database
        .updateTable("threads")
        .set({ latestRunCompletedAt: ended })
        .where("id", "=", run.threadId)
        .execute();
      await database.updateTable("clientSyncState").set({ unreadTaskCount: 1 }).execute();
      const before = await database
        .selectFrom("clientSyncState")
        .select("epoch")
        .executeTakeFirstOrThrow();
      await applyStoppedRunsNotNews(database);
      const after = await database
        .selectFrom("clientSyncState")
        .select(["epoch", "unreadTaskCount"])
        .executeTakeFirstOrThrow();
      expect(after.epoch).not.toBe(before.epoch);
      return {
        stoppedBy: (
          await database
            .selectFrom("commands")
            .select("authoritySource")
            .where("runId", "=", run.runId)
            .where("type", "=", "run.interrupt")
            .executeTakeFirstOrThrow()
        ).authoritySource,
        news: (
          await database
            .selectFrom("threads")
            .select("latestRunCompletedAt")
            .where("id", "=", run.threadId)
            .executeTakeFirstOrThrow()
        ).latestRunCompletedAt,
        unread: after.unreadTaskCount,
      };
    };
    const userId = run.userId;
    // The person's own Stop, from any client: no longer news.
    expect(await migrated("interrupt:7d0f1c2a")).toEqual({
      stoppedBy: { kind: "user-session" },
      news: null,
      unread: 0,
    });
    // A teammate withdrew their ask: still news.
    expect(await migrated("team-cancel:dep_team:req_ask")).toEqual({
      stoppedBy: { kind: "team-cancel", teamId: "dep_team", requestId: "req_ask" },
      news: ended,
      unread: 1,
    });
    // An agent stopped it, or a connection marked it Done: still news.
    expect(await migrated("run:run_agent:op_1:interrupt")).toEqual({
      stoppedBy: { kind: "thread-agent", runId: "run_agent", userId },
      news: ended,
      unread: 1,
    });
    expect(await migrated(`task-done:connection:con_1:op_2:thread.write:${run.runId}`)).toEqual({
      stoppedBy: { kind: "connection", connectionId: "con_1", userId },
      news: ended,
      unread: 1,
    });
  } finally {
    await fixture.close();
  }
});
