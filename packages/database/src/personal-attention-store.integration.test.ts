import { createId } from "@opensteer/core";
import { sql } from "kysely";
import { expect, test } from "vitest";
import {
  readAttentionKeys,
  requireFreshPersonalAttention,
  refreshLatestRunCompletion,
  settleExpiredPersonalAttention,
  refreshTeamAskAttention,
  updateAttentionLinkContribution,
} from "./personal-attention-store.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { createPersonalStateFixture } from "./personal-state.test-support.js";
import { withPersonalSyncRead } from "./personal-sync-store.js";

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
    const flip = (state: "active" | "revoked") =>
      commitPersonalMutation(database, async (tx, mutation) => {
        const before = await tx
          .selectFrom("personalTeamLinks")
          .select(["id", "state", "approvalAttentionCount"])
          .where("teamDeploymentId", "=", teamId)
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        await tx
          .updateTable("personalTeamLinks")
          .set({ state })
          .where("id", "=", before.id)
          .execute();
        updateAttentionLinkContribution(mutation, {
          before: before.state,
          after: state,
          bucket: before.approvalAttentionCount,
        });
      });
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

    const expiredAt = new Date("2000-01-01");
    await database
      .updateTable("personalTeamRequests")
      .set({ consentExpiresAt: expiredAt })
      .where("teamDeploymentId", "=", teamId)
      .where("requestId", "=", ordinary)
      .execute();
    await database
      .updateTable("personalAttention")
      .set({ expiresAt: expiredAt })
      .where("id", "=", `team:${teamId}:${ordinary}`)
      .execute();
    await expect(
      withPersonalSyncRead(database, requireFreshPersonalAttention),
    ).rejects.toMatchObject({ code: "conflict", retryable: true });
    expect(await settleExpiredPersonalAttention(database)).toBe(1);
    await expect(
      withPersonalSyncRead(database, requireFreshPersonalAttention),
    ).resolves.toBeUndefined();
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
