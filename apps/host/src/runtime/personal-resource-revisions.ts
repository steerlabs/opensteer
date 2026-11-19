import { randomBytes } from "node:crypto";
import type {
  DurablePersonalResourceKind,
  DurablePersonalResourceRevisions,
  PersonalResourceKind,
  PersonalResourceRevisions,
} from "@opensteer/protocol/resources";

/**
 * Each kind's current revision. A durable revision is the sequence of the
 * commit that last changed the kind; a runtime fact (a Runner, a browser
 * placement, a plugin) bumps an in-memory counter tagged with this boot, so it
 * never takes the deployment lock or writes PostgreSQL. Bump only after the
 * change is visible to a read: a read takes its revision first, so its data is
 * never older than the revision it reports.
 */
export class ResourceRevisions {
  readonly #boot = randomBytes(8).toString("hex");
  readonly #durable = new Map<PersonalResourceKind, bigint>();
  readonly #runtime = new Map<PersonalResourceKind, number>();
  readonly #changed: (kinds: ReadonlySet<PersonalResourceKind>) => void;

  constructor(changed: (kinds: ReadonlySet<PersonalResourceKind>) => void) {
    this.#changed = changed;
  }

  /** Durable revisions read at startup; anything a commit already reported stays. */
  seed(revisions: DurablePersonalResourceRevisions) {
    this.committed(
      new Set(Object.keys(revisions) as DurablePersonalResourceKind[]),
      (kind) => revisions[kind],
    );
  }

  committed(
    kinds: ReadonlySet<DurablePersonalResourceKind>,
    head: string | ((kind: DurablePersonalResourceKind) => string),
  ) {
    const changed = new Set<PersonalResourceKind>();
    for (const kind of kinds) {
      const revision = BigInt(typeof head === "string" ? head : head(kind));
      if (revision <= (this.#durable.get(kind) ?? 0n)) continue;
      this.#durable.set(kind, revision);
      changed.add(kind);
    }
    if (changed.size) this.#changed(changed);
  }

  bump(...kinds: PersonalResourceKind[]) {
    for (const kind of kinds) this.#runtime.set(kind, (this.#runtime.get(kind) ?? 0) + 1);
    if (kinds.length) this.#changed(new Set(kinds));
  }

  get(kind: PersonalResourceKind) {
    const durable = (this.#durable.get(kind) ?? 0n).toString();
    const runtime = this.#runtime.get(kind);
    return runtime ? `${durable}.${this.#boot}.${runtime}` : durable;
  }

  read(kinds: readonly PersonalResourceKind[]): PersonalResourceRevisions {
    return Object.fromEntries(kinds.map((kind) => [kind, this.get(kind)]));
  }
}
