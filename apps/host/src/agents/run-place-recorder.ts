import { placeIdentityKey, type AgentEvent, type EventData, type RunId } from "@opensteer/core";

interface RunPlaceWrite {
  readonly runId: RunId;
  readonly bindingGeneration: number;
  readonly data: EventData<"place.entered">;
}

/** One lane for browser and native activity; the database owns the Run fence and dedup. */
export class RunPlaceRecorder {
  readonly #write: (input: RunPlaceWrite) => Promise<AgentEvent | undefined>;
  readonly #publish: (event: AgentEvent) => void;
  readonly #onError: (error: unknown) => void;
  #closed = false;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #admissions = new Map<
    string,
    { readonly generation: number; next: number; completed: number }
  >();
  readonly #last = new Map<string, { readonly generation: number; readonly key: string }>();

  constructor(options: {
    readonly write: (input: RunPlaceWrite) => Promise<AgentEvent | undefined>;
    readonly publish: (event: AgentEvent) => void;
    readonly onError: (error: unknown) => void;
  }) {
    this.#write = options.write;
    this.#publish = options.publish;
    this.#onError = options.onError;
  }

  /** Native calls reserve order at admission, then enter only after a successful answer. */
  begin(runId: RunId, bindingGeneration: number): (data: EventData<"place.entered">) => void {
    if (this.#closed) return () => undefined;
    let admissions = this.#admissions.get(runId);
    if (admissions && admissions.generation > bindingGeneration) return () => undefined;
    if (!admissions || admissions.generation !== bindingGeneration) {
      admissions = { generation: bindingGeneration, next: 0, completed: 0 };
      this.#admissions.set(runId, admissions);
    }
    const ordinal = ++admissions.next;
    return (data) => {
      if (this.#admissions.get(runId) !== admissions || ordinal <= admissions.completed) return;
      admissions.completed = ordinal;
      const key = placeIdentityKey(data.place);
      const previous = this.#last.get(runId);
      if (previous?.generation === bindingGeneration && previous.key === key) return;
      const last = { generation: bindingGeneration, key };
      this.#last.set(runId, last);
      const tail = (this.#tails.get(runId) ?? Promise.resolve())
        .then(async () => {
          const event = await this.#write({ runId, bindingGeneration, data });
          if (event) this.#publish(event);
        })
        .catch((error: unknown) => {
          if (this.#last.get(runId) === last) this.#last.delete(runId);
          this.#onError(error);
        });
      this.#tails.set(runId, tail);
      void tail.finally(() => {
        if (this.#tails.get(runId) === tail) this.#tails.delete(runId);
      });
    };
  }

  enter(runId: RunId, bindingGeneration: number, data: EventData<"place.entered">): void {
    this.begin(runId, bindingGeneration)(data);
  }

  async drain(runId: string): Promise<void> {
    await this.#tails.get(runId);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#admissions.clear();
    await Promise.all(this.#tails.values());
    this.#last.clear();
  }

  forget(runId: string): void {
    this.#admissions.delete(runId);
    this.#last.delete(runId);
  }
}
