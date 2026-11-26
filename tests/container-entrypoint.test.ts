import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expandSecretFiles,
  findExecutable,
  handOver,
  nodeServiceArguments,
  immutablePackageManifestPath,
  immutableReleaseRecordPath,
  rejectRuntimeInjectionEnvironment,
  serviceEnvironment,
  verifyReleaseIdentity,
} from "../deploy/container/opensteer-entrypoint.mjs";

describe("container entrypoint", () => {
  it.each(["@opensteer/host", "@opensteer/runner", "@opensteer/channel-runtime"])(
    "starts %s trusting its container's certificates and keeping its operator's",
    (service) => {
      const started = serviceEnvironment(service, {
        NODE_EXTRA_CA_CERTS: "/home-proof-account-ca.pem",
        OPENSTEER_MODE: "production",
        SSL_CERT_DIR: "/etc/ssl/certs",
      });
      expect(started).toEqual({
        NODE_EXTRA_CA_CERTS: "/home-proof-account-ca.pem",
        NODE_USE_SYSTEM_CA: "1",
        OPENSTEER_MODE: "production",
        SSL_CERT_DIR: "/etc/ssl/certs",
      });
    },
  );

  it.each([
    "@opensteer/control-plane",
    "@opensteer/home-provisioner",
    "@opensteer/browser-runtime",
    null,
  ])("leaves the trust of %s, which is not a Home service, as it was", (service) => {
    const environment = { OPENSTEER_MODE: "production" };
    expect(serviceEnvironment(service, environment)).toEqual({ OPENSTEER_MODE: "production" });
  });

  it("reads the off switch from the environment it starts the service with", () => {
    expect(process.env.OPENSTEER_SYSTEM_CERTIFICATES).toBeUndefined();
    expect(
      serviceEnvironment("@opensteer/host", {
        OPENSTEER_MODE: "production",
        OPENSTEER_SYSTEM_CERTIFICATES: "off",
      }),
    ).toEqual({ OPENSTEER_MODE: "production", OPENSTEER_SYSTEM_CERTIFICATES: "off" });
  });

  it("names the service its package stamp is for", async () => {
    await expect(
      verifyReleaseIdentity(
        {},
        async () =>
          JSON.stringify({ schemaVersion: 1, sourceRevision: "a".repeat(40), version: "1.2.3" }),
        async () => packageStamp("1.2.3", "a".repeat(40)),
      ),
    ).resolves.toBe("@opensteer/service");
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

  it("hands the process over to the service: the same process ID, no wrapper left behind", () => {
    const entrypoint = join(import.meta.dirname, "../deploy/container/opensteer-entrypoint.mjs");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const { handOver } = await import(${JSON.stringify(entrypoint)});
         process.stdout.write(process.pid + "\\n");
         handOver("sh", ["-c", 'echo "$$ $SERVICE"; exit 7'], { PATH: process.env.PATH, SERVICE: "started" });`,
      ],
      { encoding: "utf8" },
    );
    const [before, after] = result.stdout.trim().split("\n");
    // The service runs as this process: its exit is the container's, and tini signals it directly.
    expect(after).toBe(`${before} started`);
    expect(result.status).toBe(7);
  });

  it("names a service it cannot find instead of handing over to nothing", () => {
    const calls: unknown[] = [];
    expect(() =>
      handOver("no-such-opensteer-service", [], { PATH: "/usr/bin:/bin" }, (...call) => {
        calls.push(call);
        throw new Error("handed over");
      }),
    ).toThrow("Could not start Opensteer: no-such-opensteer-service was not found.");
    expect(calls).toEqual([]);
    expect(findExecutable("sh", "relative:/bin:/usr/bin")).toMatch(/^\/(usr\/)?bin\/sh$/u);
    expect(findExecutable("sh", "relative")).toBe(undefined);
  });

  it.each(["@opensteer/host", "@opensteer/runner", "@opensteer/channel-runtime"])(
    "starts %s's Node with a small young generation and the old space its Home sized",
    (service) => {
      const environment: Record<string, string> = { OPENSTEER_NODE_OLD_SPACE_MB: "642" };
      expect(nodeServiceArguments(service, "node", ["dist/main.js"], environment)).toEqual([
        "--max-semi-space-size=4",
        "--max-old-space-size=642",
        "dist/main.js",
      ]);
      // The size goes no further than this Node's flags.
      expect(environment).toEqual({});
      // A Home that sizes nothing (a self-hosted one) still gets the small young generation.
      expect(nodeServiceArguments(service, "node", ["dist/main.js"], {})).toEqual([
        "--max-semi-space-size=4",
        "dist/main.js",
      ]);
      expect(() =>
        nodeServiceArguments(service, "node", [], { OPENSTEER_NODE_OLD_SPACE_MB: "642 --inspect" }),
      ).toThrow("OPENSTEER_NODE_OLD_SPACE_MB must be a number of MiB.");
    },
  );

  it("leaves another image's command as it was", () => {
    for (const [service, command] of [
      ["@opensteer/control-plane", "node"],
      ["@opensteer/browser-runtime", "node"],
      ["@opensteer/host", "sh"],
    ] as const)
      expect(
        nodeServiceArguments(service, command, ["dist/main.js"], {
          OPENSTEER_NODE_OLD_SPACE_MB: "64",
        }),
      ).toEqual(["dist/main.js"]);
  });

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
