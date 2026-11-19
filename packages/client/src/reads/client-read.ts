import {
  clientScopeKey,
  type ClientConnection,
  type ClientSession,
} from "../connections/connection-controller.js";
import { classifyClientFailure, unrefTimer } from "../connections/operation-error.js";
import { clientIssueFromFailure, type ClientIssue } from "../feedback/client-issue.js";

export type ClientReadState<T> =
  | { readonly status: "waiting" | "loading"; readonly data: null; readonly issue: null }
  | {
      readonly status: "ready";
      readonly data: T;
      readonly refreshing: boolean;
      readonly stale: boolean;
      readonly issue: ClientIssue | null;
    }
  | { readonly status: "failed"; readonly data: null; readonly issue: ClientIssue };
export interface ClientRead<T> {
  getSnapshot(): ClientReadState<T>;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  invalidate(): void;
  evict(): void;
  dispose(): void;
}
export interface ClientReadSpec<T> {
  readonly key: string;
  readonly label: string;
  readonly remember?: boolean | "across-mounts";
  readonly scopeKey?: string | null;
  readonly read: (signal: AbortSignal) => Promise<T>;
  readonly subscribeInvalidation?: (invalidate: () => void) => () => void;
}

class ReadScheduler {
  #active = 0;
  readonly #queue: (() => void)[] = [];
  run<T>(signal: AbortSignal, read: () => Promise<T>): Promise<T> {
    const start = () => {
      this.#active++;
      try {
        signal.throwIfAborted();
        return read().finally(() => {
          this.#active--;
          this.#drain();
        });
      } catch (error) {
        this.#active--;
        this.#drain();
        return Promise.reject<T>(error);
      }
    };
    if (this.#active < 4) return start();
    return new Promise<T>((resolve, reject) =>
      this.#queue.push(() => {
        void start().then(resolve, reject);
      }),
    );
  }
  #drain(): void {
    while (this.#active < 4 && this.#queue.length) {
      this.#queue.shift()!();
    }
  }
}
const schedulers = new WeakMap<ClientConnection, ReadScheduler>();
interface RememberedRead {
  readonly scope: string;
  readonly value: unknown;
  forget(): void;
}
type RetentionKey = string | (() => void);
const remembered = new WeakMap<ClientConnection, Map<RetentionKey, RememberedRead>>();
export function createClientRead<T>(
  session: ClientSession,
  spec: ClientReadSpec<T>,
): ClientRead<T> {
  let scheduler = schedulers.get(session.connection);
  if (!scheduler) {
    scheduler = new ReadScheduler();
    schedulers.set(session.connection, scheduler);
  }
  return new RetainedClientRead(session, spec, scheduler);
}

class RetainedClientRead<T> implements ClientRead<T> {
  readonly #session: ClientSession;
  readonly #spec: ClientReadSpec<T>;
  readonly #scheduler: ReadScheduler;
  readonly #listeners = new Set<() => void>();
  #state: ClientReadState<T> = { status: "waiting", data: null, issue: null };
  #scope: string | null;
  #epoch: number;
  #revision: number;
  #accepted = false;
  #value: T | undefined;
  #controller: AbortController | null = null;
  #dirty = false;
  #explicit = false;
  #attempt = 0;
  #disposed = false;
  #work: Promise<void> = Promise.resolve();
  #retry: ReturnType<typeof setTimeout> | null = null;
  #retention: ReturnType<typeof setTimeout> | null = null;
  #unsubscribe: (() => void) | null = null;
  #invalidation: (() => void) | null = null;

