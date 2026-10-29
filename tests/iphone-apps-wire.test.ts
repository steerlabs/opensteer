import { createPrivateKey, createPublicKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tokenDigest } from "../packages/core/src/crypto.js";
import { canonicalJson } from "../packages/shared/src/canonicalJson.js";
import { ComputerAppSetupRequestSchema } from "../packages/integration-core/src/models.js";
import {
  RunnerChallengeSchema,
  RunnerAuxiliaryChallengeSchema,
  RunnerBootIdSchema,
  RunnerWireProofSchema,
  RunnerIntegrationsStatusSchema,
  RunnerOperationalMessageSchema,
  RunnerAuxiliaryAuthenticateSchema,
} from "../packages/protocol/src/index.js";
import { RunnerIdSchema } from "../packages/core/src/ids.js";
import {
  canonicalComputerAppApprovalPublicKey,
  computerAppApprovalKeyId,
  createComputerAppApproval,
  signComputerAppApprovalKeyChallenge,
  verifyComputerAppApproval,
  verifyComputerAppApprovalKeyChallenge,
  canonicalRunnerPublicKeyPem,
  createRunnerAuthenticationSignature,
  createRunnerEnrollmentSignature,
  runnerPublicKeyFingerprint,
  verifyRunnerAuthenticationSignature,
  verifyRunnerEnrollmentSignature,
  createRunnerAuxiliarySignature,
  verifyRunnerAuxiliarySignature,
} from "../packages/runner-auth/src/index.js";
import { describe, expect, it } from "vitest";

// Build the production Swift vector before this native VM/CI test. Compiler
// startup is not part of the wire assertion's runtime budget.
const vectorExecutable = fileURLToPath(
  new URL("../apps/mobile/modules/iphone-apps/ios/.build/debug/IphoneAppsVectors", import.meta.url),
);

function key(seed: Uint8Array) {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return createPrivateKey({ format: "der", type: "pkcs8", key: Buffer.concat([prefix, seed]) });
}

const runnerSeed = Uint8Array.from({ length: 32 }, (_, index) => index);
const approvalSeed = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const runner = key(runnerSeed);
const approval = key(approvalSeed);
const runnerPublic = createPublicKey(runner);
const approvalPublic = createPublicKey(approval);
const now = Date.parse("2030-01-01T12:00:00.000Z");
const challenge = RunnerChallengeSchema.parse({
  type: "host.challenge" as const,
  challengeId: "rch_11111111-1111-4111-8111-111111111111",
  expiresAt: "2030-01-01T12:00:15.000Z",
  hostSessionId: "A".repeat(32),
  nonce: "B".repeat(43),
  proofFormatVersion: 2,
});
const auxiliaryChallenge = RunnerAuxiliaryChallengeSchema.parse({
  type: "host.auxiliary.challenge" as const,
  challengeId: "rch_22222222-2222-4222-8222-222222222222",
  expiresAt: "2030-01-01T12:00:15.000Z",
  hostSessionId: "C".repeat(32),
  nonce: "D".repeat(43),
  module: "integrations" as const,
});
const descriptor = {
  bootId: "rbt_33333333-3333-4333-8333-333333333333",
  capabilities: [],
  device: { form: "phone", platform: "ios" },
  modules: { integrations: { computerAppApprovals: true, platform: "ios", protocolVersion: 1 } },
  name: "iPhone — Calendar ✓",
  runnerId: "rnr_44444444-4444-4444-8444-444444444444",
  runnerKind: "local",
  runtimeVersion: "0.1.202",
};
const token = "iphone-enrollment-token-0123456789abcdefghijklmnopqrstuvwxyz";
const ticket = "eyJhbGciOiJFZERTQSJ9.eyJ4IjoxfQ.c2ln";
const approvalRequest = ComputerAppSetupRequestSchema.parse({
  access: "read-write",
  app: null,
  createdAt: "2030-01-01T11:59:00.000Z",
  definitionDigest: "sha256:test",
  definitionId: "apple-calendar",
  deploymentId: "dep_55555555-5555-4555-8555-555555555555",
  expiresAt: "2030-01-01T12:01:00.000Z",
  id: "66666666-6666-4666-8666-666666666666",
  kind: "app",
  ownerUserId: "usr_77777777-7777-4777-8777-777777777777",
  policyAppApproval: null,
  reason: "Create a meeting",
  runnerId: descriptor.runnerId,
  threadId: null,
  threadTitle: "Plan lunch",
  workspaceId: null,
  workspaceName: "Main",
});
const keyChallenge = {
  challengeId: "88888888-8888-4888-8888-888888888888",
  expiresAt: "2030-01-01T12:00:15.000Z",
  keyId: computerAppApprovalKeyId(approvalPublic),
  nonce: "E".repeat(43),
  runnerId: descriptor.runnerId,
};
const fence = {
  bootId: descriptor.bootId,
  connectionGeneration: 3,
  connectionId: "rcn_99999999-9999-4999-8999-999999999999",
  connectionLeaseId: "rls_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  runnerId: descriptor.runnerId,
  auxiliaryStreamId: "rax_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  module: "integrations" as const,
};

