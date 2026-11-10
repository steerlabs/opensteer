import { createId } from "@opensteer/core";
import { sql } from "kysely";
import { expect } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { pauseAfterLock } from "./lock-race.test-support.js";
import type { DatabaseSchema } from "./schema.js";
import type { Kysely } from "kysely";
import { describeStore } from "./store.integration.test-support.js";
import { ensureProjectPrincipal } from "./project-work-store.js";

describeStore("Project principal lookup", (it) => {
  it("converges concurrent admission lookups and retains the principal after deletion", async ({
    storeFixture,
  }) => {
    const database = storeFixture.database;
    const userId = await storeFixture.store.createUser("Project creator");
    const workspaceId = createId("workspace");
    const environmentId = createId("environment");
    await database
      .insertInto("deployments")
      .values({
        id: createId("deployment"),
        singletonKey: "primary",
        activeHostInstanceId: createId("hostInstance"),
        authorityModelVersion: 2,
        canonicalOrigin: "https://project.test.invalid",
        lifecycle: "active",
        deploymentShape: { kind: "server", defaultWorkspaceBacking: "local-directory" },
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .execute();
    await database.transaction().execute(async (transaction) => {
      await sql`insert into execution_environments (id, name, kind, capabilities)
        values (${environmentId}, 'Project computer', 'main', '[]'::jsonb)`.execute(transaction);
      await sql`insert into workspaces (id, kind, name, created_by, color, backing)
        values (${workspaceId}, 'project', 'Team Project', ${userId}, 'blue', ${JSON.stringify({
          kind: "local-directory",
          ownerEnvironmentId: environmentId,
          bindingId: createId("workspaceBinding"),
          storageAuthorityId: null,
          generation: 1,
        })}::jsonb)`.execute(transaction);
      await sql`insert into workspace_memberships (id, workspace_id, user_id, role, state)
        values (${createId("workspaceMembership")}, ${workspaceId}, ${userId}, 'owner', 'active')`.execute(
        transaction,
      );
    });
    const inserted = pauseAfterLock(
      database,
      (node) => node.includes('"InsertQueryNode"') && node.includes('"principals"'),
    );
    const observed = pauseAfterLock(
      database,
      (node) => node.includes('"SelectQueryNode"') && node.includes('"principals"'),
    );
    const lookup = (connection: Kysely<DatabaseSchema>) =>
      connection.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("workspaces")
          .select("id")
          .where("id", "=", workspaceId)
          .forShare()
          .executeTakeFirstOrThrow();
        return ensureProjectPrincipal(transaction, workspaceId);
      });
    const first = lookup(inserted.database);
    void first.catch(() => undefined);
    let second: ReturnType<typeof lookup> | undefined;
    let ids: Awaited<ReturnType<typeof lookup>>[];
    try {
      await withTimeout(inserted.reached, 3000, {
        timeoutError: () => new Error("First principal insert never reached its barrier"),
      });
      second = lookup(observed.database);
      void second.catch(() => undefined);
      await withTimeout(observed.reached, 3000, {
        timeoutError: () =>
          new Error("Concurrent principal lookup never read the absent uncommitted row"),
      });
      observed.release();
      inserted.release();
      ids = await withTimeout(Promise.all([first, second]), 3000, {
        timeoutError: () => new Error("Concurrent principal lookups did not settle"),
      });
    } finally {
      observed.release();
      inserted.release();
      await withTimeout(Promise.allSettled([first, second]), 3000, {
        timeoutError: () => new Error("Principal lookup cleanup did not settle"),
      });
    }
    expect(new Set(ids).size).toBe(1);
    const rows = await database
      .selectFrom("principals")
      .selectAll()
      .where("workspaceId", "=", workspaceId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: ids[0], kind: "project", userId: null });
    expect(
      await database
        .transaction()
        .execute((transaction) => ensureProjectPrincipal(transaction, workspaceId)),
    ).toBe(ids[0]);
    await database
      .updateTable("workspaces")
      .set({ status: "deleted", deletedAt: new Date() })
      .where("id", "=", workspaceId)
      .execute();
    await expect(
      database
        .transaction()
        .execute((transaction) => ensureProjectPrincipal(transaction, workspaceId)),
    ).rejects.toMatchObject({ code: "workspace_unavailable" });
    expect(
      await database
        .selectFrom("principals")
        .select("id")
        .where("workspaceId", "=", workspaceId)
        .execute(),
    ).toEqual([{ id: ids[0] }]);
  });
});
