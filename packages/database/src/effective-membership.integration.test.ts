import { expect } from "vitest";
import { createId } from "@opensteer/core";
import { sql } from "kysely";
import { describeStore, testWorkspaceProfile } from "./store.integration.test-support.js";
import { effectiveMembershipPredicate, loadMembershipAuthority } from "./effective-membership.js";
import { OpensteerStore } from "./store.js";
import { requireActiveWorkspaceMembership } from "./store-primitives.js";

interface Plan {
  readonly "Node Type": string;
  readonly "Index Name"?: string;
  readonly "Heap Fetches"?: number;
  readonly "Shared Hit Blocks": number;
  readonly "Shared Read Blocks": number;
  readonly Plans?: readonly Plan[];
}
function nodes(plan: Plan): readonly Plan[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

describeStore("effective membership query plans", (it) => {
  it("emits the origin/main membership, file-admission and locked-membership SQL on model 1", async ({
    storeFixture,
  }) => {
    const fixture = await storeFixture.createRunFixture("legacy-sql-equivalence", null, "project");
    const { database } = storeFixture;
    const observed: { sql: string; parameters: readonly unknown[] }[] = [];
    const measured = database.withPlugin({
      transformQuery(args) {
        if (args.node.kind === "SelectQueryNode") {
          const query = database.getExecutor().compileQuery(args.node, args.queryId);
          observed.push({ sql: query.sql, parameters: query.parameters });
        }
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    });
    const store = await OpensteerStore.create(measured);
    expect(observed).toHaveLength(1);
    const expectOriginal = (query: { sql: string; parameters: readonly unknown[] }) => {
      expect(observed.splice(0)).toEqual([{ sql: query.sql, parameters: query.parameters }]);
    };
    observed.length = 0;
    await store.workspaceMembershipForUser(fixture.workspace.id, fixture.userId);
    expectOriginal(
      database
        .selectFrom("workspaceMemberships")
        .select([
          "generation",
          "id",
          "invitedBy",
          "joinedAt",
          "role",
          "state",
          "userId",
          "workspaceId",
        ])
        .where("workspaceId", "=", fixture.workspace.id)
        .where("userId", "=", fixture.userId)
        .compile(),
    );
    await store.admitWorkspaceFiles(fixture.workspace.id, fixture.userId);
    expectOriginal(
      database
        .selectFrom("workspaces")
        .innerJoin("workspaceMemberships", "workspaceMemberships.workspaceId", "workspaces.id")
        .selectAll("workspaces")
        .select("workspaceMemberships.generation as membershipGeneration")
        .where("workspaces.id", "=", fixture.workspace.id)
        .where("workspaceMemberships.userId", "=", fixture.userId)
        .where("workspaceMemberships.state", "=", "active")
        .compile(),
    );
    for (const lock of [false, true]) {
      await measured
        .transaction()
        .execute((transaction) =>
          requireActiveWorkspaceMembership(transaction, fixture.workspace.id, fixture.userId, lock),
        );
      let original = database
        .selectFrom("workspaceMemberships")
        .select(["role", "state", "generation"])
        .where("workspaceId", "=", fixture.workspace.id)
        .where("userId", "=", fixture.userId);
      if (lock) original = original.forNoKeyUpdate();
      expectOriginal(original.compile());
    }
  });
  for (const version of [1, 2] as const)
    it(`keeps covering hot reads on authority model ${version}`, async ({ storeFixture }) => {
      const { database, store } = storeFixture;
      await store.ensureDeployment({
        canonicalOrigin: "https://test-host.invalid",
        hostInstanceId: createId("hostInstance"),
        deploymentShape: testWorkspaceProfile,
      });
      await database.updateTable("deployments").set({ authorityModelVersion: version }).execute();
      await loadMembershipAuthority(database);
      await sql`
      create table access_plan_memberships (id text, workspace_id text, user_id text, state text, effective_until timestamptz, role text);
      insert into access_plan_memberships
      select 'mem_'||project||'_'||person, 'wsp_'||project, 'usr_plan_'||person,
        case when person <= 64 then 'active' else 'revoked' end, null, 'collaborator'
      from generate_series(1,128) project cross join generate_series(1,256) person;
      insert into users(id, display_name, email, admitted_at)
        select 'usr_plan_'||person, 'Plan', 'plan_'||person||'@test.invalid', clock_timestamp() from generate_series(1,256) person;
    `.execute(database);
      const indexes = await sql<{
        definition: string;
      }>`select pg_get_indexdef(indexrelid) as definition from pg_index
      where indrelid = 'workspace_memberships'::regclass and indexrelid::regclass::text in (
        'workspace_memberships_user_active', 'workspace_memberships_workspace_active',
        'workspace_memberships_user_effective', 'workspace_memberships_workspace_effective')`.execute(
        database,
      );
      expect(indexes.rows).toHaveLength(2);
      for (const index of indexes.rows)
        await sql
          .raw(index.definition.replaceAll("workspace_memberships", "access_plan_memberships"))
          .execute(database);
      await sql`vacuum analyze access_plan_memberships`.execute(database);
      await sql`vacuum analyze users`.execute(database);
      for (const [column, value, suffix] of [
        ["user_id", "usr_plan_1", "user"],
        ["workspace_id", "wsp_1", "workspace"],
      ] as const) {
        const selected = column === "user_id" ? "workspace_id" : "user_id";
        const query = (predicate: ReturnType<typeof effectiveMembershipPredicate>) => sql`
        select ${sql.ref(selected)} from access_plan_memberships m where ${sql.ref(`m.${column}`)} = ${value} and ${predicate}`;
        const baseline = query(sql<boolean>`${sql.raw("m.state")} = 'active'`);
        const current = query(effectiveMembershipPredicate(database, "m.state", true));
        if (version === 1) expect(current.compile(database)).toEqual(baseline.compile(database));
        expect((await current.execute(database)).rows).toEqual(
          (await baseline.execute(database)).rows,
        );
        const explain = async (statement: typeof current) => {
          const result = await sql<{
            "QUERY PLAN": readonly { Plan: Plan }[];
          }>`explain (analyze, buffers, format json) ${statement}`.execute(database);
          return result.rows[0]!["QUERY PLAN"][0]!.Plan;
        };
        const original = await explain(baseline),
          plan = await explain(current);
        if (version === 1) {
          await sql`create or replace function public.opensteer_membership_is_effective(membership_state text, deadline timestamptz, member_id text)
          returns boolean language plpgsql volatile parallel safe as $$ begin raise exception 'Legacy guard evaluated per row'; end $$`.execute(
            database,
          );
          const guarded =
            query(sql<boolean>`(m.state = 'active' and ((m.effective_until is null and not (select exists (
          select 1 from public.deployments where authority_model_version = 2 and deployment_shape->>'kind' = 'server')))
          or public.opensteer_membership_is_effective(m.state, m.effective_until, m.user_id)))`);
          const guardPlan = await explain(guarded);
          expect(nodes(guardPlan)).toContainEqual(
            expect.objectContaining({
              "Node Type": "Index Only Scan",
              "Index Name": `access_plan_memberships_${suffix}_active`,
              "Heap Fetches": 0,
            }),
          );
          expect(
            guardPlan["Shared Hit Blocks"] + guardPlan["Shared Read Blocks"],
          ).toBeLessThanOrEqual(5);
          console.info("access legacy SQL guard plan", JSON.stringify(guardPlan));
        }
        const expectedIndex = `access_plan_memberships_${suffix}_active`;
        expect(nodes(plan)).toContainEqual(
          expect.objectContaining({
            "Node Type": "Index Only Scan",
            "Index Name": expectedIndex,
            "Heap Fetches": 0,
          }),
        );
        expect(plan["Shared Hit Blocks"] + plan["Shared Read Blocks"]).toBeLessThanOrEqual(
          version === 1 ? 4 : 10,
        );
        expect(
          nodes(plan).some(
            (node) => "Relation Name" in node && node["Relation Name"] === "deployments",
          ),
        ).toBe(false);
        if (version === 1)
          expect(plan["Shared Hit Blocks"] + plan["Shared Read Blocks"]).toBe(
            original["Shared Hit Blocks"] + original["Shared Read Blocks"],
          );
        console.info(
          "access covering plan",
          JSON.stringify({ version, column, baseline: original, current: plan }),
        );
      }
    });
});
