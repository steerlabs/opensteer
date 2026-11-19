import { createId, TeamMessageIdSchema, type RequestId } from "@opensteer/core";
import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { AutomationFailureStore } from "./automation-failure-store.js";
import { refreshTeamAskAttention } from "./personal-attention-store.js";
import { buildPersonalShellSnapshot } from "./personal-snapshot-store.js";
import { authorizedSyncState, withPersonalSyncRead } from "./personal-sync-store.js";
import { commitPersonalMutation } from "./personal-mutation.js";
import { expiredPersonalSignInRequests, nextPersonalRequestDeadline } from "./request-deadlines.js";
import { TriggerStore } from "./trigger-store.js";
import { TeamAccessStore } from "./team-access-store.js";
import { TeamChatStore } from "./team-chat-store.js";
import { createTeamKnowledgeFixture } from "./team-knowledge.test-support.js";
import { TeamRequestsStore } from "./team-requests-store.js";
import {
  describeStore,
  testMessagingRunnerId,
  type StoreFixture,
} from "./store.integration.test-support.js";
import { PersonalTeamRequestsStore } from "./personal-team-requests-store.js";
import { admitTeamTaskRequest } from "./task-admission-store.js";

/**
 * Runs `work` with the Host's clock offset from PostgreSQL's: only `Date` is faked, so SQL clock
 * functions keep real time. Each owner stamps a due and a not-yet-due row on its own clock, 5 s
 * either side of now; an owner that compares on the other clock flips one of them.
 */
async function withHostClockOffset(offsetMs: number, work: () => Promise<void>) {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + offsetMs, shouldAdvanceTime: true });
  try {
    await work();
  } finally {
    vi.useRealTimers();
  }
}
const hostAt = (deltaMs: number) => new Date(Date.now() + deltaMs);
const databaseAt = (deltaSeconds: number) =>
  sql<Date>`statement_timestamp() + ${deltaSeconds} * interval '1 second'`;

async function teamLink(database: StoreFixture["database"]) {
  const teamId = createId("deployment");
  const linkId = crypto.randomUUID();
  await database
    .insertInto("personalTeamLinks")
    .values({
      id: linkId,
      teamDeploymentId: teamId,
      teamHostInstanceId: createId("hostInstance"),
      hostKeyFingerprint: "fixture",
      approvedOrigin: "https://team.example.invalid",
      authorityEnvelope: {},
      remoteLinkId: "remote" as never,
      state: "active",
    })
    .execute();
  return { teamId, linkId };
}

async function teamRequest(
  database: StoreFixture["database"],
  personal: Awaited<ReturnType<StoreFixture["createRunFixture"]>>,
  teamId: Parameters<typeof admitTeamTaskRequest>[1]["origin"]["teamId"],
) {
  const team = { teamId };
  const requestId = createId("teamAgentRequest");
  const threadRootId = TeamMessageIdSchema.parse("1");
  const channelId = createId("teamChannel");
  await admitTeamTaskRequest(database, {
    bodyMarkdown: "Team ask",
    origin: { teamId: team.teamId, channelId, threadRootId },
    requestId,
    triggerMessageId: threadRootId,
    source: {
      teamId: team.teamId,
      channelId,
      threadRootId,
      messageId: threadRootId,
      audience: {
        teamName: "Acme",
        channelName: "Support",
        channelKind: "private",
        memberCount: 2,
        peopleOnly: false,
      },
    },
    ownerId: personal.userId,
    execution: {
      environmentId: personal.environmentId,
      harnessInstanceId: personal.harnessInstance.id,
      modelSelection: personal.thread.modelSelection,
    },
  });
  return requestId;
}

