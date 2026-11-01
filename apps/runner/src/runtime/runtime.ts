import { VoiceCalls } from "../voice/voice-calls.js";
import { isCodexVoiceAdapter } from "@opensteer/harness-codex";
import { systemClock, type Clock } from "@opensteer/shared/clock";
import { setPrivateDirectoryMode } from "@opensteer/shared/privateFiles";
import { safeMessage } from "@opensteer/shared/safeMessage";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import { platformGuideForRun } from "@opensteer/agent-tools";
import { defaultRunnerMaxConcurrentTriggerPrograms, type RunnerConfig } from "@opensteer/config";
import {
  createId,
  createToolArguments,
  messageContentMaxSerializedBytes,
  messageTextPartMaxLength,
  OpensteerError,
  requestChoiceTextMaxLength,
  requestLabelMaxLength,
  requestTextMaxLength,
  requestTitleMaxLength,
  runFailureMessageMaxLength,
  surrogateSafeCut,
  toolOutputTextMaxBytes,
  utf8ByteLength,
  utf8HeadAndTail,
  utf8Prefix,
  type ContentPart,
  type UserId,
  type RequestPresentation,
  type HarnessId,
  type HarnessInstanceId,
  type RequestId,
  type RuntimeMode,
  type RunId,
  type ThreadId,
  type TriggerOccurrenceId,
  type TriggerWatchActivationId,
  type WorkspaceId,
} from "@opensteer/core";
import {
  assertFreshProviderSessionContext,
  discoverModelServers,
  HarnessSteerDeliveryUnknownError,
  identifyModelServer,
  isHarnessLiveEvent,
  LiveSessionDirectory,
  threadTitlePrompt,
  threadTitleBudgetMs,
  threadTitleCleanupMs,
  parseGeneratedThreadName,
  type HarnessDurableEvent,
  type EngineUpdatePlan,
  type HarnessLiveEvent,
  type HarnessInstanceDefinition,
  type HarnessRegistry,
  spawnSupervised,
  type HarnessProcessLaunchWrapper,
  type HarnessRuntimeBoundary,
  type HarnessSession,
  type HarnessSkillPlan,
  type ResolvedAttachment,
} from "@opensteer/harness";
import {
  HarnessInstanceCatalogSchema,
  PendingAgentEventSchema,
  pendingAgentEventMaxSerializedBytes,
  type PendingAgentEvent,
  type ProtocolError,
  type HostToRunnerMessage,
  type HarnessAuthenticationState,
  type HarnessInstallation,
  type HarnessInstanceCatalog,
  type ModelServer,
  type RunnerHarnessDriver,
  type RunnerCommand,
  type RunnerOperationalReport,
  type RunnerVoiceCommand,
  type RunnerVoiceResult,
} from "@opensteer/protocol";
import type { TriggerExecutionOutput } from "@opensteer/triggers";
import type { ProviderContinuationIdentityProjector } from "@opensteer/runner-client";
import { CommandLedger, type CommandDecision } from "../agent/command-ledger.js";
import type { RunWorkspace, WorkspaceAccessManager } from "../workspace/mount-manager.js";
import type { WorkspaceMountRegistry } from "../workspace/workspace-mount-registry.js";
import { HttpAgentControlClient } from "../agent/agent-control-client.js";
import { planAgentSkills, type AgentSkillBundle } from "../skills/agent-skills.js";
import type { RunnerLogger } from "../host/host-connection.js";
import { materializeIntegrationSkills } from "../skills/integration-skills.js";
import { resolveSkillPlan } from "../skills/skill-plan.js";
import { discoverWorkspaceSkills } from "../skills/workspace-skills.js";
import { BrowserCdpRelay } from "../browser/browser-cdp-relay.js";
import { CredentialProxy } from "../credentials/credential-proxy.js";
import { RunCredentials } from "../credentials/run-credentials.js";
import { ExecutionContainment, type TerminationProof } from "./execution-containment.js";
import { WarmEnginePool, type WarmEngine } from "./warm-engine-pool.js";
import { startProgramEndpoints, type ProgramEndpointSet } from "../agent/program-endpoints.js";
import { TriggerProgramExecutor, type ProgramLaunchPlanner } from "../agent/program-executor.js";
import { WatchSupervisor } from "../triggers/watch-supervisor.js";
import {
  isMachineAccessRoutes,
  isMachineAccessSetup,
  machineAccessLaunchIdentity,
  machineAccessTargets,
  planMachineAccess,
  renderMachineAccessNotice,
  setupMachineAccess,
  type MachineAccessSetup,
  type MachineAccessUnavailableReason,
  type MachineAccessValidationHook,
} from "../shell/machine-access-setup.js";
import {
  harnessSandboxRequired,
  type HarnessProcessSandbox,
  type HarnessSandboxRunPlan,
} from "../sandbox/harness-sandbox.js";
import {
  existingIsolatedHarnessProviderState,
  prepareHarnessProviderState,
  removeHarnessProviderState,
  type HarnessProviderStateOptions,
} from "../harness/harness-provider-state.js";
import { AttachmentCache } from "../attachments/attachment-cache.js";
import { LiveProgressBuffer } from "./live-progress.js";

/** A Run's fresh capability tokens, or null once its grant has ended. */
export type RefreshedRunCredentials =
  | Extract<
      Extract<HostToRunnerMessage, { readonly type: "host.grants.credentials" }>["result"],
      { readonly status: "issued" }
    >["credentials"]
  | null;

export interface RunnerMessageSink {
  send(message: RunnerOperationalReport): Promise<void>;
  /** Undefined when the Host gave no answer; the Run keeps its tokens and retries. */
  refreshRunCredentials?(runId: RunId): Promise<RefreshedRunCredentials | undefined>;
}

export interface RunnerRuntimeOptions {
  /** Execution leases only; request, engine and transport budgets stay real. */
  readonly executionClock?: Clock;
  /** Schedules credential refresh only; leases, sockets and engine timers stay real. */
  readonly credentialRefreshClock?: Pick<Clock, "schedule">;
  readonly attachmentCache?: AttachmentCache;
  readonly agentSkills: AgentSkillBundle;
  readonly browserHarnessExecutable: string;
  readonly bootId: string;
  /** Proves each execution's processes gone; built from the boot and data directory when omitted. */
  readonly containment?: ExecutionContainment;
  /** The Runner's whole data directory: the root model-executed tools must never read. */
  readonly dataDirectory: string;
  readonly deploymentShape: RunnerConfig["deploymentShape"];
  readonly environmentId: RunnerCommand["environmentId"];
  readonly harnesses: HarnessRegistry;
  /** Present exactly when {@link harnessSandboxRequired} says so for this Runner. */
  readonly harnessSandbox?: HarnessProcessSandbox;
  readonly integrationSkills: typeof materializeIntegrationSkills;
  readonly harnessRuntimeBoundary: HarnessRuntimeBoundary;
  readonly logger?: RunnerLogger;
  readonly maxConcurrentRuns: number;
  readonly maxConcurrentTriggerPrograms?: number;
  readonly maxRunEventBytes?: number;
  readonly maxRunEvents?: number;
  readonly machineAccess?: {
    readonly controlCaPath?: string;
    readonly helperBinary: string;
    readonly hostUrl: URL;
    readonly validationHook?: MachineAccessValidationHook;
  };
  readonly mode?: RuntimeMode;
  /**
   * Where model server apps keep their own settings — the person's home on
   * their own computer. Tests point it at a temporary home.
   */
  readonly modelServerHome?: string;
  readonly nodeExecutable?: string;
  readonly privateStateDirectory: string;
  readonly projectContinuationIdentity: ProviderContinuationIdentityProjector;
  readonly programExecutor?: Pick<TriggerProgramExecutor, "execute">;
  readonly workspaceManager: WorkspaceAccessManager;
  readonly watchSupervisor?: Pick<
    WatchSupervisor,
    "activeActivationIds" | "close" | "connectionLost" | "reconcile"
  >;
  readonly workspaceMountRegistry?: Pick<
    WorkspaceMountRegistry,
    "detach" | "detachAll" | "inventory"
  >;
}

type HarnessAuthenticationResponse = Pick<
  Extract<RunnerOperationalReport, { readonly type: "runner.harness-authentication" }>,
  "driverKind" | "harnessInstanceId" | "state"
>;

interface HarnessAuthenticationEntry {
  readonly connectionSlot?: string;
  /** Settles only after provider startup or a pending sign-in has ended. */
  readonly completion?: Promise<void>;
  readonly driverKind: HarnessAuthenticationResponse["driverKind"];
  /** Epoch milliseconds after which this interaction may no longer be replayed. */
  readonly expiresAt: number;
  readonly methodId?: string;
  readonly state: HarnessAuthenticationState;
  /** Holds the stop reservation while cancellation is active or awaiting an explicit retry. */
  readonly stopping?: Promise<void>;
  /** The reserved stop attempt ended without proving the process gone and may be retried. */
  readonly stoppingFailed?: boolean;
  readonly cancel?: () => Promise<void>;
  readonly submit?: (value: string) => Promise<void>;
}

/**
 * What a Run has reported that the Host has not acknowledged: its durable
 * events by ordinal and its session binding. They survive a lost connection
 * and are replayed, in order, on the next one.
 */
interface RunJournal {
  readonly events: Map<number, { readonly bytes: number; readonly event: PendingAgentEvent }>;
  bytes: number;
  sessionBound: Extract<RunnerOperationalReport, { readonly type: "runner.session-bound" }> | null;
  /** The session binding has been sent on the current connection. */
  sessionBoundSent: boolean;
  /** The highest ordinal sent on the current connection, in order. */
  sentThrough: number;
  /** Sends the journal in ordinal order; one at a time per Run. */
  sending: Promise<void>;
  terminal: boolean;
}

interface ActiveRun {
  interruptionCause?: "lease-lost";
  shutdown?: boolean;
  readonly abort: AbortController;
  readonly command: Extract<RunnerCommand, { readonly type: "run.execute" }>;
  readonly journal: RunJournal;
  /** Local time after which the Run stops unless the Host renews its lease. */
  leaseDeadline: number;
  /**
   * Whether `leaseDeadline` was measured from a moment this Runner chose
   * before the Host granted the lease, so it can never outlast the Host's
   * record. The deadline taken at admission was not: it is replaced, not
   * extended, by the first grant that is.
   */
  leaseCorrelated: boolean;
  readonly leaseGrant: {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
  };
  readonly leaseMs: number;
  emittedEventBytes: number;
  emittedEvents: number;
  /** Streaming text not yet completed by a durable event. */
  readonly live: LiveProgressBuffer;
  nextOrdinal: number;
  readonly pendingRequestIds: Set<RequestId>;
  /**
   * The Host already ended this Run without it. Nothing more is sent for it:
   * its outcome is durable there, and a late event would only be refused.
   */
  revoked?: boolean;
  /** An explicit Stop wins over an engine completion while this Run is still held. */
  interrupted?: true;
  readonly saturatedToolDeltaCallIds: Set<string>;
  readonly toolDeltaBytes: Map<string, number>;
  primaryWorkspace?: RunWorkspace;
  /**
   * What the engine reaches the Host and the browser through, while this Run
   * holds them; cut on interrupt. A Run that hands its engine on lets go of
   * both, so nothing it does later reaches the Run that takes the engine.
   */
  browserCdpRelay?: BrowserCdpRelay;
  credentialProxy?: CredentialProxy;
  /** What the engine's `ssh` reaches the Host through, while this Run holds it. */
  machineAccessRelay?: MachineAccessSetup["relay"];
  /** Its access was cut; nothing lends this Run a relay again. */
  localAccessEnded?: boolean;
  /** The Run's current Host tokens once it executes, replaced by each refresh. */
  credentials?: RunCredentials;
  /** Refreshing the Run's tokens, which ends with its execution. */
  readonly credentialLifetime: AbortController;
  /** The containment scope of the Run's processes: its own, or its warm engine's. */
  containmentScope: string;
  session?: HarnessSession;
  settling?: boolean;
  readonly steerTasks: Set<Promise<CommandDecision>>;
  task?: Promise<void>;
  readonly workspaceIds: Set<WorkspaceId>;
}

interface ActiveTriggerProgram {
  readonly abort: AbortController;
  readonly command: Extract<RunnerCommand, { readonly type: "trigger.execute" }>;
  readonly sink: RunnerMessageSink;
  task?: Promise<void>;
  readonly workspaceIds: Set<WorkspaceId>;
}

// Durable events only: streaming text travels as live progress and counts
// against its own budget, which ends streaming rather than the Run.
const defaultMaxRunEvents = 10_000;
const defaultMaxRunEventBytes = 64 * 1_024 * 1_024;
const liveFlushIntervalMs = 50;
/** Events a Run may hold for a Host it cannot reach before it stops itself. */
const maxJournalBytes = 32 * 1_024 * 1_024;
/** How long, and how much of, ended Runs' unacknowledged journals are kept. */
const settledJournalRetentionMs = 24 * 60 * 60_000;
const maxSettledJournalBytes = 64 * 1_024 * 1_024;
const liveMaxPendingBytes = 32 * 1_024;
const liveMaxInFlightBytes = 256 * 1_024;
const liveMaxSentBytes = 32 * 1_024 * 1_024;
const terminalEventReserveBytes = pendingAgentEventMaxSerializedBytes;
const runtimeTaskStopWaitMs = 30_000;
/** How long a stopped Run's engine gets to wind down before the Runner ends its processes. */
const executionStopGraceMs = 3_000;
const uncontainedRetryMs = 5_000;
/** Matches the Host coordinator's hard attempt lifetime so neither side outlives the other. */
const harnessAuthenticationLifetimeMs = 15 * 60_000;
/**
 * An updater holds the engine's maintenance reservation, refusing its Runs and
 * sign-ins, until it ends. Long enough for Homebrew to refresh itself and then
 * download a few hundred megabytes on a slow home link; ending a healthy
 * install midway can leave the engine broken.
 */
const engineUpdateDeadlineMs = 15 * 60_000;
const engineUpdateOutputGraceMs = 1_000;
const requestCancellationReserveBytes = 2_048;
const toolDeltaOmissionMarker = "\n… additional live output omitted; final tool output follows …\n";
const toolDeltaContentMaxBytes = toolOutputTextMaxBytes - utf8ByteLength(toolDeltaOmissionMarker);

const terminalEventTypes = new Set<HarnessDurableEvent["type"]>([
  "run.completed",
  "run.failed",
  "run.interrupted",
]);

export class RunnerRuntime {
  readonly #attachmentCache: AttachmentCache | undefined;
  readonly #agentSkills: AgentSkillBundle;
  readonly #browserHarnessExecutable: string;
  readonly #dataDirectory: string;
  readonly #deploymentShape: RunnerConfig["deploymentShape"];
  readonly #environmentId: RunnerCommand["environmentId"];
  readonly #harnesses: HarnessRegistry;
  readonly #harnessSandbox: HarnessProcessSandbox | undefined;
  readonly #harnessAuthenticationLifetime = new AbortController();
  readonly #harnessAuthenticationStartups = new Set<Promise<void>>();
  readonly #harnessAuthenticationStartupsByInstance = new Map<string, Promise<void>>();
  readonly #harnessAuthentications = new Map<string, HarnessAuthenticationEntry>();
  readonly #harnessMaintenance = new Set<HarnessInstanceId>();
  readonly #driverMaintenance = new Set<HarnessId>();
  readonly #driverInstallationFacts = new Map<HarnessId, HarnessInstallation>();
  readonly #driverInstallationInspections = new Map<HarnessId, Promise<void>>();
  readonly #driverInstallationOperations = new Map<HarnessId, HarnessInstallation>();
  readonly #pendingDriverInstallationAdvertisements = new Map<HarnessId, HarnessInstallation>();
  readonly #pendingHarnessCatalogInvalidations = new Set<HarnessInstanceId>();
  readonly #installationQueues = new Map<string, Promise<void>>();
  readonly #installationLifetime = new AbortController();
  readonly #installationTasks = new Set<Promise<void>>();
  readonly #integrationSkills: typeof materializeIntegrationSkills;
  readonly #harnessRuntimeBoundary: HarnessRuntimeBoundary;
  readonly #ledger = new CommandLedger();
  readonly #logger: RunnerLogger | undefined;
  readonly #maxConcurrentRuns: number;
  readonly #maxConcurrentTriggerPrograms: number;
  readonly #maxRunEventBytes: number;
  readonly #maxRunEvents: number;
  readonly #credentialRefreshClock: Pick<Clock, "schedule">;
  readonly #executionClock: Clock | undefined;
  readonly #executionNow: () => number;
  readonly #machineAccess: RunnerRuntimeOptions["machineAccess"];
  readonly #mode: RuntimeMode;
  readonly #privateStateDirectory: string;
  readonly #voice: VoiceCalls;
  readonly #modelServerHome: string | undefined;
  readonly #projectContinuationIdentity: ProviderContinuationIdentityProjector;
  readonly #programExecutor: Pick<TriggerProgramExecutor, "execute">;
  readonly #runs = new Map<RunId, ActiveRun>();
  readonly #containment: ExecutionContainment;
  /** Engines kept running between a Thread's Runs. */
  readonly #warm: WarmEnginePool;
  /**
   * Threads whose last execution left processes the Runner could not prove
   * gone, with the containment scope of those processes. Nothing new starts on
   * one until they are.
   */
  readonly #uncontainedThreads = new Map<ThreadId, string>();
  /**
   * Runs that have ended but whose last events the Host has not acknowledged,
   * oldest first. They are kept for replay until it does, within
   * `settledJournalRetentionMs` and `maxSettledJournalBytes`: a Host that was
   * down restarts its leases at boot, so their outcomes still count when it
   * returns.
   */
  readonly #settledRuns = new Map<RunId, ActiveRun & { readonly settledAt: number }>();
  /** The connection Runs report on, once the Host has reattached them to it. */
  #connection: RunnerMessageSink | null = null;
  /** When this Runner last announced its Runs; the answer's leases run from here. */
  #attachRequestedAt: number | undefined;
  #stopLeaseWatchdog: (() => void) | undefined;
  readonly #sessions: LiveSessionDirectory;
  readonly #threads = new Map<ThreadId, RunId>();
  readonly #triggerPrograms = new Map<TriggerOccurrenceId, ActiveTriggerProgram>();
  readonly #workspaceManager: WorkspaceAccessManager;
  readonly #workspaceMountRegistry: RunnerRuntimeOptions["workspaceMountRegistry"];
  readonly #watchSupervisor: Pick<
    WatchSupervisor,
    "activeActivationIds" | "close" | "connectionLost" | "reconcile"
  >;
  #draining = false;

