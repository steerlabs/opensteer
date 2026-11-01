import { browserProfileSnapshotVersion } from "@opensteer/browser-profile/snapshot";
import type { EnvironmentId, HarnessId, HarnessInstanceId, RunId } from "@opensteer/core";
import { withTimeout } from "@opensteer/shared/withTimeout";
import type { RunnerConfig } from "@opensteer/config";
import { sameStringSet } from "@opensteer/core";
import type { RunnerCapability } from "@opensteer/core";
import { randomUUID } from "node:crypto";
import {
  HostToRunnerMessageSchema,
  RunnerAuxiliaryRequestIdSchema,
  RunnerOperationalMessageSchema,
  RunnerToHostMessageSchema,
  RunnerWireProofSchema,
  type RunnerToHostMessage,
  parseJsonFrame,
  runnerEnvironmentIds,
  serializeJsonFrame,
  type HarnessInstanceCatalog,
  type HostToRunnerMessage,
  type HostWorkspaceLocalRequest,
  type RunnerAgentsModule,
  type RunnerAuxiliaryModule,
  type RunnerChallenge,
  type RunnerCommand,
  type RunnerConnectionFence,
  type RunnerDescriptor,
  type RunnerEnrollmentCredential,
  type RunnerLocalStorageInventory,
  type RunnerOperationalReport,
  type RunnerWorkspaceMount,
} from "@opensteer/protocol";
import { maxBrowserRelayEnvelopeBytes } from "@opensteer/protocol/browser-relay";
import WebSocket, { type RawData } from "ws";
import { BoundedRunnerInbox } from "../runtime/bounded-inbox.js";
import type { LocalWorkspaceService } from "../workspace/local-workspace-service.js";
import {
  BrowserModuleRelay,
  FencedInboundDispatcher,
  LocalBrowserRuntimeBridge,
  RunnerConnectionFenceLedger,
  moduleReadiness,
  openRunnerAuxiliaryStream,
  runnerEnrollmentCredential,
  runnerIdentityProof,
  runnerTransportWebSocketUrl,
  runnerWebSocketTransport,
  type FileRunnerIdentityStore,
  type RunnerIdentity,
  type RunnerModuleStream,
} from "@opensteer/runner-client";
import {
  errorCatalog,
  type RefreshedRunCredentials,
  type RunnerMessageSink,
  RunnerRuntime,
} from "../runtime/runtime.js";
import { ComputerAppModuleHandler } from "../computer-apps/module-handler.js";
import type { PreparedIntegrationsModule } from "../computer-apps/prepare.js";
import type { PreparedMessagingModule } from "../messaging/prepare.js";
import { ShellModuleHandler } from "../shell/shell-module-handler.js";
import type { PreparedShellModule } from "../shell/shell-host-key.js";
import {
  watchFullDiskAccess,
  type FullDiskAccessProbeOptions,
  type FullDiskAccessWatch,
} from "../shell/full-disk-access.js";

const maximumFrameBytes = 1024 * 1024;
const maximumQueuedInboundBytes = 4 * maximumFrameBytes;
const maximumQueuedInboundItems = 64;
const maximumBufferedOutboundBytes = 8 * 1024 * 1024;
const handshakeTimeoutMs = 15_000;
const connectionOperationStopWaitMs = 15_000;
const maximumReconnectDelayMs = 30_000;
/**
 * A Runner holding Runs has only their leases to get back to the Host in, so
 * it retries within a few seconds: a Host restart then costs them nothing, at
 * the price of more attempts against a Host that is down.
 */
const reconnectDelayHoldingRunsMs = 5_000;
// A Runner that cannot enroll is waiting on a human, not on the network.
const unenrollableReconnectDelayMs = 120_000;
/**
 * The Host's close code for an identity that no longer belongs to the
 * Deployment. It is deliberately not 4003: that code carries lease expiry and
 * every other authentication refusal — including the Personal "remote access is
 * off" one — each of which is a Runner that should keep trying.
 */
const revokedIdentityCloseCode = 4010;

/** How long a refusal waits for the close code that classifies it. */
const refusalCloseWaitMs = 3_000;

/** The one refusal that ends this Runner rather than delaying it. */
class RunnerIdentityRevokedError extends Error {
  constructor() {
    super("The Host revoked this Runner's identity");
    this.name = "RunnerIdentityRevokedError";
  }
}

/** The Host said no while connecting. Whether that is final is in the close. */
class HostRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostRefusedError";
  }
}

interface InboundFrame {
  readonly buffer: Buffer;
  readonly isBinary: boolean;
}

type PostAuthenticationHostMessage = Exclude<
  HostToRunnerMessage,
  { readonly type: "host.challenge" | "host.error" }
>;

/**
 * What one auxiliary module does with its own stream.
 *
 * Everything else about opening a module stream — the ticket request, the key
 * proof, the readiness report, the heartbeat, the teardown — is identical for
 * every module and lives in `#openModule`.
 */
interface RunnerModuleHandler {
  readonly maxPayloadBytes: number;
  attach(stream: RunnerModuleStream): Promise<void> | void;
  detach(): Promise<void> | void;
  handleFrame(frame: Buffer, isBinary: boolean): Promise<void>;
}

function computerAppModuleHandler(
  integrations: PreparedIntegrationsModule,
  logger: RunnerLogger,
  config: Pick<RunnerConfig, "hostUrl" | "controlCaPath" | "mode">,
): RunnerModuleHandler {
  const handler = new ComputerAppModuleHandler({
    ...(integrations.computerUse ? { computerUse: integrations.computerUse } : {}),
    ...(integrations.localMcp ? { localMcp: integrations.localMcp } : {}),
    logger,
    providers: integrations.providers,
    videoTransport: {
      hostOrigin: config.hostUrl,
      mode: config.mode,
      ...(config.controlCaPath ? { controlCaPath: config.controlCaPath } : {}),
    },
  });
  return {
    attach: (stream) => handler.attach(stream),
    detach: () => handler.detach(),
    handleFrame: (frame, isBinary) => handler.handleFrame(frame, isBinary),
    maxPayloadBytes: handler.maxPayloadBytes,
  };
}

/** The largest messaging frame: a delivery's content, or a Mac's few connections. */
const messagingMaxPayloadBytes = 4 * 1_024 * 1_024;

function messagingModuleHandler(
  messaging: PreparedMessagingModule,
  logger: RunnerLogger,
): RunnerModuleHandler {
  return {
    attach: (stream) => {
      void messaging.module.attach(stream).catch((error: unknown) => {
        logger.error("Messaging module could not open its stream", {
          reason: error instanceof Error ? error.message : String(error),
        });
      });
    },
    detach: async () => await messaging.module.detach(),
    handleFrame: async (frame, isBinary) => await messaging.module.handleFrame(frame, isBinary),
    maxPayloadBytes: messagingMaxPayloadBytes,
  };
}

interface OpenedRunnerModule {
  /** Resolves when this stream has ended, whatever ended it. */
  readonly closed: Promise<void>;
  readonly module: RunnerAuxiliaryModule;
  close(): Promise<void>;
  heartbeat(): Promise<void>;
}

