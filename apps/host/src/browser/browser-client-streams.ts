import { createHash } from "node:crypto";
import type { BrowserSessionId, UserId } from "@opensteer/core";
import type { BrowserGroupFacts, PersonalTabStreamRow } from "@opensteer/database";
import {
  browserPageSite,
  type BrowserGroupRow,
  type BrowserTabRecord,
  type BrowserTabRow,
  type HostedBrowserBootstrap,
} from "@opensteer/protocol/browser";
import {
  equal,
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
      groupId: BrowserSessionId;
      stream: KeyedStreamMessage<BrowserTabRow, Record<string, never>>;
    };
export interface BrowserLiveRows {
  readonly groupId: BrowserSessionId;
  readonly records: ReadonlyMap<string, BrowserTabRecord>;
  readonly inventoryRevision: number;
  readonly navigation: boolean;
  readonly ready: boolean;
  readonly acting: boolean;
  readonly page: BrowserGroupRow["page"];
  iconRef(id: string): string | null;
}
export interface BrowserRowPorts {
  authorityGeneration(): number;
  groupIds(userId: UserId): Promise<readonly BrowserSessionId[]>;
  readGroups(
    userId: UserId,
    groupIds: readonly BrowserSessionId[],
  ): Promise<readonly BrowserGroupFacts[]>;
  readTabs(groupIds: readonly BrowserSessionId[]): Promise<readonly PersonalTabStreamRow[]>;
  groupId(sessionId: BrowserSessionId): Promise<BrowserSessionId | null>;
  live(sessionId: BrowserSessionId): BrowserLiveRows | undefined;
  occupants(userId: UserId, sessionId: BrowserSessionId, tabId: string): BrowserTabRow["occupants"];
  onError(error: unknown): void;
}
interface Projection {
  readonly userId: UserId;
  references: number;
  generation: number;
  held: boolean;
  ready: Promise<void>;
  tail: Promise<void>;
  facts: Map<BrowserSessionId, BrowserGroupFacts>;
  readonly groups: Map<BrowserSessionId, BrowserGroupRow>;
  readonly tabs: Map<BrowserSessionId, Map<string, BrowserTabRow>>;
}
type Changed = (
  projection: Projection,
  groupId: BrowserSessionId | null,
  tabIds: readonly string[],
  groupChanged: boolean,
) => void;
function current(facts: BrowserGroupFacts): boolean {
  return facts.state === "starting" || facts.state === "ready" || facts.state === "closing";
}

function prefix<Row extends { id: string }>(
  rows: ReadonlyMap<string, Row>,
  budget: number,
  envelope: object,
) {
  const overhead = keyedStreamBytes(envelope);
  if (budget <= overhead + 32) return { rows: [] as Row[], complete: rows.size === 0 };
  const publisher = new KeyedStreamPublisher<Row, Record<string, never>>({
    ids: () => rows.keys(),
    read: (id) => rows.get(id),
    meta: () => ({}),
    targetBytes: budget,
    envelopeBytes: overhead,
  });
  const begin = publisher.next()!;
  publisher.settled(begin, true);
  const frame = publisher.next();
  const packed = frame?.op === "rows" ? frame.rows : [];
  return { rows: packed, complete: packed.length === rows.size };
}

export class BrowserRowSource {
  readonly #projections = new Map<UserId, Projection>();
  readonly #durable = new Map<BrowserSessionId, Map<string, PersonalTabStreamRow>>();
  readonly #tabReads = new Map<BrowserSessionId, Promise<void>>();
  readonly #readingGroups = new Map<BrowserSessionId, number>();
  readonly #tabVersions = new Map<BrowserSessionId, number>();
  readonly #sessionGroups = new Map<BrowserSessionId, BrowserSessionId>();
  #closed = false;
  readonly ports: BrowserRowPorts;
  readonly changed: Changed;
  constructor(ports: BrowserRowPorts, changed: Changed) {
    this.ports = ports;
    this.changed = changed;
  }

