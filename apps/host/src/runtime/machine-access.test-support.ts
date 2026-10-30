import { freePort } from "@opensteer/shared/test-support/loopbackPort";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createId,
  PendingRequestSchema,
  zeroSequence,
  type EnvironmentId,
  type RequestId,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
  type WorkspaceId,
} from "@opensteer/core";
import type { HostConfig } from "@opensteer/config";
import { nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import { createDatabase, migrateToLatest, type OpensteerStore } from "@opensteer/database";
import {
  cloneTestDatabase,
  failDatabaseContainment,
  ownTestDatabaseProducer,
} from "@opensteer/database/test-support/database";
import {
  HarnessInstanceCatalogSchema,
  RunnerAuxiliaryChallengeSchema,
  RunnerAuxiliaryWelcomeSchema,
  RunnerBootIdSchema,
  RunnerChallengeSchema,
  RunnerDescriptorSchema,
  RunnerEnrollmentCredentialSchema,
  runnerProofFormatVersion,
  ShellSessionIdSchema,
  type HostToRunnerMessage,
  type MachineAccessPolicy,
  type MachineAccessRunContext,
  type RunnerBootId,
  type RunnerConnectionFence,
  type RunnerDescriptor,
  type RunnerModuleName,
  type RunnerProof,
  hostApiVersionHeader,
} from "@opensteer/protocol";
import { hostApiVersion } from "@opensteer/deployment-authority";
import {
  isMachineAccessRoutes,
  isMachineAccessSetup,
  machineAccessTargets,
  planMachineAccess,
  prepareShellModule,
  setupMachineAccess,
  ShellModuleHandler,
  type MachineAccessSetup,
  type PreparedShellModule,
} from "@opensteer/runner";
import {
  createRunnerAuthenticationSignature,
  createRunnerAuxiliarySignature,
  createRunnerEnrollmentSignature,
} from "@opensteer/runner-auth";
import { sql } from "kysely";
import WebSocket from "ws";
import { attachLocalWorkspaceDisk } from "../workspace/runner-local-workspace.test-support.js";
import { testRpcData } from "../server/test-host-api-request.js";
import { createHostRuntime, type HostRuntime } from "./runtime.js";
import { startPortableFsManagerFake } from "./portablefs-manager.test-support.js";

const executeFile = promisify(execFile);

export const machineAccessTestAccessToken = "machine-access-".padEnd(40, "a");

/** The built helper every machine-access end-to-end test drives. */
export const nativeFsHelperBinary = fileURLToPath(
  new URL("../../../runner/native-fs-helper/opensteer-native-fs-test", import.meta.url),
);

export interface MachineAccessHost {
  readonly config: HostConfig;
  readonly hostPort: number;
  readonly origin: string;
  readonly ownerHeaders: Record<string, string>;
  readonly ownerId: UserId;
  readonly runtime: HostRuntime;
  readonly store: OpensteerStore;
  close(): Promise<void>;
}

export interface MachineAccessDatabase {
  readonly url: string;
  drop(): Promise<void>;
}

/**
 * A database of this suite's own.
 *
 * These tests stand a whole Host up, which claims the Deployment row for its
 * instance; sharing one database with anything else running against the same
 * server turns that claim into a race nobody can win.
 */
export async function createMachineAccessDatabase(
  baseUrl: string,
  options: { readonly stopProducers?: () => Promise<void> } = {},
): Promise<MachineAccessDatabase> {
  return cloneTestDatabase("host", { ...options, serverUrl: baseUrl });
}

/** Empties every table the Host runtime writes, as the vertical slice does. */
export async function resetMachineAccessDatabase(databaseUrl: string): Promise<void> {
  const database = createDatabase({ connectionString: databaseUrl });
  await migrateToLatest(database);
  // A truncate this wide deadlocks against anything else holding these tables;
  // it is the first thing a test does, so retrying is always safe.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await truncateMachineAccessTables(database);
      break;
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
  }
  await database
    .updateTable("personalRemoteAccess")
    .set({ generation: 0, mode: "off", routeOrigin: null, updatedAt: new Date() })
    .where("singletonKey", "=", "personal")
    .executeTakeFirstOrThrow();
  await sql`
    insert into principals(id, kind, user_id, display_name)
    values ('pri_00000000-0000-4000-8000-000000000001', 'system', null, 'Opensteer')
    on conflict (id) do nothing
  `.execute(database);
  await database.destroy();
}

async function truncateMachineAccessTables(
  database: ReturnType<typeof createDatabase>,
): Promise<void> {
  await sql`
    truncate table
      machine_access_events,
      machine_access_sessions,
      personal_remote_session_grant_uses,
      personal_remote_sessions,
      personal_remote_pairing_codes,
      personal_remote_account_link,
      account_directory_provider,
      account_directory_projections,
      auth_rate_limits,
      auth_verifications,
      auth_admissions,
      auth_sso_providers,
      owner_enrollments,
      security_effects,
      security_audit,
      credential_access_audit,
      credential_vault_canaries,
      browser_profile_grants,
      browser_sessions,
      browser_profile_revisions,
      browser_profiles,
      credentials,
      workspace_events,
      commands,
      provider_sessions,
      messages,
      runs,
      threads,
      harness_instances,
      workspaces,
      execution_environments,
      runners,
      deployments,
      users
    restart identity cascade
  `.execute(database);
}

/**
 * The same Host, shaped as a Personal Deployment: loopback-only, holding its
 * Workspaces on the Main computer's own disk, and with the one owner the local
 * supervisor claims. It is the only shape that has remote access at all.
 */
export interface PersonalMachineAccessHost extends MachineAccessHost {
  /** The Main Runner's enrollment, minted by the Host for the computer it runs on. */
  readonly mainRunnerEnrollmentToken: string;
  /** The environment the Deployment's own local-directory Workspaces live in. */
  readonly ownerEnvironmentId: EnvironmentId;
}

const personalOwnerClaimToken = "machine-access-personal-owner".padEnd(40, "x");

export function startPersonalMachineAccessHost(
  databaseUrl: string,
): Promise<PersonalMachineAccessHost> {
  return ownTestDatabaseProducer(databaseUrl, () => createPersonalMachineAccessHost(databaseUrl));
}