export interface RunnerLogger {
  info(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}

/**
 * Everything a computer that runs agents brings to its Host connection.
 *
 * These parts travel as one value because they exist together or not at all: a
 * reach-only computer has no Runtime to hand a command to, no Workspace storage
 * to advertise, and no browser of its own to relay (`docs/computers.md` §2).
 */
export interface RunnerAgentsConnection {
  readonly earlierBootsContained?: boolean;
  /**
   * Present when this computer also relays a browser. The Personal Desktop
   * stack puts the relay in the Runner process precisely so the Runner key
   * never has to be copied anywhere else: the relay reaches its Chromium over
   * a loopback bridge and reaches the Host over this Runner's own identity.
   */
  readonly browserBridge?: {
    readonly bridgeToken: string;
    readonly runtimeId: string;
    readonly signIn: boolean;
    readonly url: URL;
  };
  /** Present exactly when this Runner holds directories of its own. */
  readonly localWorkspaces?: {
    readonly inventory: () => Promise<RunnerLocalStorageInventory>;
    readonly service: LocalWorkspaceService;
  };
  readonly runtime: RunnerRuntime;
  /** What this Runner can actually reach, which is not always what it was
   * configured to want: a missing PortableFS mount degrades to local-only. */
  readonly workspaceBackings: readonly ("local-directory" | "portablefs")[];
  readonly workspaceMounts: () => readonly RunnerWorkspaceMount[];
}

export interface ReconnectingHostConnectionOptions {
  readonly executionClock?: Pick<import("@opensteer/shared/clock").Clock, "now">;
  /** Present exactly when this Runner advertises the agents module. */
  readonly agents?: RunnerAgentsConnection;
  readonly bootId: RunnerDescriptor["bootId"];
  readonly config: RunnerConfig;
  /** The computer this Runner runs on, read once at start. */
  readonly device?: RunnerDescriptor["device"];
  /**
   * How this connection re-probes the macOS grant. Production leaves it alone
   * and the helper answers on the watch's own cadence; a test supplies its own
   * probe and intervals rather than waiting seconds for a real one.
   */
  readonly fullDiskAccessProbe?: FullDiskAccessProbeOptions;
  readonly identity: RunnerIdentity;
  readonly integrationsModule?: PreparedIntegrationsModule;
  readonly messagingModule?: PreparedMessagingModule;
  readonly identityStore: Pick<FileRunnerIdentityStore, "acceptHostConnection">;
  readonly logger: RunnerLogger;
  readonly onConnected?: (identity: {
    readonly environmentId: NonNullable<RunnerIdentity["environmentId"]>;
    readonly runnerId: RunnerIdentity["runnerId"];
  }) => Promise<void> | void;
  readonly onDisconnected?: () => Promise<void> | void;
  /** Called once, instead of reconnecting, when the Host revokes this identity. */
  readonly onRevoked?: () => Promise<void> | void;
  readonly runtimeVersion: string;
  readonly shellModule?: PreparedShellModule;
}

export class ReconnectingHostConnection {
  readonly #agents: RunnerAgentsConnection | undefined;
  readonly #bootId: RunnerDescriptor["bootId"];
  readonly #config: Omit<RunnerConfig, "enrollmentToken">;
  readonly #device: RunnerDescriptor["device"];
  readonly #fullDiskAccessProbe: FullDiskAccessProbeOptions;
  readonly #identityStore: ReconnectingHostConnectionOptions["identityStore"];
  readonly #computerUse: PreparedIntegrationsModule["computerUse"];
  readonly #integrationsDescriptor: PreparedIntegrationsModule["descriptor"] | undefined;
  /**
   * Provider work belongs to the Runner process, not one Host connection.
   * Keeping this handler across reconnects preserves its concurrency accounting
   * until provider promises actually settle, including providers that ignore an
   * abort when their old stream is detached.
   */
  readonly #integrationsHandler: RunnerModuleHandler | undefined;
  readonly #messagingDescriptor: PreparedMessagingModule["descriptor"] | undefined;
  readonly #messagingHandler: RunnerModuleHandler | undefined;
  readonly #logger: RunnerLogger;
  readonly #onConnected: ReconnectingHostConnectionOptions["onConnected"];
  readonly #onDisconnected: ReconnectingHostConnectionOptions["onDisconnected"];
  readonly #onRevoked: ReconnectingHostConnectionOptions["onRevoked"];
  readonly #runtimeVersion: string;
  readonly #shellModule: ReconnectingHostConnectionOptions["shellModule"];
  /**
   * The fence the Host handed this connection. Every frame repeats it, so the
   * Runner keeps exactly one copy rather than reconstructing it per message.
   */
  readonly #fence: RunnerConnectionFenceLedger;
  /** Modules already reported as unheartbeatable, so the timer says it once. */
  readonly #silencedModules = new WeakSet<OpenedRunnerModule>();
  /** Module tickets this connection has asked for and not yet been handed. */
  readonly #ticketWaiters = new Map<
    string,
    {
      readonly module: RunnerAuxiliaryModule;
      readonly reject: (error: Error) => void;
      readonly resolve: (ticket: string) => void;
    }
  >();
  /** Credential refreshes this connection has asked for and not yet been answered. */
  readonly #credentialWaiters = new Map<
    string,
    (credentials: RefreshedRunCredentials | undefined) => void
  >();
  #enrollmentCredential: RunnerEnrollmentCredential | undefined;
  /**
   * The macOS grant as this Runner last probed it, which the prepared module
   * only supplies the boot-time value of. It lives here so a reconnect states
   * what is true now instead of restating what was true when the process
   * started — a person turns that switch while the Runner is connected.
   */
  #fullDiskAccess: boolean | undefined;
  #identity: RunnerIdentity;
  /** Set after the Host rejects this Runner's persisted key; see `#proof`. */
  #reenroll = false;
  #socket: WebSocket | undefined;

  constructor(options: ReconnectingHostConnectionOptions) {
    this.#fence = new RunnerConnectionFenceLedger(
      options.executionClock ? { now: options.executionClock.now } : {},
    );
    this.#agents = options.agents;
    this.#bootId = options.bootId;
    const { enrollmentToken, ...config } = options.config;
    this.#config = config;
    this.#device = options.device;
    this.#enrollmentCredential = runnerEnrollmentCredential(enrollmentToken);
    this.#fullDiskAccess = options.shellModule?.descriptor.fullDiskAccess;
    this.#fullDiskAccessProbe = options.fullDiskAccessProbe ?? {};
    this.#identity = options.identity;
    this.#identityStore = options.identityStore;
    this.#logger = options.logger;
    this.#integrationsDescriptor = options.integrationsModule?.descriptor;
    this.#computerUse = options.integrationsModule?.computerUse;
    this.#integrationsHandler = options.integrationsModule
      ? computerAppModuleHandler(options.integrationsModule, this.#logger, this.#config)
      : undefined;
    this.#messagingDescriptor = options.messagingModule?.descriptor;
    this.#messagingHandler = options.messagingModule
      ? messagingModuleHandler(options.messagingModule, this.#logger)
      : undefined;
    this.#onConnected = options.onConnected;
    this.#onDisconnected = options.onDisconnected;
    this.#onRevoked = options.onRevoked;
    this.#runtimeVersion = options.runtimeVersion;
    this.#shellModule = options.shellModule;
    if (!options.agents && !options.shellModule && !options.integrationsModule) {
      throw new Error("A Runner that runs no agents must offer shell or integrations");
    }
    if (this.#config.maxConcurrentRuns > 1_000) {
      throw new Error("OPENSTEER_MAX_CONCURRENT_RUNS cannot exceed 1000");
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    let reportedUnenrollable = false;
    while (!signal.aborted) {
      try {
        await this.#connectOnce(signal);
        failures = 0;
        reportedUnenrollable = false;
      } catch (error) {
        if (signal.aborted) break;
        // Removal is the one refusal that retrying can never fix: this identity
        // is gone from the Deployment, and reconnecting would only ask a Host
        // that has already answered. Stop, and say so once.
        if (error instanceof RunnerIdentityRevokedError) {
          this.#logger.error(
            "This computer was removed from its Deployment; the Runner is stopping",
            {
              runnerId: this.#identity.runnerId,
            },
          );
          await this.#onRevoked?.();
          return;
        }
        failures += 1;
        // Without a credential no amount of retrying can succeed, so say once
        // what would fix it rather than repeating the same failure every few
        // seconds until someone reads the whole scrollback.
        if (this.#unenrollable()) {
          if (!reportedUnenrollable) {
            reportedUnenrollable = true;
            this.#logger.error(
              this.#identity.lastConnectionGeneration > 0
                ? "This Host does not recognize this Runner's saved identity. Supply a new enrollment token, or remove the Runner data directory to enroll as a new Runner."
                : "This Runner is not enrolled. Supply an enrollment token before it can connect.",
              { dataDirectory: this.#config.dataDirectory, runnerId: this.#identity.runnerId },
            );
          }
        } else {
          this.#logger.error("Runner connection closed", {
            attempt: failures,
            error: safeErrorMessage(error),
          });
        }
      }
      if (signal.aborted) break;
      const ceiling = this.#unenrollable()
        ? unenrollableReconnectDelayMs
        : Math.min(
            (this.#agents?.runtime.attachInventory().length ?? 0) > 0
              ? reconnectDelayHoldingRunsMs
              : maximumReconnectDelayMs,
            500 * 2 ** Math.min(failures, 6),
          );
      await waitForRunnerReconnect(Math.floor(Math.random() * ceiling), signal);
    }
  }

  /** True when no credential is held and the persisted identity cannot be used. */
  #unenrollable(): boolean {
    if (this.#enrollmentCredential) return false;
    return this.#identity.lastConnectionGeneration === 0 || this.#reenroll;
  }

  close(): void {
    const socket = this.#socket;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1001, "Runner shutting down");
  }

