import { freePort } from "@opensteer/shared/test-support/loopbackPort";
import { runnerCatalogReadiness } from "./runner-readiness.test-support.js";
import { EventEmitter } from "node:events";
import { forkRunnerChild } from "./runner-child.test-support.js";
import { RunnerWire, type RunnerWireOptions } from "./runner-wire.test-support.js";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { LocalWorkspaceAuthority, NativeFsHelper } from "@opensteer/workspace-local";
import { nativeFsHelperBinary } from "../runtime/machine-access.test-support.js";
import type { HostConfig, RunnerConfig } from "@opensteer/config";
import { createHttpHostApiClient } from "@opensteer/client/host-api";
import {
  createId,
  HarnessIdSchema,
  zeroSequence,
  type AgentEvent,
  type ArtifactContentPart,
  type Attachment,
  type EnvironmentId,
  type HarnessInstanceId,
  type MessageId,
  type ModelSelection,
  type NotificationView,
  type ProviderSessionId,
  type RunId,
  type ThreadId,
  type ThreadAccessMode,
  type WorkspaceId,
} from "@opensteer/core";
import {
  cloneTestDatabase,
  failDatabaseContainment,
  type TestDatabase,
} from "@opensteer/database/test-support/database";
import { TestRunner } from "vitest";
import { hostApiVersion, hostKeyFingerprint } from "@opensteer/deployment-authority";
import type { HarnessRegistry, HarnessRuntimeBoundary } from "@opensteer/harness";
import {
  HostToClientMessageSchema,
  RunnerBootIdSchema,
  hostApiVersionHeader,
  type HarnessInstanceCatalogView,
  type HarnessModelDescriptor,
  type HostToClientMessage,
  type HostApiClient,
} from "@opensteer/protocol";
import {
  ReconnectingHostConnection,
  ExecutionContainment,
  executionScopeVariable,
  AttachmentCache,
  FileRunnerIdentityStore,
  RunnerRuntime,
  providerContinuationIdentityProjector,
  type RunWorkspaceManager,
  type RunnerLogger,
  type RunnerRuntimeOptions,
  type PreparedIntegrationsModule,
  type RunnerAgentsConnection,
} from "@opensteer/runner";
import WebSocket, { type RawData } from "ws";
import { loadOrCreateHostInstance } from "../identity/host-instance.js";
import { loadOrCreateHostKeys } from "../identity/host-keys.js";
import { createHostRuntime, type HostRuntime } from "../runtime/runtime.js";
import { NetworkPartition } from "./network-partition.test-support.js";
import { startPortableFsManagerFake } from "../runtime/portablefs-manager.test-support.js";
import { testRpcData } from "../server/test-host-api-request.js";
import { integrationBundleEntry } from "@opensteer/shared/test-support/integrationRunnerBuild";

/*
 * A whole deployment in one process: a Host on a temporary database, one
 * Runner connected to it over its real WebSocket, and a person signed in
 * through the real setup flow. Only the Workspace's storage is faked. The
 * Runner is given its engine registry, so the same stack runs a scripted
 * engine in the integration suite and the shipped engines in qualification.
 */

const accessToken = "vertical-access-".padEnd(40, "a");
const agentSkillsRoot = fileURLToPath(new URL("../../../runner/agent-skills/", import.meta.url));
const testAgentSkills = {
  paths: {
    "opensteer-browser": join(agentSkillsRoot, "skills", "opensteer-browser"),
    "opensteer-computer-use": join(agentSkillsRoot, "skills", "opensteer-computer-use"),
    "opensteer-computers": join(agentSkillsRoot, "skills", "opensteer-computers"),
    "opensteer-specialization": join(agentSkillsRoot, "skills", "opensteer-specialization"),
    "opensteer-integrations": join(agentSkillsRoot, "skills", "opensteer-integrations"),
    "opensteer-threads": join(agentSkillsRoot, "skills", "opensteer-threads"),
    "opensteer-triggers": join(agentSkillsRoot, "skills", "opensteer-triggers"),
    "opensteer-workspaces": join(agentSkillsRoot, "skills", "opensteer-workspaces"),
  },
  rootPath: agentSkillsRoot,
} as const;
const cleanupTimeoutMs = 30_000;

export interface VerticalStackOptions {
  readonly executionClock?: import("@opensteer/shared/clock").Clock;
  readonly account?: HostConfig["account"];
  readonly accountDirectoryFetch?: typeof globalThis.fetch;
  readonly runnerWire?: RunnerWireOptions;
  /** Child-process Runner for crash/reaping acceptance journeys. */
  readonly runnerChild?: { readonly fixture: string; readonly arguments: readonly string[] };
  /** Personal Main Runner with its desktop authority; no server enrollment shortcut. */
  readonly personal?: { readonly integrations: () => PreparedIntegrationsModule };
  /**
   * A browser this computer relays, reached over the same loopback bridge the
   * desktop app's Runner uses. Without it the Runner offers no browser.
   */
  readonly browser?: {
    readonly bridgeToken: string;
    readonly runtimeId: string;
    readonly url: URL;
  };
  /** The Browser Harness executable a Run's commands invoke. */
  readonly browserHarnessExecutable?: string;
  /**
   * The one-use token a separately running browser service enrolls with, as a
   * self-hosted or managed Deployment configures it.
   */
  readonly browserServiceEnrollmentToken?: string;
  readonly cleanupTimeoutMs?: number;
  readonly databaseUrl: string;
  /**
   * The Runner's engines. A factory gives each Runner boot its own registry,
   * as a restarted process has; `restartRunner` needs one, because a Runner
   * closes its registry when it stops.
   */
  readonly harnesses: HarnessRegistry | (() => HarnessRegistry);
  readonly harnessRuntimeBoundary: HarnessRuntimeBoundary;
  /** The one account the deployment is given before its Runner connects. */
  readonly harnessInstance: {
    readonly config: Readonly<Record<string, unknown>>;
    readonly driverKind: string;
    readonly sourceId: string;
    readonly stateKind: "ambient" | "isolated";
    /**
     * A key to sign the account in with, through the same setup commands the
     * Settings screen sends, when the Runner reports it signed out. With no
     * `value` the method needs nothing typed, as when the server's own
     * settings hold the key.
     */
    readonly apiKey?: {
      readonly connectionSlot?: string;
      readonly methodId: string;
      readonly value?: string;
    };
  };
  /** Additional accounts on the same connected Runner for route-switch journeys. */
  readonly additionalHarnessInstances?: readonly VerticalStackOptions["harnessInstance"][];
  /** How long the Runner may take to report that account's catalog ready. */
  readonly catalogTimeoutMs: number;
  /** How long one Run may take to complete. */
  readonly runTimeoutMs: number;
  /** Captures Runner diagnostics for engine lifecycle journeys. */
  readonly runnerLogger?: RunnerLogger;
  /** Original Host diagnostics, before an acceptance journey scrubs exports. */
  readonly hostLog?: (line: string) => void;
  /** Runs the one Runner executes at once; one unless a journey needs more. */
  readonly maxConcurrentRuns?: number;
  /** How long a Run survives without word from its Runner; shortened by reattach journeys. */
  readonly executionLeaseMs?: number;
  /** Where the Runner reads model server apps' own settings; a temporary home in tests. */
  readonly modelServerHome?: string;
  /** How long a Run's capability tokens live, shortened by refresh journeys. */
  readonly runCapabilityLifetimeSeconds?: number;
  readonly runCapabilityNow?: () => number;
  readonly credentialRefreshClock?: RunnerRuntimeOptions["credentialRefreshClock"];
  readonly notificationTiming?: Pick<
    import("../notifications/notification-dispatcher.js").NotificationDispatcherOptions,
    "now" | "wait"
  >;
  /** Controls only Host browser activity expiry. */
  readonly browserActivityClock?: import("@opensteer/shared/clock").Clock;
  /** Controls only when the Host's periodic workspace reconciliation passes run. */
  readonly workspaceReconcileClock?: import("@opensteer/shared/clock").Clock;
  /** How this Runner's Runs reach other computers; without it they reach none. */
  readonly machineAccess?: RunnerRuntimeOptions["machineAccess"];
  /**
   * Where people, phones and Runs reach this Host when it is not where it
   * listens, such as a TLS front door in front of it. It is the canonical and
   * the runtime origin both: the signed-in person's requests name it, a phone
   * pairs with it, and the Runner's tool URLs are minted from it. The Host
   * itself stays bound to loopback, where the stack's clients and Runner
   * connection dial it.
   */
  readonly publicOrigin?: URL;
}

