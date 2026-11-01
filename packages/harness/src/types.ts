import { OpensteerError } from "@opensteer/core";
import type {
  AgentEventType,
  AssignmentRunContext,
  DeploymentKind,
  EnvironmentId,
  RunnerEventData,
  ExecutionEnvironmentKind,
  HarnessId,
  HarnessInstanceId,
  HarnessInstanceStateKind,
  HarnessRuntimeRevision,
  Message,
  ModelSelection,
  RunId,
  RunThreadState,
  RequestId,
  RequestResponse,
  ThreadId,
  ThreadAccessMode,
  UserId,
  WorkspaceId,
} from "@opensteer/core";
import type {
  AgentControlRequest,
  AgentControlResponse,
  HarnessInput,
  HarnessRunReports,
  RunAgentToolsPlan,
  RunIntegrationToolsPlan,
  RunHistoryWindow,
  RunInitialContext,
} from "@opensteer/protocol";
import type { z } from "zod";
import type { InstalledEngineUpdateFacts } from "./engine-installation.js";

interface AgentControlClient {
  request(input: AgentControlRequest, signal: AbortSignal): Promise<AgentControlResponse>;
}

export interface HarnessCapabilities {
  readonly approvals: boolean;
  readonly attachments: boolean;
  readonly messageAttachments?: {
    /** The provider sandbox denies sibling Thread caches on a shared macOS Runner. */
    readonly darwinIsolatedServiceSandbox?: true;
    /**
     * The largest stored image the driver guarantees to deliver on every path it
     * offers, prompt and (with `steering`) a running turn. The driver fits what
     * it sends to its engine's own input limits with `prepareNativeImage`, so a
     * driver with native images advertises the Host's upload limits.
     */
    readonly nativeImages: {
      readonly maxBytes: number;
      readonly maxPixels: number;
      readonly mediaTypes: readonly string[];
      readonly steering: boolean;
    } | null;
  };
  readonly interruption: boolean;
  /**
   * The provider renders an MCP image content block to the model.
   *
   * A tool that answers with a picture — computer use's observation is the one
   * that does — sends the block only to an engine that shows it, and tells the
   * model in words that the picture is unavailable to every other one. An
   * engine that drops the block silently would leave a model reasoning about a
   * screenshot it was never shown.
   */
  readonly mcpImageContent: boolean;
  readonly resume: boolean;
  /** The provider can accept new input into an already executing Opensteer Run. */
  readonly steering: boolean;
  readonly toolCalls: boolean;
  readonly userInput: boolean;
  /**
   * A session can serve the Thread's next Run once the Runner rebinds it: its
   * engine process outlives one Run and holds nothing of that Run once
   * released. The Runner keeps such a session warm only when everything the
   * engine was started with is the same for the next Run. Its `execute`
   * resolves only after the Run's terminal event is published or its event
   * stream closed, so the Runner waits for that event instead of stopping it.
   */
  readonly warmReuse?: boolean;
}

/**
 * One physical trust boundary for provider state and model-executed tools.
 *
 * `native-user` means the Runner process belongs to exactly one person and runs
 * as them, so the provider sign-ins already on that computer are theirs to use.
 * `isolated-service` means the Runner executes work for a Deployment's users at
 * large, so every profile gets a Runner-private provider home instead.
 */
export interface HarnessRuntimeBoundary {
  readonly kind: "native-user" | "isolated-service";
}

/**
 * The native session store one or more profiles share. It is the unit that can
 * resume a provider conversation, which is why the continuation identity is
 * derived from `id` and never from a profile or a credential.
 */
export interface HarnessProviderStore {
  readonly id: string;
  readonly directory: string;
}

/**
 * How wide one driver's native session store reaches. `driver-shared` lets
 * every profile of that driver on one execution environment resume the same
 * conversations, so an account switch is a credential change and not a new
 * store; `profile` keeps each profile's conversations to itself.
 *
 * A `driver-shared` driver must also say where its ambient home lives, because
 * on a `native-user` Runner the person's own CLI home is the store.
 */