async function createPersonalMachineAccessHost(
  databaseUrl: string,
): Promise<PersonalMachineAccessHost> {
  const dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-ma-personal-"));
  const hostPort = await freePort();
  const ownerEnvironmentId = createId("environment");
  const config = personalMachineAccessHostConfig(
    hostPort,
    dataDirectory,
    databaseUrl,
    ownerEnvironmentId,
  );
  let runtime: HostRuntime | undefined;
  const close = async () => {
    const failures: unknown[] = [];
    try {
      await runtime?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await rm(dataDirectory, { force: true, recursive: true });
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      failDatabaseContainment(new AggregateError(failures, "Personal Host cleanup failed"));
  };
  try {
    runtime = await createHostRuntime(config);
    await runtime.listen();
    const origin = `http://127.0.0.1:${hostPort}`;
    const requestOrigin = config.canonicalOrigin.origin;
    const bootstrap = (await (
      await fetch(`${origin}/v1/local-bootstrap`, {
        headers: { authorization: `Bearer ${personalOwnerClaimToken}`, origin: requestOrigin },
      })
    ).json()) as { readonly runnerEnrollmentToken?: string };
    if (!bootstrap.runnerEnrollmentToken) {
      throw new Error("The Personal Host offered no Main Runner enrollment.");
    }
    const claimed = await fetch(`${origin}/v1/rpc/auth.setup.claim`, {
      body: JSON.stringify({ kind: "local-machine-owner", token: personalOwnerClaimToken }),
      headers: {
        [hostApiVersionHeader]: String(hostApiVersion),
        "content-type": "application/json",
        origin: requestOrigin,
      },
      method: "POST",
    });
    if (!claimed.ok) throw new Error(`Local owner claim failed with HTTP ${claimed.status}.`);
    const cookies = responseCookies(claimed);
    if (cookies.length === 0) throw new Error("Host did not issue a session cookie.");
    const owner = await runtime.store.firstUser();
    if (!owner) throw new Error("The Personal Host did not establish an owner.");
    return {
      close,
      config,
      hostPort,
      mainRunnerEnrollmentToken: bootstrap.runnerEnrollmentToken,
      origin,
      ownerEnvironmentId,
      ownerHeaders: { cookie: cookies.join("; "), origin: requestOrigin },
      ownerId: owner.id,
      runtime,
      store: runtime.store,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Writes the Personal remote-access settings the way the Settings page does,
 * over the route that owns them, so the Host's own transaction runs.
 */
export async function configurePersonalRemoteAccess(
  host: MachineAccessHost,
  request: { readonly mode: "off" | "private"; readonly routeOrigin: string | null },
): Promise<{ readonly generation: number; readonly mode: string }> {
  const response = await fetch(`${host.origin}/v1/personal-remote-access`, {
    body: JSON.stringify({ ...request, schemaVersion: 1 }),
    headers: { "content-type": "application/json", ...host.ownerHeaders },
    method: "PUT",
  });
  if (!response.ok) {
    throw new Error(
      `Personal remote access configure failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as { readonly generation: number; readonly mode: string };
}

function personalMachineAccessHostConfig(
  hostPort: number,
  hostDataDirectory: string,
  databaseUrl: string,
  ownerEnvironmentId: EnvironmentId,
): HostConfig {
  return {
    // A Personal Deployment is single-user and loopback-only: nobody lends it a
    // machine from outside its own network, and its Workspaces are directories
    // on the Mac that hosts it.
    acceptsExternalRunners: false,
    authSecret: "machine-access-personal-secret".padEnd(40, "x"),
    bindAddress: "127.0.0.1",
    browserProfileKeyPath: undefined,
    browserRuntime: { attachKeyId: "host-browser-v1" },
    canonicalOrigin: new URL(`http://127.0.0.1:${hostPort}`),
    credentialKeyPath: undefined,
    databaseUrl,
    dataDirectory: hostDataDirectory,
    // The desktop names a Personal Deployment after the Mac it runs on.
    deploymentName: "Mac mini",
    exposure: "loopback" as const,
    identity: {
      initialOwnerEnrollment: undefined,
      localOwnerClaimToken: personalOwnerClaimToken,
      localPasswordEnabled: false,
      oidcConfigPath: undefined,
      signupPolicy: "closed",
    },
    executionLeaseMs: 90_000,
    maxConcurrentDispatches: 8,
    maxConcurrentTriggerDispatches: 4,
    mode: "development",
    port: hostPort,
    privateKeyPath: undefined,
    publicKeyPath: undefined,
    runtimeOrigin: new URL(`http://127.0.0.1:${hostPort}`),
    workspace: {
      deletionRetentionDays: 14,
      shape: { defaultWorkspaceBacking: "local-directory", kind: "personal" as const },
      storage: { kind: "local-directory", ownerEnvironmentId },
    },
  };
}

/** A Host runtime with an established owner, ready to enroll computers. */
export function startMachineAccessHost(
  databaseUrl: string,
  options: {
    readonly logger?: Record<string, unknown>;
    readonly browserActivityClock?: import("@opensteer/shared/clock").Clock;
    /** The name its administrator gave the Deployment; unnamed otherwise. */
    readonly deploymentName?: string;
    /** Where integrations reach providers, for a journey with an upstream of its own. */
    readonly integrationFetch?: typeof globalThis.fetch;
    /** Shortens Run tokens' lifetime, so a journey sees them refreshed and expire. */
    readonly runCapabilityLifetimeSeconds?: number;
    readonly signupPolicy?: "closed" | "invite-only" | "open";
  } = {},
): Promise<MachineAccessHost> {
  return ownTestDatabaseProducer(databaseUrl, () => createMachineAccessHost(databaseUrl, options));
}

async function createMachineAccessHost(
  databaseUrl: string,
  options: NonNullable<Parameters<typeof startMachineAccessHost>[1]>,
): Promise<MachineAccessHost> {
  const portableFs = await startPortableFsManagerFake();
  const dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-ma-host-"));
  const hostPort = await freePort();
  const config = {
    ...machineAccessHostConfig(
      hostPort,
      dataDirectory,
      portableFs.url,
      databaseUrl,
      options.signupPolicy ?? "invite-only",
    ),
    ...(options.deploymentName === undefined ? {} : { deploymentName: options.deploymentName }),
  };
  let runtime: HostRuntime | undefined;
  const close = async () => {
    const failures: unknown[] = [];
    for (const stop of [
      () => runtime?.close(),
      () => portableFs.close(),
      () => rm(dataDirectory, { force: true, recursive: true }),
    ]) {
      try {
        await stop();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      failDatabaseContainment(new AggregateError(failures, "Machine-access Host cleanup failed"));
  };
  try {
    runtime = await createHostRuntime(config, {
      ...(options.browserActivityClock
        ? { browserActivityClock: options.browserActivityClock }
        : {}),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.integrationFetch === undefined
        ? {}
        : { integrationFetch: options.integrationFetch }),
      ...(options.runCapabilityLifetimeSeconds === undefined
        ? {}
        : { runCapabilityLifetimeSeconds: options.runCapabilityLifetimeSeconds }),
    });
    await runtime.listen();
    const origin = config.runtimeOrigin.origin;
    const ownerHeaders = await establishOwner(origin);
    const owner = await runtime.store.firstUser();
    if (!owner) throw new Error("The machine-access Host did not establish an owner.");
    return {
      close,
      config,
      hostPort,
      origin,
      ownerHeaders,
      ownerId: owner.id,
      runtime,
      store: runtime.store,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export function machineAccessHostConfig(
  hostPort: number,
  hostDataDirectory: string,
  portableFsManagerUrl: URL,
  databaseUrl: string,
  signupPolicy: "closed" | "invite-only" | "open",
  /**
   * Where people and computers reach this Host when that is not where it
   * listens, such as a TLS front door in front of it. It is the canonical and
   * the runtime origin both; the Host itself stays bound to loopback on
   * `hostPort`.
   */
  publicOrigin: URL = new URL(`http://127.0.0.1:${hostPort}`),
): HostConfig {
  return {
    acceptsExternalRunners: true,
    authSecret: "machine-access-auth-secret".padEnd(40, "x"),
    bindAddress: "127.0.0.1",
    browserProfileKeyPath: undefined,
    browserRuntime: { attachKeyId: "host-browser-v1" },
    canonicalOrigin: publicOrigin,
    credentialKeyPath: undefined,
    databaseUrl,
    dataDirectory: hostDataDirectory,
    exposure: "networked" as const,
    identity: {
      initialOwnerEnrollment: { lifetimeSeconds: 3_600, token: machineAccessTestAccessToken },
      localPasswordEnabled: true,
      oidcConfigPath: undefined,
      signupPolicy,
    },
    executionLeaseMs: 90_000,
    maxConcurrentDispatches: 8,
    maxConcurrentTriggerDispatches: 4,
    mode: "development",
    port: hostPort,
    privateKeyPath: undefined,
    publicKeyPath: undefined,
    runtimeOrigin: publicOrigin,
    workspace: {
      deletionRetentionDays: 14,
      shape: { defaultWorkspaceBacking: "portablefs", kind: "server" as const },
      storage: {
        archiveAfterDays: 7,
        authorizationDomain: "opensteer-test",
        defaultBlockLimitBytes: 10 * 1_024 * 1_024 * 1_024,
        defaultInodeLimit: 1_000_000,
        filesServiceUrl: new URL("http://127.0.0.1:4315"),
        kind: "portablefs",
        managerCaPath: undefined,
        managerCertPath: undefined,
        managerKeyPath: undefined,
        managerServerName: undefined,
        managerUrl: portableFsManagerUrl,
        maxBlockLimitBytes: 100 * 1_024 * 1_024 * 1_024,
        maxInodeLimit: 10_000_000,
        productIssuer: "opensteer-test",
        productPrivateKeyPath: undefined,
        serviceId: "test-portablefs",
      },
    },
  };
}

/**
 * Claims the networked Host for its owner. The calls dial `dialOrigin`, where
 * the Host listens, and name `publicOrigin` as theirs, as a browser on the
 * Host's public address does: mutations are taken only from the canonical
 * origin.
 */
export async function establishOwner(
  dialOrigin: string,
  publicOrigin: string = dialOrigin,
): Promise<Record<string, string>> {
  const origin = publicOrigin;
  const exchanged = await fetch(`${dialOrigin}/v1/rpc/auth.setup.exchange`, {
    body: JSON.stringify({ token: machineAccessTestAccessToken }),
    headers: {
      [hostApiVersionHeader]: String(hostApiVersion),
      "content-type": "application/json",
      origin,
    },
    method: "POST",
  });
  if (!exchanged.ok) throw new Error(`Setup exchange failed with HTTP ${exchanged.status}.`);
  const claimed = await fetch(`${dialOrigin}/v1/rpc/auth.setup.claim`, {
    body: JSON.stringify({
      email: "alex@example.com",
      kind: "password",
      password: "machine-access-owner-password",
    }),
    headers: {
      [hostApiVersionHeader]: String(hostApiVersion),
      "content-type": "application/json",
      cookie: responseCookies(exchanged).join("; "),
      origin,
    },
    method: "POST",
  });
  if (!claimed.ok) throw new Error(`Owner claim failed with HTTP ${claimed.status}.`);
  const cookies = responseCookies(claimed);
  if (cookies.length === 0) throw new Error("Host did not issue a session cookie.");
  return { cookie: cookies.join("; "), origin };
}

function responseCookies(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .filter((value): value is string => Boolean(value));
}

/** A Host as its owner reaches it: where it listens and the owner's signed-in session. */
export type MachineAccessOwner = Pick<MachineAccessHost, "hostPort" | "origin" | "ownerHeaders">;

/** One enrollment token for a computer that will advertise exactly these modules. */
export async function enrollmentToken(
  host: MachineAccessOwner,
  input: {
    readonly allowedModules: readonly RunnerModuleName[];
    readonly idempotencyKey: string;
    /** A managed computer belongs to the Deployment, not to the person who lent it. */
    readonly managed?: boolean;
    readonly name: string;
  },
): Promise<string> {
  const type = input.managed
    ? ("runner.enrollment.createManaged" as const)
    : ("runner.enrollment.createLocal" as const);
  const enrollment = await testRpcData(
    host.origin,
    "commands.dispatch",
    {
      allowedModules: [...input.allowedModules],
      idempotencyKey: input.idempotencyKey,
      name: input.name,
      type,
    },
    { headers: host.ownerHeaders },
  );
  if (enrollment.type !== type) throw new Error("Runner enrollment command mismatch.");
  return enrollment.token;
}

export interface PrimaryConnection {
  readonly bootId: RunnerBootId;
  readonly fence: RunnerConnectionFence;
  readonly privateKey: KeyObject;
  readonly socket: WebSocket;
  activeRunIds: readonly RunId[];
}

export async function connectPrimary(
  hostPort: number,
  descriptor: RunnerDescriptor,
  credentials:
    | { readonly privateKey: KeyObject; readonly token?: undefined }
    | { readonly privateKey?: undefined; readonly token: string },
  /** An already-opened socket, for a caller that had to attach a listener first. */
  existingSocket?: WebSocket,
): Promise<PrimaryConnection> {
  const socket = existingSocket ?? new WebSocket(`ws://127.0.0.1:${hostPort}/internal/v1/runners`);
  const challengeMessage = waitForMessage(socket, (message) => message.type === "host.challenge");
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const challenge = RunnerChallengeSchema.parse(await challengeMessage);
  const pair = credentials.privateKey
    ? { privateKey: credentials.privateKey }
    : generateKeyPairSync("ed25519");
  if ("publicKey" in pair && credentials.token !== undefined) {
    const publicKeyPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const credential = RunnerEnrollmentCredentialSchema.parse({
      enrollmentToken: credentials.token,
      kind: "host-enrollment-token",
    });
    socket.send(
      JSON.stringify({
        challengeId: challenge.challengeId,
        credential,
        descriptor,
        proofFormatVersion: runnerProofFormatVersion,
        publicKeyPem,
        signature: createRunnerEnrollmentSignature(pair.privateKey, {
          challenge,
          credential,
          descriptor,
          publicKeyPem,
        }),
        type: "runner.enroll",
      } satisfies RunnerProof),
    );
  } else {
    // The machine is already enrolled, so it proves the identity key it kept.
    socket.send(
      JSON.stringify({
        challengeId: challenge.challengeId,
        descriptor,
        proofFormatVersion: runnerProofFormatVersion,
        signature: createRunnerAuthenticationSignature(pair.privateKey, { challenge, descriptor }),
        type: "runner.authenticate",
      } satisfies RunnerProof),
    );
  }
  const welcome = (await waitForMessage(
    socket,
    (message) => message.type === "host.welcome",
  )) as unknown as RunnerConnectionFence & { readonly heartbeatIntervalMs: number };
  const connection: PrimaryConnection = {
    activeRunIds: [],
    bootId: descriptor.bootId,
    fence: primaryFence(welcome),
    privateKey: pair.privateKey,
    socket,
  };
  // A Runner states the Runs it holds before the Host sends it any work.
  socket.send(
    JSON.stringify({
      ...connection.fence,
      complete: true,
      executions: [],
      type: "runner.executions.attach",
    }),
  );
  // The Host renews the connection lease — and every provider-session lease the
  // heartbeat names — only while the Runner keeps saying it is here.
  const timer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        ...connection.fence,
        activeRunIds: [...connection.activeRunIds],
        activeTriggerOccurrenceIds: [],
        activeWatchActivationIds: [],
        sentAt: new Date().toISOString(),
        type: "runner.heartbeat",
      }),
    );
  }, welcome.heartbeatIntervalMs);
  timer.unref();
  socket.once("close", () => clearInterval(timer));
  return connection;
}

/**
 * Presents an enrolled machine's identity proof and reads to the close.
 *
 * Deliberately not `connectPrimary`: this is about a handshake that never
 * succeeds, and what a refused Runner is owed is the code and reason it closed
 * with — plus, just as load-bearing, whatever did or did not arrive before it.
 */
async function observeRunnerRefusal(
  hostPort: number,
  descriptor: RunnerDescriptor,
  privateKey: KeyObject,
): Promise<RunnerRefusal> {
  const socket = new WebSocket(`ws://127.0.0.1:${hostPort}/internal/v1/runners`);
  const frames: { type: string }[] = [];
  const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("the Host never closed the socket")), 15_000);
    socket.once("close", (code: number, reason: Buffer) => {
      clearTimeout(timeout);
      resolve({ code, reason: reason.toString("utf8") });
    });
    socket.once("error", reject);
  });
  socket.on("message", (frame: WebSocket.RawData) => {
    const message = JSON.parse(frame.toString()) as { type: string };
    frames.push(message);
    if (message.type !== "host.challenge") return;
    const challenge = RunnerChallengeSchema.parse(message);
    socket.send(
      JSON.stringify({
        challengeId: challenge.challengeId,
        descriptor,
        proofFormatVersion: runnerProofFormatVersion,
        signature: createRunnerAuthenticationSignature(privateKey, { challenge, descriptor }),
        type: "runner.authenticate",
      } satisfies RunnerProof),
    );
  });
  return { close: await closed, frames };
}

