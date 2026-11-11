import { randomUUID } from "node:crypto";
import { createId } from "@opensteer/core";
import { LocalProfileBindingSchema, createBrowserSessionId } from "@opensteer/protocol";
import { sql } from "kysely";
import { expect, it } from "vitest";
import {
  deleteBrowserProfile,
  getBrowserProfile,
  insertBrowserProfileOnLockedHome,
} from "./browser-session-store.js";
import {
  bindBrowserProfile,
  listBrowserProfileErasureJobs,
} from "./browser-profile-storage-store.js";
import {
  archiveRunnerBrowserProfiles,
  finishRunnerBrowserProfileRemoval,
} from "./browser-runner-removal-store.js";
import { createDatabase } from "./connection.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { cloneTestDatabase } from "./test-database.test-support.js";

it("archives a profile's saved tabs and history while retaining its exact native erasure binding", async () => {
  const clone = await cloneTestDatabase("host");
  const database = createDatabase({ connectionString: clone.url });
  try {
    const p = await seedPersonalFixture(database, "/tmp/profile-erasure");
    await database
      .updateTable("runners")
      .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
      .where("id", "=", p.runnerId)
      .execute();
    await expect(
      database.transaction().execute((tx) =>
        insertBrowserProfileOnLockedHome(tx, {
          name: "Unowned",
          ownerId: createId("user"),
          homeRunnerId: null,
        }),
      ),
    ).rejects.toThrow();
    const profileId = createId("browserProfile");
    await database
      .insertInto("browserProfiles")
      .values({ id: profileId, ownerId: p.userId, homeRunnerId: p.runnerId, name: "Personal" })
      .execute();
    const binding = LocalProfileBindingSchema.parse({
      version: 1,
      profileId,
      deploymentId: p.deploymentId,
      runnerId: p.runnerId,
      storageInstanceId: randomUUID(),
      bindingId: randomUUID(),
      engine: "chromium",
    });
    expect((await bindBrowserProfile(database, binding)).kind).toBe("local");
    await expect(
      bindBrowserProfile(database, { ...binding, storageInstanceId: randomUUID() }),
    ).rejects.toThrow("original computer");
    const sessionId = createBrowserSessionId();
    await sql`insert into browser_sessions(id,tab_group_id,origin,profile_id,placement_key,runner_id,runtime_id,state)
      values(${sessionId},${sessionId},'person',${profileId},'personal',${p.runnerId},'browser','ready')`.execute(
      database,
    );
    const tabId = `${sessionId}-tab`;
    await sql`insert into personal_tabs(id,group_id,session_id,title,url,"order",state)
      values(${tabId},${sessionId},${sessionId},'Saved','https://example.com/',0,'suspended')`.execute(
      database,
    );
    await sql`insert into browser_history_entries(profile_id,url,origin,title,typed_count,visit_count)
      values(${profileId},'https://example.com/','https://example.com','History',1,1)`.execute(
      database,
    );
    await sql`insert into browser_history_icons(profile_id,origin,icon_ref,favicon)
      values(${profileId},'https://example.com','hash','data:image/png;base64,AA==')`.execute(
      database,
    );
    await expect(
      deleteBrowserProfile(database, { ownerId: createId("user"), profileId }),
    ).rejects.toThrow();
    const removed = await deleteBrowserProfile(database, { ownerId: p.userId, profileId });
    expect(removed.sessionIds).toEqual([sessionId]);
    expect(removed.deletion).toEqual({
      profileId,
      computerId: p.runnerId,
      state: "pending-computer",
    });
    expect(await getBrowserProfile(database, profileId, p.userId)).toBeNull();
    expect(await database.selectFrom("browserHistoryEntries").selectAll().execute()).toEqual([]);
    expect(await database.selectFrom("browserHistoryIcons").selectAll().execute()).toEqual([]);
    expect(
      (
        await database
          .selectFrom("personalTabs")
          .select("closedAt")
          .where("id", "=", tabId)
          .executeTakeFirstOrThrow()
      ).closedAt,
    ).toBeInstanceOf(Date);
    expect(await listBrowserProfileErasureJobs(database, p.runnerId)).toMatchObject([{ binding }]);
    await database.transaction().execute(async (tx) => {
      const now = new Date();
      const profiles = await archiveRunnerBrowserProfiles(tx, [profileId], now);
      await finishRunnerBrowserProfileRemoval(tx, p.runnerId, profiles, now);
    });
    expect(await listBrowserProfileErasureJobs(database, p.runnerId)).toEqual([]);
    expect(
      await database
        .selectFrom("browserProfileDeletions")
        .select(["state", "deletedAt", "runnerId", "bindingVersion"])
        .where("profileId", "=", profileId)
        .executeTakeFirstOrThrow(),
    ).toEqual({
      state: "unconfirmed",
      deletedAt: null,
      runnerId: p.runnerId,
      bindingVersion: 1,
    });
  } finally {
    await database.destroy();
    await clone.drop();
  }
});