describe.runIf(process.env.OPENSTEER_IPHONE_APPS_NATIVE_TESTS === "1")(
  "production Swift iPhone wire against TypeScript Host",
  () => {
    it("signs and verifies both directions, and parses the emitted wire frames", () => {
      const proof = { challenge, descriptor };
      const credential = { kind: "host-enrollment-token" as const, enrollmentToken: token };
      const publicKeyPem = canonicalRunnerPublicKeyPem(runnerPublic);
      const aux = {
        bootId: RunnerBootIdSchema.parse(descriptor.bootId),
        challenge: auxiliaryChallenge,
        module: "integrations" as const,
        runnerId: RunnerIdSchema.parse(descriptor.runnerId),
        ticket,
      };
      const allow = createComputerAppApproval(approval, approvalRequest, now, "allow");
      const deny = createComputerAppApproval(approval, approvalRequest, now, "deny");
      const expected = {
        publicKeyPem,
        keyId: runnerPublicKeyFingerprint(publicKeyPem),
        approvalPublicKeyPem: canonicalComputerAppApprovalPublicKey(approvalPublic),
        approvalKeyId: computerAppApprovalKeyId(approvalPublic),
        authentication: createRunnerAuthenticationSignature(runner, proof),
        enrollment: createRunnerEnrollmentSignature(runner, { ...proof, credential, publicKeyPem }),
        auxiliary: createRunnerAuxiliarySignature(runner, aux),
        allow: allow.signature,
        deny: deny.signature,
        keyProof: signComputerAppApprovalKeyChallenge(approval, keyChallenge),
      };
      const input = {
        runnerSeed: Buffer.from(runnerSeed).toString("hex"),
        approvalSeed: Buffer.from(approvalSeed).toString("hex"),
        descriptor,
        challenge,
        auxiliaryChallenge,
        token,
        ticket,
        approvalRequest,
        answerExpiresAt: allow.expiresAt,
        keyChallenge,
        fence,
        sentAt: "2030-01-01T12:00:00.000Z",
        expected,
      };
      const output = JSON.parse(
        execFileSync(vectorExecutable, [], {
          input: JSON.stringify(input),
          maxBuffer: 2_000_000,
        }).toString(),
      ) as {
        actual: typeof expected;
        matches: Record<keyof typeof expected, boolean>;
        rejectsTampering: Record<
          string,
          { wrongKey: boolean; changedData: boolean; changedSignature: boolean }
        >;
        frames: Record<string, Record<string, unknown>>;
        keyTranscript: string;
      };
      expect(output.keyTranscript).toBe(
        canonicalJson([
          "opensteer-computer-app-approval-key-registration-v1",
          "challenge",
          keyChallenge,
        ]),
      );
      expect(output.matches).toEqual(
        Object.fromEntries(Object.keys(expected).map((key) => [key, true])),
      );
      expect(output.rejectsTampering).toEqual(
        Object.fromEntries(
          ["authentication", "enrollment", "auxiliary", "allow", "deny", "keyProof"].map((key) => [
            key,
            { wrongKey: true, changedData: true, changedSignature: true },
          ]),
        ),
      );
      expect(
        verifyRunnerAuthenticationSignature(
          runnerPublic,
          { ...proof, signature: output.actual.authentication },
          now,
        ),
      ).toBe(true);
      expect(
        verifyRunnerEnrollmentSignature(
          runnerPublic,
          { ...proof, credential, publicKeyPem, signature: output.actual.enrollment },
          now,
        ),
      ).toBe(true);
      expect(
        verifyRunnerAuxiliarySignature(
          runnerPublic,
          { ...aux, signature: output.actual.auxiliary },
          now,
        ),
      ).toBe(true);
      expect(
        verifyComputerAppApproval({
          publicKey: approvalPublic,
          request: approvalRequest,
          approval: { ...allow, signature: output.actual.allow },
          now,
          decision: "allow",
        }),
      ).toBe(true);
      expect(
        verifyComputerAppApproval({
          publicKey: approvalPublic,
          request: approvalRequest,
          approval: { ...deny, signature: output.actual.deny },
          now,
          decision: "deny",
        }),
      ).toBe(true);
      expect(
        verifyComputerAppApprovalKeyChallenge({
          publicKey: approvalPublic,
          challenge: keyChallenge,
          signature: output.actual.keyProof,
          now,
        }),
      ).toBe(true);
      expect(tokenDigest(ticket)).toMatch(/^sha256:/);
      expect(RunnerWireProofSchema.parse(output.frames.enroll).type).toBe("runner.enroll");
      expect(RunnerWireProofSchema.parse(output.frames.authenticate).type).toBe(
        "runner.authenticate",
      );
      expect(RunnerAuxiliaryAuthenticateSchema.parse(output.frames.auxiliary).type).toBe(
        "runner.auxiliary.authenticate",
      );
      expect(RunnerOperationalMessageSchema.parse(output.frames.heartbeat).type).toBe(
        "runner.heartbeat",
      );
      expect(RunnerOperationalMessageSchema.parse(output.frames.modules).type).toBe(
        "runner.modules.report",
      );
      expect(
        RunnerIntegrationsStatusSchema.parse(output.frames.status).apps.map(
          ({ definitionId }) => definitionId,
        ),
      ).toEqual([
        "apple-calendar",
        "apple-contacts",
        "apple-reminders",
        "iphone-location",
        "iphone-photos",
      ]);
    });
  },
);
