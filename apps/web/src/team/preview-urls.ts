import type { TeamRuntimeOwner } from "@opensteer/client/team";
export class TeamPreviewUrls {
  #generation = 0;
  #urls: ReadonlyMap<string, string> = new Map();
  readonly #asked = new Set<string>();
  readonly #listeners = new Set<() => void>();
  constructor(owner?: TeamRuntimeOwner) {
    owner?.own(() => this.clear());
  }
  getSnapshot = () => this.#urls;
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  async load(id: string, read: () => Promise<Blob | null>): Promise<void> {
    if (this.#asked.has(id)) return;
    this.#asked.add(id);
    const generation = this.#generation;
    try {
      const blob = await read();
      if (!blob || generation !== this.#generation) return;
      this.#urls = new Map([...this.#urls, [id, URL.createObjectURL(blob)]]);
      for (const listener of this.#listeners) listener();
    } catch {
      if (generation === this.#generation) this.#asked.delete(id);
    }
  }
  clear(): void {
    this.#generation++;
    for (const url of this.#urls.values()) URL.revokeObjectURL(url);
    this.#asked.clear();
    this.#urls = new Map();
    for (const listener of this.#listeners) listener();
  }
}
