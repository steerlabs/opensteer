interface BrowserLocationParts {
  readonly hash: string;
  readonly pathname: string;
  readonly search: string;
}

/**
 * Better Auth signs the complete authorization query before sending the
 * browser to the Host login page. Keep that opaque signed value only in
 * memory, remove it from browser history, and return it unchanged so the Host
 * can verify it when password or upstream OIDC login creates the session.
 */
export function consumeNativeOAuthQuery(
  location: BrowserLocationParts,
  replace: (url: string) => void,
): string | null {
  if (location.pathname !== "/" || location.search.length <= 1) return null;
  const raw = location.search.slice(1);
  if (raw.length > 32_768) return null;
  const parameters = new URLSearchParams(raw);
  if (
    parameters.get("response_type") !== "code" ||
    parameters.get("code_challenge_method") !== "S256" ||
    !parameters.get("client_id") ||
    !parameters.get("redirect_uri") ||
    !parameters.get("code_challenge") ||
    !parameters.get("sig") ||
    !parameters.get("ba_iat") ||
    parameters.getAll("ba_param").length === 0
  ) {
    return null;
  }
  replace(`${location.pathname}${location.hash}`);
  return raw;
}
