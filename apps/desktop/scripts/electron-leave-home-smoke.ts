import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { app, session } from "electron";
import {
  createId,
  DeploymentIdSchema,
  RunnerIdSchema,
  shippedHarnessKindRecord,
  shippedHarnessKinds,
  type DeploymentId,
} from "@opensteer/core";
import {
  signTestDiscoveryEnvelope,
  signTestPersonalAccessRoute,
  testHostAuthorityKeys,
} from "@opensteer/client/test-support";
import { RunnerLeaveRequestSchema, type HostApiClient } from "@opensteer/protocol";
import { verifyDeviceLeaveSignature } from "@opensteer/runner-auth";
import { ElectronHostNetwork } from "../src/app/electron-host-network.js";
import { ElectronServiceNetwork } from "../src/app/electron-service-network.js";
import type { DesktopConfiguration } from "../src/config.js";
import {
  LocalRunnerDeploymentUnavailableError,
  type DesktopLocalRunnerTarget,
  type DesktopLocalRunnerTargetAuthority,
} from "../src/supervisor/local-runner-authority.js";
import {
  LocalRunnerService,
  type LocalRunnerServiceDependencies,
  type UtilityProcessLike,
} from "../src/supervisor/local-runner-service.js";
import { installSmokeGuard } from "./test-support/smoke-guard.js";

/**
 * A Mac that is a device of two Homes leaves one of them, in real Electron.
 *
 * Real here: Electron's persistent per-Home session partitions (`ElectronHostNetwork`, the
 * HttpOnly session cookie each Home set over Electron's own network), the leave proof delivered
 * over Electron's network (`ElectronServiceNetwork`, as main wires `leaveFetch`), the app's own
 * stores on disk (device memberships, each Home's Runner folder and its identity key), and
 * `LocalRunnerService`, which the window's Leave reaches through `opensteer.desktop.device.leave`.
 * Stand-ins: each Home is a loopback HTTPS server at its signed private route (its test
 * certificate trusted by exactly the partitions that reach it) that answers the two requests this
 * path makes of a Home (its sign-in cookie, POST /v1/runner/leave) and the Home API main calls (session list and
 * bind) answers in memory; the Runner worker is a fake process that writes its identity the way the
 * real one does, because a real worker needs a real Home to enroll with.
 */
installSmokeGuard("leave-home", 120_000);

const root = mkdtempSync(
  path.join(process.env.OPENSTEER_LEAVE_HOME_E2E_ARTIFACT_DIR ?? tmpdir(), "opensteer-leave-home-"),
);
const artifactPath = path.join(root, "leave-home.json");
const began = Date.now();
const events: { readonly ms: number; readonly kind: string; readonly [field: string]: unknown }[] =
  [];
const checks: Record<string, unknown> = {};
app.setPath("userData", path.join(root, "profile"));
app.on("window-all-closed", () => undefined);
const watchdog = setTimeout(() => finish(1, "Smoke exceeded its 90 second deadline."), 90_000);
const servers: Server[] = [];
void run().then(
  () => finish(0),
  (error: unknown) => finish(1, String(error instanceof Error ? error.stack : error)),
);

function record(kind: string, fields: object = {}): void {
  events.push({ ms: Date.now() - began, kind, ...fields });
}

function finish(code: number, error?: string): void {
  clearTimeout(watchdog);
  for (const server of servers) server.close();
  writeFileSync(
    artifactPath,
    `${JSON.stringify({ code, electron: process.versions.electron, checks, events, error }, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify({ code, artifactPath, error })}\n`);
  app.exit(code);
}

interface FixtureHome {
  readonly name: string;
  readonly origin: string;
  readonly leaves: unknown[];
}

