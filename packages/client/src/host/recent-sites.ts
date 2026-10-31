import { z } from "zod";
import { BrowserFaviconSchema } from "@opensteer/protocol";
import type { BrowserSessionSummary } from "./client.js";
import type { BrowserIdentityChoice } from "./start-page-model.js";

export interface RecentSitesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface RecentSitesScope {
  readonly deploymentId: string;
  readonly userId: string;
}
export interface RecentSite {
  readonly origin: string;
  readonly lastUsed: number;
  readonly favicon?: string;
}
const webUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  });
const timestamp = z.number().int().nonnegative().safe();
const entrySchema = z.strictObject({
  url: webUrl,
  title: z.string().max(200),
  typedCount: z.number().int().nonnegative().safe(),
  visitCount: z.number().int().positive().safe(),
  lastVisit: timestamp,
});
export type BrowsingHistoryEntry = z.infer<typeof entrySchema> & { readonly favicon?: string };
const entriesSchema = z
  .record(z.string().min(1).max(255), z.array(entrySchema).max(300))
  .refine((value) => Object.keys(value).length <= 128);
const saved = z.strictObject({
  entries: entriesSchema,
  icons: z.record(z.string().min(1).max(255), z.record(webUrl, BrowserFaviconSchema)),
});
type HistoryData = z.infer<typeof saved>;
const emptyHistory = (): HistoryData => ({ entries: {}, icons: {} });
/** A tab a person opened for a site, until its first web document is replaced. */
interface OpenedTab {
  readonly profileId: string;
  readonly origin: string;
  landed?: { readonly site: string; readonly documentId: string | null };
}
const legacy = z
  .record(
    z.string().max(255),
    z
      .array(
        z.strictObject({
          origin: webUrl.refine((value) => new URL(value).origin === value),
          lastUsed: timestamp,
        }),
      )
      .max(12),
  )
  .refine((value) => Object.keys(value).length <= 128);
const visited = (data: HistoryData, profileId: string, origin: string) =>
  Object.hasOwn(data.entries, profileId) &&
  data.entries[profileId]!.some((entry) => new URL(entry.url).origin === origin);
const retentionMs = 90 * 86400000;
const maximumBytes = 1024 * 1024;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/**
 * Only person navigation adds visits. A site's icon comes from any open tab of
 * the same profile showing it, and from the first document of the tab a person
 * opened for it, so a redirect still marks the address they asked for.
 */
