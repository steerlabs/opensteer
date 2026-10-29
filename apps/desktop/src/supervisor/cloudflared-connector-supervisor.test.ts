import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createId, type HostInstanceId } from "@opensteer/core";
import { hostKeyFingerprint } from "@opensteer/deployment-authority";
import { afterEach, describe, expect, it } from "vitest";
import {
  CloudflaredConnectorSupervisor,
  type CloudflaredChildProcess,
  type CloudflaredConnectorConfiguration,
  type SpawnCloudflared,
} from "./cloudflared-connector-supervisor.js";
import { openDesktopPrivateFilesystem } from "../secrets/desktop-private-files.js";
import {
  DeploymentConnectionSchema,
  type DeploymentConnection,
} from "@opensteer/client/connections";
import { testDiscoveryEnvelope } from "@opensteer/client/test-support";
import type { PersonalHostRuntimeRecord } from "./personal-host-runtime.js";
import { testPersonalHostRuntime } from "./personal-host-runtime-test-support.js";

const temporaryDirectories: string[] = [];
const nativeFsHelper = path.resolve(
  import.meta.dirname,
  `../../../runner/native-fs-helper/opensteer-native-fs${process.platform === "win32" ? ".exe" : ""}`,
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("CloudflaredConnectorSupervisor", () => {
  it("starts the pinned binary with a private token file and no secret process inputs", async () => {
    const fixture = await supervisorFixture();
    const token = tunnelToken("first");
    const configuration = connectorConfiguration(fixture.connection, 1, token);
    const tokenFilePath = path.join(
      fixture.dataDirectory,
      "deployments",
      configuration.discovery.deploymentId,
      "runtime",
      "connect",
      "token.v1",
    );
    await fixture.privateFiles.ensureDirectory(path.dirname(tokenFilePath));
    await fixture.privateFiles.writeFileAtomic(tokenFilePath, tunnelToken("stale"));

    await fixture.supervisor.start(configuration);

    expect(fixture.spawn.calls).toHaveLength(1);
    const launched = fixture.spawn.calls[0]!;
    expect(launched.executable).toBe(fixture.binaryPath);
    expect(launched.arguments).toEqual(
      expect.arrayContaining([
        "tunnel",
        "--no-autoupdate",
        "--metrics",
        "127.0.0.1:20421",
        "run",
        "--token-file",
      ]),
    );
    expect(JSON.stringify(launched.arguments)).not.toContain(token);
    expect(JSON.stringify(launched.options.env)).not.toContain(token);
    expect(Object.keys(launched.options.env ?? {})).not.toEqual(
      expect.arrayContaining(["TUNNEL_TOKEN", "CLOUDFLARED_TOKEN"]),
    );
    expect(launched.arguments[launched.arguments.indexOf("--token-file") + 1]).toBe(tokenFilePath);
    expect(await readFile(tokenFilePath, "utf8")).toBe(token);
    // Ingress is remotely configured without path restrictions, including display sockets.
    expect(await readFile(path.join(path.dirname(tokenFilePath), "cloudflared.yml"), "utf8")).toBe(
      "{}\n",
    );
    const connectorManifest = await readFile(
      path.join(path.dirname(tokenFilePath), "connector.v1.json"),
      "utf8",
    );
    expect(connectorManifest).toContain(configuration.discovery.deploymentId);
    expect(connectorManifest).not.toContain(token);
    if (process.platform !== "win32") {
      expect((await lstat(tokenFilePath)).mode & 0o777).toBe(0o600);
    }
    expect(fixture.supervisor.status).toMatchObject({
      deploymentId: configuration.discovery.deploymentId,
      generation: 1,
      state: "healthy",
    });

    for (let index = 0; index < 100; index += 1) {
      launched.child.stdout.write(`${"l".repeat(4_000)}\n`);
    }
    launched.child.stderr.write(`tunnelToken=${token} Bearer ${token} connected\n`);
    await fixture.supervisor.stop();

    await expect(lstat(tokenFilePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(launched.child.signals).toEqual(["SIGTERM"]);
    const logPath = path.join(
      fixture.dataDirectory,
      "deployments",
      configuration.discovery.deploymentId,
      "logs",
      "connect",
      "cloudflared.log",
    );
    const log = await readFile(logPath, "utf8");
    expect(log).not.toContain(token);
    expect(log).toContain("[redacted]");
    expect(Buffer.byteLength(log)).toBeLessThanOrEqual(128 * 1_024);
    expect(Math.max(...log.split("\n").map((line) => line.length))).toBeLessThanOrEqual(2_000);
  });

  it("rotates only to a higher fenced generation and removes the old token file", async () => {
    const fixture = await supervisorFixture();
    const first = connectorConfiguration(fixture.connection, 7, tunnelToken("first"));
    const second = connectorConfiguration(fixture.connection, 8, tunnelToken("second"));
    await fixture.supervisor.start(first);
    const firstLaunch = fixture.spawn.calls[0]!;
    const firstTokenPath = tokenPath(firstLaunch);

    await expect(fixture.supervisor.rotateToken(first)).resolves.toBeUndefined();
    expect(fixture.spawn.calls).toHaveLength(1);
    await expect(
      fixture.supervisor.rotateToken({ ...first, tunnelToken: tunnelToken("different") }),
    ).rejects.toThrow(/reused with different content/u);
    await expect(fixture.supervisor.rotateToken({ ...first, generation: 6 })).rejects.toThrow(
      /stale/u,
    );

    await fixture.supervisor.rotateToken(second);
    expect(fixture.spawn.calls).toHaveLength(2);
    const secondTokenPath = tokenPath(fixture.spawn.calls[1]!);
    expect(secondTokenPath).toBe(firstTokenPath);
    expect(await readFile(secondTokenPath, "utf8")).toBe(second.tunnelToken);
    expect(firstLaunch.child.signals).toEqual(["SIGTERM"]);
    expect(fixture.supervisor.status).toMatchObject({ generation: 8, state: "healthy" });
    await fixture.supervisor.stop();
  });

  it("restarts an exited or unhealthy connector with bounded backoff", async () => {
    const fixture = await supervisorFixture({
      healthFailureThreshold: 1,
      healthIntervalMs: 5,
      restartBackoffBaseMs: 5,
      restartBackoffMaximumMs: 10,
    });
    await fixture.supervisor.start(
      connectorConfiguration(fixture.connection, 1, tunnelToken("restart")),
    );

    fixture.spawn.calls[0]!.child.crash(1);
    await expect.poll(() => fixture.spawn.calls.length, { timeout: 1_000 }).toBe(2);
    await expect.poll(() => fixture.supervisor.status.state, { timeout: 1_000 }).toBe("healthy");

    fixture.health.ready = false;
    await expect.poll(() => fixture.spawn.calls.length, { timeout: 1_000 }).toBeGreaterThan(2);
    expect(fixture.spawn.calls[1]!.child.signals).toContain("SIGTERM");
    fixture.health.ready = true;
    await expect.poll(() => fixture.supervisor.status.state, { timeout: 1_000 }).toBe("healthy");
    await fixture.supervisor.stop();
  });

  it("stops and fences a stale Deployment Host identity instead of restarting it", async () => {
    const fixture = await supervisorFixture({ healthIntervalMs: 5 });
    const configuration = connectorConfiguration(fixture.connection, 1, tunnelToken("fenced"));
    await fixture.supervisor.start(configuration);
    fixture.runtime.current = personalHostRuntime({
      ...fixture.connection,
      authority: {
        ...fixture.connection.authority,
        document: {
          ...fixture.connection.authority.document,
          hostInstanceId: createId("hostInstance"),
        },
      },
    });

    await expect.poll(() => fixture.supervisor.status.state, { timeout: 1_000 }).toBe("fenced");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.spawn.calls).toHaveLength(1);
    expect(fixture.spawn.calls[0]!.child.signals).toContain("SIGTERM");
    await fixture.supervisor.stop();
  });

  it("rejects a catalog-looking connection without a Desktop-owned runtime", async () => {
    const fixture = await supervisorFixture();
    fixture.runtime.current = null;

    await expect(
      fixture.supervisor.start(
        connectorConfiguration(fixture.connection, 1, tunnelToken("catalog-only")),
      ),
    ).rejects.toThrow(/Desktop-owned Personal Host runtime/u);
    expect(fixture.spawn.calls).toHaveLength(0);
    expect(fixture.supervisor.status.state).toBe("stopped");
  });

  it("fails closed when the native private root identity has been replaced", async () => {
    const fixture = await supervisorFixture();
    await rename(fixture.dataDirectory, `${fixture.dataDirectory}.replaced`);
    await mkdir(fixture.dataDirectory, { mode: 0o700 });

    await expect(
      fixture.supervisor.start(
        connectorConfiguration(fixture.connection, 1, tunnelToken("replaced-root")),
      ),
    ).rejects.toThrow(/root identity no longer matches/u);
    expect(fixture.spawn.calls).toHaveLength(0);
    expect(fixture.supervisor.status.state).toBe("stopped");
  });

  it("escalates a graceful stop that does not exit", async () => {
    const fixture = await supervisorFixture({ shutdownTimeoutMs: 5 });
    fixture.spawn.exitOnSigterm = false;
    await fixture.supervisor.start(
      connectorConfiguration(fixture.connection, 1, tunnelToken("shutdown")),
    );

    await fixture.supervisor.stop();
    expect(fixture.spawn.calls[0]!.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

async function supervisorFixture(
  options: {
    readonly healthFailureThreshold?: number;
    readonly healthIntervalMs?: number;
    readonly restartBackoffBaseMs?: number;
    readonly restartBackoffMaximumMs?: number;
    readonly shutdownTimeoutMs?: number;
  } = {},
) {
  const resourcesDirectory = await mkdtemp(path.join(tmpdir(), "opensteer-connect-resources-"));
  const dataParentDirectory = await mkdtemp(path.join(tmpdir(), "opensteer-connect-data-"));
  const dataDirectory = path.join(dataParentDirectory, "Opensteer");
  temporaryDirectories.push(resourcesDirectory, dataParentDirectory);
  const privateFiles = await openDesktopPrivateFilesystem({
    binary: nativeFsHelper,
    root: dataDirectory,
  });
  const releaseDirectory = path.join(resourcesDirectory, "cloudflared");
  await mkdir(releaseDirectory, { mode: 0o700 });
  const binaryPath = path.join(releaseDirectory, "cloudflared");
  const binary = "fixture-cloudflared";
  await writeFile(binaryPath, binary, { mode: 0o555 });
  await chmod(binaryPath, 0o555);
  await writeFile(
    path.join(releaseDirectory, "release.json"),
    JSON.stringify({
      architecture: arch() === "x64" ? "amd64" : arch(),
      binarySha256: createHash("sha256").update(binary).digest("hex"),
      operatingSystem: platform(),
      schemaVersion: 1,
      version: "2026.8.0",
    }),
    { mode: 0o444 },
  );
  const connection = deployment();
  const runtimeState: { current: PersonalHostRuntimeRecord | null } = {
    current: personalHostRuntime(connection),
  };
  const spawn = fakeSpawn();
  const health = { ready: true };
  const supervisor = new CloudflaredConnectorSupervisor({
    allocateMetricsPort: async () => 20_421 + spawn.calls.length,
    fetch: async () =>
      new Response(health.ready ? "ready" : "not ready", { status: health.ready ? 200 : 503 }),
    ...(options.healthFailureThreshold === undefined
      ? {}
      : { healthFailureThreshold: options.healthFailureThreshold }),
    healthIntervalMs: options.healthIntervalMs ?? 100,
    healthRequestTimeoutMs: 50,
    privateFiles,
    resourcesDirectory,
    runtime: { current: async () => runtimeState.current },
    restartBackoffBaseMs: options.restartBackoffBaseMs ?? 5,
    restartBackoffMaximumMs: options.restartBackoffMaximumMs ?? 10,
    restartResetAfterMs: 10_000,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 50,
    spawn,
    startupTimeoutMs: 200,
  });
  return {
    binaryPath,
    connection,
    dataDirectory,
    health,
    privateFiles,
    runtime: runtimeState,
    spawn,
    supervisor,
  };
}

function fakeSpawn(): SpawnCloudflared & {
  calls: Array<{
    readonly arguments: readonly string[];
    readonly child: FakeChild;
    readonly executable: string;
    readonly options: Parameters<SpawnCloudflared>[2];
  }>;
  exitOnSigterm: boolean;
} {
  const calls: Array<{
    readonly arguments: readonly string[];
    readonly child: FakeChild;
    readonly executable: string;
    readonly options: Parameters<SpawnCloudflared>[2];
  }> = [];
  const spawn = ((
    executable: string,
    arguments_: readonly string[],
    options: Parameters<SpawnCloudflared>[2],
  ) => {
    const child = new FakeChild(() => spawn.exitOnSigterm);
    calls.push({ arguments: [...arguments_], child, executable, options });
    return child;
  }) as unknown as SpawnCloudflared & {
    calls: typeof calls;
    exitOnSigterm: boolean;
  };
  spawn.calls = calls;
  spawn.exitOnSigterm = true;
  return spawn;
}

class FakeChild extends EventEmitter implements CloudflaredChildProcess {
  readonly pid = 4_321;
  readonly signals: NodeJS.Signals[] = [];
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
  readonly #exitOnSigterm: () => boolean;
  #exited = false;

  constructor(exitOnSigterm: () => boolean) {
    super();
    this.#exitOnSigterm = exitOnSigterm;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === "SIGKILL" || this.#exitOnSigterm()) this.crash(null, signal);
    return true;
  }

  crash(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.#exited) return;
    this.#exited = true;
    this.stderr.end();
    this.stdout.end();
    queueMicrotask(() => this.emit("exit", code, signal));
  }
}

function deployment(): DeploymentConnection {
  const canonicalOrigin = "http://127.0.0.1:4310";
  const now = "2026-08-11T10:00:00.000Z";
  return DeploymentConnectionSchema.parse({
    authority: testDiscoveryEnvelope({
      canonicalOrigin,
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance") as HostInstanceId,
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: {
        defaultWorkspaceBacking: "local-directory",
        kind: "personal" as const,
      },
    }),
    bootstrapMethods: [],
    createdAt: now,
    endpoints: [{ kind: "canonical", origin: canonicalOrigin, verifiedAt: now }],
    kind: "personal" as const,
    lastUsedAt: null,
    name: "Home Mac",
    reachability: "canonical",
    source: { kind: "manual" },
    updatedAt: now,
  });
}

function connectorConfiguration(
  connection: DeploymentConnection,
  generation: number,
  tunnelTokenValue: string,
): CloudflaredConnectorConfiguration {
  return {
    discovery: connection.authority.document,
    generation,
    hostKeyFingerprint: hostKeyFingerprint(connection.authority.publicKey.spki),
    localOrigin: loopbackCanonicalOrigin(connection),
    schemaVersion: 1,
    tunnelToken: tunnelTokenValue,
  };
}

function personalHostRuntime(connection: DeploymentConnection): PersonalHostRuntimeRecord {
  const localOrigin = loopbackCanonicalOrigin(connection);
  return testPersonalHostRuntime({
    discovery: connection.authority.document,
    localOrigin,
    observedAt: "2026-08-11T10:00:00.000Z",
    ownership: "desktop-personal-host-supervisor",
    schemaVersion: 1,
    state: "ready",
    verification: "signed-loopback-discovery",
  });
}

function loopbackCanonicalOrigin(connection: DeploymentConnection): string {
  const origin = connection.endpoints.find(({ kind }) => kind === "canonical")?.origin;
  if (!origin || !["127.0.0.1", "::1", "localhost"].includes(new URL(origin).hostname)) {
    throw new Error("Fixture has no loopback canonical Host origin.");
  }
  return origin;
}

function tunnelToken(seed: string): string {
  return `eyJ${seed}${"x".repeat(80)}`;
}

function tokenPath(call: { readonly arguments: readonly string[] }): string {
  return call.arguments[call.arguments.indexOf("--token-file") + 1]!;
}