export interface VerticalTurn {
  readonly assistantText: string;
  readonly events: readonly AgentEvent[];
  readonly runId: RunId;
}

export interface VerticalStack {
  readonly settledRunEvent: (
    runId: RunId,
  ) => import("@opensteer/protocol").PendingAgentEvent | undefined;
  readonly notifications: readonly NotificationView[];
  readonly wire?: RunnerWire;
  readonly crashRunner: (beforeRestart?: () => Promise<void>) => Promise<void>;
  readonly startAdditionalRunner: () => Promise<{
    readonly environmentId: EnvironmentId;
    readonly harnessInstanceId: HarnessInstanceId;
    readonly close: () => Promise<void>;
  }>;
  readonly api: HostApiClient;
  /** Test-only authenticated browser session for exercising the actual client transports. */
  readonly sessionCookie: string;
  readonly catalog: Extract<HarnessInstanceCatalogView, { status: "ready" }>;
  /** The account's first settled catalog, before any sign-in. */
  readonly initialCatalog: HarnessInstanceCatalogView;
  readonly environmentId: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly additionalHarnessInstanceIds: readonly HarnessInstanceId[];
  readonly mainWorkspaceId: WorkspaceId;
  readonly host: HostRuntime;
  readonly hostOrigin: URL;
  /** The hop between the Runner and the Host, which a journey can cut or hold open. */
  readonly network: Pick<NetworkPartition, "block" | "drop" | "unblock">;
  /** Stops the Host and starts it again on the same database, keys and port. */
  /**
   * Stops the Host and boots it again. `whileDown` runs, and `downForMs`
   * passes, before the new Host starts: an outage its Runner lives through.
   */
  readonly restartHost: (outage?: {
    readonly downForMs?: number;
    readonly whileDown?: () => Promise<void>;
  }) => Promise<void>;
  /** Stops the Runner process, ending its engines, and starts it again as a new boot. */
  readonly restartRunner: () => Promise<void>;
  readonly mountedWorkspacePath: string;
  readonly runnerDataDirectory: string;
  readonly mountCalls: readonly Parameters<RunWorkspaceManager["prepare"]>[0][];
  readonly mountCleanupCalls: () => number;
  readonly portableFsCreateCalls: () => number;
  readonly close: () => Promise<void>;
  readonly createWorkspace: (
    name: string,
  ) => Promise<{ readonly id: WorkspaceId; readonly kind: string }>;
  readonly configureModel: (
    nativeModelId: string,
    settings: { readonly contextWindow: number; readonly maxOutputTokens?: number } | null,
  ) => Promise<HarnessModelDescriptor>;
  readonly createThread: (input: {
    readonly home?: true;
    readonly generateTitle?: true;
    readonly idempotencyKey?: string;
    readonly modelSelection: ModelSelection;
    readonly title: string;
    readonly workspaceId: WorkspaceId;
  }) => Promise<ThreadId>;
  readonly updateThreadExecution: (
    threadId: ThreadId,
    modelSelection: ModelSelection,
    options?: {
      readonly harnessInstanceId?: HarnessInstanceId;
      readonly expectedProviderSessionId?: ProviderSessionId | null;
      readonly idempotencyKey?: string;
    },
  ) => Promise<void>;
  readonly updateThreadAccess: (threadId: ThreadId, accessMode: ThreadAccessMode) => Promise<void>;
  readonly interruptRun: (threadId: ThreadId, runId: RunId) => Promise<void>;
  readonly resumeThreadInputQueue: (threadId: ThreadId) => Promise<void>;
  readonly queueMessage: (input: {
    readonly text: string;
    readonly threadId: ThreadId;
  }) => Promise<{ readonly messageId: MessageId; readonly runId: RunId | null }>;
  /** Reserves and uploads one file the way a client does; the Host must accept it. */
  readonly uploadAttachment: (input: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly name: string;
    readonly workspaceId: WorkspaceId;
  }) => Promise<Attachment>;
  /** Waits until the Run's agent has started `count` tool calls, so its turn is mid-flight. */
  readonly waitForToolStart: (runId: RunId, count?: number) => Promise<void>;
  /** Sends one message into the Thread's executing Run as a steer. */
  readonly steerMessage: (input: {
    readonly attachments?: readonly ArtifactContentPart[];
    readonly text: string;
    readonly threadId: ThreadId;
  }) => Promise<{ readonly messageId: MessageId; readonly runId: RunId | null }>;
  /** Sends one message and waits for its Run or the callback-selected continuation. */
  readonly sendMessage: (input: {
    readonly attachments?: readonly ArtifactContentPart[];
    /** Return a Request's actual continuation Run when the journey must follow it. */
    readonly onQueued?: (runId: RunId) => Promise<RunId | void>;
    readonly text: string;
    readonly threadId: ThreadId;
    readonly workspaceId: WorkspaceId;
  }) => Promise<VerticalTurn>;
}

/** The message part that sends an uploaded attachment. */
export function attachmentReference(attachment: Attachment): ArtifactContentPart {
  return {
    artifactId: attachment.id,
    mediaType: attachment.mediaType,
    name: attachment.name,
    sizeBytes: attachment.sizeBytes,
    type: "artifact",
  };
}

