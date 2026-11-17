import type { ScopedHostMessage } from "@opensteer/protocol/personal-sync";
import { utf8Tail } from "@opensteer/core";

type LiveFrame = Extract<ScopedHostMessage, { type: "host.live" }>;

export function liveFrameKey(frame: LiveFrame) {
  return JSON.stringify([
    frame.liveBootId,
    frame.runId,
    frame.attemptId,
    frame.bindingGeneration,
    frame.streamId,
    frame.itemId,
  ]);
}

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
  readonly #faces = new Map<string, NonNullable<LiveFrame["item"]>>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #gaps = new Map<string, number>();
  readonly #closed = new Map<string, string>();
  readonly #retiredBoots = new Set<string>();
  readonly #identities = new Map<
    string,
    { key: string; binding: number; attempt: string; barrier: bigint }
  >();
  #generation = 0;
  #retiredThrough: bigint = -1n;
  #boot: string | undefined;

  get(itemId: string) {
    return this.#items.get(itemId);
  }

  item(itemId: string) {
    return this.#faces.get(itemId);
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
    this.#faces.clear();
    this.#gaps.clear();
    this.#closed.clear();
    this.#retiredThrough = -1n;
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
    const key = liveFrameKey(frame);
    const identity = this.#identities.get(frame.itemId);
    const barrier = BigInt(frame.afterSequence);
    const prior = this.#items.get(frame.itemId);
    const { update } = frame;
    if (
      this.#closed.has(key) ||
      (identity?.key !== key && barrier <= this.#retiredThrough) ||
      (identity &&
        (frame.bindingGeneration < identity.binding ||
          (frame.bindingGeneration === identity.binding &&
            frame.attemptId !== identity.attempt &&
            barrier <= identity.barrier)))
    )
      return "ignored";
    if (update.operation === "close") {
      this.#close(key, frame.afterSequence);
      if (identity?.key !== key || !prior) return "ignored";
      this.#delete(frame.itemId);
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
    if (identity && identity.key !== key) this.#close(identity.key, identity.barrier.toString());
    rememberBounded(
      this.#identities,
      frame.itemId,
      { key, binding: frame.bindingGeneration, attempt: frame.attemptId, barrier },
      256,
    );
    const offset = update.totalLength - text.length;
    if (frame.item) this.#faces.set(frame.itemId, frame.item);
    else if (!matches) this.#faces.delete(frame.itemId);
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

  finishItem(id: string) {
    const current = this.#identities.get(id);
    if (current) this.#close(current.key, current.barrier.toString());
    this.#delete(id);
  }

  #close(key: string, through: string) {
    this.#closed.set(key, through);
    this.#gaps.delete(key);
    if (this.#closed.size <= 256) return;
    const oldest = this.#closed.entries().next().value!;
    this.#closed.delete(oldest[0]);
    const retired = BigInt(oldest[1]);
    if (retired > this.#retiredThrough) this.#retiredThrough = retired;
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
    this.#faces.delete(id);
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
