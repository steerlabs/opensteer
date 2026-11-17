import { createId } from "@opensteer/core";
import { sql } from "kysely";
import { expect, test } from "vitest";
import {
  readAttentionKeys,
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

    await commitPersonalMutation(database, async (tx, mutation) => {
      await tx
        .updateTable("personalTeamRequests")
        .set({ consentExpiresAt: new Date("2000-01-01") })
        .where("teamDeploymentId", "=", teamId)
        .where("requestId", "=", ordinary)
        .execute();
      await refreshTeamAskAttention(tx, mutation, teamId, ordinary);
    });
    await flip("revoked");
    await flip("active");
    expect(await fetchKinds()).toEqual(["failed-ask"]);
    expect(await fetchCount()).toEqual({ pendingRequestCount: 0, needsYouCount: 1 });
  } finally {
    await fixture.close();
  }
});
