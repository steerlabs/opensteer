import { safeMessage } from "@opensteer/shared/safeMessage";
import type { NotificationDevicePlatform } from "@opensteer/control-plane-protocol";
import { notificationMessage, type NotificationMessage } from "./notification-message.js";
import type {
  ClaimedNotificationDelivery,
  ControlPlaneNotificationStore,
} from "./notification-store.js";
import type { PushDeliveryResult } from "./push-result.js";

export type NotificationDeliveryWorkerStore = Pick<
  ControlPlaneNotificationStore,
  | "claimDueDeliveries"
  | "disableDevice"
  | "pruneSettled"
  | "renewDeliveryLease"
  | "retryDelivery"
  | "settleDelivery"
>;

export type PushSender = (input: {
  readonly apsEnvironment: "development" | "production" | null;
  /**
   * What a newer alert replaces on the phone: the same kind of alert about
   * the same Thread. A reply never covers an approval still waiting on the
   * person.
   */
  readonly collapseKey: string;
  readonly expiresAt: Date;
  readonly message: NotificationMessage;
  readonly token: string;
}) => Promise<PushDeliveryResult>;

export interface NotificationDeliveryWorkerOptions {
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly onSettledFailure: (failure: {
    readonly notificationId: string;
    readonly platform: NotificationDevicePlatform;
    readonly providerOutcome: string;
  }) => void;
  readonly onError: (error: unknown) => void;
  /** How long a settled delivery and its receipt are kept. */
  readonly retentionMs?: number;
  /** How often retention runs, which is nothing like how often sending does. */
  readonly retentionIntervalMs?: number;
  readonly senders: Readonly<Partial<Record<NotificationDevicePlatform, PushSender>>>;
  readonly store: NotificationDeliveryWorkerStore;
}

/** Thirty days of settled deliveries and receipts, then they are gone. */
const defaultRetentionMs = 30 * 24 * 60 * 60 * 1_000;
const defaultRetentionIntervalMs = 60 * 60 * 1_000;

/**
 * Sends claimed deliveries to Apple and Google.
 *
 * Retries are bounded by the notification's own freshness window rather than by
 * an attempt count: past it there is nothing worth telling anybody, so the row
 * is dropped instead of retried. A provider that says the token is gone ends
 * the registration on the spot — a dead token only ever produces more dead
 * deliveries.
 */
