import { z } from "zod";

export const keyedStreamHardCapBytes = 256 * 1024;
const Revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Generation = z.string().min(1).max(64);

export function keyedStreamSchema<
  Row extends z.ZodRawShape & Record<Key, z.ZodType<string>>,
  Meta extends z.ZodRawShape,
  Key extends string = "id",
>(row: z.ZodObject<Row>, meta: z.ZodObject<Meta>, key: Key = "id" as Key) {
  const keyShape = Object.fromEntries<z.ZodType<string>>([[key, row.shape[key]!]]) as Record<
    Key,
    z.ZodType<string>
  >;
  return z.discriminatedUnion("op", [
    z.strictObject({ op: z.literal("begin"), generation: Generation, prefix: Revision.optional() }),
    z.strictObject({ op: z.literal("rows"), rows: z.array(row).min(1) }),
    z.strictObject({ op: z.literal("end"), revision: Revision, count: Revision, meta }),
    z.strictObject({
      op: z.literal("change"),
      generation: Generation,
      base: Revision,
      revision: Revision,
      add: z.array(row).optional(),
      update: z.array(z.object(row.shape).partial().extend(keyShape)).optional(),
      remove: z.array(keyShape[key]!).optional(),
      meta: meta.partial().optional(),
    }),
  ]);
}

export function keyedStreamViewSchema<
  Row extends z.ZodRawShape & Record<Key, z.ZodType<string>>,
  Meta extends z.ZodRawShape,
  Key extends string = "id",
>(row: z.ZodObject<Row>, meta: z.ZodObject<Meta>, key: Key = "id" as Key) {
  const [begin, rows, end, change] = keyedStreamSchema(row.strip(), meta.strip(), key).options;
  return z.discriminatedUnion("op", [begin.strip(), rows.strip(), end.strip(), change.strip()]);
}

export type KeyedStreamMessage<
  Row extends Record<Key, string>,
  Meta extends object,
  Key extends string = "id",
> =
  | { op: "begin"; generation: string; prefix?: number | undefined }
  | { op: "rows"; rows: Row[] }
  | { op: "end"; revision: number; count: number; meta: Meta }
  | {
      op: "change";
      generation: string;
      base: number;
      revision: number;
      add?: Row[] | undefined;
      update?:
        | ({ [K in Exclude<keyof Row, Key>]?: Row[K] | undefined } & Record<Key, string>)[]
        | undefined;
      remove?: string[] | undefined;
      meta?: { [K in keyof Meta]?: Meta[K] | undefined } | undefined;
    };

export type KeyedStreamChanges = {
  added: string[];
  updated: string[];
  removed: string[];
  structural: boolean;
};
const encoder = new TextEncoder();
export function keyedStreamBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}
export function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(
      ([key, value]) => Object.hasOwn(right, key) && equal(value, Reflect.get(right, key)),
    )
  );
}
function patch<T extends object>(before: T, after: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(after).filter(([key, value]) => !equal(Reflect.get(before, key), value)),
  ) as Partial<T>;
}

interface PublisherOptions<Row, Meta, Key extends string> {
  key?: Key;
  ids(): Iterable<string>;
  read(id: string): Row | undefined;
  meta(): Meta;
  targetBytes: number;
  envelopeBytes: number;
  generation?: string;
}
export class KeyedStreamPublisher<
  Row extends Record<Key, string>,
  Meta extends object,
  Key extends string = "id",
