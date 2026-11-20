import {
  AgentDirectoryOriginSchema,
  agentDirectoryJwtTyp,
  agentDirectoryPath,
  agentDirectoryTokenUse,
  isIdentityStillVerified,
  maximumAgentDirectoryEnvelopeBytes,
  type AgentConnectionIdentityAtConsent,
  type AgentDirectoryDocument,
} from "@opensteer/control-plane-protocol";
import { createId } from "@opensteer/core";
import type { AgentConnectionStore } from "@opensteer/database";
import { generateKeyPairSync } from "node:crypto";
import { ConnectionOAuth } from "./connection-oauth.js";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet, type JWK } from "jose";
import { describe, expect, it, vi } from "vitest";
import { AgentDirectoryCache, matchPlatform } from "./agent-directory.js";

const accountOrigin = "https://accounts.example.test";
const baseNow = Date.parse("2026-11-20T12:00:00.000Z");

async function makeAccountKey(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const jwk: JWK = { ...(await exportJWK(publicKey)), alg: "EdDSA", kid, use: "sig" };
  return { kid, privateKey, jwk };
}

async function signDirectory(
  document: AgentDirectoryDocument,
  key: { kid: string; privateKey: CryptoKey },
  overrides: {
    readonly issuer?: string;
    readonly typ?: string;
    readonly tokenUse?: string;
    readonly iat?: number;
  } = {},
): Promise<string> {
  const payload: Record<string, unknown> = {
    ...document,
    tokenUse: overrides.tokenUse ?? agentDirectoryTokenUse,
    iss: overrides.issuer ?? accountOrigin,
    iat: overrides.iat ?? Math.floor(Date.parse(document.issuedAt) / 1_000),
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "EdDSA", kid: key.kid, typ: overrides.typ ?? agentDirectoryJwtTyp })
    .sign(key.privateKey);
}

function sampleDocument(revision: number, nowMs = baseNow): AgentDirectoryDocument {
  return {
    revision,
    issuedAt: new Date(nowMs).toISOString(),
    entries: [
      {
        id: "agentpay",
        displayName: "AgentPay",
        origins: ["https://agentpay.example", "https://eu.agentpay.example"],
      },
      {
        id: "errand",
        displayName: "Errand",
        origins: ["https://errand.example"],
        embedsVia: ["agentpay"],
      },
    ],
  };
}

function makeMockFetch(handlers: {
  getJwks: () => Response | Promise<Response>;
  getDirectory: () => Response | Promise<Response>;
}): typeof globalThis.fetch {
  return (async (input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === `${accountOrigin}/api/auth/jwks`) return handlers.getJwks();
    if (url === `${accountOrigin}${agentDirectoryPath}`) return handlers.getDirectory();
    throw new Error(`Unexpected fetch to ${url}`);
  }) as typeof globalThis.fetch;
}

function jsonResponse(body: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
}

function makeCache(options: Omit<ConstructorParameters<typeof AgentDirectoryCache>[0], "storage">,
  saved: AgentDirectoryDocument | null = null) {
  return new AgentDirectoryCache({
    ...options,
    storage: {
      load: async () => saved,
      accept: async (_issuer, document) => { saved = document; return document; },
    },
  });
}

function authorize(cache: AgentDirectoryCache) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const origin = "http://127.0.0.1:4310";
  const oauth = new ConnectionOAuth({
    directory: cache,
    deploymentId: createId("deployment"),
    store: {} as AgentConnectionStore,
    signingKey: privateKey,
    verificationKey: publicKey,
  });
  const redirect = "https://agentpay.example/callback";
  const client = oauth.register(origin, { redirect_uris: [redirect] });
  return oauth.authorize(origin, {
    ...client,
    redirect_uri: redirect,
    response_type: "code",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
  }).then((path) => {
    const id = new URL(path, origin).searchParams.get("request")!;
    return oauth.consent(id, createId("user"));
  });
}

