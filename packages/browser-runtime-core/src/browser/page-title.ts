import { ExecutionContextInventory, type CdpParameters } from "@opensteer/browser-core";
import { z } from "zod";
import type { CdpSession } from "./backend.js";

/** The ledger's view of the page a sample must belong to; null once it is gone. */
export interface PageTitleOwner {
  readonly documentId: string;
  /** The loader of the committed document; null until a sample has seen it. */
  readonly loaderId: string | null;
  readonly committedUrl: string;
}

const SampleSchema = z.object({
  result: z.object({ value: z.object({ href: z.string(), title: z.string() }) }),
});
const FrameTreeSchema = z.object({
  frameTree: z.object({ frame: z.object({ id: z.string(), loaderId: z.string() }) }),
});

/**
 * Reads a page's title from the document it belongs to. Browser-side target
 * info names a title without saying which document it came from, and can lag
 * a commit the page's own session has already reported, so a title is only
 * taken from the main world of the document the ledger currently shows.
 *
 * Attribution uses this one session's own order. A sample captures the
 * session's generation (bumped by every context reset and main-frame commit),
 * then asks the page which loader it shows; if nothing changed meanwhile, the
 * newest main world reported since the last commit belongs to that loader. A
 * restored document is the exception Chromium names: its contexts come back
 * after its reset and before its commit.
 * The title is read by `uniqueContextId`, which never reaches another context.
 *
 * It only listens: the ledger enables Runtime on every page's session when it
 * announces the page (its script targets do), which reports existing contexts.
 * The ledger asks for a sample once it has taken in a commit, so a sample
 * never starts on behalf of a document the ledger no longer shows. At most
 * one sample runs per page; hints that arrive meanwhile run one more after it. A failed sample does not retry by itself, and nothing waits for a
 * sample, so a stuck renderer holds only its own title.
 */
export class PageTitleReader {
  readonly #cdp: CdpSession;
  readonly #frameId: string;
  readonly #owner: () => PageTitleOwner | null;
  readonly #adoptLoader: (documentId: string, loaderId: string) => void;
  readonly #publish: (documentId: string, title: string) => void;
  readonly #inventory = new ExecutionContextInventory();
  /** Context ID → order of its creation report, to leave pre-commit contexts behind. */
  readonly #created = new Map<number, number>();
  #creations = 0;
  #staleThrough = 0;
  #generation = 0;
  #running = false;
  #wanted = false;
  #closed = false;

  constructor(
    cdp: CdpSession,
    frameId: string,
    owner: () => PageTitleOwner | null,
    adoptLoader: (documentId: string, loaderId: string) => void,
    publish: (documentId: string, title: string) => void,
  ) {
    this.#cdp = cdp;
    this.#frameId = frameId;
    this.#owner = owner;
    this.#adoptLoader = adoptLoader;
    this.#publish = publish;
    cdp.on("Runtime.executionContextCreated", this.#onCreated);
    cdp.on("Runtime.executionContextDestroyed", this.#onDestroyed);
    cdp.on("Runtime.executionContextsCleared", this.#onCleared);
    cdp.on("Page.frameNavigated", this.#onFrameNavigated);
  }

  /** Asks for a sample of the current document's title. */
  sample(): void {
    if (this.#closed) return;
    this.#wanted = true;
    if (!this.#running) void this.#run();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cdp.off("Runtime.executionContextCreated", this.#onCreated);
    this.#cdp.off("Runtime.executionContextDestroyed", this.#onDestroyed);
    this.#cdp.off("Runtime.executionContextsCleared", this.#onCleared);
    this.#cdp.off("Page.frameNavigated", this.#onFrameNavigated);
  }

  async #run(): Promise<void> {
    this.#running = true;
    try {
      while (this.#wanted && !this.#closed) {
        this.#wanted = false;
        await this.#sampleOnce().catch(() => undefined);
      }
    } finally {
      this.#running = false;
    }
  }

  async #sampleOnce(): Promise<void> {
    const owner = this.#current();
    if (!owner) return;
    const generation = this.#generation;
    const tree = FrameTreeSchema.parse(await this.#cdp.send("Page.getFrameTree"));
    // Anything this session reported since the question was asked supersedes it.
    if (generation !== this.#generation) {
      this.#wanted = true;
      return;
    }
    const frame = tree.frameTree.frame;
    const current = this.#current();
    if (!current || frame.id !== this.#frameId) return;
    if (current.documentId !== owner.documentId) {
      this.#wanted = true;
      return;
    }
    if (current.loaderId === null) this.#adoptLoader(current.documentId, frame.loaderId);
    else if (current.loaderId !== frame.loaderId) return;
    const world = this.#inventory
      .entries()
      .filter(
        (entry) =>
          entry.mainWorld &&
          entry.frameId === this.#frameId &&
          entry.uniqueId !== null &&
          (this.#created.get(entry.id) ?? 0) > this.#staleThrough,
      )
      .at(-1);
    // A main world reported later asks for a sample of its own.
    if (!world?.uniqueId || !this.#current()) return;
    const sample = SampleSchema.parse(
      await this.#cdp.send("Runtime.evaluate", {
        expression: "({ href: location.href, title: document.title })",
        uniqueContextId: world.uniqueId,
        returnByValue: true,
        silent: true,
      }),
    ).result.value;
    const after = this.#current();
    if (
      !after ||
      after.documentId !== owner.documentId ||
      !this.#inventory.entries().some((entry) => entry.uniqueId === world.uniqueId)
    )
      return;
    // A same-document navigation since the read asks for another sample.
    if (sample.href !== after.committedUrl) return;
    this.#publish(owner.documentId, sample.title);
  }

  #current(): PageTitleOwner | null {
    return this.#closed ? null : this.#owner();
  }

  readonly #onCreated = (parameters: unknown): void => {
    const entry = this.#inventory.observe(
      "Runtime.executionContextCreated",
      parameters as CdpParameters,
    );
    if (!entry) return;
    this.#created.set(entry.id, ++this.#creations);
    if (entry.mainWorld && entry.frameId === this.#frameId) this.sample();
  };

  readonly #onDestroyed = (parameters: unknown): void => {
    const entry = this.#inventory.observe(
      "Runtime.executionContextDestroyed",
      parameters as CdpParameters,
    );
    if (entry) this.#created.delete(entry.id);
  };

  readonly #onCleared = (): void => {
    this.#inventory.clear();
    this.#created.clear();
    this.#generation++;
  };

  readonly #onFrameNavigated = (parameters: unknown): void => {
    if (!parameters || typeof parameters !== "object" || !("frame" in parameters)) return;
    const frame = parameters.frame;
    if (!frame || typeof frame !== "object" || "parentId" in frame) return;
    // Contexts reported before a commit belong to the document it replaced,
    // even those reported since a reset, as a resubscribed session replays
    // them. Only a restore brings its own back first; its reset cleared the rest.
    if (!("type" in parameters) || parameters.type !== "BackForwardCacheRestore")
      this.#staleThrough = this.#creations;
    this.#generation++;
  };
}
