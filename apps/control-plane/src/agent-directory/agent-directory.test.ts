import {
  AgentDirectoryClaimsSchema,
  AgentDirectoryResponseSchema,
  agentDirectoryJwtTyp,
  agentDirectoryPath,
  agentDirectoryTokenUse,
  type AgentDirectoryDocument,
} from "@opensteer/control-plane-protocol";
import Fastify from "fastify";
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type JSONWebKeySet,
} from "jose";
import { describe, expect, it } from "vitest";
import { agentDirectoryCacheControl, registerAgentDirectoryRoutes } from "./routes.js";
import { applyAgentDirectoryChange, type AgentDirectorySnapshot } from "./store.js";

const accountOrigin = new URL("https://accounts.example.test");
const fixedNow = new Date("2026-11-20T12:00:00.000Z");

async function makeEd25519Jwk(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const raw = await exportJWK(publicKey);
  return {
    privateKey,
    jwk: {
      kty: "OKP" as const,
      crv: "Ed25519" as const,
      x: raw.x!,
      kid,
      use: "sig" as const,
      alg: "EdDSA" as const,
    },
  };
}

describe("agent directory mutations and signed GET route", () => {
  it("bumps revision monotonically on add, update, and remove and enforces invariants", async () => {
    const errandKey = await makeEd25519Jwk("errand-1");
    let state: AgentDirectorySnapshot = { revision: 1, entries: [] };

    const afterPlatform = applyAgentDirectoryChange(
      state,
      {
        kind: "add",
        input: {
          id: "agentpay",
          displayName: "AgentPay",
          origins: ["https://agentpay.example"],
        },
      },
      fixedNow,
    );
    expect(afterPlatform.revision).toBe(2);
    state = { revision: afterPlatform.revision, entries: afterPlatform.entries };

    const afterEmbedder = applyAgentDirectoryChange(
      state,
      {
        kind: "add",
        input: {
          id: "errand",
          displayName: "Errand",
          origins: ["https://errand.example"],
          keys: { keys: [errandKey.jwk] },
          embedsVia: ["agentpay"],
        },
      },
      fixedNow,
    );
    expect(afterEmbedder.revision).toBe(3);
    state = { revision: afterEmbedder.revision, entries: afterEmbedder.entries };

    // Duplicate origin across entries is refused.
    expect(() =>
      applyAgentDirectoryChange(
        state,
        {
          kind: "add",
          input: {
            id: "spoof",
            displayName: "Spoof",
            origins: ["https://agentpay.example"],
          },
        },
        fixedNow,
      ),
    ).toThrow(/Duplicate directory origin/u);

    // Removing a platform still referenced by embedsVia is refused.
    expect(() =>
      applyAgentDirectoryChange(state, { kind: "remove", id: "agentpay" }, fixedNow),
    ).toThrow(/Unknown platform entry agentpay/u);

    // Updating an entry bumps revision.
    const afterUpdate = applyAgentDirectoryChange(
      state,
      {
        kind: "update",
        id: "errand",
        input: {
          displayName: "Errand App",
          origins: ["https://errand.example"],
          keys: { keys: [errandKey.jwk] },
        },
      },
      fixedNow,
    );
    expect(afterUpdate.revision).toBe(4);
    expect(afterUpdate.entry?.displayName).toBe("Errand App");
    state = { revision: afterUpdate.revision, entries: afterUpdate.entries };

    // Once embedsVia is cleared, removing agentpay succeeds and bumps revision.
    const afterRemove = applyAgentDirectoryChange(
      state,
      { kind: "remove", id: "agentpay" },
      fixedNow,
    );
    expect(afterRemove.revision).toBe(5);
    expect(afterRemove.entries.map((entry) => entry.id)).toEqual(["errand"]);
  });

  it("refuses a valid entry that would exhaust the signed response budget", () => {
    const snapshot: AgentDirectorySnapshot = {
      revision: 1,
      entries: Array.from({ length: 250 }, (_, index) => ({
        id: `platform-${index}`,
        displayName: "Platform",
        origins: Array.from(
          { length: 16 },
          (_, suffix) =>
            `https://${"a".repeat(58)}.${"b".repeat(58)}.platform-${index}-${suffix}.example`,
        ),
      })),
    };
    expect(() =>
      applyAgentDirectoryChange(
        snapshot,
        {
          kind: "add",
          input: {
            id: "new-platform",
            displayName: "New platform",
            origins: ["https://new.example"],
          },
        },
        fixedNow,
      ),
    ).toThrow("Signed agent directory would exceed its byte limit");
  });

  it("serves a signed directory that verifies with Account's published JWKS and reflects rising revisions", async () => {
    const accountKey = await makeEd25519Jwk("account-key-1");
    const jwks: JSONWebKeySet = { keys: [accountKey.jwk] };
    const resolveKey = createLocalJWKSet(jwks);

    let snapshot: AgentDirectorySnapshot = { revision: 1, entries: [] };
    const app = Fastify();
    registerAgentDirectoryRoutes(app, {
      agentDirectory: {
        document: async (): Promise<AgentDirectoryDocument> => ({
          revision: snapshot.revision,
          issuedAt: fixedNow.toISOString(),
          entries: [...snapshot.entries],
        }),
      },
      publicOrigin: accountOrigin,
      now: () => fixedNow.getTime(),
      sign: async (payload, { typ }) =>
        new SignJWT(payload)
          .setProtectedHeader({ alg: "EdDSA", kid: accountKey.jwk.kid, typ })
          .sign(accountKey.privateKey),
    });

    try {
      const first = await app.inject({ method: "GET", url: agentDirectoryPath });
      expect(first.statusCode).toBe(200);
      expect(first.headers["cache-control"]).toBe(agentDirectoryCacheControl);
      expect(first.headers.etag).toBeUndefined();

      const parsedFirst = AgentDirectoryResponseSchema.parse(first.json());
      const header = decodeProtectedHeader(parsedFirst.assertion);
      expect(header).toEqual({
        alg: "EdDSA",
        kid: accountKey.jwk.kid,
        typ: agentDirectoryJwtTyp,
      });

      const verifiedFirst = await jwtVerify(parsedFirst.assertion, resolveKey, {
        algorithms: ["EdDSA"],
        currentDate: fixedNow,
        issuer: accountOrigin.origin,
        typ: agentDirectoryJwtTyp,
      });
      const claimsFirst = AgentDirectoryClaimsSchema.parse(verifiedFirst.payload);
      expect(claimsFirst.tokenUse).toBe(agentDirectoryTokenUse);
      expect(claimsFirst.revision).toBe(1);
      expect(claimsFirst.entries).toEqual([]);

      // Mutate and confirm signed revision rises.
      const added = applyAgentDirectoryChange(
        snapshot,
        {
          kind: "add",
          input: {
            id: "agentpay",
            displayName: "AgentPay",
            origins: ["https://agentpay.example"],
          },
        },
        fixedNow,
      );
      snapshot = { revision: added.revision, entries: added.entries };

      const second = await app.inject({ method: "GET", url: agentDirectoryPath });
      expect(second.statusCode).toBe(200);
      expect(second.headers.etag).toBeUndefined();
      const parsedSecond = AgentDirectoryResponseSchema.parse(second.json());
      const verifiedSecond = await jwtVerify(parsedSecond.assertion, resolveKey, {
        algorithms: ["EdDSA"],
        currentDate: fixedNow,
        issuer: accountOrigin.origin,
        typ: agentDirectoryJwtTyp,
      });
      const claimsSecond = AgentDirectoryClaimsSchema.parse(verifiedSecond.payload);
      expect(claimsSecond.revision).toBe(2);
      expect(claimsSecond.entries).toHaveLength(1);
      expect(claimsSecond.entries[0]?.id).toBe("agentpay");
    } finally {
      await app.close();
    }
  });
});
