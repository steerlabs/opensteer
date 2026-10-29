import { generateKeyPairSync, sign } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createId } from "@opensteer/core";
import {
  hostDiscoverySigningBytes,
  hostKeyFingerprint as fingerprintForSpki,
} from "@opensteer/deployment-authority";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesktopConnectCredentialStateSchema,
  DesktopConnectCredentialStore,
} from "./connect-credential-store.js";
import { testPersonalHostRuntime } from "../supervisor/personal-host-runtime-test-support.js";
import type { DesktopSecretCryptography } from "./protected-json-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("DesktopConnectCredentialStore", () => {
  it("migrates signed legacy discovery while preserving credentials and rejecting a different key", async () => {
    const store = new DesktopConnectCredentialStore({
      cryptography: fakeCryptography(),
      dataDirectory: await temporaryDirectory(),
    });
    const state = connectState();
    const keys = generateKeyPairSync("ed25519");
    const spki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const current = {
      ...state.authority,
      discoveryEnvelope: {
        document: state.authority.discovery,
        publicKey: { algorithm: "Ed25519" as const, spki },
        signature: sign(
          null,
          hostDiscoverySigningBytes(state.authority.discovery),
          keys.privateKey,
        ).toString("base64url"),
      },
    };
    const legacyDiscovery = {
      ...current.discovery,
      deploymentShape: { backing: "local-directory" as const, kind: "personal" as const },
    };
    const previous = {
      ...state,
      credential: { ...state.credential!, hostKeyFingerprint: fingerprintForSpki(spki) },
      authority: {
        ...current,
        discovery: legacyDiscovery,
        discoveryEnvelope: {
          ...current.discoveryEnvelope,
          document: legacyDiscovery,
          signature: sign(
            null,
            hostDiscoverySigningBytes(legacyDiscovery),
            keys.privateKey,
          ).toString("base64url"),
        },
      },
    };
    const id = current.discovery.deploymentId;
    await store.save(id, previous);
    const changedKey = {
      ...current,
      discoveryEnvelope: {
        ...current.discoveryEnvelope,
        publicKey: { algorithm: "Ed25519" as const, spki: "A".repeat(59) },
      },
    };
    await expect(store.load(id, changedKey)).rejects.toThrow("authority changed");
    // A key that is not canonical base64url has no fingerprint at all, so it
    // never reaches the identity comparison.
    const nonCanonicalKey = {
      ...current,
      discoveryEnvelope: {
        ...current.discoveryEnvelope,
        publicKey: { algorithm: "Ed25519" as const, spki: "B".repeat(59) },
      },
    };
    await expect(store.load(id, nonCanonicalKey)).rejects.toThrow();
    await expect(store.load(id)).resolves.toEqual(previous);
    const invalidSignature = {
      ...current,
      discoveryEnvelope: { ...current.discoveryEnvelope, signature: "A".repeat(86) },
    };
    await expect(store.load(id, invalidSignature)).rejects.toThrow("signature is invalid");
    const expected = { ...previous, authority: current };
    await expect(store.load(id, current)).resolves.toEqual(expected);
    await expect(store.load(id)).resolves.toEqual(expected);
    await expect(store.load(id, current)).resolves.toEqual(expected);
  });

  it("stores one authority-bound connector credential in a separate OS-encrypted file", async () => {
    const dataDirectory = await temporaryDirectory();
    const store = new DesktopConnectCredentialStore({
      cryptography: fakeCryptography(),
      dataDirectory,
    });
    const state = connectState();

    await store.save(state.authority.discovery.deploymentId, state);

    const serialized = await readFile(
      store.filePath(state.authority.discovery.deploymentId),
      "utf8",
    );
    expect(serialized).not.toContain(state.credential!.tunnelToken);
    expect(serialized).not.toContain("Bearer account-token");
    expect(serialized).not.toContain("cloudflareApiToken");
    await expect(store.load(state.authority.discovery.deploymentId)).resolves.toEqual(state);
    if (process.platform !== "win32") {
      expect(
        (await lstat(store.filePath(state.authority.discovery.deploymentId))).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it("rejects Linux basic-text storage and symlinked credential files", async () => {
    const dataDirectory = await temporaryDirectory();
    const state = connectState();
    const basicText = new DesktopConnectCredentialStore({
      cryptography: fakeCryptography("basic_text"),
      dataDirectory,
      platform: "linux",
    });
    await expect(basicText.save(state.authority.discovery.deploymentId, state)).rejects.toThrow(
      /basic-text/u,
    );

    const store = new DesktopConnectCredentialStore({
      cryptography: fakeCryptography(),
      dataDirectory,
    });
    const filePath = store.filePath(state.authority.discovery.deploymentId);
    await mkdir(path.dirname(filePath), { mode: 0o700, recursive: true });
    await symlink(path.join(dataDirectory, "missing"), filePath);
    await expect(store.load(state.authority.discovery.deploymentId)).rejects.toThrow(
      /real regular file/u,
    );
  });

  it("rejects copied ciphertext under another Deployment path", async () => {
    const dataDirectory = await temporaryDirectory();
    const store = new DesktopConnectCredentialStore({
      cryptography: fakeCryptography(),
      dataDirectory,
    });
    const state = connectState();
    const firstId = state.authority.discovery.deploymentId;
    const secondId = createId("deployment");
    await store.save(firstId, state);
    const secondPath = store.filePath(secondId);
    await mkdir(path.dirname(secondPath), { mode: 0o700, recursive: true });
    await copyFile(store.filePath(firstId), secondPath);

    await expect(store.load(secondId)).rejects.toThrow(/another Deployment/u);
  });

  it("requires a bounded durable operation for every incomplete transition", () => {
    const state = connectState();
    expect(
      DesktopConnectCredentialStateSchema.safeParse({
        ...state,
        credential: null,
        pendingOperation: null,
      }).success,
    ).toBe(false);
    expect(
      DesktopConnectCredentialStateSchema.safeParse({
        ...state,
        pendingOperation: {
          kind: "rotate",
          operationId: "cop_not-a-bounded-operation-id",
        },
      }).success,
    ).toBe(false);
    expect(
      DesktopConnectCredentialStateSchema.safeParse({
        ...state,
        accountAuthorization: "Bearer account-token",
      }).success,
    ).toBe(false);
  });

  it("deletes a retired protocol-1 credential cache without reading its authority", async () => {
    const dataDirectory = await temporaryDirectory();
    const cryptography = fakeCryptography();
    const store = new DesktopConnectCredentialStore({ cryptography, dataDirectory });
    const deploymentId = createId("deployment");
    const filePath = store.filePath(deploymentId);
    await mkdir(path.dirname(filePath), { mode: 0o700, recursive: true });
    const encrypted = await cryptography.encryptStringAsync(
      JSON.stringify({
        authority: { discovery: { protocol: { maximum: 1, minimum: 1 } } },
        schemaVersion: 1,
      }),
    );
    await writeFile(
      filePath,
      `${JSON.stringify({ ciphertext: encrypted.toString("base64"), schemaVersion: 1 })}\n`,
      { mode: 0o600 },
    );

    await expect(store.load(deploymentId)).resolves.toBeNull();
    await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opensteer-connect-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeCryptography(backend = "gnome_libsecret"): DesktopSecretCryptography {
  return {
    decryptStringAsync: async (encrypted) => ({
      result: Buffer.from(encrypted.toString("utf8"), "base64").toString("utf8"),
      shouldReEncrypt: false,
    }),
    encryptStringAsync: async (plaintext) =>
      Buffer.from(Buffer.from(plaintext, "utf8").toString("base64"), "utf8"),
    getSelectedStorageBackend: () => backend,
    isAsyncEncryptionAvailable: async () => true,
  };
}

function connectState() {
  const deploymentId = createId("deployment");
  const hostInstanceId = createId("hostInstance");
  const canonicalOrigin = "http://127.0.0.1:4310";
  const authority = testPersonalHostRuntime({
    discovery: {
      canonicalOrigin,
      deploymentId,
      hostInstanceId,
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: {
        defaultWorkspaceBacking: "local-directory",
        kind: "personal" as const,
      },
    },
    localOrigin: "http://127.0.0.1:4310",
    observedAt: "2026-08-11T10:00:00.000Z",
    ownership: "desktop-personal-host-supervisor",
    schemaVersion: 2,
    state: "ready",
    verification: "signed-loopback-discovery",
  });
  const hostKeyFingerprint = fingerprintForSpki(authority.discoveryEnvelope.publicKey.spki);
  return DesktopConnectCredentialStateSchema.parse({
    authority,
    credential: {
      canonicalOrigin,
      deploymentId,
      connectorCredentialGeneration: 7,
      hostInstanceId,
      hostKeyFingerprint,
      routeOrigin: "https://home.connect.opensteer.test",
      tunnelToken: `eyJ${"x".repeat(80)}`,
    },
    desiredState: "enabled",
    pendingOperation: null,
    schemaVersion: 2,
  });
}
