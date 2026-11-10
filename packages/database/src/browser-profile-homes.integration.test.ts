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
import { listEligibleBrowserRunners } from "./browser-home-store.js";

async function computer(
  fixture: StoreFixture,
  ownerId: UserId,
  options: {
    personal?: boolean;
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
    allowedModules: options.personal
      ? ["browser", "integrations", "messaging", "shell"]
      : browser
        ? ["browser"]
        : ["integrations"],
    modules: browser
      ? { browser: { runtimeId: runnerId, wireVersion: 2 } }
      : { integrations: { platform: "android", protocolVersion: 4 } },
  });
  return runnerId;
}

async function setup(fixture: StoreFixture, personal = false) {
  const run = await fixture.createRunFixture(
    "homes",
    personal
      ? {
          deploymentShape: { kind: "personal", defaultWorkspaceBacking: "local-directory" },
          workspaceBacking: "local-directory",
        }
      : null,
  );
  await fixture.database
    .updateTable("runners")
    .set({ allowedModules: sql`'["agents","browser","messaging"]'::jsonb` })
    .where("id", "=", run.runnerId)
    .execute();
  const deployment = await fixture.store.getDeployment();
  if (personal) await fixture.enablePersonalRemoteAccess();
  return { ...run, deploymentId: deployment!.id };
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
  it.for([false, true])(
    "keeps computer ownership independent from shared Workspaces (Personal=%s)",
    async (personal, { storeFixture: fixture }) => {
      const run = await setup(fixture, personal);
      const other = await fixture.store.createUser("Other member");
      const own = await computer(fixture, run.userId, { personal });
      const foreign = await computer(fixture, other, { personal });
      const retired = await computer(fixture, run.userId, { personal });
      await fixture.store.revokeRunner(retired, run.userId);
      await sql`insert into workspace_memberships (id,workspace_id,user_id,role,state)
      values (${createId("workspaceMembership")},${run.workspace.id},${other},'collaborator','active')`.execute(
        fixture.database,
      );
      const expected = [run.runnerId, own];
      if (!personal) {
        const shared = await fixture.enrollBrowserRunner(run.userId, "Shared browser service");
        const boundOther = await computer(fixture, other, { managed: true });
        const withoutBrowser = await computer(fixture, run.userId, { browser: false });
        expected.push(shared);
        expect(
          (await listEligibleBrowserRunners(fixture.database, run.userId)).map((row) => row.id),
        ).not.toContain(boundOther);
        expect(
          (await listEligibleBrowserRunners(fixture.database, run.userId)).map((row) => row.id),
        ).not.toContain(withoutBrowser);
      }
      expect(
        (await fixture.store.listEligibleBrowserRunners(run.userId)).map((row) => row.id).sort(),
      ).toEqual(expected.sort());
      await expect(
        fixture.store.createBrowserProfile({
          ownerId: run.userId,
          name: "Foreign",
          homeRunnerId: foreign,
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
        fixture.store.bindBrowserProfile(binding(run.deploymentId, foreign, profile.id)),
      ).rejects.toMatchObject({ code: "forbidden" });
    },
  );

  it("requires a selection when ambiguous, preserves idempotency, and binds only to the chosen home", async ({
    storeFixture: fixture,
  }) => {
    const unhomedOwner = await fixture.store.createUser("No computer");
    await expect(
      fixture.store.createBrowserProfile({
        ownerId: unhomedOwner,
        name: "No home",
        idempotencyKey: "no-home",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
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

  it("lists unplaced Personal profiles without assigning their home at enrollment", async ({
    storeFixture: fixture,
  }) => {
    await fixture.store.ensureDeployment({
      canonicalOrigin: "http://127.0.0.1:4310",
      hostInstanceId: createId("hostInstance"),
      deploymentShape: { kind: "personal", defaultWorkspaceBacking: "local-directory" },
    });
    const ownerId = await fixture.store.createUser("Owner");
    const profileIds = [createId("browserProfile"), createId("browserProfile")];
    await fixture.database
      .insertInto("browserProfiles")
      .values(profileIds.map((id) => ({ id, ownerId, name: "Legacy", archivedAt: null })))
      .execute();
    const unplaced = profileIds.map((id) => ({ id, ownerId, name: "Legacy", homeRunnerId: null }));
    expect(await fixture.store.listBrowserProfiles(ownerId)).toEqual(unplaced);
    expect(await fixture.store.getBrowserProfile(profileIds[0]!, ownerId)).toEqual(unplaced[0]);
    const otherOwner = await fixture.store.createUser("Other owner");
    expect(await fixture.store.listBrowserProfiles(otherOwner)).toEqual([]);
    expect(await fixture.store.getBrowserProfile(profileIds[0]!, otherOwner)).toBeNull();
    const runnerId = createId("runner");
    await enrollTestRunner(fixture.store, {
      createdBy: null,
      runnerId,
      environmentId: createId("environment"),
      allowedModules: ["agents", "browser"],
      name: "Main",
      tokenSuffix: "late-main",
    });
    expect(await fixture.store.listBrowserProfiles(ownerId)).toEqual(unplaced);
    const deployment = (await fixture.store.getDeployment())!;
    await fixture.store.bindBrowserProfile(binding(deployment.id, runnerId, profileIds[0]!));
    expect(await fixture.store.getBrowserProfile(profileIds[0]!, ownerId)).toEqual({
      ...unplaced[0],
      homeRunnerId: runnerId,
    });
    expect(await fixture.store.getBrowserProfile(profileIds[1]!, ownerId)).toEqual(unplaced[1]);
  });

  it("adopts a legacy server home once and atomically refuses a competing first open", async ({
    storeFixture: fixture,
  }) => {
    const run = await setup(fixture);
    const other = await computer(fixture, run.userId);
    const profile = await fixture.store.createBrowserProfile({
      ownerId: run.userId,
      name: "Legacy",
      homeRunnerId: run.runnerId,
      idempotencyKey: "legacy",
    });
    await fixture.database
      .updateTable("browserProfiles")
      .set({ homeRunnerId: null })
      .where("id", "=", profile.id)
      .execute();
    const results = await Promise.allSettled(
      [run.runnerId, other].map((runnerId) =>
        fixture.store.bindBrowserProfile(binding(run.deploymentId, runnerId, profile.id)),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const storage = await fixture.store.getBrowserProfileStorage(profile.id);
    expect(storage.kind).toBe("local");
    if (storage.kind !== "local") throw new Error("Legacy profile was not bound");
    expect((await fixture.store.getBrowserProfile(profile.id, run.userId))?.homeRunnerId).toBe(
      storage.binding.runnerId,
    );
  });

  it("removes all homed profiles with history, grants, saved tabs and terminal unconfirmed erasure", async ({
    storeFixture: fixture,
  }) => {
    const run = await setup(fixture);
    const home = await computer(fixture, run.userId);
    const project = await fixture.createProjectWorkspace(run.userId, "homes-removal");
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
      await fixture.store.createBrowserProfileGrant({
        profileId: profile.id,
        createdBy: run.userId,
        workspaceId: project.id,
        access: "read-write",
      });
      const sessionId = createBrowserSessionId();
      await fixture.store.createBrowserSession({
        id: sessionId,
        runnerId: home,
        origin: "workspace",
        profileId: profile.id,
        placementKey: `runner:${home}`,
        runtimeId: "browser",
        workspaceId: run.workspace.id,
      });
      await fixture.database
        .insertInto("workspaceTabs")
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
    expect(await fixture.store.listActiveBrowserProfileGrants(run.userId)).toEqual([]);
    expect(await fixture.database.selectFrom("workspaceTabs").select("closedAt").execute()).toEqual(
      [{ closedAt: expect.any(Date) }, { closedAt: expect.any(Date) }],
    );
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
    "removes a computer's profiles with its %s Run",
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
      const project = await fixture.createProjectWorkspace(run.userId, "executing-home");
      await fixture.store.createBrowserProfileGrant({
        profileId: profile.id,
        createdBy: run.userId,
        workspaceId: project.id,
        access: "read-write",
      });
      const sessionId = createBrowserSessionId();
      await fixture.store.createBrowserSession({
        id: sessionId,
        runnerId: run.runnerId,
        profileId: profile.id,
        origin: "workspace",
        runtimeId: "browser",
        placementKey: `runner:${run.runnerId}`,
        workspaceId: run.workspace.id,
      });
      await fixture.store.attachBrowserSession({
        agentBindingId: "trigger:home",
        ownerId: run.userId,
        workspaceId: run.workspace.id,
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
      const removed = await fixture.store.revokeRunner(run.runnerId, run.userId, {
        allowDeployment: true,
      });
      expect(removed.deletedBrowserProfiles).toEqual([{ id: profile.id, ownerId: run.userId }]);
      expect(
        (
          await fixture.database
            .selectFrom("runs")
            .select("status")
            .where("id", "=", runId)
            .executeTakeFirst()
        )?.status,
      ).toBe("failed");
      expect(await fixture.store.listActiveBrowserProfileGrants(run.userId)).toEqual([]);
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
                  origin: "workspace",
                  runtimeId: "browser",
                  placementKey: `runner:${home}`,
                  workspaceId: run.workspace.id,
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
