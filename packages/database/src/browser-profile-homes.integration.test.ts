import { createId, type RunnerId, type UserId } from "@opensteer/core";
import { createBrowserSessionId, type LocalProfileBinding } from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import {
  describeStore,
  enrollTestRunner,
  type StoreFixture,
} from "./store.integration.test-support.js";
import { personalReachableGrant } from "./runner-store.js";
import { listEligibleBrowserRunners } from "./browser-home-store.js";

async function computer(
  fixture: StoreFixture,
  ownerId: UserId,
  options: {
    managed?: boolean;
    browser?: boolean;
  } = {},
) {
  const runnerId = createId("runner");
  const browser = options.browser !== false;
  await enrollTestRunner(fixture.store, {
    createdBy: ownerId,
    environmentId: createId("environment"),
    runnerId,
    runnerKind: options.managed ? "managed" : "local",
    ...(options.managed ? { ownerUserId: ownerId } : {}),
    name: runnerId,
    tokenSuffix: runnerId,
    allowedModules: personalReachableGrant,
    modules: browser
      ? { browser: { runtimeId: runnerId, wireVersion: 2 } }
      : { integrations: { platform: "android", protocolVersion: 4 } },
  });
  if (!browser)
    await fixture.database
      .updateTable("runners")
      .set({ allowedModules: sql`'["integrations"]'::jsonb` })
      .where("id", "=", runnerId)
      .execute();
  return runnerId;
}

async function setup(fixture: StoreFixture) {
  const run = await fixture.createRunFixture("homes");
  await fixture.database
    .updateTable("runners")
    .set({
      allowedModules: sql`'["agents","browser","messaging"]'::jsonb`,
    })
    .where("id", "=", run.runnerId)
    .execute();
  await fixture.enablePersonalRemoteAccess();
  return run;
}

function binding(
  deploymentId: LocalProfileBinding["deploymentId"],
  runnerId: RunnerId,
  profileId: LocalProfileBinding["profileId"],
): LocalProfileBinding {
  return {
    version: 1,
    deploymentId,
    runnerId,
    profileId,
    storageInstanceId: randomUUID(),
    bindingId: randomUUID(),
    engine: "chromium",
  };
}

