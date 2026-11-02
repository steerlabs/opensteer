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
  readonly #tickets = new Map<string, object>();
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
    const ticket = {};
    this.#tickets.set(runId, ticket);
    return (data) => {
      if (this.#tickets.get(runId) !== ticket) return;
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
    this.#tickets.clear();
    await Promise.all(this.#tails.values());
    this.#last.clear();
  }

  forget(runId: string): void {
    this.#tickets.delete(runId);
    this.#last.delete(runId);
  }
}
