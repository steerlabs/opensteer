import { DeviceIdSchema } from "@opensteer/core";
import { TabIdSchema } from "@opensteer/core";
import { TabStore } from "./tab-store.js";
import { randomUUID } from "node:crypto";
import { createId } from "@opensteer/core";
import { LocalProfileBindingSchema, createBrowserSessionId } from "@opensteer/protocol";
import { sql } from "kysely";
import { expect, it } from "vitest";
import {
  deleteBrowserProfile,
  getBrowserProfile,
  insertBrowserProfileOnLockedHome,
  listBrowserProfileUsageThreads,
  recordBrowserSessionUse,
} from "./browser-session-store.js";
import {
  bindBrowserProfile,
  listBrowserProfileErasureJobs,
  reconcileBrowserProfileInventory,
} from "./browser-profile-storage-store.js";
import {
  archiveRunnerBrowserProfiles,
  finishRunnerBrowserProfileRemoval,
} from "./browser-runner-removal-store.js";
import { createDatabase } from "./connection.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import {
  describeStore,
  enrollTestRunner,
  testModelSelection,
} from "./store.integration.test-support.js";
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
    const tabId = TabIdSchema.parse(`${sessionId}-tab`);
    await new TabStore(database).open(
      {
        id: tabId,
        ownerId: p.userId,
        computerId: DeviceIdSchema.parse(p.runnerId),
        kind: "page",
        title: "Saved",
        url: "https://example.com/",
        profileId,
        profileName: "Personal",
        openedBy: "person",
        pageBinding: { lineageId: sessionId, sessionId, surfaceId: tabId },
      },
      "saved",
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
    ).toBeNull();
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