  async #connectOnce(signal: AbortSignal): Promise<void> {
    const transport = await runnerWebSocketTransport(
      {
        ...(this.#config.controlCaPath ? { controlCaPath: this.#config.controlCaPath } : {}),
        hostOrigin: this.#config.hostUrl,
        mode: this.#config.mode,
      },
      "/internal/v1/runners",
    );
    const socket = new WebSocket(transport.url, {
      ...(transport.ca ? { ca: transport.ca } : {}),
      followRedirects: false,
      handshakeTimeout: handshakeTimeoutMs,
      maxPayload: maximumFrameBytes,
      perMessageDeflate: false,
      rejectUnauthorized: true,
    });
    const absorbSocketError = (): void => undefined;
    socket.on("error", absorbSocketError);
    this.#socket = socket;
    const abort = () => socket.close(1001, "Runner stopping");
    signal.addEventListener("abort", abort, { once: true });

    const inbox = new BoundedRunnerInbox<InboundFrame>({
      maxBytes: maximumQueuedInboundBytes,
      maxItems: maximumQueuedInboundItems,
    });
    const onMessage = (data: RawData, isBinary: boolean): void => {
      try {
        const buffer = rawDataToBuffer(data);
        if (buffer.byteLength > maximumFrameBytes)
          throw new Error("Host frame exceeded size limit");
        inbox.push({ bytes: buffer.byteLength, value: { buffer, isBinary } });
      } catch (error) {
        inbox.close(error);
        socket.close(1009, "Runner input queue exceeded");
      }
    };
    const connectionLifetime = new AbortController();
    let closeCode: number | undefined;
    let socketClosed!: () => void;
    const closed = new Promise<void>((resolvePromise) => {
      socketClosed = resolvePromise;
    });
    const onClose = (code: number, reason: Buffer): void => {
      const detail = reason.toString("utf8").slice(0, 500);
      closeCode = code;
      socketClosed();
      const error = new Error(`Host connection closed (${code})${detail ? `: ${detail}` : ""}`);
      connectionLifetime.abort(error);
      inbox.close(error);
    };
    const onError = (error: Error): void => {
      connectionLifetime.abort(error);
      inbox.close(error);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);

    let sink: CausallyOrderedRunnerSink | undefined;
    try {
      await waitForOpen(socket, signal);
      const iterator = inbox[Symbol.asyncIterator]();
      const welcome = await this.#authenticate(socket, iterator, signal);
      sink = new CausallyOrderedRunnerSink(new WebSocketMessageSink(socket, this.#fence), (runId) =>
        this.#refreshRunCredentials(socket, runId),
      );
      const browserHandler = this.#browserModuleHandler();
      const integrationsHandler = this.#integrationsHandler;
      const messagingHandler = this.#messagingHandler;
      const shellHandler = this.#shellModuleHandler();
      const handlers = [
        ...(browserHandler ? [{ handler: browserHandler, module: "browser" as const }] : []),
        ...(integrationsHandler
          ? [{ handler: integrationsHandler, module: "integrations" as const }]
          : []),
        ...(messagingHandler ? [{ handler: messagingHandler, module: "messaging" as const }] : []),
        ...(shellHandler ? [{ handler: shellHandler, module: "shell" as const }] : []),
      ];
      const disallowed = handlers.find(({ module }) => !welcome.allowedModules.includes(module));
      if (disallowed) {
        throw new Error(`This Runner's enrollment does not allow the ${disallowed.module} module`);
      }
      await this.#serve(
        socket,
        sink,
        iterator,
        welcome,
        handlers,
        AbortSignal.any([signal, connectionLifetime.signal]),
      );
    } catch (error) {
      // Only the close code says whether this identity was revoked, and the
      // Host may refuse either way round: a `host.error` frame and then the
      // close, or the close alone. A refusal therefore waits for that code
      // instead of deciding on whichever frame arrived first.
      if (error instanceof HostRefusedError && closeCode === undefined) {
        await withTimeout(closed, refusalCloseWaitMs, {
          timeoutError: () => new Error("Host refused without closing the connection"),
        }).catch(() => {
          if (socket.readyState < WebSocket.CLOSING) {
            socket.close(1002, "Host refused without closing the connection");
          }
        });
      }
      if (socket.readyState < WebSocket.CLOSING) socket.close(1008, "Runner connection failed");
      throw closeCode === revokedIdentityCloseCode ? new RunnerIdentityRevokedError() : error;
    } finally {
      connectionLifetime.abort(new Error("Host connection stopped"));
      signal.removeEventListener("abort", abort);
      inbox.close();
      sink?.close();
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      // Cancelling an HTTP Upgrade emits its error and close on the next tick.
      // Keep the listeners until then, and finish owning the socket before returning.
      await closed;
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
      socket.off("error", absorbSocketError);
      if (this.#socket === socket) this.#socket = undefined;
      if (sink) {
        await this.#onDisconnected?.();
        await this.#agents?.runtime.connectionLost(sink);
      }
    }
    // A Host that revokes a connected Runner closes the socket under it, which
    // ends the serving loop without an error of its own.
    if (closeCode === revokedIdentityCloseCode) throw new RunnerIdentityRevokedError();
  }

  async #authenticate(
    socket: WebSocket,
    iterator: AsyncIterator<InboundFrame>,
    signal: AbortSignal,
  ): Promise<Extract<HostToRunnerMessage, { readonly type: "host.welcome" }>> {
    const first = await nextHostMessage(iterator, signal, "Host did not issue a Runner challenge");
    if (first.type !== "host.challenge") {
      throw new Error("Host did not start the Runner authentication handshake");
    }
    if (Date.parse(first.expiresAt) <= Date.now()) {
      throw new Error("Host Runner challenge is expired");
    }
    const descriptor = await this.#descriptor();
    const proof = this.#proof(first, descriptor);
    await sendWireMessage(socket, proof);

    const response = await nextHostMessage(
      iterator,
      signal,
      "Host did not acknowledge the Runner identity proof",
    );
    if (response.type === "host.error") {
      // The Host deliberately does not say whether the identity is unknown or
      // the signature is wrong, because that would let an unauthenticated peer
      // enumerate enrolled Runners. It does not need to: this Runner knows
      // whether it is holding a credential that would let it start over.
      if (proof.type === "runner.authenticate" && this.#enrollmentCredential && !this.#reenroll) {
        this.#reenroll = true;
        this.#logger.info("Host rejected the persisted Runner identity; re-enrolling", {
          runnerId: this.#identity.runnerId,
        });
      }
      throw new HostRefusedError(`Host rejected Runner authentication: ${response.error.message}`);
    }
    if (response.type !== "host.welcome") {
      throw new Error("Host sent an invalid Runner authentication response");
    }
    if (
      response.bootId !== descriptor.bootId ||
      response.runnerId !== descriptor.runnerId ||
      !sameStringSet(response.environmentIds, runnerEnvironmentIds(descriptor))
    ) {
      throw new Error("Host Runner acknowledgement does not match the authenticated identity");
    }
    if (
      proof.type === "runner.authenticate" &&
      this.#enrollmentCredential &&
      !this.#reenroll &&
      response.connectionGeneration <= this.#identity.lastConnectionGeneration
    ) {
      this.#reenroll = true;
      this.#logger.info("Host accepted a reset Runner identity; completing re-enrollment", {
        runnerId: this.#identity.runnerId,
      });
      throw new Error("Host Runner connection generation restarted; re-enrollment is required");
    }
    this.#fence.adopt(
      {
        bootId: response.bootId,
        connectionGeneration: response.connectionGeneration,
        connectionId: response.connectionId,
        connectionLeaseId: response.connectionLeaseId,
        runnerId: response.runnerId,
      },
      response.connectionLeaseExpiresAt,
    );
    this.#identity = await this.#identityStore.acceptHostConnection({
      connectionGeneration: response.connectionGeneration,
      environmentIds: response.environmentIds,
      reenrolled: proof.type === "runner.enroll",
      runnerId: response.runnerId,
    });
    this.#enrollmentCredential = undefined;
    this.#reenroll = false;
    this.#logger.info("Runner connected to Host", {
      connectionGeneration: response.connectionGeneration,
      environmentId: this.#identity.environmentId,
      runnerId: this.#identity.runnerId,
    });
    // A supervisor watches this to learn the Runner is up. A reach-only
    // computer that never held a work location has nothing to name here, so it
    // reports nothing rather than inventing an environment.
    const environmentId = this.#identity.environmentId;
    if (environmentId) {
      await this.#onConnected?.({ environmentId, runnerId: this.#identity.runnerId });
    }
    // Only a module that is actually running is reported ready. A reach-only
    // computer says nothing here; its shell module reports itself once its own
    // stream is open.
    if (this.#agents) {
      await sendWireMessage(socket, {
        ...this.#fence.fence,
        modules: [moduleReadiness("agents", "ready")],
        type: "runner.modules.report",
      });
    }
    return response;
  }

  /** Exactly the modules this process runs, and nothing it merely could run. */
  async #descriptor(): Promise<RunnerDescriptor> {
    const agents = this.#agents;
    await this.#computerUse?.permissions().catch(() => undefined);
    const browserCapabilities = agents?.browserBridge
      ? await new LocalBrowserRuntimeBridge(agents.browserBridge).capabilities()
      : {};
    return {
      bootId: this.#bootId,
      capabilities: [
        ...runnerCapabilities(),
        ...(agents?.runtime.harnessDrivers().some((driver) => driver.driverKind === "codex")
          ? ["voice-v1" as const, "voice-agent-v1" as const]
          : []),
        ...(agents?.earlierBootsContained ? ["earlier-boots-contained-v1" as const] : []),
      ],
      ...(this.#device ? { device: this.#device } : {}),
      modules: {
        ...(agents ? { agents: await this.#agentsModule(agents) } : {}),
        ...(agents?.browserBridge
          ? {
              browser: {
                runtimeId: agents.browserBridge.runtimeId,
                ...browserCapabilities,
                profileSnapshotVersion: browserProfileSnapshotVersion,
                // The loopback browser runtime ships in the same release as
                // this Runner, so it parses every frame this Runner relays.
                stateImport: true,
                fileStaging: true,
                passkeys: 1,
                cdpBoundary: 1,
                sharedControl: 1,
                targetControl: 1,
                navigationVersion: 1,
                navigationAttributionVersion: 1,
                workspaceTabRestoreVersion: 1,
                captureRegion: 1,
                rasterDemand: 1,
                editing: 2,
                clipboard: false,
                ...(agents.browserBridge.signIn ? { signIn: { version: 3 } } : {}),
              },
            }
          : {}),
        ...(this.#integrationsDescriptor ? { integrations: this.#integrationsDescriptor } : {}),
        ...(this.#messagingDescriptor ? { messaging: this.#messagingDescriptor } : {}),
        ...(this.#shellModule ? { shell: this.#shellDescriptor(this.#shellModule) } : {}),
      },
      name: this.#config.name,
      runnerId: this.#identity.runnerId,
      runnerKind: this.#config.runnerKind,
      runtimeVersion: this.#runtimeVersion,
    };
  }

  async #agentsModule(agents: RunnerAgentsConnection): Promise<RunnerAgentsModule> {
    const environmentId = this.#identity.environmentId;
    if (!environmentId) {
      throw new Error("This Runner executes agents and needs a work location");
    }
    return {
      environmentIds: [environmentId],
      harnessDrivers: [...agents.runtime.harnessDrivers()],
      localStorage: (await agents.localWorkspaces?.inventory()) ?? null,
      loginFill: 1,
      computerTool: 1,
      maxConcurrentRuns: this.#config.maxConcurrentRuns,
      providerStateModes: [...agents.runtime.providerStateModes()],
      workspaceBackings: [...agents.workspaceBackings],
      workspaceMounts: [...agents.workspaceMounts()],
    };
  }

  /** The prepared module, with the grant this connection last probed. */
  #shellDescriptor(shell: PreparedShellModule): PreparedShellModule["descriptor"] {
    const fullDiskAccess = this.#fullDiskAccess;
    return {
      ...shell.descriptor,
      ...(fullDiskAccess === undefined ? {} : { fullDiskAccess }),
    };
  }

  /**
   * Keeps the Host's copy of the macOS grant current for one connection.
   *
   * macOS raises no event when a person turns the switch, and the descriptor is
   * signed once at connect, so the alternative to re-probing here would be
   * dropping a healthy connection to restate a boolean. The fenced connection
   * carries the new answer instead: it grants nothing on the Host, and the host
   * key beside it stays where only a signed hello can state it.
   */
  #watchFullDiskAccess(socket: WebSocket, signal: AbortSignal): FullDiskAccessWatch | undefined {
    const shell = this.#shellModule;
    const initial = this.#fullDiskAccess;
    if (!shell || shell.descriptor.platform !== "darwin" || initial === undefined) return undefined;
    return watchFullDiskAccess({
      ...this.#fullDiskAccessProbe,
      helperBinary: shell.helperBinary,
      initial,
      onChange: async (fullDiskAccess) => {
        await sendWireMessage(socket, {
          ...this.#fence.fence,
          fullDiskAccess,
          type: "runner.shell.full-disk-access",
        });
        this.#fullDiskAccess = fullDiskAccess;
      },
      onError: (error) =>
        this.#logger.error("This computer's macOS Full Disk Access probe failed", {
          reason: safeErrorMessage(error),
        }),
      signal,
    });
  }

  #proof(challenge: RunnerChallenge, descriptor: RunnerDescriptor) {
    return runnerIdentityProof({
      challenge,
      credential: this.#enrollmentCredential,
      descriptor,
      enrolled: this.#identity.lastConnectionGeneration > 0 && !this.#reenroll,
      privateKey: this.#identity.privateKey,
      publicKeyPem: this.#identity.publicKeyPem,
    });
  }

  /**
   * Opens one auxiliary module's stream beside this connection.
   *
   * The ticket is asked for here, on the authenticated primary connection, and
   * the module proves the Runner key over the new socket's own challenge. A
   * module can therefore reach the Host without ever holding a credential of
   * its own, and its stream dies when this connection does. Everything that
   * differs between modules is in the handler the caller supplies.
   */
  async #openModule(
    module: RunnerAuxiliaryModule,
    handler: RunnerModuleHandler,
    socket: WebSocket,
    signal: AbortSignal,
  ): Promise<OpenedRunnerModule> {
    const ticket = await this.#requestModuleTicket(module, socket, signal);
    const opened = await openRunnerAuxiliaryStream({
      bootId: this.#bootId,
      ...(this.#config.controlCaPath ? { controlCaPath: this.#config.controlCaPath } : {}),
      hostOrigin: this.#config.hostUrl,
      maxPayloadBytes: handler.maxPayloadBytes,
      module,
      mode: this.#config.mode,
      onFrame: (frame, isBinary) => handler.handleFrame(frame, isBinary),
      onInvalidated: () => handler.detach(),
      privateKey: this.#identity.privateKey,
      runnerId: this.#identity.runnerId,
      signal,
      ticket,
    });
    try {
      await handler.attach(opened.stream);
      await sendWireMessage(socket, {
        ...this.#fence.fence,
        modules: [moduleReadiness(module, "ready")],
        type: "runner.modules.report",
      });
    } catch (error) {
      // A stream the Host does not know this Runner is using is worse than no
      // stream: hand it back before the supervisor tries again.
      opened.close(1011, "module readiness failed");
      await handler.detach();
      throw error;
    }
    return {
      close: async () => {
        opened.close();
        await handler.detach();
      },
      closed: opened.closed,
      heartbeat: () => opened.heartbeat(),
      module,
    };
  }

  /**
   * Asks this primary connection for one module ticket.
   *
   * The answer arrives on the primary connection like everything else, so it is
   * routed by the serving dispatcher rather than read off the inbox here. That
   * is what lets a module stream be reopened while the connection keeps
   * serving: there is only ever one reader of the connection.
   */
  async #requestModuleTicket(
    module: RunnerAuxiliaryModule,
    socket: WebSocket,
    signal: AbortSignal,
  ): Promise<string> {
    const requestId = RunnerAuxiliaryRequestIdSchema.parse(`aux:${randomUUID()}`);
    const issued = new Promise<string>((resolve, reject) => {
      this.#ticketWaiters.set(requestId, { module, reject, resolve });
    });
    try {
      await sendWireMessage(socket, {
        ...this.#fence.fence,
        module,
        requestId,
        type: "runner.auxiliary.ticket-request",
      });
      return await withTimeout(issued, handshakeTimeoutMs, {
        abortFallback: "Runner connection closed",
        signal,
        timeoutError: () => new Error(`Host did not issue a ${module} module ticket`),
      });
    } finally {
      this.#ticketWaiters.delete(requestId);
    }
  }

  /**
   * Asks the Host for a Run's fresh capability tokens. Undefined means no
   * answer came, so the Run keeps its current tokens and asks again later.
   */
  async #refreshRunCredentials(
    socket: WebSocket,
    runId: RunId,
  ): Promise<RefreshedRunCredentials | undefined> {
    const requestId = RunnerAuxiliaryRequestIdSchema.parse(`grant:${randomUUID()}`);
    const answered = new Promise<RefreshedRunCredentials | undefined>((resolve) => {
      this.#credentialWaiters.set(requestId, resolve);
    });
    try {
      await sendWireMessage(socket, {
        ...this.#fence.fence,
        requestId,
        runId,
        type: "runner.grants.refresh",
      });
      return await withTimeout(answered, handshakeTimeoutMs, {
        abortFallback: "Runner connection closed",
        signal: AbortSignal.timeout(handshakeTimeoutMs * 2),
        timeoutError: () => new Error("Host did not answer a credential refresh"),
      }).catch(() => undefined);
    } finally {
      this.#credentialWaiters.delete(requestId);
    }
  }

  /** Hands a ticket to the module waiting for it, or refuses an unasked one. */
  #acceptModuleTicket(
    message: Extract<HostToRunnerMessage, { readonly type: "host.auxiliary.ticket" }>,
  ): void {
    const waiter = this.#ticketWaiters.get(message.requestId);
    if (!waiter) throw new Error("Host sent an unsolicited auxiliary ticket");
    this.#ticketWaiters.delete(message.requestId);
    if (message.module !== waiter.module) {
      waiter.reject(new Error(`Host answered a different ${waiter.module} module ticket request`));
      return;
    }
    waiter.resolve(message.ticket);
  }

  /** Waits for this stream to end, or for the connection that owns it to. */
  async #awaitStreamEnd(opened: OpenedRunnerModule, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        opened.closed,
        new Promise<void>((resolve) => {
          onAbort = () => resolve();
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Keeps one module's stream open for as long as this connection lasts.
   *
   * A module stream ends on its own terms — its lease runs out, the Host
   * supersedes it, the helper it reaches restarts — while the connection that
   * authorized it is still healthy, and reopening it is simply another ticket
   * on that same connection. So a module stream's lifetime inside a connection
   * is owned here and nowhere else: open, wait for the stream to end, open
   * again, until the connection itself ends. Every ended stream backs the next
   * attempt off, so a module that cannot stay up cannot spin either.
   */
  async #superviseModule(
    module: RunnerAuxiliaryModule,
    handler: RunnerModuleHandler,
    socket: WebSocket,
    open: Map<RunnerAuxiliaryModule, OpenedRunnerModule>,
    signal: AbortSignal,
  ): Promise<void> {
    for (let attempts = 0; !signal.aborted; attempts += 1) {
      try {
        const opened = await this.#openModule(module, handler, socket, signal);
        open.set(module, opened);
        try {
          await this.#awaitStreamEnd(opened, signal);
        } finally {
          if (open.get(module) === opened) open.delete(module);
          // This loop opened the stream, so this loop closes it. Nothing else
          // holds it, and the connection's teardown only has to say stop.
          await opened.close();
        }
        if (!signal.aborted) {
          this.#logger.info("Runner module stream closed; reopening", { module });
        }
      } catch (error) {
        if (signal.aborted) return;
        this.#logger.error("Runner module stream could not be opened", {
          attempt: attempts + 1,
          module,
          reason: safeErrorMessage(error),
        });
      }
      if (signal.aborted) return;
      await waitForRunnerReconnect(
        Math.min(maximumReconnectDelayMs, 500 * 2 ** Math.min(attempts, 6)),
        signal,
      );
    }
  }

  /** Present only on a computer that also relays a browser. */
  #browserModuleHandler(): RunnerModuleHandler | undefined {
    const bridge = this.#agents?.browserBridge;
    if (!bridge) return undefined;
    const relay = new BrowserModuleRelay(
      new LocalBrowserRuntimeBridge({
        bridgeToken: bridge.bridgeToken,
        runtimeId: bridge.runtimeId,
        url: bridge.url,
      }),
    );
    return {
      attach: (stream) => relay.attach(stream),
      detach: () => relay.detach(),
      handleFrame: (frame, isBinary) => relay.handleFrame(frame, isBinary),
      maxPayloadBytes: maxBrowserRelayEnvelopeBytes,
    };
  }

  #shellModuleHandler(): RunnerModuleHandler | undefined {
    const shell = this.#shellModule;
    if (!shell) return undefined;
    const handler = new ShellModuleHandler({
      helperBinary: shell.helperBinary,
      hostKeyPath: shell.hostKeyPath,
      logger: this.#logger,
      transport: this.#config,
    });
    return {
      attach: (stream) => handler.attach(stream),
      detach: () => handler.detach(),
      handleFrame: (frame, isBinary) => handler.handleFrame(frame, isBinary),
      maxPayloadBytes: handler.maxPayloadBytes,
    };
  }

  /**
   * One module's heartbeat, held away from the timer that drives it.
   *
   * A module can fail before it ever returns a promise — a stream whose lease
   * has run out stamps no fence — and the heartbeat runs on a timer, where a
   * synchronous throw has no caller and ends the process. Calling it from here
   * makes every failure a rejection, and a helper module that lost its stream
   * stays a helper module that lost its stream rather than a dead Runner. It
   * is said once per module: the stream does not come back inside this
   * connection, and repeating it every interval would bury everything else.
   */
  async #moduleHeartbeat(module: OpenedRunnerModule): Promise<void> {
    try {
      await module.heartbeat();
    } catch (error) {
      if (this.#silencedModules.has(module)) return;
      this.#silencedModules.add(module);
      this.#logger.error("Runner module stream heartbeat failed", {
        module: module.module,
        reason: safeErrorMessage(error),
      });
    }
  }

  async #serve(
    socket: WebSocket,
    sink: CausallyOrderedRunnerSink,
    iterator: AsyncIterator<InboundFrame>,
    welcome: Extract<HostToRunnerMessage, { readonly type: "host.welcome" }>,
    handlers: readonly {
      readonly handler: RunnerModuleHandler;
      readonly module: RunnerAuxiliaryModule;
    }[],
    signal: AbortSignal,
  ): Promise<void> {
    const agents = this.#agents;
    const work: RunnerWorkSession = agents
      ? new AgentsWorkSession({
          agents,
          environmentId: () => requiredEnvironmentId(this.#identity),
          fail: (reason) => socket.close(1011, reason),
          fence: this.#fence,
          heartbeatNow: () => sendHeartbeat(),
          signal,
          sink,
        })
      : reachOnlyWorkSession(sink);
    // Module streams are opened from inside the serving loop, because the
    // ticket each one needs is answered on this connection: the loop below is
    // the only reader of it, so it is the only place that can hand a ticket
    // over. Their own lifetime ends with this connection, never before it.
    const modules = new Map<RunnerAuxiliaryModule, OpenedRunnerModule>();
    const moduleLifetime = new AbortController();
    const moduleSignal = AbortSignal.any([signal, moduleLifetime.signal]);
    const supervision = handlers.map(({ handler, module }) =>
      this.#superviseModule(module, handler, socket, modules, moduleSignal),
    );
    const fullDiskAccess = this.#watchFullDiskAccess(socket, moduleSignal);
    const sendHeartbeat = (): void => {
      // The frame is built inside the promise: reading what this Runner is
      // busy with and stamping the fence are part of the send, so a failure in
      // either is a rejected send rather than a throw the timer cannot catch.
      void Promise.resolve()
        .then(() =>
          sink.send({
            ...work.activity(),
            sentAt: this.#fence.heartbeatTimestamp(),
            type: "runner.heartbeat",
          }),
        )
        .catch(() => socket.close(1011, "Heartbeat failed"));
    };
    const heartbeat = setInterval(() => {
      sendHeartbeat();
      for (const module of modules.values()) void this.#moduleHeartbeat(module);
    }, welcome.heartbeatIntervalMs);
    heartbeat.unref();
    const dispatcher = new FencedInboundDispatcher({
      accepts: (fence: RunnerConnectionFence) => this.#fence.accepts(fence),
      fence: hostMessageFence,
      handle: async (message: PostAuthenticationHostMessage) => {
        switch (message.type) {
          case "host.welcome":
            throw new Error("Host repeated the Runner authentication handshake");
          case "host.connection.lease-renewed":
            this.#fence.renew(message.connectionLeaseExpiresAt);
            break;
          case "host.auxiliary.ticket":
            this.#acceptModuleTicket(message);
            break;
          case "host.grants.credentials":
            // An answer that arrives after its request gave up changes nothing.
            this.#credentialWaiters.get(message.requestId)?.(
              message.result.status === "issued"
                ? message.result.credentials
                : message.result.status === "refused"
                  ? null
                  : undefined,
            );
            this.#credentialWaiters.delete(message.requestId);
            break;
          default:
            await work.handle(message);
        }
      },
    });
    try {
      // Before anything else on this connection, the Host learns every Run this
      // Runner holds and answers which of them continue here.
      await sink.send({
        complete: true,
        executions: work.attachInventory(),
        type: "runner.executions.attach",
      });
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        const message = parseHostFrame(next.value);
        if (message.type === "host.challenge") {
          throw new Error("Host repeated the Runner authentication handshake");
        }
        if (message.type === "host.error") {
          throw new Error(`Host protocol error: ${message.error.message}`);
        }
        await dispatcher.dispatch(message);
      }
    } finally {
      await dispatcher.abortAndDrain(new Error("Runner connection closed"));
      clearInterval(heartbeat);
      fullDiskAccess?.stop();
      moduleLifetime.abort(new Error("Runner connection closed"));
      for (const waiter of this.#ticketWaiters.values()) {
        waiter.reject(new Error("Runner connection closed"));
      }
      this.#ticketWaiters.clear();
      this.#credentialWaiters.clear();
      await Promise.allSettled(supervision);
      await work.close();
    }
  }
}

