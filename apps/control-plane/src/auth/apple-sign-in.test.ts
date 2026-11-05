import { generateKeyPairSync } from "node:crypto";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { expect, it } from "vitest";
import { appleClientSecret } from "./apple-sign-in.js";

it("mints the client secret Apple's token endpoint accepts", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const now = new Date("2026-11-05T00:00:00.000Z");
  const secret = await appleClientSecret(
    {
      clientId: "com.opensteer.account",
      keyId: "ABCDE12345",
      privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      teamId: "TEAM123456",
    },
    now,
  );
  expect(decodeProtectedHeader(secret)).toMatchObject({ alg: "ES256", kid: "ABCDE12345" });
  const { payload } = await jwtVerify(secret, publicKey, {
    audience: "https://appleid.apple.com",
    currentDate: now,
    issuer: "TEAM123456",
    subject: "com.opensteer.account",
  });
  const sixMonthsSeconds = 15_777_000;
  expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(sixMonthsSeconds);
});
