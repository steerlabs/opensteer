/**
 * The person signed this browser out of this Opensteer. Until they choose to sign in again, the
 * app never starts the Opensteer account sign-in by itself: the account is still signed in to
 * this browser, and it would answer at once and bring the workspace back without a click.
 * Signing out of the Opensteer account itself is the account's own act, on its own page.
 */
const key = "opensteer.signed-out-here";

export function rememberSignedOutHere(): void {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Without storage this browser is still signed out; only the next automatic sign-in remains.
  }
}

export function signedOutHere(): boolean {
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

/** The person is signed in again: the next sign-out is theirs to choose again. */
export function forgetSignedOutHere(): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing kept, nothing to forget.
  }
}
