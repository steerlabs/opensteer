import { createId, OpensteerError } from "@opensteer/core";
import { RunnerBootIdSchema } from "@opensteer/protocol";
import {
  createRunnerAuthenticationSignature,
  createRunnerAuxiliarySignature,
  createRunnerEnrollmentSignature,
  hashRunnerEnrollmentToken,
  runnerPublicKeyFingerprint,
} from "@opensteer/runner-auth";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RunnerAuthenticator } from "./runner-authenticator.js";

describe("Runner v2 wire admission", () => {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const authenticator = new RunnerAuthenticator({
    issuancePrivateKey: pair.privateKey,
    store: {} as never,
  });
  function enrollment() {
    const challenge = authenticator.issueChallenge();
    const descriptor = {
      bootId: "rbt_11111111-1111-4111-8111-111111111111",
      runnerId: createId("runner"),
      runnerKind: "local",
      name: "  signed spelling  ",
      runtimeVersion: "test",
      capabilities: ["future-capability"],
      future: { nested: [true, null] },
      device: { form: "laptop", platform: "linux", future: true },
      modules: {
        browser: {
          runtimeId: "chromium",
          future: { nested: 7 },
          signIn: { version: 3, extra: true },
        },
        futureModule: { kind: "future" },
      },
    };
    const credential = { kind: "host-enrollment-token" as const, enrollmentToken: "x".repeat(40) };
    return {
      challenge,
      proof: {
        type: "runner.enroll" as const,
        proofFormatVersion: 2,
        challengeId: challenge.challengeId,
        descriptor,
        credential,
        publicKeyPem,
        signature: createRunnerEnrollmentSignature(pair.privateKey, {
          challenge,
          descriptor,
          credential,
          publicKeyPem,
        }),
      },
    };
  }
  it("verifies the raw descriptor before stripping or normalizing any advertisement", async () => {
    const { challenge, proof } = enrollment();
    const verified = await authenticator.verifyProof(challenge, proof);
    expect(verified.descriptor).toMatchObject({
      name: "signed spelling",
      capabilities: [],
      modules: { browser: { runtimeId: "chromium", signIn: { version: 3 } } },
    });
    expect(JSON.stringify(verified)).not.toContain("future");
    await expect(
      authenticator.verifyProof(challenge, {
        ...proof,
        descriptor: { ...proof.descriptor, name: "signed spelling" },
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      authenticator.verifyProof(challenge, {
        ...proof,
        descriptor: { ...proof.descriptor, future: { nested: [false, null] } },
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
  it("refuses other proof formats before enrollment or identity lookup with an update instruction", async () => {
    for (const proofFormatVersion of [undefined, 1, 3]) {
      const { challenge, proof } = enrollment();
      await expect(
        authenticator.verifyProof(challenge, { ...proof, proofFormatVersion }),
      ).rejects.toMatchObject({
        reason: "runner-proof-format-mismatch",
        message: expect.stringMatching(/update/i),
      });
    }
  });
});

describe("RunnerAuthenticator enrollment issuance", () => {
  it("returns an exact deterministic replay while giving the store only a token digest", async () => {
    const pair = generateKeyPairSync("ed25519");
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    let durable:
      | {
          readonly expiresAt: Date;
          readonly id: string;
          readonly requestFingerprint: string;
          readonly runnerKind: "main" | "local" | "managed";
          readonly tokenHash: string;
        }
      | undefined;
    const createRunnerEnrollment = vi.fn(
      async (input: {
        readonly expiresAt: Date;
        readonly id: string;
        readonly requestFingerprint: string;
        readonly runnerKind: "main" | "local" | "managed";
        readonly tokenHash: string;
      }) => {
        if (!durable) durable = input;
        else if (
          durable.requestFingerprint !== input.requestFingerprint ||
          durable.runnerKind !== input.runnerKind ||
          durable.tokenHash !== input.tokenHash
        ) {
          throw new OpensteerError({ code: "conflict", message: "idempotency conflict" });
        }
        return {
          expiresAt: durable.expiresAt,
          id: durable.id,
          runnerKind: durable.runnerKind,
          tokenHash: durable.tokenHash,
        };
      },
    );
    const authenticator = new RunnerAuthenticator({
      issuancePrivateKey: pair.privateKey,
      now: () => now,
      store: { createRunnerEnrollment } as never,
    });
    const request = {
      allowedModules: ["agents"] as const,
      createdBy: createId("user"),
      idempotencyKey: "install-example-mac-1",
      lifetimeSeconds: 600,
      name: "Alex's Mac",
      runnerKind: "local" as const,
    };

    const first = await authenticator.createEnrollment(request);
    now += 30_000;
    const replay = await authenticator.createEnrollment(request);

    expect(replay).toEqual(first);
    expect(first.enrollmentId).toBe(durable?.id);
    expect(first.token).toHaveLength(86);
    expect(durable?.tokenHash).toBe(hashRunnerEnrollmentToken(first.token));
    expect(JSON.stringify(createRunnerEnrollment.mock.calls)).not.toContain(first.token);
    await expect(
      authenticator.createEnrollment({ ...request, lifetimeSeconds: 900 }),
    ).rejects.toMatchObject({ code: "conflict" });
    // The grant is part of what a token means, so the same key asking for a
    // different set of modules is a different request, not a replay.
    await expect(
      authenticator.createEnrollment({ ...request, allowedModules: ["agents", "browser"] }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("stores a configured Main token only as a digest with a stable request fingerprint", async () => {
    const pair = generateKeyPairSync("ed25519");
    const createRunnerEnrollment = vi.fn(async (input) => input);
    const authenticator = new RunnerAuthenticator({
      issuancePrivateKey: pair.privateKey,
      store: { createRunnerEnrollment } as never,
    });
    const token = "provider-held-runner-enrollment-token";

    await authenticator.ensureConfiguredInitialMainEnrollment({
      allowedModules: ["agents"],
      idempotencyKey: "deployment-managed-main-runner",
      lifetimeSeconds: 600,
      token,
    });

    expect(createRunnerEnrollment).toHaveBeenCalledWith(
      expect.objectContaining({
        createdBy: null,
        idempotencyKey: "deployment-managed-main-runner",
        mainEnrollmentPurpose: "initial",
        runnerKind: "main",
        tokenHash: hashRunnerEnrollmentToken(token),
      }),
    );
    expect(JSON.stringify(createRunnerEnrollment.mock.calls)).not.toContain(token);
  });

  it("refuses an auxiliary ticket for a module the enrollment never granted", () => {
    const pair = generateKeyPairSync("ed25519");
    const authenticator = new RunnerAuthenticator({
      issuancePrivateKey: pair.privateKey,
      store: {} as never,
    });
    const identity = {
      allowedModules: ["agents"],
      bootId: RunnerBootIdSchema.parse("rbt_11111111-1111-4111-8111-111111111111"),
      connectionGeneration: 1,
      connectionId: "rcn_11111111-1111-4111-8111-111111111111",
      modules: { browser: { wireVersion: 2 as const, runtimeId: "chromium" } },
      runnerId: createId("runner"),
    } as never;

    expect(() => authenticator.issueAuxiliaryTicket(identity, "browser")).toThrow(
      /does not allow the browser module/u,
    );
  });

  it("burns an auxiliary ticket so it can open exactly one stream", async () => {
    const pair = generateKeyPairSync("ed25519");
    const runnerPair = generateKeyPairSync("ed25519");
    const runnerId = createId("runner");
    const bootId = RunnerBootIdSchema.parse("rbt_11111111-1111-4111-8111-111111111111");
    const authenticator = new RunnerAuthenticator({
      issuancePrivateKey: pair.privateKey,
      store: {
        runnerForAuthentication: async () => ({
          allowedModules: ["browser"],
          connectionGeneration: 3,
          environmentIds: [],
          publicKeyFingerprint: runnerPublicKeyFingerprint(runnerPair.publicKey),
          publicKeyPem: runnerPair.publicKey.export({ format: "pem", type: "spki" }).toString(),
          revokedAt: null,
          runnerId,
          runnerKind: "managed",
        }),
      } as never,
    });
    const identity = {
      allowedModules: ["browser"],
      bootId,
      connectionGeneration: 3,
      connectionId: "rcn_11111111-1111-4111-8111-111111111111",
      modules: { browser: { wireVersion: 2 as const, runtimeId: "chromium" } },
      runnerId,
    } as never;
    const { ticket } = authenticator.issueAuxiliaryTicket(identity, "browser");
    const challenge = authenticator.issueAuxiliaryChallenge("browser");
    const proof = {
      bootId,
      challengeId: challenge.challengeId,
      module: "browser",
      runnerId,
      signature: createRunnerAuxiliarySignature(runnerPair.privateKey, {
        bootId,
        challenge,
        module: "browser",
        runnerId,
        ticket,
      }),
      ticket,
    } as never;

    await expect(authenticator.verifyAuxiliary(challenge, proof)).resolves.toMatchObject({
      module: "browser",
    });
    const second = authenticator.issueAuxiliaryChallenge("browser");
    await expect(
      authenticator.verifyAuxiliary(second, {
        ...(proof as object),
        challengeId: second.challengeId,
        signature: createRunnerAuxiliarySignature(runnerPair.privateKey, {
          bootId,
          challenge: second,
          module: "browser",
          runnerId,
          ticket,
        }),
      } as never),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("RunnerAuthenticator identity refusals", () => {
  const runnerId = createId("runner");
  const runnerPair = generateKeyPairSync("ed25519");

  function authenticatorFor(runner: Record<string, unknown> | null) {
    return new RunnerAuthenticator({
      issuancePrivateKey: generateKeyPairSync("ed25519").privateKey,
      store: { runnerForAuthentication: async () => runner } as never,
    });
  }

  function proofFor(authenticator: RunnerAuthenticator) {
    const challenge = authenticator.issueChallenge();
    const descriptor = {
      bootId: RunnerBootIdSchema.parse("rbt_11111111-1111-4111-8111-111111111111"),
      capabilities: [],
      modules: { browser: { wireVersion: 2 as const, runtimeId: "chromium" } },
      name: "Studio Mac",
      runnerId,
      runnerKind: "local" as const,
      runtimeVersion: "test",
    };
    return {
      challenge,
      proof: {
        challengeId: challenge.challengeId,
        descriptor,
        signature: createRunnerAuthenticationSignature(runnerPair.privateKey, {
          challenge,
          descriptor,
        }),
        proofFormatVersion: 2,
        type: "runner.authenticate",
      } as never,
    };
  }

  const enrolled = {
    deviceProfile: null,
    allowedModules: ["browser"],
    connectionGeneration: 3,
    environmentIds: [],
    publicKeyFingerprint: runnerPublicKeyFingerprint(runnerPair.publicKey),
    publicKeyPem: runnerPair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    revokedAt: null,
    runnerId,
    runnerKind: "local",
  };

  it("authenticates a legacy browser descriptor without losing its other modules", async () => {
    const environmentId = createId("environment");
    const descriptor = {
      bootId: RunnerBootIdSchema.parse("rbt_11111111-1111-4111-8111-111111111111"),
      capabilities: [],
      modules: {
        agents: {
          environmentIds: [environmentId],
          harnessDrivers: [],
          localStorage: null,
          maxConcurrentRuns: 1,
          providerStateModes: ["isolated"],
          workspaceBackings: ["portablefs"],
          workspaceMounts: [],
        },
        browser: { runtimeId: "older-browser" },
        integrations: { platform: "darwin" },
        shell: {
          platform: "darwin",
          hostPublicKey:
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          fullDiskAccess: false,
        },
      },
      name: "Studio Mac",
      runnerId,
      runnerKind: "local" as const,
      runtimeVersion: "older-build",
    };
    const authenticateRunnerConnection = vi.fn(async () => ({
      allowedModules: ["agents", "browser", "integrations", "shell"],
      connectionGeneration: 4,
      personalRemoteAccessGeneration: null,
    }));
    const authenticator = new RunnerAuthenticator({
      issuancePrivateKey: generateKeyPairSync("ed25519").privateKey,
      store: {
        authenticateRunnerConnection,
        runnerForAuthentication: async () => ({
          ...enrolled,
          allowedModules: ["agents", "browser", "integrations", "shell"],
          environmentIds: [environmentId],
          publicKeyFingerprint: runnerPublicKeyFingerprint(runnerPair.publicKey),
        }),
      } as never,
    });
    const challenge = authenticator.issueChallenge();
    const proof = {
      challengeId: challenge.challengeId,
      descriptor,
      signature: createRunnerAuthenticationSignature(runnerPair.privateKey, {
        challenge,
        descriptor: descriptor as never,
      }),
      proofFormatVersion: 2,
      type: "runner.authenticate",
    } as never;

    await expect(authenticator.authenticate(challenge, proof)).resolves.toMatchObject({
      environmentIds: [environmentId],
      modules: {
        agents: expect.any(Object),
        browser: { runtimeId: "older-browser" },
        integrations: { platform: "darwin" },
        shell: expect.any(Object),
      },
    });
    expect(authenticateRunnerConnection).toHaveBeenCalledWith(descriptor);
  });

  it("says a retired identity apart from every other refusal", async () => {
    const authenticator = authenticatorFor({ ...enrolled, revokedAt: new Date() });
    const { challenge, proof } = proofFor(authenticator);

    // The one answer a Runner must not retry, and the only one the computer
    // supervising it clears its slot on — so it carries a discriminator rather
    // than prose a reader would have to match.
    await expect(authenticator.authenticate(challenge, proof)).rejects.toMatchObject({
      message: "Runner identity was revoked",
      reason: "runner-identity-revoked",
    });
  });

  it("tells an unknown or mismatched identity nothing beyond that it failed", async () => {
    for (const runner of [null, { ...enrolled, runnerKind: "managed" }]) {
      const authenticator = authenticatorFor(runner);
      const { challenge, proof } = proofFor(authenticator);
      const refusal = await authenticator
        .authenticate(challenge, proof)
        .then(() => undefined)
        .catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(OpensteerError);
      expect(refusal).toMatchObject({
        code: "unauthorized",
        message: "Runner authentication failed",
      });
      // No discriminator: an unauthenticated caller learns only that it failed,
      // and nothing downstream may read this as a revocation.
      expect((refusal as OpensteerError).reason).toBeUndefined();
    }
  });
});
