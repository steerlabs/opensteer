import {
  HostAccountAdoptionCompletionGrantClaimsSchema,
  HostAccountAdoptionProofIdSchema,
} from "@opensteer/control-plane-protocol";
import { createId } from "@opensteer/core";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { RemoteAccountAdoptionGrantVerifier } from "./account-adoption-grant-verifier.js";

const issuer = "https://accounts.opensteer.test";
const audience = "https://host.example.test";

describe("RemoteAccountAdoptionGrantVerifier", () => {
  it("accepts only a real Ed25519 signature over the exact completion tuple", async () => {
    const signing = await signingFixture();
    const fetch = jwksFetch(signing.publicJwk);
    const verifier = new RemoteAccountAdoptionGrantVerifier({
      audience,
      fetch,
      issuer: new URL(issuer),
    });
    const claims = adoptionClaims();
    const token = await signedGrant(signing.privateKey, claims);

    await expect(verifier.verify(token)).resolves.toMatchObject({
      account: claims.account,
      authorizedBy: claims.proof.authorizedBy,
      deployment: claims.authority,
      grantId: claims.jti,
      proofId: claims.proof.id,
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("/api/auth/jwks", issuer),
      expect.objectContaining({ credentials: "omit", method: "GET", redirect: "manual" }),
    );

    const wrongAudience = await signedGrant(signing.privateKey, {
      ...claims,
      aud: "https://different-host.example.test",
      authority: { ...claims.authority, canonicalOrigin: "https://different-host.example.test" },
    });
    await expect(verifier.verify(wrongAudience)).rejects.toMatchObject({ code: "forbidden" });

    const wrongIssuer = await signedGrant(signing.privateKey, {
      ...claims,
      account: { ...claims.account, issuer: "https://attacker.example.test" },
      iss: "https://attacker.example.test",
    });
    await expect(verifier.verify(wrongIssuer)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects an expired grant, an unsupported algorithm, and an oversized JWKS", async () => {
    const signing = await signingFixture();
    const claims = adoptionClaims();
    const verifier = new RemoteAccountAdoptionGrantVerifier({
      audience,
      fetch: jwksFetch(signing.publicJwk),
      issuer: new URL(issuer),
    });
    const now = Math.floor(Date.now() / 1_000);
    await expect(
      verifier.verify(
        await signedGrant(signing.privateKey, { ...claims, exp: now - 10, iat: now - 70 }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });

    const hmacToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", kid: signing.publicJwk.kid })
      .sign(new TextEncoder().encode("a-secret-that-is-long-enough-for-hs256"));
    await expect(verifier.verify(hmacToken)).rejects.toMatchObject({ code: "forbidden" });

    const oversizedVerifier = new RemoteAccountAdoptionGrantVerifier({
      audience,
      fetch: vi.fn(
        async () =>
          new Response(JSON.stringify({ keys: [signing.publicJwk] }), {
            headers: { "content-length": String(65 * 1_024), "content-type": "application/json" },
          }),
      ),
      issuer: new URL(issuer),
    });
    await expect(
      oversizedVerifier.verify(await signedGrant(signing.privateKey, claims)),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

function adoptionClaims() {
  const now = Math.floor(Date.now() / 1_000);
  return HostAccountAdoptionCompletionGrantClaimsSchema.parse({
    account: {
      issuer,
      subject: "acct_00000000-0000-4000-8000-000000000001",
    },
    aud: audience,
    authority: {
      canonicalOrigin: audience,
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
    },
    exp: now + 300,
    iat: now,
    iss: issuer,
    jti: `hag_${crypto.randomUUID()}`,
    proof: {
      authorizedBy: {
        sessionId: createId("authSession"),
        userId: createId("user"),
      },
      consumedAt: new Date().toISOString(),
      id: HostAccountAdoptionProofIdSchema.parse(`hap_${crypto.randomUUID()}`),
    },
    sub: "acct_00000000-0000-4000-8000-000000000001",
    tokenUse: "opensteer-host-account-adoption",
  });
}

async function signingFixture() {
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    alg: "EdDSA",
    kid: "account-signing-key-v1",
    use: "sig",
  };
  return { privateKey, publicJwk };
}

async function signedGrant(
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"],
  claims: ReturnType<typeof adoptionClaims>,
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: "account-signing-key-v1", typ: "JWT" })
    .sign(privateKey);
}

function jwksFetch(publicJwk: Awaited<ReturnType<typeof signingFixture>>["publicJwk"]) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify({ keys: [publicJwk] }), {
        headers: { "content-type": "application/json" },
      }),
  );
}