  constructor(session: ClientSession, spec: ClientReadSpec<T>, scheduler: ReadScheduler) {
    this.#session = session;
    this.#spec = spec;
    this.#scheduler = scheduler;
    const connection = session.connection.getSnapshot();
    this.#scope = clientScopeKey(connection.scope);
    this.#epoch = connection.epoch;
    this.#revision = connection.readyRevision;
    const held =
      spec.remember === "across-mounts"
        ? remembered.get(session.connection)?.get(spec.key)
        : undefined;
    if (held && held.scope === this.#scope) {
      this.#accepted = true;
      this.#value = held.value as T;
      this.#state = {
        status: "ready",
        data: this.#value,
        refreshing: false,
        stale: true,
        issue: null,
      };
    }
  }
  getSnapshot = (): ClientReadState<T> => {
    if (clientScopeKey(this.#session.connection.getSnapshot().scope) !== this.#scope)
      return waiting;
    return this.#state;
  };
  subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) return () => {};
    this.#listeners.add(listener);
    if (this.#listeners.size === 1) {
      if (this.#retention) clearTimeout(this.#retention);
      this.#retention = null;
      this.#releaseRemembered();
      this.#unsubscribe ??= this.#session.connection.subscribe(() => this.#connectionChanged());
      this.#invalidation = this.#spec.subscribeInvalidation?.(this.invalidate) ?? null;
      this.#dirty = true;
      this.#connectionChanged();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size !== 0) return;
      this.#cancel();
      this.#invalidation?.();
      this.#invalidation = null;
      if (this.#spec.remember && this.#accepted && this.#scope !== null) {
        let cache = remembered.get(this.#session.connection);
        if (!cache) {
          cache = new Map();
          remembered.set(this.#session.connection, cache);
        }
        const key = this.#retentionKey();
        cache.get(key)?.forget();
        cache.set(key, { scope: this.#scope, value: this.#value, forget: this.#forget });
        if (cache.size > 32) cache.values().next().value?.forget();
        this.#retention = setTimeout(this.#forget, 300_000);
        unrefTimer(this.#retention);
      } else this.#forget();
    };
  };
  refresh = (): Promise<void> => {
    this.#explicit = true;
    this.#attempt = 2;
    const connection = this.#session.connection.getSnapshot();
    if (
      connection.phase !== "ready" ||
      connection.network === "offline" ||
      connection.visibility !== "foreground" ||
      !connection.scope
    ) {
      this.#dirty = true;
      const issue: ClientIssue =
        connection.phase === "blocked" && connection.issue
          ? connection.issue
          : { code: this.#accepted ? "refresh-failed" : "read-failed", resource: this.#spec.label };
      this.#publish(
        this.#accepted
          ? { status: "ready", data: this.#value!, refreshing: false, stale: true, issue }
          : { status: "failed", data: null, issue },
      );
      return Promise.resolve();
    }
    if (this.#listeners.size === 0) {
      const release = this.subscribe(() => {});
      return this.#settled().finally(release);
    }
    this.invalidate();
    return this.#settled();
  };
  async #settled(): Promise<void> {
    const work = this.#work;
    await work;
    if (work !== this.#work) await this.#settled();
  }
  invalidate = (): void => {
    if (this.#disposed) return;
    this.#dirty = true;
    if (!this.#controller && !this.#retry) this.#read();
  };
  evict = (): void => {
    this.#cancel();
    const held = remembered.get(this.#session.connection)?.get(this.#retentionKey());
    if (held?.scope === this.#scope) held.forget();
    this.#accepted = false;
    this.#value = undefined;
    this.#publish({ status: "failed", data: null, issue: { code: "access-lost" } });
  };
  dispose = (): void => {
    this.#forget();
    this.#disposed = true;
    this.#listeners.clear();
  };
  #forget = (): void => {
    this.#cancel();
    this.#accepted = false;
    this.#value = undefined;
    this.#state = waiting;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#invalidation?.();
    this.#invalidation = null;
    if (this.#retention) clearTimeout(this.#retention);
    this.#retention = null;
    this.#releaseRemembered();
  };
  #releaseRemembered(): void {
    const cache = remembered.get(this.#session.connection);
    const key = this.#retentionKey();
    if (cache?.get(key)?.forget === this.#forget) cache.delete(key);
  }
  #retentionKey(): RetentionKey {
    return this.#spec.remember === "across-mounts" ? this.#spec.key : this.#forget;
  }
  #publish(state: ClientReadState<T>): void {
    this.#state = state;
    this.#listeners.forEach((listener) => listener());
  }
  #cancel(): void {
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    const controller = this.#controller;
    this.#controller = null;
    controller?.abort();
  }
  #usable(): boolean {
    const state = this.#session.connection.getSnapshot();
    return (
      this.#listeners.size > 0 &&
      state.phase === "ready" &&
      state.visibility === "foreground" &&
      state.network !== "offline" &&
      state.scope !== null &&
      (this.#spec.scopeKey === undefined || this.#spec.scopeKey === clientScopeKey(state.scope))
    );
  }
  #connectionChanged(): void {
    const connection = this.#session.connection.getSnapshot();
    const scope = clientScopeKey(connection.scope);
    const newScope = scope !== this.#scope;
    const newEpoch = connection.epoch !== this.#epoch;
    const newReady = connection.readyRevision !== this.#revision;
    this.#scope = scope;
    this.#epoch = connection.epoch;
    this.#revision = connection.readyRevision;
    if (newScope) {
      if (this.#listeners.size === 0) {
        this.#forget();
        return;
      }
      this.#cancel();
      this.#accepted = false;
      this.#value = undefined;
      this.#attempt = 0;
      this.#publish(waiting);
    } else if (newEpoch || !this.#usable()) {
      this.#dirty ||= this.#accepted || this.#controller !== null || this.#retry !== null;
      this.#cancel();
      this.#publish(
        this.#accepted
          ? {
              status: "ready",
              data: this.#value!,
              refreshing: false,
              stale: true,
              issue: this.#state.status === "ready" ? this.#state.issue : null,
            }
          : waiting,
      );
    }
    if (newScope || newEpoch || newReady) {
      this.#dirty = true;
      this.#attempt = 0;
    }
    if (this.#usable() && this.#dirty && !this.#controller) this.#read();
  }
  #read(): void {
    if (!this.#usable() || this.#disposed) return;
    const scope = this.#scope,
      epoch = this.#epoch;
    const controller = new AbortController();
    this.#controller = controller;
    this.#dirty = false;
    const current = () =>
      this.#controller === controller &&
      !controller.signal.aborted &&
      this.#scope === scope &&
      this.#epoch === epoch;
    this.#publish(
      this.#accepted
        ? { status: "ready", data: this.#value!, refreshing: true, stale: true, issue: null }
        : { status: "loading", data: null, issue: null },
    );
    this.#work = this.#scheduler
      .run(controller.signal, () => this.#spec.read(controller.signal))
      .then(
        (value) => {
          if (!current()) return;
          this.#accepted = true;
          this.#value = value;
          this.#attempt = 0;
          this.#explicit = false;
          this.#publish({
            status: "ready",
            data: value,
            refreshing: false,
            stale: false,
            issue: null,
          });
        },
        (error) => {
          if (!current()) return;
          const failure = classifyClientFailure(error);
          const denied =
            failure.provenance === "host" &&
            ["forbidden", "not_found", "unauthorized"].includes(failure.code);
          if (denied) {
            const held = remembered.get(this.#session.connection)?.get(this.#retentionKey());
            if (held?.scope === scope) held.forget();
            this.#accepted = false;
            this.#value = undefined;
          }
          if (
            !denied &&
            failure.retryable &&
            ["transport", "service"].includes(failure.kind) &&
            this.#attempt < 2 &&
            this.#usable() &&
            !this.#dirty
          ) {
            const delay = [500, 1500][this.#attempt++]!;
            this.#retry = setTimeout(() => {
              this.#retry = null;
              this.#read();
            }, delay);
            unrefTimer(this.#retry);
          }
          const issue = clientIssueFromFailure(failure, {
            operation: this.#accepted ? "refresh" : "read",
            label: this.#spec.label,
          });
          // An automatic refresh that fails keeps the data quietly while the
          // failure is the link's (retried, and shown by the connection). A
          // final answer from the Host is neither, so it is shown.
          const final =
            failure.provenance === "host" &&
            !failure.retryable &&
            ["service", "rejection"].includes(failure.kind);
          this.#publish(
            this.#accepted
              ? {
                  status: "ready",
                  data: this.#value!,
                  refreshing: false,
                  stale: true,
                  issue: (this.#explicit || final) && !this.#retry ? issue : null,
                }
              : this.#retry || !issue
                ? waiting
                : { status: "failed", data: null, issue },
          );
        },
      )
      .finally(() => {
        if (!current()) return;
        this.#controller = null;
        if (this.#dirty && !this.#retry) this.#read();
      });
  }
}
const waiting: ClientReadState<never> = { status: "waiting", data: null, issue: null };
