import type { NativeOAuthIdentity } from "@opensteer/client/auth";
import {
  opensteerMobileIntegrationAuthorizationCallback,
  parseNativeIntegrationAuthorizationCallback,
  IntegrationAuthorizationCancelledError,
} from "@opensteer/client/integrations";

/** `expo-web-browser`'s authentication session, as this adapter needs it. */
export interface AuthorizationSessionOpener {
  dismissAuthSession(): void;
  openAuthSessionAsync(
    url: string,
    redirectUrl: string,
    options: { readonly preferEphemeralSession: boolean },
  ): Promise<{ readonly type: string; readonly url?: string }>;
}

/**
 * The system authorization session, wired to the OAuth deep-link broker.
 *
 * `NativeOAuthManager` asks the application to open an authorize URL and waits
 * for the callback to arrive through the broker. On a phone the two are one
 * call: iOS and Android hand the redirect straight back to the caller of an
 * authentication session, so the returned URL is fed to the broker rather than
 * waiting for the operating system to route the scheme to a cold start.
 *
 * The OAuth owner supplies the callback for invite continuations. Only this
 * build's registered callbacks can open a system authorization session.
 */
export function createAuthorizationBrowser(options: {
  readonly broker: { accept(url: string): boolean; settled(): Promise<void> };
  readonly browser: AuthorizationSessionOpener;
  readonly oauth: NativeOAuthIdentity;
}): (url: string, callback?: string) => Promise<void> {
  return async (url, callback) => {
    const redirect = authorizationRedirectOf(url, options.oauth, callback);
    // Host OAuth may federate to the Account immediately after Account OAuth.
    // Sharing the system browser's cookies turns that second trip into a
    // redirect instead of asking the person to authenticate twice.
    const result = await options.browser.openAuthSessionAsync(url, redirect, {
      preferEphemeralSession: false,
    });
    if (result.type !== "success") throw new Error("Sign-in was cancelled.");
    if (result.url === undefined || !options.broker.accept(result.url)) {
      throw new Error("The authorization browser did not return an Opensteer callback.");
    }
    // The browser closing is not proof that its code was exchanged and saved.
    // Keep the sign-in action pending until the broker has delivered the result.
    await options.broker.settled();
  };
}

/** Opens a provider flow that returns its attempt and optional finish proof to this app. */
export function createIntegrationAuthorizationBrowser(options: {
  readonly browser: AuthorizationSessionOpener;
}): (url: string, signal?: AbortSignal) => Promise<string> {
  return async (url, signal) => {
    let launch: URL;
    try {
      launch = new URL(url);
    } catch {
      throw new Error("The integration authorization address is not a URL.");
    }
    if (launch.protocol !== "https:" && launch.protocol !== "http:") {
      throw new Error("An integration authorization address must be served over HTTP.");
    }
    let abort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      abort = () => {
        reject(new IntegrationAuthorizationCancelledError());
        try {
          options.browser.dismissAuthSession();
        } catch {
          // Android's module has no dismissal, so its tab stays open for the person to
          // close. Nothing is lost: a return from it finds no attempt to finish.
        }
      };
    });
    signal?.addEventListener("abort", abort, { once: true });
    const result = await Promise.race([
      options.browser.openAuthSessionAsync(
        launch.toString(),
        opensteerMobileIntegrationAuthorizationCallback,
        { preferEphemeralSession: false },
      ),
      aborted,
    ]).finally(() => signal?.removeEventListener("abort", abort));
    if (result.type !== "success") throw new IntegrationAuthorizationCancelledError();
    if (
      result.url === undefined ||
      parseNativeIntegrationAuthorizationCallback(result.url) === null
    ) {
      throw new Error("The authorization browser did not return an integration attempt.");
    }
    return result.url;
  };
}

export function authorizationRedirectOf(
  authorizeUrl: string,
  oauth: NativeOAuthIdentity,
  callback?: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(authorizeUrl);
  } catch {
    throw new Error("The authorization address is not a URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("An authorization address must be served over HTTP.");
  }
  const redirect = callback ?? parsed.searchParams.get("redirect_uri");
  if (redirect !== oauth.accountCallback && redirect !== oauth.hostCallback) {
    throw new Error("This authorization address does not return to Opensteer on this device.");
  }
  return redirect;
}
