import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { expect, it } from "vitest";
import { RemotePersonProfileReceiptVerifier } from "./person-profile-receipt-verifier.js";

const issuer = new URL("https://account.example");

it("accepts only Account's name receipts: its key, issuer, audience, use and lifetime", async () => {
  const keys = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), alg: "EdDSA", kid: "fixture" }] };
  const verifier = new RemotePersonProfileReceiptVerifier({
    issuer,
    fetch: async () => Response.json(jwks),
  });
  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    tokenUse: "opensteer-person-profile",
    iss: issuer.origin,
    aud: "opensteer-person-profile",
    sub: `acct_${crypto.randomUUID()}`,
    iat,
    exp: iat + 3_600,
    name: "Ada Lovelace",
    revision: 4,
  };
  const sign = (changes: Record<string, unknown> = {}, key = keys.privateKey) =>
    new SignJWT({ ...claims, ...changes })
      .setProtectedHeader({ alg: "EdDSA", kid: "fixture" })
      .sign(key);
  await expect(verifier.verify(await sign())).resolves.toEqual(claims);
  for (const change of [
    { iss: "https://foreign.example" },
    // Any other Account token, such as a team sign-in assertion, is never a name.
    { aud: "https://team.example", tokenUse: "opensteer-team-identity" },
    { tokenUse: "opensteer-team-identity" },
    { exp: iat + 3_601 },
    { iat: iat - 7_300, exp: iat - 3_700 },
    { name: "  Ada  " },
    { revision: 0 },
  ])
    await expect(verifier.verify(await sign(change))).rejects.toMatchObject({
      code: "unauthorized",
    });
  const foreign = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  await expect(verifier.verify(await sign({}, foreign.privateKey))).rejects.toMatchObject({
    code: "unauthorized",
  });
});
