import type { ScreenPresentationReceipt } from "@opensteer/core";
import {
  ScreenPresentationInputSchema,
  screenPresentationEligibilityMs,
  type ScreenPresentationInput,
  type ScreenShowMessage,
} from "@opensteer/protocol";
import { voiceTimers, type VoiceTimer, type VoiceTimers } from "../voice/timers.js";
import type {
  CapturedPresentationView,
  PreparedPresentation,
  ScreenPresentationPort,
  ScreenPresentationTransport,
} from "./contract.js";

const ended: ScreenPresentationReceipt = { outcome: "superseded", reason: "interaction-ended" };
const expired: ScreenPresentationReceipt = { outcome: "superseded", reason: "expired" };
const unavailable: ScreenPresentationReceipt = { outcome: "unavailable" };
const receiptLimit = 256;

interface Utterance {
  readonly sequence: number;
  readonly view: CapturedPresentationView;
  readonly context: ScreenPresentationInput | undefined;
  readonly expiresAt: number;
  operationId: string | null;
}

interface Operation {
  readonly abort: AbortController;
  readonly message: ScreenShowMessage;
  readonly utterance: Utterance;
  readonly cancelled: Promise<void>;
  cancel(): void;
  settled: boolean;
  timer: VoiceTimer | null;
  committed: boolean;
}

/** A call may present one requested view; its transport and platform never choose its addressee. */
export class ScreenPresentationController {
  readonly #transport: ScreenPresentationTransport;
  readonly #port: ScreenPresentationPort;
  readonly #timers;
  readonly #unsubscribe: () => void;
  readonly #operations = new Map<string, Operation>();
  readonly #receipts = new Map<string, ScreenPresentationReceipt>();
  #endpointRef: string | null;
  #voiceSessionId: string | null = null;
  #sequence = 0;
  #utterance: Utterance | null = null;
  #disposed = false;

