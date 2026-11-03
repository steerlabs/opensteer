import { z } from "zod";
import {
  BrowserPresentedFrameSchema,
  immutableBrowserVideoHeader,
  browserPresentationRef,
  browserVideoCounter,
  browserVideoRootPoint,
  sameBrowserPresentation,
  displayMaxFramePayloadBytes,
  displayMaxHeaderBytes,
  type BrowserPresentedFrame,
  type BrowserPresentationRef,
  type BrowserVideoBudget,
  type BrowserVideoCapacitySchema,
  type BrowserVideoFrameHeader,
  type DisplayStreamId,
} from "@opensteer/protocol";

/** Only the native owner implements this port. Ordinary CDP has no access to it. */
export interface BrowserPresentationPort {
  start(options: {
    budget: BrowserVideoBudget;
    creditWindow: number;
    onFrame(frame: BrowserProducerFrame): void;
    onStopped(reason: string): void;
  }): Promise<{ producerStreamId: string; capacity?: z.infer<typeof BrowserVideoCapacitySchema> }>;
  budget(budget: BrowserVideoBudget): Promise<void>;
  keyframe(): Promise<void>;
  ack(sequence: string): Promise<void>;
  click(input: {
    reference: BrowserPresentationRef;
    seq: string;
    rootCssPoint: { x: number; y: number };
    modifiers: number;
  }): Promise<{ dispatched: boolean }>;
  stop(): Promise<void>;
}
export interface BrowserProducerFrame {
  readonly generation: string;
  readonly sequence: string;
  readonly ptsUs: string;
  readonly key: boolean;
  readonly codec?: string;
  readonly width: number;
  readonly height: number;
  readonly presentation: BrowserPresentedFrame;
  readonly payload: Uint8Array;
}

