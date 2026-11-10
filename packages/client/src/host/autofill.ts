import type { PersonFillStatus } from "@opensteer/protocol";
import { autofillKeeps, type AutofillKey } from "../editing/autofill-keys.js";
import type { BrowserAutofillState, BrowserEditingTarget } from "./browser-editing.js";
import { profileTint } from "./start-page-model.js";

/** The chooser's accessible name; it shows no title of its own. */
export const autofillChooserLabel = "Saved logins";
/** A code field's row, above the login it comes from. */
export const autofillCodeTitle = "Verification code";

/** A login's lettered mark: its username's first letter in a tint of its own. */
export function autofillAccountMark(account: { readonly id: string; readonly username: string }) {
  const letter = Array.from(account.username.trim()).find((char) => /[\p{L}\p{N}]/u.test(char));
  return { initial: letter?.toLocaleUpperCase() ?? "•", tint: profileTint(account.id) };
}

/** What a fill that did not happen says; nothing for a fill or the person's own cancel. */
export function autofillResultMessage(status: PersonFillStatus | null): string | null {
  switch (status) {
    case null:
    case "filled":
    case "cancelled":
      return null;
    case "changed":
      return "That login changed in Passwords. Click the field to see it again.";
    case "denied":
      return "Filling passwords for you is off in the Passwords window.";
    case "stale":
    case "expired":
      return "The page changed before it could be filled. Click the field again.";
    case "unavailable":
      return "Passwords couldn’t fill this right now.";
  }
}

export { autofillKeeps, type AutofillKey } from "../editing/autofill-keys.js";

/**
 * A key pressed while the chooser is shown: ↑ and ↓ move, Return fills and Esc
 * closes it. Any other key closes it and still reaches the page; a modifier on
 * its own does nothing yet. True when the chooser kept the key.
 */
export function autofillKey(
  target: Pick<BrowserEditingTarget, "dismissAutofill" | "fillAutofill" | "moveAutofill">,
  autofill: BrowserAutofillState,
  key: AutofillKey,
): boolean {
  if (modifierKeys.has(key.key)) return false;
  if (!autofillKeeps(key) || key.key === "Escape") target.dismissAutofill();
  else if (key.key === "Enter") {
    const account = autofill.offer.accounts[autofill.highlighted];
    if (account) target.fillAutofill(account.id);
  } else target.moveAutofill(key.key === "ArrowUp" ? -1 : 1);
  return autofillKeeps(key);
}
const modifierKeys = new Set(["Alt", "AltGraph", "CapsLock", "Control", "Fn", "Meta", "Shift"]);
