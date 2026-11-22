import { createId, type RequestId } from "@opensteer/core";
import { sql } from "kysely";
import { expect, vi } from "vitest";
import { AutomationFailureStore } from "./automation-failure-store.js";
import { expiredPersonalSignInRequests, nextPersonalRequestDeadline } from "./request-deadlines.js";
import { TriggerStore } from "./trigger-store.js";
import { describeStore, testMessagingRunnerId } from "./store.integration.test-support.js";

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
          .updateTable("bridgeDeliveries")
          .set({ nextAttemptAt: databaseAt(5) })
          .where("id", "=", id)
          .execute();
        expect(await channels.claimDelivery(testMessagingRunnerId)).toBeNull();
        await database
          .updateTable("bridgeDeliveries")
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
        const deadline = (await channels.nextIngressDeadline(new Date()))!.getTime();
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
        const due = (await store.requests.nextContinuationDeadline(
          retryMs,
          new Set(),
          new Date(),
        ))!.getTime();
        expect(due).toBeLessThanOrEqual(Date.now());
        expect(due).toBeGreaterThan(Date.now() - 5_000);
        await attempted(hostAt(-5_000));
        const later = (await store.requests.nextContinuationDeadline(
          retryMs,
          new Set(),
          new Date(),
        ))!.getTime();
        expect(later - Date.now()).toBeGreaterThan(retryMs - 10_000);
        expect(later - Date.now()).toBeLessThanOrEqual(retryMs - 5_000 + 1_000);
      });
    });
  }
});
