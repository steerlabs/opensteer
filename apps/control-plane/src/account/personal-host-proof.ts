import { createPublicKey, verify } from "node:crypto";
import {
  PersonalHostAccessRouteEnvelopeSchema,
  PersonalHostAccountAuthoritySchema,
  PersonalHostAccountLinkProofEnvelopeSchema,
  isNetworkedPersonalAuthority,
  personalHostAccountLinkProofSigningBytes,
  type PersonalHostAccessRouteEnvelope,
  type PersonalHostAccountLinkProofEnvelope,
} from "@opensteer/control-plane-protocol";
import { sha256Base64Url } from "@opensteer/core/crypto";
import {
  HostDiscoveryEnvelopeSchema,
  verifyPersonalHostAccessRouteEnvelope,
} from "@opensteer/deployment-authority";
import { ControlPlaneError } from "../server/errors.js";

const invalidHostProof = () =>
  new ControlPlaneError("forbidden", "Personal Host signature is invalid");

export function verifyPersonalHostAccessRoute(
  input: PersonalHostAccessRouteEnvelope,
): ReturnType<typeof PersonalHostAccessRouteEnvelopeSchema.parse> {
  const envelope = PersonalHostAccessRouteEnvelopeSchema.parse(input);
  try {
    return verifyPersonalHostAccessRouteEnvelope(envelope);
  } catch {
    throw invalidHostProof();
  }
}

export function verifyPersonalHostAccountLinkProof(
  input: PersonalHostAccountLinkProofEnvelope,
): ReturnType<typeof PersonalHostAccountLinkProofEnvelopeSchema.parse> {
  const envelope = PersonalHostAccountLinkProofEnvelopeSchema.parse(input);
  verifyHostEnvelope(
    envelope.publicKey.spki,
    envelope.signature,
    personalHostAccountLinkProofSigningBytes(envelope.document),
  );
  return envelope;
}

export function personalHostAccountLinkProofSha256(
  input: PersonalHostAccountLinkProofEnvelope,
): string {
  const envelope = PersonalHostAccountLinkProofEnvelopeSchema.parse(input);
  return sha256Base64Url(JSON.stringify(envelope));
}

function verifyHostEnvelope(
  encodedSpki: string,
  encodedSignature: string,
  signingBytes: Uint8Array,
): void {
  try {
    const spki = Buffer.from(encodedSpki, "base64url");
    const signature = Buffer.from(encodedSignature, "base64url");
    if (
      spki.toString("base64url") !== encodedSpki ||
      signature.toString("base64url") !== encodedSignature
    ) {
      throw invalidHostProof();
    }
    const publicKey = createPublicKey({ format: "der", key: spki, type: "spki" });
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
      throw invalidHostProof();
    }
    if (!verify(null, signingBytes, publicKey, signature)) throw invalidHostProof();
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    throw invalidHostProof();
  }
}

/**
 * Where clients reach a linked Personal Host: a Mac Home by its signed Remote
 * access route, a Home on its own server at its canonical origin. Anything
 * that is not a Personal authority answers `routed`, so it never matches a
 * canonical row.
 */
export function personalReachability(authority: unknown): "canonical" | "routed" {
  const envelope = HostDiscoveryEnvelopeSchema.safeParse(authority);
  const parsed = PersonalHostAccountAuthoritySchema.safeParse(
    envelope.success ? envelope.data.document : authority,
  );
  return parsed.success && isNetworkedPersonalAuthority(parsed.data) ? "canonical" : "routed";
}
