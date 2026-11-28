interface BrowserLocationParts {
  readonly hash: string;
  readonly pathname: string;
  readonly search: string;
}

export interface OAuthErrorQuery {
  readonly description: string | null;
  readonly error: string;
}

/**
 * The identity provider sends authorization failures — an unknown client, a
 * refused upstream OIDC callback — to this path with the reason in the query.
 * Both values are attacker-controllable text, so they are bounded here and
 * rendered as plain text; an over-long description is dropped rather than
 * shown cut in half, and the screen falls back to its own sentence.
 *
 * The query is removed from history in the same turn, because the failure is a
 * moment to read once and not a page anyone should be able to return to.
 */
export function consumeOAuthErrorQuery(
  location: BrowserLocationParts,
  replace: (url: string) => void,
): OAuthErrorQuery | null {
  if (location.pathname !== "/auth/error" || location.search.length <= 1) return null;
  const raw = location.search.slice(1);
  if (raw.length > 4_096) return null;
  const parameters = new URLSearchParams(raw);
  const error = parameters.get("error");
  if (error === null || !/^[A-Za-z0-9_-]{1,64}$/u.test(error)) return null;
  const rawDescription = parameters.get("error_description")?.trim() ?? "";
  replace(`/${location.hash}`);
  return {
    description: rawDescription.length === 0 || rawDescription.length > 512 ? null : rawDescription,
    error,
  };
}

export interface AuthorizationErrorScreen {
  /** Continue clears the screen; signing in as the owner asks the Account who is signing in. */
  readonly action: "continue" | "sign-in-as-owner";
  readonly message: string;
  readonly title: string;
}

/**
 * What the page says for a failed sign-in. A managed Home refuses an Opensteer
 * account that is not its owner (`another_account`); signing in again with the
 * same Account session would only be refused again, so that page offers
 * signing in as the owner, which makes the Account ask who is signing in.
 */
export function authorizationErrorScreen(error: OAuthErrorQuery): AuthorizationErrorScreen {
  if (error.error === "another_account")
    return {
      action: "sign-in-as-owner",
      message: "Sign in with the Opensteer account that owns it.",
      title: "This Home belongs to another Opensteer account",
    };
  return {
    action: "continue",
    message: error.description ?? "This deployment turned down the authorization request.",
    title: "Sign-in couldn’t be completed",
  };
}
