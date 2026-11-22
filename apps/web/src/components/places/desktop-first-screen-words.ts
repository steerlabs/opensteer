/**
 * The words that tell the Mac app's first screen apart, as `DesktopWelcome` shows them. Two of its
 * screens share the title "Welcome to Opensteer": the signed-out welcome, with Sign in, and the
 * welcome of a build without an Opensteer account, without it. The first-run journey reads these
 * same words, so it can't drift from the screen.
 */
export const desktopFirstScreenWords = Object.freeze({
  /** The title of both welcomes. */
  welcomeTitle: "Welcome to Opensteer",
  /** The signed-out welcome's primary button. */
  signIn: "Sign in",
  /** The title when this Mac's keychain refuses Opensteer. */
  keychainTitle: "Opensteer can’t use this Mac’s keychain",
  /** A row only the welcome of a build without an account shows. */
  connectExisting: "Connect to my Opensteer",
});

export type DesktopFirstScreenWords = typeof desktopFirstScreenWords;
