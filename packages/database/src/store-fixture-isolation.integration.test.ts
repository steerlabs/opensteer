import { sql } from "kysely";
import { expect } from "vitest";
import { describeStore } from "./store.integration.test-support.js";

let previousDatabase: string;

// Guards isolation of schema and singleton changes that a table reset cannot undo.
describeStore("store fixture isolation", (it) => {
  it("owns its schema and seeded singleton changes", async ({ storeFixture }) => {
    const { database, store } = storeFixture;
    const result = await sql<{ name: string }>`select current_database() as name`.execute(database);
    previousDatabase = result.rows[0]!.name;
    await sql`create table fixture_isolation_sentinel (value text)`.execute(database);
    await store.createUser("Previous fixture sentinel");
    await database
      .updateTable("personalRemoteAccess")
      .set({ generation: 19, mode: "private", routeOrigin: "https://previous.test" })
      .where("singletonKey", "=", "personal")
      .executeTakeFirstOrThrow();
  });

  it("starts with a different database and only migrated state", async ({ storeFixture }) => {
    const { database } = storeFixture;
    const result = await sql<{ name: string; sentinel: string | null }>`
      select current_database() as name, to_regclass('fixture_isolation_sentinel')::text as sentinel
    `.execute(database);
    expect(result.rows[0]!.name).not.toBe(previousDatabase);
    expect(result.rows[0]!.sentinel).toBeNull();
    expect(await database.selectFrom("users").selectAll().execute()).toEqual([]);
    expect(
      await database
        .selectFrom("personalRemoteAccess")
        .select(["mode", "routeOrigin"])
        .select(sql<number>`generation::integer`.as("generation"))
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ generation: 0, mode: "off", routeOrigin: null });
  });
});
