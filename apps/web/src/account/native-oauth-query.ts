interface BrowserLocationParts {
  readonly hash: string;
  readonly pathname: string;
  readonly search: string;
}

/** Keep the signed request in this history entry so reload and Back retain consent. */
export function consumeNativeOAuthQuery(
  location: BrowserLocationParts,
  replace: (url: string, state: Record<string, unknown>) => void,
  historyState: unknown = null,
): string | null {
  if (location.pathname !== "/") return null;
  const entry = typeof historyState === "object" && historyState !== null ? historyState : {};
  const saved = "nativeOAuthQuery" in entry ? entry.nativeOAuthQuery : null;
  const raw = location.search.length > 1 ? location.search.slice(1) : saved;
  if (typeof raw !== "string" || raw.length > 32_768) return null;
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
  if (location.search.length > 1)
    replace(`${location.pathname}${location.hash}`, { ...entry, nativeOAuthQuery: raw });
  return raw;
}

/** The same history entry once its request is answered, so returning to it is ordinary web use. */
export function withoutNativeOAuthQuery(historyState: unknown): unknown {
  if (typeof historyState !== "object" || historyState === null) return historyState;
  const { nativeOAuthQuery: _answered, ...entry } = historyState as Record<string, unknown>;
  return entry;
}
