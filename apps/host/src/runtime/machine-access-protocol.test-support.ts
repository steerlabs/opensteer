import { parseHostConfig } from "@opensteer/config";
import {
  createId,
  PendingRequestSchema,
  zeroSequence,
  type EnvironmentId,
  type RequestId,
  type RunId,
  type RunnerId,
  type ThreadId,
} from "@opensteer/core";
import { createDatabase, migrateToLatest } from "@opensteer/database";
import { ownTestDatabaseProducer } from "@opensteer/database/test-support/database";
import { apiVersionQueryParameter, hostApiVersion } from "@opensteer/deployment-authority";
import { nativeUserHarnessRuntimeBoundary } from "@opensteer/harness";
import {
  HarnessInstanceCatalogSchema,
  hostApiVersionHeader,
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
  type RunnerProof,
} from "@opensteer/protocol";
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
import { freePort } from "@opensteer/shared/test-support/loopbackPort";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { sql } from "kysely";
import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { vi } from "vitest";
import { testRpcData } from "../server/test-host-api-request.js";
import { createHostRuntime, type PersonalHostRuntime } from "./runtime.js";

import { createHttpHostApiClient } from "@opensteer/client/host-api";
import type { MachineAccessHost } from "./machine-access.test-support.js";
import {
  createMachineAccessDatabase,
  configurePersonalRemoteAccess,
  enrollmentToken,
  nativeFsHelperBinary,
} from "./personal-machine.test-support.js";
export {
  createMachineAccessDatabase,
  configurePersonalRemoteAccess,
  enrollmentToken,
  nativeFsHelperBinary,
};
export type { MachineAccessHost };

