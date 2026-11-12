import { createDatabase } from "@opensteer/database";
import { sql } from "kysely";
import { parseHostConfig, type HostConfig } from "@opensteer/config";
import {
  createId,
  PendingRequestSchema,
  type EnvironmentId,
  type RequestId,
  type RunId,
  type RunnerId,
  type ThreadId,
} from "@opensteer/core";
import { ownTestDatabaseProducer } from "@opensteer/database/test-support/database";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { createHttpHostApiClient } from "@opensteer/client/host-api";
import {
  HarnessInstanceCatalogSchema,
  hostApiVersionHeader,
  RunnerBootIdSchema,
  RunnerChallengeSchema,
  RunnerDescriptorSchema,
  RunnerEnrollmentCredentialSchema,
  runnerProofFormatVersion,
  type HostToRunnerMessage,
  type MachineAccessRunContext,
  type RunnerBootId,
  type RunnerConnectionFence,
  type RunnerDescriptor,
  type RunnerProof,
} from "@opensteer/protocol";
import {
  createRunnerAuthenticationSignature,
  createRunnerEnrollmentSignature,
} from "@opensteer/runner-auth";
import { freePort } from "@opensteer/shared/test-support/loopbackPort";
import { generateKeyPairSync, randomUUID, randomBytes, type KeyObject } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { vi } from "vitest";
import { testRpcData } from "../server/test-host-api-request.js";
import { createHostRuntime, type PersonalHostRuntime } from "../runtime/runtime.js";
import type { MachineAccessHost as BaseMachineAccessHost } from "../runtime/machine-access.test-support.js";
import {
  configurePersonalRemoteAccess,
  enrollmentToken,
  createMachineAccessDatabase,
} from "../runtime/personal-machine.test-support.js";
export { freePort, configurePersonalRemoteAccess, enrollmentToken, createMachineAccessDatabase };
export type MachineAccessDatabase = Awaited<ReturnType<typeof createMachineAccessDatabase>>;
export interface PrivateMachineHost extends BaseMachineAccessHost {
  readonly hostingRunnerEnrollmentToken: string;
  readonly hostingPrivateKey: KeyObject;
  readonly ownerEnvironmentId: EnvironmentId;
}
export type { PrivateMachineHost as MachineAccessHost };
export function privateMachineHostConfig(
  hostPort: number,
  dataDirectory: string,
  databaseUrl: string,
): HostConfig {
  return parseHostConfig({
    OPENSTEER_MODE: "development",
    OPENSTEER_DEPLOYMENT_KIND: "personal",
    OPENSTEER_DATABASE_URL: databaseUrl,
    OPENSTEER_AUTH_SECRET: randomBytes(48).toString("base64url"),
    OPENSTEER_LOCAL_OWNER_CLAIM_TOKEN: randomBytes(32).toString("base64url"),
    OPENSTEER_LOCAL_PASSWORD_ENABLED: "false",
    OPENSTEER_HOST_DATA_DIR: dataDirectory,
    OPENSTEER_PORT: String(hostPort),
    OPENSTEER_BIND_ADDRESS: "127.0.0.1",
    OPENSTEER_CANONICAL_ORIGIN: `http://127.0.0.1:${hostPort}`,
    OPENSTEER_HOSTING_ENVIRONMENT_ID: createId("environment"),
    OPENSTEER_AGENT_HOME: join(dataDirectory, "agent-home"),
    OPENSTEER_NATIVE_FS_HELPER: resolve("apps/runner/native-fs-helper/opensteer-native-fs"),
  });
}
export async function claimPrivateMachineOwner(runtime: PersonalHostRuntime, config: HostConfig) {
  const claimed = await runtime.app.inject({
    method: "POST",
    url: "/v1/rpc/auth.setup.claim",
    headers: {
      origin: config.canonicalOrigin.origin,
      [hostApiVersionHeader]: String(hostApiVersion),
    },
    payload: { kind: "local-machine-owner", token: config.identity.localOwnerClaimToken },
  });
  if (claimed.statusCode !== 200)
    throw new Error(`Personal owner claim failed: ${claimed.statusCode}`);
  return {
    cookie: claimed.cookies.map((c) => `${c.name}=${c.value}`).join("; "),
    origin: config.canonicalOrigin.origin,
    [hostApiVersionHeader]: String(hostApiVersion),
  };
}
export async function startPrivateMachineHost(
  databaseUrl: string,
  options: Pick<
    NonNullable<Parameters<typeof createHostRuntime>[1]>,
    | "logger"
    | "phoneUpdateRelease"
    | "browserActivityClock"
    | "integrationFetch"
    | "runCapabilityLifetimeSeconds"
    | "runCapabilityNow"
  > & {
    readonly remoteAccess?: boolean;
    readonly deploymentName?: string;
    readonly canonicalOrigin?: URL;
  } = {},
): Promise<PrivateMachineHost> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "private-machine-test-")));
  const config = {
    ...privateMachineHostConfig(await freePort(), directory, databaseUrl),
    ...(options.deploymentName ? { deploymentName: options.deploymentName } : {}),
    ...(options.canonicalOrigin
      ? { canonicalOrigin: options.canonicalOrigin, runtimeOrigin: options.canonicalOrigin }
      : {}),
  };
  await mkdir(config.personal!.agentHome, { recursive: true });
  let runtime: PersonalHostRuntime | undefined;
  let hostClosed = false;
  const close = async () => {
    if (hostClosed) return;
    hostClosed = true;
    try {
      await runtime?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  try {
    const owned = await ownTestDatabaseProducer(databaseUrl, async () => {
      const created = await createHostRuntime(config, options);
      if (created.kind !== "personal") {
        await created.close();
        throw new Error("Expected Personal Host");
      }
      runtime = created;
      return { runtime: created, close };
    });
    const current = owned.runtime;
    await current.listen();
    const ownerHeaders = await claimPrivateMachineOwner(current, config);
    const boot = await current.app.inject({
      method: "GET",
      url: "/v1/local-bootstrap",
      headers: { authorization: `Bearer ${config.identity.localOwnerClaimToken}` },
    });
    const token = boot.json<{ runnerEnrollmentToken: string }>().runnerEnrollmentToken;
    if (!token) throw new Error("No hosting-computer enrollment token");
    const origin = new URL(`http://127.0.0.1:${config.port}`);
    const hostingComputerId = createId("runner");
    const primary = await connectPrimary(
      config.port,
      RunnerDescriptorSchema.parse({
        bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
        capabilities: [],
        modules: {
          agents: {
            environmentIds: [config.personal!.environmentId],
            harnessDrivers: [],
            maxConcurrentRuns: 1,
            providerStateModes: ["isolated"],
          },
        },
        name: "Hosting computer",
        runnerId: hostingComputerId,
        runnerKind: "main",
        runtimeVersion: "test",
      }),
      { token },
    );
    try {
      await testRpcData(origin, "bootstrap.get", {}, { headers: ownerHeaders });
    } finally {
      primary.socket.close();
      await closed(primary.socket);
    }
    const settings = await current.store.database
      .selectFrom("personalSettings")
      .selectAll()
      .executeTakeFirstOrThrow();
    const api = createHttpHostApiClient({
      baseUrl: origin,
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init?.headers)), ...ownerHeaders },
        }),
      onAuthenticationRequired: () => {
        throw new Error("Personal owner session expired");
      },
    });
    const host: PrivateMachineHost = {
      api,
      ownerId: settings.ownerId,
      hostingComputerId: settings.agentHomeComputerId,
      agentHome: { computerId: settings.agentHomeComputerId, path: settings.agentHomePath },
      origin,
      remoteAccess: options.remoteAccess ?? false,
      runtime: current,
      store: current.store,
      config,
      ownerHeaders,
      hostPort: config.port,
      hostingRunnerEnrollmentToken: token,
      hostingPrivateKey: primary.privateKey,
      ownerEnvironmentId: config.personal!.environmentId,
      close,
    };
    if (options.remoteAccess)
      await configurePersonalRemoteAccess(host, {
        schemaVersion: 1,
        mode: "private",
        routeOrigin: "https://personal.private-test.invalid",
      });
    return host;
  } catch (error) {
    await close();
    throw error;
  }
}
export async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 15000,
): Promise<void> {
  await vi.waitFor(
    async () => {
      if (!(await predicate()))
        throw new Error("Expected personal fixture condition never arrived");
    },
    { timeout: timeoutMs },
  );
}
export async function waitForValue<Value>(
  produce: () => Promise<Value | undefined>,
  timeoutMs = 15000,
): Promise<Value> {
  return vi.waitFor(
    async () => {
      const value = await produce();
      if (value === undefined) throw new Error("Expected personal fixture value never arrived");
      return value;
    },
    { timeout: timeoutMs },
  );
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

function primaryFence(message: RunnerConnectionFence): RunnerConnectionFence {
  return {
    bootId: message.bootId,
    connectionGeneration: message.connectionGeneration,
    connectionId: message.connectionId,
    connectionLeaseId: message.connectionLeaseId,
    runnerId: message.runnerId,
  };
}

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

export interface CallerMachine {
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: string;
  readonly primary: PrimaryConnection;
  readonly runnerId: RunnerId;
  close(): Promise<void>;
}

export async function connectCallerMachine(
  host: PrivateMachineHost,
  input: {
    /**
     * The actual hosting computer’s execution environment.
     */
    readonly environmentId?: EnvironmentId;
    /** Synthetic Personal desktop authority shares its real primary identity. */
    readonly integrations?: RunnerDescriptor["modules"]["integrations"];
    readonly browser?: RunnerDescriptor["modules"]["browser"];
    readonly name: string;
    readonly maxConcurrentRuns?: number;
    readonly voice?: boolean;
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
  } & (
    | { readonly token: string; readonly previous?: undefined }
    /** Reattach the same computer and disk after its Host restarts. */
    | { readonly previous: CallerMachine; readonly token?: undefined }
  ),
): Promise<CallerMachine> {
  const runnerId = input.previous?.runnerId ?? host.hostingComputerId;
  const environmentId =
    input.previous?.environmentId ?? input.environmentId ?? host.ownerEnvironmentId;
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
    : { privateKey: host.hostingPrivateKey };
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

async function createCallerThread(
  host: PrivateMachineHost,
  caller: CallerMachine,
  input: { readonly key: string; readonly title: string },
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
    },
    { headers: host.ownerHeaders },
  );
  if (thread.type !== "thread.create") throw new Error("Thread command mismatch.");
  return thread.thread.id;
}