describeStore("browser profile homes", (it) => {
  it("lists only active browser computers and refuses another person", async ({
    storeFixture: fixture,
  }) => {
    const run = await setup(fixture);
    const other = await fixture.store.createUser("Other person");
    const own = await computer(fixture, run.userId);
    const retired = await computer(fixture, run.userId);
    const withoutBrowser = await computer(fixture, run.userId, { browser: false });
    await fixture.store.revokeRunner(retired, run.userId);
    expect(
      (await listEligibleBrowserRunners(fixture.database, run.userId)).map((row) => row.id).sort(),
    ).toEqual([run.runnerId, own].sort());
    expect(
      (await fixture.store.listEligibleBrowserRunners(run.userId)).map((row) => row.id),
    ).not.toContain(withoutBrowser);
    await expect(
      fixture.store.createBrowserProfile({
        ownerId: other,
        name: "Foreign",
        homeRunnerId: own,
        idempotencyKey: "foreign",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    const profile = await fixture.store.createBrowserProfile({
      ownerId: run.userId,
      name: "Offline home",
      homeRunnerId: own,
      idempotencyKey: "own",
    });
    expect(profile.homeRunnerId).toBe(own);
    await expect(
      fixture.store.bindBrowserProfile(binding(run.deploymentId, retired, profile.id)),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("requires a selection when ambiguous, preserves idempotency, and binds only to the chosen home", async ({
    storeFixture: fixture,
  }) => {
    const run = await setup(fixture);
    const implicit = await fixture.store.createBrowserProfile({
      ownerId: run.userId,
      name: "Only computer",
      idempotencyKey: "implicit",
    });
    expect(implicit.homeRunnerId).toBe(run.runnerId);
    const other = await computer(fixture, run.userId);
    await expect(
      fixture.store.createBrowserProfile({
        ownerId: run.userId,
        name: "Ambiguous",
        idempotencyKey: "ambiguous",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const input = {
      ownerId: run.userId,
      name: "Chosen",
      homeRunnerId: other,
      idempotencyKey: "chosen",
    };
    const profile = await fixture.store.createBrowserProfile(input);
    expect(await fixture.store.createBrowserProfile(input)).toEqual(profile);
    await expect(
      fixture.store.createBrowserProfile({ ...input, homeRunnerId: run.runnerId }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      fixture.store.bindBrowserProfile(binding(run.deploymentId, run.runnerId, profile.id)),
    ).rejects.toMatchObject({ code: "conflict" });
    const native = binding(run.deploymentId, other, profile.id);
    expect(await fixture.store.bindBrowserProfile(native)).toMatchObject({
      kind: "local",
      binding: native,
    });
    await expect(
      fixture.store.bindBrowserProfile({ ...native, engine: "wkwebview" }),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      fixture.store.bindBrowserProfile({ ...native, storageInstanceId: randomUUID() }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await fixture.store.getBrowserProfile(profile.id, run.userId)).toMatchObject({
      homeRunnerId: other,
    });
  });

  it("removes all homed profiles with history, saved tabs and terminal unconfirmed erasure", async ({
    storeFixture: fixture,
  }) => {
    const run = await setup(fixture);
    const home = await computer(fixture, run.userId);
    const profiles = [];
    for (let index = 0; index < 2; index++) {
      const profile = await fixture.store.createBrowserProfile({
        ownerId: run.userId,
        homeRunnerId: home,
        name: `Profile ${index}`,
        idempotencyKey: `remove-${index}`,
      });
      profiles.push(profile);
      await fixture.store.bindBrowserProfile(binding(run.deploymentId, home, profile.id));
      await fixture.store.browserHistory.recordVisit({
        profileId: profile.id,
        ownerId: run.userId,
        url: `https://example.test/${index}`,
        title: "History",
        typed: true,
      });

      const sessionId = createBrowserSessionId();
      await fixture.store.createBrowserSession({
        id: sessionId,
        runnerId: home,
        origin: "agent",
        ownerId: run.userId,
        profileId: profile.id,
        placementKey: `runner:${home}`,
        runtimeId: "browser",
      });
      await fixture.database
        .insertInto("personalTabs")
        .values({
          id: `${sessionId}-tab`,
          sessionId,
          groupId: sessionId,
          createdAt: new Date(),
          order: 0,
          openerId: null,
          state: "suspended",
          title: "Saved",
          url: "https://example.test/",
          closedAt: null,
        })
        .execute();
    }
    const oldGuest = createBrowserSessionId();
    await fixture.store.createBrowserSession({
      id: oldGuest,
      runnerId: home,
      origin: "agent",
      ownerId: run.userId,
      profileId: null,
      placementKey: `runner:${home}`,
      runtimeId: "browser",
    });
    await fixture.database
      .updateTable("browserSessions")
      .set({ state: "closed", closedAt: new Date() })
      .where("id", "=", oldGuest)
      .execute();
    const replacementGuest = createBrowserSessionId();
    await fixture.store.createBrowserSession({
      id: replacementGuest,
      tabGroupId: oldGuest,
      runnerId: run.runnerId,
      origin: "agent",
      ownerId: run.userId,
      profileId: null,
      placementKey: `runner:${run.runnerId}`,
      runtimeId: "browser",
    });
    await fixture.database
      .insertInto("personalTabs")
      .values({
        id: "replacement-guest-tab",
        sessionId: replacementGuest,
        groupId: oldGuest,
        createdAt: new Date(),
        order: 0,
        openerId: null,
        state: "suspended",
        title: "Reopened elsewhere",
        url: "https://retained.test/",
        closedAt: null,
      })
      .execute();
    const removed = await fixture.store.revokeRunner(home, run.userId, {
      administration: {
        requestedBy: run.userId,
        idempotencyKey: "remove-homed-computer",
        type: "machine.revoke",
        request: { runnerId: home },
        authoritySource: { kind: "user-session", userId: run.userId },
      },
    });
    expect(removed.deletedBrowserProfiles.map((row) => row.id).sort()).toEqual(
      profiles.map((row) => row.id).sort(),
    );
    expect(removed.closedBrowserSessions).toHaveLength(2);
    expect(await fixture.store.listBrowserProfiles(run.userId)).toEqual([]);
    expect(
      await fixture.database.selectFrom("browserHistoryEntries").selectAll().execute(),
    ).toEqual([]);
    expect(
      await fixture.database
        .selectFrom("personalTabs")
        .select("closedAt")
        .where("groupId", "!=", oldGuest)
        .execute(),
    ).toEqual([{ closedAt: expect.any(Date) }, { closedAt: expect.any(Date) }]);
    expect(
      await fixture.database
        .selectFrom("personalTabs")
        .select("closedAt")
        .where("id", "=", "replacement-guest-tab")
        .executeTakeFirstOrThrow(),
    ).toEqual({ closedAt: null });
    expect(
      await fixture.database
        .selectFrom("browserProfileDeletions")
        .select(["state", "deletedAt"])
        .execute(),
    ).toEqual([
      { state: "unconfirmed", deletedAt: null },
      { state: "unconfirmed", deletedAt: null },
    ]);
    expect(await fixture.store.listBrowserProfileErasureJobs(home)).toEqual([]);
    expect(await fixture.store.listPendingBrowserProfileDeletions(run.userId)).toEqual([]);
    const remaining = await computer(fixture, run.userId);
    await fixture.database
      .insertInto("browserProfiles")
      .values(
        Array.from({ length: 126 }, (_, index) => ({
          id: createId("browserProfile"),
          ownerId: run.userId,
          homeRunnerId: remaining,
          name: `Replacement ${index}`,
        })),
      )
      .execute();
    for (const index of [126, 127])
      await fixture.store.createBrowserProfile({
        ownerId: run.userId,
        homeRunnerId: remaining,
        name: `Replacement ${index}`,
        idempotencyKey: `replacement-${index}`,
      });
    await expect(
      fixture.store.createBrowserProfile({
        ownerId: run.userId,
        homeRunnerId: remaining,
        name: "Over quota",
        idempotencyKey: "over-quota",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it.for(["queued", "running"] as const)(
    "refuses to remove the hosting computer and preserves its profiles and %s Run",
    async (state, { storeFixture: fixture }) => {
      const running = state === "running" ? await fixture.startRunFixture("homes-executing") : null;
      const run = running ?? (await fixture.createRunFixture("homes-queued"));
      await fixture.database
        .updateTable("runners")
        .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
        .where("id", "=", run.runnerId)
        .execute();
      const deployment = await fixture.store.getDeployment();
      const profile = await fixture.store.createBrowserProfile({
        ownerId: run.userId,
        homeRunnerId: run.runnerId,
        name: "Execution browser",
        idempotencyKey: "execution",
      });
      await fixture.store.bindBrowserProfile(binding(deployment!.id, run.runnerId, profile.id));

      const sessionId = createBrowserSessionId();
      await fixture.store.createBrowserSession({
        id: sessionId,
        runnerId: run.runnerId,
        profileId: profile.id,
        origin: "agent",
        ownerId: run.userId,
        runtimeId: "browser",
        placementKey: `runner:${run.runnerId}`,
      });
      await fixture.store.attachBrowserSession({
        agentBindingId: "trigger:home",
        ownerId: run.userId,
        sessionId,
      });
      const runId =
        running?.run.id ??
        (
          await fixture.enqueueHumanTrigger({
            content: [{ type: "text", text: "Queued work" }],
            idempotencyKey: "queued",
            requestedBy: run.userId,
            threadId: run.thread.id,
          })
        ).run.id;
      await expect(
        fixture.store.revokeRunner(run.runnerId, run.userId, { allowDeployment: true }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect((await fixture.store.getBrowserProfile(profile.id, run.userId))?.homeRunnerId).toBe(
        run.runnerId,
      );
      expect(
        await fixture.database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", runId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ status: state === "running" ? "running" : "queued" });
    },
  );
  it.for(["create", "implicit-create", "bind", "start"] as const)(
    "serializes %s against removal at the Runner row",
    async (operation, { storeFixture: fixture }) => {
      const run = await setup(fixture);
      const home = await computer(fixture, run.userId);
      if (operation === "implicit-create")
        await fixture.database
          .updateTable("runners")
          .set({ allowedModules: sql`'["agents","messaging"]'::jsonb` })
          .where("id", "=", run.runnerId)
          .execute();
      const profile = await fixture.store.createBrowserProfile({
        ownerId: run.userId,
        homeRunnerId: home,
        name: "Race",
        idempotencyKey: "race",
      });
      const native = binding(run.deploymentId, home, profile.id);
      if (operation === "start") await fixture.store.bindBrowserProfile(native);
      const held = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const blocker = fixture.database.transaction().execute(async (tx) => {
        await tx
          .selectFrom("runners")
          .select("id")
          .where("id", "=", home)
          .forNoKeyUpdate()
          .execute();
        const result = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx);
        held.resolve(result.rows[0]!.pid);
        await withTimeout(release.promise, 5_000, {
          timeoutError: () => new Error("Removal race blocker was not released"),
        });
      });
      const blockerPid = await withTimeout(held.promise, 2_000, {
        timeoutError: () => new Error("Runner row was never locked"),
      });
      let removing: ReturnType<typeof fixture.store.revokeRunner> | undefined;
      let competing: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        removing = fixture.store.revokeRunner(home, run.userId);
        const removingPid = await vi.waitFor(
          async () => {
            const result = await sql<{
              pid: number;
            }>`select pid from pg_stat_activity where ${blockerPid} = any(pg_blocking_pids(pid))`.execute(
              fixture.database,
            );
            expect(result.rows.length, "Removal never waited for its Runner fence").toBeGreaterThan(
              0,
            );
            return result.rows[0]!.pid;
          },
          { timeout: 2_000 },
        );
        const action =
          operation === "create" || operation === "implicit-create"
            ? fixture.store.createBrowserProfile({
                ownerId: run.userId,
                ...(operation === "create" ? { homeRunnerId: home } : {}),
                name: "Too late",
                idempotencyKey: "late",
              })
            : operation === "bind"
              ? fixture.store.bindBrowserProfile(native)
              : fixture.store.createBrowserSession({
                  id: createBrowserSessionId(),
                  runnerId: home,
                  profileId: profile.id,
                  origin: "agent",
                  ownerId: run.userId,
                  runtimeId: "browser",
                  placementKey: `runner:${home}`,
                });
        competing = Promise.allSettled([action]);
        await vi.waitFor(
          async () => {
            const result = await sql<{ count: string }>`select count(*)::text as count
              from pg_stat_activity where pid <> ${removingPid} and
                (${blockerPid} = any(pg_blocking_pids(pid)) or
                 ${removingPid} = any(pg_blocking_pids(pid)))`.execute(fixture.database);
            expect(
              Number(result.rows[0]!.count),
              "Competing operation never waited for removal's fence",
            ).toBeGreaterThan(0);
          },
          { timeout: 2_000 },
        );
        release.resolve();
        await blocker;
        await removing;
        expect((await competing)[0]?.status).toBe("rejected");
        expect(await fixture.store.listBrowserProfiles(run.userId)).toEqual([]);
      } finally {
        release.resolve();
        await blocker;
        await removing;
        await competing;
      }
    },
  );
});
