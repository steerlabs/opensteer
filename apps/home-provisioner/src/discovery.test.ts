import { generateKeyPairSync, sign } from "node:crypto";
import {
  HostDiscoveryDocumentSchema,
  hostDiscoverySigningBytes,
  hostKeyFingerprint,
} from "@opensteer/deployment-authority";
import { expect, it, vi } from "vitest";
import { discoverHome, homeTlsOptions } from "./discovery.js";

const hostname = "home.example.com";
const keys = generateKeyPairSync("ed25519");
const spki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const document = HostDiscoveryDocumentSchema.parse({
  canonicalOrigin: `https://${hostname}`,
  deploymentId: "dep_00000000-0000-4000-8000-000000000001",
  hostInstanceId: "hst_00000000-0000-4000-8000-000000000001",
  hostKey: { algorithm: "Ed25519" },
  deploymentShape: { kind: "personal" },
});

it.each(["valid", "wrong-origin", "invalid-signature"])(
  "handles %s Home discovery",
  async (scenario) => {
    const doc =
      scenario === "wrong-origin"
        ? { ...document, canonicalOrigin: "https://another.example.com" }
        : document;
    const signature = sign(null, hostDiscoverySigningBytes(doc), keys.privateKey).toString(
      "base64url",
    );
    const fetch = vi.fn(async () =>
      Response.json({
        kind: "personal",
        apiVersion: 1,
        authority: {
          document: doc,
          publicKey: { algorithm: "Ed25519", spki },
          signature: scenario === "invalid-signature" ? "A".repeat(86) : signature,
        },
      }),
    );
    const discover = discoverHome({ timeoutMs: 1000, fetch });
    await expect(discover(hostname, "192.0.2.7", new AbortController().signal)).resolves.toEqual(
      scenario === "valid"
        ? {
            deploymentId: document.deploymentId,
            hostKeyFingerprint: hostKeyFingerprint(spki),
          }
        : "invalid",
    );
    expect(fetch).toHaveBeenCalledWith(
      new URL(`https://${hostname}/.well-known/opensteer`),
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
    );
  },
);

it("dials the provider address with the hostname as SNI and Host", () => {
  expect(homeTlsOptions("home.example.test", "2001:db8::12")).toMatchObject({
    hostname: "2001:db8::12",
    servername: "home.example.test",
    headers: { host: "home.example.test" },
    rejectUnauthorized: true,
  });
});

it.each([302, 421, 503])(
  "distinguishes an invalid endpoint from a temporary outage (HTTP %i)",
  async (status) => {
    const discover = discoverHome({
      timeoutMs: 1000,
      fetch: async () => new Response(null, { status }),
    });
    await expect(discover(hostname, "192.0.2.7", new AbortController().signal)).resolves.toBe(
      status === 503 ? undefined : "invalid",
    );
  },
);
