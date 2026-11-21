import { createId } from "@opensteer/core";
import { sql } from "kysely";
import { expect, test } from "vitest";
import {
  readAttentionKeys,
  refreshLatestRunCompletion,
  refreshTeamAskAttention,
  unreadTaskSql,
} from "./personal-attention-store.js";
import { applyStoppedRunsNotNews } from "./personal-state-schema.js";
import { NotificationStateStore } from "./notification-state.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { createPersonalStateFixture } from "./personal-state.test-support.js";
import { buildPersonalShellSnapshot } from "./personal-snapshot-store.js";
import { PersonalTeamLinksStore } from "./personal-team-links-store.js";
import { authorizedSyncState, withPersonalSyncRead } from "./personal-sync-store.js";

test("parks ordinary asks by link while retaining failed asks and dropping expired consent", async () => {
  const fixture = await createPersonalStateFixture("link-bucket");
  const { database } = fixture;
  try {
    const teamId = createId("deployment");
    const ordinary = createId("teamAgentRequest");
    const failed = createId("teamAgentRequest");
    await sql`insert into personal_team_links(id,team_deployment_id,team_host_instance_id,
      host_key_fingerprint,approved_origin,authority_envelope,state)
      values(${crypto.randomUUID()},${teamId},${createId("hostInstance")},'fixture','https://team.example.invalid','{}','active')
    `.execute(database);
    await sql`insert into personal_team_requests(team_deployment_id,request_id,trigger_message_id,kind,remote_state,
      terminal_state,publication_state,presentation,consent_expires_at,blocked_reason,source)
      values(${teamId},${ordinary},1,'ask','awaiting_approval',null,'pending','{}',now()+interval '1 hour',null,'{}'),
        (${teamId},${failed},2,'ask','failed','failed','blocked','{}',now()+interval '1 hour','It could not be released','{}')
    `.execute(database);
    for (const requestId of [ordinary, failed])
      await commitPersonalMutation(database, (tx, mutation) =>
        refreshTeamAskAttention(tx, mutation, teamId, requestId),
      );

    const fetchCount = () =>
      database
        .selectFrom("clientSyncState")
        .select(["pendingRequestCount", "needsYouCount"])
        .executeTakeFirstOrThrow();
    const fetchKinds = () =>
      withPersonalSyncRead(database, async (tx) =>
        (await readAttentionKeys(tx, { limit: 10 })).map(({ kind }) => kind).toSorted(),
      );
    const links = new PersonalTeamLinksStore(database);
    const flip = (state: "active" | "revoked") => links.state(teamId, state);
    expect(await fetchCount()).toEqual({ pendingRequestCount: 0, needsYouCount: 2 });
    expect(await fetchKinds()).toEqual(["failed-ask", "team-ask"]);
    // Another computer's row reads attention; it counts Needs you as the Needs you page does.
    expect(await new NotificationStateStore(database).attention(fixture.run.userId)).toMatchObject({
      needsYou: 2,
    });
    const parked = await database
      .selectFrom("personalAttention")
      .selectAll()
      .orderBy("id")
      .execute();
    await flip("revoked");
    expect(await fetchKinds()).toEqual(["failed-ask"]);
    expect(await fetchCount()).toEqual({ pendingRequestCount: 0, needsYouCount: 1 });
    expect(
      await database.selectFrom("personalAttention").selectAll().orderBy("id").execute(),
    ).toEqual(parked);
    await flip("active");
    expect(await fetchKinds()).toEqual(["failed-ask", "team-ask"]);

    // The ask's expiry has passed and its owner has not settled it yet.
    const expired = new Date(Date.now() - 1_000);
    await database
      .updateTable("personalTeamRequests")
      .set({ consentExpiresAt: expired })
      .where("teamDeploymentId", "=", teamId)
      .where("requestId", "=", ordinary)
      .execute();
    await database
      .updateTable("personalAttention")
      .set({ expiresAt: expired })
      .where("id", "=", `team:${teamId}:${ordinary}`)
      .execute();
    // An attach never waits on the owner: it shows the ask until the owner settles it.
    expect(await fetchKinds()).toEqual(["failed-ask", "team-ask"]);
    const shell = await withPersonalSyncRead(database, async (tx) =>
      buildPersonalShellSnapshot(
        tx,
        await authorizedSyncState(tx, fixture.run.userId),
        fixture.run.userId,
      ),
    );
    expect(shell.attention.map(({ kind }) => kind).toSorted()).toEqual(["failed-ask", "team-ask"]);
    // The owner settles it: the ask leaves Needs you.
    await database
      .updateTable("personalTeamRequests")
      .set({ terminalState: "cancelled" })
      .where("teamDeploymentId", "=", teamId)
      .where("requestId", "=", ordinary)
      .execute();
    await commitPersonalMutation(database, (tx, mutation) =>
      refreshTeamAskAttention(tx, mutation, teamId, ordinary),
    );
    await flip("revoked");
    await flip("active");
    expect(await fetchKinds()).toEqual(["failed-ask"]);
    expect(await fetchCount()).toEqual({ pendingRequestCount: 0, needsYouCount: 1 });
  } finally {
    await fixture.close();
  }
});

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
    const stoppedBy = async (kind: string) => {
      await sql`delete from commands where run_id=${run.runId} and type='run.interrupt'`.execute(
        database,
      );
      await sql`insert into commands(id,environment_id,thread_id,run_id,requested_by,actor_principal_id,
          authority_source,idempotency_key,type,payload,status)
        select ${createId("command")},environment_id,thread_id,run_id,requested_by,actor_principal_id,
          jsonb_build_object('kind',${kind}::text),${`stop:${kind}`},'run.interrupt',
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

    // A Host from before this rule stored the Stop as news; migrating corrects it.
    await database
      .updateTable("runs")
      .set({ status: "interrupted" })
      .where("id", "=", run.runId)
      .execute();
    await stoppedBy("user-session");
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
    expect(
      await database
        .selectFrom("threads")
        .select("latestRunCompletedAt")
        .where("id", "=", run.threadId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ latestRunCompletedAt: null });
    const after = await database
      .selectFrom("clientSyncState")
      .select(["epoch", "unreadTaskCount"])
      .executeTakeFirstOrThrow();
    expect(after.unreadTaskCount).toBe(0);
    expect(after.epoch).not.toBe(before.epoch);
  } finally {
    await fixture.close();
  }
});