  constructor(options: RunnerRuntimeOptions) {
    this.#executionClock = options.executionClock;
    this.#executionNow = options.executionClock?.now ?? (() => Date.now());
    this.#credentialRefreshClock = options.credentialRefreshClock ?? systemClock;
    this.#attachmentCache = options.attachmentCache;
    this.#agentSkills = options.agentSkills;
    this.#browserHarnessExecutable = resolve(options.browserHarnessExecutable);
    this.#dataDirectory = resolve(options.dataDirectory);
    this.#deploymentShape = options.deploymentShape;
    this.#environmentId = options.environmentId;
    this.#harnesses = options.harnesses;
    this.#integrationSkills = options.integrationSkills;
    this.#harnessRuntimeBoundary = options.harnessRuntimeBoundary;
    if (
      harnessSandboxRequired(platform(), options.harnessRuntimeBoundary) &&
      !options.harnessSandbox
    ) {
      throw new Error("An isolated-service Linux Runner requires the Runner-owned harness sandbox");
    }
    this.#harnessSandbox = options.harnessSandbox;
    this.#logger = options.logger;
    this.#maxConcurrentRuns = boundedPositiveInteger(
      options.maxConcurrentRuns,
      1,
      1_000,
      "maxConcurrentRuns",
    );
    this.#maxConcurrentTriggerPrograms = boundedPositiveInteger(
      options.maxConcurrentTriggerPrograms ?? defaultRunnerMaxConcurrentTriggerPrograms,
      1,
      1_000,
      "maxConcurrentTriggerPrograms",
    );
    this.#maxRunEventBytes = boundedPositiveInteger(
      options.maxRunEventBytes ?? defaultMaxRunEventBytes,
      terminalEventReserveBytes * 2,
      256 * 1_024 * 1_024,
      "maxRunEventBytes",
    );
    this.#maxRunEvents = boundedPositiveInteger(
      options.maxRunEvents ?? defaultMaxRunEvents,
      2,
      100_000,
      "maxRunEvents",
    );
    this.#machineAccess = options.machineAccess;
    this.#mode = options.mode ?? "development";
    this.#privateStateDirectory = resolve(options.privateStateDirectory);
    this.#voice = new VoiceCalls(
      join(this.#privateStateDirectory, "voice"),
      async ({ harnessInstanceId, offer, agent, signal, directory }) => {
        const definition = this.#harnesses.state(harnessInstanceId)?.definition;
        if (!definition || definition.driverKind !== "codex")
          throw new OpensteerError({
            code: "conflict",
            reason: "voice-account-unavailable",
            message: "Voice requires a Codex account.",
          });
        const adapter = await this.#harnesses.adapter(harnessInstanceId);
        if (!isCodexVoiceAdapter(adapter))
          throw new OpensteerError({
            code: "conflict",
            reason: "voice-engine-unsupported",
            message: "This Codex driver does not support voice.",
          });
        const options = await this.#providerStateOptions(definition.driverKind);
        const { providerState } = await prepareHarnessProviderState(definition, options);
        return adapter.startVoiceCall({
          agent,
          offer,
          signal,
          environment: options.environment,
          providerState,
          runtimeBoundary: this.#harnessRuntimeBoundary,
          workingDirectory: directory,
        });
      },
    );
    this.#modelServerHome = options.modelServerHome;
    this.#projectContinuationIdentity = options.projectContinuationIdentity;
    this.#programExecutor =
      options.programExecutor ?? programExecutorFor(options, this.#privateStateDirectory);
    this.#workspaceManager = options.workspaceManager;
    this.#workspaceMountRegistry = options.workspaceMountRegistry;
    this.#watchSupervisor =
      options.watchSupervisor ??
      new WatchSupervisor({
        environmentId: options.environmentId,
        nodeExecutable: options.nodeExecutable ?? process.execPath,
        planLaunch: (executionId, launch) => this.#planProgramLaunch(executionId, launch),
        privateStateDirectory: this.#privateStateDirectory,
        terminate: (executionId) => this.#containment.terminate(executionId),
        transport: { mode: this.#mode },
        workspaceManager: options.workspaceManager,
      });
    this.#sessions = new LiveSessionDirectory(options.bootId);
    this.#containment =
      options.containment ??
      new ExecutionContainment({ bootId: options.bootId, dataDirectory: options.dataDirectory });
    this.#warm = new WarmEnginePool({ retire: (engine) => this.#retireWarmEngine(engine) });
  }

  voice(userId: UserId, command: RunnerVoiceCommand): Promise<RunnerVoiceResult> {
    return this.#voice.handle(userId, command);
  }

  activeRunIds(): readonly RunId[] {
    return [...this.#runs.keys()];
  }

  /** An unacknowledged terminal outcome, after execution and cleanup have settled. */
  settledRunEvent(runId: RunId): PendingAgentEvent | undefined {
    const active = this.#settledRuns.get(runId);
    if (!active) return undefined;
    return active.journal.terminal ? [...active.journal.events.values()].at(-1)?.event : undefined;
  }

  activeTriggerOccurrenceIds(): readonly TriggerOccurrenceId[] {
    return [...this.#triggerPrograms.keys()];
  }

  async harnessDrivers(): Promise<readonly RunnerHarnessDriver[]> {
    return this.#harnesses.listDrivers().map(({ kind, readiness }) => {
      this.#refreshDriverInstallation(kind);
      const installation =
        this.#driverInstallationOperations.get(kind) ?? this.#driverInstallationFacts.get(kind);
      if (readiness.status === "unavailable") {
        return {
          driverKind: kind,
          ...(installation ? { installation } : {}),
          readiness: "unavailable" as const,
          reason: readiness.reason,
        };
      }
      const capabilities = this.#harnesses.driverCapabilities(kind);
      const nativeImages = capabilities?.messageAttachments?.nativeImages;
      return {
        // A runnable driver always declares at least one access mode; the Host
        // refuses every mode a driver does not advertise, so an empty list
        // would leave the engine unable to run any Thread at all.
        accessModes: [...(this.#harnesses.driverAccessModes(kind) ?? [])],
        driverKind: kind,
        ...(installation ? { installation } : {}),
        mcpImageContent: capabilities?.mcpImageContent ?? false,
        ...(this.#canDeliverMessageAttachments(kind)
          ? {
              messageAttachments: {
                nativeImages: nativeImages
                  ? {
                      ...nativeImages,
                      mediaTypes: [...nativeImages.mediaTypes],
                    }
                  : null,
              },
            }
          : {}),
        ...(readiness.note ? { note: readiness.note } : {}),
        readiness: readiness.status,
        steering: capabilities?.steering ?? false,
        // A runnable driver always declares at least one source; an empty list
        // would leave clients unable to offer "Add account" for an engine the
        // Runner is ready to run.
        sources: (this.#harnesses.driverSources(kind) ?? []).map((source) => ({
          ...source,
          fields: source.fields.map(({ options, ...field }) => ({
            ...field,
            ...(options ? { options: options.map((option) => ({ ...option })) } : {}),
          })),
          stateKinds: [...source.stateKinds],
        })),
      };
    });
  }

  #refreshDriverInstallation(kind: HarnessId): void {
    if (this.#driverInstallationInspections.has(kind)) return;
    const inspection = this.#harnesses
      .driverInstallation(kind)
      .then(async (resolved) => {
        if (!resolved) return;
        const previous = this.#driverInstallationFacts.get(kind);
        this.#driverInstallationFacts.set(kind, resolved.descriptor);
        if (
          this.#driverInstallationOperations.has(kind) ||
          JSON.stringify(previous) === JSON.stringify(resolved.descriptor)
        )
          return;
        await this.#publishDriverInstallation(kind, resolved.descriptor);
      })
      .catch(() => undefined)
      .finally(() => this.#driverInstallationInspections.delete(kind));
    this.#driverInstallationInspections.set(kind, inspection);
  }

  async #publishDriverInstallation(
    driverKind: HarnessId,
    installation: HarnessInstallation,
    fallback?: RunnerMessageSink,
  ): Promise<void> {
    this.#pendingDriverInstallationAdvertisements.set(driverKind, installation);
    const connection = this.#connection ?? fallback;
    if (!connection) return;
    await connection.send({ driverKind, installation, type: "runner.harness-installation" });
    if (this.#pendingDriverInstallationAdvertisements.get(driverKind) === installation) {
      this.#pendingDriverInstallationAdvertisements.delete(driverKind);
    }
  }

  async #publishDriverInstallationOutcome(
    driverKind: HarnessId,
    outcome: HarnessInstallation,
    fallback?: RunnerMessageSink,
  ): Promise<void> {
    try {
      await this.#publishDriverInstallation(driverKind, outcome, fallback);
    } catch {
      return;
    }
    if (this.#driverInstallationOperations.get(driverKind) !== outcome) return;
    this.#driverInstallationOperations.delete(driverKind);
    if (outcome.update !== "succeeded") return;
    const current = this.#driverInstallationFacts.get(driverKind);
    if (current)
      await this.#publishDriverInstallation(driverKind, current, fallback).catch(() => undefined);
  }

  async #publishPendingHarnessCatalogInvalidations(fallback?: RunnerMessageSink): Promise<void> {
    const connection = this.#connection ?? fallback;
    if (!connection) return;
    for (const harnessInstanceId of this.#pendingHarnessCatalogInvalidations) {
      try {
        await connection.send({ harnessInstanceId, type: "runner.harness-catalog-invalidated" });
        this.#pendingHarnessCatalogInvalidations.delete(harnessInstanceId);
      } catch {
        // The next connection replays every invalidation not confirmed sent.
      }
    }
  }

  #canDeliverMessageAttachments(driverKind: HarnessId): boolean {
    const capability = this.#harnesses.driverCapabilities(driverKind)?.messageAttachments;
    if (!this.#attachmentCache || !capability) return false;
    if (this.#harnessRuntimeBoundary.kind === "native-user" || process.platform === "linux")
      return true;
    return process.platform === "darwin" && capability.darwinIsolatedServiceSandbox === true;
  }

  subscribeHarnessPreparation(listener: (instanceId: HarnessInstanceId) => void): () => void {
    return this.#harnesses.subscribePreparations(listener);
  }

  providerStateModes(): readonly ("ambient" | "isolated")[] {
    return this.#harnessRuntimeBoundary.kind === "native-user"
      ? ["ambient", "isolated"]
      : ["isolated"];
  }

  /**
   * Answers one catalog request. `authoritative` marks the Host's
   * `host.reconcile-harnesses`, whose list is the complete desired set for this
   * environment; an ordinary `host.inspect-harnesses` carries an arbitrary
   * subset and must never be allowed to close anything.
   */
  async inspectHarnesses(
    definitions: Extract<
      HostToRunnerMessage,
      { readonly type: "host.reconcile-harnesses" }
    >["harnesses"],
    signal: AbortSignal,
    authoritative = false,
  ): Promise<readonly HarnessInstanceCatalog[]> {
    // Reconciliation runs on every connect, so a failure here must degrade to
    // per-profile error catalogs: throwing would tear the Host socket down and
    // turn one broken profile into a permanent reconnect loop.
    let preparationFailure: unknown;
    try {
      if (authoritative) await this.reconcileHarnesses(definitions);
      else {
        await mkdir(this.#privateStateDirectory, { mode: 0o700, recursive: true });
        await setPrivateDirectoryMode(this.#privateStateDirectory);
      }
    } catch (error) {
      preparationFailure = error;
    }
    return Promise.all(
      definitions.map(async (definition): Promise<HarnessInstanceCatalog> => {
        try {
          if (preparationFailure !== undefined) throw preparationFailure;
          const options = await this.#providerStateOptions(definition.driverKind);
          const { providerState, supersededContinuationKeys } = await prepareHarnessProviderState(
            definition,
            options,
          );
          const result = await this.#harnesses.inspectDefinition(
            definition,
            options.environment,
            this.#harnessRuntimeBoundary,
            providerState,
            this.#privateStateDirectory,
            signal,
          );
          if (result.status === "preparing") {
            return HarnessInstanceCatalogSchema.parse({
              connections: [],
              detail: result.detail,
              driverKind: definition.driverKind,
              harnessInstanceId: definition.id,
              models: [],
              setupMethods: [],
              status: "preparing",
            });
          }
          if (result.status !== "ready") {
            if (result.status === "authentication-required") {
              return HarnessInstanceCatalogSchema.parse({
                connections: result.connections ?? [],
                detail: result.detail,
                driverKind: definition.driverKind,
                harnessInstanceId: definition.id,
                models: [],
                setupMethods: result.setupMethods ?? [],
                status: "authentication-required",
              });
            }
            return HarnessInstanceCatalogSchema.parse({
              connections: result.connections ?? [],
              detail: result.detail,
              driverKind: definition.driverKind,
              harnessInstanceId: definition.id,
              models: [],
              setupMethods: result.setupMethods ?? [],
              status: "unavailable",
            });
          }
          return HarnessInstanceCatalogSchema.parse({
            connections: result.connections ?? [],
            // The Runner owns the continuation identity, and it identifies the
            // native session store rather than the profile or the account
            // signed into it: switching accounts is a visible catalog fact, not
            // a reason to fence a Thread off from its own provider history.
            continuationIdentity: this.#projectContinuationIdentity({
              continuationKey: providerState.continuationKey,
              driverKind: definition.driverKind,
            }),
            ...(result.detail ? { detail: result.detail } : {}),
            driverKind: definition.driverKind,
            harnessInstanceId: definition.id,
            models: result.models,
            setupMethods: result.setupMethods ?? [],
            status: "ready",
            steering: this.#harnesses.driverCapabilities(definition.driverKind)?.steering ?? false,
            supersededContinuationIdentities: supersededContinuationKeys.map(
              (continuationKey) =>
                this.#projectContinuationIdentity({
                  continuationKey,
                  driverKind: definition.driverKind,
                }).continuationKey,
            ),
          });
        } catch (error) {
          this.#logger?.error("AI engine inspection failed", {
            driverKind: definition.driverKind,
            harnessInstanceId: definition.id,
            detail: safeMessage(error, safeMessageOptions),
            ...(error instanceof OpensteerError && typeof error.details?.stderr === "string"
              ? { stderr: error.details.stderr }
              : {}),
          });
          return errorCatalog(definition, error);
        }
      }),
    );
  }

  /**
   * The model servers on this computer, or the one at `address`. Only a
   * computer the person owns looks: on a shared Runner the servers belong to
   * whoever runs the machine, and no engine that talks to them runs there.
   */
  async discoverModelServers(
    address: string | undefined,
    signal: AbortSignal,
  ): Promise<readonly ModelServer[]> {
    if (this.#harnessRuntimeBoundary.kind !== "native-user") {
      throw new OpensteerError({
        code: "forbidden",
        message: "Model servers are used only on a computer you own.",
      });
    }
    const options = {
      ...(this.#modelServerHome ? { home: this.#modelServerHome } : {}),
      signal,
    };
    return address === undefined
      ? discoverModelServers(options)
      : [await identifyModelServer(address, options)];
  }

  /** Applies the complete desired profile set before concurrent Run admission resumes. */
  async reconcileHarnesses(
    definitions: Extract<
      HostToRunnerMessage,
      { readonly type: "host.reconcile-harnesses" }
    >["harnesses"],
  ): Promise<void> {
    await mkdir(this.#privateStateDirectory, { mode: 0o700, recursive: true });
    await setPrivateDirectoryMode(this.#privateStateDirectory);
    // An engine started under an account's former definition is not kept.
    await this.#warm.evict(() => true);
    await this.#harnesses.reconcileInstances(definitions);
  }

  /** Whether this process has admitted work on one profile. */
  #harnessIsExecuting(harnessInstanceId: HarnessInstanceId): boolean {
    for (const active of this.#runs.values()) {
      if (active.command.context.harnessInstanceId === harnessInstanceId) return true;
    }
    return false;
  }

  /**
   * Serializes destructive provider maintenance with local Run admission.
   *
   * The Host's durable idle read cannot cover a Run that binds immediately
   * afterward. This fence is installed synchronously, before maintenance first
   * yields, and `#admitExecution` checks it synchronously before publishing a
   * Run in `#runs`. JavaScript therefore orders the two local outcomes without
   * another queue, mutex, or cross-process lock: existing work refuses the
   * maintenance, while maintenance that arrives first refuses later admission.
   */
  async #withHarnessMaintenance<T>(
    harnessInstanceId: HarnessInstanceId,
    action: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (
      this.#harnessMaintenance.has(harnessInstanceId) ||
      this.#harnessIsExecuting(harnessInstanceId)
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: `This AI engine is busy; wait before ${action}`,
        retryable: true,
      });
    }
    this.#harnessMaintenance.add(harnessInstanceId);
    try {
      await this.#warm.evict((engine) => engine.harnessInstanceId === harnessInstanceId);
      return await operation();
    } finally {
      this.#harnessMaintenance.delete(harnessInstanceId);
    }
  }

  async handleHarnessAuthentication(
    request: Extract<
      HostToRunnerMessage,
      { readonly type: "host.harness-authentication" }
    >["request"],
    signal: AbortSignal = this.#harnessAuthenticationLifetime.signal,
  ): Promise<HarnessAuthenticationResponse> {
    if (request.action === "remove") {
      const harness = request.harness;
      return this.#withHarnessMaintenance(harness.id, "removing it", async () => {
        await this.#discardAuthentication(harness.id, true);
        // An ambient profile keeps no Opensteer-owned provider files, so removal
        // is a no-op against the provider: the machine's normal CLI stays signed
        // in and only the Runner-owned record is dropped.
        const options = await this.#providerStateOptions(harness.driverKind);
        const providerState =
          harness.stateKind === "isolated"
            ? await existingIsolatedHarnessProviderState(harness, options)
            : undefined;
        if (providerState) {
          await this.#harnesses.removeDefinition(
            harness,
            options.environment,
            this.#harnessRuntimeBoundary,
            providerState,
            this.#privateStateDirectory,
            this.#harnessAuthenticationLifetime.signal,
          );
        } else {
          await this.#harnesses.closeInstance(harness.id);
        }
        await removeHarnessProviderState(harness, options);
        return {
          driverKind: harness.driverKind,
          harnessInstanceId: harness.id,
          state: { status: "not-started" as const },
        };
      });
    }
    if (request.action === "logout") {
      const harness = request.harness;
      return this.#withHarnessMaintenance(harness.id, "signing it out", async () => {
        await this.#discardAuthentication(harness.id, true);
        const options = await this.#providerStateOptions(harness.driverKind);
        const { providerState } = await prepareHarnessProviderState(harness, options);
        await this.#harnesses.logoutDefinition(
          harness,
          options.environment,
          this.#harnessRuntimeBoundary,
          providerState,
          this.#privateStateDirectory,
          this.#harnessAuthenticationLifetime.signal,
          request.connectionSlot,
        );
        return {
          driverKind: harness.driverKind,
          harnessInstanceId: harness.id,
          state: { status: "not-started" as const },
        };
      });
    }
    if (request.action === "submit") {
      const existing = await this.#liveAuthentication(request.harnessInstanceId);
      if (
        existing === undefined ||
        existing.driverKind !== request.driverKind ||
        existing.submit === undefined
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "No interactive sign-in is pending",
        });
      }
      await existing.submit(request.value);
      // Settling replaces the entry, so the answer is what the Runner holds now:
      // a stored key reaches the dialog as ready without another round trip.
      return {
        driverKind: request.driverKind,
        harnessInstanceId: request.harnessInstanceId,
        state: this.#harnessAuthentications.get(request.harnessInstanceId)?.state ?? {
          status: "not-started",
        },
      };
    }
    if (request.action !== "start") {
      const existing = await this.#liveAuthentication(request.harnessInstanceId);
      if (existing && existing.driverKind !== request.driverKind) {
        throw new OpensteerError({
          code: "conflict",
          message: "AI engine sign-in targets a different harness driver",
        });
      }
      if (request.action === "cancel") {
        await this.#discardAuthentication(request.harnessInstanceId);
        return {
          driverKind: request.driverKind,
          harnessInstanceId: request.harnessInstanceId,
          state: { status: "not-started" },
        };
      }
      return {
        driverKind: request.driverKind,
        harnessInstanceId: request.harnessInstanceId,
        state: existing?.state ?? { status: "not-started" },
      };
    }

    const { harness } = request;
    const existing = this.#harnessAuthentications.get(harness.id);
    if (this.#driverAuthenticationIsStopping(harness.driverKind)) {
      throw new OpensteerError({
        code: "conflict",
        message: "This AI engine sign-in is still stopping",
        retryable: true,
      });
    }
    if (existing && existing.expiresAt > Date.now()) {
      if (existing.driverKind !== harness.driverKind) {
        throw new OpensteerError({
          code: "conflict",
          message: "AI engine sign-in targets a different harness driver",
        });
      }
      // Only a live interaction is replayed. A start against a profile that
      // already reported ready is a deliberate re-authentication, so it must
      // run the provider's setup again instead of silently doing nothing.
      if (
        (existing.state.status === "not-started" || existing.state.status === "pending") &&
        existing.methodId === request.methodId &&
        existing.connectionSlot === request.connectionSlot
      ) {
        return {
          driverKind: harness.driverKind,
          harnessInstanceId: harness.id,
          state: existing.state,
        };
      }
    }
    if (this.#harnessMaintenance.has(harness.id)) {
      throw new OpensteerError({
        code: "conflict",
        message: "This AI engine is busy; wait before signing in",
        retryable: true,
      });
    }
    if (
      this.#driverMaintenance.has(harness.driverKind) &&
      this.#harnesses.installationAffects(harness.driverKind, harness.stateKind)
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "This AI engine is updating; wait before signing in",
        retryable: true,
      });
    }
    const priorStartup = this.#harnessAuthenticationStartupsByInstance.get(harness.id);
    const startup = new AbortController();
    const startupSignal = AbortSignal.any([
      this.#harnessAuthenticationLifetime.signal,
      signal,
      startup.signal,
    ]);
    let finishAuthenticationProcess!: () => void;
    const authenticationCompletion = new Promise<void>((resolvePromise) => {
      finishAuthenticationProcess = resolvePromise;
    });
    const startingEntry: HarnessAuthenticationEntry = {
      cancel: async () => startup.abort(new Error("AI engine sign-in canceled")),
      completion: authenticationCompletion,
      ...(request.connectionSlot ? { connectionSlot: request.connectionSlot } : {}),
      driverKind: harness.driverKind,
      expiresAt: Date.now() + harnessAuthenticationLifetimeMs,
      methodId: request.methodId,
      state: { status: "not-started" },
    };
    this.#harnessAuthentications.set(harness.id, startingEntry);
    const startupTask = (async () => {
      try {
        await existing?.cancel?.().catch(() => undefined);
        await priorStartup;
        if (this.#harnessAuthentications.get(harness.id) !== startingEntry) {
          finishAuthenticationProcess();
          return;
        }
        if (startupSignal.aborted) throw startupSignal.reason;
        await mkdir(this.#privateStateDirectory, { mode: 0o700, recursive: true });
        await setPrivateDirectoryMode(this.#privateStateDirectory);
        const options = await this.#providerStateOptions(harness.driverKind);
        const { providerState } = await prepareHarnessProviderState(harness, options);
        if (this.#harnessAuthentications.get(harness.id) !== startingEntry) {
          finishAuthenticationProcess();
          return;
        }
        if (startupSignal.aborted) throw startupSignal.reason;
        const started = await this.#harnesses.authenticateDefinition(
          harness,
          options.environment,
          this.#harnessRuntimeBoundary,
          providerState,
          this.#privateStateDirectory,
          startupSignal,
          {
            ...(request.connectionSlot ? { connectionSlot: request.connectionSlot } : {}),
            methodId: request.methodId,
          },
        );
        if (started.status === "pending") {
          void started.result.then(finishAuthenticationProcess, finishAuthenticationProcess);
        } else {
          finishAuthenticationProcess();
        }
        if (startupSignal.aborted) {
          this.#failAuthentication(harness.id, startingEntry, startupSignal.reason);
          if (started.status === "pending") {
            await started.cancel().then(finishAuthenticationProcess, () => undefined);
          }
          return;
        }
        if (this.#harnessAuthentications.get(harness.id) !== startingEntry) {
          if (started.status === "pending") {
            await started.cancel().then(finishAuthenticationProcess, () => undefined);
          }
          return;
        }
        const expiresAt = Date.now() + harnessAuthenticationLifetimeMs;
        if (started.status === "ready") {
          this.#harnessAuthentications.set(harness.id, {
            ...(request.connectionSlot ? { connectionSlot: request.connectionSlot } : {}),
            driverKind: harness.driverKind,
            expiresAt,
            methodId: request.methodId,
            state: { status: "ready" },
          });
          return;
        }
        const entry: HarnessAuthenticationEntry = {
          cancel: started.cancel,
          completion: authenticationCompletion,
          ...(request.connectionSlot ? { connectionSlot: request.connectionSlot } : {}),
          driverKind: harness.driverKind,
          expiresAt,
          methodId: request.methodId,
          state: {
            challenge: started.challenge,
            ...(request.connectionSlot ? { connectionSlot: request.connectionSlot } : {}),
            methodId: request.methodId,
            status: "pending",
          },
          ...(started.submit ? { submit: started.submit } : {}),
        };
        this.#harnessAuthentications.set(harness.id, entry);
        void started.result.then(
          (state) => this.#finishAuthentication(harness.id, entry, state),
          (error) => this.#failAuthentication(harness.id, entry, error),
        );
      } catch (error) {
        finishAuthenticationProcess();
        this.#failAuthentication(harness.id, startingEntry, error);
      }
    })();
    this.#harnessAuthenticationStartups.add(startupTask);
    this.#harnessAuthenticationStartupsByInstance.set(harness.id, startupTask);
    const forgetStartup = () => {
      this.#harnessAuthenticationStartups.delete(startupTask);
      if (this.#harnessAuthenticationStartupsByInstance.get(harness.id) === startupTask) {
        this.#harnessAuthenticationStartupsByInstance.delete(harness.id);
      }
    };
    void startupTask.then(forgetStartup, forgetStartup);
    return {
      driverKind: harness.driverKind,
      harnessInstanceId: harness.id,
      state: startingEntry.state,
    };
  }

  #finishAuthentication(
    harnessInstanceId: string,
    entry: HarnessAuthenticationEntry,
    state: HarnessAuthenticationState,
  ): void {
    if (this.#harnessAuthentications.get(harnessInstanceId) !== entry) return;
    this.#harnessAuthentications.set(harnessInstanceId, {
      ...(entry.connectionSlot ? { connectionSlot: entry.connectionSlot } : {}),
      driverKind: entry.driverKind,
      expiresAt: entry.expiresAt,
      ...(entry.methodId ? { methodId: entry.methodId } : {}),
      state,
    });
  }

  #failAuthentication(
    harnessInstanceId: string,
    entry: HarnessAuthenticationEntry,
    error: unknown,
  ): void {
    if (this.#harnessAuthentications.get(harnessInstanceId) !== entry) return;
    this.#harnessAuthentications.set(harnessInstanceId, {
      driverKind: entry.driverKind,
      expiresAt: entry.expiresAt,
      state: {
        detail: error instanceof Error ? error.message.slice(0, 500) : "AI engine sign-in failed",
        status: "failed",
      },
    });
  }

  /**
   * Reads the interaction state the Host may still act on. An attempt that
   * outlived the Host's own bounded attempt lifetime is treated as absent and
   * cancelled here, so a dead device code can never be replayed forever.
   */
  async #liveAuthentication(
    harnessInstanceId: string,
  ): Promise<HarnessAuthenticationEntry | undefined> {
    const existing = this.#harnessAuthentications.get(harnessInstanceId);
    if (!existing) return undefined;
    if (existing.stopping) return existing;
    if (existing.expiresAt > Date.now()) return existing;
    await this.#discardAuthentication(harnessInstanceId);
    return undefined;
  }

  /** Cancels one interaction and forgets it only once its process is gone. */
  async #discardAuthentication(harnessInstanceId: string, awaitStartup = false): Promise<void> {
    const existing = this.#harnessAuthentications.get(harnessInstanceId);
    const startup = this.#harnessAuthenticationStartupsByInstance.get(harnessInstanceId);
    if (!existing) {
      if (awaitStartup && startup) {
        await withTimeout(startup, runtimeTaskStopWaitMs, {
          timeoutError: () =>
            new OpensteerError({
              code: "conflict",
              message: "AI engine sign-in did not stop before the maintenance deadline",
              retryable: true,
            }),
        });
      }
      return;
    }
    if (existing.stopping && !existing.stoppingFailed) {
      if (!awaitStartup) {
        throw new OpensteerError({
          code: "conflict",
          message: "Opensteer is still stopping the sign-in; try again",
          retryable: true,
        });
      }
      await withTimeout(existing.stopping, runtimeTaskStopWaitMs, {
        timeoutError: () =>
          new OpensteerError({
            code: "conflict",
            message: "AI engine sign-in did not stop before the maintenance deadline",
            retryable: true,
          }),
      });
      return;
    }

    const cancel = existing.cancel;
    const cancellation = cancel ? Promise.resolve().then(cancel) : undefined;
    if (!cancellation && !existing.completion && !startup) {
      this.#harnessAuthentications.delete(harnessInstanceId);
      return;
    }
    const cancellationProof = cancellation;
    const stopping = startup
      ? Promise.all(
          [startup, existing.completion, cancellationProof].filter(
            (task): task is Promise<void> => task !== undefined,
          ),
        ).then(() => undefined)
      : existing.completion
        ? Promise.race(
            [existing.completion, cancellationProof].filter(
              (task): task is Promise<void> => task !== undefined,
            ),
          )
        : (cancellationProof ?? Promise.resolve());
    const stoppingEntry: HarnessAuthenticationEntry = {
      ...existing,
      stopping,
      stoppingFailed: false,
    };
    this.#harnessAuthentications.set(harnessInstanceId, stoppingEntry);
    void stopping.then(
      () => {
        if (this.#harnessAuthentications.get(harnessInstanceId) === stoppingEntry) {
          this.#harnessAuthentications.delete(harnessInstanceId);
        }
      },
      () => {
        if (this.#harnessAuthentications.get(harnessInstanceId) === stoppingEntry) {
          const failedEntry: HarnessAuthenticationEntry = {
            ...existing,
            stopping: Promise.resolve(),
            stoppingFailed: true,
          };
          this.#harnessAuthentications.set(harnessInstanceId, failedEntry);
          void existing.completion?.then(() => {
            if (this.#harnessAuthentications.get(harnessInstanceId) === failedEntry) {
              this.#harnessAuthentications.delete(harnessInstanceId);
            }
          });
        }
      },
    );

    if (!awaitStartup) {
      await cancellation;
      return;
    }
    const shutdown = startup
      ? Promise.all(
          [startup, existing.completion, cancellation].filter(
            (task): task is Promise<void> => task !== undefined,
          ),
        ).then(() => undefined)
      : existing.completion
        ? Promise.race(
            [existing.completion, cancellation].filter(
              (task): task is Promise<void> => task !== undefined,
            ),
          )
        : (cancellation ?? Promise.resolve());
    await withTimeout(shutdown, runtimeTaskStopWaitMs, {
      timeoutError: () =>
        new OpensteerError({
          code: "conflict",
          message: "AI engine sign-in did not stop before the maintenance deadline",
          retryable: true,
        }),
    });
  }

  #driverAuthenticationIsStopping(driverKind: HarnessId): boolean {
    for (const authentication of this.#harnessAuthentications.values()) {
      if (authentication.driverKind === driverKind && authentication.stopping) return true;
    }
    return false;
  }

  handleCommand(command: RunnerCommand, sink: RunnerMessageSink): Promise<CommandDecision> {
    return this.#ledger.execute(command, async () => {
      if (command.environmentId !== this.#environmentId) {
        return reject("forbidden", "Command targets a different execution environment", false);
      }
      switch (command.type) {
        case "run.execute":
          return this.#admitExecution(command, sink);
        case "trigger.execute":
          return this.#admitTriggerProgram(command, sink);
        case "watch.reconcile":
          await this.#watchSupervisor.reconcile(command, sink);
          return { status: "accepted" };
        case "trigger.interrupt":
          return this.#interruptTrigger(command.occurrenceId);
        case "run.interrupt":
          return this.#interrupt(command.runId, command.threadId, command.bindingGeneration);
        case "request.resolve":
          return this.#resolveRequest(command.runId, command.requestId, command.response);
        case "run.steer":
          return this.#steer(command);
        case "workspace.mount":
          return this.#mountWorkspace(command);
        case "workspace.detach":
          return this.#detachWorkspace(command);
        case "harness.update":
          return this.#startHarnessUpdate(command.driverKind, sink);
      }
    });
  }

  async #startHarnessUpdate(
    driverKind: HarnessId,
    sink: RunnerMessageSink,
  ): Promise<CommandDecision> {
    if (this.#harnessRuntimeBoundary.kind !== "native-user") {
      return reject(
        "forbidden",
        "Installed AI engines can only be updated on a person's computer",
        false,
      );
    }
    if (this.#driverMaintenance.has(driverKind)) {
      return reject("conflict", "This AI engine is already updating", true);
    }
    this.#driverMaintenance.add(driverKind);
    let admitted = false;
    try {
      for (const active of this.#runs.values()) {
        if (
          active.command.context.harness.driverKind === driverKind &&
          this.#harnesses.installationAffects(driverKind, active.command.context.harness.stateKind)
        ) {
          return reject(
            "conflict",
            "This AI engine is in use. End its active run before updating.",
            true,
          );
        }
      }
      for (const [harnessInstanceId, authentication] of this.#harnessAuthentications) {
        const definition = this.#harnesses.state(
          harnessInstanceId as HarnessInstanceId,
        )?.definition;
        if (
          definition?.driverKind !== driverKind ||
          !this.#harnesses.installationAffects(driverKind, definition.stateKind)
        )
          continue;
        if (authentication.stopping && !authentication.stoppingFailed)
          return reject(
            "conflict",
            "Opensteer couldn't stop the sign-in in progress; try again",
            true,
          );
        if (authentication.expiresAt <= Date.now()) {
          try {
            await this.#discardAuthentication(harnessInstanceId, true);
          } catch {
            return reject(
              "conflict",
              "Opensteer couldn't stop the sign-in in progress; try again",
              true,
            );
          }
          continue;
        }
        if (
          authentication.state.status === "not-started" ||
          authentication.state.status === "pending"
        )
          return reject(
            "conflict",
            "This AI engine is signing in. Finish or cancel sign-in before updating.",
            true,
          );
      }
      const resolved = await this.#harnesses.driverInstallation(driverKind).catch(() => undefined);
      if (!resolved) return reject("not_found", "This installed AI engine is not available", false);
      if (!resolved.plan) {
        return reject(
          "conflict",
          resolved.descriptor.detail ?? "Update this AI engine with the tool that installed it.",
          false,
        );
      }
      this.#driverInstallationFacts.set(driverKind, resolved.descriptor);
      const updating: HarnessInstallation = { ...resolved.descriptor, update: "updating" };
      this.#driverInstallationOperations.set(driverKind, updating);
      try {
        await this.#publishDriverInstallation(driverKind, updating, sink);
      } catch (error) {
        this.#driverInstallationOperations.delete(driverKind);
        this.#pendingDriverInstallationAdvertisements.set(driverKind, resolved.descriptor);
        throw error;
      }
      const task = this.#performHarnessUpdate(driverKind, resolved.plan, resolved.descriptor, sink);
      this.#installationTasks.add(task);
      void task.finally(() => this.#installationTasks.delete(task));
      admitted = true;
      return { status: "accepted" };
    } finally {
      if (!admitted) this.#driverMaintenance.delete(driverKind);
    }
  }

  async #performHarnessUpdate(
    driverKind: HarnessId,
    plan: EngineUpdatePlan,
    previous: HarnessInstallation,
    sink: RunnerMessageSink,
  ): Promise<void> {
    let outcome: HarnessInstallation;
    try {
      await this.#warm.evict((engine) => {
        const definition = this.#harnesses.state(engine.harnessInstanceId)?.definition;
        return (
          definition?.driverKind === driverKind &&
          this.#harnesses.installationAffects(driverKind, definition.stateKind)
        );
      });
      const prior = this.#installationQueues.get(plan.serializationKey) ?? Promise.resolve();
      const operation = prior.then(async () => {
        const child = spawnSupervised({
          args: plan.args,
          cwd: process.cwd(),
          environment: plan.environment,
          executable: plan.executable,
          maxOutputBytes: 16 * 1_024,
          signal: this.#installationLifetime.signal,
        });
        let expired = false;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        let outputGrace: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<undefined>((resolve) => {
          deadline = setTimeout(() => {
            expired = true;
            resolve(undefined);
          }, engineUpdateDeadlineMs);
        });
        const output = Promise.all([
          collectProcessOutput(child.stdout),
          collectProcessOutput(child.stderr),
        ]);
        void output.catch(() => undefined);
        try {
          const exit = await Promise.race([child.exited, timedOut]);
          if (exit) {
            await Promise.race([
              output,
              timedOut,
              new Promise<void>((resolve) => {
                outputGrace = setTimeout(resolve, engineUpdateOutputGraceMs);
              }),
            ]);
          }
          if (expired || !exit) throw new Error("The update didn't finish in time.");
          if (exit.code !== 0) {
            throw new Error(`Updater exited with code ${exit.code ?? "unknown"}`);
          }
        } finally {
          clearTimeout(deadline);
          clearTimeout(outputGrace);
          try {
            await child.terminate(0).catch((error: unknown) => {
              if (!expired) throw error;
            });
          } finally {
            // An orphan can keep inherited pipes open even after its parent exits.
            child.child.stdout.destroy();
            child.child.stderr.destroy();
            await output.catch(() => undefined);
          }
        }
      });
      this.#installationQueues.set(
        plan.serializationKey,
        operation.catch(() => undefined),
      );
      const failure = await operation.then(
        () => undefined,
        (error: unknown) => ({ error }),
      );
      // A failed or ended updater may still have replaced some of the engine's files.
      const affected = await this.#harnesses.invalidateDriver(driverKind);
      for (const harnessInstanceId of affected) {
        this.#pendingHarnessCatalogInvalidations.add(harnessInstanceId);
      }
      if (failure) throw failure.error;
      const refreshed = await this.#harnesses.driverInstallation(driverKind);
      const succeeded: HarnessInstallation = {
        ...(refreshed?.descriptor ?? previous),
        detail: "Update finished.",
        update: "succeeded",
      };
      const current = refreshed?.descriptor ?? previous;
      this.#driverInstallationFacts.set(driverKind, current);
      outcome = succeeded;
    } catch (error) {
      outcome = {
        ...previous,
        detail: safeMessage(error, safeMessageOptions).slice(0, 2_000),
        update: "failed",
      };
    } finally {
      this.#driverInstallationOperations.set(driverKind, outcome!);
      await Promise.allSettled([
        this.#publishDriverInstallationOutcome(driverKind, outcome!, sink),
        this.#publishPendingHarnessCatalogInvalidations(sink),
      ]);
      this.#driverMaintenance.delete(driverKind);
    }
  }

  /**
   * The Host ended these Runs without them. Each one stops at once and says
   * nothing more: its outcome is durable on the Host already.
   */
  revokeRuns(revocations: readonly { readonly reason: string; readonly runId: RunId }[]): void {
    for (const { reason, runId } of revocations) {
      this.#settledRuns.delete(runId);
      const active = this.#runs.get(runId);
      if (!active) continue;
      active.revoked = true;
      active.live.close();
      this.#endLocalAccess(active);
      active.abort.abort(new Error(reason));
    }
  }

  /**
   * Ends what the engine reaches the Host, the browser and other computers
   * through, and the streams and connections held open on them, now rather
   * than once the engine has stopped. The Host has already ended the authority
   * behind them; this stops the engine working against dead tools.
   */
  #endLocalAccess(active: ActiveRun): void {
    active.localAccessEnded = true;
    active.credentialProxy?.revoke();
    void active.browserCdpRelay?.close().catch(() => undefined);
    void active.machineAccessRelay?.suspend();
  }

  /**
   * Resolves `executionStopGraceMs` after the Run is stopped, once the Runner
   * has ended the Run's processes itself. An engine that does not wind down in
   * time is not waited on.
   */
  #haltAfterGrace(active: ActiveRun): Promise<void> {
    return new Promise((resolve) => {
      const halt = () => {
        const timer = setTimeout(() => {
          void this.#containment
            .terminate(active.containmentScope)
            .catch(() => undefined)
            .then(() => resolve());
        }, executionStopGraceMs);
        timer.unref?.();
      };
      if (active.abort.signal.aborted) halt();
      else active.abort.signal.addEventListener("abort", halt, { once: true });
    });
  }

  /**
   * Keeps a Thread closed to new executions until the processes its last Run
   * left behind are proven gone, retrying their termination meanwhile.
   */
  #holdUncontainedThread(threadId: ThreadId, runId: RunId | null, executionId: string): void {
    this.#uncontainedThreads.set(threadId, executionId);
    this.#logger?.error("A stopped Run left processes the Runner could not end", {
      ...(runId ? { runId } : {}),
      threadId,
    });
    const retry = setInterval(() => {
      void this.#containment
        .terminate(executionId)
        .catch(() => "unknown" as const)
        .then((termination) => {
          if (termination !== "proven") return;
          clearInterval(retry);
          if (this.#uncontainedThreads.get(threadId) === executionId) {
            this.#uncontainedThreads.delete(threadId);
          }
        });
    }, uncontainedRetryMs);
    retry.unref?.();
  }

  /**
   * Every Run this Runner holds, for the attach message that opens each new
   * connection: executing Runs and ended ones with unacknowledged events.
   */
  attachInventory(): Extract<
    RunnerOperationalReport,
    { readonly type: "runner.executions.attach" }
  >["executions"] {
    this.#attachRequestedAt = this.#executionNow();
    return [...this.#runs.values(), ...this.#settledRuns.values()].map((active) => ({
      bindingGeneration: active.command.context.bindingGeneration,
      environmentId: active.command.context.environmentId,
      nextOrdinal: active.nextOrdinal,
      runId: active.command.context.runId,
      terminal: active.journal.terminal,
      threadId: active.command.context.threadId,
      workspaceId: active.command.context.workspaceId,
    }));
  }

  /**
   * Applies the Host's answer to the attach message and resumes reporting on
   * this connection. An attached Run replays what the Host has not committed,
   * from `nextOrdinal`, then states its streams again; a revoked one stops.
   */
  async attach(
    answer: Extract<HostToRunnerMessage, { readonly type: "host.executions.attached" }>,
    sink: RunnerMessageSink,
  ): Promise<void> {
    this.#connection = sink;
    const answered = new Set<RunId>();
    const revoked: { readonly reason: string; readonly runId: RunId }[] = [];
    const resumed: Promise<void>[] = [];
    for (const result of answer.results) {
      answered.add(result.runId);
      const active = this.#runs.get(result.runId) ?? this.#settledRuns.get(result.runId);
      if (!active) continue;
      if (result.status === "revoked") {
        revoked.push({ reason: result.reason, runId: result.runId });
        continue;
      }
      this.#grantLease(
        active,
        (this.#attachRequestedAt ?? this.#executionNow()) + leaseLeadMs(answer.leaseMs),
      );
      const { journal } = active;
      for (const [ordinal, entry] of journal.events) {
        if (ordinal >= result.nextOrdinal) continue;
        journal.events.delete(ordinal);
        journal.bytes -= entry.bytes;
      }
      journal.sentThrough = result.nextOrdinal - 1;
      journal.sessionBoundSent = false;
      resumed.push(
        this.#pumpJournal(active).then(() => {
          if (this.#runs.has(result.runId)) active.live.resynchronize();
          this.#releaseIfSettled(active);
        }),
      );
    }
    // A Run the Host did not answer for is one it does not hold.
    for (const active of [...this.#runs.values(), ...this.#settledRuns.values()]) {
      const runId = active.command.context.runId;
      if (!answered.has(runId)) revoked.push({ reason: "The Host does not hold this Run", runId });
    }
    if (revoked.length > 0) this.revokeRuns(revoked);
    await Promise.all(resumed);
    for (const [driverKind, installation] of this.#pendingDriverInstallationAdvertisements) {
      const operation = this.#driverInstallationOperations.get(driverKind);
      if (
        operation === installation &&
        (installation.update === "failed" || installation.update === "succeeded")
      ) {
        await this.#publishDriverInstallationOutcome(driverKind, installation, sink);
      } else {
        await this.#publishDriverInstallation(driverKind, installation, sink);
      }
    }
    await this.#publishPendingHarnessCatalogInvalidations(sink);
  }

  /** Forgets what the Host has committed; nothing acknowledged is replayed again. */
  acknowledge(
    acks: Extract<HostToRunnerMessage, { readonly type: "host.events.acked" }>["acks"],
  ): void {
    for (const ack of acks) {
      const active = this.#runs.get(ack.runId) ?? this.#settledRuns.get(ack.runId);
      if (!active) continue;
      const { journal } = active;
      for (const [ordinal, entry] of journal.events) {
        if (ordinal > ack.throughOrdinal) continue;
        journal.events.delete(ordinal);
        journal.bytes -= entry.bytes;
      }
      if (ack.sessionBound) journal.sessionBound = null;
      this.#releaseIfSettled(active);
    }
  }

  /** Extends the named Runs' leases from the heartbeat the Host renewed them on. */
  renewLeases(
    renewal: Extract<HostToRunnerMessage, { readonly type: "host.executions.renewed" }>,
  ): void {
    const deadline = Date.parse(renewal.heartbeatSentAt) + leaseLeadMs(renewal.leaseMs);
    for (const runId of renewal.runIds) {
      const active = this.#runs.get(runId);
      if (active) this.#grantLease(active, deadline);
    }
  }

  /**
   * Applies a lease the Host granted, measured from a moment this Runner chose
   * before the grant. It replaces the deadline taken at admission, which no
   * grant was measured from, and otherwise only ever extends the lease.
   */
  #grantLease(active: ActiveRun, deadline: number): void {
    active.leaseDeadline = active.leaseCorrelated
      ? Math.max(active.leaseDeadline, deadline)
      : deadline;
    active.leaseCorrelated = true;
    active.leaseGrant.resolve();
  }

  /**
   * Sends a Run's journal on the current connection in ordinal order, from the
   * last event sent. One send runs at a time per Run, so an event emitted
   * during a replay can never overtake the ones being replayed.
   */
  #pumpJournal(active: ActiveRun): Promise<void> {
    const { journal } = active;
    journal.sending = journal.sending.then(async () => {
      const connection = this.#connection;
      if (!connection || active.revoked) return;
      // A send that resolves after its connection was replaced counts for
      // nothing: the new connection's attach answer says where to resume.
      if (journal.sessionBound && !journal.sessionBoundSent) {
        try {
          await connection.send(journal.sessionBound);
        } catch {
          return;
        }
        if (this.#connection !== connection) return;
        journal.sessionBoundSent = true;
      }
      for (;;) {
        if (this.#connection !== connection || active.revoked) return;
        const next = journal.events.get(journal.sentThrough + 1);
        if (!next) return;
        try {
          await connection.send({ event: next.event, type: "runner.event" });
        } catch {
          // The next connection replays from what the Host says it committed.
          return;
        }
        if (this.#connection !== connection) return;
        journal.sentThrough += 1;
      }
    });
    return journal.sending;
  }

  /** Sends one ephemeral message if a connection is up; a lost one costs nothing durable. */
  async #transmit(message: RunnerOperationalReport): Promise<void> {
    const connection = this.#connection;
    if (!connection) return;
    await connection.send(message).catch(() => undefined);
  }

  #releaseIfSettled(active: ActiveRun): void {
    const runId = active.command.context.runId;
    if (this.#settledRuns.get(runId) === active && journalSettled(active.journal)) {
      this.#settledRuns.delete(runId);
    }
  }

  #watchLeases(): void {
    if (this.#stopLeaseWatchdog) return;
    const clock = this.#executionClock;
    if (!clock) {
      const timer = setInterval(() => this.#enforceLeases(), 1_000);
      timer.unref?.();
      this.#stopLeaseWatchdog = () => clearInterval(timer);
      return;
    }
    let cancel: () => void = () => undefined;
    const tick = () => {
      this.#enforceLeases();
      if (this.#stopLeaseWatchdog) cancel = clock.schedule(tick, 1_000);
    };
    this.#stopLeaseWatchdog = () => cancel();
    cancel = clock.schedule(tick, 1_000);
  }

  /**
   * A Run whose lease ran out without a renewal stops here, whatever the Host
   * can or cannot tell it: the Host classifies the lost execution, and acting past that
   * point would be acting without its authority.
   */
  #enforceLeases(): void {
    const now = this.#executionNow();
    for (const active of this.#runs.values()) {
      if (active.leaseDeadline > now || active.abort.signal.aborted) continue;
      this.#endLocalAccess(active);
      active.interruptionCause = "lease-lost";
      active.abort.abort(new Error("The Run's execution lease ran out without the Host"));
    }
    let settledBytes = 0;
    for (const active of this.#settledRuns.values()) settledBytes += active.journal.bytes;
    for (const [runId, active] of this.#settledRuns) {
      if (
        active.settledAt + settledJournalRetentionMs > now &&
        settledBytes <= maxSettledJournalBytes
      )
        break;
      settledBytes -= active.journal.bytes;
      this.#settledRuns.delete(runId);
    }
    if (this.#runs.size === 0 && this.#settledRuns.size === 0 && this.#stopLeaseWatchdog) {
      this.#stopLeaseWatchdog();
      this.#stopLeaseWatchdog = undefined;
    }
  }

  async connectionLost(sink: RunnerMessageSink): Promise<void> {
    // Runs keep executing: they hold leases the Host renews, and what they
    // report waits in each Run's journal for the next connection. Trigger
    // programs and watches belong to the connection that started them.
    if (this.#connection === sink) this.#connection = null;
    const tasks: Promise<void>[] = [];
    for (const active of this.#triggerPrograms.values()) {
      if (active.sink !== sink) continue;
      active.abort.abort(new Error("Host connection was lost"));
      if (active.task) tasks.push(active.task);
    }
    tasks.push(this.#watchSupervisor.connectionLost(sink));
    await Promise.allSettled(tasks);
  }

  async close(): Promise<void> {
    this.#draining = true;
    const voiceClosed = this.#voice.close();
    this.#stopLeaseWatchdog?.();
    this.#stopLeaseWatchdog = undefined;
    this.#harnessAuthenticationLifetime.abort(new Error("Runner is shutting down"));
    this.#installationLifetime.abort(new Error("Runner is shutting down"));
    for (const active of this.#runs.values()) {
      active.shutdown = true;
      this.#endLocalAccess(active);
      active.abort.abort(new Error("Runner is shutting down"));
    }
    for (const active of this.#triggerPrograms.values()) {
      active.abort.abort(new Error("Runner is shutting down"));
    }
    await Promise.allSettled([
      voiceClosed,
      ...[...this.#runs.values(), ...this.#triggerPrograms.values()].flatMap((active) =>
        active.task ? [active.task] : [],
      ),
    ]);
    await this.#watchSupervisor.close();
    await settlesWithin([...this.#harnessAuthenticationStartups], runtimeTaskStopWaitMs);
    await settlesWithin([...this.#installationTasks], runtimeTaskStopWaitMs);
    await settlesWithin([...this.#driverInstallationInspections.values()], runtimeTaskStopWaitMs);
    await settlesWithin([this.#warm.close()], runtimeTaskStopWaitMs);
    await this.#sessions.stopAll();
    await this.#workspaceMountRegistry?.detachAll();
    await this.#harnesses.close();
  }

  activeWatchActivationIds(): readonly TriggerWatchActivationId[] {
    return this.#watchSupervisor.activeActivationIds();
  }

  #admitExecution(
    command: Extract<RunnerCommand, { readonly type: "run.execute" }>,
    sink: RunnerMessageSink,
  ): CommandDecision {
    if (this.#draining) return reject("conflict", "Runner is draining", true);
    if (this.#harnessMaintenance.has(command.context.harnessInstanceId)) {
      return reject("conflict", "AI engine profile maintenance is in progress", true);
    }
    if (this.#driverAuthenticationIsStopping(command.context.harness.driverKind)) {
      return reject("conflict", "AI engine sign-in is still stopping", true);
    }
    if (
      this.#driverMaintenance.has(command.context.harness.driverKind) &&
      this.#harnesses.installationAffects(
        command.context.harness.driverKind,
        command.context.harness.stateKind,
      )
    ) {
      return reject("conflict", "AI engine update is in progress", true);
    }
    const previous = this.#runs.get(command.context.runId);
    if (previous) {
      // A restarted Run's next attempt can arrive while the one it replaces is
      // still winding down here; it starts once that one has.
      return previous.command.context.bindingGeneration < command.context.bindingGeneration
        ? reject("conflict", "The Run's previous attempt is still stopping", true)
        : reject("conflict", "Run is already active", false);
    }
    if (this.#threads.has(command.context.threadId)) {
      return reject("conflict", "Thread already has an active run", true);
    }
    if (this.#uncontainedThreads.has(command.context.threadId)) {
      return reject("conflict", "The Thread's previous Run is still stopping", true);
    }
    if (this.#runs.size >= this.#maxConcurrentRuns) {
      return reject("conflict", "Runner Run concurrency limit is saturated", true);
    }
    if (command.context.environmentId !== command.environmentId) {
      return reject("forbidden", "Run context targets a different execution environment", false);
    }
    if (
      command.context.workspaceAccess.workspaceId !== command.context.workspaceId ||
      (command.context.workspaceAccess.kind === "local-directory" &&
        command.context.workspaceAccess.ownerEnvironmentId !== command.environmentId) ||
      (command.context.workspaceAccess.kind === "portablefs" &&
        (command.context.workspaceAccess.workspaceKind !== command.context.workspaceKind ||
          (command.context.workspaceKind === "main" &&
            command.context.workspaceAccess.createdBy !== command.context.requestedBy)))
    ) {
      return reject("forbidden", "Run Workspace access plan does not match its context", false);
    }
    if (!this.#harnesses.canRunDriver(command.context.harness.driverKind)) {
      return reject(
        "not_found",
        `Harness driver ${command.context.harness.driverKind} is unavailable on this Runner`,
        false,
      );
    }
    // Dispatch may use only a profile revision this Runner already reconciled.
    // A run never creates an unknown profile or advances a revision, so both
    // conditions are retryable: the Host reconciles and dispatches again.
    const reconciled = this.#harnesses.state(command.context.harnessInstanceId);
    if (!reconciled) {
      return reject(
        "not_found",
        `AI engine profile ${command.context.harnessInstanceId} is not reconciled on this Runner`,
        true,
      );
    }
    if (reconciled.definition.runtimeRevision !== command.context.harness.runtimeRevision) {
      return reject(
        "conflict",
        `AI engine profile ${command.context.harnessInstanceId} is reconciled at runtime revision ${reconciled.definition.runtimeRevision}, not ${command.context.harness.runtimeRevision}`,
        true,
      );
    }
    const { context } = command;
    // The connection that delivered the Run is the one it reports on.
    this.#connection ??= sink;
    // A restarted Run's next attempt continues the Run's ordinals.
    const firstOrdinal = context.firstOrdinal ?? 0;
    const active: ActiveRun = {
      abort: new AbortController(),
      command,
      emittedEventBytes: 0,
      emittedEvents: 0,
      journal: {
        bytes: 0,
        events: new Map(),
        sending: Promise.resolve(),
        sentThrough: firstOrdinal - 1,
        sessionBound: null,
        sessionBoundSent: false,
        terminal: false,
      },
      leaseCorrelated: false,
      leaseGrant: Promise.withResolvers<void>(),
      leaseDeadline: this.#executionNow() + leaseLeadMs(context.executionLeaseMs),
      leaseMs: context.executionLeaseMs,
      live: new LiveProgressBuffer({
        flushIntervalMs: liveFlushIntervalMs,
        maxInFlightBytes: liveMaxInFlightBytes,
        maxPendingBytes: liveMaxPendingBytes,
        maxSentBytes: liveMaxSentBytes,
        send: async (items) => {
          if (active.revoked) return;
          await this.#transmit({
            bindingGeneration: context.bindingGeneration,
            environmentId: context.environmentId,
            progress: {
              items: [...items],
              runId: context.runId,
              threadId: context.threadId,
              workspaceId: context.workspaceId,
            },
            type: "runner.live",
          });
        },
      }),
      containmentScope: runExecutionId(context),
      credentialLifetime: new AbortController(),
      nextOrdinal: firstOrdinal,
      pendingRequestIds: new Set(),
      saturatedToolDeltaCallIds: new Set(),
      steerTasks: new Set(),
      toolDeltaBytes: new Map(),
      workspaceIds: new Set([context.workspaceId]),
    };
    this.#watchLeases();
    // The Host dispatches a Run's next attempt only once it has committed the
    // previous one's end, so nothing of that one is still owed.
    const settled = this.#settledRuns.get(command.context.runId);
    if (settled && settled.command.context.bindingGeneration < command.context.bindingGeneration) {
      this.#settledRuns.delete(command.context.runId);
    }
    this.#runs.set(command.context.runId, active);
    this.#threads.set(command.context.threadId, command.context.runId);
    active.task = new Promise<void>((resolvePromise) => {
      setImmediate(() => {
        void this.#execute(active).then(resolvePromise, () => resolvePromise());
      });
    });
    return { status: "accepted" };
  }

  #admitTriggerProgram(
    command: Extract<RunnerCommand, { readonly type: "trigger.execute" }>,
    sink: RunnerMessageSink,
  ): CommandDecision {
    if (this.#draining) return reject("conflict", "Runner is draining", true);
    if (this.#triggerPrograms.has(command.context.occurrenceId)) {
      return reject("conflict", "Trigger occurrence is already active", false);
    }
    if (this.#triggerPrograms.size >= this.#maxConcurrentTriggerPrograms) {
      return reject("conflict", "Runner Trigger program concurrency limit is saturated", true);
    }
    if (
      command.context.workspaceAccess.workspaceId !== command.context.workspaceId ||
      (command.context.workspaceAccess.kind === "local-directory" &&
        command.context.workspaceAccess.ownerEnvironmentId !== command.environmentId)
    ) {
      return reject("forbidden", "Trigger Workspace access plan does not match its context", false);
    }
    const active: ActiveTriggerProgram = {
      abort: new AbortController(),
      command,
      sink,
      workspaceIds: new Set([command.context.workspaceId]),
    };
    this.#triggerPrograms.set(command.context.occurrenceId, active);
    active.task = new Promise<void>((resolvePromise) => {
      setImmediate(() => {
        void this.#executeTriggerProgram(active).then(resolvePromise, () => resolvePromise());
      });
    });
    return { status: "accepted" };
  }

  async #executeTriggerProgram(active: ActiveTriggerProgram): Promise<void> {
    const { context } = active.command;
    let workspace: RunWorkspace | undefined;
    let output: TriggerExecutionOutput | undefined;
    let endpoints: ProgramEndpointSet | undefined;
    // An interrupted occurrence loses its tools at once, not when its process exits.
    const endAccess = () => endpoints?.revoke();
    active.abort.signal.addEventListener("abort", endAccess, { once: true });
    try {
      workspace = await this.#workspaceManager.prepare({
        instructionsPath: null,
        plan: context.workspaceAccess,
        signal: active.abort.signal,
      });
      endpoints = await startProgramEndpoints({
        capabilities: () => context,
        transport: { mode: this.#mode },
      });
      active.abort.signal.throwIfAborted();
      output = await this.#programExecutor.execute({
        context,
        endpoints: endpoints.endpoints,
        planLaunch: (launch) => this.#planProgramLaunch(context.occurrenceId, launch),
        signal: active.abort.signal,
        workspace,
      });
    } catch (error) {
      output = {
        completedAt: new Date().toISOString(),
        error: active.abort.signal.aborted
          ? "Trigger program was canceled"
          : safeMessage(error, safeMessageOptions).slice(0, 20_000),
        exitCode: null,
        occurrenceId: context.occurrenceId,
        result: null,
        status: active.abort.signal.aborted ? "canceled" : "failed",
        stderr: "",
        stdout: "",
      };
    } finally {
      output ??= {
        completedAt: new Date().toISOString(),
        error: "Trigger program ended without an execution result",
        exitCode: null,
        occurrenceId: context.occurrenceId,
        result: null,
        status: "failed",
        stderr: "",
        stdout: "",
      };
      active.abort.signal.removeEventListener("abort", endAccess);
      await endpoints?.close();
      // Whatever the program left running ends with its occurrence.
      await this.#containment.terminate(context.occurrenceId).catch(() => undefined);
      await active.sink
        .send({
          environmentId: active.command.environmentId,
          executionGeneration: context.executionGeneration,
          output,
          type: "runner.trigger-result",
        })
        .catch(() => undefined);
      this.#triggerPrograms.delete(context.occurrenceId);
    }
  }

  /**
   * A Trigger or Watch program's launch: in the Runner sandbox where Runs are
   * sandboxed, and marked with its execution's scope so nothing it starts
   * outlives it.
   */
  async #planProgramLaunch(
    executionId: string,
    launch: Parameters<ProgramLaunchPlanner>[0],
  ): Promise<HarnessProcessLaunchWrapper> {
    return this.#containment.wrap(
      executionId,
      this.#harnessSandbox ? await this.#harnessSandbox.planProgram(launch) : (input) => input,
    );
  }

  async #execute(active: ActiveRun): Promise<void> {
    const { command } = active;
    const { context } = command;
    let workspace: RunWorkspace | undefined;
    let browserCdpRelay: BrowserCdpRelay | undefined;
    let credentialProxy: CredentialProxy | undefined;
    let machineAccessSetup: MachineAccessSetup | undefined;
    let agentControl: HttpAgentControlClient | undefined;
    let integrationSkills: Awaited<ReturnType<typeof materializeIntegrationSkills>> | undefined;
    let terminal: HarnessDurableEvent | undefined;
    let consumptionError: unknown;
    let titleTask: Promise<void> | undefined;
    let internalBinding: ReturnType<LiveSessionDirectory["acquire"]> | undefined;
    // An engine this Run took from the warm pool, or one it may leave there.
    let warmEngine: WarmEngine | undefined;
    let unlinkEngineLifetime: (() => void) | undefined;
    // Settles once a stopped Run's grace has passed and its processes have
    // been ended for it, so no wait on the engine outlasts that.
    const halted = this.#haltAfterGrace(active);
    try {
      // Delivery can outlast the durable lease. Only a grant measured from
      // this Runner's heartbeat or attach request permits execution to start.
      const { signal } = active.abort;
      signal.throwIfAborted();
      let abortAdmission: (() => void) | undefined;
      try {
        await Promise.race([
          active.leaseGrant.promise,
          new Promise<never>((_resolvePromise, rejectPromise) => {
            abortAdmission = () => rejectPromise(signal.reason);
            signal.addEventListener("abort", abortAdmission, { once: true });
          }),
        ]);
      } finally {
        if (abortAdmission) signal.removeEventListener("abort", abortAdmission);
      }
      if (active.leaseDeadline <= this.#executionNow()) {
        active.interruptionCause = "lease-lost";
        active.abort.abort(new Error("The Run's execution lease ran out without the Host"));
      }
      signal.throwIfAborted();
      workspace = await this.#workspaceManager.prepare({
        instructionsPath: context.workspaceInstructionsPath,
        plan: context.workspaceAccess,
        signal: active.abort.signal,
      });
      active.primaryWorkspace = workspace;
      const adapter = await this.#harnesses.adapter(context.harnessInstanceId);
      const transport = { deploymentShape: this.#deploymentShape, mode: this.#mode };
      const credentials = new RunCredentials(context);
      active.credentials = credentials;
      this.#scheduleCredentialRefresh(active, context.credentialRefreshAfterMs);
      const baseEnvironment = await this.#harnessEnvironment(context.harness.driverKind);
      // Both state kinds resolve through the same store record, so a Run and an
      // inspection of the same profile always project one continuation
      // namespace instead of two derived from different identities.
      const { providerState } = await prepareHarnessProviderState(
        { ...context.harness, id: context.harnessInstanceId },
        await this.#providerStateOptions(context.harness.driverKind),
      );
      if (!context.providerSessionId) {
        throw new OpensteerError({
          code: "harness_error",
          message: "Host did not provide the admitted provider session identity",
        });
      }
      if (
        context.providerSessionStateLayout !== "thread" &&
        context.providerSessionStateLayout !== "session"
      ) {
        throw new OpensteerError({
          code: "harness_error",
          message: "Host did not provide a valid provider session state layout",
        });
      }
      const threadStateDirectory =
        context.providerSessionStateLayout === "thread"
          ? join(this.#privateStateDirectory, "threads", context.threadId)
          : join(this.#privateStateDirectory, "sessions", context.providerSessionId);
      await mkdir(threadStateDirectory, { mode: 0o700, recursive: true });
      await setPrivateDirectoryMode(threadStateDirectory);
      const attachments = await this.#prepareAttachments(
        context.attachments,
        context.threadId,
        context.harness.driverKind,
        active.abort.signal,
      );
      const attachmentRoot = context.attachments ? this.#attachmentCache?.root : undefined;
      const attachmentDirectory = attachmentRoot
        ? join(attachmentRoot, context.threadId)
        : undefined;
      const attachmentContext =
        attachmentRoot && attachmentDirectory ? { attachmentDirectory, attachmentRoot } : {};
      this.#requireInputAttachments(command.inputs, attachments);
      this.#requireInputAttachments(command.reports.messages, attachments);
      const writableRoots = this.#workspaceManager.writableRoots({
        plan: context.workspaceAccess,
        requestedBy: context.requestedBy,
        workspaceKind: context.workspaceKind,
        workspacePath: workspace.path,
      });
      // The Thread's idle engine is this Run's to serve itself with or retire.
      // Once taken, no idle timeout or eviction retires it — emptying the
      // Thread's skills directory — while this Run writes its skills there.
      warmEngine = await this.#warm.take(context.threadId);
      if (
        warmEngine &&
        command.inputs.some(
          (message) =>
            message.author.kind === "platform" && message.author.cause === "run-recovery",
        )
      ) {
        await this.#retireWarmEngine(warmEngine);
        warmEngine = undefined;
      }
      const runSkills = await this.#integrationSkills({
        plan: context.integrationSkills,
        signal: active.abort.signal,
        stateDirectory: this.#privateStateDirectory,
        threadId: context.threadId,
      });
      integrationSkills = runSkills;
      const workspaceSkills = await discoverWorkspaceSkills(workspace.path);
      for (const warning of workspaceSkills.warnings) {
        this.#logger?.info(warning, {
          runId: context.runId,
          workspaceId: context.workspaceId,
        });
      }
      const skills = resolveSkillPlan({
        bundled: planAgentSkills(this.#agentSkills, context.agentTools.capabilityProfileId),
        integration: runSkills.skills,
        workspace: workspaceSkills.skills,
      });
      // An engine that outlives its Run serves the Thread's next one only when
      // everything it was started with is the same, the launch directory it
      // reaches other computers through included.
      const machineAccess = this.#machineAccess;
      const machineAccessPlan = machineAccess
        ? await planMachineAccess({
            accessMode: context.accessMode,
            driverKind: context.harness.driverKind,
            environment: baseEnvironment,
            helperBinary: machineAccess.helperBinary,
            machineAccess: context.machineAccess,
          })
        : undefined;
      const machineAccessRoutes =
        machineAccessPlan && isMachineAccessRoutes(machineAccessPlan)
          ? machineAccessPlan
          : undefined;
      const { instructions = null, path: workspacePath } = workspace;
      const warmKeyFor = (providerSessionReference: string | null, machineAccessLaunch: string) =>
        warmEngineKey({
          attachmentRoot: attachmentRoot ?? null,
          baseEnvironment,
          context,
          instructions,
          integrationSkillsDigest: runSkills.digest,
          machineAccessLaunch,
          providerSessionReference,
          skills,
          workspaceSkillsDigest: workspaceSkills.digest,
          runtimeBoundary: this.#harnessRuntimeBoundary.kind,
          workspacePath,
          writableRoots,
        });
      const warmKey =
        adapter.capabilities.warmReuse === true
          ? warmKeyFor(
              context.providerSessionReference ?? null,
              machineAccessLaunchIdentity(machineAccessPlan),
            )
          : undefined;
      if (warmEngine && warmEngine.key !== warmKey) {
        const retired = warmEngine;
        warmEngine = undefined;
        // This Run's skills already replaced the engine's, and are its own to remove.
        await this.#retireWarmEngine(retired, { keepSkills: true });
      }
      // An engine that may live on keeps its Thread from running anything else.
      if (this.#uncontainedThreads.has(context.threadId)) {
        throw new OpensteerError({
          code: "conflict",
          message: "The Thread's previous engine is still stopping",
          retryable: true,
        });
      }
      if (warmEngine) {
        warmEngine = { ...warmEngine, integrationSkills: runSkills };
        warmEngine.authority.credentials = credentials;
        warmEngine.credentialProxy.resume();
        warmEngine.browserCdpRelay.resume();
        browserCdpRelay = warmEngine.browserCdpRelay;
        credentialProxy = warmEngine.credentialProxy;
      }
      // A warm engine's proxy and relay carry whichever Run holds it now.
      const authority = warmEngine?.authority ?? { credentials };
      const current = (): RunCredentials => {
        if (!authority.credentials) throw new Error("No Run holds this engine");
        return authority.credentials;
      };
      const warmLifetime = warmKey && !warmEngine ? new AbortController() : undefined;
      // The engine hears of a stop only from here, and only once its
      // processes are noted, so what it orphans as it exits is still found
      // and ended. Its lifetime is the Runner's to end, not the Run's: a warm
      // engine outlives its Run.
      const engineLifetime = warmEngine?.lifetime ?? warmLifetime ?? new AbortController();
      const executionStop = new AbortController();
      {
        const { signal } = active.abort;
        const stopEngine = () => {
          void this.#containment
            .note(active.containmentScope)
            .catch(() => undefined)
            .finally(() => {
              executionStop.abort(signal.reason);
              engineLifetime.abort(signal.reason);
              void active.session?.interrupt().catch(() => undefined);
            });
        };
        signal.addEventListener("abort", stopEngine, { once: true });
        unlinkEngineLifetime = () => signal.removeEventListener("abort", stopEngine);
        if (signal.aborted) stopEngine();
      }
      if (!browserCdpRelay) {
        browserCdpRelay = new BrowserCdpRelay({
          plan: context.browserCdp,
          token: () => current().browserCdp,
          transport,
        });
      }
      const browserCdpUrl = warmEngine?.browserCdpUrl ?? (await browserCdpRelay.start());
      // The engine reaches the Host's tool endpoints only through this proxy,
      // with a secret that works nowhere else; Host tokens stay here.
      if (!credentialProxy) {
        credentialProxy = new CredentialProxy({
          routes: {
            "agent-tools": {
              token: () => current().agentTools,
              upstream: context.agentTools.url,
            },
            "integration-tools": {
              token: () => current().integrationTools,
              upstream: context.integrationTools.url,
            },
          },
          transport,
        });
      }
      const proxied = warmEngine?.proxied ?? (await credentialProxy.start());
      active.browserCdpRelay = browserCdpRelay;
      active.credentialProxy = credentialProxy;
      const warmScope = warmEngine?.scope ?? (warmKey ? `warm-${randomUUID()}` : undefined);
      if (warmScope) active.containmentScope = warmScope;
      // Everything the sandbox must expose is known before the harness starts;
      // only the machine-access launch directory arrives during setup.
      const sandboxPlan = {
        ...(attachmentDirectory ? { attachmentDirectory } : {}),
        environment: baseEnvironment,
        integrationSkillsDirectory: runSkills.directory,
        providerState,
        threadStateDirectory,
        workspacePath: workspace.path,
        writableRoots,
      } satisfies Omit<HarnessSandboxRunPlan, "launchDirectory">;
      let machineAccessUnavailable: MachineAccessUnavailableReason | undefined =
        machineAccessPlan && !isMachineAccessRoutes(machineAccessPlan)
          ? machineAccessPlan.reason
          : undefined;
      // A warm engine keeps the launch directory it started with; its key
      // says this Run's routes are the same. A new engine gets its own.
      if (!warmEngine && machineAccess && machineAccessRoutes) {
        const wrapModelCommand = await this.#harnesses.modelCommandLaunch(
          context.harness.driverKind,
          {
            accessMode: context.accessMode,
            ...attachmentContext,
            environment: baseEnvironment,
            providerState,
            runtimeBoundary: this.#harnessRuntimeBoundary,
            workspacePath: workspace.path,
            writableRoots,
          },
        );
        const outcome = await setupMachineAccess({
          environment: baseEnvironment,
          ...(this.#logger ? { logger: this.#logger } : {}),
          plan: machineAccessRoutes,
          privateStateRoot: this.#dataDirectory,
          runtimeBoundary: this.#harnessRuntimeBoundary,
          ...(machineAccess.validationHook ? { validationHook: machineAccess.validationHook } : {}),
          transport: {
            controlCaPath: machineAccess.controlCaPath,
            hostUrl: machineAccess.hostUrl,
            mode: this.#mode,
          },
          // The setup probe runs where the harness will run, so what it
          // proves is what the harness finds.
          workspacePath: workspace.path,
          wrapModelCommand,
          wrapProcessLaunch: async (launchDirectory) =>
            this.#containment.wrap(
              active.containmentScope,
              await this.#wrapProcessLaunch({ ...sandboxPlan, launchDirectory }),
            ),
        });
        if (isMachineAccessSetup(outcome)) machineAccessSetup = outcome;
        else machineAccessUnavailable = outcome.reason;
      }
      const launch = warmEngine ? warmEngine.machineAccess : machineAccessSetup;
      if (launch) active.machineAccessRelay = launch.relay;
      // The harness starts through the exact seam the probe went through, and
      // every process it starts carries this Run's scope.
      const wrapProcessLaunch = this.#containment.wrap(
        active.containmentScope,
        launch?.wrapProcessLaunch ??
          (await this.#wrapProcessLaunch({ ...sandboxPlan, launchDirectory: undefined })),
      );
      const environment = Object.freeze({
        ...(launch?.environment ?? baseEnvironment),
        OPENSTEER_AGENT_WORKSPACE: workspace.path,
        OPENSTEER_BROWSER_CDP_WS: browserCdpUrl,
        OPENSTEER_BROWSER_HARNESS: this.#browserHarnessExecutable,
      });
      agentControl = new HttpAgentControlClient({
        plan: context.agentControl,
        token: () => credentials.agentControl,
        transport,
      });
      const machineAccessContext = context.machineAccess;
      const sessionContext = {
        ...attachmentContext,
        accessMode: context.accessMode,
        agentControl,
        agentTools: {
          ...context.agentTools,
          token: proxied.secret,
          url: proxied.urls["agent-tools"],
        },
        integrationTools: { token: proxied.secret, url: proxied.urls["integration-tools"] },
        environment,
        environmentId: context.environmentId,
        history: context.history,
        historyWindow: context.historyWindow,
        initialContext: context.initialContext,
        harnessInstanceId: context.harnessInstanceId,
        instructions: workspace.instructions,
        // Setup that was skipped or failed leaves nothing reachable, and the
        // model is told so, with the reason, rather than left with an earlier
        // Run's inventory.
        machineAccessNotice:
          launch && machineAccessRoutes
            ? machineAccessRoutes.notice
            : renderMachineAccessNotice(
                {
                  callerMachineName: machineAccessContext.callerMachineName,
                  machines: [],
                  omittedMachines:
                    machineAccessContext.machines.length + machineAccessContext.omittedMachines,
                },
                Date.now(),
                machineAccessUnavailable,
              ),
        machineAccessPlatform: launch?.machineAccessPlatform,
        machineAccessRelaySocket: launch?.machineAccessRelaySocket,
        modelSelection: context.modelSelection,
        platformGuide: platformGuideForRun({
          capabilityProfileId: context.agentTools.capabilityProfileId,
          role: context.threadRole,
        }),
        providerState,
        runtimeBoundary: this.#harnessRuntimeBoundary,
        signal: engineLifetime.signal,
        skills,
        threadId: context.threadId,
        threadStateDirectory,
        workspaceId: context.workspaceId,
        workspacePath: workspace.path,
        wrapProcessLaunch,
        writableRoots,
      };
      if (!context.providerSessionReference) assertFreshProviderSessionContext(sessionContext);
      const engineStart = warmEngine ? "warm" : "cold";
      if (warmEngine) {
        warmEngine.session.rebind?.(sessionContext);
        active.session = warmEngine.session;
      } else {
        active.session = await Promise.race([
          context.providerSessionReference
            ? adapter.resumeSession(context.providerSessionReference, sessionContext)
            : adapter.startSession(sessionContext),
          halted.then(() => Promise.reject(active.abort.signal.reason)),
        ]);
        if (warmKey && warmScope && warmLifetime) {
          warmEngine = {
            authority,
            browserCdpRelay,
            browserCdpUrl,
            credentialProxy,
            harnessInstanceId: context.harnessInstanceId,
            integrationSkills: runSkills,
            // The next Run continues the conversation this session now holds.
            // A launch that failed its probe matches no Run's plan, so the
            // next Run with routes tries again on an engine of its own.
            key: warmKeyFor(
              active.session.providerSessionReference,
              machineAccessLaunchIdentity(
                machineAccessRoutes && !machineAccessSetup
                  ? { reason: "probe-failed" }
                  : machineAccessPlan,
              ),
            ),
            lifetime: warmLifetime,
            machineAccess: machineAccessSetup,
            proxied,
            scope: warmScope,
            session: active.session,
            threadId: context.threadId,
            workspaceId: context.workspaceId,
          };
        }
      }
      if (
        context.providerSessionReference &&
        active.session.providerSessionReference !== context.providerSessionReference
      ) {
        throw new OpensteerError({
          code: "harness_error",
          message: "AI engine resumed a different provider session",
        });
      }
      // The relay is this Run's only once its engine carries this Run's
      // context, and never after its access was cut.
      if (
        launch &&
        machineAccessRoutes &&
        !active.localAccessEnded &&
        !active.abort.signal.aborted
      ) {
        launch.relay.bind({
          credentials,
          runId: context.runId,
          targets: machineAccessTargets(machineAccessRoutes),
        });
      }
      internalBinding = this.#sessions.acquire({
        harnessInstanceId: context.harnessInstanceId,
        session: active.session,
        threadId: context.threadId,
      });
      active.journal.sessionBound = {
        bindingGeneration: context.bindingGeneration,
        engineStart,
        harnessInstanceId: context.harnessInstanceId,
        providerSessionId: context.providerSessionId,
        providerSessionReference: active.session.providerSessionReference,
        runId: context.runId,
        threadId: context.threadId,
        type: "runner.session-bound",
      };
      await this.#pumpJournal(active);

      titleTask = this.#generateThreadTitle(active, active.session);

      const consume = this.#consumeHarnessEvents(active, active.session)
        .then((value) => {
          // A stream that ends while the Runner is already failing the Run
          // says nothing of how it ended, and must not erase why.
          terminal = value ?? terminal;
        })
        .catch((error: unknown) => {
          consumptionError = error;
          active.abort.abort(error);
        });
      try {
        const execution = active.session.execute({
          attachments,
          context: {
            assignment: context.assignment,
            requesterTimeZone: context.requesterTimeZone,
            threadState: context.threadState,
          },
          environment,
          inputs: command.inputs,
          reports: command.reports,
          requestedBy: context.requestedBy,
          runId: context.runId,
          signal: executionStop.signal,
        });
        await Promise.race([execution, halted]);
      } catch (error) {
        if (!active.abort.signal.aborted) throw error;
      } finally {
        if (!terminal && active.abort.signal.aborted)
          await Promise.race([active.session.interrupt().catch(() => undefined), halted]);
      }
      // A warm engine has published its Run's end by now and must outlive it;
      // any other engine is stopped so its event stream ends.
      if (warmEngine && !active.abort.signal.aborted) await Promise.race([consume, halted]);
      await titleTask;
      if (!terminal) {
        await this.#containment.note(active.containmentScope).catch(() => undefined);
        await Promise.race([active.session.stop(), halted]);
      }
      await Promise.race([consume, halted]);
      if (consumptionError) throw consumptionError;
      terminal ??= active.abort.signal.aborted
        ? { data: { status: "interrupted" }, type: "run.interrupted" }
        : failureEvent(
            "Harness execution ended without a terminal event",
            "harness_protocol_error",
          );
    } catch (error) {
      terminal = consumptionError
        ? failureEvent(
            safeMessage(consumptionError, safeMessageOptions),
            "harness_event_budget_exceeded",
          )
        : active.abort.signal.aborted
          ? { data: { status: "interrupted" }, type: "run.interrupted" }
          : failureEvent(safeMessage(error, safeMessageOptions), "runner_execution_error");
    } finally {
      // Naming owns another process in this containment scope. It must exit
      // before stop, the single-tree warm check, or credential teardown.
      await titleTask;
      active.settling = true;
      unlinkEngineLifetime?.();
      // SSH ends with the Run, before anything below waits on the engine: no
      // Run's authority may stay lent while its engine's reuse is weighed.
      const machineAccessRelay = active.machineAccessRelay;
      delete active.machineAccessRelay;
      await withinStopGrace(machineAccessRelay?.suspend());
      await withinStopGrace(Promise.allSettled(active.steerTasks));
      // A refresh still on its way changes nothing once the execution is over.
      active.credentialLifetime.abort();
      // A warm engine the Run released waits for the Thread's next Run, on
      // proof that nothing of this Run lives on in it.
      const kept = warmEngine ? await this.#keepWarmEngine(active, warmEngine, terminal) : false;
      let termination: TerminationProof = "proven";
      if (warmEngine && !kept) {
        // Everything the engine held ends with it; an unproven end holds the Thread.
        await this.#retireWarmEngine(warmEngine);
      } else if (!kept) {
        // Whatever the engine left running ends with its Run, including what
        // it orphans as it stops. The Thread takes no new execution until all
        // of it is proven gone.
        termination = await this.#containment
          .terminate(active.containmentScope, () =>
            withinStopGrace(active.session?.stop().catch(() => undefined)),
          )
          .catch(() => "unknown" as const);
        await integrationSkills?.cleanup().catch(() => undefined);
        await browserCdpRelay?.close().catch(() => undefined);
        await credentialProxy?.close().catch(() => undefined);
        await machineAccessSetup?.close().catch(() => undefined);
      }
      await this.#attachmentCache?.clear(context.threadId).catch(() => undefined);
      if (internalBinding) {
        this.#sessions.release({
          generation: internalBinding.generation,
          leaseToken: internalBinding.leaseToken,
          threadId: internalBinding.threadId,
        });
      }
      delete active.primaryWorkspace;
      terminal ??= failureEvent("Runner execution ended unexpectedly", "runner_internal_error");
      await this.#settleLiveStreams(active).catch(() => undefined);
      if (active.interrupted)
        terminal = { data: { status: "interrupted" }, type: "run.interrupted" };
      await this.#emit(active, terminal).catch(() => undefined);
      if (active.shutdown) await this.#pumpJournal(active).catch(() => undefined);
      this.#runs.delete(context.runId);
      if (termination === "unknown") {
        this.#holdUncontainedThread(context.threadId, context.runId, active.containmentScope);
      }
      if (this.#threads.get(context.threadId) === context.runId) {
        this.#threads.delete(context.threadId);
      }
      // The Thread is free for its next turn; what the Host has not yet
      // acknowledged of this one is kept until it does.
      if (!active.revoked && !journalSettled(active.journal)) {
        this.#settledRuns.set(
          context.runId,
          Object.assign(active, { settledAt: this.#executionNow() }),
        );
      }
    }
  }

  async #generateThreadTitle(active: ActiveRun, session: HarnessSession): Promise<void> {
    const { context } = active.command;
    const request = context.titleRequest;
    const generateTitle = session.generateTitle?.bind(session);
    if (!request || !generateTitle || active.abort.signal.aborted) return;
    const lifetime = new AbortController();
    const abort = () => lifetime.abort(active.abort.signal.reason);
    active.abort.signal.addEventListener("abort", abort, { once: true });
    // Naming is stopped early enough that its process has exited, and the
    // Run's teardown can go on, by the time the budget ends.
    const timer = setTimeout(() => lifetime.abort(), threadTitleBudgetMs - threadTitleCleanupMs);
    timer.unref?.();
    try {
      const reply = await withTimeout(
        Promise.resolve().then(async () => {
          lifetime.signal.throwIfAborted();
          return generateTitle({
            prompt: threadTitlePrompt(request.request, { icon: request.icon === true }),
            signal: lifetime.signal,
          });
        }),
        threadTitleBudgetMs,
        { timeoutError: () => new Error("Thread title process did not settle") },
      );
      if (!reply.trim() || lifetime.signal.aborted || active.revoked || active.abort.signal.aborted)
        return;
      const name = parseGeneratedThreadName(reply, { icon: request.icon === true });
      if (!name.title && !name.icon) return;
      await this.#transmit({
        bindingGeneration: context.bindingGeneration,
        environmentId: context.environmentId,
        runId: context.runId,
        threadId: context.threadId,
        ...(name.title ? { title: name.title } : {}),
        ...(name.icon ? { icon: name.icon } : {}),
        type: "runner.thread-title",
        workspaceId: context.workspaceId,
      });
    } catch (error) {
      if (!active.abort.signal.aborted)
        this.#logger?.error("Thread title generation failed or exceeded its cleanup budget", {
          runId: context.runId,
          failure: error instanceof Error ? error.name : "unknown",
          ...(error instanceof OpensteerError && typeof error.details?.exitCode === "number"
            ? { exitCode: error.details.exitCode }
            : {}),
        });
    } finally {
      lifetime.abort();
      clearTimeout(timer);
      active.abort.signal.removeEventListener("abort", abort);
    }
  }

  /**
   * Keeps a warm engine for its Thread's next Run when this Run completed,
   * the engine released everything of it, and its process tree is exactly
   * what the Runner launched. Its proxy and relay hold no authority while it
   * waits.
   */
  async #keepWarmEngine(
    active: ActiveRun,
    engine: WarmEngine,
    terminal: HarnessDurableEvent | undefined,
  ): Promise<boolean> {
    if (
      terminal?.type !== "run.completed" ||
      active.abort.signal.aborted ||
      active.revoked ||
      this.#draining ||
      !engine.credentialProxy.usable
    ) {
      return false;
    }
    if ((await engine.session.releaseForReuse?.().catch(() => false)) !== true) return false;
    if ((await this.#containment.isSingleTree(engine.scope).catch(() => false)) !== true) {
      return false;
    }
    // Revoked or stopped while the engine was being checked: it ends with the Run.
    if (active.abort.signal.aborted || active.revoked || !engine.credentialProxy.usable) {
      return false;
    }
    // From here the engine is the pool's: nothing this Run does reaches it.
    delete active.credentialProxy;
    delete active.browserCdpRelay;
    engine.credentialProxy.suspend();
    engine.browserCdpRelay.suspend();
    engine.authority.credentials = undefined;
    await this.#warm.put(engine);
    return true;
  }

  /** Ends a warm engine and everything it held, proving its processes gone. */
  async #retireWarmEngine(
    engine: WarmEngine,
    options: { readonly keepSkills?: boolean } = {},
  ): Promise<void> {
    const termination = await this.#containment
      .terminate(engine.scope, () => {
        engine.lifetime.abort(new Error("Warm engine retired"));
        return withinStopGrace(engine.session.stop().catch(() => undefined));
      })
      .catch(() => "unknown" as const);
    if (!options.keepSkills) await engine.integrationSkills.cleanup().catch(() => undefined);
    await engine.browserCdpRelay.close().catch(() => undefined);
    await engine.credentialProxy.close().catch(() => undefined);
    await engine.machineAccess?.close().catch(() => undefined);
    if (termination === "unknown") {
      this.#holdUncontainedThread(engine.threadId, null, engine.scope);
    }
  }

  async #consumeHarnessEvents(
    active: ActiveRun,
    session: HarnessSession,
  ): Promise<HarnessDurableEvent | undefined> {
    for await (const event of session.events) {
      if (isHarnessLiveEvent(event)) {
        this.#appendLive(active, event);
        continue;
      }
      if (terminalEventTypes.has(event.type)) {
        if (active.pendingRequestIds.size > 0) {
          throw new Error("Harness emitted a terminal event with pending Requests");
        }
        return event;
      }
      await this.#emitDurable(active, event);
    }
    return undefined;
  }

  /**
   * Streaming text goes to the Run's live buffer. A tool's live output keeps
   * its existing bound: the independent `tool.completed` carries the result.
   */
  #appendLive(active: ActiveRun, event: HarnessLiveEvent): void {
    switch (event.type) {
      case "assistant.delta":
        active.live.append({ stream: "assistant" }, event.data.text);
        return;
      case "reasoning.delta":
        active.live.append({ blockId: event.data.blockId, stream: "reasoning" }, event.data.text);
        return;
      case "tool.delta": {
        const { callId, text } = event.data;
        if (active.saturatedToolDeltaCallIds.has(callId)) return;
        const emittedBytes = active.toolDeltaBytes.get(callId) ?? 0;
        const availableBytes = Math.max(0, toolDeltaContentMaxBytes - emittedBytes);
        const incomingBytes = utf8ByteLength(text);
        if (incomingBytes <= availableBytes) {
          active.toolDeltaBytes.set(callId, emittedBytes + incomingBytes);
          active.live.append({ callId, stream: "tool" }, text);
          return;
        }
        active.saturatedToolDeltaCallIds.add(callId);
        active.toolDeltaBytes.set(callId, toolOutputTextMaxBytes);
        active.live.append(
          { callId, stream: "tool" },
          `${utf8Prefix(text, availableBytes)}${toolDeltaOmissionMarker}`,
        );
        return;
      }
    }
  }

  /**
   * Every durable event of a Run follows the live text sent before it, so a
   * reader never sees a completion overtaken by the words it completes, and
   * the stream it completes starts again from nothing.
   */
  async #emitDurable(active: ActiveRun, event: HarnessDurableEvent): Promise<void> {
    await active.live.flush();
    await this.#emit(active, event);
    switch (event.type) {
      case "assistant.message":
        active.live.complete({ stream: "assistant" });
        return;
      case "reasoning.completed":
        active.live.complete({ blockId: event.data.blockId, stream: "reasoning" });
        return;
      case "tool.completed":
        active.toolDeltaBytes.delete(event.data.callId);
        active.saturatedToolDeltaCallIds.delete(event.data.callId);
        active.live.complete({ callId: event.data.callId, stream: "tool" });
        return;
      default:
        return;
    }
  }

  /**
   * A Run that ends mid-stream keeps what its reader already saw. An answer
   * or reasoning block that never completed becomes durable here, before the
   * terminal event, from the same tail the reader holds; a tool's partial
   * output does not, because only the tool may say how it ended.
   */
  async #settleLiveStreams(active: ActiveRun): Promise<void> {
    await active.live.flush().catch(() => undefined);
    for (const item of active.live.replacement()) {
      if (!item.text || item.op !== "replace") continue;
      const truncated = item.length > item.text.length;
      try {
        if (item.stream === "assistant") {
          // A message's durable limit is in serialized bytes, which a stream's
          // tail can exceed in many scripts; the newest text that fits is kept.
          const text = fittedTail(item.text, truncated, messageContentMaxSerializedBytes - 1_024);
          await this.#emit(active, {
            data: { content: [{ text, type: "text" }], messageId: createId("message") },
            type: "assistant.message",
          });
        } else if (item.stream === "reasoning") {
          const text = fittedTail(
            item.text.slice(-reasoningCompletedMaxLength),
            truncated || item.text.length > reasoningCompletedMaxLength,
            pendingAgentEventMaxSerializedBytes - 4_096,
          );
          await this.#emit(active, {
            data: { blockId: item.blockId, text },
            type: "reasoning.completed",
          });
        }
      } catch (error) {
        // One stream that cannot be recorded must not cost the others, nor the
        // terminal event that follows; the reader keeps the live text it drew.
        this.#logger?.error("Runner could not record an unfinished stream", {
          error: safeMessage(error, safeMessageOptions),
          runId: active.command.context.runId,
          stream: item.stream,
        });
      }
    }
    active.live.close();
  }

  async #emit(active: ActiveRun, original: HarnessDurableEvent): Promise<void> {
    // The terminal event is a Run's last: an engine still reporting after the
    // Runner ended it for its stop is not heard.
    if (active.revoked || active.journal.terminal) return;
    if (active.shutdown && terminalEventTypes.has(original.type)) return;
    const outcome: HarnessDurableEvent =
      active.interruptionCause && terminalEventTypes.has(original.type)
        ? {
            type: "run.interrupted",
            data: { status: "interrupted", cause: active.interruptionCause },
          }
        : original;
    const event = fittedDurableEvent(outcome);
    const { context } = active.command;
    const pending = PendingAgentEventSchema.parse({
      bindingGeneration: context.bindingGeneration,
      data: event.data,
      emittedAt: new Date().toISOString(),
      environmentId: context.environmentId,
      ordinal: active.nextOrdinal,
      runId: context.runId,
      threadId: context.threadId,
      type: event.type,
      workspaceId: context.workspaceId,
    });
    const bytes = Buffer.byteLength(JSON.stringify(pending), "utf8");
    const terminal = terminalEventTypes.has(event.type);
    const pendingAfter = new Set(active.pendingRequestIds);
    if (event.type === "request.opened") pendingAfter.add(event.data.request.id);
    if (event.type === "request.cancelled") pendingAfter.delete(event.data.requestId);
    // A Run that is ending still owes two statements after every other event:
    // its usage, when the driver has it, and the terminal event itself.
    const eventLimit = terminal
      ? this.#maxRunEvents
      : event.type === "run.usage"
        ? this.#maxRunEvents - 1
        : this.#maxRunEvents - 2 - pendingAfter.size;
    const byteLimit = terminal
      ? this.#maxRunEventBytes
      : this.#maxRunEventBytes -
        terminalEventReserveBytes -
        pendingAfter.size * requestCancellationReserveBytes;
    if (active.emittedEvents + 1 > eventLimit || active.emittedEventBytes + bytes > byteLimit) {
      throw new Error("Harness exceeded the Runner's per-Run event budget");
    }
    // Room is kept for the terminal event, so a Run whose Host has been out of
    // reach too long still ends with a statement of why.
    const journalLimit = terminal ? maxJournalBytes : maxJournalBytes - terminalEventReserveBytes;
    if (active.journal.bytes + bytes > journalLimit) {
      throw new Error("The Runner could not reach its Host to record this Run's events");
    }
    active.nextOrdinal += 1;
    active.emittedEvents += 1;
    active.emittedEventBytes += bytes;
    active.journal.events.set(pending.ordinal, { bytes, event: pending });
    active.journal.bytes += bytes;
    if (terminal) active.journal.terminal = true;
    await this.#pumpJournal(active);
    active.pendingRequestIds.clear();
    for (const requestId of pendingAfter) active.pendingRequestIds.add(requestId);
  }

  async #interrupt(
    runId: RunId,
    threadId: ThreadId,
    bindingGeneration?: number,
  ): Promise<CommandDecision> {
    const active = this.#runs.get(runId);
    const existingThreadId = active?.command.context.threadId;
    if (existingThreadId && existingThreadId !== threadId) {
      return reject("forbidden", "Interrupt targets a different thread", false);
    }
    // A restart stops the attempt it replaces and never the one taking over.
    if (
      active &&
      bindingGeneration !== undefined &&
      active.command.context.bindingGeneration !== bindingGeneration
    ) {
      return { status: "accepted" };
    }
    // Host commands are delivered on one ordered connection. An execute which
    // preceded this interrupt is already active; an execute which follows it
    // is rejected by the Host registry's causal dispatch fence. Keeping a
    // second process-lifetime tombstone here would only duplicate authority
    // state and retain completed identifiers forever.
    if (!active) return { status: "accepted" };
    // The Host has already revoked the Run's grant.
    this.#endLocalAccess(active);
    active.interrupted = true;
    active.abort.abort(new Error("Run was interrupted"));
    return { status: "accepted" };
  }

  /**
   * Keeps a long Run's Host tokens fresh. The Host answers with new tokens
   * while the Run's grant stands, or null once it has ended, which ends the
   * Run's local access too. No answer leaves the current tokens, which still
   * have half their life, and asks again sooner.
   */
  #scheduleCredentialRefresh(active: ActiveRun, afterMs: number | undefined): void {
    if (afterMs === undefined) return;
    const retryMs = Math.max(1_000, Math.min(afterMs / 4, 30_000));
    const { signal } = active.credentialLifetime;
    const ended = () => signal.aborted || active.abort.signal.aborted;
    const schedule = (delayMs: number) => {
      if (ended()) return;
      const cancel = this.#credentialRefreshClock.schedule(() => {
        signal.removeEventListener("abort", cancel);
        void refresh();
      }, delayMs);
      signal.addEventListener("abort", cancel, { once: true });
    };
    const refresh = async (): Promise<void> => {
      if (ended()) return;
      const fresh = await this.#connection
        ?.refreshRunCredentials?.(active.command.context.runId)
        .catch(() => undefined);
      // The answer to a refresh asked during the execution may arrive after
      // it ended, when its engine may already serve another Run.
      if (ended()) return;
      if (fresh === null) {
        this.#endLocalAccess(active);
        return;
      }
      if (fresh) active.credentials?.replace(fresh);
      schedule(fresh ? afterMs : retryMs);
    };
    schedule(afterMs);
  }

  #interruptTrigger(occurrenceId: TriggerOccurrenceId): CommandDecision {
    // Cancellation is idempotent so a retried Host security effect can always
    // converge even if the program completed between observation and delivery.
    this.#triggerPrograms
      .get(occurrenceId)
      ?.abort.abort(new Error("Trigger execution authority was revoked"));
    return { status: "accepted" };
  }

  async #resolveRequest(
    runId: RunId,
    requestId: Parameters<HarnessSession["resolveRequest"]>[0],
    response: Parameters<HarnessSession["resolveRequest"]>[1],
  ): Promise<CommandDecision> {
    const active = this.#runs.get(runId);
    const session = active?.session;
    if (!session) return reject("not_found", "Active run was not found", false);
    // Answered before the engine hears it: an engine may act on the answer,
    // and end its turn, before the call that delivered it returns.
    active.pendingRequestIds.delete(requestId);
    try {
      await session.resolveRequest(requestId, response);
      return { status: "accepted" };
    } catch (error) {
      return reject("not_found", safeMessage(error, safeMessageOptions), false);
    }
  }

  async #steer(
    command: Extract<RunnerCommand, { readonly type: "run.steer" }>,
  ): Promise<CommandDecision> {
    const active = this.#runs.get(command.runId);
    if (!active) return reject("not_found", "Active run was not found", false);
    if (active.settling) return reject("conflict", "Run is finishing", false);
    if (active.command.context.threadId !== command.threadId) {
      return reject("forbidden", "Steer targets a different thread", false);
    }
    const steer = active.session?.steer;
    if (!active.session || !steer) {
      return reject("conflict", "Harness does not support steering", false);
    }
    const task = this.#deliverSteer(active, command, steer);
    active.steerTasks.add(task);
    try {
      return await task;
    } finally {
      active.steerTasks.delete(task);
    }
  }

  async #deliverSteer(
    active: ActiveRun,
    command: Extract<RunnerCommand, { readonly type: "run.steer" }>,
    steer: NonNullable<HarnessSession["steer"]>,
  ): Promise<CommandDecision> {
    try {
      const plan = active.command.context.attachments;
      const attachments = await this.#prepareAttachments(
        plan ? { ...plan, token: active.credentials?.attachments ?? plan.token } : undefined,
        command.threadId,
        active.command.context.harness.driverKind,
        active.abort.signal,
      );
      this.#requireInputAttachments([command.input], attachments);
      await steer.call(active.session, {
        attachments,
        input: command.input,
        signal: active.abort.signal,
      });
    } catch (error) {
      if (error instanceof HarnessSteerDeliveryUnknownError) {
        return { message: safeMessage(error, safeMessageOptions), status: "uncertain" };
      }
      return reject("conflict", safeMessage(error, safeMessageOptions), false);
    }
    try {
      await this.#emit(active, {
        data: { messageId: command.input.messageId },
        type: "message.injected",
      });
    } catch (error) {
      // The provider already accepted the message. Losing the durable receipt
      // cannot be presented as a refusal or cause the input to run again.
      return { message: safeMessage(error, safeMessageOptions), status: "uncertain" };
    }
    return { status: "accepted" };
  }

  async #prepareAttachments(
    plan: Extract<RunnerCommand, { readonly type: "run.execute" }>["context"]["attachments"],
    threadId: ThreadId,
    driverKind: HarnessId,
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, ResolvedAttachment>> {
    if (!plan) return new Map();
    if (!this.#canDeliverMessageAttachments(driverKind))
      throw new Error(
        "Runner attachment capability is not configured for this engine and boundary",
      );
    if (!this.#attachmentCache) throw new Error("Runner attachment cache is unavailable");
    return this.#attachmentCache.prepare({ plan, threadId, signal });
  }

  #requireInputAttachments(
    inputs: readonly {
      readonly content: readonly { readonly type: string; readonly artifactId?: string }[];
    }[],
    attachments: ReadonlyMap<string, ResolvedAttachment>,
  ): void {
    for (const input of inputs) {
      for (const part of input.content) {
        if (part.type !== "artifact") continue;
        if (!part.artifactId || !attachments.has(part.artifactId)) {
          throw new Error(
            `Attachment ${part.artifactId ?? "unknown"} is not authorized for this Run`,
          );
        }
      }
    }
  }

  async #mountWorkspace(
    command: Extract<RunnerCommand, { readonly type: "workspace.mount" }>,
  ): Promise<CommandDecision> {
    const active = this.#runs.get(command.runId);
    if (!active || !active.primaryWorkspace) {
      return reject("not_found", "Active Main run was not found", false);
    }
    const { context } = active.command;
    if (context.threadId !== command.threadId || context.workspaceKind !== "main") {
      return reject("forbidden", "Workspace mount does not belong to this Main run", false);
    }
    if (command.workspaceId === context.workspaceId) {
      return reject("forbidden", "Workspace mount path is not the assigned Main path", false);
    }
    if (
      command.plan.workspaceId !== command.workspaceId ||
      (command.plan.kind === "local-directory" &&
        command.plan.ownerEnvironmentId !== command.environmentId) ||
      (command.plan.kind === "portablefs" && command.plan.workspaceKind === "main")
    ) {
      return reject("forbidden", "Workspace access plan is not assigned to this Main run", false);
    }
    if (active.abort.signal.aborted) {
      return reject("conflict", "Main run is stopping", true);
    }
    try {
      const workspace = await this.#workspaceManager.prepare({
        instructionsPath: null,
        plan: command.plan,
        signal: active.abort.signal,
      });
      active.workspaceIds.add(command.workspaceId);
      return { status: "accepted", workspacePath: workspace.path };
    } catch (error) {
      return reject("conflict", safeMessage(error, safeMessageOptions), true);
    }
  }

  async #detachWorkspace(
    command: Extract<RunnerCommand, { readonly type: "workspace.detach" }>,
  ): Promise<CommandDecision> {
    const registry = this.#workspaceMountRegistry;
    if (!registry) return { status: "accepted" };
    const mounted = registry.inventory().find((entry) => entry.workspaceId === command.workspaceId);
    if (mounted && mounted.volumeId !== command.volumeId) {
      return reject(
        "conflict",
        `Workspace ${command.workspaceId} is mounted from volume ${mounted.volumeId}, not requested volume ${command.volumeId}`,
        true,
      );
    }

    await this.#warm.evict((engine) => engine.workspaceId === command.workspaceId);
    const tasks: Promise<void>[] = [];
    for (const active of this.#runs.values()) {
      if (!active.workspaceIds.has(command.workspaceId)) continue;
      active.abort.abort(new Error("Workspace access was detached"));
      if (active.task) tasks.push(active.task);
    }
    for (const active of this.#triggerPrograms.values()) {
      if (!active.workspaceIds.has(command.workspaceId)) continue;
      active.abort.abort(new Error("Workspace access was detached"));
      if (active.task) tasks.push(active.task);
    }
    if (!(await settlesWithin(tasks, runtimeTaskStopWaitMs))) {
      return reject(
        "conflict",
        "Active Workspace users did not stop before the detach deadline",
        true,
      );
    }
    try {
      await registry.detach(command.workspaceId);
      return { status: "accepted" };
    } catch (error) {
      return reject("conflict", safeMessage(error, safeMessageOptions), true);
    }
  }

  /**
   * Everything the Runner needs to resolve one profile's private storage. The
   * environment is part of it because a `native-user` Runner's store is the
   * ambient provider home, which the harness environment may relocate.
   */
  async #providerStateOptions(driverKind: HarnessId): Promise<HarnessProviderStateOptions> {
    return {
      environment: await this.#harnessEnvironment(driverKind),
      privateStateRoot: this.#dataDirectory,
      runtimeBoundary: this.#harnessRuntimeBoundary,
      stateDirectory: this.#privateStateDirectory,
      storeScope: this.#harnesses.providerStoreScope(driverKind),
    };
  }

  /**
   * The Runner's one decision about where a Run's harness process tree runs.
   * With a sandbox it is the sandbox's plan for this Run; without one the
   * launch is returned as the driver built it.
   */
  async #wrapProcessLaunch(plan: HarnessSandboxRunPlan): Promise<HarnessProcessLaunchWrapper> {
    return this.#harnessSandbox ? this.#harnessSandbox.plan(plan) : (launch) => launch;
  }

  async #harnessEnvironment(driverKind: HarnessId): Promise<Readonly<Record<string, string>>> {
    const output: Record<string, string> = {};
    for (const name of [
      "APPDATA",
      "HOME",
      "LANG",
      "LC_ALL",
      "LOCALAPPDATA",
      "LOGNAME",
      "NODE_EXTRA_CA_CERTS",
      "PATH",
      "SHELL",
      "TERM",
      "TMPDIR",
      "USER",
      "USERPROFILE",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
    ] as const) {
      const value = process.env[name];
      if (value) output[name] = value;
    }
    for (const name of this.#harnesses.environmentVariables(driverKind)) {
      const value = process.env[name];
      if (value) output[name] = value;
    }
    return Object.freeze(output);
  }
}

