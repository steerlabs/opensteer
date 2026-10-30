import { createHash } from "node:crypto";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { BrowserTabCatalogSchema, type BrowserTabCatalog } from "@opensteer/protocol/browser";

/** One broker's global counter and bounded, viewer-specific publication history. */
export class BrowserCatalogRevisions {
  #revision = 0;
  // Counts mutations that queued a catalog notice themselves.
  #announced = 0;
  #generation: number | undefined;
  readonly #viewers = new Map<string, { digest: string; revision: number; announced: number }>();

  get revision(): number {
    return this.#revision;
  }
  get size(): number {
    return this.#viewers.size;
  }
  has(viewer: string): boolean {
    return this.#viewers.has(viewer);
  }
  /** A mutation that tells every connection through a catalog notice. */
  announce(): number {
    this.#announced++;
    return ++this.#revision;
  }
  clear(): void {
    this.#viewers.clear();
  }

  /**
   * Stamps `input` for `viewer`. `unannounced` reports content that changed for a
   * viewer seen before with no announced mutation since, such as a restored holding
   * or repeated activity: the caller must notify that viewer's other connections.
   */
  assign(
    viewer: string,
    input: BrowserTabCatalog,
  ): { catalog: BrowserTabCatalog; unannounced: boolean } {
    const validated = BrowserTabCatalogSchema.parse(input);
    const { generation, revision: suppliedRevision, ...content } = validated;
    const digest = createHash("sha256").update(canonicalJson(content)).digest("hex");
    if (this.#generation !== generation) {
      this.clear();
      this.#generation = generation;
      this.#revision = suppliedRevision;
    }
    this.#revision = Math.max(this.#revision, suppliedRevision);
    const previous = this.#viewers.get(viewer);
    // An unchanged read keeps the viewer's revision. A forgotten viewer always gets
    // a fresh global revision, so eviction cannot reuse one it has already received.
    const revision =
      previous?.digest === digest
        ? previous.revision
        : !previous || this.#revision <= previous.revision
          ? ++this.#revision
          : this.#revision;
    this.#viewers.delete(viewer);
    this.#viewers.set(viewer, { digest, revision, announced: this.#announced });
    if (this.#viewers.size > 256) this.#viewers.delete(this.#viewers.keys().next().value!);
    return {
      catalog: { ...validated, revision },
      unannounced:
        previous !== undefined &&
        previous.digest !== digest &&
        previous.announced === this.#announced,
    };
  }
}
