import { createId } from "@opensteer/core";
import { sql } from "kysely";
import { expect } from "vitest";
import { describeStore } from "./store.integration.test-support.js";
import { AccountDirectoryStore } from "./account-directory-store.js";
import { loadMembershipAuthority } from "./effective-membership.js";

describeStore("effective SQL authority", (it) => {
  for (const [name, message] of [
    ["opensteer_enforce_run_execution_authority", "run requester cannot execute"],
    ["opensteer_enforce_thread_execution_authority", "thread creator must be an active"],
    ["opensteer_enforce_command_execution_authority", "command requester cannot execute"],
  ] as const)
    it(`fences expired authority in ${name}`, async ({ storeFixture }) => {
      const fixture = await storeFixture.createRunFixture(name, null, "project");
      const database = storeFixture.database;
      await database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
      await database
        .updateTable("users")
        .set({ admittedAt: new Date() })
        .where("id", "=", fixture.userId)
        .execute();
      const probe = () =>
        database.transaction().execute(async (transaction) => {
          await sql`create temporary table authority_probe (
        thread_id text, environment_id text, harness_instance_id text, requested_by text,
        membership_generation bigint, workspace_id text, created_by text, type text, run_id text
      ) on commit drop`.execute(transaction);
          await sql
            .raw(
              `create trigger authority_probe_guard before insert on authority_probe for each row execute function public.${name}()`,
            )
            .execute(transaction);
          await sql`insert into authority_probe values (${fixture.thread.id}, ${fixture.environmentId}, ${fixture.harnessInstance.id},
        ${fixture.userId}, 1, ${fixture.workspace.id}, ${fixture.userId}, 'run.execute', null)`.execute(
            transaction,
          );
        });
      await probe();
      await database
        .updateTable("workspaceMemberships")
        .set({ effectiveUntil: new Date("2020-01-01") })
        .where("workspaceId", "=", fixture.workspace.id)
        .execute();
      await expect(probe()).rejects.toThrow(message);
      const result = await sql<{
        allowed: boolean;
      }>`select opensteer_user_can_execute_thread(${fixture.thread.id}, ${fixture.userId}) as allowed`.execute(
        database,
      );
      expect(result.rows[0]!.allowed).toBe(false);
    });

  it("keeps intrinsic owner constraints on version 1 and Personal and does not resurrect retired profiles", async ({
    storeFixture,
  }) => {
    const fixture = await storeFixture.createRunFixture("owner-invariant", null, "project");
    const database = storeFixture.database;
    expect(
      (
        await sql`select to_regprocedure('public.opensteer_enforce_thread_capability_profile()') as profile`.execute(
          database,
        )
      ).rows,
    ).toEqual([{ profile: null }]);
    await database
      .updateTable("workspaceMemberships")
      .set({ effectiveUntil: new Date("2020-01-01") })
      .where("workspaceId", "=", fixture.workspace.id)
      .execute();
    for (const kind of ["server", "personal"] as const) {
      await database
        .updateTable("deployments")
        .set({
          deploymentShape: { kind, defaultWorkspaceBacking: "local-directory" },
        })
        .execute();
      await expect(
        database
          .updateTable("workspaceMemberships")
          .set({
            state: "revoked",
            revokedAt: new Date(),
            revokedBy: fixture.userId,
          })
          .where("workspaceId", "=", fixture.workspace.id)
          .execute(),
      ).rejects.toThrow("workspace must retain at least one active owner");
      await database.transaction().execute(async (transaction) => {
        const workspaceId = createId("workspace");
        await sql`insert into workspaces(id,name,color,kind,created_by,backing,status)
          select ${workspaceId}, 'Intrinsic owner', 'blue', 'project', created_by,
            jsonb_set(backing, '{bindingId}', to_jsonb(${createId("workspaceBinding")}::text)), 'ready'
          from workspaces where id = ${fixture.workspace.id}`.execute(transaction);
        await transaction
          .insertInto("workspaceMemberships")
          .values({
            id: createId("workspaceMembership"),
            workspaceId,
            userId: fixture.userId,
            role: "owner",
            state: "active",
            generation: 1,
            invitedBy: null,
            effectiveUntil: new Date("2020-01-01"),
          })
          .execute();
      });
    }
    await database
      .updateTable("deployments")
      .set({
        authorityModelVersion: 2,
        deploymentShape: {
          kind: "server",
          defaultWorkspaceBacking: "local-directory",
        },
      })
      .execute();
    await database
      .updateTable("workspaceMemberships")
      .set({ state: "revoked", revokedAt: new Date(), revokedBy: null })
      .where("workspaceId", "=", fixture.workspace.id)
      .execute();
  });

  it("denies expired intrinsic Main consent without changing the public membership DTO", async ({
    storeFixture,
  }) => {
    const fixture = await storeFixture.createRunFixture("main-consent");
    const database = storeFixture.database;
    await database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
    await database.updateTable("users").set({ admittedAt: new Date() }).execute();
    await loadMembershipAuthority(database);
    await database
      .updateTable("workspaceMemberships")
      .set({ effectiveUntil: new Date("2020-01-01") })
      .where("workspaceId", "=", fixture.workspace.id)
      .execute();
    await expect(
      database.transaction().execute(async (transaction) => {
        await sql`create temporary table authority_probe (id text, parent_thread_id text, inherits_main boolean,
        specialist_id text, lineage_root_thread_id text, workspace_id text, created_by text) on commit drop;
        create trigger authority_probe_guard before insert on authority_probe for each row execute function public.opensteer_enforce_thread_consent()`.execute(
          transaction,
        );
        await sql`insert into authority_probe values (${createId("thread")}, null, true, null, null, ${fixture.workspace.id}, ${fixture.userId})`.execute(
          transaction,
        );
      }),
    ).rejects.toThrow("thread consent exceeds its durable authority");
  });

  it("fans plugin revisions out only to effective members", async ({ storeFixture }) => {
    const fixture = await storeFixture.createRunFixture("plugin-fanout", null, "project");
    const userId = await storeFixture.store.createUser("Effective member");
    const database = storeFixture.database;
    await database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
    await database.updateTable("users").set({ admittedAt: new Date() }).execute();
    await loadMembershipAuthority(database);
    await database
      .insertInto("workspaceMemberships")
      .values({
        id: createId("workspaceMembership"),
        workspaceId: fixture.workspace.id,
        userId,
        role: "collaborator",
        state: "active",
        generation: 1,
        invitedBy: null,
      })
      .execute();
    await database
      .updateTable("workspaceMemberships")
      .set({ effectiveUntil: new Date("2020-01-01") })
      .where("workspaceId", "=", fixture.workspace.id)
      .where("userId", "=", fixture.userId)
      .execute();
    await database.transaction().execute(async (transaction) => {
      await sql`create temporary table plugin_activations(workspace_id text, plugin_id text) on commit drop;
        create trigger effective_plugin_fanout after insert on plugin_activations
        for each row execute function public.opensteer_legacy_plugin_revision()`.execute(
        transaction,
      );
      await sql`insert into plugin_activations values (${fixture.workspace.id}, 'test-plugin')`.execute(
        transaction,
      );
      const pending = await sql`select owner_user_id from plugin_settings_revision_pending
        where transaction_id = pg_current_xact_id()`.execute(transaction);
      expect(pending.rows).toEqual([{ ownerUserId: userId }]);
    });
  });

  it("keeps administrator directory presence distinct from effective content membership", async ({
    storeFixture,
  }) => {
    const fixture = await storeFixture.createRunFixture("directory-presence", null, "project");
    const database = storeFixture.database;
    await database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
    await database.updateTable("users").set({ admittedAt: new Date() }).execute();
    await loadMembershipAuthority(database);
    const directory = new AccountDirectoryStore(database);
    await directory.configureProvider({
      providerId: "fixture-account",
      issuer: "https://accounts.fixture.invalid",
    });
    await database
      .insertInto("authAccounts")
      .values({
        id: createId("authAccount"),
        userId: fixture.userId,
        providerId: "fixture-account",
        accountId: "fixture-person",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();
    const presence = () =>
      database
        .selectFrom("accountDirectoryProjections")
        .select("present")
        .where("userId", "=", fixture.userId)
        .executeTakeFirstOrThrow();
    expect(await presence()).toEqual({ present: true });
    await database
      .updateTable("workspaceMemberships")
      .set({ effectiveUntil: new Date("2020-01-01") })
      .where("workspaceId", "=", fixture.workspace.id)
      .execute();
    await directory.refreshUser(fixture.userId);
    expect(await presence()).toEqual({ present: false });
    await database
      .updateTable("users")
      .set({ instanceRole: "administrator" })
      .where("id", "=", fixture.userId)
      .execute();
    expect(await presence()).toEqual({ present: true });
  });
});
