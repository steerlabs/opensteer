import { ed25519SpkiFingerprint } from "@opensteer/core/crypto";
import { createPublicKey } from "node:crypto";
import {
  ComputerAppApprovalSchema,
  ComputerAppSetupRequestSchema,
  type ComputerAppApproval,
  type ComputerAppSetupRequest,
} from "@opensteer/integration-core";
import {
  normalizeEd25519PrivateKey,
  normalizeEd25519PublicKey,
  signProof,
  verifyProof,
  type Ed25519KeySource,
} from "@opensteer/shared/proof";

/**
 * Version 4 is signed by the desktop's own approval key rather than the
 * Runner's.
 *
 * The Runner's key authenticates a process, and any process running as the
 * person can read it from `identity.json`; an approval is the person's consent,
 * so it is signed by a key only desktop main holds, in the OS keychain. The
 * label moves with the key so a Runner-key signature over the same request can
 * never be read as the new authority, whichever key a verifier is handed.
 * Version 2 named the app; version 4 also binds the person's decision so a
 * refusal cannot be turned into consent or sent by the Runner alone.
 */
const computerAppApprovalDomain = "opensteer-computer-app-approval-v4";
export const computerAppApprovalLifetimeMs = 30_000;
export type ComputerAppApprovalDecision = "allow" | "deny";

export function createComputerAppApproval(
  privateKey: Ed25519KeySource,
  requestInput: ComputerAppSetupRequest,
  now = Date.now(),
  decision: ComputerAppApprovalDecision = "allow",
): ComputerAppApproval {
  const request = ComputerAppSetupRequestSchema.parse(requestInput);
  if (Date.parse(request.expiresAt) <= now)
    throw new Error("Computer app setup request is expired");
  const expiresAt = new Date(
    Math.min(now + computerAppApprovalLifetimeMs, Date.parse(request.expiresAt)),
  ).toISOString();
  return ComputerAppApprovalSchema.parse({
    requestId: request.id,
    expiresAt,
    signature: signProof(
      normalizeEd25519PrivateKey(privateKey, approvalKeyFailure("private")),
      computerAppApprovalTranscript(request, expiresAt, decision),
    ),
  });
}

export function verifyComputerAppApproval(input: {
  readonly approval: ComputerAppApproval;
  readonly now?: number;
  readonly publicKey: Ed25519KeySource;
  readonly request: ComputerAppSetupRequest;
  readonly decision?: ComputerAppApprovalDecision;
}): boolean {
  const request = ComputerAppSetupRequestSchema.parse(input.request);
  const approval = ComputerAppApprovalSchema.parse(input.approval);
  if (
    approval.requestId !== request.id ||
    Date.parse(approval.expiresAt) > Date.parse(request.expiresAt)
  ) {
    return false;
  }
  return verifyProof(normalizeComputerAppApprovalPublicKey(input.publicKey), {
    ...computerAppApprovalTranscript(request, approval.expiresAt, input.decision ?? "allow"),
    expiresAt: approval.expiresAt,
    now: input.now ?? Date.now(),
    signature: approval.signature,
  });
}

/** The one spelling of an approval key the Host stores: Ed25519 SPKI, PEM. */
export function canonicalComputerAppApprovalPublicKey(source: Ed25519KeySource): string {
  return normalizeComputerAppApprovalPublicKey(source)
    .export({ format: "pem", type: "spki" })
    .toString();
}

/** `sha256:<base64url>` of the key's SPKI, which the Host reports back to the Mac. */
export function computerAppApprovalKeyId(source: Ed25519KeySource): string {
  return ed25519SpkiFingerprint(normalizeComputerAppApprovalPublicKey(source));
}

export interface ComputerAppApprovalKeyChallenge {
  readonly challengeId: string;
  readonly expiresAt: string;
  readonly keyId: string;
  readonly nonce: string;
  readonly runnerId: string;
}

/** Proof that the desktop on the named Mac holds the owner-nominated key. */
export function signComputerAppApprovalKeyChallenge(
  privateKey: Ed25519KeySource,
  challenge: ComputerAppApprovalKeyChallenge,
): string {
  const normalized = normalizeEd25519PrivateKey(privateKey, approvalKeyFailure("private"));
  if (computerAppApprovalKeyId(createPublicKey(normalized)) !== challenge.keyId) {
    throw new Error("This Mac does not hold the approval key the Host asked about.");
  }
  return signProof(normalized, registrationTranscript(challenge));
}

export function verifyComputerAppApprovalKeyChallenge(input: {
  readonly challenge: ComputerAppApprovalKeyChallenge;
  readonly now?: number;
  readonly publicKey: Ed25519KeySource;
  readonly signature: string;
}): boolean {
  const publicKey = normalizeComputerAppApprovalPublicKey(input.publicKey);
  if (computerAppApprovalKeyId(publicKey) !== input.challenge.keyId) return false;
  return verifyProof(publicKey, {
    ...registrationTranscript(input.challenge),
    expiresAt: input.challenge.expiresAt,
    now: input.now ?? Date.now(),
    signature: input.signature,
  });
}

function registrationTranscript(challenge: ComputerAppApprovalKeyChallenge) {
  return {
    domain: "opensteer-computer-app-approval-key-registration-v1",
    payload: ["challenge", challenge] as const,
  };
}

function normalizeComputerAppApprovalPublicKey(source: Ed25519KeySource) {
  return normalizeEd25519PublicKey(source, approvalKeyFailure("public"));
}

function approvalKeyFailure(half: "private" | "public") {
  return (kind: "unreadable" | "not-ed25519", cause?: unknown): Error =>
    new Error(
      kind === "unreadable"
        ? `The computer app approval ${half} key is unreadable.`
        : `The computer app approval ${half} key is not Ed25519.`,
      cause === undefined ? undefined : { cause },
    );
}

function computerAppApprovalTranscript(
  request: ComputerAppSetupRequest,
  expiresAt: string,
  decision: ComputerAppApprovalDecision,
) {
  return {
    domain: computerAppApprovalDomain,
    payload: [
      "decision",
      decision,
      "request",
      request,
      "app",
      request.app,
      "expiresAt",
      expiresAt,
    ] as const,
  };
}