> {
  readonly #key: Key;
  readonly #options: PublisherOptions<Row, Meta, Key>;
  readonly #generation: string;
  readonly #sent = new Map<string, Row>();
  readonly #dirty = new Set<string>();
  #meta: Meta | null = null;
  #metaDirty = false;
  #revision = 0;
  #snapshot: {
    ids: string[];
    cursor: number;
    phase: "begin" | "rows" | "end";
    prior: ReadonlyMap<string, Row>;
    prefix: number | null;
  } | null = null;
  #reset = true;
  #prefix: number | null = null;
  #inflight: { frame: KeyedStreamMessage<Row, Meta, Key>; commit(): void } | null = null;
  #retry = false;
  constructor(options: PublisherOptions<Row, Meta, Key>) {
    if (
      !Number.isSafeInteger(options.targetBytes) ||
      !Number.isSafeInteger(options.envelopeBytes) ||
      options.envelopeBytes < 0 ||
      options.targetBytes <= options.envelopeBytes ||
      options.targetBytes > keyedStreamHardCapBytes
    )
      throw new Error("Invalid keyed stream byte target.");
    this.#generation = Generation.parse(options.generation ?? globalThis.crypto.randomUUID());
    this.#options = options;
    this.#key = options.key ?? ("id" as Key);
  }
  seed(rows: readonly Row[]): void {
    if (!this.#reset || this.#snapshot || this.#inflight || this.#sent.size)
      throw new Error("A keyed stream prefix must precede its first frame.");
    for (const row of rows) {
      this.#sent.set(row[this.#key], row);
      this.#dirty.add(row[this.#key]);
    }
    this.#prefix = rows.length;
  }
  mark(id: string): void {
    this.#dirty.add(id);
  }
  markMeta(): void {
    this.#metaDirty = true;
  }
  reset(): void {
    this.#reset = true;
  }
  hasSent(id: string): boolean {
    return !this.#snapshot && this.#sent.has(id);
  }
  flushed(id: string): boolean {
    const frame = this.#inflight?.frame;
    const named =
      frame?.op === "rows"
        ? frame.rows.some((row) => row[this.#key] === id)
        : frame?.op === "change" &&
          ([...(frame.add ?? []), ...(frame.update ?? [])].some((row) => row[this.#key] === id) ||
            frame.remove?.includes(id));
    return !this.#reset && !this.#snapshot && !this.#dirty.has(id) && !named;
  }
  get pending(): boolean {
    return (
      this.#reset ||
      this.#snapshot !== null ||
      this.#inflight !== null ||
      this.#dirty.size > 0 ||
      this.#metaDirty
    );
  }
  #fits(frame: KeyedStreamMessage<Row, Meta, Key>, target = this.#options.targetBytes): boolean {
    return keyedStreamBytes(frame) + this.#options.envelopeBytes <= target;
  }
  #offer(
    frame: KeyedStreamMessage<Row, Meta, Key>,
    commit: () => void,
  ): KeyedStreamMessage<Row, Meta, Key> {
    if (!this.#fits(frame, keyedStreamHardCapBytes))
      throw new Error("Keyed stream record exceeds the hard byte cap.");
    this.#inflight = { frame, commit };
    return frame;
  }
  next(): KeyedStreamMessage<Row, Meta, Key> | null {
    if (this.#inflight) {
      if (!this.#retry) return null;
      this.#retry = false;
      return this.#inflight.frame;
    }
    if (this.#reset) {
      this.#reset = false;
      const prior = new Map(this.#sent);
      const ids = new Set(this.#options.ids());
      // Carry pending closes through the snapshot so its first change can close them durably.
      for (const id of this.#dirty) if (prior.has(id)) ids.add(id);
      const prefix = this.#prefix;
      this.#prefix = null;
      this.#snapshot = {
        ids: [...ids].filter((id) => prefix === null || !prior.has(id)),
        cursor: 0,
        phase: "begin",
        prior,
        prefix,
      };
    }
    const snapshot = this.#snapshot;
    if (snapshot?.phase === "begin")
      return this.#offer(
        {
          op: "begin",
          generation: this.#generation,
          ...(snapshot.prefix === null ? {} : { prefix: snapshot.prefix }),
        },
        () => {
          if (snapshot.prefix === null) this.#sent.clear();
          this.#meta = null;
          snapshot.phase = "rows";
        },
      );
    if (snapshot?.phase === "rows") {
      const rows: Row[] = [];
      let cursor = snapshot.cursor;
      let bytes = keyedStreamBytes({ op: "rows", rows: [] }) + this.#options.envelopeBytes;
      while (cursor < snapshot.ids.length) {
        const id = snapshot.ids[cursor]!;
        const row =
          this.#options.read(id) ?? (this.#dirty.has(id) ? snapshot.prior.get(id) : undefined);
        if (!row) {
          cursor++;
          continue;
        }
        const size = keyedStreamBytes(row) + (rows.length ? 1 : 0);
        if (rows.length && bytes + size > this.#options.targetBytes) break;
        bytes += size;
        rows.push(row);
        cursor++;
      }
      if (rows.length)
        return this.#offer({ op: "rows", rows }, () => {
          snapshot.cursor = cursor;
          for (const row of rows) this.#sent.set(row[this.#key], row);
        });
      snapshot.phase = "end";
    }
    if (snapshot?.phase === "end") {
      const meta = this.#options.meta();
      this.#metaDirty = false;
      return this.#offer(
        { op: "end", revision: this.#revision, count: this.#sent.size, meta },
        () => {
          this.#meta = meta;
          this.#snapshot = null;
        },
      );
    }
    const frame: Extract<KeyedStreamMessage<Row, Meta, Key>, { op: "change" }> = {
      op: "change",
      generation: this.#generation,
      base: this.#revision,
      revision: this.#revision + 1,
    };
    const accepted = new Map<string, Row | undefined>();
    let bytes = keyedStreamBytes(frame) + this.#options.envelopeBytes;
    for (const id of this.#dirty) {
      const row = this.#options.read(id),
        before = this.#sent.get(id);
      if (row === before || (row && before && equal(row, before))) {
        this.#dirty.delete(id);
        continue;
      }
      const replace = row && before && Object.keys(before).some((key) => !Object.hasOwn(row, key));
      const operation = !row ? "remove" : !before || replace ? "add" : "update";
      const entry = !row
        ? id
        : !before || replace
          ? row
          : ({ ...patch(before, row), [this.#key]: id } as {
              [K in Exclude<keyof Row, Key>]?: Row[K] | undefined;
            } & Record<Key, string>);
      const size =
        keyedStreamBytes(entry) +
        (frame[operation] ? 1 : keyedStreamBytes({ [operation]: [] }) - 1);
      if (accepted.size && bytes + size > this.#options.targetBytes) break;
      if (!row) (frame.remove ??= []).push(id);
      else if (!before || replace) (frame.add ??= []).push(row);
      else
        (frame.update ??= []).push({ ...patch(before, row), [this.#key]: id } as {
          [K in Exclude<keyof Row, Key>]?: Row[K] | undefined;
        } & Record<Key, string>);
      bytes += size;
      accepted.set(id, row);
    }
    if (this.#metaDirty && this.#meta) {
      const meta = patch(this.#meta, this.#options.meta());
      if (Object.keys(meta).length) {
        const candidate = { ...frame, meta };
        if (!accepted.size || this.#fits(candidate)) frame.meta = meta;
      } else this.#metaDirty = false;
    }
    if (!accepted.size && !frame.meta) return null;
    const offered = this.#offer(frame, () => {
      for (const [id, row] of accepted) {
        if (row) this.#sent.set(id, row);
        else this.#sent.delete(id);
      }
      if (frame.meta && this.#meta) this.#meta = { ...this.#meta, ...frame.meta };
      this.#revision = frame.revision;
    });
    for (const id of accepted.keys()) this.#dirty.delete(id);
    if (frame.meta) this.#metaDirty = false;
    return offered;
  }
  settled(frame: KeyedStreamMessage<Row, Meta, Key>, ok: boolean): void {
    if (this.#inflight?.frame !== frame) throw new Error("Unknown keyed stream frame.");
    if (!ok) {
      this.#retry = true;
      return;
    }
    this.#inflight.commit();
    this.#inflight = null;
  }
}

export class KeyedStreamReceiver<
  Row extends Record<Key, string>,
  Meta extends object,
  Key extends string = "id",
> {
  readonly #key: Key;
  constructor(options: { key?: Key } = {}) {
    this.#key = options.key ?? ("id" as Key);
  }
  #rows = new Map<string, Row>();
  #meta: Meta | null = null;
  #state: "empty" | "assembling" | "committed" | "resyncing" = "empty";
  #generation: string | null = null;
  #revision = 0;
  #staged: Map<string, Row> | null = null;
  readonly #listeners = new Set<(changed: KeyedStreamChanges) => void>();
  get rows(): ReadonlyMap<string, Row> {
    return this.#rows;
  }
  get meta(): Meta | null {
    return this.#meta;
  }
  get state() {
    return this.#state;
  }
  seed(rows: readonly Row[], meta: Meta): void {
    const changed = this.#replace(rows);
    this.#meta = meta;
    this.#state = "empty";
    this.#staged = null;
    this.#generation = null;
    for (const listener of this.#listeners) listener(changed);
  }
  stale(): void {
    this.#state = "resyncing";
    this.#staged = null;
  }
  #replace(rows: Iterable<Row>): KeyedStreamChanges {
    const changed: KeyedStreamChanges = { added: [], updated: [], removed: [], structural: false };
    const next = new Map<string, Row>();
    for (const row of rows) {
      const before = this.#rows.get(row[this.#key]);
      if (before && equal(before, row)) next.set(row[this.#key], before);
      else {
        next.set(row[this.#key], row);
        if (!before) changed.added.push(row[this.#key]);
        else {
          changed.updated.push(row[this.#key]);
          changed.structural ||= Reflect.get(before, "order") !== Reflect.get(row, "order");
        }
      }
    }
    for (const id of this.#rows.keys()) if (!next.has(id)) changed.removed.push(id);
    changed.structural ||= changed.added.length > 0 || changed.removed.length > 0;
    this.#rows = next;
    return changed;
  }
  onChange(listener: (changed: KeyedStreamChanges) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #gap(): "resync" | "staged" {
    const requested = this.#state === "resyncing";
    this.#state = "resyncing";
    this.#staged = null;
    return requested ? "staged" : "resync";
  }
  apply(message: KeyedStreamMessage<Row, Meta, Key>): "applied" | "staged" | "resync" {
    if (message.op === "begin") {
      if (
        message.prefix !== undefined &&
        (this.#state !== "empty" || message.prefix !== this.#rows.size)
      )
        return this.#gap();
      this.#generation = message.generation;
      this.#staged = message.prefix === undefined ? new Map() : new Map(this.#rows);
      this.#state = "assembling";
      return "staged";
    }
    if (this.#state === "resyncing") return "staged";
    if (message.op === "rows") {
      if (!this.#staged) return this.#gap();
      for (const row of message.rows) {
        if (this.#staged.has(row[this.#key])) return this.#gap();
        this.#staged.set(row[this.#key], row);
      }
      return "staged";
    }
    let changed: KeyedStreamChanges = { added: [], updated: [], removed: [], structural: false };
    const put = (row: Row) => {
      const before = this.#rows.get(row[this.#key]);
      if (before && equal(before, row)) return before;
      if (!before) {
        changed.added.push(row[this.#key]);
        changed.structural = true;
      } else {
        changed.updated.push(row[this.#key]);
        if (Reflect.get(before, "order") !== Reflect.get(row, "order")) changed.structural = true;
      }
      return row;
    };
    if (message.op === "end") {
      if (!this.#staged || message.count !== this.#staged.size) return this.#gap();
      changed = this.#replace(this.#staged.values());
      this.#staged = null;
      this.#meta = message.meta;
    } else {
      if (
        this.#state !== "committed" ||
        message.generation !== this.#generation ||
        message.base !== this.#revision ||
        message.revision !== message.base + 1 ||
        !Number.isSafeInteger(message.revision)
      )
        return this.#gap();
      for (const row of message.add ?? []) this.#rows.set(row[this.#key], put(row));
      for (const update of message.update ?? []) {
        const before = this.#rows.get(update[this.#key]);
        if (before)
          this.#rows.set(
            update[this.#key],
            put({ ...before, ...update, [this.#key]: before[this.#key] }),
          );
      }
      for (const id of message.remove ?? []) if (this.#rows.delete(id)) changed.removed.push(id);
      changed.structural ||= changed.removed.length > 0;
      if (message.meta && this.#meta) this.#meta = { ...this.#meta, ...message.meta };
    }
    this.#revision = message.revision;
    this.#state = "committed";
    for (const listener of this.#listeners) listener(changed);
    return "applied";
  }
}