function primaryFence(message: RunnerConnectionFence): RunnerConnectionFence {
  return {
    bootId: message.bootId,
    connectionGeneration: message.connectionGeneration,
    connectionId: message.connectionId,
    connectionLeaseId: message.connectionLeaseId,
    runnerId: message.runnerId,
  };
}

export interface TargetMachine {
  reportFullDiskAccess(fullDiskAccess: boolean): void;
  /** The display name the Deployment knows this computer by; refusals name it. */
  readonly name: string;
  /** The environment this computer names whenever it is running agents. */
  readonly environmentId: EnvironmentId;
  readonly handler: ShellModuleHandler;
  /** Every control frame the module sent, in order, for ordering assertions. */
  readonly reported: readonly { readonly at: number; readonly frame: Record<string, unknown> }[];
  readonly hostKeyPath: string;
  readonly hostPublicKey: string;
  readonly runnerId: RunnerId;
  /** Drops both sockets the way a Runner that was stopped does. */
  disconnect(): Promise<void>;
  /**
   * Comes back as the same machine, proving the identity key it kept.
   *
   * `runsAgents` restarts it advertising a different module set, which is what
   * the desktop's switch does: one identity, one data directory, one host key,
   * and either the agents module or nothing but reach.
   */
  reconnect(options?: {
    readonly environmentId?: EnvironmentId;
    /** What the relaunched Mac now says about Full Disk Access. */
    readonly fullDiskAccess?: boolean;
    readonly runsAgents?: boolean;
  }): Promise<void>;
  /**
   * Tries to come back and records everything the Host said, for the refusals
   * whose whole content is the close frame.
   */
  observeRefusal(): Promise<RunnerRefusal>;
  /** Replaces its SSH host key and comes back advertising the new one. */
  rotateHostKey(): Promise<void>;
  close(): Promise<void>;
}

export interface RunnerRefusal {
  readonly close: { readonly code: number; readonly reason: string };
  /** Every frame the Host sent, in order, the opening challenge included. */
  readonly frames: readonly { readonly type: string }[];
}

/**
 * A second computer whose `shell` module is the production Runner handler,
 * attached over the real auxiliary handshake and serving the built helper.
 */
