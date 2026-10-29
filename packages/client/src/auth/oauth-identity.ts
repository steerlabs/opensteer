import type { NativeOAuthApplication } from "@opensteer/core";

/**
 * The public OAuth identity one native build authorizes as: the client the
 * authorization server has registered, and the two private-use callbacks that
 * build claims with the operating system. Supplied by the application, because
 * a desktop and a phone are separate registrations — revoking one must never
 * revoke the other.
 *
 * `application` is which build this is. The application states it rather than
 * inferring it from a callback scheme, and it is what every surface a Host or
 * Account fences by client is read from, so a phone can never present itself
 * as the desktop.
 */
export interface NativeOAuthIdentity {
  readonly accountCallback: string;
  readonly application: NativeOAuthApplication;
  readonly clientId: string;
  readonly hostCallback: string;
}
