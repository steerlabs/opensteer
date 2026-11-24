/**
 * Values kept across mounts, bounded by how many there are and by the size each is charged; the
 * least recently used go first. A value charged more than a quarter of the size bound is not
 * kept, since keeping it would push out almost everything else.
 */
export class BoundedCache<K, V> {
  readonly #entries = new Map<K, { readonly value: V; readonly size: number }>();
  readonly #maxEntries: number;
  readonly #maxSize: number;
  #size = 0;

  constructor({
    maxEntries = Infinity,
    maxSize = Infinity,
  }: {
    maxEntries?: number;
    maxSize?: number;
  }) {
    this.#maxEntries = maxEntries;
    this.#maxSize = maxSize;
  }

  /** How many values are kept. */
  get count(): number {
    return this.#entries.size;
  }

  /** The total size charged for the values kept. */
  get size(): number {
    return this.#size;
  }

  /** The value, now the most recently used. */
  get(key: K): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  /** The value, leaving its place in line as it was. */
  peek(key: K): V | undefined {
    return this.#entries.get(key)?.value;
  }

  /** Keeps the value as the most recently used, then drops the least recently used past either bound. */
  set(key: K, value: V, size = 1): void {
    this.delete(key);
    if (size > this.#maxSize / 4) return;
    this.#entries.set(key, { value, size });
    this.#size += size;
    for (const [oldest, entry] of this.#entries) {
      if (this.#entries.size <= this.#maxEntries && this.#size <= this.#maxSize) break;
      this.#entries.delete(oldest);
      this.#size -= entry.size;
    }
  }

  delete(key: K): void {
    const held = this.#entries.get(key);
    if (held === undefined) return;
    this.#entries.delete(key);
    this.#size -= held.size;
  }

  clear(): void {
    this.#entries.clear();
    this.#size = 0;
  }
}