export async function connectTargetMachine(
  host: MachineAccessOwner,
  input: {
    readonly environmentId?: EnvironmentId;
    readonly fullDiskAccess?: boolean;
    readonly idleTimeoutMs?: number;
    readonly name: string;
    /** Advertises the agents module too, for a computer whose grant allows it. */
    readonly runsAgents?: boolean;
    readonly runnerKind?: "local" | "managed";
    readonly token: string;
  },
): Promise<TargetMachine> {
  const reported: { at: number; frame: Record<string, unknown> }[] = [];
  const dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-ma-target-"));
  const initial = await prepareShellModule({
    dataDirectory,
    helperBinary: nativeFsHelperBinary,
  });
  if (!initial) throw new Error("The shell module could not be prepared on this platform.");
  let prepared: PreparedShellModule = initial;
  const runnerId = createId("runner");
  const environmentId = input.environmentId ?? createId("environment");
  // The one descriptor this machine ever sends, minus the module set, which is
  // the only thing a restart changes.
  const descriptorFor = (
    runsAgents: boolean,
    environment: EnvironmentId,
    fullDiskAccess: boolean | undefined = input.fullDiskAccess,
  ) =>
    RunnerDescriptorSchema.parse({
      bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
      capabilities: [],
      modules: {
        ...(runsAgents
          ? {
              agents: {
                environmentIds: [environment],
                harnessDrivers: [],
                localStorage: null,
                maxConcurrentRuns: 2,
                providerStateModes: ["isolated"],
                workspaceBackings: ["portablefs"],
                workspaceMounts: [],
              },
            }
          : {}),
        shell: {
          ...prepared.descriptor,
          ...(fullDiskAccess === undefined ? {} : { platform: "darwin", fullDiskAccess }),
        },
      },
      name: input.name,
      runnerId,
      runnerKind: input.runnerKind ?? "local",
      runtimeVersion: "integration",
    });
  const descriptor = descriptorFor(input.runsAgents ?? false, environmentId);
  const handler = new ShellModuleHandler({
    helperBinary: prepared.helperBinary,
    hostKeyPath: prepared.hostKeyPath,
    ...(input.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: input.idleTimeoutMs }),
    logger: silentLogger,
    transport: { controlCaPath: undefined, hostUrl: new URL(host.origin), mode: "development" },
  });
  let primary = await connectPrimary(host.hostPort, descriptor, { token: input.token });
  acknowledgeCommands(primary, () => true);
  let auxiliary = await attachShellStream(host.hostPort, primary, handler, reported);
  reportShellReadiness(primary);
  const disconnect = async () => {
    await handler.detach().catch(() => undefined);
    auxiliary.close();
    primary.socket.close();
    await Promise.all([closed(auxiliary), closed(primary.socket)]);
  };
  const reconnect: TargetMachine["reconnect"] = async (options = {}) => {
    const booted = descriptorFor(
      options.runsAgents ?? input.runsAgents ?? false,
      options.environmentId ?? environmentId,
      options.fullDiskAccess ?? input.fullDiskAccess,
    );
    primary = await connectPrimary(host.hostPort, booted, { privateKey: primary.privateKey });
    acknowledgeCommands(primary, () => true);
    auxiliary = await attachShellStream(host.hostPort, primary, handler, reported);
    reportShellReadiness(primary);
  };
  return {
    close: async () => {
      await disconnect();
      await rm(dataDirectory, { force: true, recursive: true });
    },
    disconnect,
    environmentId,
    handler,
    name: input.name,
    reportFullDiskAccess: (fullDiskAccess) =>
      primary.socket.send(
        JSON.stringify({ ...primary.fence, type: "runner.shell.full-disk-access", fullDiskAccess }),
      ),
    hostKeyPath: prepared.hostKeyPath,
    get hostPublicKey() {
      return prepared.descriptor.hostPublicKey;
    },
    reported,
    observeRefusal: async () =>
      observeRunnerRefusal(host.hostPort, descriptorFor(false, environmentId), primary.privateKey),
    reconnect,
    rotateHostKey: async () => {
      await disconnect();
      await rm(prepared.hostKeyPath, { force: true });
      await rm(`${prepared.hostKeyPath}.pub`, { force: true });
      const rotated = await prepareShellModule({
        dataDirectory,
        helperBinary: nativeFsHelperBinary,
      });
      if (!rotated) throw new Error("The shell module could not be prepared again.");
      prepared = rotated;
      await reconnect();
    },
    runnerId,
  };
}

/**
 * Answers `host.command` the way an idle Runner does. The Host holds a
 * fifteen-second deadline on every acknowledgement and ejects the connection
 * when one does not arrive, so a Runner that means to stay must answer them
 * all — including the watch reconciliation it has no watches for.
 */
export function acknowledgeCommands(
  primary: PrimaryConnection,
  accepts: (command: { readonly type: string }) => boolean,
): void {
  primary.socket.on("message", (raw: WebSocket.RawData) => {
    const message = JSON.parse(raw.toString()) as HostToRunnerMessage;
    if (message.type !== "host.command" || !accepts(message.command)) return;
    primary.socket.send(
      JSON.stringify({
        ...primaryFence(message),
        commandId: message.command.commandId,
        correlationId: message.command.correlationId,
        type: "runner.command-accepted",
      }),
    );
  });
}

function reportShellReadiness(primary: PrimaryConnection): void {
  primary.socket.send(
    JSON.stringify({
      ...primary.fence,
      modules: [
        { checkedAt: new Date().toISOString(), detail: null, module: "shell", readiness: "ready" },
      ],
      type: "runner.modules.report",
    }),
  );
}

/**
 * The `shell` auxiliary stream, opened exactly as the Runner opens it: the
 * primary connection asks for a one-use ticket, the stream proves the same
 * machine key against a fresh challenge, and every later frame repeats the
 * fence the welcome stamped.
 */
async function attachShellStream(
  hostPort: number,
  primary: PrimaryConnection,
  handler: ShellModuleHandler,
  reported: { at: number; frame: Record<string, unknown> }[],
): Promise<WebSocket> {
  const ticketed = waitForMessage(
    primary.socket,
    (message) => message.type === "host.auxiliary.ticket",
  );
  primary.socket.send(
    JSON.stringify({
      ...primary.fence,
      module: "shell",
      requestId: "shell-stream-1",
      type: "runner.auxiliary.ticket-request",
    }),
  );
  const { ticket } = (await ticketed) as unknown as { readonly ticket: string };

  const socket = new WebSocket(`ws://127.0.0.1:${hostPort}/internal/v1/runners/auxiliary/shell`);
  const challengeMessage = waitForMessage(
    socket,
    (message) => message.type === "host.auxiliary.challenge",
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const challenge = RunnerAuxiliaryChallengeSchema.parse(await challengeMessage);
  const welcomed = waitForMessage(socket, (message) => message.type === "host.auxiliary.welcome");
  socket.send(
    JSON.stringify({
      bootId: primary.bootId,
      challengeId: challenge.challengeId,
      module: "shell",
      runnerId: primary.fence.runnerId,
      signature: createRunnerAuxiliarySignature(primary.privateKey, {
        bootId: primary.bootId,
        challenge,
        module: "shell",
        runnerId: primary.fence.runnerId,
        ticket,
      }),
      ticket,
      type: "runner.auxiliary.authenticate",
    }),
  );
  const welcome = RunnerAuxiliaryWelcomeSchema.parse(await welcomed);
  const fence = {
    auxiliaryStreamId: welcome.auxiliaryStreamId,
    bootId: welcome.bootId,
    connectionGeneration: welcome.connectionGeneration,
    connectionId: welcome.connectionId,
    connectionLeaseId: welcome.connectionLeaseId,
    module: "shell" as const,
    runnerId: welcome.runnerId,
  };
  handler.attach({
    browserAttachPublicKeys: undefined,
    fence,
    send: (frame, binary) =>
      new Promise<void>((resolve, reject) => {
        if (!binary && typeof frame === "string") {
          reported.push({ at: Date.now(), frame: JSON.parse(frame) as Record<string, unknown> });
        }
        socket.send(frame, { binary }, (error) => (error ? reject(error) : resolve()));
      }),
  });
  // Lease renewals belong to the stream, never to the module: the production
  // module connection consumes them before the handler ever sees a frame.
  socket.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
    const frame = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    if (!isBinary) {
      const parsed = JSON.parse(frame.toString("utf8")) as { readonly type: string };
      if (parsed.type === "host.auxiliary.lease-renewed") return;
    }
    void handler.handleFrame(frame, isBinary).catch(() => undefined);
  });
  const timer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(
      JSON.stringify({
        ...fence,
        sentAt: new Date().toISOString(),
        type: "runner.auxiliary.heartbeat",
      }),
    );
  }, welcome.heartbeatIntervalMs);
  timer.unref();
  socket.once("close", () => {
    clearInterval(timer);
    void handler.detach().catch(() => undefined);
  });
  return socket;
}

export interface CallerMachine {
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: string;
  readonly primary: PrimaryConnection;
  readonly runnerId: RunnerId;
  close(): Promise<void>;
}

