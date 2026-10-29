export const maximumOAuthQueryLength = 32_768;

interface AccountConsentPresentation {
  readonly permissions: readonly string[];
}

const permissionByScope: Readonly<Record<string, string>> = {
  "account:delete": "Delete your Opensteer Account",
  email: "Use your account email address",
  offline_access: "Stay signed in until you sign out",
  openid: "Use your Opensteer account identity",
  profile: "Use your Opensteer account profile",
  "deployments:read": "View your Opensteer deployments",
  "deployments:write": "Create and manage your Opensteer deployments",
};

const requiredSingleValueParameters = [
  "ba_iat",
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "exp",
  "redirect_uri",
  "response_type",
  "scope",
  "sig",
  "state",
] as const;

/**
 * Parses only the browser-presentation envelope of a Better Auth consent
 * transaction. Better Auth remains the sole cryptographic authority and
 * verifies the signed query again when consent is submitted.
 */
export function accountConsentPresentation(
  oauthQuery: string,
  nowMilliseconds = Date.now(),
): AccountConsentPresentation | null {
  if (!oauthQuery || oauthQuery.length > maximumOAuthQueryLength) return null;
  const query = new URLSearchParams(oauthQuery);
  const values = new Map<string, string>();
  for (const parameter of requiredSingleValueParameters) {
    const candidates = query.getAll(parameter);
    if (candidates.length !== 1 || !candidates[0]) return null;
    values.set(parameter, candidates[0]);
  }

  if (values.get("response_type") !== "code") return null;
  if (values.get("code_challenge_method") !== "S256") return null;
  if (!/^[A-Za-z0-9_-]{43,128}$/u.test(values.get("code_challenge") ?? "")) return null;
  const state = values.get("state") ?? "";
  if (state.length < 16 || state.length > 2_048) return null;
  if ((values.get("client_id")?.length ?? 0) > 255) return null;

  const redirectUri = values.get("redirect_uri");
  if (!redirectUri) return null;
  try {
    new URL(redirectUri);
  } catch {
    return null;
  }

  const issuedAtMilliseconds = Number(values.get("ba_iat"));
  const expiresAtMilliseconds = Number(values.get("exp")) * 1_000;
  if (
    !Number.isSafeInteger(issuedAtMilliseconds) ||
    !Number.isSafeInteger(expiresAtMilliseconds) ||
    issuedAtMilliseconds <= 0 ||
    expiresAtMilliseconds <= issuedAtMilliseconds ||
    issuedAtMilliseconds > nowMilliseconds + 60_000 ||
    expiresAtMilliseconds <= nowMilliseconds
  ) {
    return null;
  }

  const scopes = (values.get("scope") ?? "").split(" ").filter(Boolean);
  if (scopes.length === 0 || scopes.some((scope) => !/^[\w:.-]{1,128}$/u.test(scope))) {
    return null;
  }
  const permissions = [
    ...new Set(
      scopes.map((scope) => permissionByScope[scope] ?? "Use additional Opensteer permissions"),
    ),
  ];
  return permissions.length > 0 ? { permissions } : null;
}