describeStore("Host and PostgreSQL clocks 30 s apart", (it) => {
  for (const offset of [30_000, -30_000]) {
    const side = offset > 0 ? "Host ahead" : "Host behind";

    it(`deliveries: due is claimed at once, not-yet-due is not (${side})`, async ({
      storeFixture,
    }) => {
      const { createChannelDeliveryFixture, insertChannelDelivery, database } = storeFixture;
      const { channels, configured, conversationId } = await createChannelDeliveryFixture(
        `skew-delivery-${offset}`,
      );
      await withHostClockOffset(offset, async () => {
        const id = await insertChannelDelivery({
          accountId: configured.account.id,
          conversationId,
          status: "pending",
        });
        await database
          .updateTable("channelDeliveries")
          .set({ nextAttemptAt: databaseAt(5) })
          .where("id", "=", id)
          .execute();
        expect(await channels.claimDelivery(testMessagingRunnerId)).toBeNull();
        await database
          .updateTable("channelDeliveries")
          .set({ nextAttemptAt: databaseAt(-5) })
          .where("id", "=", id)
          .execute();
        expect((await channels.claimDelivery(testMessagingRunnerId))?.delivery.id).toBe(id);
      });
    });

    it(`ingress: claimed at once, not before its retry, exhausted rows due now (${side})`, async ({
      storeFixture,
    }) => {
      const { createChannelDeliveryFixture, database } = storeFixture;
      const suffix = `skew-ingress-${offset}`;
      const { channels, configured } = await createChannelDeliveryFixture(suffix);
      await withHostClockOffset(offset, async () => {
        const event = {
          accountExternalId: `T-${suffix}`,
          actor: { displayName: "Skew", externalUserId: "U-skew" },
          content: [{ text: "hello", type: "text" as const }],
          conversation: {
            displayName: suffix,
            externalConversationId: `${suffix}-dm`,
            externalScopeId: suffix,
            externalThreadId: null,
            type: "dm" as const,
          },
          eventId: `${suffix}-event`,
          occurredAt: new Date().toISOString(),
          provider: "slack" as const,
          providerMessageId: `${suffix}-message`,
          trigger: "mention" as const,
        };
        const committed = await channels.commitIngress(configured.connection.id, event as never);
        const pending = (nextAttemptAt: Date, attempts: number) =>
          sql`update channel_ingress_events set status = 'pending', attempts = ${attempts},
            claim_owner = null, claim_token_hash = null, claim_expires_at = null,
            next_attempt_at = ${nextAttemptAt} where id = ${committed.ingressId}`.execute(database);
        await pending(hostAt(5_000), 0);
        expect(await channels.claimIngress("worker-skew")).toBeNull();
        await pending(hostAt(-5_000), 0);
        expect((await channels.claimIngress("worker-skew"))?.id).toBe(committed.ingressId);
        await pending(hostAt(3_600_000), 100);
        const deadline = (await channels.nextIngressDeadline())!.getTime();
        expect(deadline).toBeLessThanOrEqual(Date.now());
        expect(deadline).toBeGreaterThan(Date.now() - 5_000);
      });
    });

    it(`automation notices: due listed, not-yet-due waits its database time (${side})`, async ({
      storeFixture,
    }) => {
      const { startRunFixture, startTriggerOccurrence, database } = storeFixture;
      const run = await startRunFixture(`skew-notice-${offset}`);
      const occurrence = await startTriggerOccurrence(run, `skew-notice-${offset}`);
      const notices = new AutomationFailureStore(database);
      await withHostClockOffset(offset, async () => {
        const id = `notice-skew-${offset > 0 ? "ahead" : "behind"}`;
        await database
          .insertInto("automationFailureNotices")
          .values({
            id,
            triggerId: occurrence.triggerId,
            reason: "paused",
            detail: "Skew",
            nextAttemptAt: databaseAt(5),
          } as never)
          .execute();
        expect(await notices.listDue()).toEqual([]);
        const wake = (await notices.nextDeadline())!.getTime() - Date.now();
        expect(wake).toBeGreaterThan(3_000);
        expect(wake).toBeLessThanOrEqual(5_000);
        await database
          .updateTable("automationFailureNotices")
          .set({ nextAttemptAt: databaseAt(-5) })
          .where("id", "=", id)
          .execute();
        expect((await notices.listDue()).map((notice) => notice.id)).toEqual([id]);
      });
    });

    it(`edit leases: an expired lease is released, a live one is kept (${side})`, async ({
      storeFixture,
    }) => {
      const { startRunFixture, store, database } = storeFixture;
      const run = await startRunFixture(`skew-lease-${offset}`);
      await withHostClockOffset(offset, async () => {
        const input = await store.enqueueThreadInput({
          requestedBy: run.userId,
          threadId: run.threadId,
          content: [{ type: "text", text: "Queued" }],
          source: { kind: "human" },
          policy: "queue",
          idempotencyKey: `skew-lease-${offset}`,
        });
        const lease = (expiresAt: Date) =>
          database
            .updateTable("threadInputs")
            .set({
              editLeaseId: createId("message") as never,
              editLeaseSessionId: "session-skew" as never,
              editLeaseDeviceLabel: "Phone",
              editLeaseExpiresAt: expiresAt,
            })
            .where("messageId", "=", input.message.id)
            .execute();
        const held = async () =>
          (
            await database
              .selectFrom("threadInputs")
              .select("editLeaseId")
              .where("messageId", "=", input.message.id)
              .executeTakeFirstOrThrow()
          ).editLeaseId !== null;
        await lease(hostAt(5_000));
        await store.expireThreadInputLeases();
        expect(await held()).toBe(true);
        await lease(hostAt(-5_000));
        await store.expireThreadInputLeases();
        expect(await held()).toBe(false);
      });
    });

    it(`execution leases: an expired binding is recovered, a live one is kept (${side})`, async ({
      storeFixture,
    }) => {
      const { startRunFixture, store, database } = storeFixture;
      const run = await startRunFixture(`skew-binding-${offset}`);
      await withHostClockOffset(offset, async () => {
        const expire = (at: Date) =>
          database
            .updateTable("providerSessions")
            .set({ leaseExpiresAt: at })
            .where("threadId", "=", run.threadId)
            .where("active", "=", true)
            .execute();
        const status = async () =>
          (
            await database
              .selectFrom("runs")
              .select("status")
              .where("id", "=", run.run.id)
              .executeTakeFirstOrThrow()
          ).status;
        await expire(hostAt(5_000));
        expect((await store.nextExecutionDeadline())!.getTime()).toBeGreaterThan(Date.now());
        await store.recoverRunsWithExpiredExecutionBindings(new Date());
        expect(await status()).toBe("running");
        await expire(hostAt(-5_000));
        expect((await store.nextExecutionDeadline())!.getTime()).toBeLessThanOrEqual(Date.now());
        await store.recoverRunsWithExpiredExecutionBindings(new Date());
        expect(await status()).not.toBe("running");
      });
    });

    it(`trigger schedules: a due schedule fires, a future one does not (${side})`, async ({
      storeFixture,
    }) => {
      const { createRunFixture, database } = storeFixture;
      const task = await createRunFixture(`skew-schedule-${offset}`);
      const triggers = new TriggerStore(database);
      await withHostClockOffset(offset, async () => {
        const created = await triggers.create({
          actorThreadId: null,
          anchorThreadId: task.threadId,
          createdBy: task.userId,
          idempotencyKey: `skew-schedule-${offset}`,
          name: "Skew schedule",
          program: {
            toolContractVersion: 5,
            language: "javascript",
            source: "export default async () => null",
          },
          source: {
            kind: "schedule",
            schedule: { expression: "0 9 * * *", kind: "cron", timezone: "UTC" },
          },
        });
        const fireAt = (at: Date) =>
          database
            .updateTable("triggers")
            .set({ nextFireAt: at })
            .where("id", "=", created.trigger.id)
            .execute();
        await fireAt(hostAt(5_000));
        expect((await triggers.claimDueSchedules(new Date())).occurrences).toEqual([]);
        await fireAt(hostAt(-5_000));
        const fired = await triggers.claimDueSchedules(new Date());
        expect(fired.occurrences.map((occurrence) => occurrence.triggerId)).toEqual([
          created.trigger.id,
        ]);
      });
    });

    it(`password sign-in Requests: expired found, open not (${side})`, async ({ storeFixture }) => {
      const { startRunFixture, openLiveRequest, database } = storeFixture;
      const run = await startRunFixture(`skew-signin-${offset}`);
      const requestId = createId("request") as RequestId;
      await openLiveRequest(run, requestId);
      await withHostClockOffset(offset, async () => {
        const expiresAt = (at: Date) =>
          sql`update requests set kind = 'browser.password-sign-in',
            payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{expiresAt}', to_jsonb(${at.toISOString()}::text))
            where id = ${requestId}`.execute(database);
        await expiresAt(hostAt(5_000));
        expect(await expiredPersonalSignInRequests(database, new Date())).toEqual([]);
        expect((await nextPersonalRequestDeadline(database))!.getTime()).toBeGreaterThan(
          Date.now(),
        );
        await expiresAt(hostAt(-5_000));
        expect(
          (await expiredPersonalSignInRequests(database, new Date())).map((r) => r.id),
        ).toEqual([requestId]);
      });
    });

    it(`continuations: an unattempted page is due now, a retried one waits (${side})`, async ({
      storeFixture,
    }) => {
      const { startRunFixture, openLiveRequest, store, database } = storeFixture;
      const run = await startRunFixture(`skew-continuation-${offset}`);
      const requestId = createId("request") as RequestId;
      await openLiveRequest(run, requestId);
      await sql`update runs set phase = 'background' where id = ${run.run.id}`.execute(database);
      await sql`update requests set kind = 'person.question' where id = ${requestId}`.execute(
        database,
      );
      await withHostClockOffset(offset, async () => {
        const attempted = (at: Date | null) =>
          sql`insert into request_continuations(request_id,status,attempted_at)
            values (${requestId},'waiting',${at})
            on conflict (request_id) do update set attempted_at = excluded.attempted_at`.execute(
            database,
          );
        const retryMs = 60_000;
        await attempted(null);
        const due = (await store.requests.nextContinuationDeadline(retryMs, new Set()))!.getTime();
        expect(due).toBeLessThanOrEqual(Date.now());
        expect(due).toBeGreaterThan(Date.now() - 5_000);
        await attempted(hostAt(-5_000));
        const later = (await store.requests.nextContinuationDeadline(
          retryMs,
          new Set(),
        ))!.getTime();
        expect(later - Date.now()).toBeGreaterThan(retryMs - 10_000);
        expect(later - Date.now()).toBeLessThanOrEqual(retryMs - 5_000 + 1_000);
      });
    });

    it(`team posts: a post just written is kept, one past 14 days is pruned (${side})`, async ({
      storeFixture,
    }) => {
      const { startRunFixture, database } = storeFixture;
      const run = await startRunFixture(`skew-posts-${offset}`);
      const team = await teamLink(database);
      await withHostClockOffset(offset, async () => {
        const post = (createdAt: ReturnType<typeof databaseAt>) =>
          sql`insert into personal_team_posts(team_deployment_id,client_message_id,local_link_id,
              remote_link_id,run_id,channel_id,target_bindings,mentioned_agent_handles,body_markdown,
              attachment_ids,created_at)
            values (${team.teamId},gen_random_uuid(),${team.linkId},'remote',${run.run.id},'channel',
              '[]','{}','Post','[]',${createdAt}) returning client_message_id`.execute(database);
        const fresh = (await post(databaseAt(-1))).rows[0] as { clientMessageId: string };
        const old = (await post(databaseAt(-15 * 86_400))).rows[0] as { clientMessageId: string };
        await new PersonalTeamRequestsStore(database).prunePosts();
        const kept = await database
          .selectFrom("personalTeamPosts")
          .select("clientMessageId")
          .where("teamDeploymentId", "=", team.teamId)
          .execute();
        expect(kept.map((row) => row.clientMessageId)).toEqual([fresh.clientMessageId]);
        expect(old.clientMessageId).not.toBe(fresh.clientMessageId);
      });
    });

    it(`team-ask consent: an expired ask is found, an open one is not (${side})`, async ({
      storeFixture,
    }) => {
      const { createRunFixture, database } = storeFixture;
      const personal = await createRunFixture(`skew-consent-${offset}`);
      const team = await teamLink(database);
      const requestId = await teamRequest(database, personal, team.teamId);
      const requests = new PersonalTeamRequestsStore(database);
      await withHostClockOffset(offset, async () => {
        const consent = (at: Date) =>
          sql`update personal_team_requests set kind = 'ask', local_decision = null,
            terminal_state = null, consent_expires_at = ${at},
            presentation = jsonb_build_object(
              'asker', jsonb_build_object('teamUserId', ${createId("user")}::text,
                'displayName', 'Maya', 'actor', 'agent'),
              'bodyMarkdown', 'Ask', 'attachments', '[]'::jsonb,
              'destination', jsonb_build_object('teamId', team_deployment_id,
                'channelId', source->>'channelId', 'threadRootId', source->>'threadRootId'),
              'audience', source->'audience')
            where team_deployment_id = ${team.teamId} and request_id = ${requestId}`.execute(
            database,
          );
        await consent(hostAt(5_000));
        expect(await requests.expiredUndecidedAsks()).toEqual([]);
        await consent(hostAt(-5_000));
        expect((await requests.expiredUndecidedAsks()).map((ask) => ask.requestId)).toEqual([
          requestId,
        ]);
      });
    });

    it(`team-ask attention: an attach shows an ask until the Host-clock owner settles it (${side})`, async ({
      storeFixture,
    }) => {
      const { createRunFixture, database } = storeFixture;
      const personal = await createRunFixture(`skew-attention-${offset}`);
      const team = await teamLink(database);
      const requestId = await teamRequest(database, personal, team.teamId);
      const requests = new PersonalTeamRequestsStore(database);
      await withHostClockOffset(offset, async () => {
        const consent = (at: Date) =>
          sql`update personal_team_requests set kind = 'ask', remote_state = 'awaiting_approval',
            local_decision = null, terminal_state = null, consent_expires_at = ${at},
            presentation = jsonb_build_object(
              'asker', jsonb_build_object('teamUserId', ${createId("user")}::text,
                'displayName', 'Maya', 'actor', 'agent'),
              'bodyMarkdown', 'Ask', 'attachments', '[]'::jsonb,
              'destination', jsonb_build_object('teamId', team_deployment_id,
                'channelId', source->>'channelId', 'threadRootId', source->>'threadRootId'),
              'audience', source->'audience')
            where team_deployment_id = ${team.teamId} and request_id = ${requestId}`.execute(
            database,
          );
        const id = `team:${team.teamId}:${requestId}`;
        const expire = async (at: Date) => {
          await consent(at);
          await sql`update personal_attention set expires_at = ${at} where id = ${id}`.execute(
            database,
          );
        };
        const attached = async () =>
          (
            await withPersonalSyncRead(database, async (tx) =>
              buildPersonalShellSnapshot(
                tx,
                await authorizedSyncState(tx, personal.userId),
                personal.userId,
              ),
            )
          ).attention.map((item) => item.id);
        // Open on the Host's clock, so the ask is waiting for the owner.
        await consent(hostAt(60_000));
        await commitPersonalMutation(database, (tx, mutation) =>
          refreshTeamAskAttention(tx, mutation, team.teamId, requestId),
        );
        expect(await attached()).toContain(id);
        // 5 s from expiry on the Host's clock: not due, and the owner wakes then.
        const open = hostAt(5_000);
        await expire(open);
        expect(await attached()).toContain(id);
        expect(await nextPersonalRequestDeadline(database)).toEqual(open);
        expect(await requests.expiredUndecidedAsks()).toEqual([]);
        // Expired 5 s ago on the Host's clock: due, and an attach still reads, showing the ask
        // until the owner settles it.
        const expired = hostAt(-5_000);
        await expire(expired);
        expect(await attached()).toContain(id);
        expect(await nextPersonalRequestDeadline(database)).toEqual(expired);
        expect((await requests.expiredUndecidedAsks()).map((ask) => ask.requestId)).toEqual([
          requestId,
        ]);
      });
    });
  }
});

