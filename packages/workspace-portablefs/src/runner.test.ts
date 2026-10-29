import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PortableFsAbortError,
  PortableFsCommandError,
  PortableFsError,
  PortableFsMountCancellationUnverifiedError,
  PortableFsOutputLimitError,
  PortableFsProtocolError,
  PortableFsTimeoutError,
} from "./errors.js";
import { PortableFsCliRunner } from "./runner.js";

const fakePortableFs = `#!/usr/bin/env node
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";

const [command, ...args] = process.argv.slice(2);
const token = process.env.PORTABLEFS_MOUNT_TOKEN;
const logPath = process.env.FAKE_PORTABLEFS_LOG;
const statePath = process.env.FAKE_PORTABLEFS_STATE;
const slowMount = ["slow-mount", "slow-mount-cleanup-fails"].includes(
  process.env.FAKE_PORTABLEFS_MODE ?? "",
);
const slowMountDelayMs = Number(process.env.FAKE_PORTABLEFS_SLOW_MS ?? "2500");
const routeRevision = "11".repeat(32);
if (logPath) appendFileSync(logPath, JSON.stringify({ command, args, token: token ?? null }) + "\\n");

if (process.env.FAKE_PORTABLEFS_MODE === "hang") {
  setInterval(() => {}, 1000);
} else if (
  process.env.FAKE_PORTABLEFS_MODE === "fail" ||
  (process.env.FAKE_PORTABLEFS_MODE === "fail-mount" && command === "mount")
) {
  process.stderr.write("capability rejected: " + token + "\\n");
  process.exitCode = 1;
} else if (process.env.FAKE_PORTABLEFS_MODE === "invalid-json") {
  process.stdout.write("not json");
} else if (process.env.FAKE_PORTABLEFS_MODE === "large-output") {
  process.stdout.write("x".repeat(64 * 1024));
} else if (command === "mount") {
  if (slowMount) {
    if (process.env.FAKE_PORTABLEFS_RELEASE) {
      while (!existsSync(process.env.FAKE_PORTABLEFS_RELEASE)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, slowMountDelayMs));
    }
    if (statePath) writeFileSync(statePath, "mounted");
  }
  process.stdout.write(JSON.stringify({
    authorizationSessionId: "AAAAAAAAAAAAAAAAAAAAAA",
    ok: true,
    pid: 4242,
    strategy: "fuse",
    mountPath: args[1],
    volumeId: process.env.FAKE_PORTABLEFS_MODE === "wrong-volume" ? "volume_other" : args[0],
    localRoutes: ["node_modules/"],
    localRouteRevision: routeRevision,
    futureField: "preserved"
  }));
} else if (command === "mounts") {
  const mounts = slowMount && (!statePath || !existsSync(statePath)) ? [] : [{
    mountPath: "/workspaces/demo",
    volumeId: "volume_demo",
    pid: 4242,
    strategy: "fuse",
    startedAtMs: 123,
    alive: true,
    health: "live",
    futureHealthDetail: "ok"
  }];
  process.stdout.write(JSON.stringify({ mounts, futureEnvelopeField: true }));
} else if (command === "mount-check") {
  if (process.env.FAKE_PORTABLEFS_MODE === "blocked") {
    process.stdout.write(JSON.stringify({
      schemaVersion: 1,
      error: { kind: "blocked", code: "fuse-device-missing", message: "missing /dev/fuse" }
    }));
    process.exitCode = 1;
  } else {
    process.stdout.write(JSON.stringify({
      schemaVersion: 1,
      facts: {
        transport: "fuse",
        state: "unverified",
        summary: "no blocker observed",
        details: [{ key: "device", value: "/dev/fuse" }],
        futureFact: true
      }
    }));
  }
} else if (command === "version") {
  process.stdout.write(JSON.stringify({
    features: ["hosted-automatic-mount-reauthorization-v2"],
    version: "v3-dev",
    futureBuildField: "origin-main"
  }));
} else if (command === "umount") {
  if (process.env.FAKE_PORTABLEFS_MODE === "slow-mount-cleanup-fails") {
    process.stderr.write("identity-safe unmount refused");
    process.exitCode = 1;
  } else {
    if (statePath && existsSync(statePath)) unlinkSync(statePath);
    process.stdout.write(JSON.stringify({
      mountPath: args[0],
      volumeId: "volume_demo",
      unmounted: true,
      tracked: true,
      futureField: true
    }));
  }
} else if (command === "route") {
  process.stdout.write(JSON.stringify({
    path: args[0],
    mountPath: "/workspaces/demo",
    volumeId: "volume_demo",
    volumePath: "node_modules/pkg",
    storage: "machine-local",
    revision: routeRevision,
    backingExists: true,
    futureField: true
  }));
} else {
  process.stderr.write("unexpected command");
  process.exitCode = 2;
}
`;