/** One rendition and immutable metadata ledger per exact live page. */
export class BrowserPresentationSession {
  #closed = false;
  #streamId: DisplayStreamId | null = null;
  #producer: string | null = null;
  #sequence = -1;
  #generation = 0;
  #ptsUs = -1;
  #gesture = 0;
  #stopped: ((reason: string) => void) | null = null;
  readonly #frames = new Map<number, BrowserVideoFrameHeader>();
  readonly #pending = new Set<number>();
  readonly #clicks = new Set<string>();
  readonly #ready = Promise.withResolvers<void>();
  readonly #port: BrowserPresentationPort;
  constructor(port: BrowserPresentationPort) {
    this.#port = port;
    void this.#ready.promise.catch(() => undefined);
  }
  async start(
    streamId: DisplayStreamId,
    budget: BrowserVideoBudget,
    creditWindow: number,
    emit: (header: BrowserVideoFrameHeader, payload: Uint8Array) => void,
    stopped: (reason: string) => void,
    geometryRevision: () => number = () => 0,
  ) {
    if (this.#closed || this.#streamId) throw new Error("Browser presentation already started.");
    this.#streamId = streamId;
    this.#stopped = stopped;
    try {
      const result = await this.#port.start({
        budget,
        creditWindow,
        onStopped: (reason) => {
          if (this.#closed) return;
          this.#closed = true;
          this.#ready.reject(new Error("Browser producer ended."));
          this.#clear();
          this.#notifyStopped(reason);
        },
        onFrame: (frame) => {
          if (this.#closed) return;
          try {
            if (
              frame.payload.byteLength < 1 ||
              frame.payload.byteLength > displayMaxFramePayloadBytes
            )
              throw new Error("Invalid browser access unit size.");
            if (JSON.stringify(frame.presentation).length > displayMaxHeaderBytes)
              throw new Error("Invalid browser certificate size.");
            const presentation = BrowserPresentedFrameSchema.parse(frame.presentation);
            if (this.#producer !== null && presentation.producerStreamId !== this.#producer)
              throw new Error("Browser producer changed without replacement.");
            this.#producer = presentation.producerStreamId;
            const header = immutableBrowserVideoHeader({
              streamId,
              geometryRevision: geometryRevision(),
              generation: browserVideoCounter(frame.generation),
              sequence: browserVideoCounter(frame.sequence),
              ptsUs: browserVideoCounter(frame.ptsUs),
              key: frame.key,
              ...(frame.codec ? { codec: frame.codec } : {}),
              width: frame.width,
              height: frame.height,
              presentation,
            });
            if (
              header.sequence <= this.#sequence ||
              header.ptsUs <= this.#ptsUs ||
              (this.#sequence >= 0 && header.sequence !== this.#sequence + 1) ||
              header.generation < this.#generation ||
              (header.generation !== this.#generation && !header.key)
            )
              throw new Error("Browser video reference chain is discontinuous.");
            this.#ptsUs = header.ptsUs;
            this.#sequence = header.sequence;
            this.#generation = header.generation;
            if (this.#pending.size >= creditWindow)
              throw new Error("Browser source exceeded admission credit.");
            this.#frames.set(header.sequence, header);
            this.#pending.add(header.sequence);
            if (this.#frames.size > 128) this.#frames.delete(this.#frames.keys().next().value!);
            emit(header, frame.payload);
          } catch {
            void this.stop()
              .finally(() => this.#notifyStopped("protocol"))
              .catch(() => undefined);
          }
        },
      });
      if (this.#closed || (this.#producer && result.producerStreamId !== this.#producer))
        throw new Error("Browser presentation ended during startup.");
      this.#producer = result.producerStreamId;
      this.#ready.resolve();
      return result;
    } catch (error) {
      this.#ready.reject(error);
      await this.stop();
      throw error;
    }
  }
  async budget(budget: BrowserVideoBudget): Promise<void> {
    await this.#ready.promise;
    this.#live();
    await this.#port.budget(budget);
  }
  async keyframe(): Promise<void> {
    await this.#ready.promise;
    this.#live();
    await this.#port.keyframe();
  }
  async ack(sequence: number): Promise<void> {
    this.#live();
    if (!this.#pending.has(sequence)) throw new Error("Invalid browser source admission.");
    await this.#port.ack(String(sequence));
    for (const seq of this.#pending) {
      if (seq > sequence) break;
      this.#pending.delete(seq);
    }
  }
  async click(
    slot: string,
    gestureId: string,
    ref: BrowserPresentationRef,
    point: { x: number; y: number },
    modifiers: number,
  ): Promise<{ dispatched: boolean }> {
    const key = `${slot}:${gestureId}`;
    const header = this.#frames.get(ref.sequence);
    if (
      this.#closed ||
      !header ||
      !sameBrowserPresentation(browserPresentationRef(header), ref) ||
      this.#clicks.has(key)
    )
      return { dispatched: false };
    let rootCssPoint: { x: number; y: number };
    try {
      rootCssPoint = browserVideoRootPoint(header, point);
    } catch {
      return { dispatched: false };
    }
    if (this.#gesture >= Number.MAX_SAFE_INTEGER) return { dispatched: false };
    this.#clicks.add(key);
    if (this.#clicks.size > 128) this.#clicks.delete(this.#clicks.values().next().value!);
    return this.#port.click({
      reference: ref,
      seq: String(++this.#gesture),
      rootCssPoint,
      modifiers,
    });
  }
  resolvePoint(
    x: number,
    y: number,
    width: number,
    height: number,
    geometry: number | undefined,
  ): { x: number; y: number } | null {
    const h = this.#frames.get(this.#sequence);
    if (
      this.#closed ||
      !h ||
      h.geometryRevision !== geometry ||
      h.presentation.rootCssWidth !== width ||
      h.presentation.rootCssHeight !== height
    )
      return null;
    return { x: x * width, y: y * height };
  }
  async stop(): Promise<void> {
    this.#ready.reject(new Error("Browser presentation ended."));
    if (this.#closed) return;
    this.#closed = true;
    this.#clear();
    await this.#port.stop();
  }
  #notifyStopped(reason: string): void {
    const notify = this.#stopped;
    this.#stopped = null;
    notify?.(reason);
  }
  #live(): void {
    if (this.#closed || !this.#streamId) throw new Error("Browser presentation ended.");
  }
  #clear(): void {
    this.#frames.clear();
    this.#pending.clear();
    this.#clicks.clear();
  }
}
