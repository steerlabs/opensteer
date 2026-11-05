import { importPKCS8, SignJWT } from "jose";

export interface AppleSignInConfig {
  /** The Services ID, which is what the web flow presents as its client. */
  readonly clientId: string;
  readonly keyId: string;
  readonly privateKeyPem: string;
  readonly teamId: string;
}

export const appleOrigin = "https://appleid.apple.com";
/** Apple refuses a client secret that lives longer than six months. */
const clientSecretLifetimeSeconds = 180 * 24 * 60 * 60;

export async function appleClientSecret(
  config: AppleSignInConfig,
  now: Date = new Date(),
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1_000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: config.keyId })
    .setIssuer(config.teamId)
    .setSubject(config.clientId)
    .setAudience(appleOrigin)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + clientSecretLifetimeSeconds)
    .sign(await importPKCS8(config.privateKeyPem, "ES256"));
}
