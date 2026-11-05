import { randomUUID } from "node:crypto";
import {
  OpensteerError,
  type RequestId,
  type RunId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import type { PasswordSignInAvailability } from "@opensteer/protocol";
import {
  browserSignInPasswordsNeed,
  type AgentBrowserSignInResult,
} from "@opensteer/protocol/browser-sources";

// Long enough to export and import, short enough that a stale offer can't wake a moved-on Thread.
const offerLifetimeMs = 15 * 60_000;
const sweepIntervalMs = 3_000;
const maxOffers = 32;

/** What a sign-in told the agent Passwords lacks, which Passwords may gain without the agent. */
export interface PasswordsOffer {
  readonly id: string;
  readonly ownerId: UserId;
  /** The Chrome Request opened beside this offer, whose answer can end it. */
  readonly requestId: RequestId | null;
  readonly runId: RunId;
  readonly sessionId: string | null;
  readonly site: string;
  readonly threadId: ThreadId;
}

/** Whether an offer that found its login is finished with, or waits for the next sweep. */
export type PasswordsOfferOutcome = "ended" | "held";

function offerRequestId(result: AgentBrowserSignInResult): RequestId | null {
  return result.status === "pending" ? result.requestId : null;
}

/** Whether `result` leaves Passwords something to gain, ends what it offered, or says neither. */
function offerChange(result: AgentBrowserSignInResult): "offer" | "end" | "keep" {
  if (browserSignInPasswordsNeed(result) !== null) return "offer";
  return result.status === "unavailable" || (result.status === "pending" && result.replayed)
    ? "keep"
    : "end";
}

/**
 * The next step, carried on the result because a long-lived session keeps the
 * guide it read first. The result is the one thing every call gets fresh.
 */
export function passwordsOfferGuidance(result: AgentBrowserSignInResult): string | null {
  if (offerChange(result) !== "offer") return null;
  const chrome = result.status === "not-signed-in" ? "Chrome has no sign-in for this site. " : "";
  return `${chrome}This is true only now: Opensteer shows the person what to do under your reply, and tells you when a login is saved. If they say it's done or ask again first, call sign_in again before answering.`;
}

/** What a woken agent reads: a fact about Passwords, with the decision left to it. */
export function passwordsLoginSavedMessage(offer: PasswordsOffer): string {
  const session = offer.sessionId === null ? "" : ` in Browser Session ${offer.sessionId}`;
  return `Opensteer Passwords now has a login for ${offer.site}, saved after your last sign_in, so that result is out of date. If the person still wants this sign-in, call sign_in again${session}.`;
}

/**
 * Sign-ins that found Passwords short of something, watched until it isn't.
 * A Request wakes its agent when it settles; an offer has nothing to settle, so
 * this is what closes the same loop. Memory-only: a restarted Host forgets
 * them, and the result's guidance still gets the agent there on the next word.
 */
export class PasswordsOffers {
  readonly #offers = new Map<string, PasswordsOffer & { readonly expiresAt: number }>();
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

  /** Follows what one `sign_in` came to. */
  note(
    input: Pick<PasswordsOffer, "ownerId" | "runId" | "sessionId" | "site" | "threadId">,
    result: AgentBrowserSignInResult,
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
        requestId: offerRequestId(result),
      });
    }
    this.#schedule();
  }

  /** One pass. A pass still running covers this one. */
  async sweep(): Promise<void> {
    if (this.#sweeping) return;
    this.#sweeping = true;
    try {
      for (const [key, offer] of this.#offers) {
        await this.#check(key, offer).catch((error: unknown) => {
          // A Thread that can't take input now never will: a finished task, say.
          if (error instanceof OpensteerError && !error.retryable) this.#offers.delete(key);
          else this.#onError(error);
        });
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

  async #check(key: string, offer: PasswordsOffer & { readonly expiresAt: number }): Promise<void> {
    if (this.#now() >= offer.expiresAt) {
      this.#offers.delete(key);
      return;
    }
    if ((await this.#probe(offer.ownerId, offer.site)) !== "has-login") return;
    // A newer sign-in replaced or ended this offer during the probe.
    if (this.#offers.get(key) !== offer) return;
    if ((await this.#wake(offer)) === "ended" && this.#offers.get(key) === offer)
      this.#offers.delete(key);
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
