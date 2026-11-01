import { HarnessIdSchema, ThreadAccessModeSchema, createId } from "@opensteer/core";
import {
  type RunnerAuxiliaryChallenge,
  type RunnerChallenge,
  type RunnerDescriptor,
  type RunnerEnrollmentCredential,
} from "@opensteer/protocol";
import { canonicalJson } from "@opensteer/shared/canonicalJson";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRunnerAuxiliarySignature, verifyRunnerAuxiliarySignature } from "./auxiliary.js";
import {
  createRunnerAuthenticationSignature,
  createRunnerEnrollmentSignature,
  hashRunnerEnrollmentToken,
  runnerPublicKeyFingerprint,
  verifyRunnerAuthenticationSignature,
  verifyRunnerEnrollmentSignature,
} from "./proof.js";

describe("Runner identity proofs", () => {
  it("binds native browser and video descriptor fields", () => {
    const pair = generateKeyPairSync("ed25519");
    const base = descriptor();
    for (const modules of [
      { browser: { runtimeId: "browser", targetControl: 1 as const, captureRegion: 1 as const } },
      {
        integrations: {
          platform: "darwin" as const,
          protocolVersion: 5,
          macWindowVideoVersion: 1 as const,
        },
      },
    ]) {
      const input = { challenge: challenge(), descriptor: { ...base, modules } };
      const signature = createRunnerAuthenticationSignature(pair.privateKey, input);
      expect(verifyRunnerAuthenticationSignature(pair.publicKey, { ...input, signature })).toBe(
        true,
      );
      const stripped = modules.browser
        ? { browser: { runtimeId: "browser" } }
        : { integrations: { platform: "darwin" as const, protocolVersion: 5 } };
      expect(
        verifyRunnerAuthenticationSignature(pair.publicKey, {
          ...input,
          descriptor: { ...base, modules: stripped },
          signature,
        }),
      ).toBe(false);
    }
  });

  // The new wire shape cannot be claimed by changing an old signed hello,
  // nor may a proxy remove the version or desktop capability from a new one.
  it("signs the integrations protocol version and its desktop approval capability", () => {
    const pair = generateKeyPairSync("ed25519");
    for (const protocolVersion of [undefined, 2]) {
      const integrations = {
        platform: "darwin" as const,
        computerAppApprovals: true as const,
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
      };
      const input = {
        challenge: challenge(),
        descriptor: { ...descriptor(), modules: { integrations } },
      };
      const signature = createRunnerAuthenticationSignature(pair.privateKey, input);
      expect(verifyRunnerAuthenticationSignature(pair.publicKey, { ...input, signature })).toBe(
        true,
      );
      for (const changed of [
        { ...integrations, ownerViewVersion: 1 },
        { ...integrations, protocolVersion: protocolVersion === undefined ? 2 : 3 },
        ...(protocolVersion === undefined
          ? []
          : [
              { platform: "darwin" as const, protocolVersion: 2 },
              { platform: "darwin" as const, computerAppApprovals: true as const },
            ]),
      ]) {
        expect(
          verifyRunnerAuthenticationSignature(pair.publicKey, {
            ...input,
            descriptor: { ...input.descriptor, modules: { integrations: changed } },
            signature,
          }),
        ).toBe(false);
      }
    }
  });

  it("binds authentication to the challenged module descriptor", () => {
    const pair = generateKeyPairSync("ed25519");
    const input = { challenge: challenge(), descriptor: descriptor() };
    const signature = createRunnerAuthenticationSignature(pair.privateKey, input);
    expect(verifyRunnerAuthenticationSignature(pair.publicKey, { ...input, signature })).toBe(true);
    expect(
      verifyRunnerAuthenticationSignature(pair.publicKey, {
        ...input,
        descriptor: withAgents(input.descriptor, { environmentIds: [createId("environment")] }),
        signature,
      }),
    ).toBe(false);
    expect(
      verifyRunnerAuthenticationSignature(pair.publicKey, {
        ...input,
        descriptor: withAgents(input.descriptor, { workspaceBackings: ["portablefs"] }),
        signature,
      }),
    ).toBe(false);
  });

  it("refuses a module the proof never covered", () => {
    const pair = generateKeyPairSync("ed25519");
    const input = { challenge: challenge(), descriptor: descriptor() };
    const signature = createRunnerAuthenticationSignature(pair.privateKey, input);
    expect(
      verifyRunnerAuthenticationSignature(pair.publicKey, {
        ...input,
        descriptor: {
          ...input.descriptor,
          modules: {
            ...input.descriptor.modules,
            browser: { wireVersion: 2, runtimeId: "smuggled" },
          },
        },
        signature,
      }),
    ).toBe(false);
  });

  it("refuses a browser runtime swapped underneath a signed descriptor", () => {
    const pair = generateKeyPairSync("ed25519");
    const browserOnly: RunnerDescriptor = {
      ...descriptor(),
      modules: { browser: { wireVersion: 2, runtimeId: "chromium-a" } },
    };
    const input = { challenge: challenge(), descriptor: browserOnly };
    const signature = createRunnerAuthenticationSignature(pair.privateKey, input);
    expect(verifyRunnerAuthenticationSignature(pair.publicKey, { ...input, signature })).toBe(true);
    expect(
      verifyRunnerAuthenticationSignature(pair.publicKey, {
        ...input,
        descriptor: {
          ...browserOnly,
          modules: { browser: { wireVersion: 2, runtimeId: "chromium-b" } },
        },
        signature,
      }),
    ).toBe(false);
  });

  it("signs the complete canonical wire descriptor with a v2 domain", () => {
    const pair = generateKeyPairSync("ed25519");
    const input = {
      challenge: challenge(),
      descriptor: { ...descriptor(), future: { nested: ["é", null, true] } },
    };
    const expected = sign(
      null,
      Buffer.from(
        canonicalJson([
          "opensteer-runner-auth-v2",
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
        ]),
      ),
      pair.privateKey,
    ).toString("base64url");
    expect(createRunnerAuthenticationSignature(pair.privateKey, input)).toBe(expected);
  });

  it("rejects tampering at every known and unknown descriptor leaf for both proofs", () => {
    const pair = generateKeyPairSync("ed25519");
    const input = {
      challenge: challenge(),
      credential: { kind: "host-enrollment-token" as const, enrollmentToken: "x".repeat(40) },
      publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      descriptor: {
        ...descriptor(),
        name: "  wire spelling  ",
        future: { nested: [null, true, 7, "é😀"] },
        modules: {
          ...descriptor().modules,
          shell: {
            hostPublicKey: "signed host key",
            platform: "darwin",
            fullDiskAccess: true,
            future: { version: 7 },
          },
          futureModule: { kind: "unknown", nested: { value: "signed" } },
        },
      },
    };
    const auth = createRunnerAuthenticationSignature(pair.privateKey, input);
    const enroll = createRunnerEnrollmentSignature(pair.privateKey, input);
    function* mutations(value: unknown): Generator<unknown> {
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++)
          for (const changed of mutations(value[index]))
            yield value.map((entry, i) => (i === index ? changed : entry));
      } else if (value !== null && typeof value === "object") {
        for (const [key, entry] of Object.entries(value))
          for (const changed of mutations(entry)) yield { ...value, [key]: changed };
        yield { ...value, unsignedAddition: true };
      } else
        yield value === null
          ? "changed"
          : typeof value === "boolean"
            ? !value
            : typeof value === "number"
              ? value + 1
              : `${value}changed`;
    }
    for (const changed of mutations(input.descriptor)) {
      expect(
        verifyRunnerAuthenticationSignature(pair.publicKey, {
          ...input,
          descriptor: changed,
          signature: auth,
        }),
      ).toBe(false);
      expect(
        verifyRunnerEnrollmentSignature(pair.publicKey, {
          ...input,
          descriptor: changed,
          signature: enroll,
        }),
      ).toBe(false);
    }
  });

  it("refuses an integrations platform swapped underneath a signed descriptor", () => {
    const pair = generateKeyPairSync("ed25519");
    const integrationsOnly: RunnerDescriptor = {
      ...descriptor(),
      modules: { integrations: { platform: "darwin" } },
    };
    const input = { challenge: challenge(), descriptor: integrationsOnly };
    const signature = createRunnerAuthenticationSignature(pair.privateKey, input);
    expect(verifyRunnerAuthenticationSignature(pair.publicKey, { ...input, signature })).toBe(true);
    expect(
      verifyRunnerAuthenticationSignature(pair.publicKey, {
        ...input,
        descriptor: { ...integrationsOnly, modules: { integrations: { platform: "linux" } } },
        signature,
      }),
    ).toBe(false);
  });

  it("binds enrollment to the token digest and public key", () => {
    const pair = generateKeyPairSync("ed25519");
    const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const enrollmentToken = "runner-enrollment-token-with-at-least-32-characters";
    const input = {
      challenge: challenge(),
      credential: { enrollmentToken, kind: "host-enrollment-token" },
      descriptor: descriptor(),
      publicKeyPem,
    } satisfies EnrollmentInput;
    const signature = createRunnerEnrollmentSignature(pair.privateKey, input);
    expect(verifyRunnerEnrollmentSignature(pair.publicKey, { ...input, signature })).toBe(true);
    expect(
      verifyRunnerEnrollmentSignature(pair.publicKey, {
        ...input,
        credential: {
          enrollmentToken: "different-runner-enrollment-token-with-entropy",
          kind: "host-enrollment-token",
        },
        signature,
      }),
    ).toBe(false);
    expect(
      verifyRunnerEnrollmentSignature(pair.publicKey, {
        ...input,
        descriptor: withAgents(input.descriptor, { workspaceBackings: ["portablefs"] }),
        signature,
      }),
    ).toBe(false);
    expect(hashRunnerEnrollmentToken(enrollmentToken)).toMatch(/^sha256:/);
    expect(runnerPublicKeyFingerprint(pair.publicKey)).toMatch(/^sha256:/);
  });

  it("preserves wire array order for authentication and enrollment", () => {
    const pair = generateKeyPairSync("ed25519");
    const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const firstDescriptor = descriptor();
    const agents = firstDescriptor.modules.agents;
    if (!agents) throw new Error("The fixture descriptor must advertise agents");
    const secondDescriptor = withAgents(firstDescriptor, {
      workspaceBackings: [...agents.workspaceBackings].reverse(),
    });
    const shared = { challenge: challenge() };

    const authenticationSignature = createRunnerAuthenticationSignature(pair.privateKey, {
      ...shared,
      descriptor: firstDescriptor,
    });
    expect(
      createRunnerAuthenticationSignature(pair.privateKey, {
        ...shared,
        descriptor: secondDescriptor,
      }),
    ).not.toBe(authenticationSignature);
    expect(
      verifyRunnerAuthenticationSignature(pair.publicKey, {
        ...shared,
        descriptor: secondDescriptor,
        signature: authenticationSignature,
      }),
    ).toBe(false);

    const enrollmentInput = {
      ...shared,
      credential: {
        enrollmentToken: "runner-enrollment-token-with-at-least-32-characters",
        kind: "host-enrollment-token",
      },
      descriptor: firstDescriptor,
      publicKeyPem,
    } satisfies EnrollmentInput;
    const enrollmentSignature = createRunnerEnrollmentSignature(pair.privateKey, enrollmentInput);
    expect(
      verifyRunnerEnrollmentSignature(pair.publicKey, {
        ...enrollmentInput,
        descriptor: secondDescriptor,
        signature: enrollmentSignature,
      }),
    ).toBe(false);
  });
});