export async function startVerticalStack(options: VerticalStackOptions): Promise<VerticalStack> {
  const context = TestRunner.getCurrentTest()?.context;
  context?.signal.throwIfAborted();
  // Allocation owns no services and must fail with the original database error.
  const database = await cloneTestDatabase("host", { serverUrl: options.databaseUrl });
  const cleanups: Cleanup[] = [];
  const shutdown = new AbortController();
  let starting: Promise<VerticalStack>;
  let stopping: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const operations = new Set<Promise<unknown>>();
  const childStops = new Set<() => Promise<void>>();
  const stopProducers = () =>
    (stopping ??= (async () => {
      shutdown.abort(new Error("Vertical stack closed"));
      // Startup may still be creating resources when Vitest times out its body.
      // Wait for that owner before consuming its cleanup list; a hung owner is fatal.
      const failures: unknown[] = [];
      // A child waiting to become ready cannot be drained until it is stopped.
      for (const stop of childStops) {
        try {
          await stop();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await settleWithin(
          {
            label: "stack startup/operations",
            run: async () => {
              await starting.catch(() => undefined);
              await Promise.allSettled(operations);
            },
          },
          options.cleanupTimeoutMs ?? cleanupTimeoutMs,
        );
      } catch (error) {
        failures.push(error);
      }
      for (const cleanup of cleanups.splice(0).reverse()) {
        try {
          await settleWithin(cleanup, options.cleanupTimeoutMs ?? cleanupTimeoutMs);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, "Vertical stack cleanup failed");
    })());
  const close = () =>
    (closing ??= (async () => {
      const failures: unknown[] = [];
      try {
        await stopProducers();
      } catch (error) {
        failures.push(error);
      }
      try {
        await database.drop();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        failDatabaseContainment(new AggregateError(failures, "Vertical stack cleanup failed"));
    })());
  context?.onTestFinished(close);
  starting = startWithin(
    options,
    cleanups,
    close,
    database,
    (stop) => {
      childStops.add(stop);
      cleanups.push({ label: "Runner child process group", run: stop });
      // A restart already in flight can fork while teardown is awaiting it.
      // Stop that new owner immediately; the cleanup list retains any failure.
      if (stopping) void stop().catch(() => undefined);
    },
    shutdown.signal,
  );
  try {
    const stack = await starting;
    context?.signal.throwIfAborted();
    return new Proxy(stack, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (
          !["restartHost", "restartRunner", "crashRunner", "startAdditionalRunner"].includes(
            String(property),
          ) ||
          typeof value !== "function"
        )
          return value;
        return (...args: unknown[]) => {
          context?.signal.throwIfAborted();
          if (closing) throw new Error("Vertical stack is closed");
          const operation: Promise<unknown> = Promise.resolve(Reflect.apply(value, target, args));
          operations.add(operation);
          void operation.then(
            () => operations.delete(operation),
            () => operations.delete(operation),
          );
          return operation;
        };
      },
    });
  } catch (error) {
    await close();
    throw error;
  }
}

async function startWithin(
  options: VerticalStackOptions,
  cleanups: Cleanup[],
  close: () => Promise<void>,
  temporaryDatabase: TestDatabase,
  ownRunnerChild: (close: () => Promise<void>) => void,
  shutdown: AbortSignal,
): Promise<VerticalStack> {
  // The native local authority refuses symlink ancestors such as macOS /var.
  const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "opensteer-vertical-")));
  cleanups.push({
    label: "temporary files",
    run: () => rm(temporaryRoot, { force: true, recursive: true }),
  });
  const hostDataDirectory = join(temporaryRoot, "host");
  const runnerDataDirectory = join(temporaryRoot, "runner");
  cleanups.push({
    label: "execution processes",
    run: async () => {
      // A fresh boot marker includes every boot this fixture started. The
      // production reaper also follows detached descendants after their parent exits.
      for (const dataDirectory of [runnerDataDirectory, join(temporaryRoot, "companion")]) {
        const containment = new ExecutionContainment({
          bootId: `fixture-cleanup-${randomUUID()}`,
          dataDirectory,
        });
        if ((await containment.reapEarlierBoots()) !== "proven")
          throw new Error("Stack execution processes could not be proven stopped");
      }
    },
  });
  const mountedWorkspacePath = join(temporaryRoot, "mounted-workspace");
  const runnerId = createId("runner");
  const environmentId = createId("environment");
  const bootId = RunnerBootIdSchema.parse(`rbt_${randomUUID()}`);
  await Promise.all([
    mkdir(hostDataDirectory, { mode: 0o700, recursive: true }),
    mkdir(runnerDataDirectory, { mode: 0o700, recursive: true }),
    mkdir(mountedWorkspacePath, { mode: 0o700, recursive: true }),
  ]);
  const portableFs = await startPortableFsManagerFake();
  cleanups.push({ label: "PortableFS", run: () => portableFs.close() });
  const hostPort = await freePort();
  const hostOrigin = new URL(`http://127.0.0.1:${hostPort}`);
  const publicOrigin = options.publicOrigin ?? hostOrigin;
  const accountIdentity = options.account
    ? await (async () => {
        const instance = await loadOrCreateHostInstance(hostDataDirectory);
        const keys = await loadOrCreateHostKeys({ dataDirectory: hostDataDirectory });
        return {
          deploymentId: createId("deployment"),
          hostInstanceId: instance.hostInstanceId,
          hostKeyFingerprint: hostKeyFingerprint(
            keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
          ),
        };
      })()
    : undefined;
  const catalogCommits = new EventEmitter();
  const bootHost = () =>
    createHostRuntime(
      {
        ...hostConfig({
          dataDirectory: hostDataDirectory,
          databaseUrl: temporaryDatabase.url,
          executionLeaseMs: options.executionLeaseMs ?? 90_000,
          hostOrigin,
          portableFsUrl: portableFs.url,
          publicOrigin,
        }),
        ...(options.personal
          ? {
              acceptsExternalRunners: false,
              exposure: "loopback" as const,
              canonicalOrigin: hostOrigin,
              identity: {
                localOwnerClaimToken: accessToken,
                localPasswordEnabled: false,
                signupPolicy: "closed" as const,
                oidcConfigPath: undefined,
                initialOwnerEnrollment: undefined,
              },
              workspace: {
                deletionRetentionDays: 14,
                shape: {
                  defaultWorkspaceBacking: "local-directory" as const,
                  kind: "personal" as const,
                },
                storage: { kind: "local-directory" as const, ownerEnvironmentId: environmentId },
              },
            }
          : {}),
        ...(options.account
          ? { account: options.account, deploymentIdentity: accountIdentity }
          : {}),
        ...(options.browserServiceEnrollmentToken
          ? { initialBrowserRunnerEnrollmentToken: options.browserServiceEnrollmentToken }
          : {}),
      },
      {
        ...(options.executionClock ? { executionClock: options.executionClock } : {}),
        ...(options.notificationTiming ? { notificationTiming: options.notificationTiming } : {}),
        ...(options.browserActivityClock
          ? { browserActivityClock: options.browserActivityClock }
          : {}),
        ...(options.workspaceReconcileClock
          ? { workspaceReconcileClock: options.workspaceReconcileClock }
          : {}),
        onRunnerCatalogsCommitted: (identity, environment, catalogs) => {
          catalogCommits.emit(
            "committed",
            identity.bootId,
            identity.connectionId,
            environment,
            catalogs,
          );
        },
        ...(options.accountDirectoryFetch
          ? { accountDirectoryFetch: options.accountDirectoryFetch }
          : {}),
        logger: options.hostLog
          ? {
              level: "info",
              redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
              stream: new Writable({
                write(chunk: Buffer | string, _encoding, done) {
                  options.hostLog!(chunk.toString());
                  done();
                },
              }),
            }
          : { level: "warn" },
        ...(!options.personal ? { portableFsMountManagerEndpoint: portableFs.mountEndpoint } : {}),
        ...(options.runCapabilityNow ? { runCapabilityNow: options.runCapabilityNow } : {}),
        ...(options.runCapabilityLifetimeSeconds
          ? { runCapabilityLifetimeSeconds: options.runCapabilityLifetimeSeconds }
          : {}),
      },
    );
  // A journey may restart the Host, so cleanup always closes the current one.
  let host = await bootHost();
  cleanups.push({ label: "Host", run: () => host.close(), pending: () => host.closingStep() });
  await host.listen();
  const requestOrigin = options.personal ? hostOrigin : publicOrigin;
  const personalOwner = options.personal
    ? await setupPersonalOwner(hostOrigin, accessToken)
    : undefined;
  await host.store.createEnvironment({
    id: environmentId,
    kind: options.personal ? "main" : "local",
    name: "Vertical local environment",
  });
  const harnessInstance = await host.store.createHarnessInstance({
    config: { ...options.harnessInstance.config },
    driverKind: HarnessIdSchema.parse(options.harnessInstance.driverKind),
    environmentId,
    name: "Vertical account",
    sourceId: options.harnessInstance.sourceId,
    stateKind: options.harnessInstance.stateKind,
  });
  const additionalHarnessInstances = await Promise.all(
    (options.additionalHarnessInstances ?? []).map((additional, index) =>
      host.store.createHarnessInstance({
        config: { ...additional.config },
        driverKind: HarnessIdSchema.parse(additional.driverKind),
        environmentId,
        name: `Vertical account ${index + 2}`,
        sourceId: additional.sourceId,
        stateKind: additional.stateKind,
      }),
    ),
  );
  // The Runner reaches the Host through a hop a journey can cut; everything
  // else (clients, engine tool calls) reaches the Host directly.
  const partition = options.runnerWire
    ? await RunnerWire.start(hostPort, options.runnerWire)
    : await NetworkPartition.start(hostPort);
  cleanups.push({ label: "network partition", run: () => partition.close() });
  const sessionCookie =
    personalOwner?.sessionCookie ??
    (await setupInitialAdministrator(hostOrigin, requestOrigin, accessToken));
  const api = createHttpHostApiClient({
    baseUrl: hostOrigin,
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("cookie", sessionCookie);
      headers.set("origin", requestOrigin.origin);
      return fetch(input, { ...init, headers });
    },
    onAuthenticationRequired: () => undefined,
  });
  const signedIn = (idempotencyKey?: string) => ({
    headers: idempotencyKey
      ? mutationHeaders(sessionCookie, idempotencyKey, requestOrigin)
      : { cookie: sessionCookie },
  });
  const runnerEnrollment = personalOwner
    ? { type: "runner.enrollment.createLocal" as const, token: personalOwner.runnerEnrollmentToken }
    : await testRpcData(
        hostOrigin,
        "commands.dispatch",
        {
          allowedModules: options.browser ? ["agents", "browser"] : ["agents"],
          idempotencyKey: "vertical-runner",
          name: "Vertical computer",
          type: "runner.enrollment.createLocal",
        },
        signedIn("vertical-runner"),
      );
  if (runnerEnrollment.type !== "runner.enrollment.createLocal") {
    throw new Error("Runner enrollment command mismatch.");
  }

  const mountCalls: Parameters<RunWorkspaceManager["prepare"]>[0][] = [];
  let mountCleanupCalls = 0;
  const workspaceManager: Pick<RunWorkspaceManager, "prepare" | "writableRoots"> = {
    prepare: async (input) => {
      mountCalls.push(input);
      return {
        cleanup: async () => {
          mountCleanupCalls += 1;
        },
        instructions: "Read the durable workspace before answering.",
        path: mountedWorkspacePath,
      };
    },
    writableRoots: ({ workspacePath }) => [workspacePath],
  };
  const runnerDeploymentProfile = options.personal
    ? { defaultWorkspaceBacking: "local-directory" as const, kind: "personal" as const }
    : { defaultWorkspaceBacking: "portablefs" as const, kind: "server" as const };
  const workspaceBackings = options.personal
    ? ["local-directory" as const]
    : ["portablefs" as const];
  const filesystem = new NativeFsHelper({
    binary: nativeFsHelperBinary,
    rootPolicy: "managed-local",
  });
  const localAuthority = options.personal
    ? new LocalWorkspaceAuthority({
        filesystemAuthority: filesystem,
        namespace: { kind: "single-owner", ownerEnvironmentId: environmentId },
        registryFilePath: join(runnerDataDirectory, "local-workspaces.json"),
        visibleRootPath: join(temporaryRoot, "local-workspaces"),
      })
    : undefined;
  // A real Runner derives this from its persisted identity key, so it survives a restart.
  const continuationKey = generateKeyPairSync("ed25519").privateKey;
  const runnerStarts = new Set<Promise<unknown>>();
  const runnerStopErrors: unknown[] = [];
  cleanups.push({
    label: "Runner startups",
    run: async () => {
      await Promise.allSettled(runnerStarts);
      if (runnerStopErrors.length)
        throw new AggregateError(runnerStopErrors, "Runner shutdown failed");
    },
  });
  // One Runner process. A journey may restart it, which ends its engines and
  // comes back as a new boot with the same persisted identity and data.
  const bootRunner = async (
    bootId: ReturnType<typeof RunnerBootIdSchema.parse>,
    companion?: {
      readonly environment: EnvironmentId;
      readonly id: typeof runnerId;
      readonly directory: string;
      readonly enrollmentToken: string;
      readonly harnessInstanceId: HarnessInstanceId;
    },
    requireReady = true,
  ) => {
    shutdown.throwIfAborted();
    const executionEnvironmentId = companion?.environment ?? environmentId;
    const executionRunnerId = companion?.id ?? runnerId;
    const executionDataDirectory = companion?.directory ?? runnerDataDirectory;
    const integrations = options.personal?.integrations();
    const containment = new ExecutionContainment({ bootId, dataDirectory: executionDataDirectory });
    const earlierBoots = await containment.reapEarlierBoots();
    const runner = new RunnerRuntime({
      ...(options.executionClock ? { executionClock: options.executionClock } : {}),
      ...(options.credentialRefreshClock
        ? { credentialRefreshClock: options.credentialRefreshClock }
        : {}),
      containment,
      attachmentCache: new AttachmentCache({
        root: join(temporaryRoot, "attachments"),
        transport: { hostOrigin, mode: "development" },
      }),
      agentSkills: testAgentSkills,
      bootId,
      browserHarnessExecutable:
        options.browserHarnessExecutable ?? "/opt/opensteer/browser-harness",
      deploymentShape: runnerDeploymentProfile,
      environmentId: executionEnvironmentId,
      harnesses: typeof options.harnesses === "function" ? options.harnesses() : options.harnesses,
      harnessRuntimeBoundary: options.harnessRuntimeBoundary,
      ...(options.runnerLogger ? { logger: options.runnerLogger } : {}),
      // The boundary an isolated-service Linux Runner would enforce through
      // bubblewrap; these scenarios prove the Run wiring, not the namespace.
      harnessSandbox: {
        plan: async () => (launch) => launch,
        planProgram: async () => (launch) => launch,
      },
      integrationSkills: async () => ({
        cleanup: async () => undefined,
        digest: "none",
        directory: undefined,
        skills: [],
      }),
      maxConcurrentRuns: options.maxConcurrentRuns ?? 1,
      maxConcurrentTriggerPrograms: 1,
      ...(options.machineAccess ? { machineAccess: options.machineAccess } : {}),
      ...(options.modelServerHome ? { modelServerHome: options.modelServerHome } : {}),
      mode: "development",
      nodeExecutable: process.execPath,
      dataDirectory: executionDataDirectory,
      privateStateDirectory: join(executionDataDirectory, "private", "harness-state"),
      projectContinuationIdentity: providerContinuationIdentityProjector(continuationKey),
      workspaceManager,
    });
    const runnerConfig: RunnerConfig = {
      browserBridge: undefined,
      controlCaPath: undefined,
      dataDirectory: executionDataDirectory,
      deploymentShape: runnerDeploymentProfile,
      enrollmentToken: companion?.enrollmentToken ?? runnerEnrollment.token,
      environmentId: executionEnvironmentId,
      hostUrl: partition.url,
      maxConcurrentRuns: options.maxConcurrentRuns ?? 1,
      maxConcurrentTriggerPrograms: 1,
      mode: "development",
      modules: options.personal ? ["agents", "integrations"] : ["agents", "browser", "shell"],
      mountBinary: "unused-at-the-test-boundary",
      name: "Vertical local runner",
      runnerId: executionRunnerId,
      runnerKind: options.personal ? "main" : "local",
      workspaceBackings,
      workspaceNamespace: "owner-scoped",
      workspaceRoot: mountedWorkspacePath,
      localWorkspaceRegistryPath: undefined,
      localWorkspaceRoot: undefined,
      nodeExecutable: process.execPath,
    };
    const identityStore = new FileRunnerIdentityStore({
      dataDirectory: executionDataDirectory,
      environmentId: executionEnvironmentId,
      runnerId: executionRunnerId,
    });
    const identity = await identityStore.loadOrCreate();
    const runnerConnection = new ReconnectingHostConnection({
      ...(options.executionClock ? { executionClock: options.executionClock } : {}),
      bootId,
      config: runnerConfig,
      identity,
      identityStore,
      logger: options.runnerLogger ?? silentLogger,
      ...(integrations ? { integrationsModule: integrations } : {}),
      runtimeVersion: "vertical-test",
      agents: {
        earlierBootsContained: earlierBoots === "proven",
        ...(options.browser
          ? {
              browserBridge: {
                bridgeToken: options.browser.bridgeToken,
                runtimeId: options.browser.runtimeId,
                signIn: false,
                url: options.browser.url,
              },
            }
          : {}),
        runtime: runner,
        workspaceBackings,
        ...(localAuthority
          ? {
              localWorkspaces: {
                inventory: () => localAuthority.inventory(),
                // Only the lifecycle subset this journey uses is scripted. The
                // authority still provisions and inspects its real native disk.
                service: {
                  async handle(request) {
                    const echo = {
                      binding: request.binding,
                      fence: request.fence,
                      operationId: request.operationId,
                      requestId: request.requestId,
                    };
                    const signal = AbortSignal.timeout(30_000);
                    if (request.type === "host.workspace.local.provision") {
                      await localAuthority.provision(
                        {
                          binding: request.binding,
                          fingerprint: request.fingerprint,
                          idempotencyKey: request.operationId,
                        },
                        signal,
                      );
                      return { ...echo, type: "runner.workspace.local.provisioned" };
                    }
                    if (request.type === "host.workspace.local.inspect") {
                      const health = await localAuthority.inspect(request.binding, signal);
                      if (health.status !== "ready")
                        throw new Error(`Personal journey disk is ${health.status}`);
                      return {
                        ...echo,
                        type: "runner.workspace.local.inspected",
                        health: { status: "ready" },
                      };
                    }
                    throw new Error(
                      `Unsupported Personal journey storage request: ${request.type}`,
                    );
                  },
                } satisfies Pick<
                  NonNullable<RunnerAgentsConnection["localWorkspaces"]>["service"],
                  "handle"
                > as unknown as NonNullable<RunnerAgentsConnection["localWorkspaces"]>["service"],
              },
            }
          : {}),
        workspaceMounts: () => [],
      },
    });
    const expectedAccounts = companion
      ? [companion.harnessInstanceId]
      : [harnessInstance.id, ...additionalHarnessInstances.map((account) => account.id)];
    const committed = Promise.withResolvers<void>();
    const observe = runnerCatalogReadiness({
      bootId,
      environmentId: executionEnvironmentId,
      harnessInstanceIds: expectedAccounts,
      requireReady,
      onReady: committed.resolve,
    });
    catalogCommits.on("committed", observe);
    const expired = Promise.withResolvers<never>();
    const timeout = setTimeout(
      () =>
        expired.reject(
          new Error(
            `Runner boot ${bootId} did not commit its account catalog within ${options.catalogTimeoutMs} ms`,
          ),
        ),
      options.catalogTimeoutMs,
    );
    // Attach a rejection handler before any child startup awaits.
    void expired.promise.catch(() => undefined);
    const stopObserving = () => {
      clearTimeout(timeout);
      catalogCommits.off("committed", observe);
    };
    const startupDone = Promise.withResolvers<void>();
    const ownBoot = <T extends { readonly close: () => Promise<void> }>(process: T): T => {
      let stopping: Promise<void> | undefined;
      const owned = {
        ...process,
        close: () => {
          shutdown.removeEventListener("abort", stop);
          expired.reject(new Error(`Runner boot ${bootId} stopped before readiness`));
          stopObserving();
          return (stopping ??= process.close());
        },
      };
      const stop = () => {
        void owned.close().catch((error: unknown) => runnerStopErrors.push(error));
      };
      if (shutdown.aborted) stop();
      else shutdown.addEventListener("abort", stop, { once: true });
      // Ownership begins before readiness, including a replacement still preparing.
      cleanups.push({
        label: `Runner boot ${bootId}`,
        run: async () => {
          try {
            await owned.close();
          } finally {
            await startupDone.promise;
          }
        },
      });
      return owned;
    };
    if (partition instanceof RunnerWire) partition.useKey(identity.privateKey, executionRunnerId);
    if (options.runnerChild && !companion) {
      // Nothing from the in-process Runtime has connected or executed. The child
      // owns all execution and the same public Host connection as a real Runner.
      await runner.close();
      const ownedChild = forkRunnerChild(
        await integrationBundleEntry(
          fileURLToPath(new URL("../../../../", import.meta.url)),
          "recovery",
        ),
        {
          execArgv: [],
          // Preserve this fixture's existing shutdown budget when using the bounded owner.
          gracefulCloseMs: options.cleanupTimeoutMs ?? cleanupTimeoutMs,
          environment: { [executionScopeVariable]: containment.scope("fixture-runner") },
          afterStop: async () => {
            // A crashed boot may close after its replacement has started.
            if ((await containment.reapBoot()) !== "proven")
              throw new Error("Runner child execution processes could not be proven stopped");
          },
        },
        ownRunnerChild,
      );
      const child = ownedChild.child;
      let diagnostics = "";
      child.stdout?.on("data", (data: Buffer) => {
        diagnostics += data.toString();
      });
      child.stderr?.on("data", (data: Buffer) => {
        diagnostics += data.toString();
      });
      let crashed = false;
      const exited = new Promise<{
        readonly code: number | null;
        readonly signal: NodeJS.Signals | null;
      }>((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
      const stopped = async () => {
        const outcome = await exited;
        if (!crashed && (outcome.code !== 0 || outcome.signal !== null))
          throw new Error(
            `Runner child shutdown (${outcome.code}, ${outcome.signal}): ${diagnostics}`,
          );
      };
      const failed = Promise.withResolvers<never>();
      const ready = new Promise<void>((resolve, reject) => {
        child.once("message", (message) =>
          message === "ready" ? resolve() : reject(new Error(JSON.stringify(message))),
        );
        child.once("error", (error) => {
          failed.reject(error);
          reject(error);
        });
        child.once("exit", () => {
          const error = new Error(`Runner child exited: ${diagnostics}`);
          failed.reject(error);
          reject(error);
        });
      });
      void ready.catch(() => undefined);
      void failed.promise.catch(() => undefined);
      child.send({
        bootId,
        config: { ...runnerConfig, hostUrl: partition.url.toString() },
        harnessInstance: options.harnessInstance,
        engine: options.runnerChild,
        mountedWorkspacePath,
        attachmentRoot: join(temporaryRoot, "attachments"),
        agentSkills: testAgentSkills,
        continuationPrivateKey: continuationKey.export({ type: "pkcs8", format: "pem" }).toString(),
      });
      const bootProcess = ownBoot({
        settledRunEvent: (_runId: RunId) => undefined,
        crash: async () => {
          crashed = true;
          await ownedChild.crash();
        },
        close: async () => {
          await ownedChild.close();
          await stopped();
        },
      });
      try {
        await Promise.race([committed.promise, expired.promise, failed.promise]);
        child.send({ type: "catalog-committed", bootId });
        await Promise.race([ready, expired.promise]);
        return bootProcess;
      } catch (error) {
        try {
          await settleWithin(
            { label: "unready Runner child", run: bootProcess.close },
            options.cleanupTimeoutMs ?? cleanupTimeoutMs,
          );
        } catch (cleanupError) {
          await bootProcess.crash();
          const reaper = new ExecutionContainment({
            bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
            dataDirectory: executionDataDirectory,
          });
          await reaper.reapEarlierBoots();
          throw new AggregateError([error, cleanupError], "Runner startup and cleanup failed");
        }
        throw error;
      } finally {
        stopObserving();
        startupDone.resolve();
      }
    }
    const runnerShutdown = new AbortController();
    const runnerConnectionTask = runnerConnection.run(runnerShutdown.signal);
    const bootProcess = ownBoot({
      settledRunEvent: (runId: RunId) => runner.settledRunEvent(runId),
      crash: async () => {
        throw new Error("A crash requires runnerChild");
      },
      close: async () => {
        runnerShutdown.abort(new Error("Vertical stack closed"));
        runnerConnection.close();
        await runnerConnectionTask;
        await runner.close();
        integrations?.close?.();
      },
    });
    try {
      await Promise.race([committed.promise, expired.promise]);
      return bootProcess;
    } catch (error) {
      await bootProcess.close();
      throw error;
    } finally {
      stopObserving();
      startupDone.resolve();
    }
  };
  const startRunner = (...input: Parameters<typeof bootRunner>) => {
    const startup = bootRunner(...input);
    runnerStarts.add(startup);
    void startup.finally(() => runnerStarts.delete(startup)).catch(() => undefined);
    return startup;
  };
  // The first boot may need the fixture's sign-in commands before it can be ready.
  let runnerProcess = await startRunner(bootId, undefined, false);

  // Personal Main is provisioned through the authenticated Runner's local authority.
  const mainWorkspaceId = await waitForValue(options.catalogTimeoutMs, async () => {
    const bootstrap = await testRpcData(hostOrigin, "bootstrap.get", {}, signedIn());
    return bootstrap.homeWorkspace?.id;
  });

  // Waits for the account's first settled answer; anything but ready is a
  // result in itself (an engine not signed in, not installed, or failing), so
  // it ends the wait rather than running out the clock.
  const settledCatalog = () =>
    waitForValue(options.catalogTimeoutMs, async () => {
      const bootstrap = await testRpcData(hostOrigin, "bootstrap.get", {}, signedIn());
      const environment = bootstrap.environments.find((entry) => entry.id === environmentId);
      const catalog = environment?.harnessCatalogs.find(
        (entry) => entry.harnessInstanceId === harnessInstance.id,
      );
      return environment?.connected && catalog && catalog.status !== "preparing"
        ? catalog
        : undefined;
    });
  let reported = await settledCatalog();
  const initialCatalog = reported;
  const apiKey = options.harnessInstance.apiKey;
  if (reported.status === "authentication-required" && apiKey) {
    const begun = await testRpcData(
      hostOrigin,
      "commands.dispatch",
      {
        environmentId,
        harnessInstanceId: harnessInstance.id,
        idempotencyKey: "vertical-sign-in",
        ...(apiKey.connectionSlot ? { connectionSlot: apiKey.connectionSlot } : {}),
        methodId: apiKey.methodId,
        type: "harness.authentication.begin",
      },
      signedIn("vertical-sign-in"),
    );
    if (begun.type !== "harness.authentication.begin") {
      throw new Error("Sign-in command mismatch.");
    }
    const value = apiKey.value;
    if (value !== undefined) {
      const challenge = await waitForValue(options.catalogTimeoutMs, async () => {
        const answer = await testRpcData(
          hostOrigin,
          "harness.authentication.get",
          { environmentId, harnessInstanceId: harnessInstance.id },
          signedIn(),
        );
        if (answer.authentication.status === "failed") {
          throw new Error(`Sign-in failed: ${answer.authentication.detail}`);
        }
        return answer.authentication.status === "pending" ? answer.authentication : undefined;
      });
      if (challenge.status !== "pending" || challenge.challenge.kind !== "secret-input") {
        throw new Error("Sign-in did not ask for a key.");
      }
      const submitted = await testRpcData(
        hostOrigin,
        "commands.dispatch",
        {
          environmentId,
          harnessInstanceId: harnessInstance.id,
          idempotencyKey: "vertical-sign-in-key",
          type: "harness.authentication.submit",
          value,
        },
        signedIn("vertical-sign-in-key"),
      );
      if (submitted.type !== "harness.authentication.submit") {
        throw new Error("Sign-in submission command mismatch.");
      }
    }
    await waitForValue(options.catalogTimeoutMs, async () => {
      const answer = await testRpcData(
        hostOrigin,
        "harness.authentication.get",
        { environmentId, harnessInstanceId: harnessInstance.id },
        signedIn(),
      );
      if (answer.authentication.status === "failed") {
        throw new Error(`The key was not accepted: ${answer.authentication.detail}`);
      }
      return answer.authentication.status === "ready" ? true : undefined;
    });
    reported = await waitForValue(options.catalogTimeoutMs, async () => {
      const catalog = await settledCatalog();
      return catalog.status === "authentication-required" ? undefined : catalog;
    });
  }
  if (reported.status !== "ready") {
    throw new Error(`The account reported ${reported.status}: ${reported.detail}`);
  }
  const catalog = reported;
  for (const additional of additionalHarnessInstances) {
    const additionalCatalog = await waitForValue(options.catalogTimeoutMs, async () => {
      const bootstrap = await testRpcData(hostOrigin, "bootstrap.get", {}, signedIn());
      const environment = bootstrap.environments.find((entry) => entry.id === environmentId);
      const found = environment?.harnessCatalogs.find(
        (entry) => entry.harnessInstanceId === additional.id,
      );
      return environment?.connected && found && found.status !== "preparing" ? found : undefined;
    });
    if (additionalCatalog.status !== "ready") {
      throw new Error(
        `Additional account reported ${additionalCatalog.status}: ${additionalCatalog.detail}`,
      );
    }
  }

  const notifications: NotificationView[] = [];
  const observeNotifications = (socket: WebSocket): WebSocket => {
    socket.on("message", (data) => {
      const parsed = HostToClientMessageSchema.parse(JSON.parse(String(data)));
      if (parsed.type === "host.notification") notifications.push(parsed.notification);
    });
    return socket;
  };
  let realtimeSocket = observeNotifications(
    await openWebSocket(`ws://127.0.0.1:${hostPort}/v1/realtime`, sessionCookie, requestOrigin),
  );
  cleanups.push({ label: "realtime socket", run: async () => realtimeSocket.terminate() });
  const subscribed = new Set<WorkspaceId>();

  return {
    settledRunEvent: (runId) => runnerProcess.settledRunEvent(runId),
    ...(partition instanceof RunnerWire ? { wire: partition } : {}),
    startAdditionalRunner: async () => {
      const extraEnvironment = createId("environment");
      const extraRunner = createId("runner");
      await host.store.createEnvironment({
        id: extraEnvironment,
        kind: "local",
        name: "Healthy companion",
      });
      const account = await host.store.createHarnessInstance({
        ...options.harnessInstance,
        driverKind: HarnessIdSchema.parse(options.harnessInstance.driverKind),
        config: { ...options.harnessInstance.config },
        environmentId: extraEnvironment,
        name: "Healthy companion account",
      });
      const key = randomUUID();
      const enrollment = await testRpcData(
        hostOrigin,
        "commands.dispatch",
        {
          type: "runner.enrollment.createLocal",
          idempotencyKey: key,
          allowedModules: ["agents"],
          name: "Healthy companion",
        },
        signedIn(key),
      );
      if (enrollment.type !== "runner.enrollment.createLocal")
        throw new Error("Companion enrollment failed");
      const extra = await startRunner(RunnerBootIdSchema.parse(`rbt_${randomUUID()}`), {
        environment: extraEnvironment,
        id: extraRunner,
        directory: join(temporaryRoot, "companion"),
        enrollmentToken: enrollment.token,
        harnessInstanceId: account.id,
      });
      return { environmentId: extraEnvironment, harnessInstanceId: account.id, close: extra.close };
    },
    crashRunner: async (beforeRestart) => {
      await runnerProcess.crash();
      try {
        await beforeRestart?.();
      } finally {
        runnerProcess = await startRunner(RunnerBootIdSchema.parse(`rbt_${randomUUID()}`));
      }
    },
    api,
    sessionCookie,
    catalog,
    initialCatalog,
    environmentId,
    harnessInstanceId: harnessInstance.id,
    additionalHarnessInstanceIds: additionalHarnessInstances.map((instance) => instance.id),
    mainWorkspaceId,
    get host() {
      return host;
    },
    hostOrigin,
    network: partition,
    restartHost: async (outage = {}) => {
      realtimeSocket.terminate();
      await host.close();
      await outage.whileDown?.();
      if (outage.downForMs) await new Promise((resolve) => setTimeout(resolve, outage.downForMs));
      host = await bootHost();
      await host.listen();
      realtimeSocket = observeNotifications(
        await openWebSocket(`ws://127.0.0.1:${hostPort}/v1/realtime`, sessionCookie, requestOrigin),
      );
      subscribed.clear();
    },
    restartRunner: async () => {
      if (typeof options.harnesses !== "function") {
        throw new Error("Restarting the Runner needs a harness registry factory");
      }
      await runnerProcess.close();
      runnerProcess = await startRunner(RunnerBootIdSchema.parse(`rbt_${randomUUID()}`));
    },
    mountedWorkspacePath,
    runnerDataDirectory,
    mountCalls,
    mountCleanupCalls: () => mountCleanupCalls,
    portableFsCreateCalls: () => portableFs.createCalls,
    close,
    notifications,
    configureModel: async (nativeModelId, settings) => {
      const key = `model-configure-${randomUUID()}`;
      const configured = await testRpcData(
        hostOrigin,
        "commands.dispatch",
        {
          environmentId,
          harnessInstanceId: harnessInstance.id,
          idempotencyKey: key,
          nativeModelId,
          settings,
          type: "harness.model.configure",
        },
        signedIn(key),
      );
      if (configured.type !== "harness.model.configure") {
        throw new Error("Model configuration command mismatch.");
      }
      return waitForValue(options.catalogTimeoutMs, async () => {
        const bootstrap = await testRpcData(hostOrigin, "bootstrap.get", {}, signedIn());
        const environment = bootstrap.environments.find((entry) => entry.id === environmentId);
        const catalog = environment?.harnessCatalogs.find(
          (entry) => entry.harnessInstanceId === harnessInstance.id,
        );
        if (catalog?.status !== "ready") return undefined;
        const model = catalog.models.find(
          (entry) => (entry.nativeModelId ?? entry.modelId) === nativeModelId,
        );
        if (!model) return undefined;
        return settings?.contextWindow === model.contextWindow ? model : undefined;
      });
    },
    createWorkspace: async (name) => {
      const created = await testRpcData(
        hostOrigin,
        "commands.dispatch",
        { idempotencyKey: `workspace-${name}`, name, type: "workspace.create" },
        signedIn(`workspace-${name}`),
      );
      if (created.type !== "workspace.create") throw new Error("Workspace command mismatch.");
      return { id: created.workspace.id, kind: created.workspace.kind };
    },
    createThread: async ({
      home,
      generateTitle,
      idempotencyKey,
      modelSelection,
      title,
      workspaceId,
    }) => {
      const key = idempotencyKey ?? `thread-${title}`;
      const created = await testRpcData(
        hostOrigin,
        "commands.dispatch",
        {
          environmentId,
          harnessInstanceId: harnessInstance.id,
          ...(home ? { home } : {}),
          ...(generateTitle ? { generateTitle } : {}),
          idempotencyKey: key,
          modelSelection,
          title,
          type: "thread.create",
          workspaceId,
        },
        signedIn(key),
      );
      if (created.type !== "thread.create") throw new Error("Thread command mismatch.");
      return created.thread.id;
    },
    updateThreadExecution: async (threadId, modelSelection, options) => {
      const key = options?.idempotencyKey ?? `execution-${randomUUID()}`;
      const updated = await testRpcData(
        hostOrigin,
        "commands.dispatch",
        {
          harnessInstanceId: options?.harnessInstanceId ?? harnessInstance.id,
          idempotencyKey: key,
          modelSelection,
          threadId,
          type: "thread.execution.update",
          ...(options && "expectedProviderSessionId" in options
            ? { continuation: { expectedProviderSessionId: options.expectedProviderSessionId } }
            : {}),
        },
        signedIn(key),
      );
      if (updated.type !== "thread.execution.update") {
        throw new Error("Thread execution command mismatch.");
      }
    },
    updateThreadAccess: async (threadId, accessMode) => {
      const key = `access-${randomUUID()}`;
      const updated = await testRpcData(
        hostOrigin,
        "commands.dispatch",
        { accessMode, idempotencyKey: key, threadId, type: "thread.access.update" },
        signedIn(key),
      );
      if (updated.type !== "thread.access.update")
        throw new Error("Thread access command mismatch.");
    },
    interruptRun: async (threadId, runId) => {
      const key = `interrupt-${randomUUID()}`;
      const interrupted = await testRpcData(
        hostOrigin,
        "commands.dispatch",
        { idempotencyKey: key, runId, threadId, type: "run.interrupt" },
        signedIn(key),
      );
      if (interrupted.type !== "run.interrupt") throw new Error("Run interrupt command mismatch.");
    },
    resumeThreadInputQueue: async (threadId) => {
      const key = `queue-resume-${randomUUID()}`;
      const resumed = await testRpcData(
        hostOrigin,
        "commands.dispatch",
        { idempotencyKey: key, threadId, type: "thread.inputQueue.resume" },
        signedIn(key),
      );
      if (resumed.type !== "thread.inputQueue.resume") {
        throw new Error("Thread input queue resume command mismatch.");
      }
    },
    queueMessage: async ({ text, threadId }) => {
      const key = `queued-message-${randomUUID()}`;
      const result = await testRpcData(
        hostOrigin,
        "commands.dispatch",
        {
          content: [{ text, type: "text" }],
          idempotencyKey: key,
          threadId,
          type: "thread.sendMessage",
        },
        signedIn(key),
      );
      if (result.type !== "thread.sendMessage") {
        throw new Error("Thread message command mismatch.");
      }
      return { messageId: result.message.id, runId: result.run?.id ?? null };
    },
    uploadAttachment: async ({ bytes, mediaType, name, workspaceId }) => {
      const reservation = await api["commands.dispatch"]({
        idempotencyKey: randomUUID(),
        mediaType,
        name,
        sizeBytes: bytes.byteLength,
        type: "attachment.upload.create",
        workspaceId,
      });
      if (!reservation.ok) throw new Error(reservation.error.message);
      if (reservation.data.type !== "attachment.upload.create")
        throw new Error("Unexpected attachment reservation receipt");
      const uploaded = await api["attachment.upload"](
        { attachmentId: reservation.data.attachment.id },
        { body: new Blob([Uint8Array.from(bytes)]) },
      );
      if (!uploaded.ok) throw new Error(uploaded.error.message);
      if (uploaded.data.state !== "ready") throw new Error("The upload did not become ready");
      return uploaded.data;
    },
    waitForToolStart: async (runId, count = 1) => {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const started = await host.store.database
          .selectFrom("workspaceEvents")
          .select("eventId")
          .where("runId", "=", runId)
          .where("type", "=", "tool.started")
          .execute();
        if (started.length >= count) return;
        await delay(250);
      }
      throw new Error(`The agent did not start ${count} tool call(s)`);
    },
    steerMessage: async ({ attachments = [], text, threadId }) => {
      const key = `steered-message-${randomUUID()}`;
      const result = await testRpcData(
        hostOrigin,
        "commands.dispatch",
        {
          content: [{ text, type: "text" as const }, ...attachments],
          delivery: "steer",
          idempotencyKey: key,
          threadId,
          type: "thread.sendMessage",
        },
        signedIn(key),
      );
      if (result.type !== "thread.sendMessage") {
        throw new Error("Thread message command mismatch.");
      }
      return { messageId: result.message.id, runId: result.run?.id ?? null };
    },
    sendMessage: async ({ attachments = [], onQueued, text, threadId, workspaceId }) => {
      if (subscribed.size && !subscribed.has(workspaceId)) {
        // The Host permits one Workspace subscription per socket.
        realtimeSocket.terminate();
        realtimeSocket = observeNotifications(
          await openWebSocket(
            `ws://127.0.0.1:${hostPort}/v1/realtime`,
            sessionCookie,
            requestOrigin,
          ),
        );
        subscribed.clear();
      }
      if (!subscribed.has(workspaceId)) {
        const synchronized = waitForRealtimeMessage(
          realtimeSocket,
          (message) => message.type === "host.synchronized",
        );
        realtimeSocket.send(
          JSON.stringify({
            afterSequence: zeroSequence,
            apiVersion: hostApiVersion,
            threadId,
            type: "client.subscribe",
            workspaceId,
          }),
        );
        await synchronized;
        subscribed.add(workspaceId);
      }
      const key = `turn-${randomUUID()}`;
      const settled = collectUntilSettled(realtimeSocket, options.runTimeoutMs);
      const turn = await testRpcData(
        hostOrigin,
        "commands.dispatch",
        {
          content: [...(text ? [{ text, type: "text" as const }] : []), ...attachments],
          idempotencyKey: key,
          threadId,
          type: "thread.sendMessage",
        },
        signedIn(key),
      );
      if (turn.type !== "thread.sendMessage" || !turn.run) {
        throw new Error(`Turn command did not start a Run: ${JSON.stringify(turn)}`);
      }
      const runId = turn.run.id;
      const finalRunId = (await onQueued?.(runId)) ?? runId;
      const events = (await settled(finalRunId)).filter(
        (event) => event.runId === runId || event.runId === finalRunId,
      );
      const failure = events.find((event) => event.type === "run.failed");
      if (failure) {
        const record = await host.store.database
          .selectFrom("runs")
          .select("failure")
          .where("id", "=", failure.runId)
          .executeTakeFirst();
        const command = await host.store.database
          .selectFrom("commands")
          .select(["status", "lastError"])
          .where("runId", "=", failure.runId)
          .executeTakeFirst();
        throw new Error(
          `Run failed: ${JSON.stringify(failure.data)}; stored: ${JSON.stringify(record)}; command: ${JSON.stringify(command)}`,
        );
      }
      const snapshot = await host.store.workspaceSnapshot(workspaceId);
      const assistantText = snapshot.messages
        .filter((message) => message.kind === "assistant" && message.runId === finalRunId)
        .flatMap((message) => message.content)
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      return { assistantText, events, runId: finalRunId };
    },
  };
}

