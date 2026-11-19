import { utf8ByteLength } from "@opensteer/core";
import {
  pluginChangeResources,
  type PersonalResourceKind,
  type PersonalResourceRevisions,
  type PersonalResourceDetailSchema,
} from "@opensteer/protocol/resources";
import type { z } from "zod";
import type { PersonalResourcePort } from "./scoped-personal-stream.js";

type Detail = z.infer<typeof PersonalResourceDetailSchema>;
type Page = { readonly ok: true; readonly data: Detail } | { readonly ok: false };

/** Kinds whose revision is the whole news: a consumer rereads its own view when it moves. */
const signalKinds: ReadonlySet<PersonalResourceKind> = new Set([
  ...pluginChangeResources,
  "team-replies",
]);
/** Bounds what one kind's pages may hold before the read gives up. */
const inventoryBytes = 1024 * 1024;

export interface PersonalResourceReadOptions {
  read(kind: PersonalResourceKind, cursor: string | undefined, signal: AbortSignal): Promise<Page>;
  /** Install one page; a later page of the same read appends. */
  apply(data: Detail["data"], append: boolean, hasMore: boolean): void;
  /** The app is in front; a background app reads nothing. */
  canRead(): boolean;
  /** The watched kinds changed. */
  watchChanged(): void;
  /** The Host moved past what this client installed; its next read is coming. */
  behind?(kind: PersonalResourceKind): void;
}

/**
 * The Host pushes only `{kind: revision}`; this reads a kind's detail when a
 * surface watches it and the pushed revision differs from the one installed.
 * Revisions compare only for equality. One read per kind runs at a time, so an
 * older answer can never land after a newer one.
 */
export class PersonalResourceReads implements PersonalResourcePort {
  readonly #options: PersonalResourceReadOptions;
  readonly #listeners = new Map<PersonalResourceKind, Set<() => void>>();
  readonly #known = new Map<PersonalResourceKind, string>();
  readonly #installed = new Map<PersonalResourceKind, string>();
  readonly #reads = new Map<
    PersonalResourceKind,
    { controller: AbortController; stale: boolean }
  >();

  constructor(options: PersonalResourceReadOptions) {
    this.#options = options;
  }

  watch(kind: PersonalResourceKind, listener: () => void) {
    const listeners = this.#listeners.get(kind) ?? new Set<() => void>();
    const added = listeners.size === 0;
    listeners.add(listener);
    this.#listeners.set(kind, listeners);
    if (added) this.#options.watchChanged();
    this.#read(kind);
    return () => {
      if (!listeners.delete(listener) || listeners.size) return;
      this.#listeners.delete(kind);
      this.#reads.get(kind)?.controller.abort();
      this.#reads.delete(kind);
      this.#options.watchChanged();
    };
  }

  /** The Host's latest revision of a kind this client watches. */
  revision(kind: PersonalResourceKind) {
    return this.#known.get(kind);
  }

  interests() {
    const interests = [...this.#listeners.keys()];
    const installed: PersonalResourceRevisions = {};
    for (const kind of interests) {
      const revision = this.#installed.get(kind);
      if (revision !== undefined) installed[kind] = revision;
    }
    return { interests, installed };
  }

  changed(revisions: PersonalResourceRevisions) {
    for (const [kind, revision] of Object.entries(revisions) as [PersonalResourceKind, string][]) {
      this.#known.set(kind, revision);
      if (signalKinds.has(kind)) this.#installed.set(kind, revision);
      else if (this.#installed.has(kind) && this.#installed.get(kind) !== revision)
        this.#options.behind?.(kind);
      const read = this.#reads.get(kind);
      if (read) read.stale = true;
      else this.#read(kind);
      for (const listener of this.#listeners.get(kind) ?? []) listener();
    }
  }

  /** Read every watched kind that is behind, as after attaching or returning to the front. */
  resume() {
    for (const kind of this.#listeners.keys()) this.#read(kind);
  }

  abort() {
    for (const { controller } of this.#reads.values()) controller.abort();
    this.#reads.clear();
  }

  /** A kind whose data lives only with its listeners is read again by the next one. */
  forget(kind: PersonalResourceKind) {
    this.#installed.delete(kind);
  }

  /** Another viewer: nothing held belongs to them. */
  reset() {
    this.abort();
    this.#known.clear();
    this.#installed.clear();
  }

  #read(kind: PersonalResourceKind) {
    const known = this.#known.get(kind);
    const installed = this.#installed.get(kind);
    // A kind not read yet is read at once, beside the socket's attach, so a cold start paints it
    // with the shell; the Host's revision push then matches and reads nothing more.
    if (
      signalKinds.has(kind) ||
      (installed !== undefined && installed === known) ||
      !this.#listeners.has(kind) ||
      this.#reads.has(kind) ||
      !this.#options.canRead()
    )
      return;
    const controller = new AbortController();
    const request = { controller, stale: false };
    this.#reads.set(kind, request);
    const current = () => !controller.signal.aborted && this.#reads.get(kind) === request;
    const pages = async (): Promise<string | undefined> => {
      let cursor: string | undefined;
      let bytes = 0;
      const cursors = new Set<string>();
      do {
        const page = await this.#options.read(kind, cursor, controller.signal);
        if (!page.ok || !current() || page.data.data.kind !== kind) return;
        const { next, revision } = page.data;
        bytes += utf8ByteLength(JSON.stringify(page.data));
        if (bytes > inventoryBytes || (next && cursors.has(next))) return;
        this.#options.apply(page.data.data, cursor !== undefined, next !== null);
        if (next === null) return revision;
        cursors.add(next);
        cursor = next;
      } while (cursor);
      return undefined;
    };
    void pages()
      .catch(() => undefined)
      .then((revision) => {
        if (!current()) return;
        this.#reads.delete(kind);
        if (revision !== undefined) {
          this.#installed.set(kind, revision);
          // Read after the push it answers, so it is at least as new as anything pushed before.
          if (!request.stale) this.#known.set(kind, revision);
        }
        if (revision !== undefined || request.stale) this.#read(kind);
      });
  }
}
