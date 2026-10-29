/**
 * What every Browser Session page is told about passkeys, in both engines.
 *
 * Neither engine can complete a WebAuthn ceremony: Electron ships none of
 * Chrome's passkey interface, and the cloud browser's prompts are browser UI
 * that never reaches the page stream. Chromium then waits silently for a
 * security key for at least three minutes, so a site offering "Sign in with a
 * passkey" would hang. Pages instead see a browser without WebAuthn: the
 * `WebAuth` Blink feature removes `PublicKeyCredential`, so sites that check
 * for it offer their other sign-in methods, and a publicKey request fails at
 * once wherever an engine can install this policy
 * (docs/browser-sessions.md#passkeys).
 */
export const browserPageDisabledBlinkFeatures = "WebAuth";

/** Disables WebAuthn for a document and every frame inside it. */
export const browserPagePermissionsPolicy =
  "publickey-credentials-create=(), publickey-credentials-get=()";

// The one page global the policy touches; this package compiles without DOM types.
declare const CredentialsContainer:
  | {
      readonly prototype: Record<
        "create" | "get",
        (...argumentList: unknown[]) => Promise<unknown>
      >;
    }
  | undefined;

/**
 * Rejects publicKey credential requests in the page's main world before the
 * page's own scripts run. Engines serialize this function into pages, so it
 * must not reference anything outside its body.
 */
export function installBrowserPagePolicy(): void {
  if (typeof CredentialsContainer === "undefined") return;
  for (const method of ["create", "get"] as const) {
    const native = CredentialsContainer.prototype[method];
    CredentialsContainer.prototype[method] = new Proxy(native, {
      apply(target, thisArgument, argumentList) {
        const options = argumentList[0];
        // Matches how the browser reads its options dictionary: any object,
        // functions included, and an undefined member counts as absent.
        const dictionary =
          (typeof options === "object" && options !== null) || typeof options === "function";
        if (dictionary && (options as { publicKey?: unknown }).publicKey !== undefined) {
          return Promise.reject(
            new DOMException("Passkeys aren't available in this browser.", "NotAllowedError"),
          );
        }
        return Reflect.apply(target, thisArgument, argumentList);
      },
    });
  }
}

/** The policy as a script an engine evaluates in a new document ahead of its own scripts. */
export const browserPagePolicyScript = `(${installBrowserPagePolicy.toString()})();`;