const executeFile = promisify(execFile);
export interface MachineAccessWireHost extends MachineAccessHost {
  readonly hostingPrivateKey: KeyObject;
  readonly hostingRunnerEnrollmentToken: string;
  readonly ownerEnvironmentId: EnvironmentId;
}
export async function startMachineAccessWireHost(
  databaseUrl: string,
  options: {
    readonly remoteAccess?: boolean;
    readonly messagingEnrollmentToken?: string;
    readonly manualRunner?: boolean;
    readonly logger?: import("./runtime.js").HostRuntimeOptions["logger"];
    readonly phoneUpdateRelease?: import("./runtime.js").HostRuntimeOptions["phoneUpdateRelease"];
    readonly deploymentName?: string;
    readonly runCapabilityLifetimeSeconds?: number;
    readonly executionClock?: import("./runtime.js").HostRuntimeOptions["executionClock"];
  } = {},
): Promise<MachineAccessWireHost> {
  return ownTestDatabaseProducer(databaseUrl, async () => {
    const dataDirectory = await realpath(await mkdtemp(join(tmpdir(), "personal-machine-wire-")));
    const port = await freePort(),
      environmentId = createId("environment"),
      computerId = createId("runner");
    const origin = new URL(`http://127.0.0.1:${port}`);
    const token = randomUUID().replaceAll("-", "").repeat(2);
    const agentHome = { computerId, path: join(dataDirectory, "home") };
    await (await import("node:fs/promises")).mkdir(agentHome.path);
    const config = parseHostConfig({
      OPENSTEER_DEPLOYMENT_NAME: options.deploymentName ?? "Fixture Mac",
      ...(options.messagingEnrollmentToken
        ? { OPENSTEER_INITIAL_MESSAGING_RUNNER_ENROLLMENT_TOKEN: options.messagingEnrollmentToken }
        : {}),
      OPENSTEER_MODE: "development",
      OPENSTEER_DEPLOYMENT_KIND: "personal",
      OPENSTEER_DATABASE_URL: databaseUrl,
      OPENSTEER_AUTH_SECRET: randomUUID().repeat(2),
      OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: token,
      OPENSTEER_LOCAL_PASSWORD_ENABLED: "false",
      OPENSTEER_HOST_DATA_DIR: join(dataDirectory, "host"),
      OPENSTEER_PORT: String(port),
      OPENSTEER_BIND_ADDRESS: "127.0.0.1",
      OPENSTEER_CANONICAL_ORIGIN: origin.origin,
      OPENSTEER_HOSTING_ENVIRONMENT_ID: environmentId,
      OPENSTEER_AGENT_HOME: agentHome.path,
    });
    let runtime: PersonalHostRuntime | undefined;
    let hosting: CallerMachine | undefined;
    const close = async () => {
      try {
        await hosting?.close();
        await runtime?.close();
      } finally {
        await rm(dataDirectory, { force: true, recursive: true });
      }
    };
    try {
      const created = await createHostRuntime(config, {
        ...(options.logger ? { logger: options.logger } : {}),
        ...(options.phoneUpdateRelease ? { phoneUpdateRelease: options.phoneUpdateRelease } : {}),
        ...(options.runCapabilityLifetimeSeconds
          ? { runCapabilityLifetimeSeconds: options.runCapabilityLifetimeSeconds }
          : {}),
        ...(options.executionClock ? { executionClock: options.executionClock } : {}),
      });
      if (created.kind !== "personal")
        throw new Error("Personal wire fixture constructed a team Host");
      runtime = created;
      await runtime.listen();
      const claimed = await runtime.app.inject({
        method: "POST",
        url: "/v1/rpc/auth.setup.claim",
        headers: { origin: origin.origin, [hostApiVersionHeader]: String(hostApiVersion) },
        payload: { kind: "local-machine-owner", token },
      });
      if (claimed.statusCode !== 200)
        throw new Error(`Local owner claim failed: ${claimed.statusCode}`);
      const cookie = claimed.cookies.map((value) => `${value.name}=${value.value}`).join("; ");
      const bootstrap = await runtime.app.inject({
        method: "GET",
        url: "/v1/local-bootstrap",
        headers: { authorization: `Bearer ${token}` },
      });
      const enrollment = bootstrap.json<{ runnerEnrollmentToken: string }>().runnerEnrollmentToken;
      const owner = await runtime.store.firstUser();
      if (!owner || !enrollment)
        throw new Error("Personal bootstrap omitted owner or hosting enrollment");
      const headers = {
        cookie,
        origin: origin.origin,
        [hostApiVersionHeader]: String(hostApiVersion),
      };
      const api = createHttpHostApiClient({
        baseUrl: origin,
        fetch: (url, init) =>
          fetch(url, {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers },
          }),
        onAuthenticationRequired: () => {
          throw new Error("Personal session expired");
        },
      });
      const host: MachineAccessWireHost = {
        api,
        config,
        runtime,
        store: runtime.store,
        origin,
        hostPort: port,
        ownerId: owner.id,
        ownerHeaders: headers,
        hostingComputerId: computerId,
        get hostingPrivateKey() {
          if (!hosting) throw new Error("The hosting Runner has not connected");
          return hosting.primary.privateKey;
        },
        agentHome,
        remoteAccess: options.remoteAccess ?? false,
        hostingRunnerEnrollmentToken: enrollment,
        ownerEnvironmentId: environmentId,
        close,
      };
      if (!options.manualRunner)
        hosting = await connectCallerMachine(host, { name: "Hosting computer", token: enrollment });
      return host;
    } catch (error) {
      await close();
      throw error;
    }
  });
}
export async function resetMachineAccessDatabase(databaseUrl: string): Promise<void> {
  const database = createDatabase({ connectionString: databaseUrl });
  try {
    await migrateToLatest(database);
    const tables = await sql<{
      tablename: string;
    }>`select tablename from pg_tables where schemaname='public' and tablename not in ('kysely_migration','kysely_migration_lock','personal_remote_access')`.execute(
      database,
    );
    if (tables.rows.length)
      await sql`truncate ${sql.join(tables.rows.map((row) => sql.id(row.tablename)))} restart identity cascade`.execute(
        database,
      );
    await database
      .updateTable("personalRemoteAccess")
      .set({ generation: 0, mode: "off", routeOrigin: null, updatedAt: new Date() })
      .execute();
  } finally {
    await database.destroy();
  }
}
export type MachineAccessOwner = Pick<
  MachineAccessHost,
  "api" | "hostPort" | "origin" | "ownerHeaders"
