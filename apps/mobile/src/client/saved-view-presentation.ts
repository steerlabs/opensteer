import type { SavedViewCache } from "./saved-view-cache.js";
import {
  describeHostConnection,
  projectSavedHome,
  projectSavedTasks,
  savedViewScopeKey,
  sameTaskListSource,
  type HostSnapshot,
  type HostClient,
  type SavedChat,
  type SavedHostView,
  type SavedTask,
  type SavedViewScope,
} from "@opensteer/client/host";

export type SavedSurface<T> =
  | { readonly source: "pending" | "blocked" | "live" }
  | {
      readonly source: "saved";
      readonly content: T;
      readonly capturedAt: string;
      readonly label: string;
    };
export interface SavedPresentationState {
  readonly home: SavedSurface<SavedChat>;
  readonly tasks: SavedSurface<readonly SavedTask[]>;
  readonly failure: string | null;
}
const pending = { source: "pending" } as const;
const live = { source: "live" } as const;
const blocked = { source: "blocked" } as const;

/** A saved Chat whose fresh history read failed, while the connection itself is healthy. */
export const homeReadFailedLabel = "Couldn't update · Saved view";

/** Display-only owner. It never installs saved data in a Host model or initiates a Host read. */
export class SavedViewPresentation {
  readonly #cache: SavedViewCache;
  readonly #detachCache: () => void;
  readonly #now: () => Date;
  readonly #listeners = new Set<() => void>();
  #taskSource: HostSnapshot | null = null;
  #state: SavedPresentationState = { home: pending, tasks: pending, failure: null };
  #id: string | null = null;
  #scope: SavedViewScope | null = null;
  #lease: () => boolean = () => false;
  #generation = 0;
  #load: Promise<void> = Promise.resolve();
  #captureRevision = 0;
  #client: HostClient | null = null;
  #detach: (() => void) | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #fresh = { home: false, tasks: false };
  #diskAllowed = true;
  #disposed = false;
  #blocked = false;
  #refusal = 0;
  #userId: string | null = null;
  #savedUserId: string | null = null;
  #home: SavedChat | undefined;
  #tasks: SavedTask[] | undefined;
  #label = "Updating…";
  /** Home's history read failed while its saved copy shows; the live pane is not mounted. */
  #homeFailed = false;

