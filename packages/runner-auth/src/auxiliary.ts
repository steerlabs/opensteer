import { tokenDigest } from "@opensteer/core/crypto";
import type { RunnerId } from "@opensteer/core";
import type {
  RunnerAuxiliaryChallenge,
  RunnerAuxiliaryModule,
  RunnerBootId,
} from "@opensteer/protocol";
import { signProof, verifyProof, type Ed25519KeySource } from "@opensteer/shared/proof";
import { normalizeRunnerEd25519PublicKey, normalizeRunnerPrivateKey } from "./proof.js";

const auxiliaryDomain = "opensteer-runner-auxiliary-v1";

/**
 * An auxiliary ticket is a bearer value: whoever holds it can present it. The
 * stream is therefore admitted only when the holder also signs the Host's fresh
 * challenge together with the ticket's digest using the Runner private key, so
 * a leaked ticket alone opens nothing.
 */
export interface RunnerAuxiliaryProofContext {
  readonly bootId: RunnerBootId;
  readonly challenge: RunnerAuxiliaryChallenge;
  readonly module: RunnerAuxiliaryModule;
  readonly runnerId: RunnerId;
  readonly ticket: string;
}

export function runnerAuxiliaryTicketDigest(ticket: string): string {
  return tokenDigest(ticket);
}

export function createRunnerAuxiliarySignature(
  privateKey: Ed25519KeySource,
  input: RunnerAuxiliaryProofContext,
): string {
  return signProof(normalizeRunnerPrivateKey(privateKey), auxiliaryTranscript(input));
}

export function verifyRunnerAuxiliarySignature(
  publicKey: Ed25519KeySource,
  input: RunnerAuxiliaryProofContext & { readonly signature: string },
  now = Date.now(),
): boolean {
  return verifyProof(normalizeRunnerEd25519PublicKey(publicKey), {
    ...auxiliaryTranscript(input),
    expiresAt: input.challenge.expiresAt,
    now,
    signature: input.signature,
  });
}

function auxiliaryTranscript(input: RunnerAuxiliaryProofContext): {
  readonly domain: string;
  readonly payload: readonly unknown[];
} {
  return {
    domain: auxiliaryDomain,
    payload: [
      "challengeId",
      input.challenge.challengeId,
      "challengeNonce",
      input.challenge.nonce,
      "hostSessionId",
      input.challenge.hostSessionId,
      "challengeExpiresAt",
      input.challenge.expiresAt,
      "challengeModule",
      input.challenge.module,
      "runnerId",
      input.runnerId,
      "bootId",
      input.bootId,
      "module",
      input.module,
      "ticketDigest",
      runnerAuxiliaryTicketDigest(input.ticket),
    ],
  };
}