/** One test certificate for every fixture Home; only the partitions that reach them trust it. */
function testCertificate(): { readonly key: Buffer; readonly cert: Buffer } {
  const keyPath = path.join(root, "home-key.pem");
  const certPath = path.join(root, "home-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

/** A Home's two answers on this path, at its HTTPS route: its sign-in cookie, and a device's leave. */
async function startHome(
  name: string,
  certificate: { readonly key: Buffer; readonly cert: Buffer },
): Promise<FixtureHome> {
  const leaves: unknown[] = [];
  const server = createServer(certificate, (request, response) => {
    if (request.method === "GET" && request.url === "/v1/session") {
      response.setHeader(
        "set-cookie",
        `opensteer.session=${name}-${randomBytes(12).toString("hex")}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
      );
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ signedIn: true }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/runner/leave") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        leaves.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        record("home.leave-received", { home: name });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ outcome: "removed" }));
      });
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return { name, origin: `https://127.0.0.1:${address.port}`, leaves };
}

class WorkerStandIn extends EventEmitter implements UtilityProcessLike {
  readonly stderr = new PassThrough();
  readonly stdout = new PassThrough();
  readonly messages: unknown[] = [];
  readonly dataDirectory: string;
  kills = 0;

  constructor(dataDirectory: string) {
    super();
    this.dataDirectory = dataDirectory;
  }

  kill(): boolean {
    this.kills += 1;
    this.emit("exit", 143);
    return true;
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }
}

/** Told to stop, or killed. */
function stopped(child: WorkerStandIn): boolean {
  return (
    child.kills > 0 ||
    child.messages.some(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "runner.worker.stop",
    )
  );
}

function identityPath(dataDirectory: string): string {
  return path.join(dataDirectory, "identity.json");
}

/** What the real worker keeps in its Runner folder: its key, and whether a Home welcomed it. */
function writeIdentity(dataDirectory: string, enrolled: boolean): void {
  const existing = existsSync(identityPath(dataDirectory))
    ? (JSON.parse(readFileSync(identityPath(dataDirectory), "utf8")) as Record<string, unknown>)
    : null;
  const pair = generateKeyPairSync("ed25519");
  writeFileSync(
    identityPath(dataDirectory),
    JSON.stringify({
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      version: 3,
      lastConnectionGeneration: enrolled ? 1 : 0,
      privateKeyPem:
        existing?.privateKeyPem ??
        pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      publicKeyPem:
        existing?.publicKeyPem ?? pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      environmentId: existing?.environmentId ?? createId("environment"),
      runnerId: existing?.runnerId ?? createId("runner"),
    }),
    { mode: 0o600 },
  );
}

function readIdentity(dataDirectory: string) {
  if (!existsSync(identityPath(dataDirectory))) return null;
  return JSON.parse(readFileSync(identityPath(dataDirectory), "utf8")) as {
    readonly lastConnectionGeneration: number;
    readonly environmentId: string;
    readonly runnerId: string;
    readonly privateKeyPem: string;
    readonly publicKeyPem: string;
  };
}

/** The Home's welcome, which is what marks the identity enrolled. */
function welcome(child: WorkerStandIn): void {
  writeIdentity(child.dataDirectory, true);
  const identity = readIdentity(child.dataDirectory);
  assert(identity);
  child.emit("message", {
    environmentId: identity.environmentId,
    runnerId: identity.runnerId,
    type: "runner.worker.connected",
  });
}

function targetFor(home: FixtureHome): DesktopLocalRunnerTarget {
  const deploymentId = createId("deployment");
  const keys = testHostAuthorityKeys();
  const authority = signTestDiscoveryEnvelope(
    {
      deploymentId,
      hostInstanceId: createId("hostInstance"),
      // A Home on this Mac's network, reached by its signed private route.
      canonicalOrigin: "http://127.0.0.1:4310",
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: { kind: "personal" },
    },
    keys,
  );
  const accessRoute = signTestPersonalAccessRoute(
    {
      authority: { ...authority.document, deploymentShape: { kind: "personal" } },
      documentVersion: 2,
      purpose: "opensteer-personal-access-route",
      route: { generation: 1, kind: "private", origin: home.origin },
    },
    keys,
  );
  return {
    devicesAvailable: true,
    authority,
    accessRoute,
    source: { kind: "manual" },
    deploymentId,
    deploymentShape: { kind: "personal" },
    hostUrl: home.origin,
    key: `${deploymentId}:1`,
    mayRunAgents: true,
  };
}

function targetAuthority(
  targets: readonly DesktopLocalRunnerTarget[],
): DesktopLocalRunnerTargetAuthority {
  const byId = new Map(targets.map((target) => [target.deploymentId, target]));
  return {
    isCurrent: async (candidate) => byId.get(candidate.deploymentId)?.key === candidate.key,
    resolve: async (input) => {
      const target = byId.get(DeploymentIdSchema.parse(input));
      if (!target) throw new LocalRunnerDeploymentUnavailableError("Deployment is unavailable.");
      return target;
    },
    subscribe: () => () => undefined,
  };
}

/** The Home API main calls while a device connects: its session, and binding it to the Runner. */
function homeApi(): NonNullable<LocalRunnerServiceDependencies["hostApi"]> {
  const sessions = new Map<DeploymentId, { id: string; deviceId: string | null }>();
  return (deploymentId) => {
    const current = sessions.get(deploymentId) ?? { id: createId("authSession"), deviceId: null };
    sessions.set(deploymentId, current);
    return {
      "sessions.list": async () => ({
        ok: true,
        data: {
          sessions: [
            {
              id: current.id,
              deviceId: current.deviceId,
              current: true,
              createdAt: "2026-01-01T00:00:00.000Z",
              lastSeenAt: "2026-01-01T00:00:00.000Z",
              expiresAt: "2099-01-01T00:00:00.000Z",
              absoluteExpiresAt: "2099-01-01T00:00:00.000Z",
              deviceLabel: "Opensteer on Mac",
              form: "computer",
            },
          ],
        },
      }),
      "commands.dispatch": async (command: { type: string; machineId?: string }) => {
        if (command.type !== "machine.session.bind")
          throw new Error(`Unexpected Home command ${command.type}`);
        current.deviceId = RunnerIdSchema.parse(command.machineId);
        record("home.session-bound", { deploymentId });
        return { ok: true, data: { type: command.type } };
      },
    } as unknown as HostApiClient;
  };
}

function configuration(directory: string): DesktopConfiguration {
  const file = (name: string, mode: number) => {
    const target = path.join(directory, name);
    // A new file takes this mode (less the umask, which never clears the owner's bits).
    writeFileSync(target, name, { mode });
    return target;
  };
  mkdirSync(path.join(directory, "agent-skills"), { recursive: true });
  file("browser-harness", 0o700);
  for (const kind of shippedHarnessKinds) file(kind, 0o700);
  return {
    accountCertificateKey: null,
    accountUrl: null,
    browser: null,
    dataDirectory: directory,
    extraCertificateAuthorities: null,
    hostUrl: null,
    localExecution: {
      dataDirectory: path.join(directory, "runner"),
      nativeFsHelperBinary: file("opensteer-native-fs", 0o700),
      runnerWorkerPath: file("runner-worker.js", 0o600),
    },
    mode: "test",
    personal: { releaseDirectory: path.join(directory, "personal-runtime") },
    portalUrl: null,
    release: {
      id: "com.opensteer.opensteer",
      name: "Opensteer",
      oauth: {
        accountCallback: "com.opensteer.opensteer:/oauth/account-callback",
        application: "desktop",
        clientId: "opensteer-desktop",
        hostCallback: "com.opensteer.opensteer:/oauth/host-callback",
      },
    },
    trial: null,
  } as DesktopConfiguration;
}

async function eventually(label: string, predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Every file under a folder whose bytes contain the text: where a credential still lives. */
function filesHolding(directory: string, text: string): string[] {
  const found: string[] = [];
  const walk = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const entry = path.join(folder, name);
      const stats = statSync(entry, { throwIfNoEntry: false });
      if (!stats) continue;
      if (stats.isDirectory()) walk(entry);
      else if (
        stats.isFile() &&
        stats.size < 64 * 1024 * 1024 &&
        readFileSync(entry).includes(text)
      )
        found.push(path.relative(directory, entry));
    }
  };
  walk(directory);
  return found;
}

async function run(): Promise<void> {
  await app.whenReady();
  const config = configuration(path.join(root, "data"));
  const certificate = testCertificate();
  const [homeA, homeB] = await Promise.all([
    startHome("a", certificate),
    startHome("b", certificate),
  ]);
  const [targetA, targetB] = [targetFor(homeA), targetFor(homeB)];
  // The Home's own partition (sign-in) and the service partition for its origin (the leave),
  // as ElectronHostNetwork and ElectronServiceNetwork name them, trust only the test certificate.
  const trusted = certificate.cert.toString("utf8").trim();
  const trust = (partition: Electron.Session) =>
    partition.setCertificateVerifyProc((request, callback) =>
      callback(request.certificate.data.trim() === trusted ? 0 : -3),
    );
  for (const [target, home] of [
    [targetA, homeA],
    [targetB, homeB],
  ] as const) {
    trust(session.fromPartition(`persist:opensteer-host-${target.deploymentId}`, { cache: true }));
    const fingerprint = createHash("sha256").update(home.origin).digest("hex").slice(0, 24);
    trust(session.fromPartition(`opensteer-service-${fingerprint}`, { cache: false }));
  }
  const hostNetwork = new ElectronHostNetwork();
  const serviceNetwork = new ElectronServiceNetwork();
  const children: WorkerStandIn[] = [];
  const fenced: string[] = [];
  const service = new LocalRunnerService(config, {
    hostApi: homeApi(),
    leaveFetch: (input, init) => {
      record("leave.sent", { url: String(input) });
      return serviceNetwork.fetch(input, init);
    },
    fenceDeployment: (deploymentId) => {
      fenced.push(deploymentId);
      record("fenced", { deploymentId });
    },
    allowDeployment: async () => undefined,
    clearDeploymentSession: async (deploymentId) => {
      record("session.clearing", { deploymentId });
      await hostNetwork.clearDeploymentSession(deploymentId);
      record("session.cleared", { deploymentId });
    },
    computerName: async () => "Studio Mac",
    fork: (_module, _args, options) => {
      if (!readIdentity(options.cwd)) writeIdentity(options.cwd, false);
      const child = new WorkerStandIn(options.cwd);
      children.push(child);
      record("worker.started", { host: options.env.OPENSTEER_HOST_URL });
      return child;
    },
    inspectIdentity: async (dataDirectory) => {
      const identity = readIdentity(dataDirectory);
      return identity
        ? {
            enrolled: identity.lastConnectionGeneration > 0,
            environmentId: identity.environmentId as never,
            runnerId: RunnerIdSchema.parse(identity.runnerId),
          }
        : null;
    },
    homeDirectory: config.dataDirectory,
    restartDelayMs: () => 60_000,
    runtimeRelease: async () => ({
      agentSkillsDirectory: path.join(config.dataDirectory, "agent-skills"),
      browserHarnessExecutable: path.join(config.dataDirectory, "browser-harness"),
      harnessExecutables: shippedHarnessKindRecord((kind) => path.join(config.dataDirectory, kind)),
      nodeExecutable: process.execPath,
    }),
    confirmShutdown: async (_dataDirectory, proof) => proof !== undefined,
    targets: targetAuthority([targetA, targetB]),
    userEnvironment: {
      resolve: async () => ({ HOME: config.dataDirectory, PATH: "/usr/bin:/bin" }),
    },
  });
  const runnerFolder = (deploymentId: string) =>
    path.join(config.localExecution.dataDirectory, "deployments", deploymentId);
  const cookies = async (deploymentId: string) =>
    (await session.fromPartition(`persist:opensteer-host-${deploymentId}`).cookies.get({})).map(
      (cookie) => cookie.name,
    );

  // This Mac becomes a device of both Homes, and signs in to each over its own partition.
  const connectTo = async (target: DesktopLocalRunnerTarget) => {
    const before = children.length;
    const started = service.start({
      deploymentId: target.deploymentId,
      enrollmentToken: randomBytes(32).toString("hex"),
      runAgents: true,
      runnerName: "Studio Mac",
    });
    await eventually("the Runner to start", () => children.length === before + 1);
    welcome(children[before]!);
    await started;
    const signIn = await hostNetwork.partitionFetch(
      target.deploymentId,
      new URL("/v1/session", target.hostUrl),
      { method: "GET" },
    );
    assert.equal(signIn.status, 200);
    await signIn.body?.cancel();
    return children[before]!;
  };
  const workerA = await connectTo(targetA);
  const workerB = await connectTo(targetB);
  const identityA = readIdentity(runnerFolder(targetA.deploymentId));
  const identityB = readIdentity(runnerFolder(targetB.deploymentId));
  assert(identityA && identityB);
  assert.deepEqual(await cookies(targetA.deploymentId), ["opensteer.session"]);
  assert.deepEqual(await cookies(targetB.deploymentId), ["opensteer.session"]);
  const bothBefore = await Promise.all([
    service.status(targetA.deploymentId),
    service.status(targetB.deploymentId),
  ]);
  checks.connected = bothBefore.map((status) => ({
    runner: status.runner.state,
    membership: status.membership?.state,
  }));
  for (const status of bothBefore) assert.equal(status.membership?.state, "active");
  record("connected-to-both");

  // The window's Leave for Home A (`opensteer.desktop.device.leave` calls exactly this).
  await service.leaveDeployment({ deploymentId: targetA.deploymentId });
  record("left-a");

  // What the app shows for Home A.
  const leftA = await service.status(targetA.deploymentId);
  checks.leftA = {
    runner: leftA.runner.state,
    detail: leftA.runner.detail,
    membership: leftA.membership?.state,
    leaveUnconfirmed: leftA.membership?.leaveUnconfirmed,
  };
  assert.equal(leftA.membership?.state, "removed");
  assert.equal(leftA.membership?.leaveUnconfirmed, false);
  assert.equal(leftA.runner.detail, "This Mac has left this Deployment.");
  assert.notEqual(leftA.runner.state, "running");

  // Home A heard the leave once, signed by the key its Runner held.
  assert.equal(homeA.leaves.length, 1);
  assert.equal(homeB.leaves.length, 0);
  const proof = RunnerLeaveRequestSchema.parse(homeA.leaves[0]);
  assert.equal(proof.deploymentId, targetA.deploymentId);
  assert.equal(proof.runnerId, identityA.runnerId);
  assert(verifyDeviceLeaveSignature(identityA.publicKeyPem, proof), "Leave proof did not verify.");
  checks.leaveProof = { runnerId: proof.runnerId, verified: true };

  // Home A's session and the Runner's credentials for it are gone from the app's own stores.
  assert.deepEqual(await cookies(targetA.deploymentId), []);
  assert.equal(existsSync(runnerFolder(targetA.deploymentId)), false);
  const keyHeldA = filesHolding(root, identityA.privateKeyPem.split("\n")[1]!);
  assert.deepEqual(keyHeldA, [], `Home A's Runner key is still on disk: ${keyHeldA.join(", ")}`);
  assert(stopped(workerA), "Home A's Runner was not stopped.");
  checks.goneForA = { cookies: [], runnerFolder: false, keyFiles: keyHeldA };

  // Home B is untouched: its session, its Runner and its credentials.
  const stillB = await service.status(targetB.deploymentId);
  assert.equal(stillB.membership?.state, "active");
  assert.deepEqual(await cookies(targetB.deploymentId), ["opensteer.session"]);
  assert.deepEqual(readIdentity(runnerFolder(targetB.deploymentId)), identityB);
  assert.equal(workerB.kills, 0);
  assert(!fenced.includes(targetB.deploymentId), "Leaving Home A fenced Home B.");
  assert(!stopped(workerB), "Leaving Home A stopped Home B's Runner.");
  checks.untouchedB = {
    membership: stillB.membership?.state,
    runner: stillB.runner.state,
    cookies: ["opensteer.session"],
  };

  // Connecting to Home A again works, as a new device with a new identity.
  const again = await connectTo(targetA);
  const rejoined = await service.status(targetA.deploymentId);
  const identityAgain = readIdentity(runnerFolder(targetA.deploymentId));
  assert(identityAgain);
  assert.equal(rejoined.membership?.state, "active");
  assert.notEqual(identityAgain.runnerId, identityA.runnerId);
  assert.deepEqual(await cookies(targetA.deploymentId), ["opensteer.session"]);
  assert.equal(again.kills, 0);
  checks.rejoinedA = {
    membership: rejoined.membership?.state,
    runner: rejoined.runner.state,
    newRunner: identityAgain.runnerId !== identityA.runnerId,
  };

  checks.order = events
    .filter((event) =>
      [
        "fenced",
        "session.clearing",
        "session.cleared",
        "leave.sent",
        "home.leave-received",
      ].includes(event.kind),
    )
    .map((event) => event.kind);
  const stopping = service.shutdown();
  for (const child of children) if (child.kills === 0) child.kill();
  await stopping;
  service.dispose();
  await serviceNetwork.close();
}