>;
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
  if (descriptor.modules.agents)
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
  // Reconnect retains the disk authority while changing the advertised modules.
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
                maxConcurrentRuns: 2,
                providerStateModes: ["isolated"],
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
  const connect = (
    descriptor: RunnerDescriptor,
    credentials: Parameters<typeof connectPrimary>[2],
  ) => {
    const socket = new WebSocket(`ws://127.0.0.1:${host.hostPort}/internal/v1/runners`);
    return connectPrimary(host.hostPort, descriptor, credentials, socket);
  };
  let primary = await connect(descriptor, { token: input.token });
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
    primary = await connect(booted, { privateKey: primary.privateKey });
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
    readonly environmentId?: EnvironmentId;
    /** Synthetic Personal desktop authority shares its real primary identity. */
    readonly integrations?: RunnerDescriptor["modules"]["integrations"];
    readonly browser?: RunnerDescriptor["modules"]["browser"];
    readonly name: string;
    readonly maxConcurrentRuns?: number;
    readonly voice?: boolean;
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
    readonly longRequestHold?: boolean;
    readonly runFiles?: boolean;
    readonly runnerKind?: "local" | "main";
  } & (
    | { readonly token: string; readonly previous?: undefined }
    /** Reattach the same computer and disk after its Host restarts. */
    | { readonly previous: CallerMachine; readonly token?: undefined }
  ),
): Promise<CallerMachine> {
  const runnerId = input.previous?.runnerId ?? host.hostingComputerId;
  const environmentId =
    input.previous?.environmentId ?? input.environmentId ?? host.config.personal!.environmentId;
  const socket = new WebSocket(`ws://127.0.0.1:${host.hostPort}/internal/v1/runners`);
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
      "agent-tools-plan-v1",
      "execution-plane-v2",
      ...(input.voice ? ["voice-run-v1"] : []),
      ...(input.restartsRuns ? ["attempts-v1"] : []),
    ],
    modules: {
      ...(input.integrations ? { integrations: input.integrations } : {}),
      ...(input.browser ? { browser: input.browser } : {}),
      agents: {
        ...(input.computerTool ? { computerTool: input.computerTool } : {}),
        ...(input.runFiles ? { runFiles: 1 } : {}),
        ...(input.loginFill ? { loginFill: 1 } : {}),
        environmentIds: [environmentId],
        harnessDrivers: [
          {
            accessModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
            driverKind: "codex",
            ...(input.longRequestHold === undefined
              ? {}
              : { longRequestHold: input.longRequestHold }),
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
        maxConcurrentRuns: input.maxConcurrentRuns ?? 4,
        providerStateModes: ["ambient", "isolated"],
      },
    },
    name: input.name,
    runnerId,
    runnerKind: "main",
    runtimeVersion: "integration",
  });
  const credentials = input.previous
    ? { privateKey: input.previous.primary.privateKey }
    : { token: input.token };
  const primary = await connectPrimary(host.hostPort, descriptor, credentials, socket);
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
    const inspected = message.harnesses.filter(
      (harness) =>
        message.type !== "host.reconcile-harnesses" ||
        message.inspect === undefined ||
        message.inspect.includes(harness.id),
    );
    // A reconnect still lists the previous boot's catalog until registration replaces it,
    // so each report names its boot and readiness waits for this one's.
    primary.socket.send(
      JSON.stringify({
        ...primary.fence,
        catalogs: inspected.map((harness) =>
          HarnessInstanceCatalogSchema.parse({
            continuationIdentity: {
              continuationKey: "runner:v1:8tErnQuB1d-nw979Rab9a4JN0RE_tKRvI_Rtmy45Bbo",
              driverKind: harness.driverKind,
            },
            detail: descriptor.bootId,
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
  const harnessInstanceId = await vi.waitFor(
    async () => {
      const bootstrap = await testRpcData(
        host.origin,
        "bootstrap.get",
        {},
        { headers: host.ownerHeaders },
      );
      const harness = bootstrap.harnesses.find(
        (harness) => harness.driverKind === "codex" && harness.environmentId === environmentId,
      );
      const catalog = bootstrap.environments
        .find((environment) => environment.id === environmentId)
        ?.harnessCatalogs.find((catalog) => catalog.harnessInstanceId === harness?.id);
      if (
        !harness ||
        catalog?.status !== "ready" ||
        catalog.detail !== descriptor.bootId ||
        !catalog.models.some(
          (model) => model.modelId === "gpt-5.6-sol" && model.providerId === "openai",
        )
      ) {
        throw new Error(
          `Caller ${input.name} never committed this connection's GPT-5.6 Sol model report`,
        );
      }
      return harness.id;
    },
    { timeout: 15_000 },
  );
  if (host.remoteAccess)
    await configurePersonalRemoteAccess(host, {
      schemaVersion: 1,
      mode: "private",
      routeOrigin: "https://personal.machine-access.test",
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
  readonly toolsToken: string;
  readonly bindingGeneration: number;
  /** The ordinal this attempt's next event takes. */
  readonly nextOrdinal: number;
}

export interface CallerRun {
  /** The bearer the Run holds now; a refresh or a later attempt replaces it. */
  readonly toolsToken: string;
  /** The attempt the caller is executing now. */
  readonly attempt: CallerAttempt;
  readonly integrationTools: { readonly token: string; readonly url: string };
  readonly machineAccess: MachineAccessRunContext;
  readonly runId: RunId;
  readonly threadId: ThreadId;
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
  openLiveRequest(kind?: "harness.input" | "harness.approval"): Promise<RequestId>;
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
): Promise<ThreadId> {
  const thread = await testRpcData(
    host.origin,
    "commands.dispatch",
    {
      accessMode: "full-access",
      environmentId: caller.environmentId,
      harnessInstanceId: caller.harnessInstanceId,
      idempotencyKey: `${input.key}-thread`,
      modelSelection: { modelId: "gpt-5.6-sol", options: { effort: "low" }, providerId: "openai" },
      title: input.title,
      type: "thread.create",
      folder: host.agentHome,
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

    readonly threadId?: ThreadId;
  },
): Promise<CallerRun> {
  const threadId = input.threadId ?? (await createCallerThread(host, caller, input));

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
    get toolsToken() {
      return current.toolsToken;
    },
    get attempt() {
      return current;
    },
    integrationTools: context.agentTools,
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
        current = { ...current, toolsToken: result.credentials.agentTools };
      }
      return result.status;
    },
    reportInterrupted: (attempt = current) => {
      if (attempt === current) release();
      return report(attempt, "run.interrupted", { status: "interrupted" });
    },
    openLiveRequest: async (kind = "harness.input") => {
      const requestId = createId("request");
      const attempt = current;
      current = { ...attempt, nextOrdinal: attempt.nextOrdinal + 1 };
      await report(attempt, "request.opened", {
        request: PendingRequestSchema.parse({
          callId: requestId,
          cancellationReason: null,
          createdAt: new Date().toISOString(),
          id: requestId,
          kind,
          mode: "live",
          originatingOccurrenceId: null,
          originatingRunId: context.runId,
          originatingThreadId: context.threadId,
          payload: { kind },
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
  };
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
      },
      type: "runner.event",
    }),
  );
  caller.primary.activeRunIds = [...caller.primary.activeRunIds, context.runId];
  return {
    toolsToken: context.agentTools.token,
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

export function waitForExecute(
  socket: WebSocket,
  runId?: RunId,
): Promise<
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
      if (runId && message.command.context.runId !== runId) return;
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
  toolsToken: () => string = () => run.toolsToken,
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
      get agentTools() {
        return toolsToken();
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
      await rm(workspacePath, { force: true, recursive: true });
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
  return withTimeout(new Promise<void>((resolve) => socket.once("close", () => resolve())), 5_000, {
    timeoutError: () => new Error("Machine stream never closed"),
  });
}

export async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  await vi.waitFor(
    async () => {
      if (!(await predicate())) throw new Error("Condition never became true");
    },
    { timeout: timeoutMs },
  );
}
export async function waitForValue<Value>(
  produce: () => Promise<Value | undefined>,
  timeoutMs = 15_000,
): Promise<Value> {
  return vi.waitFor(
    async () => {
      const value = await produce();
      if (value === undefined) throw new Error("Value never became available");
      return value;
    },
    { timeout: timeoutMs },
  );
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
  const socket = new WebSocket(
    `ws://127.0.0.1:${host.hostPort}/v1/realtime?${apiVersionQueryParameter}=${hostApiVersion}`,
    { headers },
  );
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const messages: Record<string, unknown>[] = [];
  socket.on("message", (frame: WebSocket.RawData) => {
    messages.push(JSON.parse(frame.toString()) as Record<string, unknown>);
  });
  // Machine notifications belong to the authenticated owner session.
  return {
    close: async () => {
      socket.close();
      await closed(socket);
    },
    messages,
    socket,
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
export interface ShellAccessScenario {
  readonly alias: string;
  readonly caller: CallerMachine;
  readonly host: MachineAccessWireHost;
  readonly launch: CallerLaunch;
  readonly run: CallerRun;
  readonly target: TargetMachine;
  close(): Promise<void>;
}

export async function startShellAccessScenario(
  databaseUrl: string,
  input: {
    readonly fullDiskAccess?: boolean;
    readonly idleTimeoutMs?: number;
    readonly policy: MachineAccessPolicy;
    /** The caller restarts a steered Run rather than steering its engine. */
    readonly restartsRuns?: boolean;
    readonly runCapabilityLifetimeSeconds?: number;
    readonly targetName?: string;
  },
): Promise<ShellAccessScenario> {
  const host = await startMachineAccessWireHost(databaseUrl, {
    remoteAccess: true,
    manualRunner: true,
    ...(input.runCapabilityLifetimeSeconds === undefined
      ? {}
      : { runCapabilityLifetimeSeconds: input.runCapabilityLifetimeSeconds }),
  });
  const targetName = input.targetName ?? "Example Mac";
  const closers: (() => Promise<void>)[] = [() => host.close()];
  try {
    const caller = await connectCallerMachine(host, {
      name: "Caller computer",
      ...(input.restartsRuns ? { restartsRuns: true } : {}),
      token: host.hostingRunnerEnrollmentToken,
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

export async function followPersonalDeployment(host: MachineAccessHost) {
  const socket = new WebSocket(
    `ws://127.0.0.1:${host.hostPort}/v1/realtime?${apiVersionQueryParameter}=${hostApiVersion}`,
    { headers: host.ownerHeaders },
  );
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    }),
    15000,
    { timeoutError: () => new Error("Personal event socket did not open") },
  );
  const live: Record<string, unknown>[] = [];
  let synchronized = false;
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as {
      type: string;
      events?: Record<string, unknown>[];
    };
    if (message.type === "host.synchronized") synchronized = true;
    if (message.type === "host.events" && synchronized) live.push(...(message.events ?? []));
  });
  const ready = waitForMessage(socket, (m) => m.type === "host.synchronized");
  socket.send(
    JSON.stringify({
      type: "client.subscribe",
      apiVersion: hostApiVersion,
      cursor: {
        deploymentId: host.runtime.deployment.id,
        apiVersion: hostApiVersion,
        afterSequence: zeroSequence,
      },
      threadId: null,
    }),
  );
  await ready;
  return {
    live,
    close: async () => {
      socket.close();
      await closed(socket);
    },
  };
}

export async function additionalOwnerSession(host: MachineAccessHost) {
  const response = await host.runtime.app.inject({
    method: "POST",
    url: "/v1/rpc/auth.setup.claim",
    headers: {
      origin: host.origin.origin,
      [hostApiVersionHeader]: String(hostApiVersion),
      "user-agent": "Owner second device",
    },
    payload: { kind: "local-machine-owner", token: host.config.identity.localOwnerClaimToken },
  });
  if (response.statusCode !== 200)
    throw new Error(`Owner session claim failed: ${response.statusCode}`);
  return {
    origin: host.origin.origin,
    cookie: response.cookies.map((value) => `${value.name}=${value.value}`).join("; "),
  };
}