export type HarnessProviderStoreScope =
  | { readonly kind: "profile" }
  | {
      readonly kind: "driver-shared";
      readonly nativeUserHome: {
        readonly environmentVariable: string;
        /** Resolved against the operating-system home directory. */
        readonly relativeHomePath: string;
      };
    };

export const profileHarnessProviderStoreScope: HarnessProviderStoreScope = Object.freeze({
  kind: "profile",
});

/** Runner-owned storage identity and paths for one configured harness profile. */
export interface HarnessProviderState {
  /** Identifies the native session store, never the profile or its credential. */
  readonly continuationKey: string;
  readonly kind: HarnessInstanceStateKind;
  /** Present only for isolated profiles. Ambient profiles use provider defaults. */
  readonly providerHomeDirectory: string | undefined;
  /**
   * The Runner's whole data directory: its identity key, shell host key,
   * Workspace mount credentials, and every profile's provider state live under
   * it. Model-executed tools must never read it; a driver's own sandbox denies
   * it, and on an isolated-service Linux Runner the Runner's sandbox masks it
   * before the harness process even starts.
   */
  readonly privateStateRoot: string;
  readonly store: HarnessProviderStore;
}

/**
 * One harness process about to be started for a Run: the complete command the
 * driver would spawn, before the Runner decides where it runs.
 */
