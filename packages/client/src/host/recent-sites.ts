import { z } from "zod";
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
export type BrowsingHistoryEntry = z.infer<typeof entrySchema>;
const saved = z
  .record(z.string().min(1).max(255), z.array(entrySchema).max(300))
  .refine((value) => Object.keys(value).length <= 128);
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
const retentionMs = 90 * 86400000;
const maximumBytes = 1024 * 1024;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/** Person navigation intents are the only writers; browser activity never subscribes here. */
export class RecentSitesStore {
  readonly #storage: RecentSitesStorage | undefined;
  readonly #now: () => number;
  #scope: RecentSitesScope | null = null;
  #epoch = 0;
  #storageFailed = false;
  #memory: Record<string, BrowsingHistoryEntry[]> = {};
  get epoch(): number {
    return this.#epoch;
  }
  constructor(
    options: { readonly storage?: RecentSitesStorage; readonly now?: () => number } = {},
  ) {
    this.#storage = options.storage;
    this.#now = options.now ?? Date.now;
  }
  setScope(scope: RecentSitesScope | null): void {
    if (scope?.deploymentId === this.#scope?.deploymentId && scope?.userId === this.#scope?.userId)
      return;
    if (scope === null) this.clear();
    this.#scope = scope;
    this.#epoch++;
    this.#memory = {};
  }
  #key(prefix = "opensteer.browsing-history.v1"): string | null {
    return this.#scope
      ? `${prefix}:${JSON.stringify([this.#scope.deploymentId, this.#scope.userId])}`
      : null;
  }
  #read(): Record<string, BrowsingHistoryEntry[]> {
    const key = this.#key();
    if (!key || this.#storageFailed) return {};
    if (!this.#storage) return this.#memory;
    try {
      const value = this.#storage.getItem(key);
      if (value !== null)
        return value.length <= maximumBytes && bytes(value) <= maximumBytes
          ? saved.parse(JSON.parse(value))
          : {};
      const oldKey = this.#key("opensteer.recent-sites.v1")!;
      const old = this.#storage.getItem(oldKey);
      if (!old || old.length > 128 * 1024) return {};
      const migrated = Object.fromEntries(
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
      this.#write(migrated);
      this.#storage.removeItem(oldKey);
      return migrated;
    } catch {
      return {};
    }
  }
  #bounded(value: Record<string, BrowsingHistoryEntry[]>): Record<string, BrowsingHistoryEntry[]> {
    const now = this.#now();
    const profiles = Object.entries(value)
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
    const bounded = Object.fromEntries(profiles);
    // Remove oldest visits globally, including JSON escaping and UTF-8 in the bound.
    const oldest = profiles
      .flatMap(([profile, entries]) => entries.map((entry) => ({ profile, entry })))
      .sort((a, b) => a.entry.lastVisit - b.entry.lastVisit);
    let size = bytes(JSON.stringify(bounded));
    for (const { profile, entry } of oldest) {
      if (size <= maximumBytes) break;
      const entries = bounded[profile]!;
      const serialized = bytes(JSON.stringify(entry));
      entries.splice(entries.indexOf(entry), 1);
      size -= serialized + (entries.length ? 1 : 0);
      if (!entries.length) {
        delete bounded[profile];
        size = bytes(JSON.stringify(bounded));
      }
    }
    return bounded;
  }
  #write(value: Record<string, BrowsingHistoryEntry[]>): void {
    const key = this.#key();
    if (!key) return;
    const bounded = this.#bounded(value);
    if (!this.#storage) {
      this.#memory = bounded;
      return;
    }
    try {
      this.#storage.setItem(key, JSON.stringify(bounded));
    } catch {
      this.#storageFailed = true;
    }
  }
  history(identity: BrowserIdentityChoice): readonly BrowsingHistoryEntry[] {
    if (!this.#scope || identity.kind === "guest") return [];
    const entries = this.#read();
    const bounded = this.#bounded(entries);
    if (JSON.stringify(entries) !== JSON.stringify(bounded)) this.#write(bounded);
    return Object.hasOwn(bounded, identity.profileId) ? bounded[identity.profileId]! : [];
  }
  list(identity: BrowserIdentityChoice): readonly RecentSite[] {
    const seen = new Set<string>();
    return this.history(identity)
      .flatMap((entry) => {
        const origin = new URL(entry.url).origin;
        if (seen.has(origin)) return [];
        seen.add(origin);
        return [{ origin, lastUsed: entry.lastVisit }];
      })
      .slice(0, 12);
  }
  record(
    identity: BrowserIdentityChoice,
    address: string,
    epoch: number,
    visit: { readonly title?: string; readonly typed?: boolean } = {},
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
    this.#write({
      ...this.#read(),
      [identity.profileId]: [entry, ...this.history(identity).filter((row) => row.url !== url)],
    });
  }
  remove(identity: BrowserIdentityChoice, url: string): void {
    if (!this.#scope || identity.kind === "guest") return;
    this.#epoch++;
    this.#write({
      ...this.#read(),
      [identity.profileId]: this.history(identity).filter((entry) => entry.url !== url),
    });
  }
  clear(identity?: BrowserIdentityChoice): void {
    this.#epoch++;
    if (identity?.kind === "guest") return;
    if (identity?.kind === "profile") {
      const entries = this.#read();
      delete entries[identity.profileId];
      this.#write(entries);
      return;
    }
    this.#memory = {};
    try {
      for (const prefix of ["opensteer.browsing-history.v1", "opensteer.recent-sites.v1"]) {
        const key = this.#key(prefix);
        if (key) this.#storage?.removeItem(key);
      }
    } catch {
      this.#storageFailed = true;
    }
  }
}
