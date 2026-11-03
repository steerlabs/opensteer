import { describe, expect, it } from "vitest";
import { accountConsentPresentation, maximumOAuthQueryLength } from "./account-oauth.js";

const now = Date.UTC(2026, 7, 16, 20, 0, 0);

describe("Account OAuth consent presentation", () => {
  it("accepts a live Better Auth consent envelope and renders fixed permission labels", () => {
    const query = consentQuery();

    expect(accountConsentPresentation(query.toString(), now)).toEqual({
      clientId: "opensteer-desktop",
      grants: [
        { icon: "person", text: "Your email address" },
        { icon: "key", text: "Stay signed in until you sign out" },
        { icon: "stack", text: "See your Opensteers" },
        { icon: "plus", text: "Add and change your Opensteers" },
      ],
    });
  });

  it("rejects missing, duplicated, malformed, future-issued, and expired envelopes", () => {
    expect(accountConsentPresentation("", now)).toBeNull();
    expect(accountConsentPresentation("x".repeat(maximumOAuthQueryLength + 1), now)).toBeNull();

    const duplicated = consentQuery();
    duplicated.append("sig", "another-signature");
    expect(accountConsentPresentation(duplicated.toString(), now)).toBeNull();

    const malformed = consentQuery();
    malformed.set("code_challenge_method", "plain");
    expect(accountConsentPresentation(malformed.toString(), now)).toBeNull();

    const futureIssued = consentQuery();
    futureIssued.set("ba_iat", String(now + 60_001));
    futureIssued.set("exp", String(Math.floor((now + 360_000) / 1_000)));
    expect(accountConsentPresentation(futureIssued.toString(), now)).toBeNull();

    const expired = consentQuery();
    expired.set("exp", String(Math.floor(now / 1_000)));
    expect(accountConsentPresentation(expired.toString(), now)).toBeNull();
  });

  it("does not reflect unknown scope names into the consent UI", () => {
    const query = consentQuery();
    query.set("scope", "openid attacker:controlled");

    expect(accountConsentPresentation(query.toString(), now)).toEqual({
      clientId: "opensteer-desktop",
      grants: [
        { icon: "person", text: "Who you are" },
        { icon: "shield", text: "Other Opensteer permissions" },
      ],
    });
    expect(JSON.stringify(accountConsentPresentation(query.toString(), now))).not.toContain(
      "attacker",
    );
  });
});

function consentQuery(): URLSearchParams {
  return new URLSearchParams({
    ba_iat: String(now - 1_000),
    client_id: "opensteer-desktop",
    code_challenge: "A".repeat(43),
    code_challenge_method: "S256",
    exp: String(Math.floor((now + 5 * 60_000) / 1_000)),
    redirect_uri: "com.opensteer.opensteer:/oauth/account-callback",
    response_type: "code",
    scope: "openid email offline_access deployments:read deployments:write",
    sig: "signed-by-better-auth",
    state: "state-with-enough-entropy",
  });
}
