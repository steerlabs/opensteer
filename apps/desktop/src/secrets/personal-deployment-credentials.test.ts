import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createId } from "@opensteer/core";
import { afterEach, describe, expect, it } from "vitest";
import { NativePersonalDeploymentCredentials } from "./personal-deployment-credentials.js";
import {
  NativePersonalDeploymentFilesystem,
  type PersonalDeploymentManifest,
} from "./personal-deployment-store.js";
import type { DesktopSecretCryptography } from "./protected-json-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("NativePersonalDeploymentCredentials", () => {
  it("reuses protected secrets and the durable Host signing authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opensteer-personal-credentials-"));
    temporaryDirectories.push(root);
    const files = new NativePersonalDeploymentFilesystem({
      dataDirectory: path.join(root, "data"),
      minimumFreeBytes: 0,
    });
    const created = await files.create(manifest(path.join(root, "Workspaces")));
    const paths = await files.prepare(created);
    const credentials = new NativePersonalDeploymentCredentials(cryptography());
    const first = await credentials.ensure(created, paths);
    const second = await credentials.ensure(
      { ...created, hostKeyFingerprint: first.hostKeyFingerprint },
      paths,
    );
    expect(second).toEqual(first);
    expect(first.databasePassword).toHaveLength(64);
    expect(first.hostAuthSecret).toHaveLength(64);
    // Durable, not per-start: the Host pre-registers this token under a fixed
    // idempotency key, and a different token under that key is a conflict.
    expect(first.messagingEnrollmentToken).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    expect(second.messagingEnrollmentToken).toBe(first.messagingEnrollmentToken);
    expect(first.hostKeyFingerprint).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/u);
    for (const keyPath of [paths.browserProfileKeyPath, paths.credentialKeyPath]) {
      expect((await readFile(keyPath, "utf8")).trim()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      if (process.platform !== "win32") expect((await stat(keyPath)).mode & 0o077).toBe(0);
    }
    // The durable key is reported as it is; whether it still matches the
    // recorded authority is the supervisor's typed decision, which a restart
    // must not mistake for unavailable protected storage.
    await expect(
      credentials.ensure({ ...created, hostKeyFingerprint: `sha256:${"z".repeat(43)}` }, paths),
    ).resolves.toEqual(first);
  });

  it("fills in a messaging enrollment token for a secret store written before messaging existed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opensteer-personal-credentials-"));
    temporaryDirectories.push(root);
    const files = new NativePersonalDeploymentFilesystem({
      dataDirectory: path.join(root, "data"),
      minimumFreeBytes: 0,
    });
    const created = await files.create(manifest(path.join(root, "Workspaces")));
    const paths = await files.prepare(created);
    const legacy = {
      databasePassword: "d".repeat(64),
      deploymentId: created.deploymentId,
      hostAuthSecret: "h".repeat(64),
      schemaVersion: 1,
    };
    await writeFile(
      path.join(paths.rootDirectory, "personal-secrets.v1.json"),
      `${JSON.stringify({
        ciphertext: Buffer.from(JSON.stringify(legacy), "utf8").toString("base64"),
        schemaVersion: 1,
      })}\n`,
      { mode: 0o600 },
    );

    const credentials = new NativePersonalDeploymentCredentials(cryptography());
    const secrets = await credentials.ensure(created, paths);

    // The existing secrets survive the upgrade; only the new one is minted.
    expect(secrets.databasePassword).toBe(legacy.databasePassword);
    expect(secrets.hostAuthSecret).toBe(legacy.hostAuthSecret);
    expect(secrets.messagingEnrollmentToken).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    const again = await credentials.ensure(
      { ...created, hostKeyFingerprint: secrets.hostKeyFingerprint },
      paths,
    );
    expect(again.messagingEnrollmentToken).toBe(secrets.messagingEnrollmentToken);
  });

  it("rejects an invalid durable Host data-encryption key", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opensteer-personal-credentials-"));
    temporaryDirectories.push(root);
    const files = new NativePersonalDeploymentFilesystem({
      dataDirectory: path.join(root, "data"),
      minimumFreeBytes: 0,
    });
    const created = await files.create(manifest(path.join(root, "Workspaces")));
    const paths = await files.prepare(created);
    await writeFile(paths.browserProfileKeyPath, "not-a-key\n", { mode: 0o600 });

    await expect(
      new NativePersonalDeploymentCredentials(cryptography()).ensure(created, paths),
    ).rejects.toThrow(/data encryption key is invalid/u);
  });

  it("refuses to create Personal secrets without operating-system protection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opensteer-personal-credentials-"));
    temporaryDirectories.push(root);
    const files = new NativePersonalDeploymentFilesystem({
      dataDirectory: path.join(root, "data"),
      minimumFreeBytes: 0,
    });
    const created = await files.create(manifest(path.join(root, "Workspaces")));
    const paths = await files.prepare(created);
    const unavailable = cryptography();
    unavailable.isAsyncEncryptionAvailable = async () => false;
    await expect(
      new NativePersonalDeploymentCredentials(unavailable).ensure(created, paths),
    ).rejects.toThrow(/macOS Keychain|protected credential storage is unavailable/u);
  });
});

function cryptography(): DesktopSecretCryptography {
  return {
    decryptStringAsync: async (encrypted) => ({
      result: encrypted.toString("utf8"),
      shouldReEncrypt: false,
    }),
    encryptStringAsync: async (plaintext) => Buffer.from(plaintext, "utf8"),
    getSelectedStorageBackend: () => "keychain",
    isAsyncEncryptionAvailable: async () => true,
  };
}

function manifest(workspaceRoot: string): Omit<PersonalDeploymentManifest, "revision"> {
  return {
    createdAt: "2026-08-12T12:00:00.000Z",
    databaseInitialized: false,
    deploymentId: createId("deployment"),
    environmentId: createId("environment"),
    hostInstanceId: createId("hostInstance"),
    hostKeyFingerprint: null,
    hostPort: 4310,
    name: "This computer",
    ownerInitialized: false,
    postgresPort: 4311,
    release: {
      architecture: "arm64",
      hostVersion: "1.2.3",
      manifestSha256: "a".repeat(64),
      operatingSystem: "darwin",
      postgresMajor: 17,
      postgresVersion: "17.4.0",
      runnerVersion: "2.3.4",
    },
    runnerId: createId("runner"),
    schemaVersion: 3,
    setupIntentId: "019ff6c2-309a-7380-9093-e126eb2bda4b",
    updatedAt: "2026-08-12T12:00:00.000Z",
    workspaceRoot,
  };
}
