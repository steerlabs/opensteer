import type { ScopedHostMessage } from "@opensteer/protocol/personal-sync";
import { utf8Tail } from "@opensteer/core";

type LiveFrame = Extract<ScopedHostMessage, { type: "host.live" }>;

export interface ItemText {
  readonly streamId: string;
  readonly text: string;
  readonly offset: number;
  readonly totalLength: number;
  readonly incomplete: boolean;
}

const maxTailBytes = 16 * 1024;

export class ItemTextStore {
  readonly #items = new Map<string, ItemText>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #gaps = new Map<string, number>();
  readonly #closed = new Map<string, string>();
  readonly #retiredBoots = new Set<string>();
  readonly #identities = new Map<string, { key: string; binding: number; attempt: string }>();
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
    this.#retiredBoots.clear();
    this.clear();
  }

  clear() {
    const ids = [...this.#items.keys()];
    this.#items.clear();
    this.#gaps.clear();
    this.#closed.clear();
    this.#identities.clear();
    for (const id of ids) this.#notify(id);
  }

  apply(frame: LiveFrame, through: string): "ignored" | "applied" | "repair" | "barrier" {
    if (frame.generation !== this.#generation) return "ignored";
    if (BigInt(frame.afterSequence) > BigInt(through)) return "barrier";
    if (this.#retiredBoots.has(frame.liveBootId)) return "ignored";
    if (this.#boot !== undefined && this.#boot !== frame.liveBootId) {
      if (this.#retiredBoots.size >= 8) return "ignored";
      this.#retiredBoots.add(this.#boot);
      this.clear();
    }
    this.#boot = frame.liveBootId;
    const key = JSON.stringify([
      frame.runId,
      frame.attemptId,
      frame.bindingGeneration,
      frame.streamId,
    ]);
    const identity = this.#identities.get(frame.itemId);
    if (this.#closed.has(key) || (identity && frame.bindingGeneration < identity.binding))
      return "ignored";
    const prior = this.#items.get(frame.itemId);
    const { update } = frame;
    if (update.operation === "close") {
      rememberBounded(this.#closed, key, frame.afterSequence, 256);
      this.#gaps.delete(key);
      if (identity?.key === key) this.#delete(frame.itemId);
      return "applied";
    }
    const matches = prior && identity?.key === key;
    if (matches && update.totalLength < prior.totalLength) return "ignored";
    const minimum = this.#gaps.get(key);
    if (update.operation === "replace" && minimum !== undefined && update.totalLength < minimum)
      return "ignored";
    if (
      update.operation === "append" &&
      (minimum !== undefined || update.offset !== (matches ? prior.totalLength : 0))
    ) {
      rememberBounded(this.#gaps, key, Math.max(minimum ?? 0, update.totalLength), 16);
      if (matches && !prior.incomplete) this.#replace(frame.itemId, { ...prior, incomplete: true });
      return minimum !== undefined ? "ignored" : "repair";
    }
    if (update.offset + update.text.length !== update.totalLength) return "ignored";
    const piece = update.operation === "append" && matches ? prior.text + update.text : update.text;
    const text = utf8Tail(piece, maxTailBytes);
    this.#gaps.delete(key);
    rememberBounded(
      this.#identities,
      frame.itemId,
      { key, binding: frame.bindingGeneration, attempt: frame.attemptId },
      256,
    );
    const offset = update.totalLength - text.length;
    this.#replace(frame.itemId, {
      streamId: frame.streamId,
      text,
      offset,
      totalLength: update.totalLength,
      incomplete:
        offset > 0 ||
        (update.operation === "replace" ? update.incomplete : !!(matches && prior.incomplete)),
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
    const identity = this.#identities.get(id);
    if (identity) this.#gaps.delete(identity.key);
    this.#items.delete(id);
    this.#notify(id);
  }

  #notify(id: string) {
    for (const listener of this.#listeners.get(id) ?? []) listener();
  }
}

function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number) {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}
