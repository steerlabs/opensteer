import type { PersonalCommitReaction } from "@opensteer/database/personal-mutation";
import {
  ShadowLedger,
  compareShadow,
  type ShadowCatalog,
  type ShadowInventory,
} from "./shadow-comparison.js";

/** Inventory changes within this window are one comparison. */
const coalesceMs = 50;
/** A catalog read that takes longer than this is abandoned and logged as failed. */
const readDeadlineMs = 5_000;

/**
 * The Runs a commit may have changed the eligibility of: a Run's own id, or
 * null for every Run (a binding acquired, which names no Run, or a Runner
 * revoked). Undefined for a commit about no Run. Binding acquisition emits
 * `executionDeadlinesChanged`; ordinary lease renewals do not.
 */
export function shadowRunsTouched(
  reaction: PersonalCommitReaction,
): readonly string[] | null | undefined {
  switch (reaction.type) {
    case "runChanged":
    case "runFinished":
      return [reaction.runId];
    case "grantsRevoked":
      return reaction.grants.map((grant) => grant.runId);
    case "runnerRevoked":
    case "executionDeadlinesChanged":
      return null;
    default:
      return undefined;
  }
}

/**
 * Reads catalog cuts for every shadowed session of this Host, one at a time:
 * a burst of changes queues each session once behind the read in flight, so
 * this feature never holds more than one pooled connection.
 */
export class ShadowReader {
  readonly #queue = new Set<ShadowHostSession>();
  #running = false;

  request(session: ShadowHostSession): void {
    this.#queue.add(session);
    if (this.#running) return;
    this.#running = true;
    void (async () => {
      while (this.#queue.size) {
        const next = this.#queue.values().next().value!;
        this.#queue.delete(next);
        await next.readNow();
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        this.#running = false;
      });
  }

  forget(session: ShadowHostSession): void {
    this.#queue.delete(session);
  }
}

/**
 * One browser session's shadow comparison on the Host: the catalog against
 * what the runtime already reports, logged and nothing more. It runs only when
 * an input changes (a commit for one of its tabs or Runs, an inventory or
 * holder change) and never on a timer, so an idle Host does no work for it.
 * It compares only against a cut no later commit has superseded, and after a
 * failed read compares nothing until a read succeeds. Nothing waits on it;
 * any failure is logged once per kind and dropped.
 */
export class ShadowHostSession {
  readonly #session: string;
  readonly #reader: ShadowReader;
  readonly #read: (
    surfaces: readonly string[],
    signal: AbortSignal,
  ) => Promise<ShadowCatalog | null>;
  readonly #inventory: () => ShadowInventory | null;
  readonly #log: (line: Record<string, unknown>) => void;
  readonly #ledger = new ShadowLedger();
  readonly #failing = new Set<"read" | "compare">();
  /** The current cut, or null while none is valid: never read, superseded, or failed. */
  #catalog: ShadowCatalog | null = null;
  /** Surfaces whose admission was pending when the current cut was read. */
  #pendingAtRead: ReadonlySet<string> = new Set();
  /** Counts commits that touch this session; a cut read under an older count is discarded. */
  #epoch = 0;
  #needRead = false;
  #reading: AbortController | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #compared = false;
  #stopped = false;

  constructor(options: {
    readonly session: string;
    readonly reader: ShadowReader;
    /** One consistent catalog read; null when the session is gone. */
    readonly read: (
      surfaces: readonly string[],
      signal: AbortSignal,
    ) => Promise<ShadowCatalog | null>;
    /** What the runtime reports now; null when the session has no committed live inventory. */
    readonly inventory: () => ShadowInventory | null;
    readonly log?: (line: Record<string, unknown>) => void;
  }) {
    this.#session = options.session;
    this.#reader = options.reader;
    this.#read = options.read;
    this.#inventory = options.inventory;
    this.#log = options.log ?? ((line) => console.info(JSON.stringify(line)));
  }

  /** The Runs the current cut knows, for targeting Run commits. */
  get runs(): ReadonlySet<string> {
    return this.#catalog?.known ?? new Set();
  }

  /** The catalog or who may use the session changed: the current cut no longer stands. */
  catalogChanged(): void {
    if (this.#stopped) return;
    this.#epoch++;
    this.#catalog = null;
    this.#needRead = true;
    this.#reader.request(this);
  }

  /** What the runtime reports, or who holds its pages, may have changed: compare again. */
  inventoryChanged(): void {
    if (this.#stopped || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#compare();
    }, coalesceMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#reading?.abort();
    this.#reader.forget(this);
    if (this.#compared) this.#write(this.#ledger.stopped(Date.now()));
  }

  /** Called by the reader, one session at a time. */
  async readNow(): Promise<void> {
    if (this.#stopped || !this.#needRead) return;
    this.#needRead = false;
    const epoch = this.#epoch;
    const before = this.#safeInventory();
    const reading = new AbortController();
    this.#reading = reading;
    const deadline = setTimeout(() => reading.abort(), readDeadlineMs);
    deadline.unref?.();
    let catalog: ShadowCatalog | null;
    try {
      catalog = await this.#read([...(before?.surfaces.keys() ?? [])], reading.signal);
      this.#failing.delete("read");
    } catch {
      // Nothing is compared until a read succeeds; the next commit reads again.
      if (epoch === this.#epoch) this.#catalog = null;
      if (!this.#stopped) this.#fail("read");
      return;
    } finally {
      clearTimeout(deadline);
      if (this.#reading === reading) this.#reading = undefined;
    }
    // A later commit superseded this cut: its own read is already queued.
    if (this.#stopped || epoch !== this.#epoch) return;
    this.#catalog = catalog;
    this.#pendingAtRead = before?.pending ?? new Set();
    this.#compare();
  }

  #compare(): void {
    const catalog = this.#catalog;
    if (this.#stopped || !catalog) return;
    try {
      const now = this.#inventory();
      if (!now) return;
      // A page still being admitted when the cut was read stays so until a newer cut.
      const inventory: ShadowInventory = {
        ...now,
        pending: new Set([...now.pending, ...this.#pendingAtRead]),
      };
      const { findings, uncertain } = compareShadow(catalog, inventory);
      this.#compared = true;
      for (const line of this.#ledger.update(findings, uncertain, Date.now())) this.#write(line);
      this.#failing.delete("compare");
    } catch {
      this.#fail("compare");
    }
  }

  #safeInventory(): ShadowInventory | null {
    try {
      return this.#inventory();
    } catch {
      return null;
    }
  }

  #fail(kind: "read" | "compare"): void {
    if (this.#failing.has(kind)) return;
    this.#failing.add(kind);
    this.#write({ event: "browser.shadow.failed", kind });
  }

  #write(line: Record<string, unknown>): void {
    try {
      this.#log({ ...line, session: this.#session });
    } catch {
      // A log line cannot affect the session.
    }
  }
}