/** The computer a Run executes on, answering harness inspections as an idle Runner does. */
export async function connectCallerMachine(
  host: MachineAccessHost,
  input: {
    /**
     * The environment this computer executes in. A Personal Deployment holds
     * its Workspaces on the Main computer's disk and names that environment in
     * its own configuration, so the caller must attach as exactly that one.
     */
    readonly environmentId?: EnvironmentId;
    /** Synthetic Personal desktop authority shares its real primary identity. */
    readonly integrations?: RunnerDescriptor["modules"]["integrations"];
    readonly browser?: RunnerDescriptor["modules"]["browser"];
    readonly name: string;
    readonly maxConcurrentRuns?: number;
    /** Holds its own directories, the way a local-directory Deployment needs. */
    readonly localDirectory?: boolean;
    readonly loginFill?: boolean;
    /**
     * Takes a steered message by restarting the Run, as a Runner whose engine
     * cannot steer mid-turn does.
     */
    readonly restartsRuns?: boolean;
    /**
     * Its engine shows a tool result's pictures and its model reads them, so
     * a computer-use observation reaches the agent with its screenshot.
     */
    readonly rendersImages?: boolean;
    readonly computerTool?: 1;
    readonly runnerKind?: "local" | "main";
    readonly token: string;
  },
): Promise<CallerMachine> {
  const runnerId = createId("runner");
  const environmentId = input.environmentId ?? createId("environment");
  const socket = new WebSocket(`ws://127.0.0.1:${host.hostPort}/internal/v1/runners`);
  const disk = input.localDirectory ? attachLocalWorkspaceDisk(socket) : undefined;
  const descriptor = RunnerDescriptorSchema.parse({
    bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
    capabilities: [
      "filesystem",
      "network-egress",
      "native-session-continuation-v1",
      "assignments-v1",
      "steer-answer-v1",
      "browser-page-input-v1",
      "thread-state-v1",
      "requester-time-zone-v1",
      "execution-plane-v2",
      ...(input.restartsRuns ? ["attempts-v1"] : []),
    ],
    modules: {
      ...(input.integrations ? { integrations: input.integrations } : {}),
      ...(input.browser ? { browser: input.browser } : {}),
      agents: {
        ...(input.computerTool ? { computerTool: input.computerTool } : {}),
        ...(input.loginFill ? { loginFill: 1 } : {}),
        environmentIds: [environmentId],
        harnessDrivers: [
          {
            accessModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
            driverKind: "codex",
            ...(input.rendersImages ? { mcpImageContent: true } : {}),
            readiness: "configured",
            sources: [
              {
                fields: [],
                kind: "first-party",
                label: "OpenAI",
                quota: "windows",
                sourceId: "openai",
                stateKinds: ["ambient", "isolated"],
              },
            ],
          },
        ],
        localStorage: disk?.inventory ?? null,
        maxConcurrentRuns: input.maxConcurrentRuns ?? 4,
        providerStateModes: ["ambient", "isolated"],
        workspaceBackings: disk ? ["local-directory"] : ["portablefs"],
        workspaceMounts: [],
      },
    },
    name: input.name,
    runnerId,
    runnerKind: input.runnerKind ?? "local",
    runtimeVersion: "integration",
  });
  const primary = await connectPrimary(host.hostPort, descriptor, { token: input.token }, socket);
  // Every dispatched command is acknowledged, including the ones this Runner
  // has nothing to do about: a command the Host waits on and never hears back
  // ejects the whole connection fifteen seconds later.
  acknowledgeCommands(primary, (command) => command.type !== "run.execute");
  primary.socket.on("message", (raw: WebSocket.RawData) => {
    const message = JSON.parse(raw.toString()) as HostToRunnerMessage;
    if (message.type === "host.harness-authentication") {
      const request = message.request;
      primary.socket.send(
        JSON.stringify({
          ...primary.fence,
          driverKind: "harness" in request ? request.harness.driverKind : request.driverKind,
          harnessInstanceId: "harness" in request ? request.harness.id : request.harnessInstanceId,
          requestId: message.requestId,
          state: { status: "not-started" },
          type: "runner.harness-authentication",
        }),
      );
      return;
    }
    if (message.type !== "host.inspect-harnesses" && message.type !== "host.reconcile-harnesses") {
      return;
    }
    primary.socket.send(
      JSON.stringify({
        ...primary.fence,
        catalogs: message.harnesses.map((harness) =>
          HarnessInstanceCatalogSchema.parse({
            continuationIdentity: {
              continuationKey: "runner:v1:8tErnQuB1d-nw979Rab9a4JN0RE_tKRvI_Rtmy45Bbo",
              driverKind: harness.driverKind,
            },
            driverKind: harness.driverKind,
            harnessInstanceId: harness.id,
            models: [
              {
                ...(input.rendersImages ? { acceptsImages: true } : {}),
                displayName: "GPT-5.6 Sol",
                isDefault: true,
                modelId: "gpt-5.6-sol",
                options: [
                  {
                    defaultValue: "low",
                    id: "effort",
                    label: "Reasoning effort",
                    type: "select",
                    values: [
                      { label: "Low", value: "low" },
                      { label: "Medium", value: "medium" },
                    ],
                  },
                ],
                providerId: "openai",
              },
            ],
            status: "ready",
          }),
        ),
        requestId: message.requestId,
        type: "runner.harness-catalog",
      }),
    );
  });
  const harnessInstanceId = await waitForValue(async () => {
    const bootstrap = await testRpcData(
      host.origin,
      "bootstrap.get",
      {},
      { headers: host.ownerHeaders },
    );
    return bootstrap.harnesses.find(
      (harness) => harness.driverKind === "codex" && harness.environmentId === environmentId,
    )?.id;
  });
  return {
    close: async () => {
      primary.socket.close();
      await closed(primary.socket);
    },
    environmentId,
    harnessInstanceId,
    primary,
    runnerId,
  };
}

/** One execution of a Run on the caller: its binding, its bearer, and where its events resume. */
export interface CallerAttempt {
  readonly agentControlToken: string;
  readonly bindingGeneration: number;
  /** The ordinal this attempt's next event takes. */
  readonly nextOrdinal: number;
}

export interface CallerRun {
  /** The bearer the Run holds now; a refresh or a later attempt replaces it. */
  readonly agentControlToken: string;
  /** The attempt the caller is executing now. */
  readonly attempt: CallerAttempt;
  readonly integrationTools: { readonly token: string; readonly url: string };
  readonly machineAccess: MachineAccessRunContext;
  readonly runId: RunId;
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
  /** Reports the Run finished, releasing its execution binding. */
  complete(): Promise<void>;
  /** Asks for fresh tokens as the Runner does at half their lifetime, and holds what it is given. */
  refreshCredentials(): Promise<"issued" | "refused" | "unavailable">;
  /**
   * Reports an attempt interrupted, as its Runner does once the interrupt has
   * landed: the current attempt, or an earlier one whose report is replayed.
   * Settles once the Host has acknowledged it.
   */
  reportInterrupted(attempt?: CallerAttempt): Promise<void>;
  /**
   * Reports the current attempt's phase: `background` is a turn that answered
   * while work it started runs on. Settles once the Host has acknowledged it.
   */
  reportPhase(phase: "background" | "turn"): Promise<void>;
  /**
   * Opens a live Request the way an engine asking for approval does, which
   * leaves the Run waiting on its requester. Settles once the Host has it.
   */
  openLiveRequest(): Promise<RequestId>;
  /** Takes the next attempt the Host dispatches for this Run, as the Runner does. */
  startNextAttempt(): Promise<CallerAttempt>;
}

type ExecuteCommand = Awaited<ReturnType<typeof waitForExecute>>;

/**
 * One dispatched Run on the caller, left running so its capability token stays
 * live while the test drives `ssh` the way the model would.
 */
async function createCallerThread(
  host: MachineAccessHost,
  caller: CallerMachine,
  input: { readonly key: string; readonly title: string },
  workspaceId: WorkspaceId,
): Promise<ThreadId> {
  const thread = await testRpcData(
    host.origin,
    "commands.dispatch",
    {
      environmentId: caller.environmentId,
      harnessInstanceId: caller.harnessInstanceId,
      idempotencyKey: `${input.key}-thread`,
      modelSelection: { modelId: "gpt-5.6-sol", options: { effort: "low" }, providerId: "openai" },
      title: input.title,
      type: "thread.create",
      workspaceId,
    },
    { headers: host.ownerHeaders },
  );
  if (thread.type !== "thread.create") throw new Error("Thread command mismatch.");
  return thread.thread.id;
}

export async function dispatchCallerRun(
  host: MachineAccessHost,
  caller: CallerMachine,
  input: {
    readonly key: string;
    readonly title: string;
    /**
     * The Workspace the Run's Thread opens in, such as the owner's Main;
     * a Workspace of the Run's own is created when it is absent.
     */
    readonly workspaceId?: WorkspaceId;
    /** A later Run of this Thread, in `workspaceId`, instead of a new Thread's first. */
    readonly threadId?: ThreadId;
  },
): Promise<CallerRun> {
  const workspaceId = input.workspaceId ?? (await createCallerWorkspace(host, input));
  const threadId = input.threadId ?? (await createCallerThread(host, caller, input, workspaceId));

  const executed = waitForExecute(caller.primary.socket);
  const turn = await testRpcData(
    host.origin,
    "commands.dispatch",
    {
      content: [{ text: "Use the other computer.", type: "text" }],
      idempotencyKey: `${input.key}-turn`,
      threadId,
      type: "thread.sendMessage",
    },
    { headers: host.ownerHeaders },
  );
  if (turn.type !== "thread.sendMessage" || !turn.run) throw new Error("Turn command mismatch.");
  return acceptCallerRun(host, caller, await executed);
}

