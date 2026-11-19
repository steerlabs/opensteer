import { createId } from "@opensteer/core";
import { sql } from "kysely";
import { expect, test } from "vitest";
import {
  readAttentionKeys,
  refreshLatestRunCompletion,
  refreshTeamAskAttention,
} from "./personal-attention-store.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { createPersonalStateFixture } from "./personal-state.test-support.js";
import { buildPersonalShellSnapshot } from "./personal-snapshot-store.js";
import { PersonalTeamLinksStore } from "./personal-team-links-store.js";
import { setExecutionClock } from "./personal-transaction.js";
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

    // PostgreSQL says the ask is due; this Host's clock runs an hour behind it.
    const dueOnDatabase = sql<Date>`clock_timestamp() - interval '1 second'`;
    await database
      .updateTable("personalTeamRequests")
      .set({ consentExpiresAt: dueOnDatabase })
      .where("teamDeploymentId", "=", teamId)
      .where("requestId", "=", ordinary)
      .execute();
    await database
      .updateTable("personalAttention")
      .set({ expiresAt: dueOnDatabase })
      .where("id", "=", `team:${teamId}:${ordinary}`)
      .execute();
    setExecutionClock(database, () => Date.now() - 3_600_000);
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