export class RecentSitesStore {
  readonly #storage: RecentSitesStorage | undefined;
  readonly #now: () => number;
  #scope: RecentSitesScope | null = null;
  #epoch = 0;
  #storageFailed = false;
  readonly #readIcon: ((sessionId: string, iconRef: string) => Promise<string | null>) | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #opened = new Map<string, OpenedTab>();
  /** The icon reference read, or being read, for each profile and origin. */
  readonly #iconReads = new Map<string, string>();
  #sessions: readonly BrowserSessionSummary[] = [];
  #connected = false;
  #revision = 0;
  #memory: HistoryData = emptyHistory();
  readonly getRevision = () => this.#revision;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #publish(): void {
    this.#revision++;
    for (const listener of this.#listeners) listener();
  }
  get epoch(): number {
    return this.#epoch;
  }
  constructor(
    options: {
      readonly storage?: RecentSitesStorage;
      readonly now?: () => number;
      readonly readIcon?: (sessionId: string, iconRef: string) => Promise<string | null>;
    } = {},
  ) {
    this.#storage = options.storage;
    this.#now = options.now ?? Date.now;
    this.#readIcon = options.readIcon;
  }
  setScope(scope: RecentSitesScope | null): void {
    if (scope?.deploymentId === this.#scope?.deploymentId && scope?.userId === this.#scope?.userId)
      return;
    if (scope === null) this.clear();
    this.#scope = scope;
    this.#epoch++;
    this.#memory = emptyHistory();
    this.#forgetIcons();
    this.#sessions = [];
    this.#publish();
  }
  #key(prefix = "opensteer.browsing-history.v2"): string | null {
    return this.#scope
      ? `${prefix}:${JSON.stringify([this.#scope.deploymentId, this.#scope.userId])}`
      : null;
  }
  #read(): HistoryData {
    const key = this.#key();
    if (!key || this.#storageFailed) return emptyHistory();
    if (!this.#storage) return this.#memory;
    try {
      const value = this.#storage.getItem(key);
      if (value !== null)
        return value.length <= maximumBytes && bytes(value) <= maximumBytes
          ? saved.parse(JSON.parse(value))
          : emptyHistory();
      const historyKey = this.#key("opensteer.browsing-history.v1")!;
      const history = this.#storage.getItem(historyKey);
      if (history !== null) {
        if (history.length > maximumBytes || bytes(history) > maximumBytes) return emptyHistory();
        const migrated = { entries: entriesSchema.parse(JSON.parse(history)), icons: {} };
        this.#write(migrated, false);
        if (!this.#storageFailed) this.#storage.removeItem(historyKey);
        return migrated;
      }
      const oldKey = this.#key("opensteer.recent-sites.v1")!;
      const old = this.#storage.getItem(oldKey);
      if (!old || old.length > 128 * 1024) return emptyHistory();
      const entries = Object.fromEntries(
        Object.entries(legacy.parse(JSON.parse(old))).map(([profile, sites]) => [
          profile,
          sites
            .filter((site) => site.origin.length + 1 <= 2048)
            .map((site) => ({
              url: `${site.origin}/`,
              title: "",
              typedCount: 0,
              visitCount: 1,
              lastVisit: site.lastUsed,
            })),
        ]),
      );
      const migrated = { entries, icons: {} };
      this.#write(migrated, false);
      if (!this.#storageFailed) this.#storage.removeItem(oldKey);
      return migrated;
    } catch {
      return emptyHistory();
    }
  }
  #bounded(value: HistoryData): HistoryData {
    const now = this.#now();
    const profiles = Object.entries(value.entries)
      .map(([profile, entries]) => {
        const seen = new Set<string>();
        return [
          profile,
          [...entries]
            .sort((a, b) => b.lastVisit - a.lastVisit)
            .filter((entry) => {
              if (
                entry.lastVisit <= now - retentionMs ||
                entry.lastVisit > now ||
                seen.has(entry.url)
              )
                return false;
              seen.add(entry.url);
              return true;
            })
            .slice(0, 300),
        ] as const;
      })
      .filter(([, entries]) => entries.length > 0)
      .sort((a, b) => b[1][0]!.lastVisit - a[1][0]!.lastVisit)
      .slice(0, 128);
    const bounded: HistoryData = { entries: Object.fromEntries(profiles), icons: {} };
    const originCounts = new Map<string, Map<string, number>>();
    // One raster per origin and profile, retained only while that site has history.
    for (const [profile, entries] of profiles) {
      const counts = new Map<string, number>();
      for (const entry of entries) {
        const origin = new URL(entry.url).origin;
        counts.set(origin, (counts.get(origin) ?? 0) + 1);
      }
      originCounts.set(profile, counts);
      const icons = Object.fromEntries(
        [...counts.keys()].flatMap((origin) => {
          const icon = Object.hasOwn(value.icons, profile) ? value.icons[profile]?.[origin] : null;
          return icon ? [[origin, icon]] : [];
        }),
      );
      if (Object.keys(icons).length) bounded.icons[profile] = icons;
    }
    // Remove oldest visits globally, including JSON escaping and UTF-8 in the bound.
    const oldest = profiles
      .flatMap(([profile, entries]) => entries.map((entry) => ({ profile, entry })))
      .sort((a, b) => a.entry.lastVisit - b.entry.lastVisit);
    let size = bytes(JSON.stringify(bounded));
    for (const { profile, entry } of oldest) {
      if (size <= maximumBytes) break;
      const entries = bounded.entries[profile]!;
      const serialized = bytes(JSON.stringify(entry));
      entries.splice(entries.indexOf(entry), 1);
      size -= serialized + (entries.length ? 1 : 0);
      if (!entries.length) {
        delete bounded.entries[profile];
        size -= bytes(JSON.stringify(profile)) + 3 + (Object.keys(bounded.entries).length ? 1 : 0);
      }
      const origin = new URL(entry.url).origin;
      const counts = originCounts.get(profile)!;
      counts.set(origin, counts.get(origin)! - 1);
      const icons = bounded.icons[profile];
      const icon = icons?.[origin];
      if (counts.get(origin) === 0 && icons && icon) {
        delete icons[origin];
        size -=
          bytes(JSON.stringify(origin)) +
          1 +
          bytes(JSON.stringify(icon)) +
          (Object.keys(icons).length ? 1 : 0);
        if (!Object.keys(icons).length) {
          delete bounded.icons[profile];
          size -= bytes(JSON.stringify(profile)) + 3 + (Object.keys(bounded.icons).length ? 1 : 0);
        }
      }
    }
    return bounded;
  }
  #write(value: HistoryData, notify = true): void {
    const key = this.#key();
    if (!key) return;
    const bounded = this.#bounded(value);
    if (!this.#storage) {
      this.#memory = bounded;
      if (notify) this.#publish();
      return;
    }
    try {
      this.#storage.setItem(key, JSON.stringify(bounded));
    } catch {
      this.#storageFailed = true;
      return;
    }
    if (notify) this.#publish();
  }
  history(identity: BrowserIdentityChoice): readonly BrowsingHistoryEntry[] {
    if (!this.#scope || identity.kind === "guest") return [];
    const entries = this.#read();
    const bounded = this.#bounded(entries);
    if (JSON.stringify(entries) !== JSON.stringify(bounded)) this.#write(bounded, false);
    return Object.hasOwn(bounded.entries, identity.profileId)
      ? bounded.entries[identity.profileId]!.map((entry) => {
          const favicon = bounded.icons[identity.profileId]?.[new URL(entry.url).origin];
          return favicon ? { ...entry, favicon } : entry;
        })
      : [];
  }
  list(identity: BrowserIdentityChoice): readonly RecentSite[] {
    const seen = new Set<string>();
    return this.history(identity)
      .flatMap((entry) => {
        const origin = new URL(entry.url).origin;
        if (seen.has(origin)) return [];
        seen.add(origin);
        return [
          {
            origin,
            lastUsed: entry.lastVisit,
            ...(entry.favicon ? { favicon: entry.favicon } : {}),
          },
        ];
      })
      .slice(0, 12);
  }
  record(
    identity: BrowserIdentityChoice,
    address: string,
    epoch: number,
    visit: {
      readonly title?: string;
      readonly typed?: boolean;
      readonly tab?: { readonly sessionId: string; readonly tabId: string };
    } = {},
  ): void {
    if (
      !this.#scope ||
      identity.kind === "guest" ||
      epoch !== this.#epoch ||
      identity.profileId.length === 0 ||
      identity.profileId.length > 255
    )
      return;
    const parsed = webUrl.safeParse(address);
    if (!parsed.success) return;
    const url = new URL(parsed.data).href;
    if (url.length > 2048) return;
    const previous = this.history(identity).find((entry) => entry.url === url);
    const entry: BrowsingHistoryEntry = {
      url,
      title: (visit.title ?? previous?.title ?? "").slice(0, 200),
      typedCount: Math.min(
        Number.MAX_SAFE_INTEGER,
        (previous?.typedCount ?? 0) + (visit.typed === false ? 0 : 1),
      ),
      visitCount: Math.min(Number.MAX_SAFE_INTEGER, (previous?.visitCount ?? 0) + 1),
      lastVisit: this.#now(),
    };
    const data = this.#read();
    const origin = new URL(url).origin;
    // A tab already showing a newly visited site may hold its icon.
    if (!visited(data, identity.profileId, origin))
      this.#iconReads.delete(JSON.stringify([identity.profileId, origin]));
    this.#write({
      ...data,
      entries: {
        ...data.entries,
        [identity.profileId]: [
          entry,
          ...(data.entries[identity.profileId] ?? []).filter((row) => row.url !== url),
        ],
      },
    });
    if (visit.tab)
      this.#opened.set(JSON.stringify([visit.tab.sessionId, visit.tab.tabId]), {
        profileId: identity.profileId,
        origin,
      });
    this.#readIcons();
  }

  observeTabs(sessions: readonly BrowserSessionSummary[], connected: boolean): void {
    if (sessions === this.#sessions && connected === this.#connected) return;
    this.#sessions = sessions;
    this.#connected = connected;
    this.#readIcons();
  }
  #forgetIcons(): void {
    this.#opened.clear();
    this.#iconReads.clear();
  }
  #readIcons(): void {
    const open = new Set<string>();
    const wanted = new Map<string, { readonly sessionId: string; readonly ref: string }>();
    for (const session of this.#sessions)
      for (const tab of session.tabCatalog?.tabs ?? []) {
        const key = JSON.stringify([session.id, tab.id]);
        open.add(key);
        if (!webUrl.safeParse(tab.site).success) continue;
        const opened = this.#opened.get(key);
        if (opened) {
          opened.landed ??= { site: tab.site, documentId: tab.documentId ?? null };
          if (
            opened.landed.site !== tab.site ||
            opened.landed.documentId !== (tab.documentId ?? null)
          )
            this.#opened.delete(key);
        }
        if (!session.profileId || !tab.iconRef) continue;
        const bound = this.#opened.get(key);
        const origins =
          bound?.profileId === session.profileId ? [tab.site, bound.origin] : [tab.site];
        for (const origin of origins) {
          const site = JSON.stringify([session.profileId, origin]);
          if (!wanted.has(site)) wanted.set(site, { sessionId: session.id, ref: tab.iconRef });
        }
      }
    for (const key of this.#opened.keys()) if (!open.has(key)) this.#opened.delete(key);
    // The Host serves only open tabs' icons, so a closed tab's read is moot.
    for (const site of this.#iconReads.keys()) if (!wanted.has(site)) this.#iconReads.delete(site);
    if (!this.#readIcon || !this.#connected) return;
    let data: HistoryData | undefined;
    const epoch = this.#epoch;
    for (const [site, { sessionId, ref }] of wanted) {
      if (this.#iconReads.get(site) === ref) continue;
      this.#iconReads.set(site, ref);
      const [profileId, origin] = JSON.parse(site) as [string, string];
      data ??= this.#read();
      if (!visited(data, profileId, origin)) continue;
      const current = () => this.#epoch === epoch && this.#iconReads.get(site) === ref;
      void this.#readIcon(sessionId, ref)
        .then((read) => {
          const parsed = BrowserFaviconSchema.safeParse(read);
          if (!current() || !parsed.success) return;
          const favicon = parsed.data;
          const latest = this.#read();
          if (!visited(latest, profileId, origin) || latest.icons[profileId]?.[origin] === favicon)
            return;
          this.#write({
            ...latest,
            icons: {
              ...latest.icons,
              [profileId]: { ...latest.icons[profileId], [origin]: favicon },
            },
          });
        })
        // A failed request is tried again on the next tab observation; a reference's answer is final.
        .catch(() => {
          if (current()) this.#iconReads.delete(site);
        });
    }
  }
  dispose(): void {
    this.#epoch++;
    this.#forgetIcons();
    this.#sessions = [];
    this.#listeners.clear();
  }
  remove(identity: BrowserIdentityChoice, url: string): void {
    if (!this.#scope || identity.kind === "guest") return;
    this.#epoch++;
    this.#iconReads.clear();
    const data = this.#read();
    this.#write({
      ...data,
      entries: {
        ...data.entries,
        [identity.profileId]: (data.entries[identity.profileId] ?? []).filter(
          (entry) => entry.url !== url,
        ),
      },
    });
  }
  clear(identity?: BrowserIdentityChoice): void {
    this.#epoch++;
    this.#iconReads.clear();
    if (identity?.kind === "guest") return;
    if (identity?.kind === "profile") {
      const entries = this.#read();
      delete entries.entries[identity.profileId];
      delete entries.icons[identity.profileId];
      this.#write(entries);
      return;
    }
    this.#memory = emptyHistory();
    try {
      for (const prefix of [
        "opensteer.browsing-history.v2",
        "opensteer.browsing-history.v1",
        "opensteer.recent-sites.v1",
      ]) {
        const key = this.#key(prefix);
        if (key) this.#storage?.removeItem(key);
      }
    } catch {
      this.#storageFailed = true;
    }
    this.#publish();
  }
}