export interface HarnessProcessLaunch {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

/**
 * The Runner's one seam into how a Run's harness process tree is started. On an
 * isolated-service Linux Runner it wraps the launch in the Runner-owned sandbox
 * that masks Runner-private state; elsewhere it returns the launch unchanged. A
 * driver applies it to the exact command it spawns for the Run's harness
 * process and its private title process, after every provider flag is in place: sign-in,
 * inspection, and sign-out run Runner-side and are not model-driven.
 */
export type HarnessProcessLaunchWrapper = (launch: HarnessProcessLaunch) => HarnessProcessLaunch;

/** What a driver needs to launch one command the way the model's commands run in a Run. */
export interface HarnessModelCommandContext {
  readonly accessMode: ThreadAccessMode;
  readonly attachmentDirectory?: string;
  readonly attachmentRoot?: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly providerState: HarnessProviderState;
  readonly runtimeBoundary: HarnessRuntimeBoundary;
  readonly workspacePath: string;
  readonly writableRoots: readonly string[];
}

export const nativeUserHarnessRuntimeBoundary: HarnessRuntimeBoundary = Object.freeze({
  kind: "native-user",
});

export const isolatedServiceHarnessRuntimeBoundary: HarnessRuntimeBoundary = Object.freeze({
  kind: "isolated-service",
});

/**
 * The boundary one Runner executes under.
 *
 * Ownership decides this, not the Deployment's kind. A `local` Runner is
 * enrolled by one person and the database refuses any other binding
 * (`runners_owner_binding_check`: `kind = 'local'` implies an owning user), so
 * its process runs as that person on their own computer — and their existing
 * Claude Code and Codex sign-ins are the whole reason they lent the machine to
 * a shared Deployment. Deriving the boundary from `deploymentKind` alone took
 * that away the moment the Deployment was a `server`.
 *
 * A `main` or `managed` Runner is owned by the Deployment and executes work for
 * whoever asks, so it stays isolated; a Personal Deployment is single-user by
 * construction, which is why its Runner is native-user whatever its kind.
 */
export function harnessRuntimeBoundaryForRunner(runner: {
  readonly deploymentKind: DeploymentKind;
  readonly runnerKind: ExecutionEnvironmentKind;
}): HarnessRuntimeBoundary {
  return runner.deploymentKind === "personal" || runner.runnerKind === "local"
    ? nativeUserHarnessRuntimeBoundary
    : isolatedServiceHarnessRuntimeBoundary;
}

/**
 * Durable events a provider adapter or the Runner may emit for one Run.
 * Host-owned facts (durable inputs, delegation settlement, queueing, and
 * Thread state) intentionally cannot cross this boundary from a harness.
 */
export type HarnessDurableEventType = Extract<
  AgentEventType,
  | "assistant.message"
  | "message.injected"
  | "node.completed"
  | "node.started"
  | "node.updated"
  | "reasoning.completed"
  | "request.cancelled"
  | "request.opened"
  | "run.completed"
  | "run.failed"
  | "run.interrupted"
  | "run.phase"
  | "run.started"
  | "run.status"
  | "run.usage"
  | "tool.completed"
  | "tool.started"
>;

export type HarnessDurableEvent = {
  [Type in HarnessDurableEventType]: {
    readonly type: Type;
    readonly data: RunnerEventData<Type>;
  };
}[HarnessDurableEventType];

/**
 * What a stream says before it completes. The Runner forwards these as live
 * progress, never as durable events: the completing `assistant.message`,
 * `reasoning.completed` or `tool.completed` carries the whole text.
 */
export type HarnessLiveEvent =
  | { readonly data: { readonly text: string }; readonly type: "assistant.delta" }
  | {
      readonly data: { readonly blockId: string; readonly text: string };
      readonly type: "reasoning.delta";
    }
  | {
      readonly data: { readonly callId: string; readonly text: string };
      readonly type: "tool.delta";
    };

export type HarnessEvent = HarnessDurableEvent | HarnessLiveEvent;
export type HarnessEventType = HarnessEvent["type"];

const harnessLiveEventTypes: ReadonlySet<HarnessEventType> = new Set([
  "assistant.delta",
  "reasoning.delta",
  "tool.delta",
]);

export function isHarnessLiveEvent(event: HarnessEvent): event is HarnessLiveEvent {
  return harnessLiveEventTypes.has(event.type);
}

export interface HarnessSessionContext {
  /** Model-visible, verified per-Thread attachment directory, outside private state. */
  readonly attachmentDirectory?: string;
  /** Shared cache root that a provider sandbox must deny on a shared Runner. */
  readonly attachmentRoot?: string;
  /** Durable per-Thread access policy snapshotted onto this Run. */
  readonly accessMode: ThreadAccessMode;
  readonly agentControl?: AgentControlClient;
  readonly agentTools: RunAgentToolsPlan;
  readonly integrationTools: RunIntegrationToolsPlan;
  readonly environmentId: EnvironmentId;
  readonly history: readonly Message[];
  readonly historyWindow: RunHistoryWindow;
  /** Host-authorized, frozen history for the first delivered turn of a new native session. */
  readonly initialContext?: RunInitialContext | null;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly instructions: string | undefined;
  /**
   * The Runner's statement of which other computers this Run can reach over
   * SSH, or that none can. It describes what setup actually established, never
   * a setting, and it changes from Run to Run; a driver must put the current
   * text in front of the model on this Run's turn whether the provider
   * conversation is new or resumed.
   */
  readonly machineAccessNotice: string;
  /** The caller platform controls Claude's isolated Unix-socket sandbox setting. */
  readonly machineAccessPlatform: "darwin" | "linux" | undefined;
  /** Model-visible launch socket path, never a Runner credential. */
  readonly machineAccessRelaySocket: string | undefined;
  /** Host-independent Opensteer product facts and capability scope. */
  readonly platformGuide: string;
  /** Runner-owned Agent Skills selected by the signed capability profile. */
  readonly skills: HarnessSkillPlan | undefined;
  /** Exact provider/model/options snapshot chosen for this Run. */
  readonly modelSelection: ModelSelection;
  /** Runner-owned storage for this profile. */
  readonly providerState: HarnessProviderState;
  readonly runtimeBoundary: HarnessRuntimeBoundary;
  readonly threadId: ThreadId;
  /**
   * Runner-private, per-ProviderSession, deterministic across Runs: the one place a
   * driver keeps native-session helper files (a skill plugin wrapper, for
   * example). The path remains stable for a ProviderSession; the Runner's sandbox exposes it to the harness process
   * and the driver's own sandbox keeps it from the model's commands.
   */
  readonly threadStateDirectory: string;
  /** See {@link HarnessProcessLaunchWrapper}. */
  readonly wrapProcessLaunch: HarnessProcessLaunchWrapper;
  readonly workspaceId: WorkspaceId;
  readonly workspacePath: string;
  readonly writableRoots: readonly string[];
  readonly signal: AbortSignal;
  readonly environment: Readonly<Record<string, string>>;
}

export function assertFreshProviderSessionContext(context: HarnessSessionContext): void {
  if (context.initialContext) return;
  if (context.history.length === 0 && !context.historyWindow.hasEarlier) return;
  throw new OpensteerError({
    code: "conflict",
    message:
      "A native provider session can start at the beginning of a Thread or with Host-authorized initial context. History cannot be replayed as a continuation fallback.",
  });
}

/**
 * The vendor-neutral Agent Skill selection for one session. Names are unique
 * and already resolved across layers; a driver that needs a vendor package
 * layout synthesizes it privately from these directories.
 */
export interface HarnessSkillPlan {
  readonly skills: readonly HarnessSkill[];
}

export interface HarnessSkill {
  readonly name: string;
  readonly path: string;
}

export function durableHistoryWindowNotice(context: HarnessSessionContext): string | undefined {
  if (!context.historyWindow.hasEarlier) return undefined;
  return `Opensteer supplied the most recent ${context.historyWindow.itemCount} durable messages (${context.historyWindow.byteCount} serialized bytes) to this session. Earlier messages remain canonical on the Host and can be retrieved with thread_read.`;
}

/**
 * What the Host stated about a Run's Thread when it dispatched the Run: the
 * task the Run belongs to, the requester's time zone, and what the engine's
 * own history cannot show.
 */
export interface HarnessRunContext {
  readonly assignment: AssignmentRunContext | null;
  /** An IANA name as the Host accepted it, which this Runner may not know. */
  readonly requesterTimeZone: string | null;
  readonly threadState: RunThreadState;
}

export interface HarnessRunInput {
  readonly attachments?: ReadonlyMap<string, ResolvedAttachment>;
  readonly context: HarnessRunContext;
  readonly environment: Readonly<Record<string, string>>;
  readonly inputs: readonly HarnessInput[];
  readonly reports: HarnessRunReports;
  readonly runId: RunId;
  readonly requestedBy: UserId;
  readonly signal: AbortSignal;
}

/**
 * One canonical Thread input delivered into a Run that is already executing.
 * Provider-specific authorship projection belongs to the adapter.
 */
export interface HarnessSteerInput {
  readonly attachments?: ReadonlyMap<string, ResolvedAttachment>;
  readonly input: HarnessInput;
  readonly signal?: AbortSignal;
}

export interface ResolvedAttachment {
  readonly attachment: {
    readonly id: string;
    readonly kind: "file" | "image";
    readonly mediaType: string;
    readonly name: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  };
  readonly path: string;
}

export type { HarnessInput, HarnessRunReports } from "@opensteer/protocol";

export interface HarnessTitleInput {
  /** `threadTitlePrompt` of the Thread's first message. */
  readonly prompt: string;
  readonly signal: AbortSignal;
}

export interface HarnessSession {
  readonly providerSessionReference: string;
  /**
   * Events produced by Runs executed through this session. Opening or resuming
   * a provider session must not replay its historical transcript here.
   */
  readonly events: AsyncIterable<HarnessEvent>;
  execute(run: HarnessRunInput): Promise<void>;
  interrupt(): Promise<void>;
  /**
   * Present only when the adapter advertises `steering`. It resolves once the
   * provider accepted the injection and rejects with a conflict-style error
   * when no steerable Run is active.
   */
  steer?(input: HarnessSteerInput): Promise<void>;
  resolveRequest(requestId: RequestId, response: RequestResponse): Promise<void>;
  /**
   * Present when this engine can name a Thread. Asks the session's engine,
   * signed in with the session's account, for a reply to `prompt` alone, and
   * resolves with that reply's text. It runs in a process of its own that it
   * has ended, and awaited, by the time it settles, never in the Run's engine:
   * with every tool, MCP server, skill, hook, plugin and instruction file off;
   * leaving no session, history or file behind; asking nobody anything; and
   * putting nothing on `events` or the Run's usage report. An aborted `signal`
   * ends it at once, including awaiting process exit and removing scratch files.
   */
  generateTitle?(input: HarnessTitleInput): Promise<string>;
  /**
   * Ends the session, its provider process and any Run still in it, and frees
   * its conversation for the adapter's next session. It never waits on a
   * provider whose process has ended: nothing that provider owed will arrive.
   */
  stop(): Promise<void>;
  /**
   * Present when the adapter advertises `warmReuse`. Hands the session the next
   * Run's context; everything the engine was started with is already the same.
   */
  rebind?(context: HarnessSessionContext): void;
  /**
   * Present when the adapter advertises `warmReuse`. Ends whatever of the last
   * Run is still held — leftover work, its approvals — and says whether the
   * session can serve another Run. False keeps nothing: the Runner stops it.
   */
  releaseForReuse?(): Promise<boolean>;
}

/**
 * One harness session serves one Run at a time, and the context it opens or is
 * rebound with describes that Run. A context field that changes from Run to Run — today the machine
 * access notice — must be visible to the model on this Run's turn whether the
 * provider conversation is new or resumed, because a provider's startup
 * instructions are typically rendered once per conversation and would leave a
 * resumed conversation holding an earlier Run's facts.
 */
export interface HarnessAdapter {
  readonly capabilities: HarnessCapabilities;
  readonly instanceId: HarnessInstanceId;
  startSession(context: HarnessSessionContext): Promise<HarnessSession>;
  /**
   * Attaches the exact provider-native session identified by the reference.
   * Resume uses the provider's own durable state; it must not replay Host
   * history or replace a missing provider session with a fresh one. A
   * reference that is already open in this adapter is a conflict: that session
   * carries another Run's context and must not serve this one.
   */
  resumeSession(
    providerSessionReference: string,
    context: HarnessSessionContext,
  ): Promise<HarnessSession>;
  close(): Promise<void>;
}

export interface HarnessDriverCreateContext {
  readonly instanceId: HarnessInstanceId;
  readonly config: unknown;
  readonly sourceId: string;
}

/**
 * One way an engine can be pointed at a provider. Declared statically by the
 * driver so the Host can validate an account against it and settings can
 * render "Add account" for it without knowing the engine.
 */
export interface HarnessSourceField {
  readonly defaultValue?: string;
  readonly detail?: string;
  readonly id: string;
  readonly kind: "url" | "text" | "select";
  readonly label: string;
  readonly options?: readonly { readonly label: string; readonly value: string }[];
  readonly placeholder?: string;
  readonly required?: boolean;
}

export interface HarnessSourceDescriptor {
  readonly detail?: string;
  readonly fields: readonly HarnessSourceField[];
  readonly kind: "first-party" | "compatible-endpoint" | "cloud-identity" | "gateway";
  readonly label: string;
  readonly modelSettings?: boolean;
  readonly quota: "windows" | "none";
  readonly sourceId: string;
  readonly stateKinds: readonly HarnessInstanceStateKind[];
}

type HarnessModelOptionDescriptor =
  | {
      readonly defaultValue?: string;
      readonly id: string;
      readonly label: string;
      readonly type: "select";
      readonly values: readonly {
        readonly description?: string;
        readonly label: string;
        readonly value: string;
      }[];
    }
  | {
      readonly defaultValue: boolean;
      readonly id: string;
      readonly label: string;
      readonly type: "toggle";
    };

/**
 * One model a harness instance can run. The (providerId, modelId) pair is the
 * model's canonical identity across harnesses: two drivers reporting the same
 * underlying model MUST report the same pair, because clients group catalogs
 * by it to offer one model with several harnesses able to run it. Drivers are
 * responsible for normalizing their native slugs to the canonical pair.
 */
export interface HarnessModelDescriptor {
  /**
   * Whether this model reads images. Omitted when the driver's own catalog
   * source does not say; the Host treats unknown as false, so a tool with a
   * picture describes it in words instead of sending a block nothing renders.
   */
  readonly acceptsImages?: boolean;
  readonly contextWindow?: number;
  readonly description?: string;
  readonly displayName: string;
  readonly isDefault: boolean;
  readonly maxOutputTokens?: number;
  readonly modelId: ModelSelection["modelId"];
  /**
   * The id this account's endpoint answers to, when it differs from modelId.
   * A Run sends it verbatim; the canonical pair stays the grouping key.
   */
  readonly nativeModelId?: string;
  readonly options: readonly HarnessModelOptionDescriptor[];
  readonly providerId: ModelSelection["providerId"];
  readonly unavailableReason?: string;
  /** The model's only blocker is an unknown context window a person can supply. */
  readonly needsContextWindow?: true;
}

export interface HarnessInspectionContext {
  readonly config: unknown;
  readonly environment: Readonly<Record<string, string>>;
  /** The source this account was added for; always one the driver declares. */
  readonly sourceId: string;
  readonly providerState: HarnessProviderState;
  readonly runtimeBoundary: HarnessRuntimeBoundary;
  readonly signal: AbortSignal;
  readonly workingDirectory: string;
}

/**
 * Provider-owned preparation whose lifetime belongs to the Runner registry,
 * rather than to the inspection request that happened to discover it.
 */
export type HarnessPreparationContext = HarnessInspectionContext;

export type HarnessSetupMethod =
  | {
      readonly connectionSlot?: string;
      readonly detail?: string;
      readonly kind: "device-code" | "browser-code" | "local-import";
      readonly label: string;
      readonly methodId: string;
    }
  | {
      readonly connectionSlot?: string;
      readonly detail?: string;
      readonly inputLabel: string;
      readonly inputPlaceholder?: string;
      readonly kind: "secret-input";
      readonly label: string;
      readonly methodId: string;
    };

/**
 * Whose capacity a window is about. Absent is the account as a whole; a model
 * scope is a limit the provider states for one model only, which a reader
 * working on another model must not plan around.
 */
export type HarnessObservedUsageScope =
  | { readonly kind: "account" }
  | {
      readonly kind: "model";
      readonly modelId: ModelSelection["modelId"];
      readonly providerId: ModelSelection["providerId"];
    };

/** One provider-reported consumption window against an account's plan. */
export interface HarnessObservedUsageWindow {
  /** How the provider frames the window — "5h", "weekly", "30d". */
  readonly label: string;
  readonly resetsAt: string | null;
  /** Absent means the account as a whole. */
  readonly scope?: HarnessObservedUsageScope;
  readonly usedPercent: number;
}

/**
 * Provider-neutral usage against one connection's account.
 *
 * `observedAt` travels with the reading rather than with the catalog because a
 * usage number is only meaningful next to the moment it was taken; a reader
 * that cannot tell stale from fresh must show nothing rather than a stale
 * percentage.
 */
export interface HarnessObservedUsage {
  readonly limitReached: boolean;
  readonly observedAt: string;
  readonly windows: readonly HarnessObservedUsageWindow[];
}

/** Display-safe connection state. Credentials and provider identifiers never cross the Runner. */
export interface HarnessObservedConnection {
  readonly accountLabel?: string;
  /** How this connection is authorised — a fact clients branch on, never a label. */
  readonly authKind?: "subscription" | "api-key" | "cloud-identity" | "none";
  readonly billingLabel?: string;
  readonly connectionSlot: string;
  readonly label: string;
  readonly logoutSupported?: boolean;
  readonly status: "connected" | "authentication-required" | "unavailable";
  readonly usage?: HarnessObservedUsage;
}

/**
 * The complete provider-owned answer to one harness inspection.
 *
 * Expected provider conditions are data, not exceptions. This keeps the
 * provider-specific distinction between authentication, configuration, and
 * availability intact across the generic Runner boundary. Drivers throw only
 * when inspection itself failed unexpectedly.
 */
export type HarnessInspectionResult =
  | {
      readonly connections?: readonly [];
      readonly detail: string;
      readonly setupMethods?: readonly [];
      readonly status: "preparing";
    }
  | {
      readonly detail?: string;
      readonly connections?: readonly HarnessObservedConnection[];
      readonly models: readonly HarnessModelDescriptor[];
      readonly setupMethods?: readonly HarnessSetupMethod[];
      readonly status: "ready";
    }
  | {
      readonly detail: string;
      readonly connections?: readonly HarnessObservedConnection[];
      readonly setupMethods?: readonly HarnessSetupMethod[];
      readonly status: "authentication-required";
    }
  | {
      readonly detail: string;
      readonly connections?: readonly HarnessObservedConnection[];
      readonly setupMethods?: readonly HarnessSetupMethod[];
      readonly status: "unavailable";
    };

/** A provider-owned sign-in flow that can be completed outside the Runner. */
interface HarnessDeviceAuthenticationChallenge {
  readonly kind: "device-code";
  readonly userCode: string;
  readonly verificationUrl: string;
}

interface HarnessBrowserAuthenticationChallenge {
  readonly authorizationUrl: string;
  readonly inputPrompt: string;
  readonly kind: "browser-code";
}

interface HarnessSecretAuthenticationChallenge {
  readonly inputLabel: string;
  readonly inputPlaceholder?: string;
  readonly kind: "secret-input";
}

type HarnessAuthenticationChallenge =
  | HarnessDeviceAuthenticationChallenge
  | HarnessBrowserAuthenticationChallenge
  | HarnessSecretAuthenticationChallenge;

export type HarnessAuthenticationResult =
  { readonly status: "ready" } | { readonly detail: string; readonly status: "failed" };

export type HarnessAuthenticationStart =
  | { readonly status: "ready" }
  | {
      readonly cancel: () => Promise<void>;
      readonly challenge: HarnessAuthenticationChallenge;
      readonly result: Promise<HarnessAuthenticationResult>;
      readonly submit?: (value: string) => Promise<void>;
      readonly status: "pending";
    };

export type HarnessAuthenticationContext = HarnessInspectionContext;

export interface HarnessAuthenticationSelection {
  readonly connectionSlot?: string;
  readonly methodId: string;
}

/** Which of an account's connections a sign-out is aimed at. */
export interface HarnessLogoutSelection {
  readonly connectionSlot?: string;
}

export interface HarnessDriver {
  readonly kind: HarnessId;
  /**
   * The sources this engine can drive, first-party first. The first entry is
   * what a seeded account gets; every account names exactly one of them.
   */
  readonly sources: readonly HarnessSourceDescriptor[];
  /**
   * The `ThreadAccessMode` values this engine can enforce for a Run — approval
   * prompts, edit auto-accept, and the rest. The Host refuses a Thread a mode
   * its engine does not declare, because a mode nothing enforces is a promise
   * the product cannot keep.
   *
   * Not to be confused with `harnessCatalog[].machineAccess.accessModes` in
   * `packages/core`, which answers a different question: the modes in which
   * this engine's own command sandbox can reach the machine-access relay
   * socket.
   */
  readonly accessModes: readonly ThreadAccessMode[];
  /**
   * What every adapter this driver creates can do. It is a static property of
   * the driver, so the Runner can advertise it during inspection without
   * materializing an adapter for a profile it has never executed.
   */
  readonly capabilities: HarnessCapabilities;
  readonly configSchema: z.ZodType;
  /** Additional process-environment variables this provider may inherit. */
  readonly environmentVariables?: readonly string[];
  /**
   * How wide this driver's native session store reaches. Defaulting to
   * `profile` keeps a driver that has never thought about account switching on
   * the conservative side: its profiles stay mutually unresumable.
   */
  readonly providerStoreScope?: HarnessProviderStoreScope;
  /** Required when inspect advertises setup methods; external sign-ins need none. */
  authenticate?(
    context: HarnessAuthenticationContext,
    selection: HarnessAuthenticationSelection,
  ): Promise<HarnessAuthenticationStart>;
  logout?(context: HarnessAuthenticationContext, selection: HarnessLogoutSelection): Promise<void>;
  /** Provider-owned cleanup performed before Runner-owned isolated state is deleted. */
  removeProfile?(context: HarnessAuthenticationContext): Promise<void>;
  /**
   * How a command the model runs is launched under this driver's own command
   * sandbox for a Run, so the Runner can prove a resource (the machine-access
   * relay) is reachable from where the model's commands actually run, not just
   * from the Runner. A driver whose sandbox cannot be replayed outside its own
   * process leaves the launch unchanged; its allowances are then declared,
   * measured facts (`machineAccess` in `harnessCatalog`) rather than probed ones.
   */
  modelCommandLaunch?(context: HarnessModelCommandContext): Promise<HarnessProcessLaunchWrapper>;
  /** One-time, potentially slow preparation required before inspection or use. */
  prepare?(context: HarnessPreparationContext): Promise<void>;
  inspect?(context: HarnessInspectionContext): Promise<HarnessInspectionResult>;
  create(context: HarnessDriverCreateContext): Promise<HarnessAdapter>;
}

/**
 * The person's own install of an engine, which accounts using the person's own
 * sign-in run instead of the engine a distribution ships. The sign-in and the
 * program that reads it then come from the same installation, and a new model
 * reaches the person the day their CLI knows it.
 */
export interface HarnessInstalledEngine {
  /** The person's executable on this computer, looked up on every use. */
  readonly locate: () => string | undefined;
  /** The driver that runs that executable. */
  readonly create: (executable: string) => HarnessDriver;
  /** Why an account using the person's own sign-in cannot run on this computer. */
  readonly missing: string;
  /** Which profiles use this executable: shipped alternatives are ambient-only. */
  readonly scope?: "ambient" | "all";
  readonly update?: InstalledEngineUpdateFacts;
}

/**
 * Runner-local readiness for a driver. `runtime-check` means the adapter is
 * installed, but instance-specific executables or provider handshakes are
 * deliberately verified when a session starts.
 */
export type HarnessDriverReadiness =
  | {
      readonly note?: string;
      readonly status: "configured" | "runtime-check";
    }
  | {
      readonly reason: string;
      readonly status: "unavailable";
    };

export interface HarnessDriverState {
  readonly kind: HarnessId;
  readonly readiness: HarnessDriverReadiness;
}

export interface HarnessInstanceDefinition {
  readonly id: HarnessInstanceId;
  readonly driverKind: HarnessId;
  readonly name: string;
  readonly config: unknown;
  readonly runtimeRevision: HarnessRuntimeRevision;
  readonly sourceId: string;
  readonly stateKind: HarnessInstanceStateKind;
}

export type HarnessInstanceState =
  | {
      readonly definition: HarnessInstanceDefinition;
      readonly status: "available";
    }
  | {
      readonly definition: HarnessInstanceDefinition;
      readonly status: "unavailable";
      readonly reason: string;
    };
