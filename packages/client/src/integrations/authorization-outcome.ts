import type { IntegrationAuthorizationStatus } from "@opensteer/integration-core";

/**
 * What a finished authorization attempt says, in one sentence a person can act
 * on. Every surface reads the same durable status, so they say the same thing;
 * `null` is the only success, and it is only ever returned for an attempt the
 * Host itself recorded as completed.
 *
 * A failure code the Host added since this build shipped falls through to the
 * generic sentence rather than being guessed at.
 */
export function integrationAuthorizationError(
  status: IntegrationAuthorizationStatus["status"],
  failureCode: string | null = null,
): string | null {
  if (status === "failed") {
    switch (failureCode) {
      case "provider-identity-already-connected":
        return "This account is already connected by another user. Ask them to disconnect it, or connect with your own provider app.";
      case "catalog-version-skew":
        return "Opensteer is updating its integration catalog. Try again after the Host and hosted service are on the same release.";
      case "scope-escalation":
        return "The provider did not grant every permission this integration needs. Reconnect and approve all requested permissions.";
      case "stale-provider-application":
        return "The OAuth application changed. Start the connection again.";
      case "account-link-mismatch":
        return "Your Opensteer Account link changed. Link the account again, then reconnect.";
      case "authorization-denied":
        return "Access was not approved.";
      case "grant-rejected":
        return "The authorization grant was rejected or expired. Start the connection again.";
      case "client-rejected":
        return "The provider rejected this OAuth application. Ask an administrator to check its configuration.";
      case "invalid-provider-response":
        return "The provider returned an invalid authorization response. Try again.";
      case "provider-exchange-failed":
        return "The provider could not exchange the authorization grant. Try again.";
    }
  }
  switch (status) {
    case "completed":
      return null;
    case "denied":
      return "Access was not approved.";
    case "cancelled":
      return "Authorization was cancelled.";
    case "expired":
      return "Authorization expired. Try again.";
    case "failed":
      return "The provider could not complete authorization. Try again.";
    case "pending":
    case "launched":
      return "Authorization is still pending.";
  }
}