/** What the heartbeat says this Runner is busy with. */
type RunnerHeartbeatActivity = Pick<
  Extract<RunnerOperationalReport, { readonly type: "runner.heartbeat" }>,
  "activeRunIds" | "activeTriggerOccurrenceIds" | "activeWatchActivationIds"
>;

/** The Host messages that address work rather than the connection itself. */
type RunnerWorkMessage = Exclude<
  PostAuthenticationHostMessage,
  { readonly type: "host.welcome" | "host.connection.lease-renewed" | "host.auxiliary.ticket" }
>;

type HarnessCatalogRequest = Extract<
  RunnerWorkMessage,
  { readonly type: "host.reconcile-harnesses" | "host.inspect-harnesses" }
>;

/**
 * What a connection does with the Host messages that address work.
 *
 * A computer that runs agents routes them into its Runtime. A reach-only
 * computer has none, and answers each message as refused rather than throwing:
 * throwing would drop the connection and with it the shell sessions this Runner
 * exists to carry, and the Host would send the same message again on reconnect.
 */
interface RunnerWorkSession {
  activity(): RunnerHeartbeatActivity;
  /** Every Run this Runner holds, announced before any other work on a connection. */
  attachInventory(): Extract<
    RunnerOperationalReport,
    { readonly type: "runner.executions.attach" }
  >["executions"];
  handle(message: RunnerWorkMessage): Promise<void>;
  /** Stops accepting work and waits for whatever is already in flight. */
  close(): Promise<void>;
}