describe("PortableFsCliRunner", () => {
  let directory: string;
  let binary: string;
  let logPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "opensteer-portablefs-runner-"));
    binary = join(directory, "portablefs.mjs");
    logPath = join(directory, "calls.jsonl");
    await writeFile(binary, fakePortableFs, { mode: 0o700 });
    await chmod(binary, 0o700);
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  function runner(environment: NodeJS.ProcessEnv = {}): PortableFsCliRunner {
    return new PortableFsCliRunner({
      binary,
      environment: {
        ...process.env,
        ...environment,
        FAKE_PORTABLEFS_LOG: logPath,
        FAKE_PORTABLEFS_STATE: join(directory, "mount-state"),
      },
      terminationGraceMs: 25,
    });
  }

  async function calls(): Promise<
    Array<{ readonly args: string[]; readonly command: string; readonly token: string | null }>
  > {
    const contents = await readFile(logPath, "utf8");
    return contents
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map(
        (line) =>
          JSON.parse(line) as {
            readonly args: string[];
            readonly command: string;
            readonly token: string | null;
          },
      );
  }

  function automaticReauthorization() {
    return {
      authorityGeneration: 7,
      authorizationExpiresAtMs: 1_900_000_000_000,
      enrollmentCertificatePath: "/run/opensteer/enrollment.pem",
      enrollmentId: "11111111-1111-4111-8111-111111111111",
      managerCaPath: "/run/opensteer/manager-ca.pem",
      managerServerName: "manager.internal",
      managerUrl: "https://manager.internal",
    } as const;
  }

  it("uses only the current v3 mount CLI and passes the capability through env", async () => {
    const capability = "v1.secret-payload.secret-signature";
    const result = await runner().mount({
      automaticReauthorization: automaticReauthorization(),
      authorityAddress: "authority.internal:7443",
      capability,
      clientCertificatePath: "/run/opensteer/client.pem",
      clientKeyPath: "/run/opensteer/client.key",
      coherence: "strict",
      mountPath: "/workspaces/demo",
      strategy: "fuse",
      tls: {
        caPath: "/run/opensteer/authority-ca.pem",
        serverName: "authority.internal",
        transport: "tls-private-ca",
      },
      volumeId: "volume_demo",
    });

    expect(result).toMatchObject({
      futureField: "preserved",
      mountPath: "/workspaces/demo",
      ok: true,
      volumeId: "volume_demo",
    });
    const call = (await calls()).find((candidate) => candidate.command === "mount");
    expect(call?.command).toBe("mount");
    expect(call?.token).toBe(capability);
    expect(call?.args).toEqual([
      "volume_demo",
      "/workspaces/demo",
      "--addr",
      "authority.internal:7443",
      "--data-plane-transport",
      "tls-private-ca",
      "--data-plane-server-name",
      "authority.internal",
      "--data-plane-ca",
      "/run/opensteer/authority-ca.pem",
      "--client-cert",
      "/run/opensteer/client.pem",
      "--client-key",
      "/run/opensteer/client.key",
      "--coherence",
      "strict",
      "--strategy",
      "fuse",
      "--auth-expires-at-ms",
      "1900000000000",
      "--manager-url",
      "https://manager.internal",
      "--manager-server-name",
      "manager.internal",
      "--manager-ca",
      "/run/opensteer/manager-ca.pem",
      "--mount-enrollment-id",
      "11111111-1111-4111-8111-111111111111",
      "--mount-enrollment-cert",
      "/run/opensteer/enrollment.pem",
      "--authority-generation",
      "7",
      "--json",
    ]);
    expect(call?.args).not.toContain(capability);
    expect(call?.args).not.toContain("--mount-token");
    expect(call?.args).not.toContain("--branch");
    expect(call?.args).not.toContain("--fast");
    expect(call?.args).not.toContain("--local-dir");
  });

  it("strips an ambient mount capability from every non-mount command", async () => {
    const instance = runner({ PORTABLEFS_MOUNT_TOKEN: "ambient-secret" });
    const version = await instance.getVersion();
    const result = await instance.listMounts();

    expect(version).toMatchObject({ futureBuildField: "origin-main", version: "v3-dev" });
    expect(result.mounts[0]).toMatchObject({ health: "live", volumeId: "volume_demo" });
    expect((await calls())[0]?.token).toBeNull();
    expect((await calls())[1]?.token).toBeNull();
  });

  it("returns structured blocked mount-check diagnostics from exit 1", async () => {
    const result = await runner({ FAKE_PORTABLEFS_MODE: "blocked" }).checkMountSupport();

    expect(result).toMatchObject({
      error: { code: "fuse-device-missing", kind: "blocked" },
      schemaVersion: 1,
    });

    await expect(
      runner({ FAKE_PORTABLEFS_MODE: "fail" }).checkMountSupport(),
    ).rejects.toBeInstanceOf(PortableFsCommandError);
  });

  it("wraps unmount and route without retired state", async () => {
    const instance = runner();
    const unmounted = await instance.unmount({ force: true, mountPath: "/workspaces/demo" });
    const route = await instance.explainRoute("/workspaces/demo/node_modules/pkg");

    expect(unmounted).toMatchObject({ tracked: true, unmounted: true });
    expect(route).toMatchObject({ storage: "machine-local", volumePath: "node_modules/pkg" });
    const [unmountCall, routeCall] = await calls();
    expect(unmountCall?.args).toEqual(["/workspaces/demo", "--force", "--json"]);
    expect(routeCall?.args).toEqual(["/workspaces/demo/node_modules/pkg", "--json"]);
  });

  it("redacts a mount capability from command errors and error metadata", async () => {
    const capability = "v1.private-payload.private-signature";
    let thrown: unknown;
    try {
      await runner({ FAKE_PORTABLEFS_MODE: "fail-mount" }).mount({
        automaticReauthorization: automaticReauthorization(),
        authorityAddress: "authority.internal:7443",
        capability,
        clientCertificatePath: "/run/opensteer/client.pem",
        clientKeyPath: "/run/opensteer/client.key",
        mountPath: "/workspaces/demo",
        tls: { serverName: "authority.internal", transport: "tls-system-pki" },
        volumeId: "volume_demo",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PortableFsCommandError);
    const commandError = thrown as PortableFsCommandError;
    expect(commandError.stderr).toContain("[REDACTED]");
    expect(commandError.stderr).not.toContain(capability);
    expect(commandError.message).not.toContain(capability);
    expect(commandError.argv.join(" ")).not.toContain(capability);
  });

  it("rejects a successful mount response for a different volume", async () => {
    await expect(
      runner({ FAKE_PORTABLEFS_MODE: "wrong-volume" }).mount({
        automaticReauthorization: automaticReauthorization(),
        authorityAddress: "authority.internal:7443",
        capability: "v1.private-payload.private-signature",
        clientCertificatePath: "/run/opensteer/client.pem",
        clientKeyPath: "/run/opensteer/client.key",
        mountPath: "/workspaces/demo",
        tls: { serverName: "authority.internal", transport: "tls-system-pki" },
        volumeId: "volume_demo",
      }),
    ).rejects.toBeInstanceOf(PortableFsProtocolError);
  });

  it("enforces timeouts and caller cancellation", async () => {
    await expect(
      runner({ FAKE_PORTABLEFS_MODE: "hang" }).listMounts({ timeoutMs: 100 }),
    ).rejects.toBeInstanceOf(PortableFsTimeoutError);

    const controller = new AbortController();
    const promise = runner({ FAKE_PORTABLEFS_MODE: "hang" }).listMounts({
      signal: controller.signal,
      timeoutMs: 2_000,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toBeInstanceOf(PortableFsAbortError);
  });

  it("lets a daemonizing mount settle, then unmounts and proves absence on timeout", async () => {
    const instance = runner({
      FAKE_PORTABLEFS_MODE: "slow-mount",
      FAKE_PORTABLEFS_SLOW_MS: "2500",
    });
    await expect(
      instance.mount(
        {
          automaticReauthorization: automaticReauthorization(),
          authorityAddress: "authority.internal:7443",
          capability: "v1.private-payload.private-signature",
          clientCertificatePath: "/run/opensteer/client.pem",
          clientKeyPath: "/run/opensteer/client.key",
          mountPath: "/workspaces/demo",
          tls: { serverName: "authority.internal", transport: "tls-system-pki" },
          volumeId: "volume_demo",
        },
        { timeoutMs: 2_000 },
      ),
    ).rejects.toBeInstanceOf(PortableFsTimeoutError);

    expect((await calls()).map((call) => call.command)).toEqual([
      "mounts",
      "mount",
      "umount",
      "mounts",
    ]);
    await expect(access(join(directory, "mount-state"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when cancellation cleanup cannot prove the mount absent", async () => {
    const controller = new AbortController();
    const release = join(directory, "release-mount");
    const mounting = runner({
      FAKE_PORTABLEFS_MODE: "slow-mount-cleanup-fails",
      FAKE_PORTABLEFS_RELEASE: release,
    }).mount(
      {
        automaticReauthorization: automaticReauthorization(),
        authorityAddress: "authority.internal:7443",
        capability: "v1.private-payload.private-signature",
        clientCertificatePath: "/run/opensteer/client.pem",
        clientKeyPath: "/run/opensteer/client.key",
        mountPath: "/workspaces/demo",
        tls: { serverName: "authority.internal", transport: "tls-system-pki" },
        volumeId: "volume_demo",
      },
      { signal: controller.signal, timeoutMs: 30_000 },
    );
    void mounting.catch(() => undefined);
    try {
      // Preflight and mount are separate Node subprocesses, slow to start under suite load.
      await expect
        .poll(async () => (await calls()).some((call) => call.command === "mount"), {
          timeout: 15_000,
        })
        .toBe(true);
      // Cancellation must occur after mount starts, not during the preflight subprocess.
      controller.abort();
    } finally {
      await writeFile(release, "release");
    }
    await expect(mounting).rejects.toBeInstanceOf(PortableFsMountCancellationUnverifiedError);
    await expect(mounting).rejects.toMatchObject({
      code: "mount_cancellation_unverified",
      requestedStop: "aborted",
      upstreamPrerequisite: "portablefs-identity-safe-mount-cancel",
    });
    await expect(access(join(directory, "mount-state"))).resolves.toBeUndefined();
  }, 20_000);

  it("rejects invalid success JSON and bounded output with typed errors", async () => {
    await expect(
      runner({ FAKE_PORTABLEFS_MODE: "invalid-json" }).listMounts(),
    ).rejects.toBeInstanceOf(PortableFsProtocolError);
    await expect(
      new PortableFsCliRunner({
        binary,
        environment: {
          ...process.env,
          FAKE_PORTABLEFS_LOG: logPath,
          FAKE_PORTABLEFS_MODE: "large-output",
        },
        maxOutputBytes: 1024,
        terminationGraceMs: 25,
      }).listMounts(),
    ).rejects.toBeInstanceOf(PortableFsOutputLimitError);

    await expect(
      new PortableFsCliRunner({ binary: join(directory, "missing-portablefs") }).listMounts(),
    ).rejects.toMatchObject({ code: "spawn_failed" });
  });

  it("rejects invalid paths before executing anything", async () => {
    await expect(
      runner().mount({
        automaticReauthorization: automaticReauthorization(),
        authorityAddress: "authority.internal:7443",
        capability: "secret",
        clientCertificatePath: "/run/opensteer/client.pem",
        clientKeyPath: "/run/opensteer/client.key",
        mountPath: "relative/workspace",
        tls: { serverName: "authority.internal", transport: "tls-system-pki" },
        volumeId: "volume_demo",
      }),
    ).rejects.toBeInstanceOf(PortableFsError);
    await expect(readFile(logPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