export class NotificationDeliveryWorker {
  readonly #intervalMs: number;
  readonly #now: () => Date;
  readonly #onSettledFailure: NotificationDeliveryWorkerOptions["onSettledFailure"];
  readonly #onError: (error: unknown) => void;
  readonly #retentionIntervalMs: number;
  readonly #retentionMs: number;
  readonly #senders: NotificationDeliveryWorkerOptions["senders"];
  readonly #store: NotificationDeliveryWorkerStore;
  #active: Promise<void> | undefined;
  #nextPruneAt = 0;
  #started = false;
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: NotificationDeliveryWorkerOptions) {
    const intervalMs = options.intervalMs ?? 2_000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100) {
      throw new TypeError("Notification delivery interval must be at least 100ms");
    }
    const retentionMs = options.retentionMs ?? defaultRetentionMs;
    const retentionIntervalMs = options.retentionIntervalMs ?? defaultRetentionIntervalMs;
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 60_000) {
      throw new TypeError("Notification retention must be at least a minute");
    }
    if (!Number.isSafeInteger(retentionIntervalMs) || retentionIntervalMs < 1_000) {
      throw new TypeError("Notification retention interval must be at least a second");
    }
    this.#intervalMs = intervalMs;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError;
    this.#onSettledFailure = options.onSettledFailure;
    this.#retentionIntervalMs = retentionIntervalMs;
    this.#retentionMs = retentionMs;
    this.#senders = options.senders;
    this.#store = options.store;
  }

  start(): void {
    if (this.#started) throw new Error("Notification delivery worker is already started");
    this.#started = true;
    this.#schedule(0);
  }

  async close(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#active;
  }

  async deliverOnce(): Promise<number> {
    const claimed = await this.#store.claimDueDeliveries();
    for (const delivery of claimed) {
      try {
        // Sending is sequential, so the lease taken for the whole batch may
        // have run out by the time this row's turn comes. A row another worker
        // has since claimed is theirs to send, not this one's to send again.
        const held = await this.#store.renewDeliveryLease({
          deviceId: delivery.deviceId,
          leaseToken: delivery.leaseToken,
          notificationId: delivery.notificationId,
        });
        if (!held) continue;
        await this.#deliver(delivery);
      } catch (error) {
        this.#report(error);
        await this.#store.retryDelivery({
          deviceId: delivery.deviceId,
          leaseToken: delivery.leaseToken,
          nextAttemptAt: this.#backoff(delivery.attempts),
          notificationId: delivery.notificationId,
          outcome: safeMessage(error, safeMessageOptions).slice(0, 512),
        });
      }
    }
    return claimed.length;
  }

  /**
   * Drops settled deliveries and the receipts that fenced them.
   *
   * It rides the sending loop rather than a second timer, but on its own far
   * slower clock: a delete every two seconds would be pure waste, and the rows
   * it removes have been finished for a month.
   */
  async pruneOnce(): Promise<{ readonly deliveries: number; readonly receipts: number }> {
    return this.#store.pruneSettled({
      before: new Date(this.#now().getTime() - this.#retentionMs),
    });
  }

  async #deliver(delivery: ClaimedNotificationDelivery): Promise<void> {
    if (delivery.expiresAt.getTime() <= this.#now().getTime()) {
      await this.#store.settleDelivery({
        deviceId: delivery.deviceId,
        leaseToken: delivery.leaseToken,
        notificationId: delivery.notificationId,
        outcome: "expired",
        status: "dropped",
      });
      return;
    }
    const sender = this.#senders[delivery.platform];
    const result: PushDeliveryResult = sender
      ? await sender({
          apsEnvironment: delivery.apsEnvironment,
          collapseKey: `${delivery.threadId}:${delivery.kind}`,
          expiresAt: delivery.expiresAt,
          message: notificationMessage({
            deploymentId: delivery.deploymentId,
            kind: delivery.kind,
            messageId: delivery.messageId ?? null,
            requestId: delivery.requestId,
            threadId: delivery.threadId,
          }),
          token: delivery.token,
        })
      : { status: "rejected", outcome: "not-configured" };
    if (result.status === "retry") {
      const nextAttemptAt = this.#backoff(delivery.attempts);
      // A retry scheduled past the freshness window would only ever be dropped,
      // so it is dropped now and the reason kept.
      if (nextAttemptAt.getTime() >= delivery.expiresAt.getTime()) {
        await this.#settleFailure(delivery, result.outcome);
        return;
      }
      await this.#store.retryDelivery({
        deviceId: delivery.deviceId,
        leaseToken: delivery.leaseToken,
        nextAttemptAt,
        notificationId: delivery.notificationId,
        outcome: result.outcome,
      });
      return;
    }
    const settled = await this.#store.settleDelivery({
      deviceId: delivery.deviceId,
      leaseToken: delivery.leaseToken,
      notificationId: delivery.notificationId,
      outcome: result.outcome,
      status: result.status === "delivered" ? "delivered" : "failed",
    });
    if (!settled) return;
    if (result.status !== "delivered") this.#logFailure(delivery, result.outcome);
    if (result.status === "unregistered") {
      await this.#store.disableDevice({
        deviceId: delivery.deviceId,
        outcome: result.outcome,
        tokenHash: delivery.tokenHash,
      });
    }
  }

  async #settleFailure(delivery: ClaimedNotificationDelivery, outcome: string): Promise<void> {
    const settled = await this.#store.settleDelivery({
      deviceId: delivery.deviceId,
      leaseToken: delivery.leaseToken,
      notificationId: delivery.notificationId,
      outcome,
      status: "failed",
    });
    if (settled) this.#logFailure(delivery, outcome);
  }

  #logFailure(delivery: ClaimedNotificationDelivery, outcome: string): void {
    try {
      this.#onSettledFailure({
        notificationId: delivery.notificationId,
        platform: delivery.platform,
        providerOutcome: outcome.replaceAll(delivery.token, "[redacted]"),
      });
    } catch {
      // Reporting cannot turn a settled delivery back into a retry.
    }
  }

  async #tick(): Promise<void> {
    await this.deliverOnce();
    const now = this.#now().getTime();
    if (now < this.#nextPruneAt) return;
    this.#nextPruneAt = now + this.#retentionIntervalMs;
    await this.pruneOnce();
  }

  /**
   * Doubles from a second up to an hour. A delivery may stay owed for a day,
   * and a provider that is down for that long should hear from this worker
   * about twenty times, not every minute.
   */
  #backoff(attempts: number): Date {
    const exponent = Math.min(Math.max(attempts - 1, 0), 12);
    return new Date(this.#now().getTime() + Math.min(60 * 60_000, 1_000 * 2 ** exponent));
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const active = this.#tick().catch((error: unknown) => this.#report(error));
      this.#active = active;
      void active.finally(() => {
        if (this.#active === active) this.#active = undefined;
        this.#schedule(this.#intervalMs);
      });
    }, delay);
    this.#timer.unref();
  }

  #report(error: unknown): void {
    try {
      this.#onError(new Error(safeMessage(error, safeMessageOptions)));
    } catch {
      // Reporting cannot stop delivery or control-plane shutdown.
    }
  }
}

const safeMessageOptions = {
  fallback: "Notification delivery failed",
  redactions: [
    { pattern: /Bearer\s+[^\s]+/giu, replacement: "Bearer [redacted]" },
    { pattern: /bearer\s+[^\s]+/gu, replacement: "bearer [redacted]" },
  ],
} as const;