interface AgentsWorkSessionOptions {
  readonly agents: RunnerAgentsConnection;
  readonly environmentId: () => EnvironmentId;
  readonly fail: (reason: string) => void;
  readonly fence: RunnerConnectionFenceLedger;
  /** Sends a heartbeat now rather than at the next interval. */
  readonly heartbeatNow: () => void;
  readonly signal: AbortSignal;
  readonly sink: CausallyOrderedRunnerSink;
}

/** One connection's worth of agent work: harness catalogs, commands, storage. */
class AgentsWorkSession implements RunnerWorkSession {
  readonly #options: AgentsWorkSessionOptions;
  readonly #lifetime = new AbortController();
  readonly #signal: AbortSignal;
  readonly #catalogAttempts = new Map<string, Promise<readonly HarnessInstanceCatalog[]>>();
  readonly #catalogResponses = new Set<Promise<void>>();
  readonly #authenticationResponses = new Set<Promise<void>>();
  readonly #modelServerResponses = new Set<Promise<void>>();
  readonly #invalidatedHarnesses = new Set<HarnessInstanceId>();
  readonly #unsubscribePreparation: () => void;
  /**
   * Commands and reconciles, one after another in the order the Host sent
   * them: a Run is admitted against the profile set it follows, and a
   * reconcile never overtakes a command sent before it. Either can take a
   * while — replacing a profile waits for its engine to stop, a steer for its
   * message to land — so nothing else waits behind them: sign-ins,
   * inspections, discovery and storage reads go on, and so does the reading
   * of the connection itself.
   */
  readonly #voiceResponses = new Set<Promise<void>>();
  #ordered: Promise<void> = Promise.resolve();
  #orderedPending = 0;

