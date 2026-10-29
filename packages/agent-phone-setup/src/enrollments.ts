import type { AgentPhoneEnrollment } from "./setup-agent-phone.js";

/** One mint request: the key it is sent under, and the only request that key ever carries. */
export interface AgentPhoneEnrollmentSlot {
  readonly idempotencyKey: string;
  readonly name: string;
  /** The Host's answer for the key, once one arrived. */
  enrollment: AgentPhoneEnrollment | null;
}

/**
 * The enrollments one setup dialog mints, kept for as long as the dialog is
 * open so that every run of setup in it — "Try again", or a phone plugged back
 * in — continues the same sequence, whatever Host port each run builds.
 *
 * The current slot keeps its key, its request and the enrollment the Host
 * answered. A mint whose answer was lost is sent again under the same key with
 * the same request, so the Host answers with the enrollment it already made.
 * Setup opens the next slot only once the Host has retired the current one, so
 * the dialog never holds two enrollments that could be redeemed.
 */
export class AgentPhoneEnrollments {
  readonly #keyPrefix: string;
  #ordinal = 0;
  #current: AgentPhoneEnrollmentSlot | null = null;

  /** `keyPrefix` is unique to the dialog, such as a fresh mutation idempotency key. */
  constructor(keyPrefix: string) {
    this.#keyPrefix = keyPrefix;
  }

  /** The dialog's current slot; the first is opened for `name`. */
  current(name: string): AgentPhoneEnrollmentSlot {
    return this.#current ?? this.#open(name);
  }

  /** Opens the slot after `retired`, whose enrollment the Host says can never be redeemed. */
  next(retired: AgentPhoneEnrollmentSlot, name: string): AgentPhoneEnrollmentSlot {
    return this.#current === retired ? this.#open(name) : this.current(name);
  }

  #open(name: string): AgentPhoneEnrollmentSlot {
    const slot = { enrollment: null, idempotencyKey: `${this.#keyPrefix}:${this.#ordinal}`, name };
    this.#ordinal += 1;
    this.#current = slot;
    return slot;
  }
}
