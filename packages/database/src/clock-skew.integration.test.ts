import { sql } from "kysely";
import { expect, vi } from "vitest";
import { describeStore, testMessagingRunnerId } from "./store.integration.test-support.js";

/**
 * Runs `work` with the Host's clock offset from PostgreSQL's: only `Date` is faked, so SQL
 * clock functions keep real time. A stored instant read on one clock and compared on the
 * other shows up here as work that is due but not claimed, or a deadline off by the offset.
 */
async function withHostClockOffset(offsetMs: number, work: () => Promise<void>) {
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + offsetMs, shouldAdvanceTime: true });
  try {
    await work();
  } finally {
    vi.useRealTimers();
  }
}

const offsets = [30_000, -30_000];

describeStore("Host and PostgreSQL clocks 30 s apart", (it) => {
  for (const offset of offsets) {
    it(`claims a delivery the moment it is enqueued (Host ${offset > 0 ? "ahead" : "behind"})`, async ({
      storeFixture,
    }) => {
      const { createChannelDeliveryFixture, insertChannelDelivery } = storeFixture;
      const { channels, configured, conversationId } = await createChannelDeliveryFixture(
        `skew-delivery-${offset}`,
      );
      await withHostClockOffset(offset, async () => {
        const id = await insertChannelDelivery({
          accountId: configured.account.id,
          conversationId,
          status: "pending",
        });
        expect((await channels.claimDelivery(testMessagingRunnerId))?.delivery.id).toBe(id);
      });
    });

    it(`claims ingress at once and dates exhausted ingress on the Host clock (Host ${offset > 0 ? "ahead" : "behind"})`, async ({
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
        const claimed = await channels.claimIngress("worker-skew");
        expect(claimed?.id).toBe(committed.ingressId);
        // Exhausted ingress is due now; its deadline must not sit on PostgreSQL's clock.
        await sql`update channel_ingress_events set status = 'pending', attempts = 100,
          claim_owner = null, claim_token_hash = null, claim_expires_at = null,
          next_attempt_at = ${new Date(Date.now() + 3_600_000)}
          where id = ${committed.ingressId}`.execute(database);
        const deadline = await channels.nextIngressDeadline();
        expect(deadline!.getTime()).toBeLessThanOrEqual(Date.now());
        expect(deadline!.getTime()).toBeGreaterThan(Date.now() - 5_000);
      });
    });
  }
});
