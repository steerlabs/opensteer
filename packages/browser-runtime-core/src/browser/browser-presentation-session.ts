import {
  sameInputBinding,
  samePopup,
  validatePopupAnswer,
  type BrowserInputBinding,
  type BrowserPopupRef,
  type BrowserPopupState,
  type BrowserPopupAnswer,
  type BrowserPrivateEdit,
  type BrowserPrivateCompositionPort,
  type BrowserClickRefusalReason,
} from "@opensteer/protocol";
export type NativeBrowserPopupRef = Omit<BrowserPopupRef, "surfaceId" | "streamId">;
export type NativeBrowserPopupEvent =
  | { type: "opened" | "updated"; ref: NativeBrowserPopupRef; state: BrowserPopupState }
  | {
      type: "closed";
      ref: NativeBrowserPopupRef;
      reason: "canceled" | "applied" | "interrupted" | "unavailable" | "expired";
    }
  | { type: "unavailable"; reason: "limit" | "unsupported" | "unavailable" };
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
  readonly popupVersion?: 1;
  readonly composition?: BrowserPrivateCompositionPort;
  start(options: {
    onPopup?(event: NativeBrowserPopupEvent): void;
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
  }): Promise<{ dispatched: boolean; reason?: BrowserClickRefusalReason }>;
  answerPopup?(
    ref: NativeBrowserPopupRef,
    answer: BrowserPopupAnswer,
  ): Promise<{ applied: boolean }>;
  cancelPopup?(ref: NativeBrowserPopupRef): Promise<void>;
  edit?(
    input: BrowserPrivateEdit,
    nextSequence: () => string,
    current?: () => boolean,
  ): Promise<{ dispatched: boolean }>;
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
  #started = false;
  #binding: BrowserInputBinding | null = null;
  #popup: { ref: NativeBrowserPopupRef; state: BrowserPopupState } | null = null;
  readonly #operations = new Map<
    string,
    { popupId: string; result: Promise<"applied" | "canceled" | "refused" | "uncertain"> }
  >();
  #pendingAnswer: string | null = null;
  get popupKind(): BrowserPopupState["kind"] | null {
    return this.#popup?.state.kind ?? null;
  }
  readonly #heldKeys = new Set<string>();
  get popupVersion(): 1 | undefined {
    return this.#port.popupVersion;
  }
  get binding(): BrowserInputBinding | null {
    return this.#binding;
  }
  bind(binding: BrowserInputBinding): boolean {
    if (this.#closed || this.#port.popupVersion !== 1) return false;
    if (this.#binding) return sameInputBinding(this.#binding, binding);
    this.#binding = { ...binding };
    return true;
  }
  owns(binding: BrowserInputBinding): boolean {
    return !this.#closed && sameInputBinding(this.#binding, binding);
  }
  async edit(
    binding: BrowserInputBinding,
    input: BrowserPrivateEdit,
    current: () => boolean = () => true,
  ): Promise<{ dispatched: boolean }> {
    if (!this.owns(binding) || !this.#port.edit) return { dispatched: false };
    if (
      this.#popup &&
      this.#popup.state.kind !== "datalist" &&
      !(input.type === "keyUp" && this.#heldKeys.has(input.code))
    )
      return { dispatched: false };
    if (input.type === "keyDown") this.#heldKeys.add(input.code);
    if (input.type === "keyUp") this.#heldKeys.delete(input.code);
    return this.#port.edit(
      input,
      () => this.#nextSequence(),
      () => this.owns(binding) && current(),
    );
  }
  popupAction(
    binding: BrowserInputBinding,
    ref: BrowserPopupRef,
    operationId: string,
    answer?: BrowserPopupAnswer,
  ): Promise<"applied" | "canceled" | "refused" | "uncertain"> {
    if (!this.owns(binding) || ref.streamId !== this.#streamId) return Promise.resolve("refused");
    const previous = this.#operations.get(operationId);
    if (previous)
      return previous.popupId === ref.popupId ? previous.result : Promise.resolve("refused");
    if (answer && this.#pendingAnswer === ref.popupId) return Promise.resolve("refused");
    const popup = this.#popup;
    if (
      !popup ||
      !samePopup({ ...popup.ref, surfaceId: ref.surfaceId, streamId: ref.streamId }, ref) ||
      (answer && (popup.ref.revision !== ref.revision || !validatePopupAnswer(popup.state, answer)))
    )
      return Promise.resolve("refused");
    if (this.#operations.size >= 128) return Promise.resolve("refused");
    // Consume before native submission, including synchronous event delivery.
    const terminal = Promise.withResolvers<"applied" | "canceled" | "refused" | "uncertain">();
    this.#operations.set(operationId, { popupId: ref.popupId, result: terminal.promise });
    if (answer) this.#pendingAnswer = ref.popupId;
    void (async () => {
      try {
        if (answer)
          return (await this.#port.answerPopup?.(ref, answer))?.applied
            ? ("applied" as const)
            : ("refused" as const);
        await this.#port.cancelPopup?.(ref);
        return "canceled" as const;
      } catch {
        return "uncertain" as const;
      }
    })().then((result) => {
      if (answer && this.#pendingAnswer === ref.popupId) this.#pendingAnswer = null;
      terminal.resolve(result);
    });
    return terminal.promise;
  }
  async dismissPopup(): Promise<void> {
    const popup = this.#popup;
    this.#popup = null;
    if (popup) await this.#port.cancelPopup?.(popup.ref).catch(() => undefined);
  }
  #streamId: DisplayStreamId | null = null;
  #producer: string | null = null;
  #sequence = -1;
  #generation = 0;
  #ptsUs = -1;
  #gesture = 0n;
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
    popup?: (event: NativeBrowserPopupEvent, binding: BrowserInputBinding) => void,
  ) {
    if (this.#closed || this.#streamId) throw new Error("Browser presentation already started.");
    this.#streamId = streamId;
    this.#stopped = stopped;
    try {
      this.#started = true;
      const result = await this.#port.start({
        budget,
        creditWindow,
        onPopup: (event) => {
          const binding = this.#binding;
          if (this.#closed || !binding) return;
          if (event.type === "opened" || event.type === "updated") {
            if (event.type === "opened")
              for (const [id, record] of this.#operations)
                if (record.popupId !== event.ref.popupId && record.popupId !== this.#pendingAnswer)
                  this.#operations.delete(id);
            this.#popup = { ref: event.ref, state: event.state };
          } else if (event.type === "unavailable") this.#popup = null;
          else if (event.type === "closed" && this.#popup?.ref.popupId === event.ref.popupId)
            this.#popup = null;
          popup?.(event, binding);
        },
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
  ): Promise<{ dispatched: boolean; reason?: BrowserClickRefusalReason }> {
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
    if (this.#gesture >= 18_446_744_073_709_551_615n) return { dispatched: false };
    this.#clicks.add(key);
    if (this.#clicks.size > 128) this.#clicks.delete(this.#clicks.values().next().value!);
    return this.#port.click({
      reference: ref,
      seq: this.#nextSequence(),
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
    if (this.#started) await this.#port.stop();
  }
  #nextSequence(): string {
    if (this.#gesture >= 18_446_744_073_709_551_615n)
      throw new Error("Private input sequence exhausted.");
    return String(++this.#gesture);
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
    this.#binding = null;
    this.#popup = null;
    this.#pendingAnswer = null;
    this.#operations.clear();
    this.#heldKeys.clear();
    this.#frames.clear();
    this.#pending.clear();
    this.#clicks.clear();
  }
}
