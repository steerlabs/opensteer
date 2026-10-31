import {
  browserHistoryIconsMaxRefs,
  type BrowserHistory,
  type BrowserHistoryEntry,
  type BrowserHistoryIcons,
} from "@opensteer/protocol";
import type { ViewerIdentity } from "./viewer-scope.js";

interface ProfileHistory {
  value: BrowserHistory;
  version: number;
  stale: boolean;
  /** The last read failed; what is shown may not be the Host's history. */
  failed: boolean;
  pending?: Promise<void>;
  mutations: Set<Promise<void>>;
}
const empty = (): BrowserHistory => ({ entries: [], icons: [] });
const emptyEntries: readonly BrowserHistoryEntry[] = [];
const iconCacheLimit = 512;

/** A raster source, or a neutral mark when no image is available. */
export type BrowserFavicon = string | null;

/** Host-owned history, fetched only by the surfaces that display it. */
export class BrowserHistoryClient {
  readonly #profiles = new Map<string, ProfileHistory>();
  // Undefined reserves an in-flight read; null is a completed miss, retried on history refresh.
  readonly #icons = new Map<string, BrowserFavicon | undefined>();
  readonly #queued = new Map<string, Set<string>>();
  readonly #listeners = new Set<() => void>();
  #scope = "";
  #generation = 0;
  #revision = 0;
  #connected = false;
  readonly ports: {
    get(profileId: string): Promise<BrowserHistory>;
    icons(profileId: string, iconRefs: string[]): Promise<BrowserHistoryIcons>;
    remove(profileId: string, url: string): Promise<void>;
    clear(profileId: string): Promise<void>;
  };
  constructor(ports: BrowserHistoryClient["ports"]) {
    this.ports = ports;
  }
  readonly getRevision = () => this.#revision;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  #publish(): void {
    this.#revision++;
    for (const listener of this.#listeners) listener();
  }
  #profile(profileId: string): ProfileHistory {
    let state = this.#profiles.get(profileId);
    if (!state) {
      state = { value: empty(), version: 0, stale: false, failed: false, mutations: new Set() };
      this.#profiles.set(profileId, state);
    }
    return state;
  }
  setScope(scope: ViewerIdentity | null): void {
    const key = scope ? JSON.stringify([scope.deploymentId, scope.userId]) : "";
    if (key === this.#scope) return;
    this.#scope = key;
    this.#generation++;
    this.#profiles.clear();
    this.#icons.clear();
    this.#queued.clear();
    this.#publish();
  }
  setConnected(connected: boolean): void {
    const reconnected = connected && !this.#connected;
    if (!connected && this.#connected)
      for (const state of this.#profiles.values()) {
        state.version++;
        delete state.pending;
      }
    this.#connected = connected;
    if (reconnected) for (const profileId of this.#profiles.keys()) void this.load(profileId);
  }
  failed(profileId: string | null): boolean {
    return (profileId && this.#profiles.get(profileId)?.failed) || false;
  }
  entries(profileId: string | null): readonly BrowserHistoryEntry[] {
    return (profileId && this.#profiles.get(profileId)?.value.entries) || emptyEntries;
  }
  iconRef(profileId: string | null, url: string): string | null {
    if (!profileId) return null;
    const origin = new URL(url).origin;
    return (
      this.#profiles.get(profileId)?.value.icons.find((icon) => icon.origin === origin)?.iconRef ??
      null
    );
  }
  changed(profileId: string): void {
    const state = this.#profiles.get(profileId);
    if (!state) return;
    state.stale = true;
    if (this.#listeners.size > 0) void this.load(profileId);
  }
  load(profileId: string | null): Promise<void> {
    if (!this.#scope || !profileId) return Promise.resolve();
    const state = this.#profile(profileId);
    if (state.pending) return state.pending;
    state.stale = false;
    const version = state.version;
    const current = () => this.#profiles.get(profileId) === state && state.version === version;
    const pending = Promise.allSettled(state.mutations)
      .then(() => (current() ? this.ports.get(profileId) : undefined))
      .then((value) => {
        if (!value || !current()) return;
        state.value = value;
        state.failed = false;
        for (const { iconRef } of value.icons)
          if (this.#icons.get(iconRef) === null) this.#icons.delete(iconRef);
        this.#publish();
      })
      .catch(() => {
        if (!current() || state.failed) return;
        state.failed = true;
        this.#publish();
      })
      .finally(() => {
        if (state.pending !== pending) return;
        delete state.pending;
        // A notice received during this read may describe data it did not include.
        if (this.#profiles.get(profileId) === state && state.stale && this.#listeners.size > 0)
          void this.load(profileId);
      });
    state.pending = pending;
    return pending;
  }
  icon(profileId: string | null, iconRef: string | null): BrowserFavicon {
    if (
      !this.#scope ||
      !profileId ||
      !iconRef ||
      !this.#profiles.get(profileId)?.value.icons.some((icon) => icon.iconRef === iconRef)
    )
      return null;
    if (this.#icons.has(iconRef)) return this.#icons.get(iconRef) ?? null;
    this.#icons.set(iconRef, undefined);
    const queued = this.#queued.get(profileId) ?? new Set<string>();
    queued.add(iconRef);
    if (!this.#queued.has(profileId)) {
      this.#queued.set(profileId, queued);
      queueMicrotask(() => {
        if (this.#queued.get(profileId) !== queued) return;
        this.#queued.delete(profileId);
        const refs = [...queued];
        for (let i = 0; i < refs.length; i += browserHistoryIconsMaxRefs)
          void this.#fetchIcons(profileId, refs.slice(i, i + browserHistoryIconsMaxRefs));
      });
    }
    return null;
  }
  async #fetchIcons(profileId: string, refs: string[]): Promise<void> {
    const generation = this.#generation;
    let icons: BrowserHistoryIcons["icons"] = [];
    try {
      ({ icons } = await this.ports.icons(profileId, refs));
    } catch {
      // Cache misses too, until a history refresh or cache eviction.
    }
    if (generation !== this.#generation) return;
    for (const ref of refs) this.#icons.set(ref, null);
    for (const { iconRef, favicon } of icons) this.#icons.set(iconRef, favicon);
    const settled = [...this.#icons].filter(([, favicon]) => favicon !== undefined);
    for (const [ref] of settled.slice(0, -iconCacheLimit)) this.#icons.delete(ref);
    this.#publish();
  }
  remove(profileId: string | null, url: string): Promise<void> {
    return this.#mutate(
      profileId,
      (value) => {
        const entries = value.entries.filter((entry) => entry.url !== url);
        const origins = new Set(entries.map((entry) => new URL(entry.url).origin));
        return { entries, icons: value.icons.filter((icon) => origins.has(icon.origin)) };
      },
      () => this.ports.remove(profileId!, url),
    );
  }
  clear(profileId: string | null): Promise<void> {
    return this.#mutate(profileId, empty, () => this.ports.clear(profileId!));
  }
  async #mutate(
    profileId: string | null,
    update: (value: BrowserHistory) => BrowserHistory,
    dispatch: () => Promise<void>,
  ): Promise<void> {
    if (!this.#scope || !profileId) return;
    const state = this.#profile(profileId);
    state.value = update(state.value);
    state.version++;
    delete state.pending;
    const mutation = Promise.resolve().then(() =>
      this.#profiles.get(profileId) === state ? dispatch() : undefined,
    );
    state.mutations.add(mutation);
    this.#publish();
    try {
      await mutation;
    } catch (error) {
      if (this.#profiles.get(profileId) !== state) return;
      state.value = empty();
      this.#publish();
      void this.load(profileId);
      throw error;
    } finally {
      state.mutations.delete(mutation);
    }
  }
  drop(profileId: string): void {
    this.#profiles.delete(profileId);
    for (const ref of this.#queued.get(profileId) ?? []) this.#icons.delete(ref);
    this.#queued.delete(profileId);
    this.#publish();
  }
  dispose(): void {
    this.setScope(null);
    this.#listeners.clear();
  }
}