  constructor(options: AgentsWorkSessionOptions) {
    this.#options = options;
    this.#signal = AbortSignal.any([options.signal, this.#lifetime.signal]);
    this.#unsubscribePreparation = options.agents.runtime.subscribeHarnessPreparation(
      (harnessInstanceId) => {
        this.#invalidatedHarnesses.add(harnessInstanceId);
        this.#flushPreparationNotifications();
      },
    );
  }

  activity(): RunnerHeartbeatActivity {
    const runtime = this.#options.agents.runtime;
    return {
      activeRunIds: [...runtime.activeRunIds()],
      activeTriggerOccurrenceIds: [...runtime.activeTriggerOccurrenceIds()],
      activeWatchActivationIds: [...runtime.activeWatchActivationIds()],
    };
  }

  attachInventory(): ReturnType<RunnerWorkSession["attachInventory"]> {
    return this.#options.agents.runtime.attachInventory();
  }

  async handle(message: RunnerWorkMessage): Promise<void> {
    switch (message.type) {
      case "host.reconcile-harnesses":
      case "host.inspect-harnesses":
        this.#answerCatalogRequest(message);
        return;
      case "host.harness-authentication":
        this.#answerAuthenticationRequest(message);
        return;
      case "host.voice":
        this.#answerVoiceRequest(message);
        return;
      case "host.discover-model-servers":
        this.#answerModelServerRequest(message);
        return;
      case "host.command": {
        const command = message.command;
        void this.#inOrder(async () => {
          await this.#options.sink.applyCommand(command, () =>
            this.#options.agents.runtime.handleCommand(command, this.#options.sink),
          );
          // Admission alone cannot start execution: this heartbeat requests
          // the first lease grant measured from a moment the Runner chose.
          if (command.type === "run.execute") this.#options.heartbeatNow();
        }).catch((error: unknown) =>
          this.#options.fail(`Runner command failed: ${safeErrorMessage(error)}`.slice(0, 120)),
        );
        return;
      }
      // Before any command on this connection: the Host dispatches nothing
      // here until it has answered which Runs continue.
      case "host.executions.attached": {
        void this.#inOrder(() =>
          this.#options.agents.runtime.attach(message, this.#options.sink),
        ).catch((error: unknown) =>
          this.#options.fail(`Runner reattach failed: ${safeErrorMessage(error)}`.slice(0, 120)),
        );
        return;
      }
      case "host.events.acked":
        this.#options.agents.runtime.acknowledge(message.acks);
        return;
      case "host.executions.renewed":
        this.#options.agents.runtime.renewLeases(message);
        return;
      // In order with commands: a revocation names Runs the Host saw this
      // connection execute, so it must never overtake the execute it follows.
      case "host.runs.revoked": {
        const { revocations } = message;
        void this.#inOrder(async () => {
          this.#options.agents.runtime.revokeRuns(revocations);
        }).catch((error: unknown) =>
          this.#options.fail(`Runner revocation failed: ${safeErrorMessage(error)}`.slice(0, 120)),
        );
        return;
      }
      case "host.workspace.local.provision":
      case "host.workspace.local.inspect":
      case "host.workspace.local.destroy":
      case "host.workspace.local.files.list":
      case "host.workspace.local.files.read":
        // Storage answers never queue behind a Run: a Files read is a person
        // waiting on a page, and a provision is a Workspace the Host is holding
        // open.
        void this.#answerWorkspaceRequest(message).catch(() => {
          this.#options.fail("Workspace storage response failed");
        });
        return;
    }
  }

  async close(): Promise<void> {
    this.#unsubscribePreparation();
    this.#lifetime.abort(new Error("Host connection stopped"));
    await withTimeout(
      Promise.allSettled([
        this.#ordered,
        ...this.#catalogResponses,
        ...this.#authenticationResponses,
        ...this.#modelServerResponses,
        ...this.#voiceResponses,
      ]),
      connectionOperationStopWaitMs,
      { timeoutError: () => new Error("Runner connection cleanup timed out") },
    ).catch(() => undefined);
  }

  /** Runs `work` after every command and reconcile the Host sent before it. */
  #inOrder<T>(work: () => Promise<T>): Promise<T> {
    if (this.#orderedPending >= maximumQueuedInboundItems) {
      throw new Error("Runner has too many pending commands");
    }
    this.#orderedPending += 1;
    const result = this.#ordered.then(work);
    this.#ordered = result.then(
      () => undefined,
      () => undefined,
    );
    void this.#ordered.then(() => {
      this.#orderedPending -= 1;
    });
    return result;
  }

  #answerCatalogRequest(message: HarnessCatalogRequest): void {
    if (this.#catalogResponses.size >= maximumQueuedInboundItems) {
      throw new Error("Runner has too many pending harness catalog requests");
    }
    const runtime = this.#options.agents.runtime;
    const fingerprint = JSON.stringify(message.harnesses);
    const key = `${message.type}:${fingerprint}`;
    let attempt =
      this.#catalogAttempts.get(key) ??
      (message.type === "host.inspect-harnesses"
        ? this.#catalogAttempts.get(`host.reconcile-harnesses:${fingerprint}`)
        : undefined);
    if (!attempt) {
      // The Host reconciles on every connect, so an escaping failure here
      // must become per-profile error catalogs instead of a reconnect loop.
      const failed = (error: unknown) =>
        message.harnesses.map((harness) => errorCatalog(harness, error));
      if (message.type === "host.reconcile-harnesses") {
        const reconciled = this.#inOrder(() => runtime.reconcileHarnesses(message.harnesses));
        attempt = reconciled.then(
          () => runtime.inspectHarnesses(message.harnesses, this.#signal).catch(failed),
          failed,
        );
      } else {
        attempt = runtime.inspectHarnesses(message.harnesses, this.#signal).catch(failed);
      }
      this.#catalogAttempts.set(key, attempt);
      const forget = () => {
        if (this.#catalogAttempts.get(key) === attempt) this.#catalogAttempts.delete(key);
      };
      void attempt.then(forget, forget);
    }
    const response = attempt
      .then(async (catalogs) => {
        if (this.#signal.aborted) return;
        await this.#options.sink.send({
          catalogs: [...catalogs],
          requestId: message.requestId,
          type: "runner.harness-catalog",
        });
      })
      .finally(() => {
        this.#catalogResponses.delete(response);
        this.#flushPreparationNotifications();
      });
    this.#catalogResponses.add(response);
    void response.catch(() => this.#options.fail("Harness catalog response failed"));
  }

  #answerVoiceRequest(message: Extract<RunnerWorkMessage, { readonly type: "host.voice" }>): void {
    if (this.#voiceResponses.size >= maximumQueuedInboundItems)
      throw new Error("Too many voice requests");
    const response = this.#options.agents.runtime
      .voice(message.userId, message.command)
      .then(async (result) => {
        if (!this.#signal.aborted)
          await this.#options.sink.send({
            type: "runner.voice",
            requestId: message.requestId,
            result,
          });
      })
      .finally(() => this.#voiceResponses.delete(response));
    this.#voiceResponses.add(response);
    void response.catch(() => this.#options.fail("Voice response failed"));
  }

  #answerModelServerRequest(
    message: Extract<RunnerWorkMessage, { readonly type: "host.discover-model-servers" }>,
  ): void {
    if (this.#modelServerResponses.size >= maximumQueuedInboundItems) {
      throw new Error("Runner has too many pending model server requests");
    }
    const response = this.#options.agents.runtime
      .discoverModelServers(message.address, this.#signal)
      .then(
        (servers) => ({ servers: [...servers] }),
        (error: unknown) => ({
          error: safeErrorMessage(error).slice(0, 500) || "Model servers could not be read",
          servers: [],
        }),
      )
      .then(async (result) => {
        if (this.#signal.aborted) return;
        await this.#options.sink.send({
          ...result,
          requestId: message.requestId,
          type: "runner.model-servers",
        });
      })
      .finally(() => this.#modelServerResponses.delete(response));
    this.#modelServerResponses.add(response);
    void response.catch(() => this.#options.fail("Model server response failed"));
  }

  #answerAuthenticationRequest(
    message: Extract<RunnerWorkMessage, { readonly type: "host.harness-authentication" }>,
  ): void {
    if (this.#authenticationResponses.size >= maximumQueuedInboundItems) {
      throw new Error("Runner has too many pending harness authentication requests");
    }
    const target = harnessAuthenticationTarget(message.request);
    const response = this.#options.agents.runtime
      .handleHarnessAuthentication(message.request, this.#signal)
      .catch((error: unknown) => ({
        ...target,
        state: {
          detail: safeErrorMessage(error).slice(0, 500),
          status: "failed" as const,
        },
      }))
      .then(async (result) => {
        if (this.#signal.aborted) return;
        await this.#options.sink.send({
          ...result,
          requestId: message.requestId,
          type: "runner.harness-authentication",
        });
      })
      .finally(() => this.#authenticationResponses.delete(response));
    this.#authenticationResponses.add(response);
    void response.catch(() => this.#options.fail("Harness authentication response failed"));
  }

  async #answerWorkspaceRequest(request: HostWorkspaceLocalRequest): Promise<void> {
    const local = this.#options.agents.localWorkspaces;
    if (!local) {
      await this.#options.sink.send(noLocalWorkspacesReply(request));
      return;
    }
    const result = await local.service.handle(
      request,
      {
        ...this.#options.fence.fence,
        environmentId: this.#options.environmentId(),
        storageAuthorityId: (await local.inventory()).storageAuthorityId,
      },
      AbortSignal.timeout(30_000),
    );
    await this.#options.sink.send(result);
  }

  #flushPreparationNotifications(): void {
    if (this.#catalogResponses.size > 0) return;
    for (const harnessInstanceId of this.#invalidatedHarnesses) {
      this.#invalidatedHarnesses.delete(harnessInstanceId);
      void this.#options.sink
        .send({ type: "runner.harness-catalog-invalidated", harnessInstanceId })
        .catch(() => this.#options.fail("Harness preparation notification failed"));
    }
  }
}

/**
 * A reach-only computer's answer to work it never offered to do.
 *
 * The Host routes work by advertised module, so none of this should arrive.
 * Answering plainly is still what keeps a person unblocked: the Run fails now,
 * with a sentence, instead of waiting on a Runner that will never reply.
 */
function reachOnlyWorkSession(sink: CausallyOrderedRunnerSink): RunnerWorkSession {
  const notRunningAgents = "This computer does not run agents.";
  return {
    activity: () => ({
      activeRunIds: [],
      activeTriggerOccurrenceIds: [],
      activeWatchActivationIds: [],
    }),
    attachInventory: () => [],
    close: () => Promise.resolve(),
    handle: async (message) => {
      switch (message.type) {
        case "host.reconcile-harnesses":
        case "host.inspect-harnesses":
          await sink.send({
            catalogs: message.harnesses.map((harness) =>
              errorCatalog(harness, new Error(notRunningAgents)),
            ),
            requestId: message.requestId,
            type: "runner.harness-catalog",
          });
          return;
        case "host.harness-authentication":
          await sink.send({
            ...harnessAuthenticationTarget(message.request),
            requestId: message.requestId,
            state: { detail: notRunningAgents, status: "failed" },
            type: "runner.harness-authentication",
          });
          return;
        case "host.voice":
          await sink.send({
            type: "runner.voice",
            requestId: message.requestId,
            result: { ok: false, reason: "voice-runner-unsupported", message: notRunningAgents },
          });
          return;
        case "host.discover-model-servers":
          await sink.send({
            error: notRunningAgents,
            requestId: message.requestId,
            servers: [],
            type: "runner.model-servers",
          });
          return;
        case "host.command":
          await sink.send({
            commandId: message.command.commandId,
            correlationId: message.command.correlationId,
            error: { code: "forbidden", message: notRunningAgents, retryable: false },
            type: "runner.command-rejected",
          });
          return;
        case "host.workspace.local.provision":
        case "host.workspace.local.inspect":
        case "host.workspace.local.destroy":
        case "host.workspace.local.files.list":
        case "host.workspace.local.files.read":
          await sink.send(noLocalWorkspacesReply(message));
          return;
        // A computer that runs no agents holds no Runs to stop, resume or renew.
        case "host.runs.revoked":
        case "host.executions.attached":
        case "host.events.acked":
        case "host.executions.renewed":
          return;
      }
    },
  };
}

/** Which profile an authentication answer is about, whichever action asked. */
function harnessAuthenticationTarget(
  request: Extract<RunnerWorkMessage, { readonly type: "host.harness-authentication" }>["request"],
): { readonly driverKind: HarnessId; readonly harnessInstanceId: HarnessInstanceId } {
  return request.action === "start" || request.action === "logout" || request.action === "remove"
    ? { driverKind: request.harness.driverKind, harnessInstanceId: request.harness.id }
    : { driverKind: request.driverKind, harnessInstanceId: request.harnessInstanceId };
}

function noLocalWorkspacesReply(request: HostWorkspaceLocalRequest): RunnerOperationalReport {
  return {
    error: {
      code: "configuration-invalid",
      message: "This machine does not hold Workspace directories of its own.",
      retryable: false,
    },
    fence: request.fence,
    operationId: request.operationId,
    requestId: request.requestId,
    type: "runner.workspace.local.error",
  };
}

function requiredEnvironmentId(identity: RunnerIdentity) {
  const environmentId = identity.environmentId;
  if (!environmentId) throw new Error("This Runner has no work location of its own");
  return environmentId;
}

interface BufferedEffectScope {
  bytes: number;
  readonly messages: RunnerOperationalReport[];
}

/**
 * The command receipt is the durable fact that authorizes the Host to commit a
 * control effect. Provider callbacks can emit a terminal event synchronously
 * while that control is still applying, so the transport holds messages from
 * the same Run (or Trigger occurrence) until its receipt is on the wire.
 */
export class CausallyOrderedRunnerSink implements RunnerMessageSink {
  readonly #delegate: RunnerMessageSink & { abort?: (reason: string) => void; close?: () => void };
  readonly #scopes = new Map<string, BufferedEffectScope>();
  #bufferedBytes = 0;
  #closed = false;

  readonly #refresh: ((runId: RunId) => Promise<RefreshedRunCredentials | undefined>) | undefined;

  constructor(
    delegate: RunnerMessageSink & { abort?: (reason: string) => void; close?: () => void },
    refresh?: (runId: RunId) => Promise<RefreshedRunCredentials | undefined>,
  ) {
    this.#delegate = delegate;
    this.#refresh = refresh;
  }

  refreshRunCredentials(runId: RunId): Promise<RefreshedRunCredentials | undefined> {
    if (this.#closed || !this.#refresh) return Promise.resolve(undefined);
    return this.#refresh(runId);
  }

  send(message: RunnerOperationalReport): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Host connection is closed"));
    const scope = operationalMessageEffectScope(message);
    const barrier = scope ? this.#scopes.get(scope) : undefined;
    if (!barrier) return this.#delegate.send(message);
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (this.#bufferedBytes + bytes > maximumBufferedOutboundBytes) {
      this.#delegate.abort?.("Runner causal event buffer exceeded its byte limit");
      return Promise.reject(new Error("Runner causal event buffer exceeded its byte limit"));
    }
    barrier.messages.push(message);
    barrier.bytes += bytes;
    this.#bufferedBytes += bytes;
    // Admission to this bounded transport buffer is the send boundary. Waiting
    // for the wire here would deadlock controls such as steer, whose handler
    // intentionally awaits its message.injected event before accepting.
    return Promise.resolve();
  }

  async applyCommand(
    command: RunnerCommand,
    apply: () => ReturnType<RunnerRuntime["handleCommand"]>,
  ): Promise<void> {
    if (this.#closed) throw new Error("Host connection is closed");
    const scope = runnerCommandEffectScope(command);
    if (scope && this.#scopes.has(scope)) {
      throw new Error(`Runner command effect scope ${scope} already has an active barrier`);
    }
    if (scope) this.#scopes.set(scope, { bytes: 0, messages: [] });
    try {
      const decision = await apply();
      await this.#delegate.send(
        decision.status === "accepted"
          ? {
              commandId: command.commandId,
              correlationId: command.correlationId,
              type: "runner.command-accepted",
              ...(decision.workspacePath ? { workspacePath: decision.workspacePath } : {}),
            }
          : decision.status === "rejected"
            ? {
                commandId: command.commandId,
                correlationId: command.correlationId,
                error: decision.error,
                type: "runner.command-rejected",
              }
            : {
                commandId: command.commandId,
                correlationId: command.correlationId,
                message: decision.message,
                type: "runner.command-uncertain",
              },
      );
      if (scope) await this.#release(scope);
    } catch (error) {
      if (scope) this.#discard(scope);
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#scopes.clear();
    this.#bufferedBytes = 0;
    this.#delegate.close?.();
  }

  async #release(scope: string): Promise<void> {
    const barrier = this.#scopes.get(scope);
    if (!barrier) return;
    try {
      for (;;) {
        const message = barrier.messages.shift();
        if (!message) break;
        const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
        barrier.bytes -= bytes;
        this.#bufferedBytes -= bytes;
        await this.#delegate.send(message);
      }
    } finally {
      this.#discard(scope);
    }
  }

  #discard(scope: string): void {
    const barrier = this.#scopes.get(scope);
    if (!barrier) return;
    this.#scopes.delete(scope);
    this.#bufferedBytes -= barrier.bytes;
  }
}

export class WebSocketMessageSink implements RunnerMessageSink {
  readonly #fence: RunnerConnectionFenceLedger;
  readonly #socket: WebSocket;
  #closed = false;
  #queuedBytes = 0;
  #tail = Promise.resolve();

  constructor(socket: WebSocket, fence: RunnerConnectionFenceLedger) {
    this.#fence = fence;
    this.#socket = socket;
  }

  send(message: RunnerOperationalReport): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Host connection is closed"));
    let frame: string;
    try {
      // The fence is stamped here, at the only place that knows which socket
      // this is, so nothing upstream can address a superseded connection.
      // Storage replies echo the complete storage fence from their request.
      // A second top-level fence would violate their strict wire schema.
      let parsed = RunnerOperationalMessageSchema.parse(
        "fence" in message ? message : { ...this.#fence.fence, ...message },
      );
      frame = serializeJsonFrame(parsed);
      if (
        parsed.type === "runner.harness-catalog" &&
        Buffer.byteLength(frame, "utf8") > maximumFrameBytes
      ) {
        parsed = fitHarnessCatalogFrame(parsed);
        frame = serializeJsonFrame(parsed);
      }
    } catch (error) {
      this.#socket.close(1011, "Runner generated an invalid protocol message");
      return Promise.reject(error);
    }
    const bytes = Buffer.byteLength(frame, "utf8");
    if (bytes > maximumFrameBytes) {
      this.#socket.close(1009, "Runner frame exceeded size limit");
      return Promise.reject(new Error("Runner frame exceeded size limit"));
    }
    if (this.#queuedBytes + bytes + this.#socket.bufferedAmount > maximumBufferedOutboundBytes) {
      this.#socket.close(1013, "Runner outbound queue is full");
      return Promise.reject(new Error("Runner outbound queue exceeded its byte limit"));
    }
    this.#queuedBytes += bytes;
    const send = this.#tail.then(
      () =>
        new Promise<void>((resolvePromise, reject) => {
          if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
            reject(new Error("Host connection is not open"));
            return;
          }
          this.#socket.send(frame, (error) => (error ? reject(error) : resolvePromise()));
        }),
    );
    this.#tail = send.catch(() => undefined);
    return send.finally(() => {
      this.#queuedBytes -= bytes;
    });
  }

  abort(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#socket.readyState < WebSocket.CLOSING) this.#socket.close(1013, reason);
  }

  close(): void {
    this.#closed = true;
  }
}

/**
 * A catalog answer must name every requested profile in one correlated frame.
 * When complete model data cannot fit, preserve that complete profile set and
 * replace only the largest catalog payloads with explicit errors. The Host can
 * then refresh one profile at a time without losing the Runner connection.
 */
function fitHarnessCatalogFrame(
  message: Extract<
    ReturnType<typeof RunnerOperationalMessageSchema.parse>,
    { readonly type: "runner.harness-catalog" }
  >,
): Extract<
  ReturnType<typeof RunnerOperationalMessageSchema.parse>,
  { readonly type: "runner.harness-catalog" }
> {
  const catalogs = [...message.catalogs];
  let frameBytes = Buffer.byteLength(serializeJsonFrame(message), "utf8");
  const replacements = catalogs
    .map((catalog, index) => {
      const replacement: HarnessInstanceCatalog = {
        connections: [],
        detail:
          "This account's complete model catalog could not fit in the Runner's 1 MiB response.",
        driverKind: catalog.driverKind,
        harnessInstanceId: catalog.harnessInstanceId,
        models: [],
        setupMethods: [],
        status: "error",
      };
      return {
        index,
        replacement,
        savedBytes:
          Buffer.byteLength(serializeJsonFrame(catalog), "utf8") -
          Buffer.byteLength(serializeJsonFrame(replacement), "utf8"),
      };
    })
    .filter(({ savedBytes }) => savedBytes > 0)
    .toSorted((left, right) => right.savedBytes - left.savedBytes);

  for (const candidate of replacements) {
    if (frameBytes <= maximumFrameBytes) break;
    catalogs[candidate.index] = candidate.replacement;
    frameBytes -= candidate.savedBytes;
  }
  return { ...message, catalogs };
}

function runnerCommandEffectScope(command: RunnerCommand): string | undefined {
  switch (command.type) {
    case "run.execute":
      return `run:${command.context.runId}`;
    case "request.resolve":
    case "run.interrupt":
    case "run.steer":
    case "workspace.mount":
      return `run:${command.runId}`;
    case "trigger.execute":
      return `trigger:${command.context.occurrenceId}`;
    case "trigger.interrupt":
      return `trigger:${command.occurrenceId}`;
    case "watch.reconcile":
      return `watch-environment:${command.environmentId}`;
    case "workspace.detach":
      return undefined;
  }
}

function operationalMessageEffectScope(message: RunnerOperationalReport): string | undefined {
  switch (message.type) {
    case "runner.event":
      return `run:${message.event.runId}`;
    // Live progress waits behind the same barrier as the Run's durable events:
    // overtaking an event that completes a stream would draw the next stream's
    // first words on the one the event is about to replace.
    case "runner.live":
      return `run:${message.progress.runId}`;
    case "runner.session-bound":
    case "runner.thread-title":
      return `run:${message.runId}`;
    case "runner.trigger-result":
      return `trigger:${message.output.occurrenceId}`;
    case "runner.watch-status":
      return `watch:${message.activationId}`;
    default:
      return undefined;
  }
}

export function runnerWebSocketUrl(config: Pick<RunnerConfig, "hostUrl" | "mode">): URL {
  return runnerTransportWebSocketUrl(
    { hostOrigin: config.hostUrl, mode: config.mode },
    "/internal/v1/runners",
  );
}

function hostMessageFence(message: PostAuthenticationHostMessage): RunnerConnectionFence {
  switch (message.type) {
    case "host.workspace.local.provision":
    case "host.workspace.local.inspect":
    case "host.workspace.local.destroy":
    case "host.workspace.local.files.list":
    case "host.workspace.local.files.read":
      return message.fence;
    default:
      return message;
  }
}

function runnerCapabilities(): RunnerCapability[] {
  return [
    "assignments-v1",
    "attempts-v1",
    "browser-page-input-v1",
    "browser-profile-create-v1",
    "environment-list-v1",
    "trigger-program-v3",
    "native-place-input-v1",
    "execution-plane-v2",
    "filesystem",
    "model-server-discovery-v1",
    "network-egress",
    "native-session-continuation-v1",
    "requester-time-zone-v1",
    "steer-answer-v1",
    "thread-state-v1",
    "thread-title-v1",
    "thread-icon-v1",
    "task-done-v1",
    "person-notify-v1",
  ];
}

function parseHostFrame(frame: InboundFrame): HostToRunnerMessage {
  if (frame.isBinary) throw new Error("Runner protocol does not accept binary frames");
  return parseJsonFrame(HostToRunnerMessageSchema, frame.buffer) as HostToRunnerMessage;
}

async function nextHostMessage(
  iterator: AsyncIterator<InboundFrame>,
  signal: AbortSignal,
  timeoutMessage: string,
): Promise<HostToRunnerMessage> {
  const next = await withTimeout(iterator.next(), handshakeTimeoutMs, {
    abortFallback: "Runner stopping",
    signal,
    timeoutError: () => new Error(timeoutMessage),
  });
  if (next.done) throw new Error("Host connection closed during Runner authentication");
  return parseHostFrame(next.value);
}

async function sendWireMessage(socket: WebSocket, message: RunnerToHostMessage): Promise<void> {
  // A domain parser may trim/default the descriptor, invalidating its wire signature.
  const parsed =
    message.type === "runner.authenticate" || message.type === "runner.enroll"
      ? RunnerWireProofSchema.parse(message)
      : RunnerToHostMessageSchema.parse(message);
  const frame = serializeJsonFrame(parsed);
  if (Buffer.byteLength(frame, "utf8") > maximumFrameBytes) {
    throw new Error("Runner authentication frame exceeded size limit");
  }
  await new Promise<void>((resolvePromise, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error("Host connection is not open"));
      return;
    }
    socket.send(frame, (error) => (error ? reject(error) : resolvePromise()));
  });
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

