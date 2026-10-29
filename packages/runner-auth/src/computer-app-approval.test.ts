import { generateKeyPairSync } from "node:crypto";
import { ComputerAppSetupRequestSchema } from "@opensteer/integration-core";
import { describe, expect, it } from "vitest";
import {
  canonicalComputerAppApprovalPublicKey,
  computerAppApprovalKeyId,
  createComputerAppApproval,
  signComputerAppApprovalKeyChallenge,
  verifyComputerAppApproval,
  verifyComputerAppApprovalKeyChallenge,
} from "./computer-app-approval.js";

const app = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: null } as const;

const request = ComputerAppSetupRequestSchema.parse({
  access: "read-write",
  app,
  createdAt: "2026-09-19T18:00:00.000Z",
  definitionDigest: "sha256:test",
  definitionId: "macos-app",
  deploymentId: "dep_00000000-0000-4000-8000-000000000001",
  expiresAt: "2026-09-26T18:00:00.000Z",
  id: "00000000-0000-4000-8000-000000000002",
  kind: "app",
  ownerUserId: "usr_00000000-0000-4000-8000-000000000003",
  policyAppApproval: null,
  reason: null,
  runnerId: "rnr_00000000-0000-4000-8000-000000000004",
  threadId: null,
  threadTitle: null,
  workspaceId: null,
  workspaceName: "Main",
});

describe("computer app approval proof", () => {
  it("binds every request field and expires after thirty seconds", () => {
    const pair = generateKeyPairSync("ed25519");
    const now = Date.parse("2026-09-19T18:01:00.000Z");
    const approval = createComputerAppApproval(pair.privateKey, request, now);
    expect(approval.expiresAt).toBe("2026-09-19T18:01:30.000Z");
    expect(
      verifyComputerAppApproval({
        publicKey: pair.publicKey,
        request,
        approval,
        now: now + 29_999,
      }),
    ).toBe(true);
    expect(
      verifyComputerAppApproval({
        publicKey: pair.publicKey,
        request,
        approval,
        now: now + 30_001,
      }),
    ).toBe(false);
    expect(
      verifyComputerAppApproval({
        publicKey: pair.publicKey,
        request: { ...request, access: "read" },
        approval,
        now,
      }),
    ).toBe(false);
  });

  /**
   * The app is the authority the person approved, so every part of it is in
   * the transcript: another app, another build of the same app, or the same
   * app under a name the person never read is a different approval.
   */
  it("binds the app identity the person confirmed", () => {
    const pair = generateKeyPairSync("ed25519");
    const now = Date.parse("2026-09-19T18:01:00.000Z");
    const approval = createComputerAppApproval(pair.privateKey, request, now);
    const rejected = [
      { ...app, bundleId: "com.apple.Reminders" },
      { ...app, displayName: "Reminders" },
      { ...app, teamId: "ABCDE12345" },
      null,
    ];
    for (const app of rejected) {
      expect(
        verifyComputerAppApproval({
          publicKey: pair.publicKey,
          request: { ...request, app },
          approval,
          now,
        }),
      ).toBe(false);
    }
    expect(verifyComputerAppApproval({ publicKey: pair.publicKey, request, approval, now })).toBe(
      true,
    );
  });

  it("binds the workspace label the person saw", () => {
    const pair = generateKeyPairSync("ed25519");
    const now = Date.parse("2026-09-19T18:01:00.000Z");
    const approval = createComputerAppApproval(pair.privateKey, request, now);
    expect(
      verifyComputerAppApproval({
        approval,
        now,
        publicKey: pair.publicKey,
        request: { ...request, workspaceName: "Forged workspace" },
      }),
    ).toBe(false);
  });

  it("verifies only against the approval key it was signed with", () => {
    const approvalKey = generateKeyPairSync("ed25519");
    const runnerKey = generateKeyPairSync("ed25519");
    const now = Date.parse("2026-09-19T18:01:00.000Z");
    const byRunner = createComputerAppApproval(runnerKey.privateKey, request, now);
    expect(
      verifyComputerAppApproval({
        approval: byRunner,
        now,
        publicKey: canonicalComputerAppApprovalPublicKey(approvalKey.publicKey),
        request,
      }),
    ).toBe(false);
    const pem = canonicalComputerAppApprovalPublicKey(approvalKey.publicKey);
    expect(pem).toMatch(/^-----BEGIN PUBLIC KEY-----\n/u);
    expect(computerAppApprovalKeyId(pem)).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/u);
    expect(computerAppApprovalKeyId(pem)).not.toBe(computerAppApprovalKeyId(runnerKey.publicKey));
  });

  it("binds a refusal separately from consent", () => {
    const pair = generateKeyPairSync("ed25519");
    const now = Date.parse("2026-09-19T18:01:00.000Z");
    const denial = createComputerAppApproval(pair.privateKey, request, now, "deny");
    expect(
      verifyComputerAppApproval({
        approval: denial,
        decision: "deny",
        now,
        publicKey: pair.publicKey,
        request,
      }),
    ).toBe(true);
    expect(
      verifyComputerAppApproval({
        approval: denial,
        now,
        publicKey: pair.publicKey,
        request,
      }),
    ).toBe(false);
  });

  it("proves only the nominated key on one Mac for one live challenge", () => {
    const pair = generateKeyPairSync("ed25519");
    const other = generateKeyPairSync("ed25519");
    const now = Date.parse("2026-09-19T18:01:00.000Z");
    const challenge = {
      challengeId: "00000000-0000-4000-8000-000000000005",
      expiresAt: new Date(now + 10_000).toISOString(),
      keyId: computerAppApprovalKeyId(pair.publicKey),
      nonce: "n".repeat(43),
      runnerId: request.runnerId,
    };
    const signature = signComputerAppApprovalKeyChallenge(pair.privateKey, challenge);
    expect(
      verifyComputerAppApprovalKeyChallenge({
        challenge,
        now,
        publicKey: pair.publicKey,
        signature,
      }),
    ).toBe(true);
    expect(
      verifyComputerAppApprovalKeyChallenge({
        challenge: { ...challenge, runnerId: "another" },
        now,
        publicKey: pair.publicKey,
        signature,
      }),
    ).toBe(false);
    expect(
      verifyComputerAppApprovalKeyChallenge({
        challenge: { ...challenge, nonce: "m".repeat(43) },
        now,
        publicKey: pair.publicKey,
        signature,
      }),
    ).toBe(false);
    expect(
      verifyComputerAppApprovalKeyChallenge({
        challenge,
        now: now + 10_001,
        publicKey: pair.publicKey,
        signature,
      }),
    ).toBe(false);
    expect(() => signComputerAppApprovalKeyChallenge(other.privateKey, challenge)).toThrow(
      /does not hold/u,
    );
  });
});
