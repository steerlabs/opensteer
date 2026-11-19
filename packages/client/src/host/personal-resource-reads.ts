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
/**
 * The most a complete inventory of each kind may hold, in serialized bytes, checked as each page
 * arrives so a phone never accumulates more. Each is several times what the kind can legitimately
 * hold: tabs are at most 1,000 plus 200 groups (about 2 KiB each) and a 128 KiB layout; one model
 * catalog is at most 8,192 descriptors. Machines, environments and harnesses are not bounded per
 * owner on the Host; a person with hundreds of each still fits. A read past its bound stops,
 * installs nothing, keeps the last complete inventory, and is reported (`unreadable`); the next
 * revision reads again.
 */
const mebibyte = 1024 * 1024;
const inventoryBounds: Partial<Record<PersonalResourceKind, number>> = {
  "harness-catalog": 8 * mebibyte,
  tab: 4 * mebibyte,
  "tab-layout": mebibyte,
  machine: 4 * mebibyte,
  environment: 2 * mebibyte,
  harness: 2 * mebibyte,
  "browser-profile": 2 * mebibyte,
  "browser-placement": mebibyte,
  "browser-home": mebibyte,
};
/** Settings, identity, profile, availability and every plugin signal are a single small value. */
const smallInventoryBytes = 256 * 1024;
export function inventoryBound(kind: PersonalResourceKind): number {
  return inventoryBounds[kind] ?? smallInventoryBytes;
}
/**
 * The kinds a Runner's connection moves. The Host bumps them on every connect and disconnect; a
 * reread waits this long after the first such push, so a Runner that drops and comes back costs
 * one read of each rather than two. A first read, a new Host boot and an attach never wait. Tabs,
 * which people change, are read at once.
 */
export const runnerSettleMs = 2_000;
const runnerKinds: ReadonlySet<PersonalResourceKind> = new Set([
  "machine",
  "environment",
  "harness-catalog",
  "browser-availability",
  "browser-placement",
]);
/** How long a reader that unmounted keeps its kinds watched, so navigating back reads nothing. */
export const readerGraceMs = 5_000;
/** How long a read made outside any reader (an effect, a handler, a controller) keeps its kind watched. */
export const ambientLeaseMs = 30_000;

/** What one reader read: held while it is open, and for a grace after its last close. */
export interface ResourceInterest {
  hold(kind: PersonalResourceKind): void;
  open(): void;
  close(): void;
}

export interface PersonalResourceReadOptions {
  read(kind: PersonalResourceKind, cursor: string | undefined, signal: AbortSignal): Promise<Page>;
  /** Install a kind's complete inventory, every page of one read, as one change. */
  apply(pages: readonly Detail["data"][]): void;
  /** The app is in front; a background app reads nothing. */
  canRead(): boolean;
  /** The watched kinds changed. */
  watchChanged(): void;
  /** A kind's first complete read for this viewer landed. */
  loaded?(kind: PersonalResourceKind): void;
  /** The Host moved past what this client installed; its next read is coming. */
  behind?(kind: PersonalResourceKind): void;
  /** Whether a kind's newest read could not be installed (too large, or malformed). */
  unreadable?(kind: PersonalResourceKind, unreadable: boolean): void;
}

/**
 * The Host pushes only `{kind: revision}`; this reads a kind's detail when a
 * surface watches it and the pushed revision differs from the one installed.
 * Reads are fenced (`FencedReads`): one per kind, judged when it lands against
 * the newest push; all of a kind's pages install together, as one change, and
 * only while nothing newer arrived; a failure retries with backoff while the
 * kind is watched. A kind is watched while a reader that read it is mounted.
 */
