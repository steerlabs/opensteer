import type { App, AppId } from "@opensteer/core";
import type { TabsClient } from "./tabs-contract.js";

export type AppAction = "rename" | "start" | "stop" | "delete" | "open";
export interface AppsListState {
  /** Null until the first read lands. */
  readonly apps: readonly App[] | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly pending: ReadonlyMap<AppId, AppAction>;
  readonly failures: ReadonlyMap<AppId, { readonly action: AppAction; readonly message: string }>;
}
export interface AppsSource {
  readonly client: Pick<
    TabsClient,
    "listApps" | "renameApp" | "startApp" | "stopApp" | "deleteApp"
  >;
  /** HostSnapshot.appsRevision: bumped by host.apps.changed and by every reconnect. */
  readonly revision: () => number;
  readonly subscribe: (listener: () => void) => () => void;
}

const initial: AppsListState = {
  apps: null,
  loading: false,
  error: null,
  pending: new Map(),
  failures: new Map(),
};

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}

/**
 * The person's apps, read only while a page shows them. A read is applied
 * only if no newer invalidation arrived while it was in flight, so an
 * answer from before a change never overwrites the list that change rereads.
 */
export class AppsList {
  readonly #source: AppsSource;
  #state = initial;
  readonly #listeners = new Set<() => void>();
  #release: (() => void) | null = null;
  #loadedRevision: number | null = null;
  #reads = 0;

  constructor(source: AppsSource) {
    this.#source = source;
  }
  get state(): AppsListState {
    return this.#state;
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    if (!this.#release) {
      this.#release = this.#source.subscribe(() => {
        if (this.#source.revision() !== this.#loadedRevision) void this.#read();
      });
      if (this.#source.revision() !== this.#loadedRevision || this.#state.error) void this.#read();
    }
    return () => {
      this.#listeners.delete(listener);
      if (!this.#listeners.size) {
        this.#release?.();
        this.#release = null;
        // An unwatched list may go stale; the next page view rereads it.
        this.#loadedRevision = null;
      }
    };
  }
  reload(): Promise<void> {
    return this.#read();
  }
  rename(appId: AppId, name: string): Promise<boolean> {
    return this.#act(appId, "rename", async () =>
      this.#replace(await this.#source.client.renameApp(appId, name)),
    );
  }
  start(appId: AppId): Promise<boolean> {
    return this.#act(appId, "start", async () =>
      this.#replace(await this.#source.client.startApp(appId)),
    );
  }
  stop(appId: AppId): Promise<boolean> {
    return this.#act(appId, "stop", async () =>
      this.#replace(await this.#source.client.stopApp(appId)),
    );
  }
  delete(appId: AppId): Promise<boolean> {
    return this.#act(appId, "delete", async () => {
      await this.#source.client.deleteApp(appId);
      const apps = this.#state.apps?.filter((app) => app.appId !== appId) ?? null;
      this.#set({ apps });
    });
  }
  /** Runs another per-app action (opening its tab) with the same pending and failure display. */
  track(appId: AppId, action: AppAction, run: () => Promise<unknown>): Promise<boolean> {
    return this.#act(appId, action, async () => {
      await run();
    });
  }
  dismissFailure(appId: AppId): void {
    if (!this.#state.failures.has(appId)) return;
    const failures = new Map(this.#state.failures);
    failures.delete(appId);
    this.#set({ failures });
  }

  async #act(appId: AppId, action: AppAction, run: () => Promise<void>): Promise<boolean> {
    if (this.#state.pending.has(appId)) return false;
    const pending = new Map(this.#state.pending).set(appId, action);
    const failures = new Map(this.#state.failures);
    failures.delete(appId);
    this.#set({ pending, failures });
    try {
      await run();
      return true;
    } catch (error) {
      this.#set({
        failures: new Map(this.#state.failures).set(appId, { action, message: message(error) }),
      });
      return false;
    } finally {
      const after = new Map(this.#state.pending);
      after.delete(appId);
      this.#set({ pending: after });
    }
  }
  #replace(app: App): void {
    const apps = this.#state.apps?.map((held) => (held.appId === app.appId ? app : held)) ?? null;
    this.#set({ apps });
  }
  async #read(): Promise<void> {
    const revision = this.#source.revision();
    const read = ++this.#reads;
    this.#set({ loading: true });
    try {
      const apps = await this.#source.client.listApps();
      if (read !== this.#reads || revision !== this.#source.revision()) return;
      this.#loadedRevision = revision;
      this.#set({ apps, loading: false, error: null });
    } catch (error) {
      if (read !== this.#reads) return;
      this.#set({ loading: false, error: message(error) });
    }
  }
  #set(patch: Partial<AppsListState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}
