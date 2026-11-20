import {
  embedderAssertionJwtTyp,
  type AgentConnectionIdentityAtConsent,
  type AgentDirectoryDocument,
  type AgentDirectoryEntry,
  type AgentDirectoryPublicJwk,
} from "@opensteer/control-plane-protocol";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { describe, expect, it } from "vitest";
import {
  consentSelfStartWarning,
  describeIdentity,
  InMemoryJtiReplayStore,
  resolveConsentIdentity,
  verifyEmbedderAssertion,
  type EmbedderAssertionRequestBinding,
} from "./embedder-assertion.js";

const nowMs = Date.parse("2026-11-20T12:00:00.000Z");
const nowSec = Math.floor(nowMs / 1_000);

const baseRequest: EmbedderAssertionRequestBinding = {
  clientId: "eyJ2IjoxfQ.signature-bytes",
  issuer: "https://alice.home.opensteer.test/oauth/mcp",
  redirectUri: "https://agentpay.example/oauth/callback",
  codeChallenge: "a".repeat(43),
  state: "state-token-123",
};

async function makeEd25519Key(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const raw = await exportJWK(publicKey);
  const jwk: AgentDirectoryPublicJwk = {
    kty: "OKP",
    crv: "Ed25519",
    x: raw.x!,
    kid,
    use: "sig",
    alg: "EdDSA",
  };
  return { kid, alg: "EdDSA" as const, privateKey, jwk };
}

async function makeEs256Key(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const raw = await exportJWK(publicKey);
  const jwk: AgentDirectoryPublicJwk = {
    kty: "EC",
    crv: "P-256",
    x: raw.x!,
    y: raw.y!,
    kid,
    use: "sig",
    alg: "ES256",
  };
  return { kid, alg: "ES256" as const, privateKey, jwk };
}

function buildDirectory(
  errandKey: AgentDirectoryPublicJwk,
  otherKey: AgentDirectoryPublicJwk,
  options: { readonly pairErrand?: boolean } = {},
): { directory: AgentDirectoryDocument; platformEntry: AgentDirectoryEntry } {
  const platformEntry: AgentDirectoryEntry = {
    id: "agentpay",
    displayName: "AgentPay",
    origins: ["https://agentpay.example"],
  };
  const errandEntry: AgentDirectoryEntry = {
    id: "errand",
    displayName: "Errand",
    origins: ["https://errand.example"],
    keys: { keys: [errandKey] },
    ...(options.pairErrand === false ? {} : { embedsVia: ["agentpay"] }),
  };
  const otherEntry: AgentDirectoryEntry = {
    id: "other-app",
    displayName: "Other App",
    origins: ["https://other.example"],
    keys: { keys: [otherKey] },
    embedsVia: ["agentpay"],
  };
  return {
    directory: {
      revision: 7,
      issuedAt: new Date(nowMs).toISOString(),
      entries: [platformEntry, errandEntry, otherEntry],
    },
    platformEntry,
  };
}

async function signAssertion(
  signer: { kid?: string; alg: "EdDSA" | "ES256"; privateKey: CryptoKey },
  overrides: Partial<Record<string, unknown>> = {},
  headerOverrides: Partial<Record<string, unknown>> = {},
): Promise<string> {
  const payload: Record<string, unknown> = {
    iss: "https://errand.example",
    sub: baseRequest.clientId,
    aud: baseRequest.issuer,
    redirect_uri: baseRequest.redirectUri,
    code_challenge: baseRequest.codeChallenge,
    state: baseRequest.state,
    iat: nowSec,
    exp: nowSec + 120,
    jti: "jti-unique-1",
    ...overrides,
  };
  const header: Record<string, unknown> = {
    alg: signer.alg,
    typ: embedderAssertionJwtTyp,
    ...(signer.kid ? { kid: signer.kid } : {}),
    ...headerOverrides,
  };
  return new SignJWT(payload)
    .setProtectedHeader(header as Parameters<SignJWT["setProtectedHeader"]>[0])
    .sign(signer.privateKey);
}

