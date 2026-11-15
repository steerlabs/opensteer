import type { App, AppId } from "@opensteer/core";
import type { TabsClient } from "./tabs-contract.js";

export type AppAction = "rename" | "start" | "stop" | "delete" | "open";
/**
 * An action on an app the list no longer shows, such as a Delete the Host
 * withdrew from the list before it could say how it ended. `message` is null
 * while it is still pending.
 */
export interface AppActionNotice {
  readonly appId: AppId;
  /** The app's name when the action began. */
  readonly name: string;
  readonly action: AppAction;
  readonly message: string | null;
}
export interface AppsListState {
  /** Null until the first read lands. */
  readonly apps: readonly App[] | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly pending: ReadonlyMap<AppId, AppAction>;
  readonly failures: ReadonlyMap<AppId, { readonly action: AppAction; readonly message: string }>;
  /** Pending and failed actions whose app is not in `apps`, shown apart from any row. */
  readonly notices: readonly AppActionNotice[];
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
  notices: [],
};

const pendingWords: Record<AppAction, string> = {
  rename: "Renaming",
  start: "Starting",
  stop: "Stopping",
  delete: "Deleting",
  open: "Opening",
};
const failedWords: Record<AppAction, string> = {
  rename: "renamed",
  start: "started",
  stop: "stopped",
  delete: "deleted",
  open: "opened",
};
/** One line naming a notice's app and action, the same on every surface. */
export function appNoticeTitle(notice: AppActionNotice): string {
  return notice.message === null
    ? `${pendingWords[notice.action]} “${notice.name}”…`
    : `“${notice.name}” could not be ${failedWords[notice.action]}`;
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}

/**
 * The person's apps, read only while a page shows them. One read is in flight
 * at a time: a change while it is out queues at most one more, and an answer
 * read before a change is never applied. An action's answer is applied only
 * if no change or read has landed since it began, so a late answer never
 * overwrites a newer list.
 */
export class AppsList {
  readonly #source: AppsSource;
  #state = initial;
  readonly #listeners = new Set<() => void>();
  #release: (() => void) | null = null;
  #loadedRevision: number | null = null;
  /** The revision the newest read asked for, so a notification without a change asks nothing. */
  #askedRevision: number | null = null;
  #inFlight: { readonly revision: number; readonly done: Promise<void> } | null = null;
  #successor: Promise<void> | null = null;
  /** Counts accepted reads, fencing action answers that began before one. */
  #accepted = 0;
  /** Each pending or failed action's app name, as it was when the action began. */
  readonly #names = new Map<AppId, string>();

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
        if (this.#source.revision() !== this.#askedRevision) void this.#read();
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
        this.#askedRevision = null;
      }
    };
  }
  reload(): Promise<void> {
    return this.#read();
  }
  rename(appId: AppId, name: string): Promise<boolean> {
    return this.#act(appId, "rename", async (fence) =>
      this.#replace(await this.#source.client.renameApp(appId, name), fence),
    );
  }
  start(appId: AppId): Promise<boolean> {
    return this.#act(appId, "start", async (fence) =>
      this.#replace(await this.#source.client.startApp(appId), fence),
    );
  }
  stop(appId: AppId): Promise<boolean> {
    return this.#act(appId, "stop", async (fence) =>
      this.#replace(await this.#source.client.stopApp(appId), fence),
    );
  }
  delete(appId: AppId): Promise<boolean> {
    return this.#act(appId, "delete", async () => {
      await this.#source.client.deleteApp(appId);
      // A deleted app never comes back, so removing it cannot undo a newer read.
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

  async #act(
    appId: AppId,
    action: AppAction,
    run: (fence: Fence) => Promise<void>,
  ): Promise<boolean> {
    if (this.#state.pending.has(appId)) return false;
    this.#names.set(
      appId,
      this.#state.apps?.find((app) => app.appId === appId)?.name ??
        this.#names.get(appId) ??
        "This app",
    );
    const fence = { accepted: this.#accepted, revision: this.#source.revision() };
    const pending = new Map(this.#state.pending).set(appId, action);
    const failures = new Map(this.#state.failures);
    failures.delete(appId);
    this.#set({ pending, failures });
    try {
      await run(fence);
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
  #replace(app: App, fence: Fence): void {
    if (fence.accepted !== this.#accepted || fence.revision !== this.#source.revision()) {
      // A newer change or read landed meanwhile: it, not this answer, is current.
      if (this.#release && this.#source.revision() !== this.#loadedRevision) void this.#read();
      return;
    }
    const apps = this.#state.apps?.map((held) => (held.appId === app.appId ? app : held)) ?? null;
    this.#set({ apps });
  }
  #read(): Promise<void> {
    const revision = this.#source.revision();
    this.#askedRevision = revision;
    const current = this.#inFlight;
    if (current) {
      if (current.revision === revision) return current.done;
      // At most one read waits behind the one out; it asks for whatever is newest then.
      return (this.#successor ??= current.done.then(() => {
        this.#successor = null;
        return this.#read();
      }));
    }
    const done = this.#fetch(revision).finally(() => {
      this.#inFlight = null;
    });
    this.#inFlight = { revision, done };
    return done;
  }
  async #fetch(revision: number): Promise<void> {
    this.#set({ loading: true });
    try {
      const apps = await this.#source.client.listApps();
      if (revision !== this.#source.revision()) return;
      this.#loadedRevision = revision;
      this.#accepted++;
      this.#set({ apps, loading: false, error: null });
    } catch (error) {
      if (revision !== this.#source.revision()) return;
      this.#set({ loading: false, error: message(error) });
    }
  }
  #set(patch: Partial<AppsListState>): void {
    let next: AppsListState = { ...this.#state, ...patch };
    if (patch.apps !== undefined || patch.pending || patch.failures) {
      for (const appId of this.#names.keys())
        if (!next.pending.has(appId) && !next.failures.has(appId)) this.#names.delete(appId);
      const notices = this.#notices(next);
      if (notices.length || next.notices.length) next = { ...next, notices };
    }
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }
  #notices(state: AppsListState): AppActionNotice[] {
    if (state.apps === null) return [];
    const listed = new Set(state.apps.map((app) => app.appId));
    const notices: AppActionNotice[] = [];
    for (const [appId, name] of this.#names) {
      if (listed.has(appId)) continue;
      const failure = state.failures.get(appId);
      const action = failure?.action ?? state.pending.get(appId);
      if (action) notices.push({ appId, name, action, message: failure?.message ?? null });
    }
    return notices;
  }
}

interface Fence {
  readonly accepted: number;
  readonly revision: number;
}
