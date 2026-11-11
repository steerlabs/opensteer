import type { UserId } from "@opensteer/core";
import type { BrowserGroupRow, BrowserTabRow } from "@opensteer/protocol/browser-tabs";
import {
  KeyedStreamPublisher,
  keyedStreamBytes,
  type KeyedStreamMessage,
} from "@opensteer/protocol/keyed-stream";

export type BrowserClientStreamMessage =
  | {
      type: "host.browser-groups";
      stream: KeyedStreamMessage<BrowserGroupRow, Record<string, never>>;
    }
  | {
      type: "host.browser-tabs";
      groupId: string;
      stream: KeyedStreamMessage<BrowserTabRow, Record<string, never>>;
    };

export interface BrowserClientRows {
  groups: readonly BrowserGroupRow[];
  tabs: ReadonlyMap<string, readonly BrowserTabRow[]>;
}
interface Projection {
  references: number;
  groups: Map<string, BrowserGroupRow>;
  tabs: Map<string, Map<string, BrowserTabRow>>;
}
interface Connection {
  readonly userId: UserId;
  readonly send: (message: BrowserClientStreamMessage) => Promise<void>;
  readonly bufferedAmount: () => number;
  readonly projection: Projection;
  readonly groups: KeyedStreamPublisher<BrowserGroupRow, Record<string, never>>;
  readonly tabs: Map<string, KeyedStreamPublisher<BrowserTabRow, Record<string, never>>>;
  timer: ReturnType<typeof setTimeout> | null;
  sending: boolean;
  closed: boolean;
}
function reuse<Row extends { id: string }>(previous: Row | undefined, row: Row): Row {
  return previous && JSON.stringify(previous) === JSON.stringify(row) ? previous : row;
}
export class BrowserClientStreams {
  #closed = false;
  readonly #connections = new Set<Connection>();
  readonly #projections = new Map<UserId, Projection>();
  readonly #refreshing = new Map<UserId, Promise<void>>();
  readonly #dirty = new Set<UserId>();
  readonly options: {
    read(userId: UserId): Promise<BrowserClientRows>;
    onError(error: unknown): void;
  };
  constructor(options: {
    read(userId: UserId): Promise<BrowserClientRows>;
    onError(error: unknown): void;
  }) {
    this.options = options;
  }
  async refresh(userId?: UserId): Promise<void> {
    if (!userId) {
      await Promise.all([...this.#projections.keys()].map((id) => this.refresh(id)));
      return;
    }
    this.#dirty.add(userId);
    const held = this.#refreshing.get(userId);
    if (held) return held;
    const work = (async () => {
      while (this.#dirty.delete(userId)) {
        const rows = await this.options.read(userId);
        const projection = this.#projections.get(userId);
        if (!projection) return;
        const groups = new Map<string, BrowserGroupRow>(
          rows.groups.map((row) => [row.id, reuse(projection.groups.get(row.id), row)]),
        );
        const changedGroups = new Set(
          [...groups.keys(), ...projection.groups.keys()].filter(
            (id) => groups.get(id) !== projection.groups.get(id),
          ),
        );
        const changedTabs = new Map<string, Set<string>>();
        for (const id of groups.keys()) {
          const previous = projection.tabs.get(id) ?? new Map<string, BrowserTabRow>();
          const next = new Map<string, BrowserTabRow>(
            (rows.tabs.get(id) ?? []).map((row) => [row.id, reuse(previous.get(row.id), row)]),
          );
          changedTabs.set(
            id,
            new Set(
              [...next.keys(), ...previous.keys()].filter(
                (key) => next.get(key) !== previous.get(key),
              ),
            ),
          );
          projection.tabs.set(id, next);
        }
        projection.groups = groups;
        for (const id of projection.tabs.keys()) if (!groups.has(id)) projection.tabs.delete(id);
        for (const connection of this.#connections) {
          if (connection.userId !== userId) continue;
          for (const id of changedGroups) connection.groups.mark(id);
          for (const id of connection.tabs.keys()) if (!groups.has(id)) connection.tabs.delete(id);
          for (const [id, keys] of changedTabs) {
            const publisher = this.#tabs(connection, id);
            for (const key of keys) publisher.mark(key);
          }
          this.#schedule(connection);
        }
      }
    })().finally(() => {
      this.#refreshing.delete(userId);
    });
    this.#refreshing.set(userId, work);
    return work;
  }
  async attach(userId: UserId, transport: Pick<Connection, "send" | "bufferedAmount">) {
    if (this.#closed) throw new Error("Browser client streams are closed.");
    let projection = this.#projections.get(userId);
    if (!projection) {
      projection = { references: 0, groups: new Map(), tabs: new Map() };
      this.#projections.set(userId, projection);
    }
    projection.references++;
    try {
      await this.refresh(userId);
      if (this.#closed) throw new Error("Browser client streams are closed.");
    } catch (error) {
      if (--projection.references === 0) this.#projections.delete(userId);
      throw error;
    }
    const connection: Connection = {
      ...transport,
      userId,
      projection,
      tabs: new Map(),
      timer: null,
      sending: false,
      closed: false,
      groups: new KeyedStreamPublisher({
        ids: () => projection.groups.keys(),
        read: (id) => projection.groups.get(id),
        meta: () => ({}),
        targetBytes: 16 * 1024,
        envelopeBytes: keyedStreamBytes({ type: "host.browser-groups", stream: null }) - 4,
      }),
    };
    this.#connections.add(connection);
    for (const id of projection.groups.keys()) this.#tabs(connection, id);
    this.#schedule(connection);
    return {
      resync: (groupId?: string) => {
        if (groupId) connection.tabs.get(groupId)?.reset();
        else connection.groups.reset();
        this.#schedule(connection);
      },
      close: () => {
        if (connection.closed) return;
        connection.closed = true;
        if (connection.timer) clearTimeout(connection.timer);
        this.#connections.delete(connection);
        if (--projection.references === 0) this.#projections.delete(userId);
      },
    };
  }
  #tabs(connection: Connection, groupId: string) {
    let publisher = connection.tabs.get(groupId);
    if (!publisher) {
      publisher = new KeyedStreamPublisher<BrowserTabRow, Record<string, never>>({
        ids: () => connection.projection.tabs.get(groupId)?.keys() ?? [],
        read: (id) => connection.projection.tabs.get(groupId)?.get(id),
        meta: () => ({}),
        targetBytes: 16 * 1024,
        envelopeBytes: keyedStreamBytes({ type: "host.browser-tabs", groupId, stream: null }) - 4,
      });
      connection.tabs.set(groupId, publisher);
    }
    return publisher;
  }
  #schedule(connection: Connection) {
    if (connection.closed || connection.timer || connection.sending) return;
    connection.timer = setTimeout(() => {
      connection.timer = null;
      void this.#flush(connection).catch(this.options.onError);
    }, 50);
    connection.timer.unref();
  }
  async #flush(connection: Connection) {
    if (connection.closed) return;
    connection.sending = true;
    try {
      while (!connection.closed && connection.bufferedAmount() < 256 * 1024) {
        const groupFrame = connection.groups.next();
        if (groupFrame) {
          try {
            await connection.send({ type: "host.browser-groups", stream: groupFrame });
            connection.groups.settled(groupFrame, true);
          } catch (error) {
            connection.groups.settled(groupFrame, false);
            throw error;
          }
          continue;
        }
        let sent = false;
        for (const [groupId, publisher] of connection.tabs) {
          if (!connection.projection.groups.has(groupId) || !connection.groups.hasSent(groupId))
            continue;
          const frame = publisher.next();
          if (!frame) continue;
          try {
            await connection.send({ type: "host.browser-tabs", groupId, stream: frame });
            publisher.settled(frame, true);
          } catch (error) {
            publisher.settled(frame, false);
            throw error;
          }
          sent = true;
          break;
        }
        if (!sent) break;
      }
    } finally {
      connection.sending = false;
      if (connection.groups.pending || [...connection.tabs.values()].some((p) => p.pending))
        this.#schedule(connection);
    }
  }
  close() {
    this.#closed = true;
    for (const connection of this.#connections) {
      connection.closed = true;
      if (connection.timer) clearTimeout(connection.timer);
    }
    this.#connections.clear();
    this.#projections.clear();
  }
}
