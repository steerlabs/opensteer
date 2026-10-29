import { generateKeyPairSync, sign } from "node:crypto";
import { createId } from "@opensteer/core";
import {
  hostApiVersion,
  hostDiscoverySigningBytes,
  hostKeyFingerprint,
} from "@opensteer/deployment-authority";
import { publicHostDescriptor } from "./host-descriptor.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { cloudHostReady } from "./host-readiness.js";

describe("public cloud Host readiness", () => {
  const keys = generateKeyPairSync("ed25519");
  const origin = "https://cloud.example.test";
  const document = {
    canonicalOrigin: origin,
    deploymentId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
    hostKey: { algorithm: "Ed25519" as const },
    deploymentShape: { kind: "server" as const, defaultWorkspaceBacking: "portablefs" as const },
  };
  const publicKey = {
    algorithm: "Ed25519",
    spki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
  };
  const envelope = {
    document,
    publicKey,
    signature: sign(null, hostDiscoverySigningBytes(document), keys.privateKey).toString(
      "base64url",
    ),
  };
  const expected = {
    deploymentId: document.deploymentId,
    hostInstanceId: document.hostInstanceId,
    hostKeyFingerprint: hostKeyFingerprint(publicKey.spki),
  };

  it("proves public identity without credentials or following redirects", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(publicHostDescriptor(envelope)),
    );
    await expect(cloudHostReady(origin, expected, fetch)).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      new URL("/.well-known/opensteer", origin),
      expect.objectContaining({ credentials: "omit", redirect: "manual", cache: "no-store" }),
    );
  });

  it("keeps a previously published legacy authority ready", async () => {
    const legacyDocument = {
      ...document,
      deploymentShape: { backing: "portablefs" as const, kind: "server" as const },
    };
    const legacyEnvelope = {
      document: legacyDocument,
      publicKey,
      signature: sign(null, hostDiscoverySigningBytes(legacyDocument), keys.privateKey).toString(
        "base64url",
      ),
    };

    await expect(
      cloudHostReady(origin, expected, async () =>
        Response.json(publicHostDescriptor(legacyEnvelope)),
      ),
    ).resolves.toBe(true);
  });

  it("names which side of the protocol a mismatched Host image is on", async () => {
    await expect(
      cloudHostReady(origin, expected, async () =>
        Response.json(publicHostDescriptor(envelope, { apiVersion: hostApiVersion + 1 })),
      ),
    ).rejects.toThrow(/newer than the protocol/u);
    await expect(
      cloudHostReady(origin, expected, async () =>
        Response.json({ authority: envelope, bootstrapMethods: ["oidc"] }),
      ),
    ).rejects.toThrow(/older than the protocol/u);
  });

  it("waits through DNS/TLS setup and HTTP errors", async () => {
    await expect(
      cloudHostReady(origin, expected, async () => {
        throw new Error("TLS not ready");
      }),
    ).resolves.toBe(false);
    await expect(
      cloudHostReady(origin, expected, async () => new Response(null, { status: 502 })),
    ).resolves.toBe(false);
    await expect(
      cloudHostReady(origin, expected, async () =>
        Response.redirect("https://other.example.test", 302),
      ),
    ).resolves.toBe(false);
  });

  it("refuses another correctly signed Host and tampered discovery", async () => {
    await expect(
      cloudHostReady(origin, { ...expected, hostInstanceId: createId("hostInstance") }, async () =>
        Response.json(publicHostDescriptor(envelope)),
      ),
    ).rejects.toThrow(/identity/u);
    await expect(
      cloudHostReady(origin, expected, async () =>
        Response.json(
          publicHostDescriptor({
            ...envelope,
            document: { ...document, canonicalOrigin: "https://wrong.example.test" },
          }),
        ),
      ),
    ).rejects.toThrow();
    await expect(
      cloudHostReady(origin, expected, async () =>
        Response.json(publicHostDescriptor({ ...envelope, signature: "x".repeat(86) })),
      ),
    ).rejects.toThrow();
  });
});