/** Accepts a Run the Host dispatched itself, such as a durable Request continuation. */
export async function acceptCallerRun(
  host: MachineAccessHost,
  caller: CallerMachine,
  command: ExecuteCommand,
): Promise<CallerRun> {
  const context = command.command.context;
  const fence = primaryFence(command);
  // A restarted Run's later attempts each arrive as a `run.execute` of their
  // own; they are kept from now on, so none can arrive unheard in between.
  const laterAttempts = executesFor(caller.primary.socket, context.runId);
  const runStatus = async () =>
    (await host.store.database
      .selectFrom("runs")
      .select(["bindingGeneration", "status"])
      .where("id", "=", context.runId)
      .executeTakeFirst()) ?? null;
  const report = (
    attempt: CallerAttempt,
    type: "request.opened" | "run.completed" | "run.interrupted" | "run.phase",
    data: Readonly<Record<string, unknown>>,
  ): Promise<void> => {
    const acknowledged = eventAcknowledged(
      caller.primary.socket,
      context.runId,
      attempt.nextOrdinal,
    );
    caller.primary.socket.send(
      JSON.stringify({
        ...fence,
        event: {
          bindingGeneration: attempt.bindingGeneration,
          data,
          emittedAt: new Date().toISOString(),
          environmentId: caller.environmentId,
          ordinal: attempt.nextOrdinal,
          runId: context.runId,
          threadId: context.threadId,
          type,
          workspaceId: context.workspaceId,
        },
        type: "runner.event",
      }),
    );
    return acknowledged;
  };
  const release = () => {
    caller.primary.activeRunIds = caller.primary.activeRunIds.filter(
      (runId) => runId !== context.runId,
    );
  };
  const take = async (execute: ExecuteCommand): Promise<CallerAttempt> => {
    const attempt = startAttempt(caller, execute);
    await waitForCondition(async () => {
      const run = await runStatus();
      return run?.status === "running" && run.bindingGeneration === attempt.bindingGeneration;
    });
    return attempt;
  };
  let current = await take(command);
  return {
    get agentControlToken() {
      return current.agentControlToken;
    },
    get attempt() {
      return current;
    },
    integrationTools: context.integrationTools,
    complete: async () => {
      release();
      await report(current, "run.completed", { status: "completed" });
      await waitForCondition(async () => (await runStatus())?.status === "completed");
    },
    machineAccess: context.machineAccess,
    refreshCredentials: async () => {
      const requestId = `refresh-${randomUUID()}`;
      const answered = waitForMessage(
        caller.primary.socket,
        (message) =>
          message.type === "host.grants.credentials" &&
          (message as { readonly requestId?: unknown }).requestId === requestId,
      );
      caller.primary.socket.send(
        JSON.stringify({
          ...fence,
          requestId,
          runId: context.runId,
          type: "runner.grants.refresh",
        }),
      );
      const { result } = (await answered) as Extract<
        HostToRunnerMessage,
        { type: "host.grants.credentials" }
      >;
      if (result.status === "issued") {
        current = { ...current, agentControlToken: result.credentials.agentControl };
      }
      return result.status;
    },
    reportInterrupted: (attempt = current) => {
      if (attempt === current) release();
      return report(attempt, "run.interrupted", { status: "interrupted" });
    },
    openLiveRequest: async () => {
      const requestId = createId("request");
      const attempt = current;
      current = { ...attempt, nextOrdinal: attempt.nextOrdinal + 1 };
      await report(attempt, "request.opened", {
        request: PendingRequestSchema.parse({
          callId: requestId,
          cancellationReason: null,
          createdAt: new Date().toISOString(),
          id: requestId,
          kind: "harness.input",
          mode: "live",
          originatingOccurrenceId: null,
          originatingRunId: context.runId,
          originatingThreadId: context.threadId,
          originatingWorkspaceId: context.workspaceId,
          payload: { kind: "harness.input" },
          presentation: {
            detail: "Approve this operation",
            kind: "choice",
            options: [{ hint: "allow-once", id: "allow", label: "Allow" }],
            title: "Approval required",
          },
          requestedBy: host.ownerId,
          requiredActor: "requester",
          resolvedAt: null,
          resolvedBy: null,
          response: null,
          status: "pending",
          targetWorkspaceId: context.workspaceId,
        }),
      });
      return requestId;
    },
    reportPhase: async (phase) => {
      const attempt = current;
      current = { ...attempt, nextOrdinal: attempt.nextOrdinal + 1 };
      await report(attempt, "run.phase", { phase });
    },
    runId: context.runId,
    startNextAttempt: async () => {
      current = await take(await laterAttempts.next());
      return current;
    },
    threadId: context.threadId,
    workspaceId: context.workspaceId,
  };
}

/** A Workspace of one Run's own, named after it. */
async function createCallerWorkspace(
  host: MachineAccessHost,
  input: { readonly key: string; readonly title: string },
): Promise<WorkspaceId> {
  const workspace = await testRpcData(
    host.origin,
    "commands.dispatch",
    {
      idempotencyKey: `${input.key}-workspace`,
      name: `${input.title} workspace`,
      type: "workspace.create",
    },
    { headers: host.ownerHeaders },
  );
  if (workspace.type !== "workspace.create") throw new Error("Workspace command mismatch.");
  return workspace.workspace.id;
}

/**
 * Accepts one `run.execute`, binds its session and reports it started, the
 * three things a Runner says before its engine does anything.
 */
function startAttempt(caller: CallerMachine, command: ExecuteCommand): CallerAttempt {
  const context = command.command.context;
  const fence = primaryFence(command);
  caller.primary.socket.send(
    JSON.stringify({
      ...fence,
      commandId: command.command.commandId,
      correlationId: command.command.correlationId,
      type: "runner.command-accepted",
    }),
  );
  caller.primary.socket.send(
    JSON.stringify({
      ...fence,
      bindingGeneration: context.bindingGeneration,
      harnessInstanceId: context.harnessInstanceId,
      providerSessionId: context.providerSessionId,
      providerSessionReference: context.providerSessionReference ?? `codex:${randomUUID()}`,
      runId: context.runId,
      threadId: context.threadId,
      type: "runner.session-bound",
    }),
  );
  const firstOrdinal = context.firstOrdinal ?? 0;
  caller.primary.socket.send(
    JSON.stringify({
      ...fence,
      event: {
        bindingGeneration: context.bindingGeneration,
        data: { status: "running" },
        emittedAt: new Date().toISOString(),
        environmentId: caller.environmentId,
        ordinal: firstOrdinal,
        runId: context.runId,
        threadId: context.threadId,
        type: "run.started",
        workspaceId: context.workspaceId,
      },
      type: "runner.event",
    }),
  );
  caller.primary.activeRunIds = [...caller.primary.activeRunIds, context.runId];
  return {
    agentControlToken: context.agentControl.token,
    bindingGeneration: context.bindingGeneration,
    nextOrdinal: firstOrdinal + 1,
  };
}

/**
 * Settles once the Host acknowledges a Run's events through `ordinal`, and
 * fails if it revokes the Run instead: a Runner told that stops the Run.
 */
function eventAcknowledged(socket: WebSocket, runId: RunId, ordinal: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", receive);
      reject(new Error(`the Host never acknowledged ordinal ${ordinal}`));
    }, 15_000);
    const receive = (frame: WebSocket.RawData) => {
      const message = JSON.parse(frame.toString()) as HostToRunnerMessage;
      const acknowledged =
        message.type === "host.events.acked" &&
        message.acks.some((ack) => ack.runId === runId && ack.throughOrdinal >= ordinal);
      const revoked =
        message.type === "host.runs.revoked" &&
        message.revocations.some((revocation) => revocation.runId === runId);
      if (!acknowledged && !revoked) return;
      clearTimeout(timeout);
      socket.off("message", receive);
      if (revoked) reject(new Error("The Host revoked the Run instead of acknowledging it."));
      else resolve();
    };
    socket.on("message", receive);
  });
}

/** Every later `run.execute` for one Run, in the order the Host sent them. */
function executesFor(
  socket: WebSocket,
  runId: RunId,
): { next(timeoutMs?: number): Promise<ExecuteCommand> } {
  const arrived: ExecuteCommand[] = [];
  const waiting: ((command: ExecuteCommand) => void)[] = [];
  socket.on("message", (frame: WebSocket.RawData) => {
    const message = JSON.parse(frame.toString()) as HostToRunnerMessage;
    if (
      message.type !== "host.command" ||
      message.command.type !== "run.execute" ||
      message.command.context.runId !== runId
    ) {
      return;
    }
    const execute = message as ExecuteCommand;
    const waiter = waiting.shift();
    if (waiter) waiter(execute);
    else arrived.push(execute);
  });
  return {
    next: (timeoutMs = 15_000) => {
      const ready = arrived.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = waiting.indexOf(settle);
          if (index !== -1) waiting.splice(index, 1);
          reject(new Error("timed out waiting for the Run's next run.execute"));
        }, timeoutMs);
        const settle = (command: ExecuteCommand) => {
          clearTimeout(timeout);
          resolve(command);
        };
        waiting.push(settle);
      });
    },
  };
}

export function waitForExecute(socket: WebSocket): Promise<
  Extract<HostToRunnerMessage, { type: "host.command" }> & {
    readonly command: Extract<
      Extract<HostToRunnerMessage, { type: "host.command" }>["command"],
      { type: "run.execute" }
    >;
  }
> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for run.execute")),
      15_000,
    );
    const receive = (frame: WebSocket.RawData) => {
      const message = JSON.parse(frame.toString()) as HostToRunnerMessage;
      if (message.type !== "host.command" || message.command.type !== "run.execute") return;
      clearTimeout(timeout);
      socket.off("message", receive);
      resolve(message as Parameters<typeof resolve>[0]);
    };
    socket.on("message", receive);
  });
}

