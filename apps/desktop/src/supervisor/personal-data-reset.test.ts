import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { desktopDeploymentPaths } from "../app/application-paths.js";
import { NativePersonalDeploymentCredentials } from "../secrets/personal-deployment-credentials.js";
import {
  NativePersonalDeploymentFilesystem,
  PersonalDeploymentManifestSchema,
} from "../secrets/personal-deployment-store.js";
import { PersonalDataReset, isOldDatabaseDiagnostic } from "./personal-data-reset.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const cryptography = {
  async decryptStringAsync(value: Buffer) {
    return { result: value.toString(), shouldReEncrypt: false };
  },
  async encryptStringAsync(value: string) {
    return Buffer.from(value);
  },
  getSelectedStorageBackend() {
    return "keychain";
  },
  async isAsyncEncryptionAvailable() {
    return true;
  },
};
async function fixture(afterRename?: (index: number) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-reset-"));
  roots.push(root);
  const deploymentId = createId("deployment");
  const reset = new PersonalDataReset({
    dataDirectory: root,
    cryptography,
    ...(afterRename ? { afterRename } : {}),
  });
  const plan = await reset.plan(deploymentId);
  for (const [index, entry] of plan.entries.entries()) {
    await mkdir(path.dirname(entry.source), { recursive: true, mode: 0o700 });
    if (index < 2) {
      await mkdir(entry.source, { mode: 0o700 });
      await writeFile(path.join(entry.source, "data"), "old");
    }
  }
  await writeFile(plan.entries[4]!.source, "old manifest", { mode: 0o600 });
  await writeFile(path.join(root, "account-unrelated"), "retain");
  await mkdir(path.join(root, "Opensteer"));
  await writeFile(path.join(root, "Opensteer", "AGENTS.md"), "memory");
  return { root, deploymentId, reset, plan };
}

describe("Personal old database reset", () => {
  it("reset-old-lineage-isolated-storage", async () => {
    const { root, reset, plan } = await fixture();
    expect(
      isOldDatabaseDiagnostic(
        "MigrationLineageError: This database belongs to an earlier or unknown Opensteer lineage (old). Start with a fresh database.",
      ),
    ).toBe(true);
    expect(isOldDatabaseDiagnostic("Postgres connection refused")).toBe(false);
    await reset.execute(plan);
    for (const index of [0, 1, 4]) {
      await expect(access(plan.entries[index]!.source)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(plan.entries[index]!.destination)).resolves.toBeUndefined();
    }
    expect(await readFile(path.join(root, "account-unrelated"), "utf8")).toBe("retain");
    expect(await readFile(path.join(root, "Opensteer/AGENTS.md"), "utf8")).toBe("memory");
    expect(await reset.pending()).toBeNull();
  });

  it.each([0, 1, 2, 3, 4])("reset-crash-after-each-rename %s", async (crashIndex) => {
    const { root, reset, plan } = await fixture(async (index) => {
      if (index === crashIndex) throw new Error("crash");
    });
    const otherDeploymentId = createId("deployment");
    const oauth = {
      accessToken: "example-access-token",
      refreshToken: "example-refresh-token",
      accessTokenExpiresAt: "2026-11-11T20:00:00.000Z",
      updatedAt: "2026-11-11T19:00:00.000Z",
      grantedScopes: ["openid"],
    };
    const account = {
      ...oauth,
      issuerOrigin: "https://account.example.test",
      subject: `acct_${crypto.randomUUID()}`,
    };
    const host = (deploymentId: typeof otherDeploymentId) => ({
      ...oauth,
      deploymentId,
      hostInstanceId: createId("hostInstance"),
      canonicalOrigin: "https://host.example.test",
      hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
    });
    const otherHost = host(otherDeploymentId);
    const authState = { schemaVersion: 2, account, hosts: [host(plan.deploymentId), otherHost] };
    await writeFile(
      plan.entries[2]!.source,
      JSON.stringify({
        schemaVersion: 4,
        revision: 0,
        updatedAt: null,
        deployments: [],
        selectedDeploymentId: null,
      }),
      { mode: 0o600 },
    );
    await writeFile(
      plan.entries[3]!.source,
      JSON.stringify({
        schemaVersion: 1,
        ciphertext: Buffer.from(JSON.stringify(authState)).toString("base64"),
      }),
      { mode: 0o600 },
    );
    await expect(reset.execute(plan)).rejects.toThrow("crash");
    const resumed = new PersonalDataReset({ dataDirectory: root, cryptography });
    expect(await resumed.pending()).toEqual(plan);
    await resumed.execute(plan);
    expect(await resumed.pending()).toBeNull();
    for (const entry of plan.entries)
      await expect(access(entry.destination)).resolves.toBeUndefined();
    const activeEnvelope = JSON.parse(await readFile(plan.entries[3]!.source, "utf8"));
    const activeState = JSON.parse(Buffer.from(activeEnvelope.ciphertext, "base64").toString());
    expect(activeState).toEqual({ ...authState, hosts: [otherHost] });
    expect(await resumed.needsFreshStart()).toBe(true);
  });

  it("reset-new-identity-does-not-reuse-old-credentials", async () => {
    const { root, deploymentId, reset, plan } = await fixture();
    const files = new NativePersonalDeploymentFilesystem({
      dataDirectory: root,
      minimumFreeBytes: 0,
    });
    const credentials = new NativePersonalDeploymentCredentials(cryptography);
    const makeManifest = (id: typeof deploymentId) =>
      PersonalDeploymentManifestSchema.parse({
        schemaVersion: 3,
        deploymentId: id,
        environmentId: createId("environment"),
        hostInstanceId: createId("hostInstance"),
        runnerId: createId("runner"),
        setupIntentId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        databaseInitialized: false,
        ownerInitialized: false,
        hostKeyFingerprint: null,
        hostPort: 15431,
        postgresPort: 15432,
        name: "Test",
        revision: 0,
        workspaceRoot: path.join(root, "Opensteer"),
        release: {
          architecture: "arm64",
          operatingSystem: "darwin",
          hostVersion: "1.0.0",
          runnerVersion: "1.0.0",
          postgresMajor: 18,
          postgresVersion: "18.0.0",
          manifestSha256: "a".repeat(64),
        },
      });
    const old = makeManifest(deploymentId);
    const oldSecrets = await credentials.ensure(old, await files.prepare(old));
    await reset.execute(plan);
    const fresh = await files.create(makeManifest(createId("deployment")));
    const nextSecrets = await credentials.ensure(fresh, await files.prepare(fresh));
    expect(fresh.deploymentId).not.toBe(old.deploymentId);
    expect(nextSecrets.databasePassword).not.toBe(oldSecrets.databasePassword);
    expect(nextSecrets.hostAuthSecret).not.toBe(oldSecrets.hostAuthSecret);
    expect(nextSecrets.hostKeyFingerprint).not.toBe(oldSecrets.hostKeyFingerprint);
    expect(desktopDeploymentPaths(root, fresh.deploymentId).rootDirectory).not.toBe(
      plan.entries[0]!.source,
    );
  });
});
