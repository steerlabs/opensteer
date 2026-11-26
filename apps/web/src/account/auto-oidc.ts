import type { IdentityConfig } from "@opensteer/core";

export interface AutoOidcOptions {
  readonly desktop: boolean;
  /** An authorization failure is on screen; restarting would loop straight back into it. */
  readonly hasAuthorizationError: boolean;
  readonly hasNativeOAuthQuery: boolean;
  readonly recentAttempt: boolean;
  readonly setupInProgress: boolean;
  /** The person signed this browser out: they choose when to sign in again. */
  readonly signedOut?: boolean;
}

export function shouldAutoStartOidc(config: IdentityConfig, options: AutoOidcOptions): boolean {
  return (
    config.setupState === "complete" &&
    !config.localPasswordEnabled &&
    config.oidcProviders.length === 1 &&
    !options.desktop &&
    !options.hasAuthorizationError &&
    !options.hasNativeOAuthQuery &&
    !options.recentAttempt &&
    !options.setupInProgress &&
    options.signedOut !== true
  );
}

/**
 * This page was signed in and the Home then ended its session: the person signed this browser
 * out from another device (or it expired) while it was open. Like a sign-out here, it stays
 * signed out until the person chooses to sign in again: an automatic sign-in would answer from
 * the still signed-in Opensteer account and stand up a new session of this browser at once.
 */
export function sessionEndedHere(wasSignedIn: boolean, session: string): boolean {
  return wasSignedIn && session === "authentication-required";
}
