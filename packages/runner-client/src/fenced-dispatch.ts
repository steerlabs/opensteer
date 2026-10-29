import {
  RunnerAuxiliaryFrameFenceSchema,
  RunnerAuxiliaryLeaseRenewedSchema,
  type RunnerAuxiliaryFrameFence,
  type RunnerAuxiliaryLeaseRenewed,
} from "@opensteer/protocol";

export interface FencedInboundDispatchOptions<Message, Fence> {
  readonly accepts: (fence: Fence) => boolean;
  readonly fence: (message: Message) => Fence;
  readonly handle: (message: Message, signal: AbortSignal) => Promise<void>;
}

export interface InboundAuxiliaryFrame {
  readonly fence: RunnerAuxiliaryFrameFence;
  readonly frame: Buffer;
  readonly renewal: RunnerAuxiliaryLeaseRenewed | undefined;
}

export function parseInboundAuxiliaryFrame(
  frame: Buffer,
  isBinary: boolean,
): InboundAuxiliaryFrame {
  if (isBinary) throw new Error("The Host module stream carries JSON only");
  let input: unknown;
  try {
    input = JSON.parse(frame.toString("utf8"));
  } catch (error) {
    throw new Error("The Host module frame is not valid JSON", { cause: error });
  }
  const renewal = RunnerAuxiliaryLeaseRenewedSchema.safeParse(input);
  return {
    fence: renewal.success
      ? renewal.data
      : RunnerAuxiliaryFrameFenceSchema.passthrough().parse(input),
    frame,
    renewal: renewal.success ? renewal.data : undefined,
  };
}

/** Serializes one authenticated stream and refuses work for any other fence. */
export class FencedInboundDispatcher<Message, Fence> {
  readonly #accepts: FencedInboundDispatchOptions<Message, Fence>["accepts"];
  readonly #fence: FencedInboundDispatchOptions<Message, Fence>["fence"];
  readonly #handle: FencedInboundDispatchOptions<Message, Fence>["handle"];
  readonly #stop = new AbortController();
  #closed = false;
  #tail = Promise.resolve();

  constructor(options: FencedInboundDispatchOptions<Message, Fence>) {
    this.#accepts = options.accepts;
    this.#fence = options.fence;
    this.#handle = options.handle;
  }

  dispatch(message: Message): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("The inbound stream is closed"));
    const handled = this.#tail.then(async () => {
      this.#stop.signal.throwIfAborted();
      if (!this.#accepts(this.#fence(message))) {
        throw new Error("The Host frame carried a stale connection fence");
      }
      await this.#handle(message, this.#stop.signal);
    });
    this.#tail = handled.catch(() => undefined);
    return handled;
  }

  async abortAndDrain(reason: Error): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      this.#stop.abort(reason);
    }
    await this.#tail;
  }
}
