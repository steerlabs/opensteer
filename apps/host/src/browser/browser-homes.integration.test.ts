import { createId, type RunnerId, type ThreadId, type UserId } from "@opensteer/core";
import {
  describeStore,
  enrollTestRunner,
  pendingEvent,
  testContinuationIdentity,
  testModelSelection,
  type StoreFixture,
} from "@opensteer/database/test-support/store";
import { RealtimeHub } from "@opensteer/orchestration";
import { createBrowserSessionId, type HostToClientMessage } from "@opensteer/protocol";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { announceBrowserUsage } from "./browser-presence.js";
import { BrowserService, type BrowserRuntimePlacement } from "./browser-service.js";
import { BrowserLocalProfiles } from "./browser-local-profiles.js";
import { browserAccessResponse } from "@opensteer/client/host";

async function setup(fixture: StoreFixture) {
  const run = await fixture.createRunFixture("host-homes");
  await fixture.database
    .updateTable("runners")
    .set({ allowedModules: sql`'["agents","browser","messaging"]'::jsonb` })
    .where("id", "=", run.runnerId)
    .execute();
  await fixture.enablePersonalRemoteAccess();
  return run;
}

async function computer(fixture: StoreFixture, ownerId: UserId) {
  const runnerId = createId("runner");
  await enrollTestRunner(fixture.store, {
    createdBy: ownerId,
    environmentId: createId("environment"),
    runnerId,
    runnerKind: "local",
    name: "Mac mini",
    tokenSuffix: runnerId,
    allowedModules: ["browser", "integrations", "messaging", "shell"],
    modules: { browser: { runtimeId: runnerId, wireVersion: 2 } },
  });
  return runnerId;
}

function service(fixture: StoreFixture, options: { personal?: boolean; runnerId?: RunnerId } = {}) {
  const placements: BrowserRuntimePlacement[] = [];
  const browser = new BrowserService({
    deploymentId: createId("deployment"),
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

    targetResolver: { placements: () => placements, resolve: () => undefined },
  });
  return { browser, placements };
}