/**
 * Represents one profile's inspection failure as data. Reporting it keeps the
 * Host's authoritative inspection alive for every other profile.
 */
export function errorCatalog(
  definition: Pick<HarnessInstanceDefinition, "driverKind" | "id">,
  error: unknown,
): HarnessInstanceCatalog {
  return HarnessInstanceCatalogSchema.parse({
    connections: [],
    detail: safeMessage(error, safeMessageOptions).slice(0, 500),
    driverKind: definition.driverKind,
    harnessInstanceId: definition.id,
    models: [],
    setupMethods: [],
    status: "error",
  });
}

function reject(code: ProtocolError["code"], message: string, retryable: boolean): CommandDecision {
  return { error: { code, message: message.slice(0, 2_000), retryable }, status: "rejected" };
}

/**
 * A Runner that cannot run Trigger programs must not start at all: the Node
 * executable is resolved and verified before the runtime exists, so its
 * absence here is a composition bug rather than a runtime condition.
 */
function programExecutorFor(
  options: Pick<RunnerRuntimeOptions, "nodeExecutable">,
  privateStateDirectory: string,
): TriggerProgramExecutor {
  if (!options.nodeExecutable) {
    throw new TypeError("RunnerRuntime requires a verified nodeExecutable for Trigger programs");
  }
  return new TriggerProgramExecutor({
    nodeExecutable: options.nodeExecutable,
    privateDirectory: resolve(privateStateDirectory, "trigger-programs"),
  });
}

