import { notificationCollapseId } from "./notification-message.js";
import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import {
  NotificationDeliveryWorker,
  type NotificationDeliveryWorkerStore,
  type PushSender,
} from "./notification-delivery-worker.js";
import type { ClaimedNotificationDelivery } from "./notification-store.js";

const now = () => new Date("2026-09-14T12:00:30.000Z");

function delivery(
  overrides: Partial<ClaimedNotificationDelivery> = {},
): ClaimedNotificationDelivery {
  return {
    installationId: "test-installation",
    preview: null,
    apsEnvironment: "development",
    attempts: 1,
    deploymentId: createId("deployment"),
    deviceId: crypto.randomUUID(),
    expiresAt: new Date("2026-09-14T12:02:00.000Z"),
    kind: "request-opened",
    leaseToken: "a".repeat(43),
    notificationId: createId("notification"),
    platform: "ios",
    requestId: createId("request"),
    threadId: createId("thread"),
    token: "b".repeat(64),
    tokenHash: "h".repeat(43),
    ...overrides,
  };
}

function worker(input: {
  readonly claimed: readonly ClaimedNotificationDelivery[];
  readonly sender?: PushSender;
  readonly store?: Partial<NotificationDeliveryWorkerStore>;
}) {
  const onSettledFailure = vi.fn();
  const disableDevice = vi.fn(async () => true);
  const renewDeliveryLease = vi.fn(async () => true);
  const retryDelivery = vi.fn(async () => true);
  const settleDelivery = vi.fn(async () => true);
  const store: NotificationDeliveryWorkerStore = {
    claimDueDeliveries: async () => input.claimed,
    disableDevice,
    pruneSettled: async () => ({ deliveries: 0, receipts: 0 }),
    renewDeliveryLease,
    retryDelivery,
    settleDelivery,
    ...input.store,
  };
  return {
    disableDevice,
    onSettledFailure,
    renewDeliveryLease,
    instance: new NotificationDeliveryWorker({
      now,
      onSettledFailure,
      onError: vi.fn(),
      senders: input.sender ? { android: input.sender, ios: input.sender } : {},
      store,
    }),
    retryDelivery,
    settleDelivery,
  };
}

describe("NotificationDeliveryWorker", () => {
  it("settles a platform without a sender as failed and logs once", async () => {
    const claimed = delivery();
    const harness = worker({ claimed: [claimed] });
    await harness.instance.deliverOnce();
    expect(harness.settleDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", outcome: "not-configured" }),
    );
    expect(harness.onSettledFailure.mock.calls).toEqual([
      [
        {
          notificationId: claimed.notificationId,
          platform: "ios",
          providerOutcome: "not-configured",
        },
      ],
    ]);
    expect(harness.retryDelivery).not.toHaveBeenCalled();
  });

  it.each(["rejected", "unregistered"] as const)(
    "logs a settled %s once without the device token",
    async (status) => {
      const claimed = delivery();
      const harness = worker({
        claimed: [claimed],
        sender: async () => ({ status, outcome: "apns:refused" }),
      });
      await harness.instance.deliverOnce();
      expect(harness.onSettledFailure.mock.calls).toEqual([
        [
          {
            notificationId: claimed.notificationId,
            platform: "ios",
            providerOutcome: "apns:refused",
          },
        ],
      ]);
      expect(JSON.stringify(harness.onSettledFailure.mock.calls)).not.toContain(claimed.token);
    },
  );

  it("does not log an outcome whose settlement lost its lease", async () => {
    const harness = worker({
      claimed: [delivery()],
      sender: async () => ({ status: "rejected", outcome: "apns:refused" }),
      store: { settleDelivery: async () => false },
    });
    await harness.instance.deliverOnce();
    expect(harness.onSettledFailure).not.toHaveBeenCalled();
    expect(harness.disableDevice).not.toHaveBeenCalled();
  });

  it("ends the registration when the provider says the token is gone", async () => {
    const claimed = delivery();
    const harness = worker({
      claimed: [claimed],
      sender: async () => ({ outcome: "apns:Unregistered", status: "unregistered" }),
    });

    await harness.instance.deliverOnce();

    expect(harness.settleDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
    );
    expect(harness.disableDevice).toHaveBeenCalledWith({
      deviceId: claimed.deviceId,
      outcome: "apns:Unregistered",
      tokenHash: claimed.tokenHash,
    });
  });

  it("schedules a transient failure inside the freshness window", async () => {
    const claimed = delivery({ attempts: 3 });
    const harness = worker({
      claimed: [claimed],
      sender: async () => ({ outcome: "fcm:503:UNAVAILABLE", status: "retry" }),
    });

    await harness.instance.deliverOnce();

    expect(harness.retryDelivery).toHaveBeenCalledWith({
      deviceId: claimed.deviceId,
      leaseToken: claimed.leaseToken,
      nextAttemptAt: new Date(now().getTime() + 4_000),
      notificationId: claimed.notificationId,
      outcome: "fcm:503:UNAVAILABLE",
    });
  });

  it("stops retrying once the next attempt would fall outside the window", async () => {
    const claimed = delivery({ attempts: 6, expiresAt: new Date("2026-09-14T12:00:40.000Z") });
    const harness = worker({
      claimed: [claimed],
      sender: async () => ({ outcome: "fcm:503:UNAVAILABLE", status: "retry" }),
    });

    await harness.instance.deliverOnce();

    expect(harness.retryDelivery).not.toHaveBeenCalled();
    expect(harness.settleDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "fcm:503:UNAVAILABLE", status: "failed" }),
    );
  });

  it("leaves a delivery alone once another worker has reclaimed its lease", async () => {
    const kept = delivery();
    const reclaimed = delivery();
    const sender = vi.fn<PushSender>(async () => ({ outcome: "accepted", status: "delivered" }));
    const harness = worker({
      claimed: [kept, reclaimed],
      sender,
      store: {
        renewDeliveryLease: async ({ notificationId }) => notificationId === kept.notificationId,
      },
    });

    await expect(harness.instance.deliverOnce()).resolves.toBe(2);

    expect(sender).toHaveBeenCalledTimes(1);
    // Each Request has its own replacement identity.
    expect(sender.mock.calls[0]?.[0].collapseKey).toBe(notificationCollapseId(kept));
    expect(harness.settleDelivery.mock.calls).toEqual([
      [
        {
          deviceId: kept.deviceId,
          leaseToken: kept.leaseToken,
          notificationId: kept.notificationId,
          outcome: "accepted",
          status: "delivered",
        },
      ],
    ]);
    expect(harness.retryDelivery).not.toHaveBeenCalled();
  });

  it("drops a delivery whose moment has already passed without contacting a provider", async () => {
    const claimed = delivery({ expiresAt: new Date("2026-09-14T11:59:00.000Z") });
    const sender = vi.fn<PushSender>(async () => ({ outcome: "accepted", status: "delivered" }));
    const harness = worker({ claimed: [claimed], sender });

    await harness.instance.deliverOnce();

    expect(sender).not.toHaveBeenCalled();
    expect(harness.settleDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "expired", status: "dropped" }),
    );
  });

  it("keeps a thrown sender from stalling the queue", async () => {
    const claimed = delivery({ attempts: 1 });
    const harness = worker({
      claimed: [claimed],
      sender: async () => {
        throw new Error("provider client exploded");
      },
    });

    await harness.instance.deliverOnce();

    expect(harness.retryDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ nextAttemptAt: new Date(now().getTime() + 1_000) }),
    );
  });
});
