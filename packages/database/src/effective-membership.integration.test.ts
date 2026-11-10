import { expect } from "vitest";
import { createId } from "@opensteer/core";
import { sql } from "kysely";
import { describeStore, testWorkspaceProfile } from "./store.integration.test-support.js";
import { effectiveMembershipPredicate } from "./effective-membership.js";

describeStore("effective membership query plans", (it) => {
  it("retains both active partial indexes with retained tombstones", async ({ storeFixture }) => {
    await storeFixture.store.ensureDeployment({
      canonicalOrigin: "https://test-host.invalid",
      hostInstanceId: createId("hostInstance"),
      deploymentShape: testWorkspaceProfile,
    });
    await storeFixture.database.transaction().execute(async (transaction) => {
      await sql`
        create table access_plan_memberships (
          id text, workspace_id text, user_id text, state text, effective_until timestamptz, role text
        );
        insert into access_plan_memberships
        select 'mem_'||project||'_'||person, 'wsp_'||project, 'usr_'||person,
          case when person <= 64 then 'active' else 'revoked' end, null, 'collaborator'
        from generate_series(1,128) project cross join generate_series(1,256) person;
        create unique index members_pair on access_plan_memberships(workspace_id,user_id);
        create index members_user_active on access_plan_memberships(user_id,workspace_id) where state='active';
        create index members_workspace_active on access_plan_memberships(workspace_id,role,user_id) where state='active';
        analyze access_plan_memberships;
      `.execute(transaction);
      for (const [column, value, index] of [
        ["user_id", "usr_1", "members_user_active"],
        ["workspace_id", "wsp_1", "members_workspace_active"],
      ] as const) {
        const selected = column === "user_id" ? "workspace_id" : "user_id";
        const baseline = await sql`explain (analyze, buffers, format json)
          select ${sql.ref(selected)} from access_plan_memberships m
          where ${sql.ref(`m.${column}`)} = ${value} and m.state = 'active'`.execute(transaction);
        const current = await sql`explain (analyze, buffers, format json)
          select ${sql.ref(selected)} from access_plan_memberships m
          where ${sql.ref(`m.${column}`)} = ${value} and ${effectiveMembershipPredicate("m")}`.execute(
          transaction,
        );
        expect(JSON.stringify(current.rows)).toContain(index);
        console.info(
          "access query plan",
          column,
          JSON.stringify({ baseline: baseline.rows, current: current.rows }),
        );
      }
      await sql`drop table access_plan_memberships`.execute(transaction);
    });
  });
});