/**
 * How far ahead of now a lease reaches, less a margin for clock drift and the
 * time a renewal takes to arrive, so the Runner always stops first.
 */
function leaseLeadMs(leaseMs: number): number {
  return leaseMs - Math.min(5_000, Math.floor(leaseMs / 4));
}

/** Waits for `work`, but no longer than a stopped Run's grace. */
async function withinStopGrace(work: Promise<unknown> | undefined): Promise<void> {
  if (!work) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work.catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, executionStopGraceMs);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
}

/**
 * Everything a warm engine was started with, as one key: a Run whose key
 * differs gets an engine of its own. Per-Run facts — its tokens, its history,
 * its machine notice — are not in it; the session is rebound with them.
 */
function warmEngineKey(input: {
  readonly attachmentRoot: string | null;
  readonly baseEnvironment: Readonly<Record<string, string>>;
  readonly context: Extract<RunnerCommand, { readonly type: "run.execute" }>["context"];
  readonly instructions: string | null;
  readonly integrationSkillsDigest: string;
  /** What the engine's launch directory for other computers was written from. */
  readonly machineAccessLaunch: string;
  readonly providerSessionReference: string | null;
  readonly runtimeBoundary: string;
  /** The skill catalog the engine was started with; an engine reads it at startup. */
  readonly skills: HarnessSkillPlan | undefined;
  readonly workspaceSkillsDigest: string;
  readonly workspacePath: string;
  readonly writableRoots: readonly string[];
}): string {
  const { context } = input;
  return createHash("sha256")
    .update(
      JSON.stringify([
        context.threadId,
        context.requestedBy,
        context.membershipGeneration,
        context.harnessInstanceId,
        context.harness,
        context.providerSessionId,
        input.providerSessionReference,
        context.providerSessionStateLayout,
        context.workspaceId,
        input.workspacePath,
        input.instructions,
        context.accessMode,
        input.writableRoots,
        context.agentTools.capabilityProfileId,
        context.threadRole,
        context.modelSelection,
        input.integrationSkillsDigest,
        input.skills,
        input.workspaceSkillsDigest,
        context.agentTools.url,
        context.integrationTools.url,
        context.browserCdp.url,
        input.attachmentRoot,
        input.baseEnvironment,
        input.runtimeBoundary,
        input.machineAccessLaunch,
      ]),
    )
    .digest("base64url");
}

