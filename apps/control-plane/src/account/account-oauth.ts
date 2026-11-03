import type { BrowserPageIcon } from "@opensteer/shared/browserPage";

export const maximumOAuthQueryLength = 32_768;

/** One thing an app will be able to do, as the consent page draws it. */
export interface ConsentGrant {
  readonly danger?: boolean;
  readonly icon: BrowserPageIcon;
  readonly text: string;
}

interface AccountConsentPresentation {
  readonly clientId: string;
  readonly grants: readonly ConsentGrant[];
}

/** In the order a person reads them: who you are, then what it may do. */
const grantByScope: Readonly<Record<string, ConsentGrant>> = {
  offline_access: { icon: "key", text: "Stay signed in until you sign out" },
  "deployments:read": { icon: "stack", text: "See your Opensteers" },
  "deployments:write": { icon: "plus", text: "Add and change your Opensteers" },
  "account:delete": { danger: true, icon: "trash", text: "Delete your Account" },
};
const identityScopes = new Set(["email", "openid", "profile"]);

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
  const requested = new Set(scopes);
  const grants: ConsentGrant[] = [];
  // The identity scopes are one fact to a person — who they are — so they
  // read as one line naming exactly the parts the app asked for.
  if (scopes.some((scope) => identityScopes.has(scope))) {
    const email = requested.has("email");
    const name = requested.has("profile");
    grants.push({
      icon: "person",
      text:
        email && name
          ? "Your name and email"
          : email
            ? "Your email address"
            : name
              ? "Your name"
              : "Who you are",
    });
  }
  for (const [scope, grant] of Object.entries(grantByScope)) {
    if (requested.has(scope)) grants.push(grant);
  }
  // A scope this page has no words for is never echoed: its name is the
  // requester's to choose.
  if (scopes.some((scope) => !identityScopes.has(scope) && !(scope in grantByScope))) {
    grants.push({ icon: "shield", text: "Other Opensteer permissions" });
  }
  return { clientId: values.get("client_id") ?? "", grants };
}
