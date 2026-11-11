import type { PersonSaveOffer } from "@opensteer/protocol";
import { browserSiteLabel } from "./browser-sign-in.js";
import type { BrowserPasswordSaveState } from "./browser-editing.js";

/**
 * Asking to keep a login the person typed in Opensteer's browser, worded the
 * same on every surface. See docs/passwords.md#saving-for-people.
 */
export const passwordSaveAction = "Save";
export const passwordSaveDismissAction = "Not now";
export const passwordSaveSetUpAction = "Set Up Passwords";
export const passwordSaveUsernameLabel = "Username";
export const passwordSavePasswordLabel = "Password";
/** What stands for the password: never its value or its length. */
export const passwordSaveMask = "••••••••";

export interface PasswordSavePrompt {
  readonly title: string;
  readonly detail: string;
  /** The account being saved; absent for setup. */
  readonly username: string | null;
  readonly action: string;
}

export function passwordSavePrompt(offer: PersonSaveOffer): PasswordSavePrompt {
  if (offer.kind === "setup")
    return {
      title: "Save logins you type?",
      detail:
        "Set up Opensteer Passwords to keep logins on this Mac, fill them from any device and let agents sign in for you. This one isn’t kept.",
      username: null,
      action: passwordSaveSetUpAction,
    };
  return {
    title: `Save password for ${browserSiteLabel(offer.origin)}?`,
    detail:
      "Kept in Opensteer Passwords on your Mac. Fill it later from any device, and let agents use it when you allow them.",
    username: offer.username,
    action: passwordSaveAction,
  };
}

/** What the page's answer says once it arrives; null when there is nothing to say. */
export function passwordSaveResultMessage(
  result: BrowserPasswordSaveState["result"],
): { readonly ok: boolean; readonly message: string } | null {
  switch (result) {
    case null:
      return null;
    case "saved":
      return { ok: true, message: "Saved to Opensteer Passwords" };
    case "exists":
      return { ok: true, message: "Opensteer Passwords already has this login." };
    case "unavailable":
      return { ok: false, message: "Opensteer Passwords couldn’t save this login." };
  }
}