/**
 * The containment scope of one execution. A restarted Run's attempts share its
 * ID, and the stop of one must never reach the next.
 */
function runExecutionId(context: {
  readonly bindingGeneration: number;
  readonly runId: RunId;
}): string {
  return `${context.runId}-${context.bindingGeneration}`;
}

function journalSettled(journal: RunJournal): boolean {
  return journal.events.size === 0 && journal.sessionBound === null;
}

/** The durable bound on one reasoning block's text, in UTF-16 units. */
const reasoningCompletedMaxLength = 300_000;

/**
 * The event as it can be recorded. What an engine reports — its reasoning, an
 * answer, a tool call's input, what it asks, why it failed — can be longer
 * than its durable record may be; failing the Run over that would discard the
 * work, so the text is cut to fit, saying it was cut. Every engine's events
 * pass through here.
 */
function fittedDurableEvent(event: HarnessDurableEvent): HarnessDurableEvent {
  switch (event.type) {
    case "reasoning.completed": {
      const text = fittedHead(
        event.data.text,
        pendingAgentEventMaxSerializedBytes - 8_192,
        reasoningCompletedMaxLength,
      );
      return text === event.data.text ? event : { ...event, data: { ...event.data, text } };
    }
    case "assistant.message": {
      const content = fittedContent(event.data.content);
      return content === event.data.content
        ? event
        : { ...event, data: { ...event.data, content } };
    }
    case "tool.started": {
      const args = createToolArguments(event.data.arguments);
      return args === event.data.arguments
        ? event
        : { ...event, data: { ...event.data, arguments: args } };
    }
    case "request.opened": {
      const { request } = event.data;
      return {
        ...event,
        data: { request: { ...request, presentation: fittedPresentation(request.presentation) } },
      };
    }
    case "run.failed":
      return {
        ...event,
        data: {
          ...event.data,
          message: fittedText(event.data.message, runFailureMessageMaxLength),
        },
      };
    default:
      return event;
  }
}

