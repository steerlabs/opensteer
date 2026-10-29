export type ThreadMutationOwner = "message" | "request" | "settings";

/**
 * Proof of the one claim on a Thread. Only its holder can end it, so an
 * operation that has already settled cannot free the Thread for a send while
 * another operation of the same kind is still waiting on the Host.
 */
export interface ThreadMutationClaim {
  readonly owner: ThreadMutationOwner;
}

export interface ThreadMutationGate {
  /** A new claim, or null while any claim — of any kind — is still live. */
  readonly acquire: (owner: ThreadMutationOwner) => ThreadMutationClaim | null;
  /**
   * The live claim when it is this kind's, for the one caller that is allowed
   * to continue someone else's: the composer's pending message is durable —
   * written to this device before the command left — so its retry is the same
   * claim rather than a second one. Every other surface acquires.
   */
  readonly resume: (owner: ThreadMutationOwner) => ThreadMutationClaim | null;
  /** Ends this claim. A claim that no longer holds the Thread changes nothing. */
  readonly release: (claim: ThreadMutationClaim) => void;
}

/** The composer, a Request answer and settings mutate one Thread one at a time. */
export function createThreadMutationGate(
  initialOwner: ThreadMutationOwner | null,
  onChange: (owner: ThreadMutationOwner | null) => void,
): ThreadMutationGate {
  // A seeded owner is a claim nobody holds yet: a pending send found on disk
  // owns the Thread before the composer has mounted to resume it.
  let current: ThreadMutationClaim | null = initialOwner === null ? null : { owner: initialOwner };
  return {
    acquire(owner) {
      if (current !== null) return null;
      const claim: ThreadMutationClaim = { owner };
      current = claim;
      onChange(owner);
      return claim;
    },
    resume(owner) {
      return current !== null && current.owner === owner ? current : null;
    },
    release(claim) {
      if (current !== claim) return;
      current = null;
      onChange(null);
    },
  };
}
