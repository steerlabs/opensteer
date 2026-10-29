import {
  notificationPushWindowMilliseconds,
  type AgentEvent,
  type EventId,
  type NotificationId,
  type NotificationKind,
} from "@opensteer/core";
import {
  mayNotify,
  replyPushGraceMilliseconds,
  type DecidedNotification,
  type NotificationPublication,
  type NotificationStore,
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

  dispatch(event: AgentEvent): void {
    if (this.#stop.signal.aborted || !mayNotify(event) || this.#remaining(event) <= 0) return;
    const pending = this.#decide(event).catch(() => {
      this.#report("onError", { eventId: event.eventId, reason: "Notification decision failed" });
    });
    this.#pending.add(pending);
    void pending.finally(() => this.#pending.delete(pending));
  }

  /** Awaits all admitted decisions and publications, including their grace and retries. */
  async drain(): Promise<void> {
    while (this.#pending.size) await Promise.all(this.#pending);
  }

  async close(): Promise<void> {
    this.#stop.abort();
    await this.drain();
  }

  async #decide(event: AgentEvent): Promise<void> {
    const decisions = await this.#options.store.decide(event);
    if (this.#stop.signal.aborted || this.#remaining(event) <= 0) return;
    await Promise.all(
      decisions.map(async (decision) => {
        this.#options.onLive(decision);
        if (!this.#options.client) return;
        const entry: NotificationPublication = {
          ...decision.view,
          eventId: event.eventId,
          sequence: event.sequence,
          userId: decision.userId,
          occurredAt: new Date(event.createdAt),
          expiresAt: new Date(Date.parse(event.createdAt) + notificationPushWindowMilliseconds),
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

  #remaining(event: AgentEvent): number {
    return Date.parse(event.createdAt) + notificationPushWindowMilliseconds - this.#now().getTime();
  }

  #report(level: "onError" | "onWarning", failure: NotificationDispatchFailure): void {
    try {
      this.#options[level](failure);
    } catch {
      // Reporting cannot leave holds, retries or shutdown unfinished.
    }
  }
}
