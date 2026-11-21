import { OpensteerError } from "@opensteer/core";
import { BrowserPoolAdmissionClosed } from "@opensteer/database";

/** Where the browser is when it is not simply running: senders wait, and nothing wakes it twice. */
export type BrowserPoolAway = "parking" | "parked" | "waking" | "reconnecting";

/** What holds admission closed whatever the browser is doing. */
export type BrowserPoolHold = "restart" | "released";

export interface BrowserPoolReservation {
  release(): void;
  /** Aborted when a restart or a removal needs every holder gone: the holder stops and settles. */
  readonly ended?: AbortSignal;
}

/**
 * Admission for one pooled runtime, as a function of facts the coordinator's loop sets. It is
 * open exactly when the browser is recovered, no hold is set, it is not away and no park is
 * preparing; it starts closed. A send before the park intent vetoes the park; a send after it
 * waits. It never drives anything: a waiter with demand only asks the loop to act.
 */
export class BrowserPoolGate {
  #recovered = false;
  #away: BrowserPoolAway | null = null;
  #hold: BrowserPoolHold | null = null;
  #preparing = false;
  #demanded = false;
  #waiting = 0;
  #active = 0;
  #changed = new AbortController();
  #ended = new AbortController();
  readonly #idle: (() => void)[] = [];
  /** The loop is asked to act: someone waits with demand, or a hold needs holders gone. */
  onChange: () => void = () => {};

  /** The loop's facts. `released` is for good: nothing moves it again. */
  set(facts: {
    readonly recovered?: boolean;
    readonly away?: BrowserPoolAway | null;
    readonly hold?: BrowserPoolHold | null;
  }): void {
    if (this.#hold === "released") return;
    if (facts.recovered !== undefined) this.#recovered = facts.recovered;
    if (facts.away !== undefined) this.#away = facts.away;
    if (facts.hold !== undefined) {
      // Every holder is asked to stop when a hold begins.
      if (facts.hold && !this.#hold) {
        this.#ended.abort();
        this.#ended = new AbortController();
      }
      this.#hold = facts.hold;
    }
    this.#notify();
  }

  get admits(): boolean {
    return this.#recovered && !this.#hold && !this.#away && !this.#preparing;
  }

  /** One word for clients and logs; the facts themselves decide admission. */
  get phase(): "recovering" | "open" | "preparing" | BrowserPoolAway | "restarting" | "released" {
    if (this.#hold === "released") return "released";
    if (this.#hold === "restart") return "restarting";
    if (!this.#recovered) return "recovering";
    if (this.#preparing) return "preparing";
    return this.#away ?? "open";
  }

  get away(): BrowserPoolAway | null {
    return this.#away;
  }

  /** Reservations held now, including queued sends with no consumer. */
  get held(): number {
    return this.#active;
  }

  /** Someone waits for the browser with demand: a parked browser should wake. */
  get demand(): boolean {
    return this.#waiting > 0;
  }

  /** The browser is away (retiring, parked, waking, reconnecting): retained documents stand. */
  get retiringOrAdopting(): boolean {
    return this.#away !== null;
  }

  /** The park step's window before D: a send now vetoes it. False: it cannot begin. */
  beginPark(): boolean {
    if (!this.admits || this.#active) return false;
    this.#demanded = false;
    this.#preparing = true;
    this.#notify();
    return true;
  }

  /** Read inside D, and again after it: whether a send arrived first. */
  demandedSince(): boolean {
    return this.#demanded || this.#waiting > 0;
  }

  /**
   * The park intent committed. False: a send arrived first and vetoes it. Either way the browser
   * is now away (parking) and every send waits: a vetoed park is undone first, and only the row
   * reading running again, published by the loop, opens admission.
   */
  committed(): boolean {
    if (!this.#preparing) return false;
    this.#preparing = false;
    this.#away = "parking";
    // A send, a restart or a removal that came first vetoes it.
    const vetoed = this.demandedSince() || this.#hold !== null;
    this.#notify();
    return !vetoed;
  }

  /** The park step ended before D: the window closes. */
  endPark(): void {
    if (!this.#preparing) return;
    this.#preparing = false;
    this.#notify();
  }

  /** Demand: asks the loop to wake a parked browser and waits for it. */
  reserve(signal: AbortSignal): Promise<BrowserPoolReservation> {
    return this.#wait(signal, true);
  }

  /** Taken when a send without a consumer is queued. Before D it vetoes the park. */
  backgroundNow(): BrowserPoolReservation | undefined {
    if (this.admits) return this.#take();
    if (this.#preparing) this.#demanded = true;
    return undefined;
  }

  /** Traffic with no consumer: vetoes a park before D, waits after it, and never wakes. */
  background(signal: AbortSignal): Promise<BrowserPoolReservation> {
    return this.#wait(signal, false);
  }

  /** Resolves once no reservation is held: every admitted send has finished. */
  idle(): Promise<void> {
    if (this.#active === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idle.push(resolve));
  }

  async #wait(signal: AbortSignal, demand: boolean): Promise<BrowserPoolReservation> {
    if (demand) this.#waiting++;
    try {
      for (;;) {
        if (signal.aborted)
          // A Stop or a cut keeps its own refusal; a deadline is a refusal before any effect.
          throw signal.reason instanceof OpensteerError
            ? signal.reason
            : new BrowserPoolAdmissionClosed(
                "The pooled browser did not wake in time. Nothing was sent.",
                signal.reason,
              );
        if (this.#hold === "released")
          throw new BrowserPoolAdmissionClosed("This device was removed. Nothing was sent.");
        if (this.admits) return this.#take();
        if (this.#preparing) this.#demanded = true;
        if (demand) this.onChange();
        await waitForChange(this.#changed.signal, signal);
      }
    } finally {
      if (demand) this.#waiting--;
    }
  }

  #take(): BrowserPoolReservation {
    this.#active++;
    let released = false;
    return {
      ended: this.#ended.signal,
      release: () => {
        if (released) return;
        released = true;
        if (--this.#active === 0) for (const idle of this.#idle.splice(0)) idle();
      },
    };
  }

  #notify(): void {
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