/**
 * A Request as it can be shown. An engine words what it asks itself — the
 * command it wants to run, its question and the choices it offers — and the
 * person still answers what was asked, from the start and end of it. What
 * identifies an answer is never cut.
 */
function fittedPresentation(presentation: RequestPresentation): RequestPresentation {
  const line = (text: string, maxLength: number) =>
    fittedHead(text, Number.MAX_SAFE_INTEGER, maxLength);
  const description = (text: string | undefined) =>
    text === undefined ? {} : { description: fittedText(text, requestChoiceTextMaxLength) };
  const shown = {
    ...(presentation.detail === undefined
      ? {}
      : { detail: fittedText(presentation.detail, requestTextMaxLength) }),
    title: line(presentation.title, requestTitleMaxLength),
  };
  switch (presentation.kind) {
    case "choice":
      return {
        ...presentation,
        ...shown,
        options: presentation.options.map((option) => ({
          ...option,
          ...description(option.description),
          label: line(option.label, requestLabelMaxLength),
        })),
      };
    case "form":
      return {
        ...presentation,
        ...shown,
        fields: presentation.fields.map((field) => ({
          ...field,
          ...(field.choices === undefined
            ? {}
            : {
                choices: field.choices.map((choice) => ({
                  ...choice,
                  ...description(choice.description),
                  label: line(choice.label, requestChoiceTextMaxLength),
                })),
              }),
          ...(field.label === undefined ? {} : { label: line(field.label, requestLabelMaxLength) }),
          prompt: fittedText(field.prompt, requestTextMaxLength),
        })),
      };
    case "external":
      return { ...presentation, ...shown };
  }
}