describe("Runner auxiliary stream proofs", () => {
  it("binds the stream to the ticket it presents", () => {
    const pair = generateKeyPairSync("ed25519");
    const input = {
      bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
      challenge: auxiliaryChallenge(),
      module: "browser",
      runnerId: createId("runner"),
      ticket: "header.payload.signature",
    } as const;
    const signature = createRunnerAuxiliarySignature(pair.privateKey, input);
    expect(verifyRunnerAuxiliarySignature(pair.publicKey, { ...input, signature })).toBe(true);
    expect(
      verifyRunnerAuxiliarySignature(pair.publicKey, {
        ...input,
        signature,
        ticket: "header.another.signature",
      }),
    ).toBe(false);
    expect(
      verifyRunnerAuxiliarySignature(pair.publicKey, {
        ...input,
        module: "messaging",
        signature,
      }),
    ).toBe(false);
  });
});

interface EnrollmentInput {
  readonly challenge: RunnerChallenge;
  readonly credential: RunnerEnrollmentCredential;
  readonly descriptor: RunnerDescriptor;
  readonly publicKeyPem: string;
}

function challenge(): RunnerChallenge {
  return {
    challengeId: `rch_${randomUUID()}` as RunnerChallenge["challengeId"],
    expiresAt: new Date(Date.now() + 10_000).toISOString(),
    hostSessionId: "host-session-identifier-with-entropy",
    nonce: "challenge-nonce-with-at-least-thirty-two-characters",
    proofFormatVersion: 2,
    type: "host.challenge",
  };
}