function hostConfig(input: {
  readonly dataDirectory: string;
  readonly databaseUrl: string;
  readonly executionLeaseMs: number;
  readonly hostOrigin: URL;
  readonly portableFsUrl: URL;
  readonly publicOrigin: URL;
}): HostConfig {
  return {
    acceptsExternalRunners: true,
    authSecret: "vertical-auth-secret".padEnd(40, "x"),
    bindAddress: "127.0.0.1",
    canonicalOrigin: input.publicOrigin,
    browserRuntime: { attachKeyId: "host-browser-v1" },
    browserProfileKeyPath: undefined,
    credentialKeyPath: undefined,
    databaseUrl: input.databaseUrl,
    dataDirectory: input.dataDirectory,
    identity: {
      initialOwnerEnrollment: { lifetimeSeconds: 3_600, token: accessToken },
      localPasswordEnabled: true,
      oidcConfigPath: undefined,
      signupPolicy: "invite-only",
    },
    executionLeaseMs: input.executionLeaseMs,
    maxConcurrentDispatches: 2,
    maxConcurrentTriggerDispatches: 2,
    mode: "development",
    port: Number(input.hostOrigin.port),
    exposure: "networked" as const,
    privateKeyPath: undefined,
    publicKeyPath: undefined,
    runtimeOrigin: input.publicOrigin,
    workspace: {
      deletionRetentionDays: 14,
      shape: {
        defaultWorkspaceBacking: "portablefs",
        kind: "server" as const,
      },
      storage: {
        archiveAfterDays: 7,
        authorizationDomain: "opensteer-test",
        defaultBlockLimitBytes: 10 * 1_024 * 1_024 * 1_024,
        defaultInodeLimit: 1_000_000,
        filesServiceUrl: new URL("http://127.0.0.1:4315"),
        kind: "portablefs",
        maxBlockLimitBytes: 100 * 1_024 * 1_024 * 1_024,
        maxInodeLimit: 10_000_000,
        managerCaPath: undefined,
        managerCertPath: undefined,
        managerKeyPath: undefined,
        managerServerName: undefined,
        managerUrl: input.portableFsUrl,
        productIssuer: "opensteer-test",
        productPrivateKeyPath: undefined,
        serviceId: "test-portablefs",
      },
    },
  };
}

