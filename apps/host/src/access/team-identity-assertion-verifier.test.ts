import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { RemoteTeamIdentityAssertionVerifier } from "./team-identity-assertion-verifier.js";

const issuer = new URL("https://account.example");
const audience = "https://team.example";

describe("Account team session assertion verification", () => {
  it("pins issuer, audience, algorithm, token use and bounded lifetime", async () => {
    const keys = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), alg: "EdDSA", kid: "fixture" }] };
    const verifier = new RemoteTeamIdentityAssertionVerifier({
      issuer,
      audience,
      fetch: async () => Response.json(jwks),
    });
    const iat = Math.floor(Date.now() / 1000);
    const claims = {
      iss: issuer.origin,
      sub: `acct_${crypto.randomUUID()}`,
      aud: audience,
      authority: {
        canonicalOrigin: audience,
        deploymentId: `dep_${crypto.randomUUID()}`,
        hostInstanceId: `hst_${crypto.randomUUID()}`,
        hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
      },
      account: { issuer: issuer.origin, subject: `acct_placeholder` },
      email: "ada@example.com",
      displayName: "Ada",
      surface: "desktop",
      tokenUse: "opensteer-team-identity",
      iat,
      exp: iat + 60,
      jti: `tig_${crypto.randomUUID()}`,
    };
    claims.account.subject = claims.sub;
    const sign = (changes: Record<string, unknown> = {}) =>
      new SignJWT({ ...claims, ...changes })
        .setProtectedHeader({ alg: "EdDSA", kid: "fixture" })
        .sign(keys.privateKey);
    await expect(verifier.verify(await sign())).resolves.toMatchObject(claims);
    for (const change of [
      { iss: "https://foreign.example" },
      { aud: "https://foreign.example" },
      { tokenUse: "other" },
      { iat: iat + 30, exp: iat + 60 },
      { exp: iat + 121 },
    ])
      await expect(verifier.verify(await sign(change))).rejects.toMatchObject({
        code: "unauthorized",
      });
    await expect(
      verifier.verify(await sign({ iat: iat - 100, exp: iat - 40 })),
    ).rejects.toMatchObject({ reason: "assertion-expired" });
    const foreign = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    await expect(
      verifier.verify(
        await new SignJWT(claims)
          .setProtectedHeader({ alg: "EdDSA", kid: "fixture" })
          .sign(foreign.privateKey),
      ),
    ).rejects.toMatchObject({ reason: "assertion-invalid" });
  });
  it("preserves JWKS outages as retryable failures", async () => {
    const keys = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: "fixture" })
      .sign(keys.privateKey);
    const verifier = new RemoteTeamIdentityAssertionVerifier({
      issuer,
      audience,
      fetch: async () => {
        throw new Error("network unavailable");
      },
    });
    await expect(verifier.verify(token)).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    });
  });
});
