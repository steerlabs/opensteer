import type { DesktopFirstScreenWords } from "./desktop-first-screen-words.js";

/** Which of the Mac app's first screens is showing. */
export type DesktopFirstScreen = "sign-in" | "keychain-refused" | "no-account";

/**
 * Which first screen `root` shows, decided by what only that screen has, or null while none is
 * showing yet: Sign in is the signed-out welcome; the keychain title is the keychain screen; the
 * welcome title with "Connect to my Opensteer" and no Sign in is a build without an account. Never
 * by the welcome title alone, which two of them share.
 *
 * The first-run journey runs it in the app's page (`page.waitForFunction`), so it stands alone:
 * only its arguments and the DOM, and no named function inside it.
 */
export function firstScreenOf(
  words: DesktopFirstScreenWords,
  root: ParentNode = document,
): DesktopFirstScreen | null {
  const buttons = [...root.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
  const texts = [...root.querySelectorAll("*")].map((e) => e.textContent?.trim() ?? "");
  if (buttons.includes(words.signIn)) return "sign-in";
  if (texts.includes(words.keychainTitle)) return "keychain-refused";
  if (texts.includes(words.welcomeTitle) && texts.includes(words.connectExisting))
    return "no-account";
  return null;
}
