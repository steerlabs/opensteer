import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { ControlPlaneError } from "../server/errors.js";

const googleIssuers = ["https://accounts.google.com", "accounts.google.com"];
const googleKeys = new URL("https://www.googleapis.com/oauth2/v3/certs");

/**
 * Admits exactly one Google service account: the Cloud Computer provisioner's Workload Identity. Its ID token
 * names this Account as audience, so a token minted for any other service is refused here.
 */
export function googleServiceAccountVerifier(input: {
  readonly audience: string;
  readonly email: string;
  readonly keys?: JWTVerifyGetKey;
}): (authorization: string | undefined) => Promise<void> {
  const keys = input.keys ?? createRemoteJWKSet(googleKeys);
  return async (authorization) => {
    const token = /^Bearer ([A-Za-z0-9_.-]{1,8192})$/u.exec(authorization ?? "")?.[1];
    if (!token) throw new ControlPlaneError("unauthorized", "Provisioner credential is required");
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        algorithms: ["RS256"],
        audience: input.audience,
        issuer: googleIssuers,
      }));
    } catch {
      throw new ControlPlaneError("unauthorized", "Provisioner credential is invalid");
    }
    if (payload.email !== input.email || payload.email_verified !== true) {
      throw new ControlPlaneError("forbidden", "Provisioner credential is not allowed");
    }
  };
}
