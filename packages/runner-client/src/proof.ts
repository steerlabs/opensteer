import {
  runnerProofFormatVersion,
  runnerProofFormatUpdateReason,
  type RunnerChallenge,
  type RunnerDescriptor,
  type RunnerEnrollmentCredential,
  type RunnerProof,
} from "@opensteer/protocol";
import {
  createRunnerAuthenticationSignature,
  createRunnerEnrollmentSignature,
} from "@opensteer/runner-auth";
import { OpensteerError } from "@opensteer/core";
import type { KeyObject } from "node:crypto";

/**
 * The identity proof a Runner answers the Host's challenge with.
 *
 * A Runner that has connected before signs with its persisted key. If the Host
 * no longer recognises that key — most often because its database was reset out
 * from under a Runner whose identity file survived — the stored identity is
 * worthless, and a Runner holding a fresh enrollment credential must be able to
 * use it rather than retrying a rejected key forever.
 */
export function runnerIdentityProof(input: {
  readonly challenge: RunnerChallenge;
  readonly credential: RunnerEnrollmentCredential | undefined;
  readonly descriptor: RunnerDescriptor;
  readonly enrolled: boolean;
  readonly privateKey: KeyObject;
  readonly publicKeyPem: string;
}): RunnerProof {
  const { challenge } = input;
  if (challenge.proofFormatVersion !== runnerProofFormatVersion)
    throw new OpensteerError({
      code: "forbidden",
      reason: "runner-proof-format-mismatch",
      message: runnerProofFormatUpdateReason,
    });
  // Snapshot JSON once: signatures cover the exact value sent, before readers apply defaults.
  const descriptor: RunnerDescriptor = JSON.parse(JSON.stringify(input.descriptor));
  if (input.enrolled) {
    return {
      proofFormatVersion: runnerProofFormatVersion,
      challengeId: challenge.challengeId,
      descriptor,
      signature: createRunnerAuthenticationSignature(input.privateKey, { challenge, descriptor }),
      type: "runner.authenticate",
    };
  }
  const credential = input.credential;
  if (!credential) {
    throw new Error(
      "Runner is not enrolled and no enrollment credential is configured; set OPENSTEER_RUNNER_ENROLLMENT_TOKEN",
    );
  }
  return {
    proofFormatVersion: runnerProofFormatVersion,
    challengeId: challenge.challengeId,
    credential,
    descriptor,
    publicKeyPem: input.publicKeyPem,
    signature: createRunnerEnrollmentSignature(input.privateKey, {
      challenge,
      credential,
      descriptor,
      publicKeyPem: input.publicKeyPem,
    }),
    type: "runner.enroll",
  };
}

export function runnerEnrollmentCredential(
  token: string | undefined,
): RunnerEnrollmentCredential | undefined {
  return token ? { enrollmentToken: token, kind: "host-enrollment-token" } : undefined;
}
