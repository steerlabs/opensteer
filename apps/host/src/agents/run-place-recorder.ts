import { systemClock, type Clock } from "@opensteer/shared/clock";
import { placeIdentityKey, type AgentEvent, type EventData, type RunId } from "@opensteer/core";

interface RunPlaceWrite {
  readonly runId: RunId;
  readonly bindingGeneration: number;
  readonly data: EventData<"place.entered">;
}

/** Called once a place is where the Run is, with when it got there and whether it was coalesced. */
export type RunPlaceSettled = (at: number, coalesced: boolean) => Promise<void>;

interface RunPlaceEntry {
  readonly input: RunPlaceWrite;
  readonly settled: RunPlaceSettled | undefined;
}

/** A Run moves at most this often in its history; the latest place always lands. */
const runPlaceIntervalMs = 1000;

/** One lane for browser and native activity; the database owns the Run fence and dedup. */
export class RunPlaceRecorder {
  readonly #write: (input: RunPlaceWrite) => Promise<AgentEvent | undefined>;
  readonly #publish: (event: AgentEvent) => void;
  readonly #onError: (error: unknown) => void;
  readonly #clock: Clock;
  readonly #pending = new Map<string, RunPlaceEntry & { readonly cancel: () => void }>();
  #closed = false;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #admissions = new Map<
    string,
    { readonly generation: number; next: number; completed: number }
  >();
  readonly #last = new Map<
    string,
    { readonly generation: number; readonly key: string; readonly at: number }
  >();

  constructor(options: {
    readonly write: (input: RunPlaceWrite) => Promise<AgentEvent | undefined>;
    readonly publish: (event: AgentEvent) => void;
    readonly onError: (error: unknown) => void;
    readonly clock?: Clock;
  }) {
    this.#write = options.write;
    this.#publish = options.publish;
    this.#onError = options.onError;
    this.#clock = options.clock ?? systemClock;
  }

  /** Native calls reserve order at admission, then enter only after a successful answer. */
  begin(
    runId: RunId,
    bindingGeneration: number,
  ): (data: EventData<"place.entered">, settled?: RunPlaceSettled) => void {
    if (this.#closed) return () => undefined;
    let admissions = this.#admissions.get(runId);
    if (admissions && admissions.generation > bindingGeneration) return () => undefined;
    if (!admissions || admissions.generation !== bindingGeneration) {
      this.#cancelPending(runId);
      admissions = { generation: bindingGeneration, next: 0, completed: 0 };
      this.#admissions.set(runId, admissions);
    }
    const ordinal = ++admissions.next;
    return (data, settled) => {
      if (this.#admissions.get(runId) !== admissions || ordinal <= admissions.completed) return;
      admissions.completed = ordinal;
      const entry = { input: { runId, bindingGeneration, data }, settled };
      const previous = this.#last.get(runId);
      const pending = this.#pending.get(runId);
      this.#cancelPending(runId);
      if (previous?.generation === bindingGeneration) {
        if (previous.key === placeIdentityKey(data.place) && !pending) return;
        const remaining = previous.at + runPlaceIntervalMs - this.#clock.now();
        if (remaining > 0) {
          const cancel = this.#clock.schedule(() => this.#flushPending(runId), remaining);
          this.#pending.set(runId, { ...entry, cancel });
          return;
        }
      }
      this.#enqueue(entry, Boolean(pending));
    };
  }

  #cancelPending(runId: string): void {
    this.#pending.get(runId)?.cancel();
    this.#pending.delete(runId);
  }

  #flushPending(runId: string): void {
    const pending = this.#pending.get(runId);
    this.#cancelPending(runId);
    if (!pending || this.#admissions.get(runId)?.generation !== pending.input.bindingGeneration)
      return;
    this.#enqueue(pending, true);
  }

  #enqueue({ input, settled }: RunPlaceEntry, coalesced: boolean): void {
    const { runId, bindingGeneration, data } = input;
    const last = {
      generation: bindingGeneration,
      key: placeIdentityKey(data.place),
      at: this.#clock.now(),
    };
    const previous = this.#last.get(runId);
    const unchanged = previous?.generation === bindingGeneration && previous.key === last.key;
    if (!unchanged) this.#last.set(runId, last);
    const tail = (this.#tails.get(runId) ?? Promise.resolve())
      .then(async () => {
        // A failed write forgets its place, so a later entry of it writes it after all.
        if (unchanged && this.#last.has(runId)) {
          if (coalesced) await settled?.(last.at, coalesced);
          return;
        }
        if (unchanged) this.#last.set(runId, last);
        const event = await this.#write(input);
        if (event) {
          this.#publish(event);
          await settled?.(last.at, coalesced);
        }
      })
      .catch((error: unknown) => {
        if (this.#last.get(runId) === last) this.#last.delete(runId);
        this.#onError(error);
      });
    this.#tails.set(runId, tail);
    void tail.finally(() => {
      if (this.#tails.get(runId) === tail) this.#tails.delete(runId);
    });
  }

  enter(
    runId: RunId,
    bindingGeneration: number,
    data: EventData<"place.entered">,
    settled?: RunPlaceSettled,
  ): void {
    this.begin(runId, bindingGeneration)(data, settled);
  }

  async drain(runId: string): Promise<void> {
    this.#flushPending(runId);
    await this.#tails.get(runId);
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const runId of this.#pending.keys()) this.#cancelPending(runId);
    this.#admissions.clear();
    await Promise.all(this.#tails.values());
    this.#last.clear();
  }

  forget(runId: string): void {
    this.#cancelPending(runId);
    this.#admissions.delete(runId);
    this.#last.delete(runId);
  }
}
