import { sql } from "kysely";
import { createId, emptyAutomaticModelConfig, emptyExecutionPreferences } from "@opensteer/core";
import { requirePersonalOwner } from "./personal-settings-store.js";
import { expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { createTeamFixture } from "./team-fixture.test-support.js";
import { cloneTestDatabase } from "./test-database.test-support.js";

it("seeds one private owner with the hosting computer and no team membership", async () => {
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url });
  try {
    const fixture = await seedPersonalFixture(database, "/tmp/fixture-agent-home");
    expect(
      (
        await sql`select owner_id,agent_home_computer_id,agent_home_path,voice_thread_id from personal_settings`.execute(
          database,
        )
      ).rows,
    ).toEqual([
      {
        ownerId: fixture.userId,
        agentHomeComputerId: fixture.runnerId,
        agentHomePath: "/tmp/fixture-agent-home",
        voiceThreadId: null,
      },
    ]);
    expect((await sql`select id from users`.execute(database)).rows).toEqual([
      { id: fixture.userId },
    ]);
    expect((await sql`select * from team_members`.execute(database)).rows).toEqual([]);
    expect(
      await database
        .selectFrom("personalSettings")
        .select(["executionPreferences", "backgroundModelPreferences"])
        .executeTakeFirstOrThrow(),
    ).toEqual({
      executionPreferences: emptyExecutionPreferences,
      backgroundModelPreferences: emptyAutomaticModelConfig,
    });
    expect(
      await database.selectFrom("principals").select(["kind", "userId"]).orderBy("kind").execute(),
    ).toEqual([
      { kind: "system", userId: null },
      { kind: "user", userId: fixture.userId },
    ]);
    const otherId = createId("user");
    await database
      .insertInto("users")
      .values({
        id: otherId,
        displayName: "Other",
        email: "other@example.invalid",
        emailVerified: true,
      })
      .execute();
    await database
      .updateTable("users")
      .set({ disabledAt: new Date() })
      .where("id", "=", fixture.userId)
      .execute();
    await expect(requirePersonalOwner(database, fixture.userId)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(requirePersonalOwner(database, otherId)).rejects.toMatchObject({
      code: "forbidden",
    });
  } finally {
    await database.destroy();
    await clone.drop();
  }
});
it("seeds a team without private settings, computers or tasks", async () => {
  const fixture = await createTeamFixture();
  try {
    expect(
      (await sql`select user_id,role from team_members`.execute(fixture.database)).rows,
    ).toEqual([{ userId: fixture.userId, role: "owner" }]);
    for (const table of ["personal_settings", "runners", "threads"])
      expect((await sql.raw(`select * from ${table}`).execute(fixture.database)).rows).toEqual([]);
  } finally {
    await fixture.close();
  }
});
