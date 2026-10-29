import type { KeyObject } from "node:crypto";
import { ed25519SpkiFingerprint, tokenDigest } from "@opensteer/core/crypto";
import type { RunnerChallenge, RunnerEnrollmentCredential } from "@opensteer/protocol";
import {
  normalizeEd25519PrivateKey,
  normalizeEd25519PublicKey,
  signProof,
  verifyProof,
  type Ed25519KeyFailure,
  type Ed25519KeySource,
} from "@opensteer/shared/proof";

const authenticationDomain = "opensteer-runner-auth-v2";
const enrollmentDomain = "opensteer-runner-enroll-v2";

interface ProofContext {
  readonly challenge: RunnerChallenge;
  readonly descriptor: unknown;
}

interface EnrollmentProofContext extends ProofContext {
  readonly credential: RunnerEnrollmentCredential;
  readonly publicKeyPem: string;
}

export function createRunnerAuthenticationSignature(
  privateKey: Ed25519KeySource,
  input: ProofContext,
): string {
  return signProof(
    normalizeRunnerPrivateKey(privateKey),
    transcript(authenticationDomain, input, []),
  );
}

export function verifyRunnerAuthenticationSignature(
  publicKey: Ed25519KeySource,
  input: ProofContext & { readonly signature: string },
  now = Date.now(),
): boolean {
  return verifyProof(normalizeRunnerEd25519PublicKey(publicKey), {
    ...transcript(authenticationDomain, input, []),
    expiresAt: input.challenge.expiresAt,
    now,
    signature: input.signature,
  });
}

export function createRunnerEnrollmentSignature(
  privateKey: Ed25519KeySource,
  input: EnrollmentProofContext,
): string {
  return signProof(normalizeRunnerPrivateKey(privateKey), enrollmentTranscript(input));
}

export function verifyRunnerEnrollmentSignature(
  publicKey: Ed25519KeySource,
  input: EnrollmentProofContext & { readonly signature: string },
  now = Date.now(),
): boolean {
  return verifyProof(normalizeRunnerEd25519PublicKey(publicKey), {
    ...enrollmentTranscript(input),
    expiresAt: input.challenge.expiresAt,
    now,
    signature: input.signature,
  });
}

export function hashRunnerEnrollmentToken(token: string): string {
  return tokenDigest(token);
}

function enrollmentTranscript(input: EnrollmentProofContext): ProofTranscript {
  const publicKeyFingerprint = runnerPublicKeyFingerprint(input.publicKeyPem);
  return transcript(enrollmentDomain, input, [
    "publicKeyFingerprint",
    publicKeyFingerprint,
    "enrollmentTokenHash",
    hashRunnerEnrollmentToken(input.credential.enrollmentToken),
  ]);
}

export function normalizeRunnerEd25519PublicKey(source: Ed25519KeySource): KeyObject {
  return normalizeEd25519PublicKey(source, runnerKeyFailure("public"));
}

export function canonicalRunnerPublicKeyPem(source: Ed25519KeySource): string {
  return normalizeRunnerEd25519PublicKey(source).export({ format: "pem", type: "spki" }).toString();
}

export function runnerPublicKeyFingerprint(source: Ed25519KeySource): string {
  return ed25519SpkiFingerprint(normalizeRunnerEd25519PublicKey(source));
}

interface ProofTranscript {
  readonly domain: string;
  readonly payload: readonly unknown[];
}

function transcript(domain: string, input: ProofContext, tail: readonly string[]): ProofTranscript {
  return {
    domain,
    payload: [
      "challengeId",
      input.challenge.challengeId,
      "challengeNonce",
      input.challenge.nonce,
      "hostSessionId",
      input.challenge.hostSessionId,
      "challengeExpiresAt",
      input.challenge.expiresAt,
      "descriptor",
      input.descriptor,
      ...tail,
    ],
  };
}

export function normalizeRunnerPrivateKey(source: Ed25519KeySource): KeyObject {
  return normalizeEd25519PrivateKey(source, runnerKeyFailure("private"));
}

function runnerKeyFailure(role: "public" | "private"): Ed25519KeyFailure {
  return (kind, cause) =>
    kind === "unreadable"
      ? new Error(`Runner ${role} key is invalid`, { cause })
      : new Error(`Runner ${role} key must be Ed25519`);
}