const silentLogger: RunnerLogger = {
  error: () => undefined,
  info: () => undefined,
};

/**
 * Starts listening before the Run exists, so no event can arrive unseen, and
 * resolves once the named Run has reached a terminal event.
 */
function collectUntilSettled(
  socket: WebSocket,
  timeoutMs: number,
): (runId: string) => Promise<readonly AgentEvent[]> {
  const events: AgentEvent[] = [];
  let target: string | undefined;
  let settle: ((events: readonly AgentEvent[]) => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;
  const terminal = new Set(["run.completed", "run.failed", "run.interrupted"]);
  const settled = () =>
    target !== undefined &&
    events.some((event) => event.runId === target && terminal.has(event.type));
  const receive = (frame: RawData, isBinary: boolean) => {
    if (isBinary) return finish(() => fail?.(new Error("Realtime sent a binary frame")));
    let message: HostToClientMessage;
    try {
      message = HostToClientMessageSchema.parse(JSON.parse(frame.toString()));
    } catch (error) {
      return finish(() => fail?.(error));
    }
    if (message.type !== "host.events") return;
    events.push(...message.events);
    if (settled()) finish(() => settle?.(events));
  };
  const closed = () => finish(() => fail?.(new Error("Realtime closed before the Run settled")));
  let timeout: NodeJS.Timeout | undefined;
  const finish = (callback: () => void): void => {
    if (timeout) clearTimeout(timeout);
    socket.off("message", receive);
    socket.off("close", closed);
    callback();
  };
  socket.on("message", receive);
  socket.once("close", closed);
  return (runId) =>
    new Promise((resolve, reject) => {
      target = runId;
      settle = resolve;
      fail = reject;
      if (settled()) return finish(() => resolve(events));
      timeout = setTimeout(
        () => finish(() => reject(new Error(`Run ${runId} did not settle within ${timeoutMs} ms`))),
        timeoutMs,
      );
    });
}

export function waitForRealtimeMessage(
  socket: WebSocket,
  predicate: (message: HostToClientMessage) => boolean,
): Promise<HostToClientMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(() => reject(new Error("Timed out waiting for realtime message"))),
      10_000,
    );
    const receive = (frame: RawData, isBinary: boolean) => {
      if (isBinary) return finish(() => reject(new Error("Realtime sent a binary frame")));
      let message: HostToClientMessage;
      try {
        message = HostToClientMessageSchema.parse(JSON.parse(frame.toString()));
      } catch (error) {
        return finish(() => reject(error));
      }
      if (predicate(message)) finish(() => resolve(message));
    };
    const finish = (callback: () => void): void => {
      clearTimeout(timeout);
      socket.off("message", receive);
      callback();
    };
    socket.on("message", receive);
  });
}