describeStore("browser profile usage invalidation", (storeIt) => {
  storeIt(
    "computes bounded affected usage thread IDs on profile delete, runner revocation, and deleted-tombstone reconciliation",
    async ({ storeFixture: f }) => {
      const run = await f.createRunFixture("profile-usage-invalidation");
      await f.enablePersonalRemoteAccess();
      const database = f.database;
      await database
        .updateTable("runners")
        .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
        .where("id", "=", run.runnerId)
        .execute();
      const store = f.store;
      const deploymentId = (
        await database.selectFrom("deployments").select("id").executeTakeFirstOrThrow()
      ).id;
      const makeThread = async (title: string) =>
        (
          await store.createThread({
            createdBy: run.userId,
            environmentId: run.environmentId,
            harnessInstanceId: run.harnessInstance.id,
            idempotencyKey: `thread-${title}-${randomUUID()}`,
            modelSelection: testModelSelection,
            title,
          })
        ).thread.id;
      const threadOld = await makeThread("Old use");
      const threadNew = await makeThread("New use");
      const threadOther = await makeThread("Other profile");
      const threadFresh = await makeThread("Fresh session");
      const threadReconciled = await makeThread("Reconciled delete");
      const threadRunnerRevoked = await makeThread("Runner revoked");

      const localRunnerId = createId("runner");
      await enrollTestRunner(store, {
        createdBy: run.userId,
        environmentId: createId("environment"),
        runnerId: localRunnerId,
        runnerKind: "local",
        name: "MacBook",
        tokenSuffix: localRunnerId,
        allowedModules: ["browser", "integrations", "messaging", "shell"],
        modules: { browser: { runtimeId: localRunnerId, wireVersion: 2 } },
      });

      const profileA = createId("browserProfile");
      const profileB = createId("browserProfile");
      const profileReconciled = createId("browserProfile");
      const profileRunner = createId("browserProfile");
      await database
        .insertInto("browserProfiles")
        .values([
          { id: profileA, ownerId: run.userId, homeRunnerId: run.runnerId, name: "Work" },
          { id: profileB, ownerId: run.userId, homeRunnerId: run.runnerId, name: "Personal" },
          {
            id: profileReconciled,
            ownerId: run.userId,
            homeRunnerId: run.runnerId,
            name: "Reconciled",
          },
          { id: profileRunner, ownerId: run.userId, homeRunnerId: localRunnerId, name: "Laptop" },
        ])
        .execute();

      const insertSession = async (
        profileId: typeof profileA | null,
        state: "ready" | "closed",
        runnerId = run.runnerId,
      ) => {
        const sessionId = createBrowserSessionId();
        await sql`insert into browser_sessions(id,tab_group_id,origin,profile_id,placement_key,runner_id,runtime_id,state)
          values(${sessionId},${sessionId},'person',${profileId},'personal',${runnerId},'browser',${state})`.execute(
          database,
        );
        return sessionId;
      };

      const sessionAClosed = await insertSession(profileA, "closed");
      const sessionAReady = await insertSession(profileA, "ready");
      const sessionB = await insertSession(profileB, "ready");
      const sessionFresh = await insertSession(null, "ready");
      const sessionReconciled = await insertSession(profileReconciled, "closed");
      const sessionRunner = await insertSession(profileRunner, "closed", localRunnerId);

      await recordBrowserSessionUse(database, {
        sessionId: sessionAClosed,
        threadId: threadOld,
        ownerId: run.userId,
        page: { site: "https://old.example", title: "Old" },
      });
      await database
        .updateTable("browserSessionUses")
        .set({ lastUsedAt: new Date("2026-01-01T00:00:00.000Z") })
        .where("threadId", "=", threadOld)
        .execute();
      await recordBrowserSessionUse(database, {
        sessionId: sessionAReady,
        threadId: threadNew,
        ownerId: run.userId,
        page: { site: "https://new.example", title: "New" },
      });
      await recordBrowserSessionUse(database, {
        sessionId: sessionB,
        threadId: threadOther,
        ownerId: run.userId,
      });
      await recordBrowserSessionUse(database, {
        sessionId: sessionFresh,
        threadId: threadFresh,
        ownerId: run.userId,
      });
      await recordBrowserSessionUse(database, {
        sessionId: sessionReconciled,
        threadId: threadReconciled,
        ownerId: run.userId,
      });
      await recordBrowserSessionUse(database, {
        sessionId: sessionRunner,
        threadId: threadRunnerRevoked,
        ownerId: run.userId,
      });

      // Bounded query orders most recently used threads first and honors the limit.
      expect(await listBrowserProfileUsageThreads(database, [profileA], 1)).toEqual([threadNew]);
      expect(await listBrowserProfileUsageThreads(database, [profileA], 10)).toEqual([
        threadNew,
        threadOld,
      ]);

      // 1. Explicit delete returns affected threads (both active and closed sessions), excludes others.
      const admin = {
        requestedBy: run.userId,
        idempotencyKey: `delete-${profileA}`,
        type: "browser.profile.delete",
        request: { profileId: profileA },
        authoritySource: { kind: "user-session", userId: run.userId },
      };
      const deleted = await deleteBrowserProfile(database, {
        ownerId: run.userId,
        profileId: profileA,
        administration: admin,
      });
      expect(deleted.usageThreadIds).toEqual([threadNew, threadOld]);
      // Idempotency replay returns empty usageThreadIds and does not re-emit.
      const replayed = await deleteBrowserProfile(database, {
        ownerId: run.userId,
        profileId: profileA,
        administration: admin,
      });
      expect(replayed.usageThreadIds).toEqual([]);
      // Second delete of an already-archived profile returns empty usageThreadIds.
      const secondDelete = await deleteBrowserProfile(database, {
        ownerId: run.userId,
        profileId: profileA,
      });
      expect(secondDelete.usageThreadIds).toEqual([]);

      // 2. Deleted-tombstone inventory reconciliation archives the profile and returns affected threads.
      const binding = LocalProfileBindingSchema.parse({
        version: 1,
        profileId: profileReconciled,
        deploymentId,
        runnerId: run.runnerId,
        storageInstanceId: randomUUID(),
        bindingId: randomUUID(),
        engine: "chromium",
      });
      await bindBrowserProfile(database, binding);
      const reconciled = await reconcileBrowserProfileInventory(database, {
        phase: "deleted",
        binding,
        deletionId: randomUUID(),
        erasure: "deleted",
      });
      expect(reconciled.usageThreadIds).toEqual([threadReconciled]);

      // 3. Runner revocation archives the runner's home profiles and returns their affected threads.
      const revoked = await store.revokeRunner(localRunnerId, run.userId);
      expect(revoked.browserUsageThreadIds).toEqual([threadRunnerRevoked]);
    },
  );
});
