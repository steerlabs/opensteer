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