  async acquire(userId: UserId): Promise<Projection> {
    if (this.#closed) throw new Error("Browser row source is closed.");
    let projection = this.#projections.get(userId);
    if (!projection) {
      projection = {
        userId,
        references: 0,
        generation: 0,
        held: true,
        ready: Promise.resolve(),
        tail: Promise.resolve(),
        facts: new Map(),
        groups: new Map(),
        tabs: new Map(),
      };
      this.#projections.set(userId, projection);
      projection.ready = this.reauthorize(userId);
    }
    projection.references++;
    try {
      // A reauthorization can supersede the read an attaching connection awaited.
      let ready: Promise<void>;
      do {
        ready = projection.ready;
        await ready;
      } while (projection.ready !== ready);
      if (this.#closed) throw new Error("Browser row source is closed.");
      return projection;
    } catch (error) {
      this.release(projection);
      throw error;
    }
  }
  release(projection: Projection): void {
    if (--projection.references !== 0) return;
    if (this.#projections.get(projection.userId) === projection)
      this.#projections.delete(projection.userId);
    this.#prune();
  }
  #valid(projection: Projection, generation: number): boolean {
    return (
      !this.#closed &&
      this.#projections.get(projection.userId) === projection &&
      projection.generation === generation
    );
  }
  #prune(): void {
    const held = new Set([
      ...this.#readingGroups.keys(),
      ...[...this.#projections.values()].flatMap((p) => [...p.facts.keys()]),
    ]);
    for (const id of this.#durable.keys()) if (!held.has(id)) this.#durable.delete(id);
    for (const [id, groupId] of this.#sessionGroups)
      if (!held.has(groupId)) this.#sessionGroups.delete(id);
    for (const id of this.#tabVersions.keys())
      if (!held.has(id) && !this.#tabReads.has(id)) this.#tabVersions.delete(id);
  }
  async #reading<T>(ids: readonly BrowserSessionId[], operation: () => Promise<T>): Promise<T> {
    for (const id of ids) this.#readingGroups.set(id, (this.#readingGroups.get(id) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      for (const id of ids) {
        const count = (this.#readingGroups.get(id) ?? 1) - 1;
        if (count) this.#readingGroups.set(id, count);
        else this.#readingGroups.delete(id);
      }
      this.#prune();
    }
  }
  async #loadTabs(groupIds: readonly BrowserSessionId[]): Promise<void> {
    const pending = groupIds.flatMap((id) => {
      const work = this.#tabReads.get(id);
      return work ? [work] : [];
    });
    const fresh = groupIds.filter((id) => !this.#tabReads.has(id));
    if (!fresh.length) {
      await Promise.all(pending);
      return;
    }
    const work = (async () => {
      let ids = fresh;
      while (ids.length && !this.#closed) {
        const versions = new Map(ids.map((id) => [id, this.#tabVersions.get(id) ?? 0]));
        const rows = await this.ports.readTabs(ids);
        if (this.#closed) return;
        const maps = new Map(ids.map((id) => [id, new Map<string, PersonalTabStreamRow>()]));
        for (const row of rows) maps.get(row.groupId)?.set(row.id, row);
        for (const [id, tabs] of maps)
          if (versions.get(id) === (this.#tabVersions.get(id) ?? 0)) this.#durable.set(id, tabs);
        ids = ids.filter((id) => versions.get(id) !== (this.#tabVersions.get(id) ?? 0));
      }
    })().finally(() => {
      for (const id of fresh) this.#tabReads.delete(id);
    });
    for (const id of fresh) this.#tabReads.set(id, work);
    await Promise.all([work, ...pending]);
  }
  #live(facts: BrowserGroupFacts): BrowserLiveRows | undefined {
    return current(facts) ? this.ports.live(facts.sessionId) : undefined;
  }
  #tab(
    facts: BrowserGroupFacts,
    id: string,
    durableTabs = this.#durable.get(facts.id),
  ): Omit<BrowserTabRow, "occupants"> | undefined {
    const durable = durableTabs?.get(id);
    const live = this.#live(facts);
    const record = live?.records.get(id);
    if (!durable && !record) return;
    const restoring = durable?.state === "restoring" && (!record || record.url === "about:blank");
    return {
      id: record?.id ?? durable!.id,
      sessionId: facts.sessionId,
      title: (!restoring && record ? record.title : durable!.title).slice(0, 256),
      site: !restoring && record ? browserPageSite(record.url).slice(0, 2048) : durable!.site,
      iconRef: !restoring && record ? live!.iconRef(id) : (durable!.iconRef ?? null),
      order: durable?.order ?? record!.order,
      openerId: durable?.openerId ?? record?.openerId ?? null,
      createdAt: durable?.createdAt ?? facts.sessionCreatedAt,
      state: restoring ? "restoring" : (record?.state ?? "suspended"),
      availability:
        facts.unavailableReason || !current(facts)
          ? "unavailable"
          : facts.state === "starting"
            ? "starting"
            : live?.ready
              ? "ready"
              : "unavailable",
      loading: record?.loading ?? false,
      navigationFailed: record?.navigationFailed ?? false,
      documentId: restoring ? null : (record?.documentId ?? null),
      canGoBack: record?.canGoBack ?? false,
      canGoForward: record?.canGoForward ?? false,
    };
  }
  #group(projection: Projection, facts: BrowserGroupFacts): boolean {
    const live = this.#live(facts);
    const row: BrowserGroupRow = {
      ...facts,
      tabCount:
        projection.tabs.get(facts.id)?.size ?? Math.max(facts.tabCount, live?.records.size ?? 0),
      inventoryRevision: live?.inventoryRevision ?? 0,
      navigation: live?.navigation ?? false,
      acting: live?.acting ?? false,
      page: live?.page ?? null,
    };
    if (equal(projection.groups.get(row.id), row)) return false;
    projection.groups.set(row.id, row);
    return true;
  }
  #setTabs(
    projection: Projection,
    facts: BrowserGroupFacts,
    ids: Iterable<string>,
    canonical?: ReadonlyMap<string, Omit<BrowserTabRow, "occupants"> | undefined>,
  ): string[] {
    let tabs = projection.tabs.get(facts.id);
    if (!tabs) {
      tabs = new Map();
      projection.tabs.set(facts.id, tabs);
    }
    const changed: string[] = [];
    for (const id of ids) {
      const tab = canonical ? canonical.get(id) : this.#tab(facts, id);
      if (!tab) {
        if (tabs.delete(id)) changed.push(id);
        continue;
      }
      const row = {
        ...tab,
        occupants: this.ports.occupants(projection.userId, facts.sessionId, id),
      };
      if (equal(tabs.get(id), row)) continue;
      tabs.set(id, row);
      changed.push(id);
    }
    return changed;
  }
  #allTabs(projection: Projection, facts: BrowserGroupFacts): string[] {
    return this.#setTabs(
      projection,
      facts,
      new Set([
        ...(projection.tabs.get(facts.id)?.keys() ?? []),
        ...(this.#durable.get(facts.id)?.keys() ?? []),
        ...(this.#live(facts)?.records.keys() ?? []),
      ]),
    );
  }
  #remove(projection: Projection, id: BrowserSessionId): void {
    projection.facts.delete(id);
    projection.tabs.delete(id);
    if (projection.groups.delete(id)) this.changed(projection, id, [], true);
  }
  #install(projection: Projection, facts: BrowserGroupFacts, tabsChanged = false): void {
    if (!current(facts) && facts.tabCount === 0) {
      this.#remove(projection, facts.id);
      return;
    }
    const previous = projection.facts.get(facts.id);
    projection.facts.set(facts.id, facts);
    if (previous && previous.sessionId !== facts.sessionId)
      this.#sessionGroups.delete(previous.sessionId);
    this.#sessionGroups.set(facts.sessionId, facts.id);
    const ids =
      tabsChanged ||
      !previous ||
      previous.sessionId !== facts.sessionId ||
      previous.state !== facts.state ||
      previous.unavailableReason !== facts.unavailableReason
        ? this.#allTabs(projection, facts)
        : [];
    const groupChanged = this.#group(projection, facts);
    if (ids.length || groupChanged) this.changed(projection, facts.id, ids, groupChanged);
  }
  markTabs(sessionId: BrowserSessionId, ids: Iterable<string>): void {
    const groupId = this.ports.live(sessionId)?.groupId ?? this.#sessionGroups.get(sessionId);
    if (!groupId) return;
    const keys = [...new Set(ids)];
    const canonical = new Map<string, Omit<BrowserTabRow, "occupants"> | undefined>();
    for (const projection of this.#projections.values()) {
      const facts = projection.facts.get(groupId);
      if (!facts || facts.sessionId !== sessionId) continue;
      if (!canonical.size) for (const id of keys) canonical.set(id, this.#tab(facts, id));
      const changed = this.#setTabs(projection, facts, keys, canonical);
      const groupChanged = this.#group(projection, facts);
      if (changed.length || groupChanged) this.changed(projection, groupId, changed, groupChanged);
    }
  }
  markGroup(sessionId: BrowserSessionId): void {
    const groupId = this.ports.live(sessionId)?.groupId ?? this.#sessionGroups.get(sessionId);
    if (!groupId) return;
    for (const projection of this.#projections.values()) {
      const facts = projection.facts.get(groupId);
      if (facts?.sessionId === sessionId && this.#group(projection, facts))
        this.changed(projection, groupId, [], true);
    }
  }
  tabsWritten(
    groupId: BrowserSessionId,
    rows: readonly PersonalTabStreamRow[],
    closedIds: readonly string[],
  ): void {
    if (!rows.length && !closedIds.length) return;
    const durable = this.#durable.get(groupId);
    if (!durable && !this.#tabReads.has(groupId)) return;
    this.#tabVersions.set(groupId, (this.#tabVersions.get(groupId) ?? 0) + 1);
    if (!durable) return;
    for (const row of rows) durable.set(row.id, row);
    for (const id of closedIds) durable.delete(id);
    const keys = [...rows.map((row) => row.id), ...closedIds];
    for (const projection of this.#projections.values()) {
      const previous = projection.facts.get(groupId);
      if (!previous) continue;
      const facts = { ...previous, tabCount: durable.size };
      projection.facts.set(groupId, facts);
      if (!current(facts) && !durable.size) {
        this.#remove(projection, groupId);
        continue;
      }
      const changed = this.#setTabs(projection, facts, keys);
      const groupChanged = this.#group(projection, facts);
      if (changed.length || groupChanged) this.changed(projection, groupId, changed, groupChanged);
    }
  }
  async groupChanged(sessionId: BrowserSessionId, options: { tabs?: boolean } = {}): Promise<void> {
    if (!this.#projections.size || this.#closed) return;
    const id =
      this.ports.live(sessionId)?.groupId ??
      this.#sessionGroups.get(sessionId) ??
      (await this.ports.groupId(sessionId));
    if (!id) return;
    await this.#reading([id], async () => {
      if (options.tabs) this.#tabVersions.set(id, (this.#tabVersions.get(id) ?? 0) + 1);
      let tabs: Promise<void> | undefined;
      await Promise.all(
        [...this.#projections.values()].map((projection) => {
          const generation = projection.generation;
          const work = projection.tail
            .catch(() => undefined)
            .then(async () => {
              if (projection.held) await projection.ready;
              if (!this.#valid(projection, generation)) return;
              const rows = await this.ports.readGroups(projection.userId, [id]);
              if (!this.#valid(projection, generation)) return;
              const facts = rows[0];
              if (!facts) {
                this.#remove(projection, id);
                return;
              }
              if (options.tabs || !this.#durable.has(id)) tabs ??= this.#loadTabs([id]);
              if (tabs) await tabs;
              if (this.#valid(projection, generation))
                this.#install(projection, facts, options.tabs);
            });
          projection.tail = work;
          return work;
        }),
      );
    });
  }
  reauthorize(userId: UserId): Promise<void> {
    const projection = this.#projections.get(userId);
    if (!projection || this.#closed) return Promise.resolve();
    projection.held = true;
    const generation = ++projection.generation;
    projection.tail = Promise.resolve();
    const work = (async () => {
      const ids = await this.ports.groupIds(userId);
      if (!this.#valid(projection, generation)) return;
      const rows = await this.ports.readGroups(userId, ids);
      const byId = new Map(rows.map((row) => [row.id, row]));
      const facts = ids.flatMap((id) => {
        const row = byId.get(id);
        return row ? [row] : [];
      });
      if (!this.#valid(projection, generation)) return;
      const visible = new Set(facts.map((row) => row.id));
      for (const id of projection.facts.keys()) if (!visible.has(id)) this.#remove(projection, id);
      await this.#reading(
        facts.map((row) => row.id),
        async () => {
          await this.#loadTabs(
            facts.filter((row) => !this.#durable.has(row.id)).map((row) => row.id),
          );
          if (this.#valid(projection, generation))
            for (const row of facts) this.#install(projection, row);
        },
      );
      if (!this.#valid(projection, generation)) return;
      projection.held = false;
      this.changed(projection, null, [], false);
      this.#prune();
    })();
    projection.ready = work;
    return work;
  }
  async bootstrap(
    userId: UserId,
    maxBytes = 128 * 1024,
  ): Promise<Pick<HostedBrowserBootstrap, "groups" | "tabs" | "continuation">> {
    if (this.#closed) return { groups: { rows: [], complete: true }, tabs: [] };
    const authority = this.ports.authorityGeneration();
    const budget = Math.max(512, Math.floor(maxBytes / 2) - 1024);
    const cached = this.#projections.get(userId);
    const groups = new Map<BrowserSessionId, BrowserGroupRow>();
    const facts = new Map<BrowserSessionId, BrowserGroupFacts>();
    const ids =
      cached && !cached.held ? [...cached.groups.keys()] : await this.ports.groupIds(userId);
    let bytes = 0;
    let exhausted = true;
    for (let offset = 0; offset < ids.length && exhausted; offset += 32) {
      const batch = ids.slice(offset, offset + 32);
      const missing = batch.filter((id) => !cached || cached.held || !cached.groups.has(id));
      if (missing.length)
        for (const read of await this.ports.readGroups(userId, missing)) facts.set(read.id, read);
      for (const id of batch) {
        let group = cached && !cached.held ? cached.groups.get(id) : undefined;
        if (!group) {
          const read = facts.get(id);
          if (!read || (!current(read) && !read.tabCount)) continue;
          const live = this.#live(read);
          group = {
            ...read,
            tabCount: Math.max(read.tabCount, live?.records.size ?? 0),
            inventoryRevision: live?.inventoryRevision ?? 0,
            navigation: live?.navigation ?? false,
            acting: live?.acting ?? false,
            page: live?.page ?? null,
          };
        }
        groups.set(id, group);
        bytes += keyedStreamBytes(group) + 1;
        if (bytes >= budget) {
          exhausted = false;
          break;
        }
      }
    }
    const packedGroups = prefix(groups, budget, { complete: false });
    packedGroups.complete &&= exhausted;
    const tabs: Required<HostedBrowserBootstrap>["tabs"] = [];
    let used = 2;
    for (const group of packedGroups.rows) {
      let rows = cached && !cached.held ? cached.tabs.get(group.id) : undefined;
      if (!rows) {
        const durable = new Map(
          (await this.ports.readTabs([group.id])).map((row) => [row.id, row]),
        );
        const read = facts.get(group.id)!;
        rows = new Map();
        for (const id of new Set([
          ...durable.keys(),
          ...(this.#live(read)?.records.keys() ?? []),
        ])) {
          const row = this.#tab(read, id, durable);
          if (row)
            rows.set(id, { ...row, occupants: this.ports.occupants(userId, group.sessionId, id) });
        }
        groups.set(group.id, { ...group, tabCount: rows.size });
      }
      const packed = prefix(rows, budget - used, { groupId: group.id, complete: false });
      const entry = { groupId: group.id, ...packed };
      if (keyedStreamBytes(entry) + used + (tabs.length ? 1 : 0) > budget) break;
      tabs.push(entry);
      used += keyedStreamBytes(entry) + (tabs.length > 1 ? 1 : 0);
      if (!packed.complete) break;
    }
    if (authority !== this.ports.authorityGeneration()) return this.bootstrap(userId, maxBytes);
    const finalGroups = prefix(groups, budget, { complete: false });
    finalGroups.complete &&= exhausted;
    const included = new Set(finalGroups.rows.map((row) => row.id));
    const packed = {
      groups: finalGroups,
      tabs: tabs.filter((entry) => included.has(entry.groupId)),
    };
    return {
      ...packed,
      continuation: createHash("sha256").update(JSON.stringify(packed)).digest("hex"),
    };
  }
  reauthorizeAll(): Promise<void> {
    return Promise.all([...this.#projections.keys()].map((id) => this.reauthorize(id))).then(
      () => undefined,
    );
  }
  close(): void {
    this.#closed = true;
    this.#projections.clear();
    this.#durable.clear();
    this.#sessionGroups.clear();
    this.#tabVersions.clear();
    this.#readingGroups.clear();
  }
}

interface Connection {
  readonly userId: UserId;
  readonly send: (message: BrowserClientStreamMessage) => Promise<void>;
  readonly bufferedAmount: () => number;
  readonly projection: Projection;
  readonly groups: KeyedStreamPublisher<BrowserGroupRow, Record<string, never>>;
  readonly tabs: Map<BrowserSessionId, KeyedStreamPublisher<BrowserTabRow, Record<string, never>>>;
  readonly pendingTabs: Set<BrowserSessionId>;
  timer: ReturnType<typeof setTimeout> | null;
  sending: boolean;
  closed: boolean;
}
export class BrowserClientStreams {
  #closed = false;
  readonly #connections = new Set<Connection>();
  readonly source: BrowserRowSource;
  readonly options: BrowserRowPorts;
  constructor(options: BrowserRowPorts) {
    this.options = options;
    this.source = new BrowserRowSource(options, (projection, groupId, ids, groupChanged) => {
      for (const connection of this.#connections) {
        if (connection.projection !== projection) continue;
        if (groupId === null) {
          this.#schedule(connection);
          continue;
        }
        if (groupChanged) connection.groups.mark(groupId);
        if (!projection.groups.has(groupId)) {
          connection.tabs.delete(groupId);
          connection.pendingTabs.delete(groupId);
        } else if (ids.length || !connection.tabs.has(groupId)) {
          const publisher = this.#tabs(connection, groupId);
          for (const id of ids) publisher.mark(id);
          connection.pendingTabs.add(groupId);
        }
        this.#schedule(connection);
      }
    });
  }
  async attach(
    userId: UserId,
    transport: Pick<Connection, "send" | "bufferedAmount">,
    continuation?: string,
  ) {
    if (this.#closed) throw new Error("Browser client streams are closed.");
    const projection = await this.source.acquire(userId);
    let prefix: Awaited<ReturnType<BrowserRowSource["bootstrap"]>> | undefined;
    try {
      if (continuation) prefix = await this.source.bootstrap(userId);
      if (this.#closed) throw new Error("Browser client streams are closed.");
    } catch (error) {
      this.source.release(projection);
      throw error;
    }
    const connection: Connection = {
      ...transport,
      userId,
      projection,
      tabs: new Map(),
      pendingTabs: new Set(),
      timer: null,
      sending: false,
      closed: false,
      groups: new KeyedStreamPublisher({
        ids: () => projection.groups.keys(),
        read: (id) => projection.groups.get(id as BrowserSessionId),
        meta: () => ({}),
        targetBytes: 16 * 1024,
        envelopeBytes: keyedStreamBytes({ type: "host.browser-groups", stream: null }) - 4,
      }),
    };
    if (prefix?.continuation === continuation && prefix) {
      connection.groups.seed(prefix.groups.rows);
      for (const entry of prefix.tabs)
        if (projection.groups.has(entry.groupId))
          this.#tabs(connection, entry.groupId).seed(entry.rows);
    }
    this.#connections.add(connection);
    for (const id of projection.groups.keys()) this.#tabs(connection, id);
    this.#schedule(connection);
    return {
      resync: (groupId?: BrowserSessionId) => {
        if (groupId) {
          const publisher = connection.tabs.get(groupId);
          if (publisher) {
            publisher.reset();
            connection.pendingTabs.add(groupId);
          }
        } else {
          connection.groups.reset();
          for (const [id, publisher] of connection.tabs) {
            publisher.reset();
            connection.pendingTabs.add(id);
          }
        }
        this.#schedule(connection);
      },
      close: () => {
        if (connection.closed) return;
        connection.closed = true;
        if (connection.timer) clearTimeout(connection.timer);
        this.#connections.delete(connection);
        this.source.release(projection);
      },
    };
  }
  #tabs(connection: Connection, groupId: BrowserSessionId) {
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
      connection.pendingTabs.add(groupId);
    }
    return publisher;
  }
  #schedule(connection: Connection) {
    if (connection.closed || connection.projection.held || connection.timer || connection.sending)
      return;
    connection.timer = setTimeout(() => {
      connection.timer = null;
      void this.#flush(connection).catch(this.options.onError);
    }, 50);
    connection.timer.unref();
  }
  async #flush(connection: Connection) {
    if (connection.closed || connection.projection.held) return;
    connection.sending = true;
    try {
      while (
        !connection.closed &&
        !connection.projection.held &&
        connection.bufferedAmount() < 256 * 1024
      ) {
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
        for (const groupId of connection.pendingTabs) {
          if (!connection.projection.groups.has(groupId) || !connection.groups.hasSent(groupId))
            continue;
          const publisher = connection.tabs.get(groupId)!;
          const frame = publisher.next();
          if (!frame) {
            connection.pendingTabs.delete(groupId);
            continue;
          }
          try {
            await connection.send({ type: "host.browser-tabs", groupId, stream: frame });
            publisher.settled(frame, true);
          } catch (error) {
            publisher.settled(frame, false);
            throw error;
          }
          if (connection.tabs.get(groupId) === publisher && !publisher.pending)
            connection.pendingTabs.delete(groupId);
          sent = true;
          break;
        }
        if (!sent) break;
      }
    } finally {
      connection.sending = false;
      if (connection.groups.pending || connection.pendingTabs.size) this.#schedule(connection);
    }
  }
  close() {
    this.#closed = true;
    for (const connection of this.#connections) {
      connection.closed = true;
      if (connection.timer) clearTimeout(connection.timer);
    }
    this.#connections.clear();
    this.source.close();
  }
}
