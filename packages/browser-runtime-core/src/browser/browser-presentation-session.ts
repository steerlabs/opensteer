import { validateBrowserH264 } from "@opensteer/protocol";
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
  }): Promise<{ producerStreamId: string; capacity: z.infer<typeof BrowserVideoCapacitySchema> }>;
  budget(budget: BrowserVideoBudget): Promise<void>;
  keyframe(): Promise<void>;
  /** Transfers the publication hold to these opaque Host viewer slots before returning credit. */
  ack(sequence: string, retainFor: readonly string[]): Promise<void>;
  hold(slot: string, reference: BrowserPresentationRef): Promise<void>;
  presented(slot: string, reference: BrowserPresentationRef): Promise<void>;
  recover(slot: string, through: number): Promise<void>;
  release(slot: string): Promise<void>;
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
  readonly #offers = new Map<string, Set<number>>();
  readonly #current = new Map<string, number>();
  readonly #pending = new Set<number>();
  readonly #releasedSlots = new Set<string>();
  readonly #retiredOffers = new Map<string, number>();
  readonly #admissions = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  readonly #gestures = new Map<
    string,
    { sequence: number; held: Promise<void>; claimed: boolean }
  >();
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
              generation: browserVideoCounter(frame.generation),
              sequence: browserVideoCounter(frame.sequence),
              ptsUs: browserVideoCounter(frame.ptsUs),
              key: frame.key,
              ...(frame.codec ? { codec: frame.codec } : {}),
              width: frame.width,
              height: frame.height,
              presentation,
            });
            validateBrowserH264(frame.payload, header);
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
            const admission = Promise.withResolvers<void>();
            void admission.promise.catch(() => undefined);
            this.#admissions.set(header.sequence, admission);
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
  async ack(sequence: number, requested: readonly string[]): Promise<void> {
    const retainFor = requested.filter(
      (slot) =>
        !this.#releasedSlots.has(slot) &&
        (sequence > (this.#retiredOffers.get(slot) ?? -1) ||
          [...this.#current].some(
            ([key, seq]) =>
              seq === sequence && (key === slot || key.startsWith(`${slot}:gesture:`)),
          )),
    );
    this.#live();
    if (
      this.#pending.values().next().value !== sequence ||
      retainFor.length > 8 ||
      new Set(retainFor).size !== retainFor.length
    )
      throw new Error("Invalid browser source admission.");
    for (const slot of retainFor) {
      let offered = this.#offers.get(slot);
      if (!offered) {
        if (this.#offers.size >= 8) throw new Error("Too many browser presentation slots.");
        this.#offers.set(slot, (offered = new Set()));
      }
      if (offered.size >= 4) throw new Error("Browser presentation offers exceeded capacity.");
    }
    // Native transfer happens before source credit is returned or JS metadata is released.
    await this.#port.ack(String(sequence), retainFor);
    if (this.#closed) return;
    for (const slot of retainFor) this.#offers.get(slot)!.add(sequence);
    this.#admissions.get(sequence)?.resolve();
    for (const seq of this.#pending) {
      if (seq > sequence) break;
      this.#pending.delete(seq);
    }
    this.#collect();
  }
  async presented(slot: string, ref: BrowserPresentationRef): Promise<void> {
    this.#live();
    await this.#admissions.get(ref.sequence)?.promise;
    const frame = this.#resolve(ref);
    const offered = this.#offers.get(slot);
    if (!offered?.has(frame.sequence))
      throw new Error("Browser picture was not offered to this viewer.");
    await this.#port.presented(slot, ref);
    if (this.#closed) return;
    this.#current.set(slot, frame.sequence);
    for (const seq of offered) if (seq <= frame.sequence) offered.delete(seq);
    this.#collect();
  }
  async release(slot: string): Promise<void> {
    if (this.#releasedSlots.has(slot)) return;
    if (this.#releasedSlots.size >= 128) {
      await this.stop();
      this.#notifyStopped("capacity");
      return;
    }
    this.#releasedSlots.add(slot);
    this.#offers.delete(slot);
    this.#current.delete(slot);
    const gestures = [...this.#gestures].filter(([key]) => key.startsWith(`${slot}:gesture:`));
    for (const [key, gesture] of gestures) {
      this.#gestures.delete(key);
      this.#current.delete(key);
      await gesture.held.catch(() => undefined);
      if (!this.#closed) await this.#port.release(key);
    }
    this.#collect();
    if (!this.#closed) await this.#port.release(slot);
  }
  async recover(slot: string, through: number): Promise<void> {
    this.#live();
    this.#retiredOffers.set(slot, Math.max(through, this.#retiredOffers.get(slot) ?? -1));
    const offered = this.#offers.get(slot);
    if (offered)
      for (const seq of offered)
        if (
          seq <= through &&
          this.#current.get(slot) !== seq &&
          ![...this.#gestures].some(
            ([key, g]) => key.startsWith(`${slot}:gesture:`) && g.sequence === seq,
          )
        )
          offered.delete(seq);
    await this.#port.recover(slot, through);
    this.#collect();
  }
  async gesture(
    slot: string,
    id: string,
    reference: BrowserPresentationRef,
    phase: "begin" | "cancel",
  ): Promise<void> {
    const key = `${slot}:gesture:${id}`;
    if (phase === "cancel") {
      const gesture = this.#gestures.get(key);
      if (gesture?.claimed) return;
      this.#gestures.delete(key);
      this.#current.delete(key);
      this.#collect();
      if (gesture) {
        await gesture.held;
        await this.#port.release(key);
      }
      return;
    }
    this.#live();
    const frame = this.#resolve(reference);
    if (
      this.#gestures.has(key) ||
      [...this.#gestures.keys()].some((k) => k.startsWith(`${slot}:gesture:`))
    )
      throw new Error("Browser gesture pin is unavailable.");
    this.#current.set(key, frame.sequence);
    const held = (async () => {
      await this.#admissions.get(frame.sequence)?.promise;
      this.#live();
      if (
        !this.#offers.get(slot)?.has(frame.sequence) &&
        this.#current.get(slot) !== frame.sequence
      )
        throw new Error("Browser picture was not offered to this viewer.");
      await this.#port.hold(key, reference);
    })();
    this.#gestures.set(key, { sequence: frame.sequence, held, claimed: false });
    try {
      await held;
    } catch (error) {
      this.#gestures.delete(key);
      this.#current.delete(key);
      this.#collect();
      throw error;
    }
  }
  async click(
    slot: string,
    gestureId: string,
    ref: BrowserPresentationRef,
    point: { x: number; y: number },
    modifiers: number,
  ): Promise<{ dispatched: boolean }> {
    this.#live();
    const key = `${slot}:gesture:${gestureId}`;
    const gesture = this.#gestures.get(key);
    if (!gesture || gesture.claimed || gesture.sequence !== ref.sequence)
      throw new Error("Browser gesture was not retained at touch start.");
    gesture.claimed = true;
    try {
      await gesture.held;
      const header = this.#resolve(ref);
      const rootCssPoint = browserVideoRootPoint(header, point);
      if (this.#gesture >= Number.MAX_SAFE_INTEGER)
        throw new Error("Browser gesture sequence exhausted.");
      // Claim before the asynchronous native call; cancellation cannot release its pin early.
      const seq = String(++this.#gesture);
      return await this.#port.click({ reference: ref, seq, rootCssPoint, modifiers });
    } finally {
      gesture.claimed = false;
      await this.gesture(slot, gestureId, ref, "cancel");
    }
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
  #resolve(ref: BrowserPresentationRef): BrowserVideoFrameHeader {
    const h = this.#frames.get(ref.sequence);
    if (!h || !sameBrowserPresentation(browserPresentationRef(h), ref))
      throw new Error("Browser presentation certificate is unavailable.");
    return h;
  }
  #live(): void {
    if (this.#closed || !this.#streamId) throw new Error("Browser presentation ended.");
  }
  #clear(): void {
    this.#frames.clear();
    this.#offers.clear();
    this.#current.clear();
    this.#pending.clear();
    this.#gestures.clear();
    for (const admission of this.#admissions.values())
      admission.reject(new Error("Browser presentation ended."));
    this.#admissions.clear();
  }
  #collect(): void {
    const retained = new Set([
      ...this.#pending,
      ...this.#current.values(),
      ...[...this.#offers.values()].flatMap((set) => [...set]),
    ]);
    for (const seq of this.#frames.keys())
      if (!retained.has(seq)) {
        this.#frames.delete(seq);
        this.#admissions.delete(seq);
      }
  }
}