describe("verifyEmbedderAssertion", () => {
  it("accepts a valid EdDSA assertion and returns verified evidence with key thumbprint", async () => {
    const errandKey = await makeEd25519Key("errand-ed-1");
    const otherKey = await makeEd25519Key("other-ed-1");
    const { directory, platformEntry } = buildDirectory(errandKey.jwk, otherKey.jwk);
    const assertion = await signAssertion(errandKey);
    const seenJti = new InMemoryJtiReplayStore();

    const result = await verifyEmbedderAssertion({
      directory,
      platformEntry,
      assertion,
      request: baseRequest,
      now: nowMs,
      seenJti,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence).toEqual({
      kind: "platform-and-embedder",
      platformOrigin: "https://agentpay.example",
      platformDirectoryId: "agentpay",
      platformName: "AgentPay",
      embedderOrigin: "https://errand.example",
      embedderDirectoryId: "errand",
      embedderName: "Errand",
      keyThumbprint: await calculateJwkThumbprint(errandKey.jwk as JWK, "sha256"),
      directoryRevision: 7,
      recordedAt: new Date(nowMs).toISOString(),
    });
  });

  it("accepts a valid ES256 assertion", async () => {
    const errandKey = await makeEs256Key("errand-es-1");
    const otherKey = await makeEd25519Key("other-ed-1");
    const { directory, platformEntry } = buildDirectory(errandKey.jwk, otherKey.jwk);
    const assertion = await signAssertion(errandKey);

    const result = await verifyEmbedderAssertion({
      directory,
      platformEntry,
      assertion,
      request: baseRequest,
      now: nowMs,
      seenJti: new InMemoryJtiReplayStore(),
    });

    expect(result.ok).toBe(true);
  });

  it.each([
    ["sub", { sub: "different-client-id" }],
    ["aud", { aud: "https://other.home.opensteer.test/oauth/mcp" }],
    ["redirect_uri", { redirect_uri: "https://agentpay.example/other-callback" }],
    ["code_challenge", { code_challenge: "b".repeat(43) }],
    ["state", { state: "different-state" }],
  ] as const)("refuses when bound field %s differs from the request", async (_field, override) => {
    const errandKey = await makeEd25519Key("errand-ed-1");
    const otherKey = await makeEd25519Key("other-ed-1");
    const { directory, platformEntry } = buildDirectory(errandKey.jwk, otherKey.jwk);
    const assertion = await signAssertion(errandKey, override);

    const result = await verifyEmbedderAssertion({
      directory,
      platformEntry,
      assertion,
      request: baseRequest,
      now: nowMs,
      seenJti: new InMemoryJtiReplayStore(),
    });

    expect(result).toMatchObject({ ok: false, reason: "request-mismatch" });
  });

  it("refuses when request omits state while presenting an embedder assertion", async () => {
    const errandKey = await makeEd25519Key("errand-ed-1");
    const otherKey = await makeEd25519Key("other-ed-1");
    const { directory, platformEntry } = buildDirectory(errandKey.jwk, otherKey.jwk);
    const assertion = await signAssertion(errandKey);

    const result = await verifyEmbedderAssertion({
      directory,
      platformEntry,
      assertion,
      request: { ...baseRequest, state: undefined },
      now: nowMs,
      seenJti: new InMemoryJtiReplayStore(),
    });

    expect(result).toMatchObject({ ok: false, reason: "request-mismatch" });
  });

  it("refuses expired assertions, future-issued assertions, and lifetimes over 2 minutes", async () => {
    const errandKey = await makeEd25519Key("errand-ed-1");
    const otherKey = await makeEd25519Key("other-ed-1");
    const { directory, platformEntry } = buildDirectory(errandKey.jwk, otherKey.jwk);

    const expired = await signAssertion(errandKey, { iat: nowSec - 135, exp: nowSec - 15 });
    expect(
      await verifyEmbedderAssertion({
        directory,
        platformEntry,
        assertion: expired,
        request: baseRequest,
        now: nowMs,
        seenJti: new InMemoryJtiReplayStore(),
      }),
    ).toMatchObject({ ok: false, reason: "expired" });

    // Within 10s clock tolerance: still accepted.
    const barelyExpired = await signAssertion(errandKey, { iat: nowSec - 125, exp: nowSec - 5 });
    expect(
      await verifyEmbedderAssertion({
        directory,
        platformEntry,
        assertion: barelyExpired,
        request: baseRequest,
        now: nowMs,
        seenJti: new InMemoryJtiReplayStore(),
      }),
    ).toMatchObject({ ok: true });

    const future = await signAssertion(errandKey, { iat: nowSec + 30, exp: nowSec + 90 });
    expect(
      await verifyEmbedderAssertion({
        directory,
        platformEntry,
        assertion: future,
        request: baseRequest,
        now: nowMs,
        seenJti: new InMemoryJtiReplayStore(),
      }),
    ).toMatchObject({ ok: false, reason: "issued-in-future" });

    const tooLong = await signAssertion(errandKey, { iat: nowSec, exp: nowSec + 121 });
    expect(
      await verifyEmbedderAssertion({
        directory,
        platformEntry,
        assertion: tooLong,
        request: baseRequest,
        now: nowMs,
        seenJti: new InMemoryJtiReplayStore(),
      }),
    ).toMatchObject({ ok: false, reason: "invalid-lifetime" });
  });

  it("refuses alg: none, symmetric HS256, RS256, and wrong typ", async () => {
    const errandKey = await makeEd25519Key("errand-ed-1");
    const otherKey = await makeEd25519Key("other-ed-1");
    const { directory, platformEntry } = buildDirectory(errandKey.jwk, otherKey.jwk);

    const payload = Buffer.from(
      JSON.stringify({
        iss: "https://errand.example",
        sub: baseRequest.clientId,
        aud: baseRequest.issuer,
        redirect_uri: baseRequest.redirectUri,
        code_challenge: baseRequest.codeChallenge,
        state: baseRequest.state,
        iat: nowSec,
        exp: nowSec + 60,
        jti: "jti-alg-test",
      }),
    ).toString("base64url");

    const algNoneHeader = Buffer.from(
      JSON.stringify({ alg: "none", typ: embedderAssertionJwtTyp }),
    ).toString("base64url");
    expect(
      await verifyEmbedderAssertion({
        directory,
        platformEntry,
        assertion: `${algNoneHeader}.${payload}.`,
        request: baseRequest,
        now: nowMs,
        seenJti: new InMemoryJtiReplayStore(),
      }),
    ).toMatchObject({ ok: false, reason: "disallowed-algorithm" });

    const hs256 = await new SignJWT({
      iss: "https://errand.example",
      sub: baseRequest.clientId,
      aud: baseRequest.issuer,
      redirect_uri: baseRequest.redirectUri,
      code_challenge: baseRequest.codeChallenge,
      state: baseRequest.state,
      iat: nowSec,
      exp: nowSec + 60,
      jti: "jti-hs256",
    })
      .setProtectedHeader({ alg: "HS256", typ: embedderAssertionJwtTyp })
      .sign(new TextEncoder().encode("shared-symmetric-secret-32-bytes!"));
    expect(
      await verifyEmbedderAssertion({
        directory,
        platformEntry,
        assertion: hs256,
        request: baseRequest,
        now: nowMs,
        seenJti: new InMemoryJtiReplayStore(),
      }),
    ).toMatchObject({ ok: false, reason: "disallowed-algorithm" });

    const wrongTyp = await signAssertion(errandKey, {}, { typ: "JWT" });
    expect(
      await verifyEmbedderAssertion({
        directory,
        platformEntry,
        assertion: wrongTyp,
        request: baseRequest,
        now: nowMs,
        seenJti: new InMemoryJtiReplayStore(),
      }),
    ).toMatchObject({ ok: false, reason: "invalid-typ" });
  });

  it("refuses a key from a different directory entry", async () => {
    const errandKey = await makeEd25519Key("errand-ed-1");
    const otherKey = await makeEd25519Key("other-ed-1");
    const { directory, platformEntry } = buildDirectory(errandKey.jwk, otherKey.jwk);

    // Different kid -> unknown-key.
    const withOtherKid = await signAssertion(otherKey);
    expect(
      await verifyEmbedderAssertion({
        directory,
        platformEntry,
        assertion: withOtherKid,
        request: baseRequest,
        now: nowMs,
        seenJti: new InMemoryJtiReplayStore(),
      }),
    ).toMatchObject({ ok: false, reason: "unknown-key" });

    // Spoofed kid matching errand's kid, signed by otherEntry's private key -> invalid-signature.
    const withSpoofedKid = await signAssertion({ ...otherKey, kid: errandKey.kid });
    expect(
      await verifyEmbedderAssertion({
        directory,
        platformEntry,
        assertion: withSpoofedKid,
        request: baseRequest,
        now: nowMs,
        seenJti: new InMemoryJtiReplayStore(),
      }),
    ).toMatchObject({ ok: false, reason: "invalid-signature" });
  });

  it("refuses an embedder not paired with this platform in embedsVia", async () => {
    const errandKey = await makeEd25519Key("errand-ed-1");
    const otherKey = await makeEd25519Key("other-ed-1");
    const { directory, platformEntry } = buildDirectory(errandKey.jwk, otherKey.jwk, {
      pairErrand: false,
    });
    const assertion = await signAssertion(errandKey);

    expect(
      await verifyEmbedderAssertion({
        directory,
        platformEntry,
        assertion,
        request: baseRequest,
        now: nowMs,
        seenJti: new InMemoryJtiReplayStore(),
      }),
    ).toMatchObject({ ok: false, reason: "unpaired-embedder" });
  });

  it("refuses a replayed jti and does not consume jti on a failed request", async () => {
    const errandKey = await makeEd25519Key("errand-ed-1");
    const otherKey = await makeEd25519Key("other-ed-1");
    const { directory, platformEntry } = buildDirectory(errandKey.jwk, otherKey.jwk);
    const seenJti = new InMemoryJtiReplayStore();
    const assertion = await signAssertion(errandKey, { jti: "one-time-jti" });

    // Wrong state fails before consuming jti.
    expect(
      await verifyEmbedderAssertion({
        directory,
        platformEntry,
        assertion,
        request: { ...baseRequest, state: "wrong" },
        now: nowMs,
        seenJti,
      }),
    ).toMatchObject({ ok: false, reason: "request-mismatch" });

    // First valid presentation succeeds.
    expect(
      await verifyEmbedderAssertion({
        directory,
        platformEntry,
        assertion,
        request: baseRequest,
        now: nowMs,
        seenJti,
      }),
    ).toMatchObject({ ok: true });

    // Replay is refused.
    expect(
      await verifyEmbedderAssertion({
        directory,
        platformEntry,
        assertion,
        request: baseRequest,
        now: nowMs + 5_000,
        seenJti,
      }),
    ).toMatchObject({ ok: false, reason: "replayed-jti" });
  });

  it("refuses malformed tokens and never treats an invalid assertion as absent", async () => {
    const errandKey = await makeEd25519Key("errand-ed-1");
    const otherKey = await makeEd25519Key("other-ed-1");
    const { directory } = buildDirectory(errandKey.jwk, otherKey.jwk);

    for (const malformed of ["not-a-jwt", "a.b", "", "a.".repeat(5_000)]) {
      const result = await resolveConsentIdentity({
        directory,
        clientName: "AgentPay",
        assertion: malformed,
        request: baseRequest,
        now: nowMs,
        seenJti: new InMemoryJtiReplayStore(),
      });
      expect(result).toMatchObject({ ok: false, reason: "malformed" });
    }

    // Even when directory is unavailable, a present assertion fails rather than falling back.
    const valid = await signAssertion(errandKey);
    expect(
      await resolveConsentIdentity({
        directory: null,
        clientName: "AgentPay",
        assertion: valid,
        request: baseRequest,
        now: nowMs,
        seenJti: new InMemoryJtiReplayStore(),
      }),
    ).toMatchObject({ ok: false, reason: "directory-unavailable" });
  });
});

describe("describeIdentity", () => {
  it("projects all three evidence kinds into the exact design view model", () => {
    const both: AgentConnectionIdentityAtConsent = {
      kind: "platform-and-embedder",
      platformOrigin: "https://agentpay.example",
      platformDirectoryId: "agentpay",
      platformName: "AgentPay",
      embedderOrigin: "https://errand.example",
      embedderDirectoryId: "errand",
      embedderName: "Errand",
      keyThumbprint: "a".repeat(43),
      directoryRevision: 7,
      recordedAt: new Date(nowMs).toISOString(),
    };
    expect(describeIdentity(both)).toEqual({
      evidenceKind: "platform-and-embedder",
      verified: true,
      selfAsserted: false,
      heading: "Errand via AgentPay",
      detail: "Errand asked for this. AgentPay will hold the access.",
      origins: [
        { role: "embedder", label: "Errand", origin: "https://errand.example" },
        { role: "platform", label: "AgentPay", origin: "https://agentpay.example" },
      ],
      warning: consentSelfStartWarning,
    });

    const platformOnly: AgentConnectionIdentityAtConsent = {
      kind: "platform",
      platformOrigin: "https://agentpay.example",
      platformDirectoryId: "agentpay",
      platformName: "AgentPay",
      directoryRevision: 7,
      recordedAt: new Date(nowMs).toISOString(),
    };
    expect(describeIdentity(platformOnly)).toEqual({
      evidenceKind: "platform",
      verified: true,
      selfAsserted: false,
      heading: "AgentPay",
      detail: "https://agentpay.example",
      origins: [{ role: "platform", label: "AgentPay", origin: "https://agentpay.example" }],
      warning: consentSelfStartWarning,
    });

    const unverifiedRemote: AgentConnectionIdentityAtConsent = {
      kind: "unverified",
      redirectOrigin: "https://unknown.example",
      isLoopback: false,
      clientName: "Mystery Agent",
      directoryRevision: 7,
      recordedAt: new Date(nowMs).toISOString(),
    };
    expect(describeIdentity(unverifiedRemote)).toEqual({
      evidenceKind: "unverified",
      verified: false,
      selfAsserted: true,
      heading: "Mystery Agent",
      detail: "https://unknown.example",
      origins: [{ role: "redirect", label: "Mystery Agent", origin: "https://unknown.example" }],
      warning: consentSelfStartWarning,
    });

    const unverifiedLoopback: AgentConnectionIdentityAtConsent = {
      kind: "unverified",
      redirectOrigin: "http://127.0.0.1:8123",
      isLoopback: true,
      clientName: "Local Script",
      directoryRevision: null,
      recordedAt: new Date(nowMs).toISOString(),
    };
    expect(describeIdentity(unverifiedLoopback)).toEqual({
      evidenceKind: "unverified",
      verified: false,
      selfAsserted: true,
      heading: "Local Script",
      detail: "an app on this computer",
      origins: [],
      warning: consentSelfStartWarning,
    });
  });
});