export class PersonalResourceReads implements PersonalResourcePort {
  readonly #options: PersonalResourceReadOptions;
  readonly #listeners = new Map<PersonalResourceKind, Set<() => void>>();
  readonly #known = new Map<PersonalResourceKind, string>();
  readonly #installed = new Map<PersonalResourceKind, string>();
  readonly #leases = new Map<
    PersonalResourceKind,
    { release: () => void; timer: ReturnType<typeof setTimeout> }
  >();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  readonly #unreadableKinds = new Set<PersonalResourceKind>();
  /** Each kind's last read that ended in a failure no retry can mend, until another read starts. */
  readonly #failures = new Map<PersonalResourceKind, unknown>();
  /** Each kind's read in flight, settled once it installs or gives up. */
  readonly #inFlight = new Map<PersonalResourceKind, Promise<void>>();
  /** A Runner kind's pending reread, from its first push within the settle window. */
  readonly #settling = new Map<PersonalResourceKind, ReturnType<typeof setTimeout>>();
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
      const installed = this.#installed.get(kind);
      // Only a live push of a Runner kind waits; what the Host says in answer to an attach is
      // read at once.
      if (
        runnerKinds.has(kind) &&
        installed !== undefined &&
        sameBoot(installed, revision) &&
        Date.now() >= this.#attachAnswerUntil
      )
        this.#settle(kind);
      else this.#read(kind);
      for (const listener of this.#listeners.get(kind) ?? []) listener();
    }
    // The revisions the Host sends in answer to an attach come in one frame.
    this.#attachAnswerUntil = 0;
  }

  /** Read every watched kind that is behind, as after attaching or returning to the front. */
  resume(attached = false) {
    // The Host answers an attach with every revision that moved meanwhile; that answer is read at
    // once, never held in the settle window. Bounded, in case nothing moved and no answer comes.
    if (attached) this.#attachAnswerUntil = Date.now() + runnerSettleMs;
    for (const kind of this.#listeners.keys()) this.#read(kind);
  }

  #attachAnswerUntil = 0;

  abort() {
    for (const kind of personalResourceKinds) this.#reads.stop(kind);
  }

  /** A kind whose data lives only with its listeners is read again by the next one. */
  forget(kind: PersonalResourceKind) {
    this.#installed.delete(kind);
  }

  /** A reader (a mounted selection, a subscription): what it reads stays watched while it is open. */
  interest(): ResourceInterest {
    const held = new Map<PersonalResourceKind, () => void>();
    let opened = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disarm = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      this.#timers.delete(timer);
      timer = undefined;
    };
    const arm = () => {
      disarm();
      timer = setTimeout(() => {
        this.#timers.delete(timer!);
        timer = undefined;
        const releases = [...held.values()];
        held.clear();
        for (const release of releases) release();
      }, readerGraceMs);
      this.#timers.add(timer);
    };
    return {
      hold: (kind) => {
        // Its own registration: a listener shared with another reader would let either end both.
        if (!held.has(kind))
          held.set(
            kind,
            this.watch(kind, () => undefined),
          );
        // Read by a render that never mounted: it lets go after the grace.
        if (opened === 0 && timer === undefined) arm();
      },
      open: () => {
        opened++;
        disarm();
      },
      close: () => {
        if (opened > 0 && --opened === 0) arm();
      },
    };
  }

  /** A read outside any reader: the kind stays watched for a while after the latest such read. */
  lease(kind: PersonalResourceKind) {
    const held = this.#leases.get(kind);
    if (held) {
      clearTimeout(held.timer);
      this.#timers.delete(held.timer);
    }
    const release = held?.release ?? this.watch(kind, () => undefined);
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.#leases.delete(kind);
      release();
    }, ambientLeaseMs);
    this.#timers.add(timer);
    this.#leases.set(kind, { release, timer });
  }

  /** Ends every grace, lease and settle timer; the client is closing. */
  dispose() {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#settling.clear();
    this.abort();
  }

  #settle(kind: PersonalResourceKind) {
    if (this.#settling.has(kind)) return;
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      this.#settling.delete(kind);
      this.#read(kind);
    }, runnerSettleMs);
    this.#timers.add(timer);
    this.#settling.set(kind, timer);
  }

  /**
   * Another viewer or history: nothing read or in flight belongs to it. What screens show stays
   * watched, so `resume()` reads it again for whoever is attached next.
   */
  reset() {
    this.#viewer++;
    for (const timer of this.#settling.values()) {
      clearTimeout(timer);
      this.#timers.delete(timer);
    }
    this.#settling.clear();
    this.abort();
    this.#known.clear();
    this.#installed.clear();
    this.#behind.clear();
    // The next viewer or history reports its own failures.
    this.#unreadableKinds.clear();
    this.#failures.clear();
  }

  #read(kind: PersonalResourceKind) {
    // A read now (a new reader, an attach, the app in front) takes over a settling reread.
    const settling = this.#settling.get(kind);
    if (settling !== undefined) {
      clearTimeout(settling);
      this.#timers.delete(settling);
      this.#settling.delete(kind);
    }
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
    this.#failures.delete(kind);
    const flying: Promise<void> = this.#reads
      .request(kind, (read) => this.#job(kind, read), { observed })
      // Only a failure no retry can mend settles the request with an error: kept for a command
      // waiting on the kind, which then stops at once rather than asking again.
      .catch((error: unknown) => {
        this.#failures.set(kind, error);
      })
      .finally(() => {
        if (this.#inFlight.get(kind) === flying) this.#inFlight.delete(kind);
      });
    this.#inFlight.set(kind, flying);
  }

  /**
   * For a command that needs a kind's current value: settles once the kind holds the newest
   * revision this client has heard of. A read that cannot finish within `boundMs` (failing,
   * retrying, or the app behind) rejects, so the command fails with a clear error instead of
   * waiting on the resource owner. Commands that need no kind never call this.
   */
  async current(kind: PersonalResourceKind, boundMs: number) {
    this.lease(kind);
    const ready = () => {
      const installed = this.#installed.get(kind);
      const known = this.#known.get(kind);
      return installed !== undefined && (known === undefined || known === installed);
    };
    const deadline = Date.now() + boundMs;
    while (!ready()) {
      this.#read(kind);
      const flying = this.#inFlight.get(kind);
      const left = deadline - Date.now();
      if (!flying || left <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        flying,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, left);
        }),
      ]);
      clearTimeout(timer);
      // The read ended in a failure no retry can mend: the command fails with it, now.
      if (this.#failures.has(kind)) throw this.#failures.get(kind);
      if (Date.now() >= deadline) break;
    }
    if (!ready())
      throw Object.assign(
        new Error("Opensteer couldn't read this information from your computer. Try again."),
        { code: "unavailable" as const },
      );
  }

  /** A Host answer no retry can mend: reported, and read again on the kind's next revision. */
  #unreadable(kind: PersonalResourceKind, detail: string) {
    if (!this.#unreadableKinds.has(kind)) {
      this.#unreadableKinds.add(kind);
      this.#options.unreadable?.(kind, true);
    }
    return Object.assign(new Error(`The Host's ${kind} inventory ${detail}.`), {
      code: "invalid-response",
    });
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
      if (page.data.data.kind !== kind)
        throw this.#unreadable(kind, `answered a ${page.data.data.kind}`);
      bytes += utf8ByteLength(JSON.stringify(page.data));
      if (bytes > inventoryBound(kind)) throw this.#unreadable(kind, "exceeds its bound");
      if (page.data.next && cursors.has(page.data.next))
        throw this.#unreadable(kind, "repeats a cursor");
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
    this.#options.apply(pages.map((page) => page.data));
    if (this.#unreadableKinds.delete(kind)) this.#options.unreadable?.(kind, false);
    const first = !this.#installed.has(kind);
    this.#installed.set(kind, revision);
    // Installed with no push since it began, so it is at least as new as anything pushed before.
    this.#known.set(kind, revision);
    if (first) this.#options.loaded?.(kind);
  }
}

/** Whether two revisions come from one Host boot, where a push may be a Runner's flap. */
function sameBoot(a: string, b: string) {
  return a.split(".")[1] === b.split(".")[1];
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