/**
 * `text` within `maxLength` UTF-16 units, keeping its head and tail around a
 * marker saying how much was cut. No character takes fewer UTF-8 bytes than
 * UTF-16 units, so the cut, made in bytes, fits the length.
 */
function fittedText(text: string, maxLength: number): string {
  return text.length <= maxLength
    ? text
    : utf8HeadAndTail(new TextEncoder().encode(text), maxLength - 64).text;
}

/**
 * Message content within its schema: each text part within a part's length,
 * and the whole within its serialized size. When the whole is too large, the
 * text parts share what the structure around them leaves, the shorter ones
 * keeping all of theirs; each cut part says it was cut.
 */
function fittedContent(content: ContentPart[]): ContentPart[] {
  const serializedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  const budget = messageContentMaxSerializedBytes - 1_024;
  const fitsPart = (part: ContentPart) =>
    part.type !== "text" ||
    (part.text.length <= messageTextPartMaxLength && part.text.isWellFormed());
  if (content.every(fitsPart) && serializedBytes(content) <= budget) return content;
  const parts = content.map((part) =>
    part.type === "text"
      ? { ...part, text: fittedHead(part.text, Number.MAX_SAFE_INTEGER, messageTextPartMaxLength) }
      : part,
  );
  if (serializedBytes(parts) <= budget) return parts;
  // Each text value is measured with its quotes, which the structure with
  // empty texts already counts once per part.
  const structure = serializedBytes(
    parts.map((part) => (part.type === "text" ? { ...part, text: "" } : part)),
  );
  const texts = parts
    .flatMap((part, index) =>
      part.type === "text" ? [{ bytes: serializedBytes(part.text) - 2, index }] : [],
    )
    .sort((left, right) => left.bytes - right.bytes);
  let available = Math.max(0, budget - structure);
  const allotted = new Map<number, number>();
  texts.forEach(({ bytes, index }, position) => {
    const share = Math.floor(available / (texts.length - position));
    const given = Math.min(bytes, share);
    allotted.set(index, given);
    available -= given;
  });
  return parts.map((part, index) =>
    part.type === "text"
      ? {
          ...part,
          text: fittedHead(part.text, (allotted.get(index) ?? 0) + 2, messageTextPartMaxLength),
        }
      : part,
  );
}

