import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BrowserAttachKeyRegistry } from "./browser-attach-key-registry.js";

describe("BrowserAttachKeyRegistry", () => {
  it("bootstraps an empty registry and replaces device keys atomically on rotation", () => {
    const first = ed25519Key();
    const second = ed25519Key();
    const registry = new BrowserAttachKeyRegistry(new Map());

    expect(registry.resolve("host-v1")).toBeNull();
    registry.replaceRelayKeys([{ keyId: "host-v1", publicKeyPem: publicPem(first) }]);
    expect(registry.resolve("host-v1")?.equals(first)).toBe(true);

    registry.replaceRelayKeys([{ keyId: "host-v2", publicKeyPem: publicPem(second) }]);
    expect(registry.resolve("host-v1")).toBeNull();
    expect(registry.resolve("host-v2")?.equals(second)).toBe(true);

    const invalid = generateKeyPairSync("rsa", { modulusLength: 2_048 }).publicKey;
    expect(() =>
      registry.replaceRelayKeys([{ keyId: "invalid", publicKeyPem: publicPem(invalid) }]),
    ).toThrow(/non-Ed25519/);
    expect(registry.resolve("host-v2")?.equals(second)).toBe(true);
  });

  it("never lets a dynamic update replace a configured static key", () => {
    const configured = ed25519Key();
    const replacement = ed25519Key();
    const registry = new BrowserAttachKeyRegistry(new Map([["host-static", configured]]));

    expect(() =>
      registry.replaceRelayKeys([{ keyId: "host-static", publicKeyPem: publicPem(replacement) }]),
    ).toThrow(/conflicts with a static key/);
    expect(registry.resolve("host-static")?.equals(configured)).toBe(true);
  });
});

function ed25519Key(): KeyObject {
  return generateKeyPairSync("ed25519").publicKey;
}

function publicPem(key: KeyObject): string {
  return key.export({ format: "pem", type: "spki" }).toString();
}
