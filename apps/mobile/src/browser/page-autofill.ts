import type { BrowserEditingTarget } from "@opensteer/client/host";
import type { PersonFillStatus } from "@opensteer/protocol";

/** What a fill that did not happen means to the person, and what they can do. */
const unfilled: Record<Exclude<PersonFillStatus, "filled" | "cancelled">, string> = {
  changed: "This login changed on your Mac. Tap the field to see it again.",
  denied: "Filling saved logins is turned off in Passwords on your Mac.",
  stale: "The page changed. Tap the field and try again.",
  expired: "Tap the field and try again.",
  unavailable: "Passwords on your Mac isn’t available right now. Try again in a moment.",
};

/**
 * Filling a saved login the page offered, from this phone: the person's tap,
 * then this device's owner check unless the Mac already has one for that
 * login on this tab, then the Mac types it. The choice is held here rather
 * than in the chips, because the system's prompt can take the keyboard and
 * the chips with it; an offer withdrawn meanwhile fills nothing.
 */
export function createPageAutofill(input: {
  readonly editing: Pick<BrowserEditingTarget, "get" | "subscribe" | "fillAutofill">;
  readonly authenticate: () => Promise<boolean>;
  /** The login waiting on the device check, or null once it is answered. */
  readonly onConfirming: (loginId: string | null) => void;
  /** About to fill: the person is still typing into the field. */
  readonly onChosen: () => void;
  readonly onFilled: () => void;
  readonly onUnfilled: (detail: string) => void;
}) {
  const { editing } = input;
  let confirming = false;
  /** The offer this phone asked to fill, until its answer or its withdrawal. */
  let awaiting: string | null = null;
  const stop = editing.subscribe(() => {
    if (awaiting === null) return;
    const autofill = editing.get().autofill;
    if (autofill?.offer.offerId !== awaiting) awaiting = null;
    else if (autofill.result !== null) {
      awaiting = null;
      if (autofill.result === "filled") input.onFilled();
      else if (autofill.result !== "cancelled") input.onUnfilled(unfilled[autofill.result]);
    }
  });
  return {
    async choose(loginId: string): Promise<void> {
      const autofill = editing.get().autofill;
      const account = autofill?.offer.accounts.find(({ id }) => id === loginId);
      if (!autofill || !account || autofill.pending !== null || confirming) return;
      const { offerId } = autofill.offer;
      if (!account.ready) {
        confirming = true;
        input.onConfirming(loginId);
        try {
          if (!(await input.authenticate())) return;
        } catch (error) {
          input.onUnfilled(error instanceof Error ? error.message : String(error));
          return;
        } finally {
          confirming = false;
          input.onConfirming(null);
        }
      }
      if (editing.get().autofill?.offer.offerId !== offerId) return;
      input.onChosen();
      awaiting = offerId;
      editing.fillAutofill(loginId);
    },
    stop,
  };
}
