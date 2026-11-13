import { randomUUID } from "node:crypto";
import { OpensteerError, type RunId, type ThreadId, type UserId } from "@opensteer/core";
import {
  savedLoginPasswordsNeed,
  type PasswordSignInAvailability,
  type SavedLoginResult,
} from "@opensteer/protocol";

// Long enough to export and import, short enough that a stale offer can't wake a moved-on Thread.
const offerLifetimeMs = 15 * 60_000;
const sweepIntervalMs = 3_000;
const maxOffers = 32;

/** What `use_saved_login` told the agent Passwords lacks, which Passwords may gain without the agent. */
export interface PasswordsOffer {
  readonly id: string;
  readonly ownerId: UserId;
  readonly runId: RunId;
  readonly sessionId: string | null;
  readonly site: string;
  readonly threadId: ThreadId;
}

type Offer = PasswordsOffer & { readonly expiresAt: number };

/** Whether an offer that found its login is finished with, or waits for the next sweep. */
export type PasswordsOfferOutcome = "ended" | "held";

/** Whether `result` leaves Passwords something to gain, ends what it offered, or says neither. */
function offerChange(result: SavedLoginResult): "offer" | "end" | "keep" {
  if (savedLoginPasswordsNeed(result) !== null) return "offer";
  return result.status === "unavailable" || (result.status === "pending" && result.replayed)
    ? "keep"
    : "end";
}

/** What a woken agent reads: a fact about Passwords, with the decision left to it. */
export function passwordsLoginSavedMessage(offer: PasswordsOffer): string {
  const session = offer.sessionId === null ? "" : ` for Browser Session ${offer.sessionId}`;
  return `Opensteer Passwords now has a login for ${offer.site}, saved after your last use_saved_login, so that result is out of date. If the task still needs ${offer.site}, call use_saved_login again${session}.`;
}

/**
 * Sign-ins that found Passwords short of something, watched until it isn't.
 * A Request wakes its agent when it settles; an offer has nothing to settle, so
 * this is what closes the same loop. Memory-only: a restarted Host forgets them.
 */
export class PasswordsOffers {
  readonly #offers = new Map<string, Offer>();
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #probe: (ownerId: UserId, site: string) => Promise<PasswordSignInAvailability>;
  readonly #wake: (offer: PasswordsOffer) => Promise<PasswordsOfferOutcome>;
  #sweeping = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: {
    readonly now: () => number;
    readonly onError: (error: unknown) => void;
    readonly probe: (ownerId: UserId, site: string) => Promise<PasswordSignInAvailability>;
    readonly wake: (offer: PasswordsOffer) => Promise<PasswordsOfferOutcome>;
  }) {
    this.#now = options.now;
    this.#onError = options.onError;
    this.#probe = options.probe;
    this.#wake = options.wake;
  }

  /** Follows what one `use_saved_login` came to. */
  note(
    input: Pick<PasswordsOffer, "ownerId" | "runId" | "sessionId" | "site" | "threadId">,
    result: SavedLoginResult,
  ): void {
    const change = offerChange(result);
    if (change === "keep") return;
    const key = `${input.threadId}\0${input.site}`;
    this.#offers.delete(key);
    if (change === "offer") {
      if (this.#offers.size >= maxOffers) {
        const oldest = this.#offers.keys().next();
        if (!oldest.done) this.#offers.delete(oldest.value);
      }
      this.#offers.set(key, {
        ...input,
        expiresAt: this.#now() + offerLifetimeMs,
        id: randomUUID(),
      });
    }
    this.#schedule();
  }

  /** One pass. A pass still running covers this one. */
  async sweep(): Promise<void> {
    if (this.#sweeping) return;
    this.#sweeping = true;
    try {
      for (const [key, offer] of await this.#withLogins()) {
        // A newer sign-in replaced or ended this offer since its probe.
        if (this.#offers.get(key) !== offer) continue;
        await this.#wake(offer).then(
          (outcome) => {
            if (outcome === "ended" && this.#offers.get(key) === offer) this.#offers.delete(key);
          },
          (error: unknown) => {
            // A Thread that can't take input now never will: a finished task, say.
            if (error instanceof OpensteerError && !error.retryable) this.#offers.delete(key);
            else this.#onError(error);
          },
        );
      }
    } finally {
      this.#sweeping = false;
      this.#schedule();
    }
  }

  close(): void {
    this.#offers.clear();
    this.#schedule();
  }

  isCurrent(offer: PasswordsOffer): boolean {
    return this.#offers.get(`${offer.threadId}\0${offer.site}`) === offer;
  }

  async #withLogins(): Promise<readonly (readonly [string, Offer])[]> {
    const found: (readonly [string, Offer])[] = [];
    for (const [key, offer] of this.#offers) {
      if (this.#now() >= offer.expiresAt) {
        this.#offers.delete(key);
        continue;
      }
      const availability = await this.#probe(offer.ownerId, offer.site).catch((error: unknown) => {
        this.#onError(error);
        return "unavailable" as const;
      });
      if (availability === "has-login") found.push([key, offer]);
    }
    return found;
  }

  #schedule(): void {
    if (this.#offers.size === 0) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    } else if (!this.#timer) {
      this.#timer = setInterval(() => void this.sweep(), sweepIntervalMs);
      this.#timer.unref();
    }
  }
}
