import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { OpensteerError } from "@opensteer/core";
import {
  HostDescriptorSchema,
  hostKeyFingerprint,
  verifyHostDiscoveryEnvelope,
  type HostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import {
  teamPartnerCapability,
  teamPartnerProtocolVersion,
  teamPartnerSigningBytes,
  type TeamPartnerChallenge,
} from "@opensteer/protocol";

export function partnerError(reason = "partner-refused"): OpensteerError {
  return new OpensteerError({
    code: "forbidden",
    reason,
    message: "Team partner connection refused",
  });
}

export function verifiedPartnerAuthority(authority: HostDiscoveryEnvelope) {
  const document = verifyHostDiscoveryEnvelope(authority);
  if (document.deploymentShape.kind !== "team") throw partnerError("identity-mismatch");
  return authority;
}

export function verifyPartnerPins(
  authority: HostDiscoveryEnvelope,
  pins: {
    teamId: string;
    origin: string;
    hostKeyFingerprint: string;
    hostInstanceId: string;
  },
) {
  const document = verifiedPartnerAuthority(authority).document;
  if (
    document.deploymentId !== pins.teamId ||
    document.canonicalOrigin !== pins.origin ||
    document.hostInstanceId !== pins.hostInstanceId ||
    hostKeyFingerprint(authority.publicKey.spki) !== pins.hostKeyFingerprint
  )
    throw partnerError("identity-mismatch");
}

export function verifiedPartnerDescriptor(
  raw: unknown,
  pins: Parameters<typeof verifyPartnerPins>[1],
) {
  const descriptor = HostDescriptorSchema.parse(raw);
  verifyPartnerPins(descriptor.authority, pins);
  if (descriptor.kind !== "team" || !descriptor.capabilities.includes(teamPartnerCapability))
    throw partnerError("unsupported-partner-version");
  return descriptor;
}

export function signPartnerChallenge(
  key: KeyObject,
  challenge: TeamPartnerChallenge,
  role: "dialer" | "listener",
) {
  return sign(null, teamPartnerSigningBytes(challenge, role), key).toString("base64url");
}

export function verifyPartnerChallenge(
  authority: HostDiscoveryEnvelope,
  challenge: TeamPartnerChallenge,
  role: "dialer" | "listener",
  signature: string,
) {
  if (challenge.version !== teamPartnerProtocolVersion)
    throw partnerError("unsupported-partner-version");
  const key = createPublicKey({
    key: Buffer.from(authority.publicKey.spki, "base64url"),
    format: "der",
    type: "spki",
  });
  if (
    !verify(
      null,
      teamPartnerSigningBytes(challenge, role),
      key,
      Buffer.from(signature, "base64url"),
    )
  )
    throw partnerError();
}
