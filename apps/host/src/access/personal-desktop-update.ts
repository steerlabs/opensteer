import { randomUUID } from "node:crypto";
import { OpensteerError, type AuthenticatedSession } from "@opensteer/core";
import { PersonalDesktopUpdateStore } from "@opensteer/database";
import {
  desktopUpdateLongPollMs,
  type DesktopUpdateState,
  type DesktopUpdateStatus,
  type DesktopUpdateRequest,
} from "@opensteer/protocol/maintenance";
import type { DesktopUpdateProgress } from "@opensteer/protocol/desktop-supervisor";

export class PersonalDesktopUpdate {
  readonly #store: PersonalDesktopUpdateStore;
  readonly #incarnation = randomUUID();
  readonly #listeners = new Set<() => void>();
  #revision = 0;
  #executor: { identity: object; incarnationId: string; currentVersion: string } | null = null;
  #state: DesktopUpdateState | null = null;
  #closed = false;
  constructor(store: PersonalDesktopUpdateStore) {
    this.#store = store;
  }
  get revision(): string {
    return `${this.#incarnation}:${this.#revision}`;
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  changed(): void {
    this.#revision++;
    for (const listener of this.#listeners) listener();
  }
  close(): void {
    this.#closed = true;
    this.#executor = null;
    this.#state = null;
    this.changed();
    this.#listeners.clear();
  }
  async authorize(session: AuthenticatedSession): Promise<void> {
    await this.#store.authorize(session.user.id);
  }
  async status(session: AuthenticatedSession): Promise<DesktopUpdateStatus> {
    await this.authorize(session);
    const revision = this.revision;
    return { supported: true, revision, state: this.#state, operation: await this.#store.latest() };
  }
  async request(session: AuthenticatedSession, request: DesktopUpdateRequest) {
    await this.authorize(session);
    const operation = await this.#store.request(session, request);
    this.changed();
    return operation;
  }
  async attachExecutor(
    identity: object,
    incarnationId: string,
    state: DesktopUpdateState,
  ): Promise<() => void> {
    if (this.#executor)
      throw new OpensteerError({
        code: "conflict",
        message: "A desktop supervisor is already connected",
      });
    this.#executor = { identity, incarnationId, currentVersion: state.currentVersion };
    this.#state = state;
    this.changed();
    return () => {
      if (this.#executor?.identity !== identity) return;
      this.#executor = null;
      this.#state = null;
      this.changed();
    };
  }
  state(identity: object, state: DesktopUpdateState): void {
    this.#require(identity);
    this.#state = state;
    this.changed();
  }
  async next(identity: object) {
    if (this.#closed || this.#executor?.identity !== identity) return null;
    const operation = await this.#store.latest();
    return operation && !["succeeded", "failed"].includes(operation.state) ? operation : null;
  }
  async progress(identity: object, progress: DesktopUpdateProgress): Promise<void> {
    const executor = this.#require(identity);
    await this.#store.progress(executor.incarnationId, progress, executor.currentVersion);
    this.changed();
  }
  wait(after: string | undefined, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!after || after !== this.revision || this.#closed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        cleanup();
        resolve();
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const unsubscribe = this.subscribe(finish);
      const timer = setTimeout(finish, desktopUpdateLongPollMs);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        unsubscribe();
        signal.removeEventListener("abort", abort);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (after !== this.revision || this.#closed) finish();
      else if (signal.aborted) abort();
    });
  }
  #require(identity: object) {
    if (this.#executor?.identity !== identity)
      throw new OpensteerError({
        code: "forbidden",
        message: "The desktop supervisor disconnected",
      });
    return this.#executor;
  }
}