async function waitForValue<T>(
  timeoutMs: number,
  operation: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the Runner to report the account", {
    cause: lastError,
  });
}

function mutationHeaders(
  cookie: string,
  idempotencyKey: string,
  origin: URL,
): Record<string, string> {
  return {
    cookie,
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
    origin: origin.origin,
  };
}

function openWebSocket(url: string, cookie: string, origin: URL): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { cookie, origin: origin.origin } });
    const opened = () => finish(() => resolve(socket));
    const failed = (error: Error) => finish(() => reject(error));
    const finish = (callback: () => void): void => {
      socket.off("open", opened);
      socket.off("error", failed);
      callback();
    };
    socket.once("open", opened);
    socket.once("error", failed);
  });
}

async function setupInitialAdministrator(dial: URL, origin: URL, token: string): Promise<string> {
  const cookies = new Map<string, string>();
  const request = async (path: string, body: unknown) => {
    const response = await fetch(new URL(path, dial), {
      body: JSON.stringify(body),
      headers: {
        ...(cookies.size > 0 ? { cookie: [...cookies.values()].join("; ") } : {}),
        "content-type": "application/json",
        origin: origin.origin,
        [hostApiVersionHeader]: String(hostApiVersion),
      },
      method: "POST",
    });
    for (const setCookie of response.headers.getSetCookie()) {
      const pair = setCookie.split(";", 1)[0];
      const name = pair?.split("=", 1)[0];
      if (!pair || !name) continue;
      if (pair === `${name}=`) cookies.delete(name);
      else cookies.set(name, pair);
    }
    const responseBody = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${responseBody}`);
  };
  await request("/v1/rpc/auth.setup.exchange", { token });
  await request("/v1/rpc/auth.setup.claim", {
    email: "vertical@example.test",
    kind: "password",
    password: "vertical-test-password-strong",
  });
  return [...cookies.values()].join("; ");
}

/** One teardown step, named so a step that hangs says which it is. */
interface Cleanup {
  readonly label: string;
  readonly run: () => Promise<unknown>;
  /** What the step is still waiting on, for the timeout message. */
  readonly pending?: () => string | undefined;
}

async function settleWithin(cleanup: Cleanup, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      cleanup.run(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const pending = cleanup.pending?.();
          reject(
            new Error(
              `Cleanup of the ${cleanup.label} did not finish${pending ? ` (waiting on: ${pending})` : ""}`,
            ),
          );
        }, timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** The desktop supervisor's bootstrap and local owner claim, over their real HTTP routes. */
async function setupPersonalOwner(origin: URL, token: string) {
  const bootstrapResponse = await fetch(new URL("/v1/local-bootstrap", origin), {
    headers: { authorization: `Bearer ${token}`, origin: origin.origin },
  });
  if (!bootstrapResponse.ok)
    throw new Error(`Personal bootstrap failed: ${bootstrapResponse.status}`);
  const bootstrap = (await bootstrapResponse.json()) as { runnerEnrollmentToken?: string };
  if (!bootstrap.runnerEnrollmentToken) throw new Error("Missing Personal Main enrollment");
  const claimed = await fetch(new URL("/v1/rpc/auth.setup.claim", origin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: origin.origin,
      [hostApiVersionHeader]: String(hostApiVersion),
    },
    body: JSON.stringify({ kind: "local-machine-owner", token }),
  });
  if (!claimed.ok) throw new Error(`Personal owner claim failed: ${claimed.status}`);
  const sessionCookie = claimed.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  if (!sessionCookie) throw new Error("Personal owner received no session");
  return { runnerEnrollmentToken: bootstrap.runnerEnrollmentToken, sessionCookie };
}
