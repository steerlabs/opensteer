import type { Tab, TabLayout, UserId } from "@opensteer/core";
import {
  equal,
  KeyedStreamPublisher,
  type KeyedStreamMessage,
} from "@opensteer/protocol/keyed-stream";

export type TabStreamMessage = {
  type: "host.tabs";
  stream: KeyedStreamMessage<Tab, { layout: TabLayout }, "tabId">;
};
interface Subscription {
  ownerId: UserId;
  rows: Map<string, Tab>;
  layout: TabLayout;
  publisher: KeyedStreamPublisher<Tab, { layout: TabLayout }, "tabId">;
  send(message: TabStreamMessage): Promise<void>;
  dirty: boolean;
  closed: boolean;
  tail: Promise<void>;
}
/** One ordered snapshot source, with bounded frames and field patches. */
export class TabStreams {
  readonly #subscriptions = new Set<Subscription>();
  readonly read: (ownerId: UserId) => Promise<{ tabs: Tab[]; layout: TabLayout }>;
  readonly onError: (error: unknown) => void;
  constructor(read: TabStreams["read"], onError: TabStreams["onError"]) {
    this.read = read;
    this.onError = onError;
  }
  subscribe(
    ownerId: UserId,
    send: Subscription["send"],
    prefix: readonly Tab[] = [],
  ): { ready: Promise<void>; close(): void; flush(): Promise<void> } {
    const subscription: Subscription = {
      ownerId,
      rows: new Map(),
      layout: { revision: 0, items: [] },
      dirty: true,
      closed: false,
      tail: Promise.resolve(),
      send,
      publisher: new KeyedStreamPublisher({
        key: "tabId",
        ids: () => subscription.rows.keys(),
        read: (id) => subscription.rows.get(id),
        meta: () => ({ layout: subscription.layout }),
        targetBytes: 64 * 1024,
        envelopeBytes: 128,
      }),
    };
    if (prefix.length) subscription.publisher.seed(prefix);
    this.#subscriptions.add(subscription);
    const ready = this.#refresh(subscription);
    return {
      ready,
      close: () => {
        subscription.closed = true;
        this.#subscriptions.delete(subscription);
      },
      flush: () => subscription.tail,
    };
  }
  changed(ownerId?: UserId): void {
    for (const subscription of this.#subscriptions)
      if (!ownerId || subscription.ownerId === ownerId) {
        subscription.dirty = true;
        void this.#refresh(subscription).catch(this.onError);
      }
  }
  #refresh(subscription: Subscription): Promise<void> {
    const pending = subscription.tail.then(async () => {
      while (subscription.dirty && !subscription.closed) {
        subscription.dirty = false;
        const { tabs, layout } = await this.read(subscription.ownerId);
        if (subscription.closed) return;
        const next = new Map<string, Tab>(tabs.map((tab) => [tab.tabId, tab]));
        for (const [id, row] of subscription.rows) {
          const after = next.get(id);
          if (!equal(row, after)) subscription.publisher.mark(id);
        }
        for (const [id, row] of next)
          if (!equal(row, subscription.rows.get(id))) subscription.publisher.mark(id);
        if (layout.revision !== subscription.layout.revision) subscription.publisher.markMeta();
        subscription.rows = next;
        subscription.layout = layout;
        while (!subscription.closed) {
          const frame = subscription.publisher.next();
          if (!frame) break;
          try {
            await subscription.send({ type: "host.tabs", stream: frame });
            subscription.publisher.settled(frame, true);
          } catch (error) {
            subscription.publisher.settled(frame, false);
            throw error;
          }
        }
      }
    });
    subscription.tail = pending.catch(() => undefined);
    return pending;
  }
  close(): void {
    for (const subscription of this.#subscriptions) subscription.closed = true;
    this.#subscriptions.clear();
  }
}