async function waitForOpen(socket: WebSocket, signal: AbortSignal): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolvePromise, reject) => {
    const opened = () => finish(resolvePromise);
    const failed = (error: Error) => finish(() => reject(error));
    const closed = (code: number) =>
      finish(() => reject(new Error(`Host connection closed (${code})`)));
    const aborted = () => {
      socket.close(1001, "Runner stopping");
      finish(() => reject(signal.reason ?? new Error("Runner stopping")));
    };
    const finish = (callback: () => void): void => {
      socket.off("open", opened);
      socket.off("error", failed);
      socket.off("close", closed);
      signal.removeEventListener("abort", aborted);
      callback();
    };
    socket.once("open", opened);
    socket.once("error", failed);
    socket.once("close", closed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

export async function waitForRunnerReconnect(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolvePromise) => {
    const timeout = setTimeout(() => finish(), milliseconds);
    // Reconnection is the Runner daemon's primary work while the Host is unavailable.
    // This timer must keep the process alive; otherwise a startup race can let Node exit
    // after the first refused connection and leave no Runner to reconnect when Host starts.
    const aborted = () => finish();
    const finish = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", aborted);
      resolvePromise();
    };
    signal.addEventListener("abort", aborted, { once: true });
  });
}

function safeErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Runner connection failed")
    .replace(/runner[_-]enrollment[_-]token[^\s]*/gi, "Runner enrollment token [redacted]")
    .slice(0, 2_000);
}