/**
 * The Run's launch directory, built by the production caller setup from the
 * exact machine list and bearer the Host dispatched.
 */
export async function setUpCallerLaunchDirectory(
  host: MachineAccessHost,
  run: CallerRun,
  /** A bearer pinned for this directory, where the Run's current one would be read otherwise. */
  agentControlToken: () => string = () => run.agentControlToken,
): Promise<CallerLaunch> {
  const privateStateRoot = await mkdtemp(join(tmpdir(), "opensteer-ma-private-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "opensteer-ma-workspace-"));
  const environment = { HOME: process.env.HOME ?? tmpdir(), PATH: process.env.PATH ?? "" };
  const plan = await planMachineAccess({
    accessMode: "full-access",
    driverKind: "claude",
    environment,
    helperBinary: nativeFsHelperBinary,
    machineAccess: run.machineAccess,
  });
  if (!isMachineAccessRoutes(plan)) {
    throw new Error(`The Run reaches no computer: ${plan.reason}.`);
  }
  const setup = await setupMachineAccess({
    environment,
    plan,
    privateStateRoot,
    runtimeBoundary: nativeUserHarnessRuntimeBoundary,
    transport: { controlCaPath: undefined, hostUrl: new URL(host.origin), mode: "development" },
    workspacePath,
    wrapModelCommand: (launch) => launch,
    wrapProcessLaunch: async () => (launch) => launch,
  });
  if (!isMachineAccessSetup(setup)) {
    throw new Error(`The Run's machine access was not set up: ${setup.reason}.`);
  }
  setup.relay.bind({
    credentials: {
      get agentControl() {
        return agentControlToken();
      },
    },
    runId: run.runId,
    targets: machineAccessTargets(plan),
  });
  return {
    ...setup,
    close: async () => {
      await setup.close();
      await rm(privateStateRoot, { force: true, recursive: true });
    },
    machineAccessNotice: plan.notice,
  };
}

/** A launch directory whose relay the dispatched Run holds, and that Run's notice. */
export type CallerLaunch = MachineAccessSetup & { readonly machineAccessNotice: string };

export interface ShimResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

/** Runs one of the launch directory's shims exactly as the model's shell would. */
export async function runShim(
  launch: Pick<MachineAccessSetup, "environment" | "launchDirectory">,
  shim: "ssh" | "scp" | "sftp",
  args: readonly string[],
  options: { readonly input?: string | Buffer; readonly timeoutMs?: number } = {},
): Promise<ShimResult> {
  return runCommand(join(launch.launchDirectory, "bin", shim), args, {
    ...options,
    environment: launch.environment,
  });
}

export async function runCommand(
  file: string,
  args: readonly string[],
  options: {
    readonly environment?: Readonly<Record<string, string>>;
    readonly input?: string | Buffer;
    readonly timeoutMs?: number;
  } = {},
): Promise<ShimResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      env: { ...(options.environment ?? process.env) },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 60_000);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export const silentLogger = {
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

export function waitForMessage(
  socket: WebSocket,
  predicate: (message: { type: string }) => boolean,
  timeoutMs = 15_000,
): Promise<{ type: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("timed out waiting for a WebSocket message")),
      timeoutMs,
    );
    const settle = () => {
      clearTimeout(timeout);
      socket.off("message", receive);
      socket.off("close", refuse);
    };
    // A socket that closed is never going to deliver this message, and the
    // code and reason it closed with are what a refused Runner learns — so
    // they belong in the failure rather than fifteen seconds of silence.
    const refuse = (code: number, reason: Buffer) => {
      settle();
      reject(new Error(`socket closed with ${code}: ${reason.toString("utf8")}`));
    };
    const receive = (frame: WebSocket.RawData) => {
      const message = JSON.parse(frame.toString()) as { type: string };
      if (!predicate(message)) return;
      settle();
      resolve(message);
    };
    socket.on("message", receive);
    socket.once("close", refuse);
  });
}

export function closed(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

export async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error("timed out waiting for a condition");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

export async function waitForValue<Value>(
  produce: () => Promise<Value | undefined>,
  timeoutMs = 15_000,
): Promise<Value> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await produce();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for a value");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/** An owner realtime connection, and everything it was told about machines. */
export async function openRealtime(
  host: MachineAccessHost,
  headers: Record<string, string>,
): Promise<{
  readonly messages: Record<string, unknown>[];
  readonly socket: WebSocket;
  close(): Promise<void>;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${host.hostPort}/v1/realtime`, { headers });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const messages: Record<string, unknown>[] = [];
  socket.on("message", (frame: WebSocket.RawData) => {
    messages.push(JSON.parse(frame.toString()) as Record<string, unknown>);
  });
  // Machine notifications are addressed to a person, not to a Workspace, so an
  // authenticated connection is all this needs.
  return {
    close: async () => {
      socket.close();
      await closed(socket);
    },
    messages,
    socket,
  };
}

/**
 * One Workspace as a client follows it: subscribed from the start, and holding
 * only the events that arrived live, after the replay it was synchronized with.
 */
export async function followWorkspace(
  host: MachineAccessHost,
  workspaceId: WorkspaceId,
): Promise<{
  readonly live: readonly Record<string, unknown>[];
  close(): Promise<void>;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${host.hostPort}/v1/realtime`, {
    headers: host.ownerHeaders,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const live: Record<string, unknown>[] = [];
  let synchronized = false;
  socket.on("message", (frame: WebSocket.RawData) => {
    const message = JSON.parse(frame.toString()) as {
      readonly events?: readonly (Record<string, unknown> & { readonly sequence?: string })[];
      readonly type: string;
    };
    if (message.type === "host.synchronized") synchronized = true;
    if (message.type !== "host.events" || !message.events) return;
    if (synchronized) live.push(...message.events);
    const latest = message.events.at(-1);
    if (latest?.sequence) {
      socket.send(JSON.stringify({ sequence: latest.sequence, type: "client.ack", workspaceId }));
    }
  });
  const synchronizedMessage = waitForMessage(
    socket,
    (message) => message.type === "host.synchronized",
  );
  socket.send(
    JSON.stringify({
      afterSequence: zeroSequence,
      apiVersion: hostApiVersion,
      threadId: null,
      type: "client.subscribe",
      workspaceId,
    }),
  );
  await synchronizedMessage;
  return {
    close: async () => {
      socket.close();
      await closed(socket);
    },
    live,
  };
}

export { freePort };

export { executeFile };

/** A running shim, for the sessions a test has to observe while they are open. */
export interface RunningShim {
  readonly exited: Promise<ShimResult>;
  readonly pid: number | undefined;
  kill(signal?: NodeJS.Signals): void;
}

export function startShim(
  launch: Pick<MachineAccessSetup, "environment" | "launchDirectory">,
  shim: "ssh" | "scp" | "sftp",
  args: readonly string[],
  options: { readonly keepStdinOpen?: boolean } = {},
): RunningShim {
  const child = spawn(join(launch.launchDirectory, "bin", shim), [...args], {
    env: { ...launch.environment },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  if (!options.keepStdinOpen) child.stdin.end();
  const exited = new Promise<ShimResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({
        code,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      }),
    );
  });
  return {
    exited,
    kill: (signal) => child.kill(signal ?? "SIGKILL"),
    pid: child.pid,
  };
}

export interface ShellSessionRow {
  readonly endReason: string | null;
  readonly endedAt: Date | null;
  readonly id: string;
  readonly runId: string;
  readonly runnerId: string;
  readonly startedAt: Date;
  readonly state: string;
  readonly bytesIn: string | number | bigint;
  readonly bytesOut: string | number | bigint;
}

export async function shellSessionRows(host: MachineAccessHost): Promise<ShellSessionRow[]> {
  return host.store.database
    .selectFrom("machineAccessSessions")
    .select([
      "bytesIn",
      "bytesOut",
      "endReason",
      "endedAt",
      "id",
      "runId",
      "runnerId",
      "startedAt",
      "state",
    ])
    .orderBy("startedAt", "asc")
    .orderBy("id", "asc")
    .execute();
}

/** Writes one access policy as the machine's owner, the way the Computers page does. */
export async function updateAccessPolicy(
  host: MachineAccessOwner,
  input: {
    readonly expectedRevision: number;
    readonly key: string;
    readonly policy: MachineAccessPolicy;
    readonly runnerId: RunnerId;
  },
) {
  const result = await testRpcData(
    host.origin,
    "commands.dispatch",
    {
      expectedRevision: input.expectedRevision,
      idempotencyKey: input.key,
      policy: input.policy,
      runnerId: input.runnerId,
      type: "machine.access.update",
    },
    { headers: host.ownerHeaders },
  );
  if (result.type !== "machine.access.update") throw new Error("Access command mismatch.");
  return result;
}

export async function machineAccessHistory(host: MachineAccessHost, runnerId: RunnerId) {
  return testRpcData(
    host.origin,
    "machine.access.history",
    { limit: 50, runnerId },
    { headers: host.ownerHeaders },
  );
}

/** Everything one machine-access end-to-end test needs, wired and torn down together. */
export interface MachineAccessScenario {
  readonly alias: string;
  readonly caller: CallerMachine;
  readonly host: MachineAccessHost;
  readonly launch: CallerLaunch;
  readonly run: CallerRun;
  readonly target: TargetMachine;
  close(): Promise<void>;
}

export async function startMachineAccessScenario(
  databaseUrl: string,
  input: {
    readonly fullDiskAccess?: boolean;
    readonly idleTimeoutMs?: number;
    readonly policy: MachineAccessPolicy;
    /** The caller restarts a steered Run rather than steering its engine. */
    readonly restartsRuns?: boolean;
    readonly runCapabilityLifetimeSeconds?: number;
    readonly signupPolicy?: "closed" | "invite-only" | "open";
    readonly targetName?: string;
  },
): Promise<MachineAccessScenario> {
  const host = await startMachineAccessHost(databaseUrl, {
    ...(input.runCapabilityLifetimeSeconds === undefined
      ? {}
      : { runCapabilityLifetimeSeconds: input.runCapabilityLifetimeSeconds }),
    ...(input.signupPolicy === undefined ? {} : { signupPolicy: input.signupPolicy }),
  });
  const targetName = input.targetName ?? "Example Mac";
  const closers: (() => Promise<void>)[] = [() => host.close()];
  try {
    const caller = await connectCallerMachine(host, {
      name: "Caller computer",
      ...(input.restartsRuns ? { restartsRuns: true } : {}),
      token: await enrollmentToken(host, {
        allowedModules: ["agents"],
        idempotencyKey: "caller",
        name: "Caller computer",
      }),
    });
    closers.unshift(() => caller.close());
    const target = await connectTargetMachine(host, {
      ...(input.fullDiskAccess === undefined ? {} : { fullDiskAccess: input.fullDiskAccess }),
      ...(input.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: input.idleTimeoutMs }),
      name: targetName,
      token: await enrollmentToken(host, {
        allowedModules: ["shell"],
        idempotencyKey: "target",
        name: targetName,
      }),
    });
    closers.unshift(() => target.close());
    await updateAccessPolicy(host, {
      expectedRevision: 1,
      key: "policy-initial",
      policy: input.policy,
      runnerId: target.runnerId,
    });
    const run = await dispatchCallerRun(host, caller, { key: "run", title: "Reach out" });
    const alias = run.machineAccess?.machines[0]?.alias;
    if (!alias) throw new Error("The Run reached no machine.");
    const launch = await setUpCallerLaunchDirectory(host, run);
    closers.unshift(() => launch.close());
    return {
      alias,
      caller,
      close: async () => {
        for (const close of closers) await close().catch(() => undefined);
      },
      host,
      launch,
      run,
      target,
    };
  } catch (error) {
    for (const close of closers) await close().catch(() => undefined);
    throw error;
  }
}

