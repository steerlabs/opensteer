import { BrowserPoolAdmissionClosed } from "@opensteer/database";

export interface BrowserPoolGateDriver {
  /** Writes D and parks, or vetoes. `demanded` is read inside D and again after it. */
  park(demanded: () => boolean): Promise<"parked" | "vetoed">;
  /** Brings a parked browser back. It ends in an open gate: adopted, or discarded and fresh. */
  wake(): Promise<void>;
}

type GatePhase = "recovering" | "open" | "preparing" | "parking" | "parked" | "waking";

export interface BrowserPoolReservation {
  release(): void;
}

/**
 * One instance per pooled runtime, shared by every send on it. A send before the park intent
 * vetoes the park; a send after it waits. No phase is terminal: the driver ends every one.
 */
export class BrowserPoolGate {
  #driver: BrowserPoolGateDriver | undefined;
  #phase: GatePhase = "recovering";
  #changed = new AbortController();
  #active = 0;
  #demanded = false;
  #waking: Promise<void> | undefined;

  attach(driver: BrowserPoolGateDriver): void {
    this.#driver = driver;
  }

  get phase(): GatePhase {
    return this.#phase;
  }

  /** Every send that arrives after D waits; the retained documents stand for live ones. */
  get retiringOrAdopting(): boolean {
    return this.#phase === "parking" || this.#phase === "parked" || this.#phase === "waking";
  }

  /** The driver reports where the browser is now. */
  settle(phase: "open" | "parked"): void {
    this.#setPhase(phase);
  }

  /** The driver is bringing the browser back by itself, as after a restart mid-wake. */
  recovering(): void {
    this.#setPhase("recovering");
  }

  /** Demand: wakes a parked browser and waits for it. */
  reserve(signal: AbortSignal): Promise<BrowserPoolReservation> {
    return this.#wait(signal, true);
  }

  /**
   * Taken when a send without a consumer is queued, so a park cannot start under it. Before D it
   * vetoes the park; undefined means the caller waits with `background`.
   */
  backgroundNow(): BrowserPoolReservation | undefined {
    if (this.#phase === "open") return this.#hold();
    if (this.#phase === "preparing") this.#demanded = true;
    return undefined;
  }

  /** Traffic with no consumer: vetoes a park before D, waits after it, and never wakes. */
  background(signal: AbortSignal): Promise<BrowserPoolReservation> {
    return this.#wait(signal, false);
  }

  async #wait(signal: AbortSignal, demand: boolean): Promise<BrowserPoolReservation> {
    for (;;) {
      if (signal.aborted)
        throw signal.reason instanceof Error
          ? signal.reason
          : new BrowserPoolAdmissionClosed("The browser request was cancelled.");
      const phase = this.#phase;
      if (phase === "open") return this.#hold();
      if (phase === "preparing") this.#demanded = true;
      if (phase === "parked" && demand) this.#wake();
      await waitForChange(this.#changed.signal, signal);
    }
  }

  #hold(): BrowserPoolReservation {
    this.#active++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.#active--;
      },
    };
  }

  async tryPark(): Promise<"parked" | "vetoed"> {
    if (this.#phase !== "open" || this.#active || !this.#driver) return "vetoed";
    this.#demanded = false;
    this.#setPhase("preparing");
    let outcome: "parked" | "vetoed" = "vetoed";
    try {
      outcome = await this.#driver.park(() => {
        if (this.#demanded) return true;
        // From here on a send waits instead of vetoing.
        this.#setPhase("parking");
        return false;
      });
    } finally {
      this.#setPhase(outcome === "parked" ? "parked" : "open");
    }
    return outcome;
  }

  #wake(): void {
    if (this.#waking || !this.#driver) return;
    this.#setPhase("waking");
    this.#waking = this.#driver.wake().finally(() => {
      this.#waking = undefined;
    });
    void this.#waking.catch(() => undefined);
  }

  #setPhase(phase: GatePhase): void {
    this.#phase = phase;
    const previous = this.#changed;
    this.#changed = new AbortController();
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
