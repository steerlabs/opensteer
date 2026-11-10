import { describeStore } from "./store.integration.test-support.js";
import { sql } from "kysely";
import { expect } from "vitest";
import { AccountDirectoryStore } from "./account-directory-store.js";
import { createId } from "@opensteer/core";

describeStore("team Account presence", (it) => {
  it("projects admitted active people without Projects and skips membership refreshes only on model 2", async ({
    storeFixture,
  }) => {
    const fixture = await storeFixture.createRunFixture("team-presence", null, "project");
    const database = storeFixture.database;
    const directory = new AccountDirectoryStore(database);
    await database.updateTable("deployments").set({ authorityModelVersion: 2 }).execute();
    await directory.configureProvider({ issuer: "https://account.test", providerId: "account" });
    const person = createId("user");
    await database
      .insertInto("users")
      .values({
        id: person,
        displayName: "Person",
        email: "person@presence.test",
        emailVerified: true,
        image: null,
        instanceRole: "user",
        disabledAt: null,
        admittedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        memberStateChangedAt: new Date(),
      })
      .execute();
    await database
      .insertInto("authAccounts")
      .values({
        id: createId("authAccount"),
        userId: person,
        providerId: "account",
        accountId: "subject",
        password: null,
      })
      .execute();
    expect(
      await database
        .selectFrom("accountDirectoryProjections")
        .selectAll()
        .where("userId", "=", person)
        .execute(),
    ).toEqual([]);
    await database
      .updateTable("users")
      .set({ admittedAt: new Date() })
      .where("id", "=", person)
      .execute();
    expect(
      await database
        .selectFrom("accountDirectoryProjections")
        .select("present")
        .where("userId", "=", person)
        .executeTakeFirstOrThrow(),
    ).toEqual({ present: true });
    await database
      .updateTable("users")
      .set({ disabledAt: new Date() })
      .where("id", "=", person)
      .execute();
    expect(
      await database
        .selectFrom("accountDirectoryProjections")
        .select("present")
        .where("userId", "=", person)
        .executeTakeFirstOrThrow(),
    ).toEqual({ present: false });
    await sql`create table human_directory_refresh_probe (user_id text)`.execute(database);
    const definition = (
      await sql<{
        definition: string;
      }>`select pg_get_functiondef('public.opensteer_refresh_account_directory_user(text)'::regprocedure) as definition`.execute(
        database,
      )
    ).rows[0]!.definition;
    await sql
      .raw(
        definition.replace(
          /begin/i,
          "begin insert into human_directory_refresh_probe values (target_user_id);",
        ),
      )
      .execute(database);
    for (const kind of ["server", "personal"] as const) {
      await database
        .updateTable("deployments")
        .set({
          authorityModelVersion: 1,
          deploymentShape: { kind, defaultWorkspaceBacking: "local-directory" },
        })
        .execute();
      await sql`truncate human_directory_refresh_probe`.execute(database);
      await database
        .updateTable("workspaceMemberships")
        .set({ generation: sql`generation + 1` })
        .where("workspaceId", "=", fixture.workspace.id)
        .where("userId", "=", fixture.userId)
        .execute();
      expect(
        (await sql`select * from human_directory_refresh_probe`.execute(database)).rows,
      ).toHaveLength(1);
    }
    await database
      .updateTable("deployments")
      .set({
        authorityModelVersion: 2,
        deploymentShape: { kind: "server", defaultWorkspaceBacking: "local-directory" },
      })
      .execute();
    await sql`truncate human_directory_refresh_probe`.execute(database);
    await database
      .updateTable("workspaceMemberships")
      .set({ generation: sql`generation + 1` })
      .where("workspaceId", "=", fixture.workspace.id)
      .where("userId", "=", fixture.userId)
      .execute();
    expect(
      (await sql`select * from human_directory_refresh_probe`.execute(database)).rows,
    ).toHaveLength(0);
    await database
      .updateTable("users")
      .set({ memberState: "suspended" })
      .where("id", "=", person)
      .execute();
    expect(
      (await sql`select * from human_directory_refresh_probe`.execute(database)).rows,
    ).toHaveLength(1);
  });
});
