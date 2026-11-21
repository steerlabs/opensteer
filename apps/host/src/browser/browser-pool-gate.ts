import { BrowserPoolAdmissionClosed, type BrowserPoolSlot } from "@opensteer/database";
import { randomUUID } from "node:crypto";

interface BrowserPoolGateOptions {
  readonly read: () => Promise<BrowserPoolSlot | undefined>;
  readonly begin: (
    intentId: string,
    demanded: () => boolean,
  ) => Promise<BrowserPoolSlot | undefined>;
  readonly park: (slot: BrowserPoolSlot) => Promise<BrowserPoolSlot>;
  readonly abortPark: (slot: BrowserPoolSlot) => Promise<BrowserPoolSlot>;
  readonly wake: (slot: BrowserPoolSlot) => Promise<BrowserPoolSlot>;
}

type GatePhase = "recovering" | "open" | "preparing" | "parking" | "parked" | "waking" | "closed";

export interface BrowserPoolReservation {
  release(): void;
}

/** One instance per opted-in runtime, shared by every send on that runtime. */
export class BrowserPoolGate {
  private readonly options: BrowserPoolGateOptions;
  private phase: GatePhase = "recovering";
  private slot: BrowserPoolSlot | undefined;
  private changed = new AbortController();
  private active = 0;
  private demanded = false;

  constructor(options: BrowserPoolGateOptions) {
    this.options = options;
  }

  /** Call only after the test target's current controller and runtime have been reconciled. */
  recovered(slot: BrowserPoolSlot | undefined): void {
    if (this.phase !== "recovering")
      throw new Error("The browser pool gate has already recovered.");
    this.install(slot);
  }

  get retiringOrAdopting(): boolean {
    return this.phase === "parking" || this.phase === "parked" || this.phase === "waking";
  }

  /** Maintenance can use the running browser, without creating wake demand. */
  holdOpen(): BrowserPoolReservation {
    if (this.phase !== "open") throw new BrowserPoolAdmissionClosed();
    this.active++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.active--;
      },
    };
  }

  async reserve(signal: AbortSignal): Promise<BrowserPoolReservation> {
    for (;;) {
      signal.throwIfAborted();
      const phase = this.phase;
      if (phase === "closed") throw new BrowserPoolAdmissionClosed();
      if (phase === "open") return this.holdOpen();
      if (phase === "preparing") this.demanded = true;
      if (phase === "parked") this.wake();
      await waitForChange(this.changed.signal, signal);
    }
  }

  async tryPark(): Promise<"parked" | "vetoed"> {
    if (this.phase !== "open" || this.active) return "vetoed";
    this.demanded = false;
    this.setPhase("preparing");
    const id = randomUUID();
    try {
      let intent: BrowserPoolSlot | undefined;
      try {
        intent = await this.options.begin(id, () => this.demanded);
      } catch (error) {
        // A failed response to COMMIT does not say whether D exists.
        const current = await this.options.read();
        if (current?.intentId !== id || current.phase !== "preparing") throw error;
        intent = current;
      }
      if (!intent) {
        this.setPhase("open");
        return "vetoed";
      }
      const abort = this.demanded;
      this.setPhase("parking");
      // A demand during COMMIT can still veto physical pause. Cancel the recorded
      // intent before reopening, even if a retire has never reached the runtime.
      const settled = await (abort ? this.options.abortPark(intent) : this.options.park(intent));
      this.install(settled);
      return settled.phase === "parked" ? "parked" : "vetoed";
    } catch (error) {
      this.setPhase("closed");
      throw error;
    }
  }

  private wake(): void {
    const slot = this.slot!;
    this.setPhase("waking");
    void this.options.wake(slot).then(
      (settled) => this.install(settled),
      () => this.setPhase("closed"),
    );
  }

  private install(slot: BrowserPoolSlot | undefined): void {
    this.slot = slot;
    const phase = slot?.phase;
    this.setPhase(
      !phase || phase === "running"
        ? "open"
        : phase === "parked" || phase === "waking"
          ? "parked"
          : "closed",
    );
  }

  private setPhase(phase: GatePhase): void {
    this.phase = phase;
    const previous = this.changed;
    this.changed = new AbortController();
    previous.abort();
  }
}

function waitForChange(changed: AbortSignal, cancelled: AbortSignal): Promise<void> {
  if (changed.aborted || cancelled.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      changed.removeEventListener("abort", done);
      cancelled.removeEventListener("abort", done);
      resolve();
    };
    changed.addEventListener("abort", done, { once: true });
    cancelled.addEventListener("abort", done, { once: true });
  });
}
