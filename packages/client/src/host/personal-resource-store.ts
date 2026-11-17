import type { ScopedHostMessage } from "@opensteer/protocol/personal-sync";
import {
  personalResourceKinds,
  type PersonalResourceKind,
  type PersonalResourceRevisions,
  type PersonalResourceView,
} from "@opensteer/protocol/resources";

type ResourceFrame = Extract<ScopedHostMessage, { type: "host.resource" }>;

export class PersonalResourceStore {
  readonly #views = new Map<
    PersonalResourceKind,
    { revision: string; view: PersonalResourceView }
  >();
  readonly #interested = new Map<PersonalResourceKind, number>();
  readonly #listeners = new Map<PersonalResourceKind, Set<() => void>>();
  readonly #onChanged: ((kind: PersonalResourceKind) => void) | undefined;
  #generation = 0;
  #known: PersonalResourceRevisions | undefined;

  constructor(onChanged?: (kind: PersonalResourceKind) => void) {
    this.#onChanged = onChanged;
  }

  begin(generation: number) {
    if (generation > this.#generation) this.#generation = generation;
  }

  watch(kind: PersonalResourceKind, listener: () => void) {
    const listeners = this.#listeners.get(kind) ?? new Set<() => void>();
    this.#listeners.set(kind, listeners);
    listeners.add(listener);
    this.#interested.set(kind, (this.#interested.get(kind) ?? 0) + 1);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(kind);
      const count = this.#interested.get(kind) ?? 0;
      if (count < 2) this.#interested.delete(kind);
      else this.#interested.set(kind, count - 1);
      this.#evict();
    };
  }

  get(kind: PersonalResourceKind) {
    return this.#views.get(kind);
  }
  isObserved(kind: PersonalResourceKind) {
    return this.#interested.has(kind);
  }

  getKnownRevision(kind: PersonalResourceKind) {
    return this.#known?.[kind];
  }

  getInterests() {
    const interests = [...this.#interested.keys()];
    const installed = Object.fromEntries(
      interests.flatMap((kind) => {
        const value = this.#views.get(kind);
        return value ? [[kind, value.revision]] : [];
      }),
    );
    return { interests, installed };
  }

  updateRevisions(generation: number, revisions: PersonalResourceRevisions) {
    if (generation !== this.#generation) return;
    const previous = this.#known;
    const next = { ...revisions };
    if (previous)
      for (const kind of personalResourceKinds)
        if (BigInt(previous[kind]) > BigInt(revisions[kind])) next[kind] = previous[kind];
    this.#known = next;
    for (const kind of personalResourceKinds)
      if (previous?.[kind] !== next[kind]) this.#notify(kind);
  }

  install(frame: ResourceFrame) {
    const existing = this.#views.get(frame.kind);
    const required = this.#known?.[frame.kind];
    if (
      frame.generation !== this.#generation ||
      (existing && BigInt(existing.revision) >= BigInt(frame.revision)) ||
      (required && BigInt(required) > BigInt(frame.revision))
    )
      return false;
    this.#views.delete(frame.kind);
    this.#views.set(frame.kind, { revision: frame.revision, view: frame.view });
    this.#evict();
    this.#notify(frame.kind);
    return true;
  }

  checkpoint() {
    return Object.fromEntries(this.#views);
  }

  clear() {
    const observed = [...this.#views.keys()];
    this.#views.clear();
    this.#known = undefined;
    for (const kind of observed) this.#notify(kind);
  }

  #notify(kind: PersonalResourceKind) {
    this.#onChanged?.(kind);
    for (const listener of this.#listeners.get(kind) ?? []) listener();
  }

  #evict() {
    let unpinned = 0;
    for (const [kind, { view }] of this.#views)
      if (!this.#interested.has(kind)) unpinned += view.entries.length;
    for (const [kind, { view }] of this.#views) {
      if (unpinned <= 256) break;
      if (!this.#interested.has(kind)) {
        this.#views.delete(kind);
        unpinned -= view.entries.length;
        this.#notify(kind);
      }
    }
  }
}
