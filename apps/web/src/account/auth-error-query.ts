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
