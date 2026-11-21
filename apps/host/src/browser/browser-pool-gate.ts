import { OpensteerError } from "@opensteer/core";
import { BrowserPoolAdmissionClosed } from "@opensteer/database";

export interface BrowserPoolGateDriver {
  /** Writes D and parks, or vetoes. `demanded` is read inside D and again after it. */
  park(demanded: () => boolean): Promise<"parked" | "vetoed">;
  /** Brings a parked browser back. It ends in an open gate: adopted, or discarded and fresh. */
  wake(): Promise<void>;
}

type GatePhase =
  | "recovering"
  | "open"
  | "preparing"
  | "parking"
  | "parked"
  | "waking"
  | "reconnecting"
  | "restarting"
  | "released";

export interface BrowserPoolReservation {
  release(): void;
}

/**
 * One instance per pooled runtime, shared by every send on it. A send before the park intent
 * vetoes the park; a send after it waits. Two holds nothing else undoes: `released` is for good,
 * and a restart holds admission until it lets go; meanwhile a park or reconnect that finishes
 * only records where the browser is.
 */
export class BrowserPoolGate {
  #driver: BrowserPoolGateDriver | undefined;
  #phase: GatePhase = "recovering";
  #changed = new AbortController();
  #active = 0;
  #demanded = false;
  #waking: Promise<void> | undefined;
  /** Where the browser is, as the driver last said, whatever a hold shows. */
  #where: "open" | "parked" = "open";
  #restarts = 0;

  attach(driver: BrowserPoolGateDriver): void {
    this.#driver = driver;
  }

  get phase(): GatePhase {
    return this.#phase;
  }

  /** Reservations held now, including queued sends with no consumer. */
  get held(): number {
    return this.#active;
  }

  /** Every send that arrives after D waits; the retained documents stand for live ones. */
  get retiringOrAdopting(): boolean {
    return this.#phase === "parking" || this.#phase === "parked" || this.#phase === "waking";
  }

  /**
   * The driver calls this once the park intent has committed. False: a send arrived first and
   * vetoes the park. True: from here on a send waits for the wake.
   */
  committed(): boolean {
    if (this.#demanded || this.#phase !== "preparing") return false;
    this.#setPhase("parking");
    return true;
  }

  /** The Runner's channel was lost: sends wait while the Home reattaches its sessions. */
  reconnecting(): void {
    if (this.#phase === "open") this.#setPhase("reconnecting");
  }

  /**
   * The owner's restart was accepted: admission is held until the returned release, which the
   * restart calls once its fresh guest is installed. Nothing in between admits, wakes or parks.
   */
  restarting(): () => void {
    if (this.#phase === "released") return () => {};
    this.#restarts++;
    this.#setPhase("restarting");
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.#restarts === 0 && this.#phase === "restarting") this.#setPhase(this.#where);
    };
  }

  /** The device was removed: nothing is admitted or woken again, whatever finishes later. */
  released(): void {
    this.#setPhase("released");
  }

  /** The driver reports where the browser is now; under a hold that is only recorded. */
  settle(phase: "open" | "parked"): void {
    this.#where = phase;
    if (this.#phase === "released" || this.#phase === "restarting") return;
    this.#setPhase(phase);
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
        // A Stop or a cut keeps its own refusal; a deadline is a refusal before any effect.
        throw signal.reason instanceof OpensteerError
          ? signal.reason
          : new BrowserPoolAdmissionClosed(
              "The pooled browser did not wake in time. Nothing was sent.",
              signal.reason,
            );
      const phase = this.#phase;
      if (phase === "open") return this.#hold();
      if (phase === "released")
        throw new BrowserPoolAdmissionClosed("This device was removed. Nothing was sent.");
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
      // Until the intent has committed, a send vetoes; the driver asks after the commit.
      outcome = await this.#driver.park(() => this.#demanded);
    } finally {
      this.settle(outcome === "parked" ? "parked" : "open");
    }
    return outcome;
  }

  #wake(): void {
    if (this.#waking || !this.#driver || this.#phase !== "parked") return;
    this.#setPhase("waking");
    this.#waking = this.#driver.wake().finally(() => {
      this.#waking = undefined;
    });
    void this.#waking.catch(() => undefined);
  }

  #setPhase(phase: GatePhase): void {
    // Released is for good: nothing moves it again.
    if (this.#phase === "released") return;
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