describe("Team server with its clock 30 s from its PostgreSQL", () => {
  for (const offset of [30_000, -30_000]) {
    const side = offset > 0 ? "Host ahead" : "Host behind";
    it(`a working request's expiry is decided on PostgreSQL's clock (${side})`, async () => {
      const fixture = await createTeamKnowledgeFixture();
      try {
        const access = new TeamAccessStore(fixture.database);
        await access.initialize();
        const chat = new TeamChatStore(access, { teamId: fixture.deploymentId, teamName: "Acme" });
        const requests = new TeamRequestsStore(access, chat);
        const asker = { kind: "human" as const, userId: fixture.userId };
        const targetId = await fixture.member("Alex");
        const { channelId } = await fixture.channel({
          name: "asks",
          kind: "private",
          access: [
            { userId: asker.userId, level: "post", manage: true },
            { userId: targetId, level: "post" },
          ],
        });
        const link = await fixture.link(targetId);
        await chat.send(asker, {
          channelId,
          threadRootId: null,
          clientMessageId: crypto.randomUUID(),
          bodyMarkdown: "@alex-agent help",
          mentions: [],
          attachmentIds: [],
        });
        const ask = (await requests.pending(link))[0]!;
        await requests.accept(link, ask.request.id, "approve");
        // Accepted seven days before the expiry, as the store stamps both on PostgreSQL's clock.
        const expireAt = (deltaSeconds: number) =>
          sql`update team_agent_requests
            set accepted_at = statement_timestamp() + ${deltaSeconds} * interval '1 second'
              - interval '7 days',
              expires_at = statement_timestamp() + ${deltaSeconds} * interval '1 second'
            where id = ${ask.request.id}`.execute(fixture.database);
        await withHostClockOffset(offset, async () => {
          // Five seconds left on PostgreSQL's clock: still working, whatever Node says.
          await expireAt(5);
          expect((await requests.authorize(link, ask.request.id, "post")).state).toBe("working");
          await requests.status(link, ask.request.id, { state: "needs_you", steps: [] });
          // Five seconds past on PostgreSQL's clock: refused, also by a check with no sweep first.
          await expireAt(-5);
          await expect(
            requests.status(link, ask.request.id, { state: "working", steps: [] }),
          ).rejects.toMatchObject({ code: "forbidden" });
          await expect(requests.authorize(link, ask.request.id, "post")).rejects.toMatchObject({
            code: "forbidden",
          });
        });
      } finally {
        await fixture.close();
      }
    });
  }
});
