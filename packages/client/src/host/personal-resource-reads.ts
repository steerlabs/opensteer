import { utf8ByteLength } from "@opensteer/core";
import {
  personalResourceKinds,
  pluginChangeResources,
  type PersonalResourceKind,
  type PersonalResourceRevisions,
  type PersonalResourceDetailSchema,
} from "@opensteer/protocol/resources";
import type { z } from "zod";
import type { PersonalResourcePort } from "./scoped-personal-stream.js";
import { FencedReads, type FencedRead } from "./fenced-reads.js";

type Detail = z.infer<typeof PersonalResourceDetailSchema>;
type Page =
  | { readonly ok: true; readonly data: Detail }
  | { readonly ok: false; readonly error: { readonly message: string } };

/** Kinds whose revision is the whole news: a consumer rereads its own view when it moves. */
const signalKinds: ReadonlySet<PersonalResourceKind> = new Set([
  ...pluginChangeResources,
  "team-replies",
]);
const noop = () => undefined;
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
  /** A kind's first complete read for this viewer landed. */
  loaded?(kind: PersonalResourceKind): void;
  /** The Host moved past what this client installed; its next read is coming. */
  behind?(kind: PersonalResourceKind): void;
}

/**
 * The Host pushes only `{kind: revision}`; this reads a kind's detail when a
 * surface watches it and the pushed revision differs from the one installed.
 * Revisions compare only for equality. Reads are fenced (`FencedReads`): one per
 * kind, a push while one flies supersedes it, all of a kind's pages install
 * together and only while nothing newer arrived, and a failure retries with
 * backoff while the kind is watched.
 */
export class PersonalResourceReads implements PersonalResourcePort {
  readonly #options: PersonalResourceReadOptions;
  readonly #listeners = new Map<PersonalResourceKind, Set<() => void>>();
  readonly #known = new Map<PersonalResourceKind, string>();
  readonly #installed = new Map<PersonalResourceKind, string>();
  readonly #retained = new Map<PersonalResourceKind, () => void>();
  /** The older revision a read last answered after a newer push, so it is not reread forever. */
  readonly #behind = new Map<PersonalResourceKind, string>();
  #viewer = 0;
  readonly #reads = new FencedReads({ epoch: () => String(this.#viewer) });

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
      this.#reads.stop(kind);
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
      // What flies is judged when it lands: older than this push, it installs nothing.
      this.#read(kind);
      for (const listener of this.#listeners.get(kind) ?? []) listener();
    }
  }

  /** Read every watched kind that is behind, as after attaching or returning to the front. */
  resume() {
    for (const kind of this.#listeners.keys()) this.#read(kind);
  }

  abort() {
    for (const kind of personalResourceKinds) this.#reads.stop(kind);
  }

  /** A kind whose data lives only with its listeners is read again by the next one. */
  forget(kind: PersonalResourceKind) {
    this.#installed.delete(kind);
  }

  /** Watches a kind for as long as this viewer lasts: something read the value it fills. */
  retain(kind: PersonalResourceKind) {
    if (this.#retained.has(kind)) return;
    this.#retained.set(kind, this.watch(kind, noop));
  }

  /** Another viewer: nothing held or retained belongs to them. */
  reset() {
    const retained = [...this.#retained.values()];
    this.#retained.clear();
    for (const release of retained) release();
    this.#viewer++;
    this.abort();
    this.#known.clear();
    this.#installed.clear();
    this.#behind.clear();
  }

  #read(kind: PersonalResourceKind) {
    const known = this.#known.get(kind);
    const installed = this.#installed.get(kind);
    // A kind not read yet is read at once, beside the socket's attach, so a cold start paints it
    // with the shell; the Host's revision push then matches and reads nothing more.
    if (
      signalKinds.has(kind) ||
      (installed !== undefined && installed === known) ||
      // One in flight is judged against the newest push when it lands.
      this.#reads.busy(kind) ||
      !this.#listeners.has(kind) ||
      !this.#options.canRead()
    )
      return;
    const observed = () => this.#listeners.has(kind) && this.#options.canRead();
    void this.#reads
      .request(kind, (read) => this.#job(kind, read), { observed })
      .catch(() => undefined);
  }

  /** Every page of one kind, installed together and only while nothing newer has arrived. */
  async #job(kind: PersonalResourceKind, read: FencedRead) {
    const pages: Detail[] = [];
    let cursor: string | undefined;
    let bytes = 0;
    const cursors = new Set<string>();
    for (;;) {
      const page = await this.#options.read(kind, cursor, read.signal);
      if (!read.current()) return;
      if (!page.ok) throw Object.assign(new Error(page.error.message), page.error);
      if (page.data.data.kind !== kind) return;
      bytes += utf8ByteLength(JSON.stringify(page.data));
      if (bytes > inventoryBytes || (page.data.next && cursors.has(page.data.next))) return;
      pages.push(page.data);
      if (page.data.next === null) break;
      cursors.add(page.data.next);
      cursor = page.data.next;
    }
    if (!read.current()) return;
    const { revision } = pages.at(-1)!;
    const known = this.#known.get(kind);
    // The Host pushed something newer while this read flew: it paints nothing and reads again,
    // once; a second identical answer waits for the next push rather than spin.
    if (known !== undefined && newerRevision(known, revision)) {
      if (this.#behind.get(kind) !== revision) {
        this.#behind.set(kind, revision);
        this.#reads.changed(kind);
      }
      return;
    }
    this.#behind.delete(kind);
    pages.forEach((page, index) =>
      this.#options.apply(page.data, index > 0, index < pages.length - 1),
    );
    const first = !this.#installed.has(kind);
    this.#installed.set(kind, revision);
    // Installed with no push since it began, so it is at least as new as anything pushed before.
    this.#known.set(kind, revision);
    if (first) this.#options.loaded?.(kind);
  }
}

/**
 * Whether `a` is a later revision than `b`. Only revisions of one Host boot compare: the durable
 * sequence, then the boot's runtime counter. Across boots any difference counts as newer, so the
 * client reads again rather than keep what an older boot said.
 */
export function newerRevision(a: string, b: string): boolean {
  if (a === b) return false;
  const [durableA, bootA, countA] = a.split(".");
  const [durableB, bootB, countB] = b.split(".");
  if (bootA !== undefined && bootB !== undefined && bootA !== bootB) return true;
  const durable = BigInt(durableA!) - BigInt(durableB!);
  if (durable !== 0n) return durable > 0n;
  return Number(countA ?? 0) > Number(countB ?? 0);
}
