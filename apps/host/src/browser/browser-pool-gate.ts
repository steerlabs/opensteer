import { OpensteerError, type BrowserSessionId } from "@opensteer/core";
import { BrowserPoolAdmissionClosed } from "@opensteer/database";

/** The controller explicitly refused this start/wake attempt. */
export class BrowserPoolAttemptRefused extends BrowserPoolAdmissionClosed {
  readonly refusedReason: string;
  /** True only when signed host status proved the saved state stayed paused on the same fence. */
  readonly savedStateKept: boolean;
  constructor(reason: string, savedStateKept = false) {
    super(`The pooled browser could not start (${reason}). Nothing was sent.`);
    this.name = "BrowserPoolAttemptRefused";
    this.refusedReason = reason;
    this.savedStateKept = savedStateKept;
  }
}

/** What a caller refused before anything was sent may do: nothing reached the browser. */
export const browserPoolUnsentNext = "Nothing was sent. It is safe to call again.";

/** The caller's own wake bound ran out while it waited: nothing was sent. */
export function browserPoolWakeRefusal(signal: AbortSignal): OpensteerError {
  // A Stop or a cut keeps its own refusal; a deadline is a refusal before any effect.
  return signal.reason instanceof OpensteerError
    ? signal.reason
    : new BrowserPoolAdmissionClosed(
        "The pooled browser did not wake in time. Nothing was sent.",
        signal.reason,
        browserPoolUnsentNext,
      );
}

/**
 * The target this caller waited for is over (another replaced it, or its host answered that this
 * Home's guest is gone) and nothing was sent. A caller that can find this Home's next target waits
 * for it within its own bound; any other reads these words.
 */
export class BrowserPoolTargetOver extends BrowserPoolAdmissionClosed {
  constructor() {
    super("This browser is not ready. Nothing was sent.", undefined, browserPoolUnsentNext);
    this.name = "BrowserPoolTargetOver";
  }
}

/** Where the browser is when it is not simply running: senders wait, and nothing wakes it twice. */
export type BrowserPoolAway = "parking" | "parked" | "waking" | "reconnecting";

/** What holds admission closed whatever the browser is doing. */
/**
 * `restart`: until the fresh guest is installed. `released`: for good (the device was removed).
 * `over`: the target answered, signed, that this Home's guest is gone; until a new target.
 */
export type BrowserPoolHold = "restart" | "released" | "over";

export interface BrowserPoolReservation {
  release(): void;
  /** True when the caller actually suspended before the gate opened (a wake, park, or hold). */
  readonly waited?: boolean;
  /** Aborted when a restart or a removal needs every holder gone: the holder stops and settles. */
  readonly ended?: AbortSignal;
  /**
   * How this holder records its outcome when a restart cannot wait for it any longer (a script
   * that ignores its abort): the restart runs it, and only then stops the guest.
   */
  onForcedEnd?(settle: () => Promise<void>): void;
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
  /** Of the active reservations, the ones taken with demand: a command in flight. */
  #commands = 0;
  #viewers = 0;
  /** The park preparing is a repair: a send with no demand waits instead of vetoing it. */
  #repairing = false;
  readonly #commandsIdle: (() => void)[] = [];
  #changed = new AbortController();
  #ended = new AbortController();
  #refusalGeneration = 0;
  #lastRefusalReason: string | undefined;
  #lastRefusalSavedStateKept = false;
  readonly #sessionPending: (id: BrowserSessionId) => boolean;
  readonly #idle: (() => void)[] = [];
  readonly #settlers = new Set<() => Promise<void>>();
  /** The loop is asked to act: someone waits with demand, or a hold needs holders gone. */
  onChange: () => void = () => {};
  /** Admission, reservations, or viewers changed: the idle-park rule updates its timer. */
  onIdleStateChanged: () => void = () => {};