  constructor(options: { readonly cache: SavedViewCache; readonly now?: () => Date }) {
    this.#cache = options.cache;
    this.#now = options.now ?? (() => new Date());
    this.#detachCache = this.#cache.subscribe(() => {
      if (this.#disposed) return;
      if (this.#id !== null && this.#cache.isBlocked(this.#id)) this.#diskAllowed = false;
      this.#publish({ ...this.#state, failure: this.#cache.getFailure() });
      if (!this.#invalidating()) this.#onLive();
    });
  }
  getSnapshot = (): SavedPresentationState => this.#state;
  getDeploymentId = (): string | null => this.#id;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  select(id: string | null, scope: SavedViewScope | null, isCurrent: () => boolean): void {
    if (this.#disposed) return;
    const same =
      id === this.#id &&
      (scope === null ||
        this.#scope === null ||
        savedViewScopeKey(scope) === savedViewScopeKey(this.#scope));
    this.#generation += 1;
    this.#cancelTimer();
    this.#detach?.();
    this.#detach = null;
    this.#client = null;
    this.#taskSource = null;
    this.#home = undefined;
    this.#tasks = undefined;
    this.#userId = null;
    if (!same) {
      this.#fresh = { home: false, tasks: false };
      this.#diskAllowed = true;
      this.#blocked = false;
      this.#home = undefined;
      this.#tasks = undefined;
      this.#userId = null;
      this.#savedUserId = null;
      this.#refusal = 0;
      this.#publish({ home: pending, tasks: pending, failure: null });
    }
    this.#id = id;
    this.#scope = scope;
    this.#lease = isCurrent;
    if (id !== null && this.#cache.isBlocked(id)) {
      this.#diskAllowed = false;
      this.#publish({
        home: blocked,
        tasks: blocked,
        failure: this.#cache.getFailure(),
      });
      return;
    }
    if (scope !== null) this.load(scope);
  }

  /** A late local credential read cannot restart or replace the selected live owner. */
  load(scope: SavedViewScope): void {
    if (
      this.#disposed ||
      this.#id !== scope.hostIdentity.deploymentId ||
      this.#blocked ||
      this.#invalidating() ||
      !this.#lease()
    )
      return;
    this.authorize(scope);
    if (
      this.#scope === null ||
      savedViewScopeKey(this.#scope) !== savedViewScopeKey(scope) ||
      !this.#diskAllowed ||
      this.#fresh.home ||
      this.#fresh.tasks
    )
      return;
    const generation = this.#generation;
    const current = () => this.#current(generation);
    this.#load = this.#cache
      .load(scope, current)
      .then((view) => {
        if (!view || !current() || this.#fresh.home || this.#fresh.tasks || this.#blocked) return;
        const user = this.#client?.getSnapshot().user?.id;
        if (user && user !== view.userId) {
          this.#invalidate();
          return;
        }
        this.#savedUserId = view.userId;
        this.#publish({
          home: view.home
            ? {
                source: "saved",
                content: view.home,
                capturedAt: view.capturedAt,
                label: this.#homeLabel(),
              }
            : pending,
          tasks: view.tasks
            ? {
                source: "saved",
                content: view.tasks,
                capturedAt: view.capturedAt,
                label: this.#label,
              }
            : pending,
          failure: null,
        });
      })
      .catch(() => undefined);
  }

  /** Joins the latest disk load, including its presentation fence checks. */
  joinLoad(): Promise<void> {
    return this.#load;
  }

  /** A legacy login may acquire its ID after bootstrap, without starting a disk fallback. */
  authorize(scope: SavedViewScope, isCurrent?: () => boolean): void {
    if (this.#id !== scope.hostIdentity.deploymentId || this.#disposed) return;
    if (this.#scope && savedViewScopeKey(this.#scope) !== savedViewScopeKey(scope)) return;
    if (isCurrent) this.#lease = isCurrent;
    const initializing = this.#scope === null;
    this.#scope = scope;
    this.#onLive();
    if (initializing && !this.#blocked && !this.#invalidating() && (this.#home || this.#tasks)) {
      this.#cancelTimer();
      this.#timer = setTimeout(() => {
        void this.flush();
      }, 2_000);
    }
  }
  attach(client: HostClient): void {
    if (this.#disposed) return;
    this.#detach?.();
    this.#client = client;
    this.#blocked = false;
    this.#detach = client.subscribe(() => this.#onLive());
    this.#onLive();
  }
  /** Auth-changing UI/sign-out calls this synchronously, before key deletion awaits. */
  block(): void {
    this.#generation += 1;
    this.#blocked = true;
    this.#scope = null;
    this.#diskAllowed = false;
    this.#cancelTimer();
    this.#detach?.();
    this.#detach = null;
    this.#client = null;
    this.#home = undefined;
    this.#tasks = undefined;
    this.#savedUserId = null;
    this.#userId = null;
    this.#publish({ home: blocked, tasks: blocked, failure: this.#state.failure });
  }
  connection(network: string, unavailable: boolean): void {
    const label =
      network === "offline"
        ? "Offline · Saved view"
        : unavailable
          ? "Unavailable · Saved view"
          : "Updating…";
    if (label === this.#label) return;
    this.#label = label;
    this.#relabel();
  }
  #homeLabel(): string {
    return this.#homeFailed && this.#label === "Updating…" ? homeReadFailedLabel : this.#label;
  }
  #relabel(): void {
    const home = this.#state.home,
      tasks = this.#state.tasks;
    this.#publish({
      ...this.#state,
      home: home.source === "saved" ? { ...home, label: this.#homeLabel() } : home,
      tasks: tasks.source === "saved" ? { ...tasks, label: this.#label } : tasks,
    });
  }
  retryInvalidation(): Promise<void> {
    return this.#cache.retryInvalidation();
  }

  detach(): void {
    this.#generation += 1;
    this.#cancelTimer();
    this.#detach?.();
    this.#detach = null;
    this.#client = null;
    this.#home = undefined;
    this.#tasks = undefined;
    this.#userId = null;
    this.#taskSource = null;
  }
  flush = async (): Promise<void> => {
    this.#cancelTimer();
    const scope = this.#scope,
      client = this.#client,
      generation = this.#generation,
      revision = this.#captureRevision;
    if (
      !scope ||
      !client ||
      !this.#userId ||
      this.#blocked ||
      this.#invalidating() ||
      // A write replaces the whole saved view, which may hold a surface this
      // session never loaded, so it waits until this attachment has captured
      // both surfaces from fresh answers. An empty or absent answer counts.
      this.#home === undefined ||
      this.#tasks === undefined
    )
      return;
    const snapshot = client.getSnapshot();
    if (snapshot.user?.id !== this.#userId || snapshot.session !== "authenticated") return;
    const view: SavedHostView = {
      ...scope,
      userId: snapshot.user.id,
      capturedAt: this.#now().toISOString(),
      ...(this.#home ? { home: this.#home } : {}),
      ...(this.#tasks ? { tasks: this.#tasks } : {}),
    };
    const current = () =>
      this.#current(generation) &&
      revision === this.#captureRevision &&
      !this.#blocked &&
      !this.#invalidating() &&
      this.#client === client &&
      client.getSnapshot().user?.id === view.userId &&
      client.getSnapshot().session === "authenticated";
    await this.#cache.write(view, current).catch(() => undefined);
  };
  dispose(): void {
    if (this.#disposed) return;
    this.block();
    this.#disposed = true;
    this.#detachCache();
    this.#listeners.clear();
  }

  #invalidating(): boolean {
    return this.#id !== null && this.#cache.isPending(this.#id);
  }
  #current(generation: number): boolean {
    return !this.#disposed && generation === this.#generation && this.#lease();
  }
  #onLive(): void {
    const client = this.#client;
    if (!client || this.#blocked || this.#disposed || !this.#lease()) return;
    const snapshot = client.getSnapshot();
    const connection = describeHostConnection(snapshot);
    this.connection(snapshot.network, connection.label === "Unavailable");
    const homeFailed =
      snapshot.homeThreadId !== null && snapshot.threadLookups[snapshot.homeThreadId] === "failed";
    if (homeFailed !== this.#homeFailed) {
      this.#homeFailed = homeFailed;
      this.#relabel();
    }
    if (snapshot.session === "authentication-required") {
      this.#invalidate();
      this.#detach?.();
      this.#detach = null;
      this.#client = null;
      return;
    }
    const ready = snapshot.savedViewReadiness;
    if (!ready || snapshot.session !== "authenticated" || !snapshot.user) return;
    if (this.#id !== null && !this.#invalidating()) this.#cache.confirm(this.#id);
    if (ready.workspaceRefusal !== this.#refusal) {
      this.#refusal = ready.workspaceRefusal;
      this.#invalidate();
    }
    if (
      (this.#savedUserId && this.#savedUserId !== snapshot.user.id) ||
      (this.#userId && this.#userId !== snapshot.user.id)
    )
      this.#invalidate();
    this.#userId = snapshot.user.id;
    let home = this.#state.home,
      tasks = this.#state.tasks,
      dirty = false;
    if (ready.tasksReady) {
      this.#fresh.tasks = true;
      this.#diskAllowed = false;
      tasks = live;
      if (this.#taskSource === null || !sameTaskListSource(this.#taskSource, snapshot)) {
        this.#taskSource = snapshot;
        try {
          const next = projectSavedTasks(snapshot);
          if (JSON.stringify(next) !== JSON.stringify(this.#tasks)) {
            this.#tasks = next;
            dirty = true;
          }
        } catch {
          this.#tasks = undefined;
        }
      }
    }
    if (ready.home.status !== "unknown") {
      this.#fresh.home = true;
      this.#diskAllowed = false;
      home = live;
      try {
        const next = projectSavedHome(snapshot);
        if (next && JSON.stringify(next) !== JSON.stringify(this.#home)) {
          this.#home = next;
          dirty = true;
        }
      } catch {
        this.#home = undefined;
      }
    }
    if (home !== this.#state.home || tasks !== this.#state.tasks)
      this.#publish({ ...this.#state, home, tasks });
    if (dirty) this.#captureRevision += 1;
    if (dirty && !this.#invalidating()) {
      this.#cancelTimer();
      this.#timer = setTimeout(() => {
        void this.flush();
      }, 2_000);
    }
  }
  #invalidate(): void {
    const id = this.#id;
    if (id === null) return;
    this.#generation += 1;
    this.#diskAllowed = false;
    this.#taskSource = null;
    this.#cancelTimer();
    this.#home = undefined;
    this.#tasks = undefined;
    this.#savedUserId = null;
    this.#userId = null;
    this.#publish({ home: blocked, tasks: blocked, failure: null });
    void this.#cache.invalidate(id);
  }

  #cancelTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
  #publish(state: SavedPresentationState): void {
    this.#state = state;
    for (const listener of this.#listeners) {
      // Optional presentation must never fail an authoritative Host installation.
      try {
        listener();
      } catch {
        /* The next snapshot can notify this observer again. */
      }
    }
  }
}