export async function dispatchCallerRun(
  host: PrivateMachineHost,
  caller: CallerMachine,
  input: {
    readonly key: string;
    readonly title: string;
    /** Continue this task rather than creating a new one. */
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
      delivery: "queue",
      type: "thread.sendMessage",
    },
    { headers: host.ownerHeaders },
  );
  if (turn.type !== "thread.sendMessage" || !turn.run) throw new Error("Turn command mismatch.");
  return acceptCallerRun(host, caller, await executed);
}

export async function acceptCallerRun(
  host: PrivateMachineHost,
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

export async function openRealtime(
  host: PrivateMachineHost,
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

  return {
    close: async () => {
      socket.close();
      await closed(socket);
    },
    messages,
    socket,
  };
}

export async function revokeMachine(
  host: PrivateMachineHost,
  input: { readonly key: string; readonly runnerId: RunnerId },
): Promise<void> {
  await testRpcData(
    host.origin,
    "commands.dispatch",
    { idempotencyKey: input.key, machineId: input.runnerId, type: "machine.revoke" },
    { headers: host.ownerHeaders },
  );
}

export async function stopRun(
  host: PrivateMachineHost,
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

export async function steerRun(
  host: PrivateMachineHost,
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

export async function clearPersonalMachineFixture(databaseUrl: string): Promise<void> {
  const database = createDatabase({ connectionString: databaseUrl });
  try {
    await sql`truncate table credential_vault_canaries, deployments, users, runners restart identity cascade`.execute(
      database,
    );
  } finally {
    await database.destroy();
  }
}
