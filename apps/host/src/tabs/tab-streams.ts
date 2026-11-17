import type { Tab, TabId, TabLayout, UserId } from "@opensteer/core";
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
  rows: Map<TabId, Tab>;
  layout: TabLayout;
  publisher: KeyedStreamPublisher<Tab, { layout: TabLayout }, "tabId">;
  send(message: TabStreamMessage): Promise<void>;
  project?:
    ((value: { tabs: Tab[]; layout: TabLayout }) => { tabs: Tab[]; layout: TabLayout }) | undefined;
  dirty: Set<TabId> | null | undefined;
  closed: boolean;
  tail: Promise<void>;
}
/** One ordered snapshot source, with bounded frames and field patches. */
export class TabStreams {
  readonly #subscriptions = new Set<Subscription>();
  readonly #projections = new Map<UserId, ReturnType<TabStreams["read"]>>();
  readonly read: (ownerId: UserId) => Promise<{ rows: ReadonlyMap<TabId, Tab>; layout: TabLayout }>;
  readonly onError: (error: unknown) => void;
  constructor(read: TabStreams["read"], onError: TabStreams["onError"]) {
    this.read = read;
    this.onError = onError;
  }
  subscribe(
    ownerId: UserId,
    send: Subscription["send"],
    prefix: readonly Tab[] = [],
    project?: Subscription["project"],
  ): { ready: Promise<void>; close(): void; flush(): Promise<void> } {
    const subscription: Subscription = {
      ownerId,
      rows: new Map(),
      layout: { revision: 0, items: [] },
      dirty: null,
      closed: false,
      tail: Promise.resolve(),
      send,
      project,
      publisher: new KeyedStreamPublisher({
        key: "tabId",
        ids: () => subscription.rows.keys(),
        read: (id) => subscription.rows.get(id as TabId),
        meta: () => ({ layout: subscription.layout }),
        targetBytes: 64 * 1024,
        envelopeBytes: 128,
      }),
    };
    if (prefix.length)
      subscription.publisher.seed(
        project ? project({ tabs: [...prefix], layout: subscription.layout }).tabs : prefix,
      );
    this.#subscriptions.add(subscription);
    const ready = this.#refresh(subscription);
    return {
      ready,
      close: () => {
        subscription.closed = true;
        this.#subscriptions.delete(subscription);
        if (![...this.#subscriptions].some((other) => other.ownerId === ownerId))
          this.#projections.delete(ownerId);
      },
      flush: () => subscription.tail,
    };
  }
  changed(ownerId?: UserId, tabIds?: readonly TabId[]): void {
    if (ownerId) this.#projections.delete(ownerId);
    else this.#projections.clear();
    for (const subscription of this.#subscriptions)
      if (!ownerId || subscription.ownerId === ownerId) {
        if (!tabIds) subscription.dirty = null;
        else if (subscription.dirty !== null) {
          subscription.dirty ??= new Set();
          for (const id of tabIds) subscription.dirty.add(id);
        }
        void this.#refresh(subscription).catch(this.onError);
      }
  }
  #refresh(subscription: Subscription): Promise<void> {
    const pending = subscription.tail.then(async () => {
      while (subscription.dirty !== undefined && !subscription.closed) {
        const changed = subscription.dirty;
        subscription.dirty = undefined;
        let projection = this.#projections.get(subscription.ownerId);
        if (!projection) {
          projection = this.read(subscription.ownerId);
          this.#projections.set(subscription.ownerId, projection);
          void projection.catch(() => {
            if (this.#projections.get(subscription.ownerId) === projection)
              this.#projections.delete(subscription.ownerId);
          });
        }
        const original = await projection;
        const filtered = subscription.project?.({
          tabs: [...original.rows.values()],
          layout: original.layout,
        });
        const rows = filtered
          ? new Map(filtered.tabs.map((tab) => [tab.tabId, tab]))
          : original.rows;
        const layout = filtered?.layout ?? original.layout;
        if (subscription.closed) return;
        const ids = changed ?? new Set([...subscription.rows.keys(), ...rows.keys()]);
        for (const id of ids) {
          const after = rows.get(id);
          if (!equal(subscription.rows.get(id), after)) subscription.publisher.mark(id);
          if (after) subscription.rows.set(id, after);
          else subscription.rows.delete(id);
        }
        if (layout.revision !== subscription.layout.revision) subscription.publisher.markMeta();
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
    this.#projections.clear();
  }
}
