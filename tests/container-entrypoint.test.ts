import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expandSecretFiles,
  immutablePackageManifestPath,
  immutableReleaseRecordPath,
  rejectRuntimeInjectionEnvironment,
  verifyReleaseIdentity,
} from "../deploy/container/opensteer-entrypoint.mjs";
import { loadProvisionerConfig } from "../apps/team-provisioner/src/config.js";
import { newTeamSecret, renderTeam } from "../apps/team-provisioner/src/template.js";
import { parseHostConfig } from "../packages/config/src/config.js";

describe("container entrypoint", () => {
  it("starts a hosted team Host from the Deployment and Secret the provisioner writes", async () => {
    const directory = join(tmpdir(), `opensteer-team-host-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    const id = "0b8f2b5e-3c0a-4b8e-9c47-6c1f3a2d9e10";
    const secret = newTeamSecret({
      id,
      slug: "acme",
      setupTokenDigest: "a".repeat(64),
      databaseUrl: "postgresql://team:secret@db.example.com:5432/team?sslmode=verify-full",
      databaseCa: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
    }) as { stringData: Record<string, string> };
    for (const [name, value] of Object.entries(secret.stringData))
      await writeFile(join(directory, name), value, { mode: 0o600 });
    const deployment = renderTeam({
      id,
      slug: "acme",
      name: "Acme",
      images: { host: `ghcr.io/steerlabs/opensteer-team-host@sha256:${"1".repeat(64)}` },
      platform: { databaseIp: "10.1.1.1", bucket: "teams", databaseCaDigest: "ca-1" },
      replicas: 1,
      setupGeneration: 1,
    }).find((object) => object.kind === "Deployment") as unknown as {
      spec: {
        template: { spec: { containers: { env: { name: string; value?: string }[] }[] } };
      };
    };
    const environment: NodeJS.ProcessEnv = Object.fromEntries(
      deployment.spec.template.spec.containers[0]!.env.map(({ name, value }) => [
        name,
        value?.replace("/run/secrets/host/", `${directory}/`),
      ]),
    );
    await expandSecretFiles(environment);
    expect(parseHostConfig(environment).strictInstallation).toBe(true);
  });
  it("starts the team provisioner from the settings its Deployment mounts", async () => {
    const directory = join(tmpdir(), `opensteer-provisioner-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    const ca = join(directory, "ca.pem");
    await writeFile(ca, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
    // As teams-1's team-platform ConfigMap and the provisioner Deployment set them.
    const environment: NodeJS.ProcessEnv = {
      OPENSTEER_ACCOUNT_URL: "https://accounts.opensteer.com",
      OPENSTEER_TEAM_HOST_IMAGE: `ghcr.io/steerlabs/opensteer-team-host@sha256:${"a".repeat(64)}`,
      OPENSTEER_TEAM_DATABASE_IP: "10.40.0.2",
      OPENSTEER_TEAM_DATABASE_HOST: "abc.def.us-west1.sql-psa.goog",
      OPENSTEER_TEAM_DATABASE_CA_FILE: ca,
      OPENSTEER_PROVISIONER_DATABASE_USER: "team-provisioner@opensteer-prod.iam",
      OPENSTEER_TEAM_GCS_BUCKET: "opensteer-prod-team-files",
      OPENSTEER_GOOGLE_PROJECT: "opensteer-prod",
      OPENSTEER_GOOGLE_PROJECT_NUMBER: "285547258220",
      KUBERNETES_SERVICE_HOST: "10.0.0.1",
      KUBERNETES_SERVICE_PORT: "443",
    };
    await expandSecretFiles(environment);
    expect(loadProvisionerConfig(environment).platform.databaseCa).toContain(
      "-----BEGIN CERTIFICATE-----",
    );
  });
  it("loads the immutable image release record into the child process", async () => {
    const directory = join(tmpdir(), `opensteer-release-record-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    const record = join(directory, "release.json");
    await writeFile(
      record,
      `${JSON.stringify({
        schemaVersion: 1,
        sourceRevision: "a".repeat(40),
        version: "1.2.3",
      })}\n`,
      { mode: 0o444 },
    );

    const environment: NodeJS.ProcessEnv = {};
    await verifyReleaseIdentity(
      environment,
      async (recordPath: string) => {
        expect(recordPath).toBe(immutableReleaseRecordPath);
        return await import("node:fs/promises").then(({ readFile }) => readFile(record, "utf8"));
      },
      async (manifestPath: string) => {
        expect(manifestPath).toBe(immutablePackageManifestPath);
        return packageStamp("1.2.3", "a".repeat(40));
      },
    );
    expect(environment).toMatchObject({
      OPENSTEER_RELEASE_RECORD: immutableReleaseRecordPath,
      OPENSTEER_RELEASE_VERSION: "1.2.3",
      OPENSTEER_SOURCE_REVISION: "a".repeat(40),
    });
  });

  it("rejects a runtime override that disagrees with the immutable release record", async () => {
    const directory = join(tmpdir(), `opensteer-release-record-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    const record = join(directory, "release.json");
    await writeFile(
      record,
      `${JSON.stringify({
        schemaVersion: 1,
        sourceRevision: "a".repeat(40),
        version: "1.2.3",
      })}\n`,
    );
    await expect(
      verifyReleaseIdentity(
        { OPENSTEER_RELEASE_VERSION: "1.2.4" },
        () => import("node:fs/promises").then(({ readFile }) => readFile(record, "utf8")),
        async () => packageStamp("1.2.3", "a".repeat(40)),
      ),
    ).rejects.toThrow(/does not match the immutable Opensteer release record/u);
  });

  it("refuses any attempt to redirect the immutable image record", async () => {
    let read = false;
    await expect(
      verifyReleaseIdentity(
        { OPENSTEER_RELEASE_RECORD: "/mounted/fake-release.json" },
        async () => {
          read = true;
          return "{}";
        },
        async () => packageStamp("1.2.3", "a".repeat(40)),
      ),
    ).rejects.toThrow(/cannot redirect/u);
    expect(read).toBe(false);
  });

  it.each([
    { sourceRevision: "a".repeat(40), version: "0.0.0" },
    { sourceRevision: "unknown", version: "1.2.3" },
  ])("rejects an invalid image release record", async (identity) => {
    const directory = join(tmpdir(), `opensteer-release-record-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    const record = join(directory, "release.json");
    await writeFile(record, `${JSON.stringify({ schemaVersion: 1, ...identity })}\n`);
    await expect(
      verifyReleaseIdentity(
        {},
        () => import("node:fs/promises").then(({ readFile }) => readFile(record, "utf8")),
        async () => packageStamp(identity.version, identity.sourceRevision),
      ),
    ).rejects.toThrow(/release record is invalid/u);
  });

  it("rejects a missing or mismatched fixed package stamp", async () => {
    const record = async () =>
      JSON.stringify({ schemaVersion: 1, sourceRevision: "a".repeat(40), version: "1.2.3" });
    await expect(
      verifyReleaseIdentity({}, record, async () => {
        throw new Error("missing");
      }),
    ).rejects.toThrow(/Could not read the fixed Opensteer package stamp/u);
    await expect(
      verifyReleaseIdentity({}, record, async () => packageStamp("1.2.4", "a".repeat(40))),
    ).rejects.toThrow(/does not match the immutable release record/u);
  });

  it.each(["LD_AUDIT", "LD_PRELOAD", "NODE_OPTIONS", "NODE_PATH"])(
    "rejects the process-injection variable %s",
    (name) => {
      expect(() => rejectRuntimeInjectionEnvironment({ [name]: "untrusted" })).toThrow(
        /cannot alter the immutable Opensteer runtime/u,
      );
    },
  );

  it("loads file-backed environment values without passing the file variable", async () => {
    const directory = join(tmpdir(), `opensteer-entrypoint-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    const secretPath = join(directory, "token");
    await writeFile(secretPath, "a-secret-value\n", { mode: 0o600 });

    const environment: NodeJS.ProcessEnv = { TEST_TOKEN_FILE: secretPath };
    await expandSecretFiles(environment);
    expect(environment.TEST_TOKEN).toBe("a-secret-value");
    expect(environment.TEST_TOKEN_FILE).toBeUndefined();
  });
});

function packageStamp(version: string, sourceRevision: string): string {
  return JSON.stringify({
    name: "@opensteer/service",
    opensteerBuild: { sourceRevision, version },
    version,
  });
}