function auxiliaryChallenge(): RunnerAuxiliaryChallenge {
  return {
    challengeId: `rch_${randomUUID()}` as RunnerChallenge["challengeId"],
    expiresAt: new Date(Date.now() + 10_000).toISOString(),
    hostSessionId: "host-session-identifier-with-entropy",
    module: "browser",
    nonce: "challenge-nonce-with-at-least-thirty-two-characters",
    type: "host.auxiliary.challenge",
  };
}

function withAgents(
  base: RunnerDescriptor,
  overrides: Partial<NonNullable<RunnerDescriptor["modules"]["agents"]>>,
): RunnerDescriptor {
  const agents = base.modules.agents;
  if (!agents) throw new Error("The fixture descriptor must advertise agents");
  return { ...base, modules: { ...base.modules, agents: { ...agents, ...overrides } } };
}

function descriptor(): RunnerDescriptor {
  return {
    bootId: `rbt_${randomUUID()}` as RunnerDescriptor["bootId"],
    capabilities: ["filesystem", "network-egress"],
    modules: {
      agents: {
        environmentIds: [createId("environment")],
        harnessDrivers: [
          {
            accessModes: ThreadAccessModeSchema.options,
            driverKind: HarnessIdSchema.parse("native"),
            readiness: "configured",
            sources: [
              {
                fields: [],
                kind: "first-party",
                label: "Native",
                quota: "none",
                sourceId: "native",
                stateKinds: ["ambient", "isolated"],
              },
            ],
          },
        ],
        localStorage: null,
        maxConcurrentRuns: 4,
        providerStateModes: ["isolated"],
        workspaceBackings: ["local-directory", "portablefs"],
        workspaceMounts: [],
      },
    },
    name: "Main runner",
    runnerId: createId("runner"),
    runnerKind: "main",
    runtimeVersion: "0.0.0",
  };
}