  constructor(sessionPending: (id: BrowserSessionId) => boolean = () => false) {
    this.#sessionPending = sessionPending;
  }

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
  get phase():
    | "recovering"
    | "open"
    | "preparing"
    | BrowserPoolAway
    | "restarting"
    | "released"
    | "unavailable" {
    if (this.#hold === "released") return "released";
    if (this.#hold === "restart") return "restarting";
    if (this.#hold === "over") return "unavailable";
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

  /**
   * Commands in flight: reservations taken with demand (`reserve`), each ended by its own bound.
   * A send with no consumer (a viewer's frames, a person's input through the broker) is not one.
   */
  get commands(): number {
    return this.#commands;
  }

  /**
   * People watching now. A viewer is not a command (W10): it holds an ordinary park off (an idle
   * park never takes a browser from under a watching person), never the proxy's repair, which
   * brings back what the person is looking at.
   */
  get viewers(): number {
    return this.#viewers;
  }

  /** A viewer attached: held until the returned release. */
  viewing(): () => void {
    this.#viewers++;
    this.onIdleStateChanged();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#viewers--;
      this.onIdleStateChanged();
    };
  }

  /** Resolves once no command is in flight. */
  commandsIdle(): Promise<void> {
    if (this.#commands === 0) return Promise.resolve();
    return new Promise((resolve) => this.#commandsIdle.push(resolve));
  }

  /**
   * Whether bytes may not leave for the guest now: a restart or a removal holds admission, or the
   * reservation the write was admitted under has ended. Checked synchronously at the write
   * itself, after its last await; a check at a caller does not count.
   */
  refusesWrite(reservation?: BrowserPoolReservation): boolean {
    return this.#hold !== null || reservation?.ended?.aborted === true;
  }

  /** Someone waits for the browser with demand: a parked browser should wake. */
  get demand(): boolean {
    return this.#waiting > 0;
  }

  /** The browser is away (retiring, parked, waking, reconnecting): retained documents stand. */
  get retiringOrAdopting(): boolean {
    return this.#away !== null;
  }

  /**
   * The park step's window before D: a send now vetoes it. False: it cannot begin. `repair`: a
   * park that brings a broken guest back (its egress proxy is down): only a command in flight, or
   * one that arrives before D, keeps it from beginning or vetoes it; a send with no demand waits
   * for the wake, as it does after D. Sends already admitted finish at the retire's quiesce.
   */
  beginPark(repair = false): boolean {
    if (!this.admits || (repair ? this.#commands : this.#active || this.#viewers)) return false;
    this.#demanded = false;
    this.#preparing = true;
    this.#repairing = repair;
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
    this.#repairing = false;
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
    this.#repairing = false;
    this.#notify();
  }

  /**
   * The controller explicitly refused this wake/start attempt: waiting opens that opted in end at
   * once with the pool's refusal reason, while a later open still creates fresh demand and retries.
   */
  noteAttemptRefused(reason: string, savedStateKept = false): void {
    this.#refusalGeneration++;
    this.#lastRefusalReason = reason;
    this.#lastRefusalSavedStateKept = savedStateKept;
    this.#notify();
  }

  /** Demand: asks the loop to wake a parked browser and waits for it. */
  reserve(
    signal: AbortSignal,
    options?: { readonly failOnRefusal?: boolean; readonly sessionId?: BrowserSessionId },
  ): Promise<BrowserPoolReservation> {
    return this.#wait(signal, true, options?.failOnRefusal === true, options?.sessionId);
  }

  /** Taken when a send without a consumer is queued. Before D it vetoes the park. */
  backgroundNow(): BrowserPoolReservation | undefined {
    if (this.admits) return this.#take(false);
    if (this.#preparing && !this.#repairing) this.#demanded = true;
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

  /**
   * Every holder still here records its outcome; resolves once each one has. A settlement that
   * failed rejects, so the restart keeps its hold and goes no further toward a Stop.
   */
  async settleHolders(): Promise<void> {
    const results = await Promise.allSettled([...this.#settlers].map((settle) => settle()));
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw (failed as PromiseRejectedResult).reason;
  }

  async #wait(
    signal: AbortSignal,
    demand: boolean,
    failOnRefusal = false,
    sessionId?: BrowserSessionId,
  ): Promise<BrowserPoolReservation> {
    if (demand) this.#waiting++;
    const seenRefusal = this.#refusalGeneration;
    let asked = false;
    let waited = false;
    try {
      for (;;) {
        if (signal.aborted) throw browserPoolWakeRefusal(signal);
        // A target that is over has no browser to wait for: refused at once, not at a deadline.
        // A caller that can find this Home's next target waits for it instead.
        if (this.#hold === "over") throw new BrowserPoolTargetOver();
        if (this.#hold === "released")
          throw new BrowserPoolAdmissionClosed("This device was removed. Nothing was sent.");
        if (failOnRefusal && this.#refusalGeneration !== seenRefusal)
          throw new BrowserPoolAttemptRefused(
            this.#lastRefusalReason ?? "refused",
            this.#lastRefusalSavedStateKept,
          );
        if (this.admits && (!sessionId || !this.#sessionPending(sessionId)))
          return this.#take(demand, waited);
        if (this.#preparing && (demand || !this.#repairing)) this.#demanded = true;
        // Demand asks the loop once, as it begins to wait: the loop keeps a change that came
        // during a step for the turn after it, so asking again at every change of the gate
        // (the loop's own publications included) would only end its backoff each time.
        const changed = this.#changed.signal;
        if (demand && !asked) {
          asked = true;
          this.onChange();
        }
        waited = true;
        await waitForChange(changed, signal);
      }
    } finally {
      if (demand) this.#waiting--;
    }
  }

  #take(command: boolean, waited = false): BrowserPoolReservation {
    this.#active++;
    if (command) this.#commands++;
    this.onIdleStateChanged();
    let released = false;
    let settler: (() => Promise<void>) | undefined;
    return {
      ...(waited ? { waited: true } : {}),
      ended: this.#ended.signal,
      onForcedEnd: (settle) => {
        if (released) return;
        if (settler) this.#settlers.delete(settler);
        settler = settle;
        this.#settlers.add(settle);
      },
      release: () => {
        if (released) return;
        released = true;
        if (settler) this.#settlers.delete(settler);
        if (command && --this.#commands === 0)
          for (const idle of this.#commandsIdle.splice(0)) idle();
        if (--this.#active === 0) for (const idle of this.#idle.splice(0)) idle();
        this.onIdleStateChanged();
      },
    };
  }

  #notify(): void {
    const previous = this.#changed;
    this.#changed = new AbortController();
    previous.abort();
    this.onIdleStateChanged();
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