describeStore("Host browser homes", (it) => {
  it("replays an unplaced Personal profile before and after its first binding", async ({
    storeFixture: fixture,
  }) => {
    const run = await setup(fixture);
    await fixture.database
      .updateTable("runners")
      .set({ allowedModules: sql`'["agents","integrations","messaging","shell"]'::jsonb` })
      .where("id", "=", run.runnerId)
      .execute();
    const home = await computer(fixture, run.userId);
    await computer(fixture, run.userId);
    const { browser } = service(fixture, { personal: true });
    const input = { ownerId: run.userId, name: "Legacy", idempotencyKey: "legacy-personal" };
    try {
      const profile = await browser.createProfile(input);
      expect(profile.homeRunnerId).toBeNull();
      expect(await browser.createProfile(input)).toEqual(profile);
      await expect(
        browser.createProfile({ ...input, homeRunnerId: null, idempotencyKey: "aware-personal" }),
      ).rejects.toMatchObject({ reason: "browser-placement-ambiguous" });
      await fixture.store.bindBrowserProfile({
        version: 1,
        deploymentId: (await fixture.store.getDeployment())!.id,
        runnerId: home,
        profileId: profile.id,
        storageInstanceId: randomUUID(),
        bindingId: randomUUID(),
        engine: "chromium",
      });
      expect(await browser.createProfile(input)).toEqual({ ...profile, homeRunnerId: home });
    } finally {
      await browser.close();
    }
  });
  it.for(
    [0, 1, 2].flatMap((count) =>
      (["absent", "null", "id"] as const).flatMap((presence) =>
        (["create", "approve"] as const).map((mode) => ({ count, presence, mode })),
      ),
    ),
  )(
    "resolves $mode with $count homes and $presence",
    async ({ count, presence, mode }, { storeFixture: fixture }) => {
      const run = await setup(fixture);
      await fixture.database
        .updateTable("runners")
        .set({ allowedModules: sql`'["agents"]'::jsonb` })
        .where("id", "=", run.runnerId)
        .execute();
      const homes: RunnerId[] = [];
      for (let index = 0; index < count; index++) homes.push(await computer(fixture, run.userId));
      const { browser } = service(fixture, { runnerId: run.runnerId });
      const selection =
        presence === "absent"
          ? {}
          : { homeRunnerId: presence === "null" ? null : (homes[0] ?? run.runnerId) };
      const expected = presence === "id" ? homes[0] : count === 1 ? homes[0] : null;
      const verify = async (result: Promise<{ homeRunnerId: RunnerId | null } | null>) => {
        if (count === 0)
          await expect(result).rejects.toMatchObject({
            code: presence === "id" ? "forbidden" : "runner_offline",
          });
        else if (count === 2 && presence === "null")
          await expect(result).rejects.toMatchObject({ reason: "browser-placement-ambiguous" });
        else await expect(result).resolves.toMatchObject({ homeRunnerId: expected });
      };
      try {
        if (mode === "create") {
          await verify(
            browser.createProfile({
              ...selection,
              ownerId: run.userId,
              name: "Created",
              idempotencyKey: "presence",
            }),
          );
          return;
        }
        const turn = await fixture.enqueueHumanTrigger({
          content: [{ type: "text", text: "Start work" }],
          idempotencyKey: "presence-run",
          requestedBy: run.userId,
          threadId: run.thread.id,
        });
        await fixture.store.claimCommand(turn.command.id, "presence-dispatcher");
        const binding = await fixture.store.acquireExecutionBinding({
          bindingLeaseExpiresAt: new Date(Date.now() + 60_000),
          continuationIdentity: testContinuationIdentity,
          harnessInstanceId: run.harnessInstance.id,
          leaseTokenHash: "presence-lease",

          runnerBootId: "presence-boot",
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
          }),
          runnerBootId: "presence-boot",
          runnerId: run.runnerId,
        });
        const request = await browser.requestAccess({
          callId: "presence",
          ownerId: run.userId,
          runId: turn.run.id,
          threadId: run.thread.id,

          reason: "Separate work identity",
          suggestion: { kind: "new", suggestedName: "Approved" },
        });
        await verify(
          browser
            .resolveRequest({
              requestId: request.requestId,
              expectedRevision: (await fixture.store.requests.revision(request.requestId))!,
              resolvedBy: run.userId,
              response: {
                kind: "external",
                value: { decision: "fulfilled", createProfile: { name: "Approved", ...selection } },
              },
            })
            .then(({ profile }) =>
              profile ? { homeRunnerId: profile.homeRunnerId ?? null } : null,
            ),
        );
      } finally {
        await browser.close();
      }
    },
  );

  it.for([true])(
    "defaults older profile creation and preserves the first home on replay (Personal=%s)",
    async (personal, { storeFixture: fixture }) => {
      const run = await setup(fixture);
      const { browser } = service(fixture, { personal });
      try {
        const input = { ownerId: run.userId, name: "Work", idempotencyKey: "older-client" };
        const profile = await browser.createProfile(input);
        expect(profile.homeRunnerId).toBe(run.runnerId);
        const second = await computer(fixture, run.userId);
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
            browser.createProfile({ ...input, homeRunnerId: null, idempotencyKey: "new" }),
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

  it("lists offline eligible homes, excludes an unenrolled computer, and follows removal", async ({
    storeFixture: fixture,
  }) => {
    const run = await setup(fixture);

    const { browser, placements } = service(fixture);
    try {
      expect((await browser.workspaceBootstrap(run.userId)).profileHomes).toEqual([run.runnerId]);
      const home = await computer(fixture, run.userId);
      const foreign = createId("runner");
      placements.push({
        available: true,
        agents: true,
        kind: "runner",
        runnerId: foreign,
        runtimeId: "foreign",
        label: "Other member's Mac",
        environmentIds: [run.environmentId],
      });
      const bootstrap = await browser.workspaceBootstrap(run.userId);
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

          fresh: true,
        }),
      ).rejects.toMatchObject({ code: "runner_offline" });
      await fixture.store.revokeRunner(home, run.userId);
      expect(
        await fixture.database
          .selectFrom("browserProfileDeletions")
          .select(["state", "deletedAt"])
          .where("profileId", "=", profile.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "unconfirmed", deletedAt: null });
      const removed = await browser.workspaceBootstrap(run.userId);
      expect(removed.profileHomes).toEqual([run.runnerId]);
      expect(removed.profiles).toEqual([]);
      expect(removed.profileDeletions ?? []).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it.for(["run", "main", "explicit", "ambiguous", "unavailable-run", "no-home"] as const)(
    "places an approved profile using %s",
    async (choice, { storeFixture: fixture }) => {
      const personal = choice === "main";
      const run = await setup(fixture);
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
        }),
        runnerBootId: "approval-boot",
        runnerId: run.runnerId,
      });
      const home = await computer(fixture, run.userId);
      if (choice === "unavailable-run" || choice === "no-home")
        await fixture.database
          .updateTable("runners")
          .set({ allowedModules: sql`'["agents"]'::jsonb` })
          .where("id", "=", run.runnerId)
          .execute();
      if (choice === "no-home")
        await fixture.database
          .updateTable("runners")
          .set({ allowedModules: sql`'["agents"]'::jsonb` })
          .where("id", "=", home)
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

          reason: "Separate work identity",
          suggestion: { kind: "new", suggestedName: "Work" },
        });
        const response = browserAccessResponse(
          { kind: "new" },
          "Work",
          choice === "explicit" ? home : null,
        );
        const resolution = browser.resolveRequest({
          requestId: request.requestId,
          expectedRevision: (await fixture.store.requests.revision(request.requestId))!,
          resolvedBy: run.userId,
          response,
        });
        if (choice === "ambiguous" || choice === "no-home") {
          await expect(resolution).rejects.toMatchObject({
            reason:
              choice === "no-home"
                ? "browser-placement-unavailable"
                : "browser-placement-ambiguous",
          });
          expect((await fixture.store.requests.get(request.requestId))?.status).toBe("pending");
        } else {
          expect((await resolution).profile?.homeRunnerId).toBe(
            choice === "main" ? run.runnerId : home,
          );
          if (choice === "unavailable-run")
            expect(
              (
                await browser.createProfile({
                  ownerId: run.userId,
                  name: "Ordinary",
                  idempotencyKey: "ordinary",
                })
              ).homeRunnerId,
            ).toBe(home);
        }
      } finally {
        await browser.close();
      }
    },
  );

  it("lists the owner's agent profiles and reports the home independently of the Run's computer", async ({
    storeFixture: fixture,
  }) => {
    const run = await setup(fixture);
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
      expect(await browser.listAgentProfiles(run.userId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: profile.id,
            home: { runnerId: home, name: "Mac mini", reachable: false },
          }),
        ]),
      );
      placements.push({
        available: true,
        agents: false,
        kind: "runner",
        runnerId: home,
        runtimeId: "home",
        label: "Mac mini",
        environmentIds: [],
      });
      expect(await browser.listAgentProfiles(run.userId)).toEqual([
        expect.objectContaining({
          name: "Work",
          home: { runnerId: home, name: "Mac mini", reachable: true },
        }),
        expect.objectContaining({
          name: "Private",
          home: { runnerId: run.runnerId, name: "Hosting computer", reachable: false },
        }),
      ]);
      await browser.deleteProfile({ ownerId: run.userId, profileId: profile.id });
      expect(await browser.listAgentProfiles(run.userId)).toEqual([
        expect.objectContaining({
          name: "Private",
          home: expect.objectContaining({ runnerId: run.runnerId }),
        }),
      ]);
    } finally {
      await browser.close();
    }
  });

  it("publishes host.browser-usage-changed through RealtimeHub for exactly the observed threads referencing an archived profile", async ({
    storeFixture: fixture,
  }) => {
    const run = await setup(fixture);
    const realtime = new RealtimeHub();
    const browser = new BrowserService({
      deploymentId: createId("deployment"),
      hostOrigin: new URL("https://host.test"),
      repository: fixture.store,
      signer: {} as never,
      personal: true,
      localProfiles: new BrowserLocalProfiles({
        deploymentId: createId("deployment"),
        baseUrl: new URL("https://host.test"),
        repository: fixture.store,
      }),
      onSessionsChanged: () => undefined,
      onUsageChanged: (credits) => announceBrowserUsage(realtime, credits),
      targetResolver: { placements: () => [], resolve: () => undefined },
    });
    const makeThread = async (title: string) =>
      (
        await fixture.store.createThread({
          createdBy: run.userId,
          environmentId: run.environmentId,
          harnessInstanceId: run.harnessInstance.id,
          idempotencyKey: `archive-notice-${title}-${randomUUID()}`,
          modelSelection: testModelSelection,
          title,
        })
      ).thread.id;
    const affectedThreadA = await makeThread("Affected A");
    const affectedThreadB = await makeThread("Affected B");
    const unaffectedThread = await makeThread("Unaffected");
    const observe = (threadIds: readonly ThreadId[]) => {
      const observed = new Set(threadIds);
      const messages: HostToClientMessage[] = [];
      const unregister = realtime.registerConnection({
        userId: run.userId,
        sessionId: createId("authSession"),
        sync: {
          attached: true,
          wake: () => undefined,
          observesThread: (id: string) => observed.has(id as ThreadId),
        } as never,
        sink: {
          id: randomUUID(),
          send: async (message) => {
            messages.push(message);
          },
          close: () => undefined,
        },
      });
      return { messages, unregister };
    };
    const viewerAffected = observe([affectedThreadA, affectedThreadB]);
    const viewerUnaffected = observe([unaffectedThread]);
    try {
      const archivedProfile = await fixture.store.createBrowserProfile({
        ownerId: run.userId,
        name: "Work",
        homeRunnerId: run.runnerId,
        idempotencyKey: "archive-notice-work",
      });
      const keptProfile = await fixture.store.createBrowserProfile({
        ownerId: run.userId,
        name: "Personal",
        homeRunnerId: run.runnerId,
        idempotencyKey: "archive-notice-personal",
      });
      const insertSession = async (
        profileId: typeof archivedProfile.id,
        state: "ready" | "closed",
      ) => {
        const sessionId = createBrowserSessionId();
        await sql`insert into browser_sessions(id,tab_group_id,origin,profile_id,placement_key,runner_id,runtime_id,state)
          values(${sessionId},${sessionId},'person',${profileId},'personal',${run.runnerId},'browser',${state})`.execute(
          fixture.database,
        );
        return sessionId;
      };
      const sessionClosed = await insertSession(archivedProfile.id, "closed");
      const sessionReady = await insertSession(archivedProfile.id, "ready");
      const sessionKept = await insertSession(keptProfile.id, "ready");
      await fixture.store.recordBrowserSessionUse({
        ownerId: run.userId,
        sessionId: sessionClosed,
        threadId: affectedThreadA,
        page: { site: "https://a.example", title: "A" },
      });
      await fixture.store.recordBrowserSessionUse({
        ownerId: run.userId,
        sessionId: sessionReady,
        threadId: affectedThreadB,
        page: { site: "https://b.example", title: "B" },
      });
      await fixture.store.recordBrowserSessionUse({
        ownerId: run.userId,
        sessionId: sessionKept,
        threadId: unaffectedThread,
        page: { site: "https://kept.example", title: "Kept" },
      });

      expect(
        await fixture.store.getThreadBrowserUsage({
          ownerId: run.userId,
          threadId: affectedThreadA,
          runIds: [],
        }),
      ).not.toEqual([]);
      expect(
        await fixture.store.getThreadBrowserUsage({
          ownerId: run.userId,
          threadId: affectedThreadB,
          runIds: [],
        }),
      ).not.toEqual([]);

      await browser.deleteProfile({ ownerId: run.userId, profileId: archivedProfile.id });

      expect(viewerAffected.messages).toHaveLength(1);
      expect(viewerAffected.messages[0]).toMatchObject({
        type: "host.browser-usage-changed",
      });
      expect(
        [
          ...(
            viewerAffected.messages[0] as Extract<
              HostToClientMessage,
              { type: "host.browser-usage-changed" }
            >
          ).threadIds,
        ].sort(),
      ).toEqual([affectedThreadA, affectedThreadB].sort());
      expect(viewerUnaffected.messages).toEqual([]);

      expect(
        await fixture.store.getThreadBrowserUsage({
          ownerId: run.userId,
          threadId: affectedThreadA,
          runIds: [],
        }),
      ).toEqual([]);
      expect(
        await fixture.store.getThreadBrowserUsage({
          ownerId: run.userId,
          threadId: affectedThreadB,
          runIds: [],
        }),
      ).toEqual([]);
      expect(
        await fixture.store.getThreadBrowserUsage({
          ownerId: run.userId,
          threadId: unaffectedThread,
          runIds: [],
        }),
      ).not.toEqual([]);
    } finally {
      viewerAffected.unregister();
      viewerUnaffected.unregister();
      await browser.close();
    }
  });
});