export interface PersonalMachineAccessScenario extends Omit<MachineAccessScenario, "host"> {
  readonly host: PersonalMachineAccessHost;
}

/**
 * The same end-to-end arrangement on a Personal Deployment: the Main computer
 * is the one that runs agents and holds the Workspace directories, and the
 * second computer is reachable and nothing else. Remote access is on, because
 * that is the only condition under which the second computer is admitted.
 */
export async function startPersonalMachineAccessScenario(
  databaseUrl: string,
  input: { readonly policy: MachineAccessPolicy; readonly targetName?: string },
): Promise<PersonalMachineAccessScenario> {
  const host = await startPersonalMachineAccessHost(databaseUrl);
  const targetName = input.targetName ?? "Example Mac";
  const closers: (() => Promise<void>)[] = [() => host.close()];
  try {
    const caller = await connectCallerMachine(host, {
      environmentId: host.ownerEnvironmentId,
      localDirectory: true,
      name: "Main computer",
      runnerKind: "main",
      token: host.mainRunnerEnrollmentToken,
    });
    closers.unshift(() => caller.close());
    await configurePersonalRemoteAccess(host, {
      mode: "private",
      routeOrigin: "https://personal.machine-access.test",
    });
    const target = await connectTargetMachine(host, {
      name: targetName,
      token: await enrollmentToken(host, {
        allowedModules: ["shell"],
        idempotencyKey: "target",
        name: targetName,
      }),
    });
    closers.unshift(() => target.close());
    await updateAccessPolicy(host, {
      expectedRevision: 1,
      key: "policy-initial",
      policy: input.policy,
      runnerId: target.runnerId,
    });
    const run = await dispatchCallerRun(host, caller, { key: "run", title: "Reach out" });
    const alias = run.machineAccess?.machines[0]?.alias;
    if (!alias) throw new Error("The Run reached no machine.");
    const launch = await setUpCallerLaunchDirectory(host, run);
    closers.unshift(() => launch.close());
    return {
      alias,
      caller,
      close: async () => {
        for (const close of closers) await close().catch(() => undefined);
      },
      host,
      launch,
      run,
      target,
    };
  } catch (error) {
    for (const close of closers) await close().catch(() => undefined);
    throw error;
  }
}

/** A second interactive account, for the viewers a machine's owner is not. */
export async function signUpUser(
  host: MachineAccessHost,
  input: { readonly email: string; readonly password: string },
  publicOrigin: string = host.origin,
): Promise<{ readonly headers: Record<string, string>; readonly userId: UserId }> {
  const response = await fetch(`${host.origin}/v1/rpc/auth.password.signUp`, {
    body: JSON.stringify({ email: input.email, password: input.password }),
    headers: {
      [hostApiVersionHeader]: String(hostApiVersion),
      "content-type": "application/json",
      origin: publicOrigin,
    },
    method: "POST",
  });
  if (!response.ok) throw new Error(`Sign-up failed with HTTP ${response.status}.`);
  const cookies = responseCookies(response);
  if (cookies.length === 0) throw new Error("Host issued no session cookie for the new account.");
  const body = (await response.json()) as {
    readonly data: { readonly session: { readonly user: { readonly id: UserId } } };
  };
  return {
    headers: { cookie: cookies.join("; "), origin: publicOrigin },
    userId: body.data.session.user.id,
  };
}

export async function stopShellSession(
  host: MachineAccessHost,
  input: { readonly key: string; readonly sessionId: string },
) {
  const result = await testRpcData(
    host.origin,
    "commands.dispatch",
    {
      idempotencyKey: input.key,
      sessionId: ShellSessionIdSchema.parse(input.sessionId),
      type: "machine.access.session.stop",
    },
    { headers: host.ownerHeaders },
  );
  if (result.type !== "machine.access.session.stop") throw new Error("Stop command mismatch.");
  return result;
}

export async function revokeMachine(
  host: MachineAccessOwner,
  input: { readonly key: string; readonly runnerId: RunnerId },
): Promise<void> {
  await testRpcData(
    host.origin,
    "commands.dispatch",
    { idempotencyKey: input.key, machineId: input.runnerId, type: "machine.revoke" },
    { headers: host.ownerHeaders },
  );
}

/** The live session on one machine, once the Host says it is carrying bytes. */
export async function activeSessionId(
  host: MachineAccessHost,
  runnerId: RunnerId,
  /** Sessions already known, so a second one opened beside them is the one found. */
  except: readonly string[] = [],
): Promise<string> {
  return waitForValue(async () => {
    const rows = await shellSessionRows(host);
    return rows.find(
      (row) => row.runnerId === runnerId && row.state === "active" && !except.includes(row.id),
    )?.id;
  });
}

/** Stops a Run the way its Thread's Stop button does. */
export async function stopRun(
  host: MachineAccessHost,
  run: Pick<CallerRun, "runId" | "threadId">,
  key: string,
): Promise<void> {
  const result = await testRpcData(
    host.origin,
    "commands.dispatch",
    { idempotencyKey: key, runId: run.runId, threadId: run.threadId, type: "run.interrupt" },
    { headers: host.ownerHeaders },
  );
  if (result.type !== "run.interrupt") throw new Error("Run interrupt command mismatch.");
}

/** Steers a message into a running Run, as the composer's Steer does. */
export async function steerRun(
  host: MachineAccessHost,
  run: Pick<CallerRun, "threadId">,
  input: { readonly key: string; readonly text: string },
): Promise<{ readonly wasDuplicate: boolean }> {
  const result = await testRpcData(
    host.origin,
    "commands.dispatch",
    {
      content: [{ text: input.text, type: "text" }],
      delivery: "steer",
      idempotencyKey: input.key,
      threadId: run.threadId,
      type: "thread.sendMessage",
    },
    { headers: host.ownerHeaders },
  );
  if (result.type !== "thread.sendMessage") throw new Error("Steer command mismatch.");
  return { wasDuplicate: result.wasDuplicate };
}

/** Every grant one Run's executions were issued, oldest first. */
export async function runGrants(host: MachineAccessHost, runId: RunId) {
  return host.store.database
    .selectFrom("grants")
    .select(["bindingGeneration", "id", "revokedAt", "revokedReason", "status"])
    .where("runId", "=", runId)
    .orderBy("bindingGeneration", "asc")
    .execute();
}
