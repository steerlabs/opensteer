import type { PersonalCommitReaction } from "@opensteer/database/personal-mutation";
import {
  ShadowLedger,
  compareShadow,
  type ShadowCatalog,
  type ShadowInventory,
} from "./shadow-comparison.js";

/** Changes within this window are one comparison: one read, one set of lines. */
const coalesceMs = 50;

/** A commit that may change a session's catalog cut: its open tabs. */
export function shadowCatalogTouched(resourceKinds: ReadonlySet<string>): boolean {
  return resourceKinds.has("tab");
}

/** A commit that may change which Run attempts may use a session. */
export function shadowAuthorityTouched(reaction: PersonalCommitReaction): boolean {
  return (
    reaction.type === "runChanged" ||
    reaction.type === "runFinished" ||
    reaction.type === "grantsRevoked" ||
    reaction.type === "runnerRevoked" ||
    reaction.type === "executionDeadlinesChanged"
  );
}

/**
 * One browser session's shadow comparison on the Host: the catalog against
 * what the runtime already reports, logged and nothing more. It runs only when
 * an input changes (a commit for the catalog or authority, an inventory or
 * holder change) and never on a timer, so an idle Host does no work for it.
 * Nothing waits on it; any failure is logged once per kind and dropped.
 */
export class ShadowHostSession {
  readonly #session: string;
  readonly #read: () => Promise<ShadowCatalog | null>;
  readonly #inventory: () => ShadowInventory | null;
  readonly #log: (line: Record<string, unknown>) => void;
  readonly #ledger = new ShadowLedger();
  readonly #failing = new Set<"read" | "compare">();
  #catalog: ShadowCatalog | null = null;
  #needRead = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #again = false;
  #stopped = false;

  constructor(options: {
    readonly session: string;
    /** One consistent catalog read; null when the session is gone. */
    readonly read: () => Promise<ShadowCatalog | null>;
    /** What the runtime reports now; null when the session has no live attachment. */
    readonly inventory: () => ShadowInventory | null;
    readonly log?: (line: Record<string, unknown>) => void;
  }) {
    this.#session = options.session;
    this.#read = options.read;
    this.#inventory = options.inventory;
    this.#log = options.log ?? ((line) => console.info(JSON.stringify(line)));
  }

  /** The catalog or who may use the session may have changed: read it again. */
  catalogChanged(): void {
    this.#needRead = true;
    this.#schedule();
  }

  /** What the runtime reports, or who holds its pages, may have changed: compare again. */
  inventoryChanged(): void {
    this.#schedule();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
  }

  #schedule(): void {
    if (this.#stopped || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#run();
    }, coalesceMs);
    this.#timer.unref?.();
  }

  #run(): void {
    if (this.#running) {
      this.#again = true;
      return;
    }
    this.#running = true;
    void (async () => {
      do {
        this.#again = false;
        await this.#once();
      } while (this.#again && !this.#stopped);
    })()
      .catch(() => this.#fail("compare"))
      .finally(() => {
        this.#running = false;
      });
  }

  async #once(): Promise<void> {
    if (this.#stopped) return;
    if (this.#needRead) {
      this.#needRead = false;
      try {
        this.#catalog = await this.#read();
        this.#failing.delete("read");
      } catch {
        // A failed read says nothing; the next commit reads again.
        this.#fail("read");
        return;
      }
    }
    if (this.#stopped || !this.#catalog) return;
    try {
      const inventory = this.#inventory();
      if (!inventory) return;
      for (const line of this.#ledger.update(compareShadow(this.#catalog, inventory), Date.now()))
        this.#write(line);
      this.#failing.delete("compare");
    } catch {
      this.#fail("compare");
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