/**
 * The start of `text` whose JSON encoding fits `maxBytes` and whose length
 * fits `maxLength`, marked when cut.
 */
function fittedHead(text: string, maxBytes: number, maxLength = Number.MAX_SAFE_INTEGER): string {
  const encodedBytes = (value: string) => Buffer.byteLength(JSON.stringify(value), "utf8");
  const whole = text.toWellFormed();
  if (whole.length <= maxLength && encodedBytes(whole) <= maxBytes) return whole;
  let low = 0;
  let high = Math.min(whole.length, maxLength - 1);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encodedBytes(`${whole.slice(0, middle)}…`) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return `${whole.slice(0, surrogateSafeCut(whole, low))}…`;
}

/**
 * The newest part of `text` whose JSON encoding fits `maxBytes`, marked when
 * anything before it was cut. Cutting is from the front because the end of an
 * unfinished stream is what its reader saw last.
 */
function fittedTail(text: string, truncated: boolean, maxBytes: number): string {
  const encodedBytes = (value: string) => Buffer.byteLength(JSON.stringify(value), "utf8");
  const marked = (value: string) => (truncated ? `…${value}` : value);
  const whole = text.toWellFormed();
  if (encodedBytes(marked(whole)) <= maxBytes) return marked(whole);
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (encodedBytes(`…${text.slice(middle)}`) <= maxBytes) high = middle;
    else low = middle + 1;
  }
  // Never begin inside a surrogate pair.
  const unit = text.charCodeAt(low);
  const start = unit >= 0xdc00 && unit <= 0xdfff ? low + 1 : low;
  return `…${text.slice(start).toWellFormed()}`;
}

function failureEvent(message: string, code: string): HarnessDurableEvent {
  return {
    data: {
      code,
      message,
      retryable: false,
      status: "failed",
    },
    type: "run.failed",
  };
}

const safeMessageOptions = {
  fallback: "Runner operation failed",
  maximumLength: Number.MAX_SAFE_INTEGER,
} as const;

function boundedPositiveInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

async function settlesWithin(tasks: readonly Promise<void>[], timeoutMs: number): Promise<boolean> {
  if (tasks.length === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.allSettled(tasks).then(() => true),
      new Promise<false>((resolvePromise) => {
        timer = setTimeout(() => resolvePromise(false), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function collectProcessOutput(chunks: AsyncIterable<Buffer>): Promise<string> {
  const values: Buffer[] = [];
  for await (const chunk of chunks) values.push(chunk);
  return Buffer.concat(values).toString("utf8");
}
