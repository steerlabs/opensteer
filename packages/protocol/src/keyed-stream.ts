import { z } from "zod";

export const keyedStreamHardCapBytes = 256 * 1024;
const Revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Generation = z.string().min(1).max(64);

export function keyedStreamSchema<
  Row extends z.ZodRawShape & { id: z.ZodType<string> },
  Meta extends z.ZodRawShape,
>(row: z.ZodObject<Row>, meta: z.ZodObject<Meta>) {
  return z.discriminatedUnion("op", [
    z.strictObject({ op: z.literal("begin"), generation: Generation }),
    z.strictObject({ op: z.literal("rows"), rows: z.array(row).min(1) }),
    z.strictObject({ op: z.literal("end"), revision: Revision, count: Revision, meta }),
    z.strictObject({
      op: z.literal("change"),
      generation: Generation,
      base: Revision,
      revision: Revision,
      add: z.array(row).optional(),
      update: z.array(row.partial().extend({ id: row.shape.id })).optional(),
      remove: z.array(row.shape.id).optional(),
      meta: meta.partial().optional(),
    }),
  ]);
}

export type KeyedStreamMessage<Row extends { id: string }, Meta extends object> =
  | { op: "begin"; generation: string }
  | { op: "rows"; rows: Row[] }
  | { op: "end"; revision: number; count: number; meta: Meta }
  | {
      op: "change";
      generation: string;
      base: number;
      revision: number;
      add?: Row[] | undefined;
      update?:
        ({ [K in Exclude<keyof Row, "id">]?: Row[K] | undefined } & { id: string })[] | undefined;
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
function equal(left: unknown, right: unknown): boolean {
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

interface PublisherOptions<Row, Meta> {
  ids(): Iterable<string>;
  read(id: string): Row | undefined;
  meta(): Meta;
  targetBytes: number;
  envelopeBytes: number;
  generation?: string;
}
export class KeyedStreamPublisher<Row extends { id: string }, Meta extends object> {
  readonly #options: PublisherOptions<Row, Meta>;
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
  } | null = null;
  #reset = true;
  #inflight: { frame: KeyedStreamMessage<Row, Meta>; commit(): void } | null = null;
  #retry = false;
  constructor(options: PublisherOptions<Row, Meta>) {
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
        ? frame.rows.some((row) => row.id === id)
        : frame?.op === "change" &&
          ([...(frame.add ?? []), ...(frame.update ?? [])].some((row) => row.id === id) ||
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
  #fits(frame: KeyedStreamMessage<Row, Meta>, target = this.#options.targetBytes): boolean {
    return keyedStreamBytes(frame) + this.#options.envelopeBytes <= target;
  }
  #offer(frame: KeyedStreamMessage<Row, Meta>, commit: () => void): KeyedStreamMessage<Row, Meta> {
    if (!this.#fits(frame, keyedStreamHardCapBytes))
      throw new Error("Keyed stream record exceeds the hard byte cap.");
    this.#inflight = { frame, commit };
    return frame;
  }
  next(): KeyedStreamMessage<Row, Meta> | null {
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
      this.#snapshot = { ids: [...ids], cursor: 0, phase: "begin", prior };
    }
    const snapshot = this.#snapshot;
    if (snapshot?.phase === "begin")
      return this.#offer({ op: "begin", generation: this.#generation }, () => {
        this.#sent.clear();
        this.#meta = null;
        snapshot.phase = "rows";
      });
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
          for (const row of rows) this.#sent.set(row.id, row);
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
    const frame: Extract<KeyedStreamMessage<Row, Meta>, { op: "change" }> = {
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
      const operation = !row ? "remove" : !before ? "add" : "update";
      const entry = !row ? id : !before ? row : { ...patch(before, row), id };
      const size =
        keyedStreamBytes(entry) +
        (frame[operation] ? 1 : keyedStreamBytes({ [operation]: [] }) - 1);
      if (accepted.size && bytes + size > this.#options.targetBytes) break;
      if (!row) (frame.remove ??= []).push(id);
      else if (!before) (frame.add ??= []).push(row);
      else (frame.update ??= []).push({ ...patch(before, row), id });
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
  settled(frame: KeyedStreamMessage<Row, Meta>, ok: boolean): void {
    if (this.#inflight?.frame !== frame) throw new Error("Unknown keyed stream frame.");
    if (!ok) {
      this.#retry = true;
      return;
    }
    this.#inflight.commit();
    this.#inflight = null;
  }
}

export class KeyedStreamReceiver<Row extends { id: string }, Meta extends object> {
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
    this.#rows = new Map(rows.map((row) => [row.id, row]));
    this.#meta = meta;
    this.#state = "empty";
    this.#staged = null;
    this.#generation = null;
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
  apply(message: KeyedStreamMessage<Row, Meta>): "applied" | "staged" | "resync" {
    if (message.op === "begin") {
      this.#generation = message.generation;
      this.#staged = new Map();
      this.#state = "assembling";
      return "staged";
    }
    if (this.#state === "resyncing") return "staged";
    if (message.op === "rows") {
      if (!this.#staged) return this.#gap();
      for (const row of message.rows) {
        if (this.#staged.has(row.id)) return this.#gap();
        this.#staged.set(row.id, row);
      }
      return "staged";
    }
    const changed: KeyedStreamChanges = { added: [], updated: [], removed: [], structural: false };
    const put = (row: Row) => {
      const before = this.#rows.get(row.id);
      if (before && equal(before, row)) return before;
      if (!before) {
        changed.added.push(row.id);
        changed.structural = true;
      } else {
        changed.updated.push(row.id);
        if (Reflect.get(before, "order") !== Reflect.get(row, "order")) changed.structural = true;
      }
      return row;
    };
    if (message.op === "end") {
      if (!this.#staged || message.count !== this.#staged.size) return this.#gap();
      const next = new Map<string, Row>();
      for (const row of this.#staged.values()) next.set(row.id, put(row));
      for (const id of this.#rows.keys()) if (!next.has(id)) changed.removed.push(id);
      changed.structural ||= changed.removed.length > 0;
      this.#rows = next;
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
      for (const row of message.add ?? []) this.#rows.set(row.id, put(row));
      for (const update of message.update ?? []) {
        const before = this.#rows.get(update.id);
        if (before) this.#rows.set(update.id, put({ ...before, ...update, id: before.id }));
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
