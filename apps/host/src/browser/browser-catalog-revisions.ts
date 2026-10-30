import { createHash } from "node:crypto";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { BrowserTabCatalogSchema, type BrowserTabCatalog } from "@opensteer/protocol/browser";

/** One broker's global counter and bounded, viewer-specific publication history. */
export class BrowserCatalogRevisions {
  #revision = 0;
  #generation: number | undefined;
  readonly #viewers = new Map<string, { digest: string; revision: number }>();

  get revision(): number {
    return this.#revision;
  }
  get size(): number {
    return this.#viewers.size;
  }
  has(viewer: string): boolean {
    return this.#viewers.has(viewer);
  }
  advance(): number {
    return ++this.#revision;
  }
  clear(): void {
    this.#viewers.clear();
  }

  assign(viewer: string, input: BrowserTabCatalog): BrowserTabCatalog {
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
    // A forgotten viewer always gets a fresh global revision, so eviction
    // cannot reuse a revision that viewer has already received.
    if (!previous || (previous.digest !== digest && this.#revision <= previous.revision))
      this.advance();
    this.#viewers.delete(viewer);
    this.#viewers.set(viewer, { digest, revision: this.#revision });
    if (this.#viewers.size > 256) this.#viewers.delete(this.#viewers.keys().next().value!);
    return { ...validated, revision: this.#revision };
  }
}