  constructor(
    input: VoiceTimers & {
      readonly transport: ScreenPresentationTransport;
      readonly port: ScreenPresentationPort;
    },
  ) {
    this.#transport = input.transport;
    this.#port = input.port;
    this.#timers = voiceTimers(input);
    this.#endpointRef = input.transport.getEndpoint()?.endpointRef ?? null;
    this.#unsubscribe = input.transport.subscribe((message) => {
      if (message) this.#receive(message);
      else {
        const next = input.transport.getEndpoint()?.endpointRef ?? null;
        if (next !== this.#endpointRef) {
          this.#invalidate();
          this.#endpointRef = next;
          this.#receipts.clear();
        }
      }
    });
  }

  start(voiceSessionId: string): void {
    this.stop();
    if (!this.#disposed) this.#voiceSessionId = voiceSessionId;
  }

  /** Called for every completed utterance, including local navigation commands. */
  captureUtterance(): {
    readonly view: CapturedPresentationView;
    readonly context: ScreenPresentationInput | undefined;
  } {
    this.#invalidate();
    const view = this.#port.capture();
    const endpoint = this.#transport.getEndpoint();
    this.#sequence += 1;
    const context =
      endpoint && this.#voiceSessionId
        ? ScreenPresentationInputSchema.parse({
            endpointRef: endpoint.endpointRef,
            voiceSessionId: this.#voiceSessionId,
            utteranceSequence: this.#sequence,
            interactionRevision: view.interactionRevision,
            ...(view.currentThreadId ? { currentThreadId: view.currentThreadId } : {}),
          })
        : undefined;
    this.#utterance = {
      sequence: this.#sequence,
      view,
      context,
      expiresAt: this.#timers.now() + screenPresentationEligibilityMs,
      operationId: null,
    };
    return { view, context };
  }

  stop(): void {
    this.#voiceSessionId = null;
    this.#invalidate();
  }

  /** Optional UI context cannot make queued work depend on a retired interaction. */
  inputContext(captured: ScreenPresentationInput | undefined): ScreenPresentationInput | undefined {
    const utterance = this.#utterance;
    if (!captured || !utterance || utterance.context !== captured) return undefined;
    const endpoint = this.#transport.getEndpoint();
    return !this.#disposed &&
      this.#utterance === utterance &&
      this.#voiceSessionId === captured.voiceSessionId &&
      endpoint?.endpointRef === captured.endpointRef &&
      this.#timers.now() < utterance.expiresAt &&
      this.#port.capture().interactionRevision === captured.interactionRevision &&
      !this.#port.blocked()
      ? captured
      : undefined;
  }

  dispose(): void {
    this.#disposed = true;
    this.stop();
    this.#unsubscribe();
    this.#receipts.clear();
  }

  #invalidate(): void {
    this.#utterance = null;
    for (const operation of this.#operations.values()) {
      operation.cancel();
      this.#settle(
        operation,
        operation.committed ? { outcome: "unconfirmed", reason: "interaction-ended" } : ended,
      );
    }
  }

  #check(operation: Operation): ScreenPresentationReceipt | null {
    const { message, utterance } = operation;
    const endpoint = this.#transport.getEndpoint();
    if (
      this.#disposed ||
      operation.abort.signal.aborted ||
      operation.settled ||
      this.#utterance !== utterance ||
      !endpoint ||
      endpoint.endpointRef !== message.endpointRef ||
      this.#voiceSessionId !== message.voiceSessionId ||
      utterance.context?.utteranceSequence !== message.utteranceSequence ||
      utterance.operationId !== message.operationId
    )
      return ended;
    if (
      this.#timers.now() >= utterance.expiresAt ||
      endpoint.serverTimeUpperBound() >= message.deadlineAt
    )
      return expired;
    if (
      this.#port.capture().interactionRevision !== message.interactionRevision ||
      utterance.view.interactionRevision !== message.interactionRevision
    )
      return { outcome: "superseded" };
    return this.#port.blocked();
  }

  #acknowledge(message: ScreenShowMessage, receipt: ScreenPresentationReceipt): void {
    if (this.#transport.getEndpoint()?.endpointRef !== message.endpointRef) return;
    try {
      this.#transport.acknowledge(message.operationId, receipt);
    } catch {
      // Delivery is uncertain; a duplicate returns this receipt without repeating navigation.
    }
  }

  #settle(operation: Operation, receipt: ScreenPresentationReceipt): void {
    if (operation.settled) return;
    operation.settled = true;
    this.#timers.clear(operation.timer);
    this.#operations.delete(operation.message.operationId);
    this.#receipts.set(operation.message.operationId, receipt);
    if (this.#receipts.size > receiptLimit) {
      const oldest = this.#receipts.keys().next().value;
      if (oldest !== undefined) this.#receipts.delete(oldest);
    }
    this.#acknowledge(operation.message, receipt);
  }

  #receive(message: ScreenShowMessage): void {
    const endpoint = this.#transport.getEndpoint();
    if (!endpoint || endpoint.endpointRef !== message.endpointRef) return;
    const cached = this.#receipts.get(message.operationId);
    if (cached) {
      this.#acknowledge(message, cached);
      return;
    }
    if (this.#operations.has(message.operationId)) return;
    const utterance = this.#utterance;
    if (
      !utterance ||
      this.#voiceSessionId !== message.voiceSessionId ||
      utterance.context?.endpointRef !== message.endpointRef ||
      utterance.sequence !== message.utteranceSequence
    ) {
      this.#acknowledge(message, ended);
      return;
    }
    if (utterance.operationId !== null) {
      this.#acknowledge(message, { outcome: "unavailable", reason: "already-requested" });
      return;
    }
    utterance.operationId = message.operationId;
    const abort = new AbortController();
    let release!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation: Operation = {
      abort,
      message,
      utterance,
      cancelled,
      cancel: () => {
        abort.abort();
        release();
      },
      settled: false,
      timer: null,
      committed: false,
    };
    this.#operations.set(message.operationId, operation);
    const blocked = this.#check(operation);
    if (blocked) {
      this.#settle(operation, blocked);
      return;
    }
    const remaining = Math.min(
      message.deadlineAt - endpoint.serverTimeUpperBound(),
      utterance.expiresAt - this.#timers.now(),
    );
    operation.timer = this.#timers.set(() => {
      operation.cancel();
      this.#settle(
        operation,
        operation.committed ? { outcome: "unconfirmed", reason: "expired" } : expired,
      );
    }, remaining);
    void this.#present(operation);
  }

  async #present(operation: Operation): Promise<void> {
    let prepared: PreparedPresentation | undefined;
    let disposed = false;
    const dispose = (value: PreparedPresentation) => {
      if (disposed) return;
      disposed = true;
      value.dispose();
    };
    try {
      const preparing = Promise.resolve()
        .then(() => this.#port.prepare(operation.message.target, operation.abort.signal))
        .then((result) => {
          // A platform may finish preparation after cancellation; it still owns cleanup.
          if (operation.abort.signal.aborted) dispose(result);
          void result.confirmation.catch(() => undefined);
          return result;
        });
      prepared = await Promise.race([preparing, operation.cancelled.then(() => undefined)]);
      if (!prepared || operation.settled) return;
      const blocked = this.#check(operation);
      if (blocked) {
        this.#settle(operation, blocked);
        return;
      }
      const result = prepared.commitIfCurrent({
        operationId: operation.message.operationId,
        check: () => this.#check(operation),
      });
      if (result !== "committed") {
        this.#settle(operation, result);
        return;
      }
      operation.committed = true;
      const confirmed = await Promise.race([
        prepared.confirmation,
        operation.cancelled.then(() => ended),
      ]);
      if (!operation.settled) this.#settle(operation, confirmed);
    } catch {
      if (!operation.settled) this.#settle(operation, unavailable);
    } finally {
      if (prepared) dispose(prepared);
    }
  }
}
