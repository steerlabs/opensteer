import type { ScopedHostMessage } from "@opensteer/protocol/personal-sync";
import { utf8ByteLength } from "@opensteer/core";

type LiveFrame = Extract<ScopedHostMessage, { type: "host.live" }>;

export interface ItemText {
  readonly streamId: string;
  readonly text: string;
  readonly offset: number;
  readonly totalLength: number;
  readonly incomplete: boolean;
}

const maxTailBytes = 16 * 1024;

function trimTail(text: string) {
  if (utf8ByteLength(text) <= maxTailBytes) return text;
  let start = Math.max(0, text.length - maxTailBytes);
  while (utf8ByteLength(text.slice(start)) > maxTailBytes)
    start += Math.max(1, Math.ceil((text.length - start) / 4));
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start++;
  return text.slice(start);
}

export class ItemTextStore {
  readonly #items = new Map<string, ItemText>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #gaps = new Set<string>();
  #generation = 0;
  #boot: string | undefined;

  get(itemId: string) {
    return this.#items.get(itemId);
  }

  subscribe(itemId: string, listener: () => void) {
    const listeners = this.#listeners.get(itemId) ?? new Set<() => void>();
    this.#listeners.set(itemId, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(itemId);
    };
  }

  generation(generation: number) {
    if (generation <= this.#generation) return;
    this.#generation = generation;
    this.#boot = undefined;
    this.clear();
  }

  clear() {
    const ids = [...this.#items.keys()];
    this.#items.clear();
    this.#gaps.clear();
    for (const id of ids) this.#notify(id);
  }

  apply(frame: LiveFrame, through: string): "ignored" | "applied" | "repair" | "barrier" {
    if (frame.generation !== this.#generation) return "ignored";
    if (BigInt(frame.afterSequence) > BigInt(through)) return "barrier";
    if (this.#boot !== undefined && this.#boot !== frame.liveBootId) this.clear();
    this.#boot = frame.liveBootId;
    const prior = this.#items.get(frame.itemId);
    const { update } = frame;
    if (update.operation === "close") {
      if (prior?.streamId === frame.streamId) this.#delete(frame.itemId);
      return "applied";
    }
    const matches = prior?.streamId === frame.streamId;
    if (matches && update.totalLength < prior.totalLength) return "ignored";
    if (update.operation === "append" && update.offset !== (matches ? prior.totalLength : 0)) {
      if (this.#gaps.has(frame.streamId)) return "ignored";
      if (this.#gaps.size >= 16) this.#gaps.delete(this.#gaps.values().next().value!);
      this.#gaps.add(frame.streamId);
      if (matches && !prior.incomplete) this.#replace(frame.itemId, { ...prior, incomplete: true });
      return "repair";
    }
    if (update.offset + update.text.length !== update.totalLength) return "ignored";
    const piece = update.operation === "append" && matches ? prior.text + update.text : update.text;
    const text = trimTail(piece);
    this.#gaps.delete(frame.streamId);
    const offset = update.totalLength - text.length;
    this.#replace(frame.itemId, {
      streamId: frame.streamId,
      text,
      offset,
      totalLength: update.totalLength,
      incomplete: offset > 0 || (update.operation === "replace" && update.incomplete),
    });
    return "applied";
  }

  #replace(id: string, item: ItemText) {
    if (this.#items.size >= 16 && !this.#items.has(id))
      this.#delete(this.#items.keys().next().value!);
    this.#items.delete(id);
    this.#items.set(id, item);
    this.#notify(id);
  }

  #delete(id: string) {
    const item = this.#items.get(id);
    if (!item) return;
    this.#gaps.delete(item.streamId);
    this.#items.delete(id);
    this.#notify(id);
  }

  #notify(id: string) {
    for (const listener of this.#listeners.get(id) ?? []) listener();
  }
}
