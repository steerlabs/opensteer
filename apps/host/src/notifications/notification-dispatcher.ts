import {
  notificationPushWindowMilliseconds,
  createId,
  type EventId,
  type NotificationId,
  type NotificationKind,
} from "@opensteer/core";
import type {
  DecidedNotification,
  NotificationPublication,
  NotificationStore,
  NotificationTransition,
} from "@opensteer/database";
import { delay } from "@opensteer/shared/delay";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { NotificationPublicationClient } from "./notification-publication-client.js";

interface NotificationDispatchFailure {
  readonly eventId: EventId;
  readonly notificationId?: NotificationId;
  readonly kind?: NotificationKind;
  readonly reason: string;
}

export interface NotificationDispatcherOptions {
  readonly client?: NotificationPublicationClient;
  readonly now?: () => Date;
  /** Domain grace/backoff waits only; publication I/O and deadlines stay real. */
  readonly wait?: typeof delay;
  readonly onError: (failure: NotificationDispatchFailure) => void;
  readonly onLive: (notification: DecidedNotification) => void;
  readonly onWarning: (failure: NotificationDispatchFailure) => void;
  readonly ready: Promise<void>;
  readonly store: Pick<NotificationStore, "decide" | "publicationSkipReason" | "accountSubjects">;
}

const replyPushGraceMilliseconds = 5_000;
const retryDelays = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/** Best-effort alerts belong to this process; the conversation remains durable. */
export class NotificationDispatcher {
  readonly #options: NotificationDispatcherOptions;
  readonly #now: () => Date;
  readonly #stop = new AbortController();
  readonly #pending = new Set<Promise<void>>();

  constructor(options: NotificationDispatcherOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  dispatch(change: NotificationTransition): void {
    if (this.#stop.signal.aborted) return;
    const eventId = createId("event");
    const pending = this.#decide(change, eventId).catch(() => {
      this.#report("onError", { eventId, reason: "Notification decision failed" });
    });
    this.#pending.add(pending);
    void pending.finally(() => this.#pending.delete(pending));
  }

  async drain(): Promise<void> {
    while (this.#pending.size) await Promise.all(this.#pending);
  }

  async close(): Promise<void> {
    this.#stop.abort();
    await this.drain();
  }

  async #decide(change: NotificationTransition, eventId: EventId): Promise<void> {
    const decisions = await this.#options.store.decide(change);
    if (this.#stop.signal.aborted) return;
    await Promise.all(
      decisions.map(async ({ sequence, ...decision }) => {
        if (this.#remaining(decision.view.occurredAt) <= 0) return;
        this.#options.onLive(decision);
        if (!this.#options.client) return;
        const entry: NotificationPublication = {
          ...decision.view,
          eventId,
          sequence,
          userId: decision.userId,
          occurredAt: new Date(decision.view.occurredAt),
          expiresAt: new Date(
            Date.parse(decision.view.occurredAt) + notificationPushWindowMilliseconds,
          ),
        };
        await this.#send(entry);
      }),
    );
  }

  async #send(entry: NotificationPublication): Promise<void> {
    const window = new AbortController();
    const timer = setTimeout(
      () => window.abort(),
      Math.max(0, entry.expiresAt.getTime() - this.#now().getTime()),
    );
    timer.unref();
    const signal = AbortSignal.any([this.#stop.signal, window.signal]);
    const report = (level: "onError" | "onWarning", reason: string) =>
      this.#report(level, {
        eventId: entry.eventId,
        notificationId: entry.id,
        kind: entry.kind,
        reason,
      });
    try {
      if (entry.kind === "reply-published")
        await (this.#options.wait ?? delay)(replyPushGraceMilliseconds, signal);
      await withTimeout(
        this.#options.ready,
        Math.max(0, entry.expiresAt.getTime() - this.#now().getTime()),
        {
          signal,
          timeoutError: () => new Error("Notification push window closed"),
        },
      );
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        if (entry.expiresAt.getTime() <= this.#now().getTime()) {
          report("onError", "Notification push window closed");
          return;
        }
        const skip = await this.#options.store.publicationSkipReason(entry);
        signal.throwIfAborted();
        if (entry.expiresAt.getTime() <= this.#now().getTime()) {
          report("onError", "Notification push window closed");
          return;
        }
        if (skip) return;
        const recipientAccountIds = await this.#options.store.accountSubjects(entry.userId);
        if (recipientAccountIds.length === 0) return;
        signal.throwIfAborted();
        const result = await this.#options.client!.publish({ entry, recipientAccountIds, signal });
        if (result.status === "published" || result.status === "no-target") return;
        if (result.status === "push-not-configured") {
          report("onWarning", "push-not-configured");
          return;
        }
        if (result.status === "failed") {
          report("onError", result.reason);
          return;
        }
        const pause = retryDelays[attempt];
        if (pause === undefined) {
          report("onError", `Notification publication retries exhausted: ${result.reason}`);
          return;
        }
        await (this.#options.wait ?? delay)(pause, signal);
      }
    } catch {
      if (!this.#stop.signal.aborted)
        report(
          "onError",
          window.signal.aborted || entry.expiresAt.getTime() <= this.#now().getTime()
            ? "Notification push window closed"
            : "Notification publication failed",
        );
    } finally {
      clearTimeout(timer);
    }
  }

  #remaining(occurredAt: string): number {
    return Date.parse(occurredAt) + notificationPushWindowMilliseconds - this.#now().getTime();
  }

  #report(level: "onError" | "onWarning", failure: NotificationDispatchFailure): void {
    try {
      this.#options[level](failure);
    } catch {
      // Reporting cannot leave holds, retries or shutdown unfinished.
    }
  }
}
