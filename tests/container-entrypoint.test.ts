import { createHash, randomUUID } from "node:crypto";
import { chmod, chown, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expandSecretFiles,
  immutablePackageManifestPath,
  immutableReleaseRecordPath,
  prepareRunnerWorkspaceRoot,
  rejectRuntimeInjectionEnvironment,
  verifyPortableFsArtifact,
  verifyReleaseIdentity,
} from "../deploy/container/opensteer-entrypoint.mjs";

describe("container entrypoint", () => {
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

  it("checks an externally supplied PortableFS artifact by exact digest", async () => {
    const directory = join(tmpdir(), `opensteer-portablefs-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    const binary = join(directory, "portablefs");
    const content = Buffer.from("pinned portablefs fixture");
    await writeFile(binary, content, { mode: 0o700 });
    await chmod(binary, 0o700);

    await expect(
      verifyPortableFsArtifact({
        OPENSTEER_PORTABLEFS_MOUNT_BINARY: binary,
        OPENSTEER_PORTABLEFS_MOUNT_SHA256: createHash("sha256").update(content).digest("hex"),
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts a pre-provisioned managed Runner Workspace root with owner-only mode", async () => {
    const directory = join(tmpdir(), `opensteer-workspace-root-${randomUUID()}`);
    const workspaceRoot = join(directory, "workspaces");
    await mkdir(workspaceRoot, { mode: 0o700, recursive: true });
    // macOS inherits the parent group, including wheel beneath /tmp.
    await chown(workspaceRoot, process.getuid!(), process.getgid!());

    await expect(
      prepareRunnerWorkspaceRoot({
        OPENSTEER_RUNNER_KIND: "managed",
        OPENSTEER_RUNNER_WORKSPACE_ROOT: workspaceRoot,
      }),
    ).resolves.toBeUndefined();
    expect((await stat(workspaceRoot)).mode & 0o777).toBe(0o700);
  });

  it("creates the configured non-managed Runner Workspace root", async () => {
    const directory = join(tmpdir(), `opensteer-workspace-root-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    await chown(directory, process.getuid!(), process.getgid!());
    const workspaceRoot = join(directory, "workspaces");

    await expect(
      prepareRunnerWorkspaceRoot({
        OPENSTEER_RUNNER_KIND: "main",
        OPENSTEER_RUNNER_WORKSPACE_ROOT: workspaceRoot,
      }),
    ).resolves.toBeUndefined();
    expect((await stat(workspaceRoot)).mode & 0o777).toBe(0o700);
  });
});

function packageStamp(version: string, sourceRevision: string): string {
  return JSON.stringify({
    name: "@opensteer/service",
    opensteerBuild: { sourceRevision, version },
    version,
  });
}