describe("AgentDirectoryCache", () => {
  it("fetches, verifies, caches, and refreshes a valid signed directory", async () => {
    const key1 = await makeAccountKey("key-1");
    const key2 = await makeAccountKey("key-2");
    let now = baseNow;
    let activeKey = key1;
    let jwks: JSONWebKeySet = { keys: [key1.jwk] };
    let currentDoc = sampleDocument(1, now);
    let directoryCalls = 0;

    const cache = makeCache({
      issuer: new URL(accountOrigin),
      now: () => now,
      refreshIntervalMs: 60_000,
      maxAgeMs: 300_000,
      fetch: makeMockFetch({
        getJwks: () => jsonResponse(jwks),
        getDirectory: async () => {
          directoryCalls += 1;
          return jsonResponse({ assertion: await signDirectory(currentDoc, activeKey) });
        },
      }),
    });

    const first = await cache.get();
    expect(first).toEqual(currentDoc);
    expect(directoryCalls).toBe(1);

    // Within refresh interval: served from memory without another fetch.
    now += 30_000;
    const cached = await cache.get();
    expect(cached).toEqual(currentDoc);
    expect(directoryCalls).toBe(1);

    // After refresh interval, rotated signing key forces JWKS refresh and accepts higher revision.
    now += 40_000;
    activeKey = key2;
    jwks = { keys: [key1.jwk, key2.jwk] };
    currentDoc = sampleDocument(2, now);
    await cache.refresh();
    const refreshed = cache.current();
    expect(refreshed?.revision).toBe(2);
    expect(directoryCalls).toBe(2);
  });

  it("treats tampered signatures as unverified", async () => {
    const key = await makeAccountKey("key-1");
    const token = await signDirectory(sampleDocument(1), key);
    const [h, p, s] = token.split(".");
    const tamperedSig = (s![0] === "A" ? "B" : "A") + s!.slice(1);

    const cache = makeCache({
      issuer: new URL(accountOrigin),
      now: () => baseNow,
      fetch: makeMockFetch({
        getJwks: () => jsonResponse({ keys: [key.jwk] }),
        getDirectory: () => jsonResponse({ assertion: `${h}.${p}.${tamperedSig}` }),
      }),
    });

    expect(await cache.get()).toBeNull();
  });

  it("refuses tokens with the wrong purpose or wrong typ header", async () => {
    const key = await makeAccountKey("key-1");
    const wrongPurpose = await signDirectory(sampleDocument(1), key, {
      tokenUse: "opensteer-work-policy",
    });
    const wrongTyp = await signDirectory(sampleDocument(1), key, { typ: "JWT" });

    for (const assertion of [wrongPurpose, wrongTyp]) {
      const cache = makeCache({
        issuer: new URL(accountOrigin),
        now: () => baseNow,
        fetch: makeMockFetch({
          getJwks: () => jsonResponse({ keys: [key.jwk] }),
          getDirectory: () => jsonResponse({ assertion }),
        }),
      });
      expect(await cache.get()).toBeNull();
    }
  });

  it("refuses tokens signed by a key not in the Account JWKS", async () => {
    const published = await makeAccountKey("key-1");
    const attacker = await makeAccountKey("key-1");
    const forged = await signDirectory(sampleDocument(1), attacker);

    const cache = makeCache({
      issuer: new URL(accountOrigin),
      now: () => baseNow,
      fetch: makeMockFetch({
        getJwks: () => jsonResponse({ keys: [published.jwk] }),
        getDirectory: () => jsonResponse({ assertion: forged }),
      }),
    });

    expect(await cache.get()).toBeNull();
  });

  it("serves a persisted copy immediately while Account is stalled", async () => {
    const stalled = Promise.withResolvers<Response>();
    const fetch = vi.fn(() => stalled.promise);
    const saved = sampleDocument(1);
    const cache = makeCache({ issuer: new URL(accountOrigin), now: () => baseNow, fetch }, saved);
    await cache.start();
    expect(fetch).toHaveBeenCalledOnce();
    const consent = vi.fn();
    vi.useFakeTimers();
    try {
      const pending = authorize(cache).then(consent);
      await vi.advanceTimersByTimeAsync(0);
      expect(consent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        identityAtConsent: expect.objectContaining({ kind: "platform", directoryRevision: 1 }),
      }));
      await pending;
    } finally {
      vi.useRealTimers();
    }
    stalled.resolve(new Response(null, { status: 503 }));
    await cache.refresh();
  });

  it("limits a cold cache to two seconds even while the fetch is stalled", async () => {
    vi.useFakeTimers();
    try {
      const stalled = Promise.withResolvers<Response>();
      const cache = makeCache({ issuer: new URL(accountOrigin), fetch: () => stalled.promise });
      const consent = vi.fn();
      const pending = authorize(cache).then(consent);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(consent).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(consent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        identityAtConsent: expect.objectContaining({ kind: "unverified" }),
      }));
      stalled.resolve(new Response(null, { status: 503 }));
      await cache.refresh();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses oversized directory responses", async () => {
    const key = await makeAccountKey("key-1");
    const oversized = "x".repeat(maximumAgentDirectoryEnvelopeBytes + 1_024);

    const cache = makeCache({
      issuer: new URL(accountOrigin),
      now: () => baseNow,
      fetch: makeMockFetch({
        getJwks: () => jsonResponse({ keys: [key.jwk] }),
        getDirectory: () =>
          new Response(`{"assertion":"${oversized}"}`, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    });

    expect(await cache.get()).toBeNull();
  });

  it("treats an expired cache as unverified when refresh fails", async () => {
    const key = await makeAccountKey("key-1");
    let now = baseNow;
    let available = true;

    const cache = makeCache({
      issuer: new URL(accountOrigin),
      now: () => now,
      refreshIntervalMs: 60_000,
      maxAgeMs: 120_000,
      fetch: makeMockFetch({
        getJwks: () => jsonResponse({ keys: [key.jwk] }),
        getDirectory: async () => {
          if (!available) throw new Error("network down");
          return jsonResponse({ assertion: await signDirectory(sampleDocument(1, now), key) });
        },
      }),
    });

    expect((await cache.get())?.revision).toBe(1);

    // Fetch fails, but cache is still within maxAgeMs -> stays usable.
    available = false;
    now += 90_000;
    expect((await cache.get())?.revision).toBe(1);

    // Past maxAgeMs -> cache expires and degrades cleanly to unverified (null).
    now += 60_000;
    expect(cache.current()).toBeNull();
    expect(await cache.get()).toBeNull();
  });

  it("never throws on fetch failures or non-200 / non-JSON responses", async () => {
    const cacheNetwork = makeCache({
      issuer: new URL(accountOrigin),
      now: () => baseNow,
      fetch: (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof globalThis.fetch,
    });
    expect(await cacheNetwork.get()).toBeNull();

    const cacheStatus = makeCache({
      issuer: new URL(accountOrigin),
      now: () => baseNow,
      fetch: makeMockFetch({
        getJwks: () => new Response("err", { status: 503 }),
        getDirectory: () => new Response("err", { status: 503 }),
      }),
    });
    expect(await cacheStatus.get()).toBeNull();
  });
});

describe("matchPlatform", () => {
  const directory = sampleDocument(1);

  it("matches an exact HTTPS origin regardless of path or query", () => {
    expect(matchPlatform(directory, "https://agentpay.example/oauth/callback?foo=1")?.id).toBe(
      "agentpay",
    );
    expect(matchPlatform(directory, "https://eu.agentpay.example/cb")?.id).toBe("agentpay");
  });

  it("refuses different ports, schemes, subdomains, and loopback redirects", () => {
    expect(matchPlatform(directory, "https://agentpay.example:8443/callback")).toBeNull();
    expect(matchPlatform(directory, "http://agentpay.example/callback")).toBeNull();
    expect(matchPlatform(directory, "https://evil.agentpay.example/callback")).toBeNull();
    expect(matchPlatform(directory, "http://127.0.0.1:4310/callback")).toBeNull();
    expect(matchPlatform(directory, "http://localhost:4310/callback")).toBeNull();
    expect(matchPlatform(directory, "https://localhost/callback")).toBeNull();
    expect(matchPlatform(directory, "http://[::1]:4310/callback")).toBeNull();
    expect(matchPlatform(null, "https://agentpay.example/callback")).toBeNull();
  });
});

it.each(["https://localhost.", "https://app.localhost.", "https://[::ffff:7f00:1]"])(
  "excludes loopback alias %s from publication and matching",
  (origin) => {
    expect(AgentDirectoryOriginSchema.safeParse(origin).success).toBe(false);
    expect(matchPlatform({ ...sampleDocument(1), entries: [
      { id: "platform", displayName: "Platform", origins: [origin] },
    ] }, `${origin}/callback`)).toBeNull();
  },
);

describe("isIdentityStillVerified", () => {
  const baseDirectory = sampleDocument(2);

  it("detects when a platform, embedder, or pairing is withdrawn", () => {
    const evidence: AgentConnectionIdentityAtConsent = {
      kind: "platform-and-embedder",
      platformOrigin: "https://agentpay.example",
      platformDirectoryId: "agentpay",
      platformName: "AgentPay",
      embedderOrigin: "https://errand.example",
      embedderDirectoryId: "errand",
      embedderName: "Errand",
      keyThumbprint: "a".repeat(43),
      directoryRevision: 2,
      recordedAt: new Date(baseNow).toISOString(),
    };

    expect(isIdentityStillVerified(evidence, baseDirectory)).toBe(true);
    expect(isIdentityStillVerified(evidence, null)).toBeNull();

    const unpaired: AgentDirectoryDocument = {
      ...baseDirectory,
      revision: 3,
      entries: [
        baseDirectory.entries[0]!,
        { id: "errand", displayName: "Errand", origins: ["https://errand.example"] },
      ],
    };
    expect(isIdentityStillVerified(evidence, unpaired)).toBe(false);
  });
});
