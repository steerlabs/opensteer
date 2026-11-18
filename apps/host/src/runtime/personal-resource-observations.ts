import type { PersonalResourceKind } from "@opensteer/protocol/resources";

export class PersonalResourceObservations {
  readonly #pending = new Map<PersonalResourceKind, Set<Promise<void>>>();
  readonly #versions = new Map<PersonalResourceKind, bigint>();

  begin(kinds: readonly PersonalResourceKind[]) {
    const settled = Promise.withResolvers<void>();
    for (const kind of kinds) {
      const pending = this.#pending.get(kind) ?? new Set<Promise<void>>();
      pending.add(settled.promise);
      this.#pending.set(kind, pending);
    }
    return () => {
      for (const kind of kinds) {
        const pending = this.#pending.get(kind);
        pending?.delete(settled.promise);
        if (pending?.size === 0) this.#pending.delete(kind);
      }
      settled.resolve();
    };
  }

  waitForCurrent(kinds: readonly PersonalResourceKind[]) {
    return Promise.all(kinds.flatMap((kind) => [...(this.#pending.get(kind) ?? [])]));
  }

  committed(kinds: ReadonlySet<PersonalResourceKind>, revision: string) {
    const last = BigInt(revision);
    for (const kind of kinds)
      if (last > (this.#versions.get(kind) ?? 0n)) this.#versions.set(kind, last);
  }

  isCurrent(kind: PersonalResourceKind, revision: string) {
    return !this.#pending.has(kind) && (this.#versions.get(kind) ?? 0n) <= BigInt(revision);
  }
}
