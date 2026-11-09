import { createId, type RunnerId, type UserId } from "@opensteer/core";
import {
  describeStore,
  enrollTestRunner,
  pendingEvent,
  testContinuationIdentity,
  type StoreFixture,
} from "@opensteer/database/test-support/store";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { BrowserService, type BrowserRuntimePlacement } from "./browser-service.js";
import { BrowserLocalProfiles } from "./browser-local-profiles.js";

async function setup(fixture: StoreFixture, personal = false) {
  const run = await fixture.createRunFixture(
    "host-homes",
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
  if (personal) await fixture.enablePersonalRemoteAccess();
  return run;
}

async function computer(fixture: StoreFixture, ownerId: UserId, personal = false) {
  const runnerId = createId("runner");
  await enrollTestRunner(fixture.store, {
    createdBy: ownerId,
    environmentId: createId("environment"),
    runnerId,
    runnerKind: "local",
    name: "Mac mini",
    tokenSuffix: runnerId,
    allowedModules: personal ? ["browser", "integrations", "messaging", "shell"] : ["browser"],
    modules: { browser: { runtimeId: runnerId, wireVersion: 2 } },
  });
  return runnerId;
}

function service(fixture: StoreFixture, options: { personal?: boolean; runnerId?: RunnerId } = {}) {
  const placements: BrowserRuntimePlacement[] = [];
  const browser = new BrowserService({
    hostOrigin: new URL("https://host.test"),
    repository: fixture.store,
    signer: {} as never,
    personal: options.personal === true,
    localProfiles: new BrowserLocalProfiles({
      deploymentId: createId("deployment"),
      baseUrl: new URL("https://host.test"),
      repository: fixture.store,
    }),
    profileRequestRunner: async () => options.runnerId ?? null,
    onSessionsChanged: () => undefined,
    onWorkspaceEvent: () => undefined,
    targetResolver: { placements: () => placements, resolve: () => undefined },
  });
  return { browser, placements };
}

describeStore("Host browser homes", (it) => {
  it.for([false, true])(
    "defaults older profile creation and preserves the first home on replay (Personal=%s)",
    async (personal, { storeFixture: fixture }) => {
      const run = await setup(fixture, personal);
      const { browser } = service(fixture, { personal });
      try {
        const input = { ownerId: run.userId, name: "Work", idempotencyKey: "older-client" };
        const profile = await browser.createProfile(input);
        expect(profile.homeRunnerId).toBe(run.runnerId);
        const second = await computer(fixture, run.userId, personal);
        expect(await browser.createProfile(input)).toEqual(profile);
        await expect(
          browser.createProfile({ ...input, homeRunnerId: second }),
        ).rejects.toMatchObject({ code: "conflict" });
        if (personal) {
          expect(
            (await browser.createProfile({ ...input, idempotencyKey: "new" })).homeRunnerId,
          ).toBe(run.runnerId);
        } else {
          await expect(
            browser.createProfile({ ...input, idempotencyKey: "new" }),
          ).rejects.toMatchObject({ reason: "browser-placement-ambiguous" });
        }
        expect(
          (
            await browser.createProfile({
              ...input,
              idempotencyKey: "explicit",
              homeRunnerId: second,
            })
          ).homeRunnerId,
        ).toBe(second);
      } finally {
        await browser.close();
      }
    },
  );

  it("lists offline eligible homes, hides another member's computer, and follows removal", async ({
    storeFixture: fixture,
  }) => {
    const run = await setup(fixture);
    const other = await fixture.store.createUser("Other member");
    await sql`insert into workspace_memberships (id,workspace_id,user_id,role,state) values (${createId("workspaceMembership")},${run.workspace.id},${other},'collaborator','active')`.execute(
      fixture.database,
    );
    const { browser, placements } = service(fixture);
    try {
      expect((await browser.bootstrap(run.userId)).profileHomes).toEqual([run.runnerId]);
      const home = await computer(fixture, run.userId);
      const foreign = await computer(fixture, other);
      placements.push({
        available: true,
        agents: true,
        kind: "runner",
        runnerId: foreign,
        runtimeId: "foreign",
        label: "Other member's Mac",
        environmentIds: [run.environmentId],
      });
      const bootstrap = await browser.bootstrap(run.userId);
      expect(bootstrap.profileHomes?.sort()).toEqual([run.runnerId, home].sort());
      expect(bootstrap.placements).toEqual([]);
      expect(bootstrap.available).toBe(false);
      const profile = await browser.createProfile({
        ownerId: run.userId,
        name: "Work",
        homeRunnerId: home,
        idempotencyKey: "home",
      });
      await fixture.store.bindBrowserProfile({
        version: 1,
        deploymentId: (await fixture.store.getDeployment())!.id,
        runnerId: home,
        profileId: profile.id,
        storageInstanceId: randomUUID(),
        bindingId: randomUUID(),
        engine: "chromium",
      });
      await expect(
        browser.openTab(run.userId, {
          type: "browser.tab.open",
          identity: { kind: "profile", profileId: profile.id },
          idempotencyKey: "offline",
        }),
      ).rejects.toMatchObject({
        reason: "browser-profile-home-unavailable",
        details: { runnerId: home, name: "Mac mini" },
      });
      await expect(
        browser.openTab(run.userId, {
          type: "browser.tab.open",
          identity: { kind: "guest" },
          placement: { kind: "runner", runnerId: foreign },
          idempotencyKey: "foreign",
        }),
      ).rejects.toMatchObject({
        reason: "browser-placement-unavailable",
        details: { placements: [] },
      });
      await expect(
        browser.openAgentSession({
          agentBindingId: `run:${createId("run")}`,
          ownerId: run.userId,
          workspaceId: run.workspace.id,
          fresh: true,
        }),
      ).rejects.toMatchObject({ code: "workspace_unavailable" });
      await fixture.store.revokeRunner(home, run.userId);
      expect(
        await fixture.database
          .selectFrom("browserProfileDeletions")
          .select(["state", "deletedAt"])
          .where("profileId", "=", profile.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "unconfirmed", deletedAt: null });
      const removed = await browser.bootstrap(run.userId);
      expect(removed.profileHomes).toEqual([run.runnerId]);
      expect(removed.profiles).toEqual([]);
      expect(removed.profileDeletions ?? []).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it.for(["run", "main", "explicit", "ambiguous", "unavailable-run"] as const)(
    "places an approved profile using %s",
    async (choice, { storeFixture: fixture }) => {
      const personal = choice === "main";
      const run = await setup(fixture, personal);
      const turn = await fixture.enqueueHumanTrigger({
        content: [{ type: "text", text: "Start work" }],
        idempotencyKey: "approval-run",
        requestedBy: run.userId,
        threadId: run.thread.id,
      });
      await fixture.store.claimCommand(turn.command.id, "approval-dispatcher");
      const binding = await fixture.store.acquireExecutionBinding({
        bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
        continuationIdentity: testContinuationIdentity,
        harnessInstanceId: run.harnessInstance.id,
        leaseTokenHash: "approval-lease",
        membershipGeneration: 1,
        runnerBootId: "approval-boot",
        runnerId: run.runnerId,
        runId: turn.run.id,
        threadId: run.thread.id,
      });
      await fixture.store.commitRunnerEvent({
        environmentId: run.environmentId,
        event: pendingEvent({
          bindingGeneration: binding.bindingGeneration,
          data: { status: "running" },
          environmentId: run.environmentId,
          ordinal: 0,
          runId: turn.run.id,
          threadId: run.thread.id,
          type: "run.started",
          workspaceId: run.workspace.id,
        }),
        runnerBootId: "approval-boot",
        runnerId: run.runnerId,
      });
      const home = await computer(fixture, run.userId, personal);
      if (choice === "unavailable-run")
        await fixture.database
          .updateTable("runners")
          .set({ allowedModules: sql`'["agents"]'::jsonb` })
          .where("id", "=", run.runnerId)
          .execute();
      const { browser } = service(fixture, {
        personal,
        ...(choice === "run"
          ? { runnerId: home }
          : choice === "unavailable-run"
            ? { runnerId: run.runnerId }
            : {}),
      });
      try {
        const request = await browser.requestAccess({
          callId: "profile",
          ownerId: run.userId,
          runId: turn.run.id,
          threadId: run.thread.id,
          originatingWorkspaceId: run.workspace.id,
          workspaceId: run.workspace.id,
          reason: "Separate work identity",
          suggestion: { kind: "new", suggestedName: "Work" },
        });
        const response = {
          kind: "external" as const,
          value: {
            decision: "fulfilled",
            createProfile: {
              name: "Work",
              ...(choice === "explicit" ? { homeRunnerId: home } : {}),
            },
          },
        };
        const resolution = browser.resolveRequest({
          requestId: request.requestId,
          resolvedBy: run.userId,
          response,
        });
        if (choice === "ambiguous" || choice === "unavailable-run") {
          await expect(resolution).rejects.toMatchObject({ reason: "browser-placement-ambiguous" });
          expect((await fixture.store.requests.get(request.requestId))?.status).toBe("pending");
        } else {
          expect((await resolution).profile?.homeRunnerId).toBe(
            choice === "main" ? run.runnerId : home,
          );
        }
      } finally {
        await browser.close();
      }
    },
  );

  it("filters agent profiles by grants and reports the home independently of the Run's computer", async ({
    storeFixture: fixture,
  }) => {
    const run = await fixture.createRunFixture("agent-homes", null, "project");
    await fixture.database
      .updateTable("runners")
      .set({ allowedModules: sql`'["agents","browser"]'::jsonb` })
      .where("id", "=", run.runnerId)
      .execute();
    const home = await computer(fixture, run.userId);
    const { browser, placements } = service(fixture);
    try {
      const profile = await browser.createProfile({
        ownerId: run.userId,
        name: "Work",
        homeRunnerId: home,
        idempotencyKey: "work",
      });
      await browser.createProfile({
        ownerId: run.userId,
        name: "Private",
        homeRunnerId: run.runnerId,
        idempotencyKey: "private",
      });
      await fixture.store.createBrowserProfileGrant({
        access: "read-write",
        createdBy: run.userId,
        profileId: profile.id,
        workspaceId: run.workspace.id,
      });
      expect(await browser.listGrantedProfiles(run.userId, run.workspace.id)).toEqual([
        expect.objectContaining({
          id: profile.id,
          home: { runnerId: home, name: "Mac mini", reachable: false },
        }),
      ]);
      placements.push({
        available: true,
        agents: false,
        kind: "runner",
        runnerId: home,
        runtimeId: "home",
        label: "Mac mini",
        environmentIds: [],
      });
      expect(await browser.listGrantedProfiles(run.userId, run.workspace.id)).toEqual([
        expect.objectContaining({ home: { runnerId: home, name: "Mac mini", reachable: true } }),
      ]);
      const grant = (await fixture.store.listActiveBrowserProfileGrants(run.userId))[0]!;
      await fixture.store.revokeBrowserProfileGrant(grant.grantId, run.userId);
      expect(await browser.listGrantedProfiles(run.userId, run.workspace.id)).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
