import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { HostCredentialSchema, ProtectedAuthStateSchema } from "@opensteer/client/auth";
import {
  DesktopProtectedAuthStore,
  type DesktopSecretCryptography,
} from "./protected-auth-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("DesktopProtectedAuthStore", () => {
  it("persists only OS-encrypted Account and per-Deployment credentials", async () => {
    const directory = await temporaryDirectory();
    const cryptography = fakeCryptography();
    const store = new DesktopProtectedAuthStore({ cryptography, dataDirectory: directory });

    await store.setAccount(accountCredential());
    await store.setHost(hostCredential());

    const serialized = await readFile(store.filePath, "utf8");
    expect(serialized).not.toContain("account-access-token");
    expect(serialized).not.toContain("host-refresh-token");
    await expect(store.load()).resolves.toMatchObject({
      account: { accessToken: "account-access-token-000000" },
      hosts: [{ accessToken: "host-access-token-000000000" }],
    });

    await store.clearHosts(["dep_00000000-0000-4000-8000-000000000001"]);
    await store.clearAccount();
    await expect(store.load()).resolves.toEqual({ account: null, hosts: [], schemaVersion: 2 });
  });

  it("fails closed when Linux selects Electron's basic_text backend", async () => {
    const directory = await temporaryDirectory();
    const store = new DesktopProtectedAuthStore({
      cryptography: fakeCryptography({ backend: "basic_text" }),
      dataDirectory: directory,
      platform: "linux",
    });
    await expect(store.load()).rejects.toThrow(/basic-text/u);
  });

  it("refuses symlinked secret files", async () => {
    const directory = await temporaryDirectory();
    const store = new DesktopProtectedAuthStore({
      cryptography: fakeCryptography(),
      dataDirectory: directory,
    });
    await symlink(path.join(directory, "missing"), store.filePath);
    await expect(store.load()).rejects.toThrow(/regular file/u);
  });

  it("atomically re-encrypts data after the OS key backend rotates", async () => {
    const directory = await temporaryDirectory();
    const initial = new DesktopProtectedAuthStore({
      cryptography: fakeCryptography(),
      dataDirectory: directory,
    });
    await initial.setAccount(accountCredential());
    const before = await readFile(initial.filePath, "utf8");
    const rotated = new DesktopProtectedAuthStore({
      cryptography: fakeCryptography({ prefix: "rotated:", shouldReEncrypt: true }),
      dataDirectory: directory,
    });
    await expect(rotated.load()).resolves.toMatchObject({
      account: { issuerOrigin: "https://accounts.example.test" },
    });
    expect(await readFile(rotated.filePath, "utf8")).not.toBe(before);
  });

  it("discards a previous-release v1 credential cache and reads signed-out", async () => {
    const directory = await temporaryDirectory();
    const cryptography = fakeCryptography();
    const store = new DesktopProtectedAuthStore({ cryptography, dataDirectory: directory });
    const { subject: _subject, ...oldAccount } = accountCredential();
    const plaintext = JSON.stringify({ account: oldAccount, hosts: [], schemaVersion: 1 });
    const encrypted = Buffer.from(Buffer.from(plaintext, "utf8").toString("base64"), "utf8");
    await writeFile(
      store.filePath,
      `${JSON.stringify({ ciphertext: encrypted.toString("base64"), schemaVersion: 1 })}\n`,
    );

    await expect(store.load()).resolves.toEqual({ account: null, hosts: [], schemaVersion: 2 });
    await expect(lstat(store.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.load()).resolves.toEqual({ account: null, hosts: [], schemaVersion: 2 });
  });

  it("preserves the version-one ciphertext envelope byte format", async () => {
    const directory = await temporaryDirectory();
    const store = new DesktopProtectedAuthStore({
      cryptography: fakeCryptography(),
      dataDirectory: directory,
    });
    const account = accountCredential();
    await store.setAccount(account);
    const plaintext = JSON.stringify(
      ProtectedAuthStateSchema.parse({ account, hosts: [], schemaVersion: 2 }),
    );
    const encrypted = Buffer.from(Buffer.from(plaintext, "utf8").toString("base64"), "utf8");
    expect(await readFile(store.filePath, "utf8")).toBe(
      `${JSON.stringify({ ciphertext: encrypted.toString("base64"), schemaVersion: 1 })}\n`,
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "opensteer-protected-auth-"));
  directories.push(directory);
  return directory;
}

function fakeCryptography(
  options: {
    readonly backend?: string;
    readonly prefix?: string;
    readonly shouldReEncrypt?: boolean;
  } = {},
): DesktopSecretCryptography {
  return {
    decryptStringAsync: async (encrypted) => {
      const decoded = Buffer.from(encrypted.toString("utf8"), "base64").toString("utf8");
      return {
        result: decoded.replace(/^(?:rotated:)?/u, ""),
        shouldReEncrypt: options.shouldReEncrypt ?? false,
      };
    },
    encryptStringAsync: async (plaintext) =>
      Buffer.from(
        Buffer.from(`${options.prefix ?? ""}${plaintext}`, "utf8").toString("base64"),
        "utf8",
      ),
    getSelectedStorageBackend: () => options.backend ?? "gnome_libsecret",
    isAsyncEncryptionAvailable: async () => true,
  };
}

function accountCredential() {
  return {
    accessToken: "account-access-token-000000",
    accessTokenExpiresAt: "2026-08-11T20:00:00.000Z",
    grantedScopes: ["openid", "deployments:read"],
    issuerOrigin: "https://accounts.example.test",
    refreshToken: "account-refresh-token-00000",
    subject: ControlPlaneAccountIdSchema.parse(`acct_${crypto.randomUUID()}`),
    updatedAt: "2026-08-11T19:00:00.000Z",
  };
}

function hostCredential() {
  return HostCredentialSchema.parse({
    accessToken: "host-access-token-000000000",
    accessTokenExpiresAt: "2026-08-11T20:00:00.000Z",
    canonicalOrigin: "https://host.example.test",
    deploymentId: "dep_00000000-0000-4000-8000-000000000001",
    grantedScopes: ["openid", "host:access"],
    hostInstanceId: "hst_00000000-0000-4000-8000-000000000002",
    hostKeyFingerprint: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    refreshToken: "host-refresh-token-000000000",
    updatedAt: "2026-08-11T19:00:00.000Z",
  });
}
