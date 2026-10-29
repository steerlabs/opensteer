import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { isRecord } from "@opensteer/shared/isRecord";
import { readBoundedRegularFile } from "@opensteer/shared/privateFiles";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { mkdir, open as openFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  attachmentMaxBytes,
  attachmentImageMaxPixels,
  attachmentNativeImageMediaTypes,
  HarnessIdSchema,
  ModelIdSchema,
  ModelProviderIdSchema,
  OpensteerError,
  canonicalModelReference,
  createId,
  harnessUsageLimitFailureCode,
  modelDisplayName,
  normalizeToolOutput,
  type HarnessInstanceId,
  type ModelSelection,
  type PendingRequest,
  type RequestId,
  type RequestResponse,
  type ToolIdentity,
  type UserId,
} from "@opensteer/core";
import { toolsForCapabilityProfile } from "@opensteer/agent-tools";
import { integrationGatewayToolNames } from "@opensteer/integration-core";
import { maxHarnessModelsPerCatalog } from "@opensteer/protocol";
import {
  Deferred,
  runTitleProcess,
  withTitleDirectory,
  type HarnessTitleInput,
  HarnessSteerDeliveryUnknownError,
  HarnessSessionRegistry,
  TurnPublisher,
  assertFreshProviderSessionContext,
  initialContinuationContextPrompt,
  boundedDenialNote,
  clampConnectionLabel,
  CompatibleEndpointHttpError,
  compatibleEndpointFailureDetail,
  discoverCompatibleEndpointModels,
  durableHistoryWindowNotice,
  compatibleEndpointHost,
  harnessInputHeader,
  importModelServerSettingsKey,
  modelServerSettingsKey,
  modelServerSettingsMethod,
  modelServerSettingsMethodId,
  harnessTurnPreamble,
  nativeImageBase64Budget,
  prepareNativeImage,
  resolvedInputParts,
  opensteerToolIdentity,
  profileHarnessProviderStoreScope,
  providerSecretFile,
  reasoningEffortLabel,
  renderHarnessSkillCatalog,
  runEndedEvent,
  runFailedEvent,
  runStartedEvent,
  secretInputAuthentication,
  spawnSupervised,
  toHarnessError,
  type HarnessAdapter,
  type HarnessAuthenticationContext,
  type HarnessAuthenticationResult,
  type ModelServerProbeOptions,
  type HarnessAuthenticationSelection,
  type HarnessAuthenticationStart,
  type HarnessCapabilities,
  type HarnessDriver,
  type HarnessDriverCreateContext,
  type HarnessEvent,
  type HarnessInput,
  type HarnessInspectionContext,
  type HarnessInspectionResult,
  type HarnessLogoutSelection,
  type HarnessModelDescriptor,
  type HarnessObservedConnection,
  type HarnessProviderState,
  type HarnessProviderStoreScope,
  type HarnessRunInput,
  type HarnessSession,
  type HarnessSessionContext,
  type HarnessSteerInput,
  type ResolvedAttachment,
} from "@opensteer/harness";
import { z } from "zod";
import { PiHarnessConfigSchema, TESTED_PI_VERSION, type PiHarnessConfig } from "./config.js";
import {
  piExtensionFileName,
  piExtensionProtocolVersion,
  piExtensionSource,
  piHandshakePrefix,
  type PiExtensionRequest,
  type PiExtensionToolDefinition,
  type PiToolAnswer,
} from "./extension.js";
import {
  PiLoginMessageSchema,
  piLoginScriptFileName,
  piLoginScriptSource,
  piPackageEntryUrl,
} from "./login.js";
import {
  connectPiMcpServer,
  piAgentToolsServer,
  piIntegrationToolsServer,
  type PiMcpConnect,
  type PiMcpConnection,
} from "./mcp.js";
import { PiRpcClient, runPiCommand, toPiProcessError, type PiLaunch } from "./process.js";
import {
  PiLineFramer,
  optionalNumber,
  optionalString,
  protocolError,
  requireObject,
  requireString,
  type JsonObject,
  type PiMessage,
} from "./protocol.js";
import {
  piAccessModeGate,
  piAccessModes,
  piApiKeySetupMethodId,
  piCommandTools,
  piCompatibleProviderId,
  piCompatibleSourceId,
  piDeviceCodeSetupMethodId,
  piFileChangeTools,
  piReadOnlyTools,
  piSetupMethods,
  piSourceRow,
  piSources,
  type PiSourceRow,
} from "./sources.js";

export {
  piAccessModeGate,
  piAccessModes,
  piCommandTools,
  piCompatibleProviderId,
  piCompatibleSourceId,
  piFileChangeTools,
  piReadOnlyTools,
  piSetupMethods,
  piSourceRow,
  piSourceTable,
  piSources,
  type PiAccessModeGate,
  type PiCredentialKind,
  type PiSourceRow,
} from "./sources.js";
export {
  piExtensionFileName,
  piExtensionProtocolVersion,
  piExtensionSource,
  piHandshakePrefix,
  type PiExtensionRequest,
  type PiExtensionToolDefinition,
  type PiToolAnswer,
  type PiToolContent,
} from "./extension.js";
export {
  PiLoginMessageSchema,
  piLoginScriptFileName,
  piLoginScriptSource,
  piPackageEntryUrl,
} from "./login.js";
export {
  connectPiMcpServer,
  piAgentToolsServer,
  piIntegrationToolsServer,
  piToolCallTimeoutMs,
  piToolContent,
  type PiMcpConnect,
  type PiMcpConnectOptions,
  type PiMcpConnection,
  type PiMcpServerPlan,
} from "./mcp.js";
export { PiHarnessConfigSchema, TESTED_PI_VERSION, type PiHarnessConfig } from "./config.js";
export type { PiLaunch } from "./process.js";

type SessionMode =
  { readonly type: "start" } | { readonly reference: string; readonly type: "resume" };

/**
 * Pi keeps no permission system, no native question tool, and no way to attach
 * bytes to a prompt that Opensteer can supply: a Thread input's non-text part
 * is an artifact id, and nothing on the Runner turns one into bytes, so
 * `prompt.images` has no source to fill it from and attachments are declared
 * false rather than silently dropped (pi-facts §8).
 */
const piHarnessCapabilities: HarnessCapabilities = Object.freeze({
  approvals: true,
  attachments: true,
  messageAttachments: {
    nativeImages: {
      maxBytes: attachmentMaxBytes,
      maxPixels: attachmentImageMaxPixels,
      mediaTypes: attachmentNativeImageMediaTypes,
      steering: true,
    },
  },
  interruption: true,
  // The driver is Pi's MCP client, and it maps an image content block onto the
  // image block a Pi tool result carries, so the model sees the picture.
  mcpImageContent: true,
  resume: true,
  steering: true,
  toolCalls: true,
  userInput: false,
});

/** Every built-in tool this driver was written against, used to fail closed on a new one. */
const piKnownTools: readonly string[] = [
  ...piCommandTools,
  ...piFileChangeTools,
  ...piReadOnlyTools,
];

const piAuthFileName = "auth.json";
const piModelsFileName = "models.json";
const piInstructionsFileName = "opensteer-instructions.md";
const piAuthFileMaxBytes = 256 * 1_024;
const piVersionTimeoutMs = 20_000;
const piAuthCheckTimeoutMs = 30_000;
const piCatalogTimeoutMs = 60_000;
const piCompatibleModelsTimeoutMs = 5_000;
const piDeviceCodeTimeoutMs = 10 * 60_000;
const piDenialNoteMaxBytes = 20_000;
const piLoginLineMaxBytes = 64 * 1_024;
const primaryConnectionSlot = "primary";

export const piIsolatedServiceDetail =
  "Pi has no command sandbox of its own, so it runs only on a computer you own.";

export interface PiHarnessDependencies {
  /** Pi's staged `dist/bundle/cli.js`, as the catalog's `script` runtime names it. */
  readonly executable: string;
  /**
   * The Runner's own verified Node. `process.execPath` is Electron when the
   * desktop app hosts the Runner, which cannot run Pi.
   */
  readonly nodeExecutable: string;
  /** How a compatible endpoint's model list is fetched; injected by tests. */
  readonly fetchModels?: typeof fetch;
  /** Where model server apps keep their own settings; the Runner's home by default. */
  readonly modelServerHome?: string;
  /** How Opensteer's MCP servers are reached; injected by tests. */
  readonly connectMcpServer?: PiMcpConnect;
  /** How the device-code sign-in child is started; injected by tests. */
  readonly spawnLoginProcess?: typeof spawnSupervised;
}

export class PiHarnessDriver implements HarnessDriver {
  readonly kind = HarnessIdSchema.parse("pi");
  readonly sources = piSources;
  /** `piAccessModeGate` translates each of them into the tool names the extension stops on. */
  readonly accessModes = piAccessModes;
  readonly capabilities = piHarnessCapabilities;
  readonly configSchema = PiHarnessConfigSchema;
  readonly environmentVariables = ["PI_CODING_AGENT_DIR"] as const;
  /**
   * Pi records a session's own directory inside the session file and resumes
   * strictly from that file, so one profile's conversations are its own. The
   * conservative default is the correct one here (X4).
   */
  readonly providerStoreScope: HarnessProviderStoreScope = profileHarnessProviderStoreScope;
  readonly #dependencies: PiHarnessDependencies;

  constructor(dependencies: PiHarnessDependencies) {
    this.#dependencies = dependencies;
  }

  async authenticate(
    context: HarnessAuthenticationContext,
    selection: HarnessAuthenticationSelection = { methodId: piApiKeySetupMethodId },
  ): Promise<HarnessAuthenticationStart> {
    const config = PiHarnessConfigSchema.parse(context.config);
    if (selection.connectionSlot && selection.connectionSlot !== primaryConnectionSlot) {
      throw new OpensteerError({ code: "bad_request", message: "Unknown Pi connection" });
    }
    const row = piSourceRow(context.sourceId);
    if (context.providerState.kind !== "isolated") {
      // An ambient profile is the person's own `~/.pi/agent`. Writing a
      // Deployment's credential into it would hand that credential to
      // everything else on the computer that runs Pi.
      throw new OpensteerError({ code: "bad_request", message: ambientSignInDetail(row) });
    }
    if (
      row.sourceId === piCompatibleSourceId &&
      selection.methodId === modelServerSettingsMethodId
    ) {
      // The same literal store a pasted key takes: `auth.json` is never
      // interpolated, where `models.json` would run a leading `!`.
      await importModelServerSettingsKey(
        config,
        async (key) => {
          await materializePiProviderHome(context.providerState);
          await writePiCredential(context.providerState, row.authKey, { key, type: "api_key" });
        },
        piModelServerProbeOptions(this.#dependencies, context.signal),
      );
      return { status: "ready" };
    }
    if (selection.methodId === piApiKeySetupMethodId) {
      if (!row.credentials.includes("api-key")) {
        throw new OpensteerError({ code: "bad_request", message: "Unknown Pi setup method" });
      }
      return secretInputAuthentication({
        cancelledDetail: "The API key was not entered",
        engineLabel: "Pi",
        inputLabel: `${row.label} API key`,
        requiredMessage: `${row.label} API key is required`,
        signal: context.signal,
        store: async (key) => {
          await materializePiProviderHome(context.providerState);
          await writePiCredential(context.providerState, row.authKey, { key, type: "api_key" });
        },
        storeFailedDetail: `The ${row.label} API key could not be stored`,
      });
    }
    if (selection.methodId === piDeviceCodeSetupMethodId) {
      if (!row.credentials.includes("device-code")) {
        throw new OpensteerError({ code: "bad_request", message: "Unknown Pi setup method" });
      }
      return startPiDeviceCodeLogin(row, context, this.#dependencies);
    }
    throw new OpensteerError({ code: "bad_request", message: "Unknown Pi setup method" });
  }

  async logout(
    context: HarnessAuthenticationContext,
    selection: HarnessLogoutSelection = {},
  ): Promise<void> {
    PiHarnessConfigSchema.parse(context.config);
    if (selection.connectionSlot && selection.connectionSlot !== primaryConnectionSlot) {
      throw new OpensteerError({ code: "bad_request", message: "Unknown Pi connection" });
    }
    const row = piSourceRow(context.sourceId);
    if (context.providerState.kind !== "isolated") {
      // There is no Opensteer-held credential to remove, and Pi's own sign-out
      // would take the person's.
      throw new OpensteerError({ code: "bad_request", message: ambientSignOutDetail(row) });
    }
    await removePiCredential(context.providerState, row.authKey);
  }

  async removeProfile(context: HarnessAuthenticationContext): Promise<void> {
    // Removing the Opensteer record never removes ambient provider files: an
    // ambient profile shares the computer's own Pi home.
    if (context.providerState.kind !== "isolated") return;
    await this.logout(context);
  }

  async inspect(context: HarnessInspectionContext): Promise<HarnessInspectionResult> {
    const config = PiHarnessConfigSchema.parse(context.config);
    const row = piSourceRow(context.sourceId);
    if (context.runtimeBoundary.kind !== "native-user") {
      return { detail: piIsolatedServiceDetail, status: "unavailable" };
    }
    const environment = await piProcessEnvironment(context.environment, context.providerState);
    const version = await readPiVersion(
      this.#dependencies,
      environment,
      context.workingDirectory,
      context.signal,
    );
    if (version) return version;
    if (row.sourceId === piCompatibleSourceId) {
      return inspectPiCompatibleEndpoint(config, context, row, this.#dependencies);
    }
    const ready = await readPiAuthStatus(
      this.#dependencies,
      environment,
      context.workingDirectory,
      row.provider,
      context.signal,
    );
    const isolated = context.providerState.kind === "isolated";
    if (!ready) {
      return {
        connections: [
          {
            ...piConnectionAuthKind(row, undefined),
            connectionSlot: primaryConnectionSlot,
            label: row.label,
            status: "authentication-required",
          },
        ],
        detail: isolated
          ? `Add a ${row.label} credential before using this account`
          : `Sign in to ${row.label} with Pi on this computer before using this account`,
        ...(isolated ? { setupMethods: piSetupMethods(row) } : {}),
        status: "authentication-required",
      };
    }
    let models: readonly HarnessModelDescriptor[];
    try {
      models = await readPiCatalog(
        this.#dependencies,
        environment,
        context.workingDirectory,
        row,
        context.signal,
      );
    } catch (error) {
      if (error instanceof OpensteerError && error.code === "harness_error") {
        return { detail: error.message, status: "unavailable" };
      }
      throw error;
    }
    if (models.length === 0) {
      return {
        detail: `Pi reported no ${row.label} models for this account`,
        status: "unavailable",
      };
    }
    const credential = isolated
      ? await readPiCredential(context.providerState, row.authKey)
      : undefined;
    return {
      connections: [
        {
          ...piConnectionAuthKind(row, credential),
          ...(row.billingLabel ? { billingLabel: row.billingLabel } : {}),
          connectionSlot: primaryConnectionSlot,
          label: clampConnectionLabel(row.label) ?? row.label,
          logoutSupported: isolated,
          status: "connected" as const,
        },
      ],
      detail: `Pi is signed in to ${row.label} and ready`,
      models,
      ...(isolated ? { setupMethods: piSetupMethods(row) } : {}),
      status: "ready",
    };
  }

  async create(context: HarnessDriverCreateContext): Promise<HarnessAdapter> {
    const config = PiHarnessConfigSchema.parse(context.config);
    const row = piSourceRow(context.sourceId);
    if (row.sourceId === piCompatibleSourceId && config.baseUrl === undefined) {
      throw new OpensteerError({
        code: "bad_request",
        message: "This account has no base URL for its OpenAI-compatible endpoint",
      });
    }
    return new PiHarnessAdapter(context.instanceId, config, row, this.#dependencies);
  }
}

function ambientSignInDetail(row: PiSourceRow): string {
  return `Sign in to ${row.label} with Pi yourself on this computer; Opensteer never writes a credential into your own Pi home.`;
}

function ambientSignOutDetail(row: PiSourceRow): string {
  return `This account uses your own Pi sign-in for ${row.label}; sign out with Pi yourself.`;
}

function piConnectionAuthKind(
  row: PiSourceRow,
  credential: PiCredential | undefined,
): { readonly authKind: NonNullable<HarnessObservedConnection["authKind"]> } {
  if (credential?.type === "oauth") return { authKind: "subscription" };
  if (credential?.type === "api_key") return { authKind: "api-key" };
  // With nothing stored — an ambient profile, or one inspected before its first
  // sign-in — the row says which kinds it can hold; a row that offers only the
  // device flow can only be a subscription.
  return {
    authKind:
      row.credentials.length === 1 && row.credentials[0] === "device-code"
        ? "subscription"
        : "api-key",
  };
}

class PiHarnessAdapter implements HarnessAdapter {
  readonly capabilities = piHarnessCapabilities;
  readonly instanceId: HarnessInstanceId;
  readonly #config: PiHarnessConfig;
  readonly #dependencies: PiHarnessDependencies;
  readonly #row: PiSourceRow;
  readonly #sessions = new HarnessSessionRegistry<PiHarnessSession>("Pi");

  constructor(
    instanceId: HarnessInstanceId,
    config: PiHarnessConfig,
    row: PiSourceRow,
    dependencies: PiHarnessDependencies,
  ) {
    this.instanceId = instanceId;
    this.#config = config;
    this.#row = row;
    this.#dependencies = dependencies;
  }

  async startSession(context: HarnessSessionContext): Promise<HarnessSession> {
    this.#sessions.assertOpen();
    assertFreshProviderSessionContext(context);
    // Pi names the session file, so the reference only exists once the process
    // has answered `get_state`.
    return this.#sessions.openUnreferenced(() => this.#open(context, { type: "start" }));
  }

  async resumeSession(
    providerSessionReference: string,
    context: HarnessSessionContext,
  ): Promise<HarnessSession> {
    this.#sessions.assertOpen();
    const reference = validateProviderReference(providerSessionReference);
    return this.#sessions.open(reference, () => this.#open(context, { reference, type: "resume" }));
  }

  async close(): Promise<void> {
    await this.#sessions.close();
  }

  #open(context: HarnessSessionContext, mode: SessionMode): Promise<PiHarnessSession> {
    return PiHarnessSession.open(
      this.#config,
      this.#row,
      this.#dependencies,
      context,
      mode,
      (closed) => this.#sessions.release(closed),
    );
  }
}

interface ActiveTurn {
  /**
   * Pi's latest message in this run was a final answer. When Pi then starts
   * on a steered message, that answer was the reply of a turn of its own.
   */
  answered: boolean;
  /** Pi settled while a steered message was still to open a turn of its own. */
  awaitingSteeredTurn: boolean;
  readonly completion: Deferred<void>;
  interruptPromise?: Promise<void>;
  interruptRequested: boolean;
  readonly requestedBy: UserId;
  readonly runId: HarnessRunInput["runId"];
  started: boolean;
  terminal: boolean;
  readonly toolLifetime: AbortController;
  /**
   * Prompts of messages steered into the Run that Pi has not yet started on.
   * Each opens Pi's next user message, between tool rounds or as a turn of
   * its own, so the Run is not over while any is outstanding.
   */
  readonly unansweredSteers: string[];
  readonly usage: MutableUsage;
  usageReported: boolean;
}

interface MutableUsage {
  cacheWriteTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  stated: boolean;
}

interface PendingApproval {
  readonly extensionRequestId: string;
  readonly kind: "command" | "file-change";
}

class PiHarnessSession implements HarnessSession {
  readonly events: AsyncIterable<HarnessEvent>;
  readonly #config: PiHarnessConfig;
  readonly #context: HarnessSessionContext;
  readonly #dependencies: PiHarnessDependencies;
  readonly #onClose: (session: PiHarnessSession) => void;
  readonly #pendingRequests = new Map<RequestId, PendingApproval>();
  readonly #processLifetime = new AbortController();
  readonly #publisher: TurnPublisher;
  readonly #row: PiSourceRow;
  readonly #abortListener: () => void;
  readonly #handshake = new Deferred<void>();
  readonly #connections = new Map<string, PiMcpConnection>();
  readonly #toolServers = new Map<string, string>();
  #activeTurn: ActiveTurn | undefined;
  #client: PiRpcClient | undefined;
  #closed = false;
  #handshakeFailure: OpensteerError | undefined;
  #handshakeSeen = false;
  #handshakeNonce = "";
  #providerSessionReference: string | undefined;
  #settled: Deferred<void> | undefined;
  #stopPromise: Promise<void> | undefined;
  #toolDefinitions: readonly PiExtensionToolDefinition[] = [];

  private constructor(
    config: PiHarnessConfig,
    row: PiSourceRow,
    dependencies: PiHarnessDependencies,
    context: HarnessSessionContext,
    onClose: (session: PiHarnessSession) => void,
  ) {
    this.#config = config;
    this.#row = row;
    this.#dependencies = dependencies;
    this.#context = context;
    this.#onClose = onClose;
    this.#publisher = new TurnPublisher({
      maxBytes: config.maxEventBytes,
      maxItems: config.maxEventItems,
    });
    this.events = this.#publisher.events;
    this.#abortListener = () => void this.stop();
    context.signal.addEventListener("abort", this.#abortListener, { once: true });
  }

  static async open(
    config: PiHarnessConfig,
    row: PiSourceRow,
    dependencies: PiHarnessDependencies,
    context: HarnessSessionContext,
    mode: SessionMode,
    onClose: (session: PiHarnessSession) => void,
  ): Promise<PiHarnessSession> {
    if (context.runtimeBoundary.kind !== "native-user") {
      // Pi has no sandbox, and the Runner's own sandbox binds the profile home
      // and the Thread state directory into the harness process tree, so on a
      // shared Runner a model-run command would read this profile's credentials.
      throw new OpensteerError({ code: "harness_error", message: piIsolatedServiceDetail });
    }
    if (context.signal.aborted) {
      throw new OpensteerError({
        code: "harness_error",
        message: "Pi session was cancelled before startup",
      });
    }
    const session = new PiHarnessSession(config, row, dependencies, context, onClose);
    try {
      await session.#initialize(mode);
      return session;
    } catch (error) {
      await session.#stop(false);
      throw error;
    }
  }

  get providerSessionReference(): string {
    if (!this.#providerSessionReference) {
      throw new OpensteerError({
        code: "internal",
        message: "Pi session has not finished opening",
      });
    }
    return this.#providerSessionReference;
  }

  async generateTitle({ prompt, signal }: HarnessTitleInput): Promise<string> {
    const environment = await piProcessEnvironment(
      this.#context.environment,
      this.#context.providerState,
    );
    return withTitleDirectory(this.#context, (directory) =>
      runTitleProcess(
        this.#context,
        {
          executable: this.#dependencies.nodeExecutable,
          args: [
            this.#dependencies.executable,
            "--print",
            "--no-session",
            "--no-tools",
            "--no-extensions",
            "--no-skills",
            "--no-context-files",
            "--no-prompt-templates",
            // no-context-files excludes AGENTS.md, but 0.87.1 discovers
            // SYSTEM.md and APPEND_SYSTEM.md separately unless overridden.
            "--system-prompt",
            "You name tasks. Reply exactly in the format the request asks for. Never use tools.",
            "--append-system-prompt",
            " ",
            "--provider",
            this.#row.provider,
            "--model",
            piModelSelectionId(this.#context.modelSelection),
            "--thinking",
            "off",
            "--no-approve",
          ],
          cwd: directory,
          environment,
        },
        signal,
        prompt,
      ),
    );
  }

  async execute(run: HarnessRunInput): Promise<void> {
    this.#assertUsable();
    if (this.#activeTurn) {
      throw new OpensteerError({
        code: "conflict",
        message: "Pi session already has an active turn",
      });
    }
    const message = [
      initialContinuationContextPrompt(this.#context),
      inputsToPiPrompt(run.inputs, run, run.attachments),
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
    const images = await piImages("prompt", run.inputs, message, this.#config, run.attachments);
    const active: ActiveTurn = {
      answered: false,
      awaitingSteeredTurn: false,
      completion: new Deferred<void>(),
      interruptRequested: run.signal.aborted,
      requestedBy: run.requestedBy,
      runId: run.runId,
      started: false,
      terminal: false,
      toolLifetime: new AbortController(),
      unansweredSteers: [],
      usage: emptyUsage(),
      usageReported: false,
    };
    this.#activeTurn = active;
    this.#settled = new Deferred<void>();
    const abort = () => {
      active.interruptRequested = true;
      void this.#interruptActive(active);
    };
    if (!run.signal.aborted) run.signal.addEventListener("abort", abort, { once: true });
    try {
      if (run.signal.aborted) {
        this.#publishTerminal(active, "interrupted");
        return;
      }
      const response = await this.#requireClient().command("prompt", { message, images });
      if (response.success !== true) {
        // Pi refuses a prompt before the model is ever reached when no
        // credential resolves; that is the Run's failure, not a protocol fault.
        throw new OpensteerError({
          code: "harness_error",
          message: optionalString(response.error) ?? "Pi refused the prompt",
        });
      }
      this.#ensureRunStarted(active);
      if (active.interruptRequested) void this.#interruptActive(active);
      await active.completion.promise;
    } catch (error) {
      if (!active.terminal) {
        if (run.signal.aborted || this.#closed) this.#publishTerminal(active, "interrupted");
        else this.#publishFailure(active, toHarnessError(error, "Pi turn failed"));
      }
    } finally {
      run.signal.removeEventListener("abort", abort);
      if (this.#activeTurn === active) this.#activeTurn = undefined;
    }
  }

  async interrupt(): Promise<void> {
    const active = this.#activeTurn;
    if (!active || active.terminal) return;
    active.interruptRequested = true;
    await this.#interruptActive(active);
  }

  async steer(input: HarnessSteerInput): Promise<void> {
    this.#assertUsable();
    const active = this.#activeTurn;
    if (!active || active.terminal || active.interruptRequested) throw steerConflict();
    const client = this.#requireClient();
    const message = inputsToPiPrompt([input.input], null, input.attachments);
    // Preparing images sends nothing, so a failure here is a definite refusal.
    const images = await piImages("steer", [input.input], message, this.#config, input.attachments);
    // Pi's `steer` queues even when nothing is running, where nothing would
    // ever take it. A prompt that steers is queued between tool rounds while
    // Pi runs and opens a turn of its own once Pi has settled.
    active.unansweredSteers.push(message);
    let response;
    try {
      response = await client.command("prompt", { images, message, streamingBehavior: "steer" });
    } catch (error) {
      this.#forgetSteer(active, message);
      const failure = toHarnessError(error, "Failed to steer the Pi turn");
      throw new HarnessSteerDeliveryUnknownError(failure.message, { cause: failure });
    }
    if (response.success !== true) {
      this.#forgetSteer(active, message);
      throw new OpensteerError({
        code: "conflict",
        message: optionalString(response.error) ?? "Pi has no steerable active turn",
      });
    }
  }

  /** A steer Pi will not run: the Run ends once Pi has settled and nothing else is owed. */
  #forgetSteer(active: ActiveTurn, message: string): void {
    const index = active.unansweredSteers.indexOf(message);
    if (index !== -1) active.unansweredSteers.splice(index, 1);
    if (active.awaitingSteeredTurn && active.unansweredSteers.length === 0)
      this.#publishTerminal(active, active.interruptRequested ? "interrupted" : "completed");
  }

  async resolveRequest(requestId: RequestId, response: RequestResponse): Promise<void> {
    this.#assertUsable();
    const pending = this.#pendingRequests.get(requestId);
    if (!pending) throw new OpensteerError({ code: "not_found", message: "Pi Request not found" });
    if (response.kind !== "choice" || !piApprovalOptionIds.has(response.optionId)) {
      throw invalidPiRequestResponse();
    }
    const note = boundedDenialNote(response.text, {
      maximumBytes: piDenialNoteMaxBytes,
      tooLong: invalidPiRequestResponse,
    });
    this.#pendingRequests.delete(requestId);
    await this.#answerExtension(
      pending.extensionRequestId,
      response.optionId === "allow-once"
        ? { decision: "allow" }
        : { decision: "deny", ...(note ? { note: piDenialNote(pending.kind, note) } : {}) },
    );
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop(true);
    return this.#stopPromise;
  }

  async #initialize(mode: SessionMode): Promise<void> {
    const context = this.#context;
    const environment = await piProcessEnvironment(context.environment, context.providerState);
    if (context.providerState.kind === "isolated" && this.#row.sourceId === piCompatibleSourceId) {
      const apiKey = optionalString(
        (await readPiCredential(context.providerState, this.#row.authKey))?.key,
      );
      const models = await discoverCompatibleEndpointModels(
        this.#config,
        apiKey ? { kind: "api-key", apiKey } : { kind: "none" },
        {
          ...(this.#dependencies.fetchModels
            ? { fetchModels: this.#dependencies.fetchModels }
            : {}),
          signal: context.signal,
          timeoutMs: piCompatibleModelsTimeoutMs,
        },
      );
      const model = models.find(
        (candidate) => candidate.nativeModelId === piModelSelectionId(context.modelSelection),
      );
      if (!model) {
        throw new OpensteerError({
          code: "harness_error",
          message: `The endpoint no longer lists ${piModelSelectionId(context.modelSelection)}`,
        });
      }
      if (model.unavailableReason || !model.contextWindow) {
        throw new OpensteerError({
          code: "harness_error",
          message:
            model.unavailableReason ??
            `Set the context window for ${piModelSelectionId(context.modelSelection)}`,
        });
      }
      await writePiModelsFile(
        context.providerState,
        models.filter((candidate) => !candidate.unavailableReason),
        this.#config,
      );
    }
    const resumed =
      mode.type === "resume" ? await this.#verifyResumeTarget(mode.reference) : undefined;
    await this.#connectToolServers();
    await mkdir(resolve(context.threadStateDirectory), { mode: 0o700, recursive: true });
    const instructionsPath = join(resolve(context.threadStateDirectory), piInstructionsFileName);
    const skillCatalog = await renderHarnessSkillCatalog(context.skills);
    await replacePrivateFileAtomically(
      instructionsPath,
      piInstructions(context, this.#toolDefinitions, skillCatalog),
    );
    this.#handshakeNonce = createId("request");
    const extensionPath = join(resolve(context.threadStateDirectory), piExtensionFileName);
    await replacePrivateFileAtomically(
      extensionPath,
      piExtensionSource({
        gate: piAccessModeGate(context.accessMode),
        handshakeNonce: this.#handshakeNonce,
        knownTools: piKnownTools,
        machineAccessNotice: context.machineAccessNotice,
        tools: this.#toolDefinitions,
      }),
    );

    this.#client = PiRpcClient.start({
      args: piProcessArguments({
        context,
        extensionPath,
        instructionsPath,
        ...(mode.type === "resume" ? { sessionPath: mode.reference } : {}),
      }),
      config: this.#config,
      cwd: context.workspacePath,
      environment,
      launch: piLaunch(this.#dependencies),
      onEvent: (event) => this.#handleEvent(event),
      onFailure: (error) => this.#handleConnectionFailure(error),
      signal: this.#processLifetime.signal,
      wrapProcessLaunch: context.wrapProcessLaunch,
    });

    await this.#awaitHandshake();
    await this.#selectModel();
    const state = requireObject(
      (await this.#requireClient().requireOk("get_state")).data,
      "Pi get_state result",
    );
    const sessionFile = resolve(requireString(state.sessionFile, "Pi get_state sessionFile"));
    const sessionId = requireString(state.sessionId, "Pi get_state sessionId");
    if (mode.type === "resume" && resumed) {
      // A resume attaches to exactly the recorded conversation or fails: Pi
      // silently mints a fresh session when the file it is pointed at is gone
      // (measured), and a fork would lose the Thread's continuation identity.
      if (sessionFile !== resolve(mode.reference)) {
        throw protocolError(
          `Pi attached to ${sessionFile} while Opensteer asked for ${mode.reference}`,
        );
      }
      if (sessionId !== resumed.sessionId) {
        throw protocolError(
          `Pi resumed session ${sessionId} while Opensteer asked for ${resumed.sessionId}`,
        );
      }
    }
    this.#providerSessionReference = sessionFile;
  }

  /**
   * Reads the recorded session header before the process starts. Pi writes the
   * file lazily, on the first message (pi-facts §3), so a reference naming a
   * file that never materialized — a Run that failed before its first prompt —
   * is a conversation that does not exist, and this is where that is said
   * rather than letting Pi open a brand new session at the same path
   * (measured: it does, with a new id and `messageCount: 0`).
   */
  async #verifyResumeTarget(reference: string): Promise<{ readonly sessionId: string }> {
    const header = await readPiSessionHeader(reference);
    if (!header) {
      throw new OpensteerError({
        code: "not_found",
        message: `The Pi session ${reference} no longer exists on this computer`,
      });
    }
    // Pi keys sessions by the directory they were started in and will not
    // continue one from elsewhere without forking it (pi-facts §3). Both sides
    // are resolved through their links first: Pi records its own resolved
    // `process.cwd()`, and a Workspace can be reached through a symlink.
    const [recorded, workspace] = await Promise.all([
      realpath(header.cwd).catch(() => resolve(header.cwd)),
      realpath(this.#context.workspacePath),
    ]);
    if (recorded !== workspace) {
      throw new OpensteerError({
        code: "conflict",
        message: `The Pi session ${reference} belongs to ${header.cwd}, not this Workspace`,
      });
    }
    return { sessionId: header.id };
  }

  /**
   * Opens both Opensteer MCP servers from inside the Runner and reads their
   * tool shapes. The connections stay here for the life of the session: the
   * extension calls back through the RPC stream rather than holding a token.
   */
  async #connectToolServers(): Promise<void> {
    const context = this.#context;
    const connect = this.#dependencies.connectMcpServer ?? connectPiMcpServer;
    // Both waits belong to session startup, so both carry its deadline and its
    // lifetime: a Host that accepts the socket and never answers would
    // otherwise hold the Run open with nothing to cancel it.
    const connectOptions = {
      signal: this.#processLifetime.signal,
      timeoutMs: this.#config.startupTimeoutMs,
    };
    const plans = [
      {
        name: piAgentToolsServer,
        token: context.agentTools.token,
        toolNames: toolsForCapabilityProfile(context.agentTools.capabilityProfileId).map(
          ({ name }) => name,
        ),
        url: context.agentTools.url,
      },
      {
        name: piIntegrationToolsServer,
        token: context.integrationTools.token,
        toolNames: [...integrationGatewayToolNames],
        url: context.integrationTools.url,
      },
    ];
    const definitions: PiExtensionToolDefinition[] = [];
    for (const plan of plans) {
      const connection = await connect(plan, connectOptions);
      this.#connections.set(plan.name, connection);
      for (const definition of await connection.listTools(connectOptions)) {
        if (this.#toolServers.has(definition.name)) {
          throw new OpensteerError({
            code: "conflict",
            message: `Two Opensteer servers offer a tool named ${definition.name}`,
          });
        }
        this.#toolServers.set(definition.name, plan.name);
        definitions.push(definition);
      }
    }
    this.#toolDefinitions = definitions;
  }

  /**
   * Pi cannot be asked which extensions loaded — `get_commands` lists commands,
   * not registered tools — and an extension that fails to load leaves Pi with no
   * gate at all and none of Opensteer's tools (measured; pi-facts risk 1). So
   * the extension announces itself with a per-session nonce and the session
   * refuses to run without it.
   */
  async #awaitHandshake(): Promise<void> {
    await withTimeout(this.#handshake.promise, this.#config.startupTimeoutMs, {
      timeoutError: () =>
        new OpensteerError({
          code: "harness_error",
          message: "The Opensteer extension did not load in Pi",
        }),
    });
    if (this.#handshakeFailure) throw this.#handshakeFailure;
    this.#requireClient();
  }

  async #selectModel(): Promise<void> {
    const client = this.#requireClient();
    const selection = this.#context.modelSelection;
    const provider = this.#row.provider;
    const modelId = piModelSelectionId(selection);
    const setModel = await client.command("set_model", { modelId, provider });
    if (setModel.success !== true) {
      throw new OpensteerError({
        code: "harness_error",
        message: `Pi could not select ${provider}/${modelId}: ${optionalString(setModel.error) ?? "no reason"}`,
      });
    }
    const thinking = piThinkingOption(selection);
    if (thinking) await client.requireOk("set_thinking_level", { level: thinking });
    const state = requireObject((await client.requireOk("get_state")).data, "Pi get_state result");
    const model = requireObject(state.model, "Pi get_state model");
    // `--model` fuzzy-matches and `--thinking` silently clamps, so what Pi
    // actually selected is read back rather than assumed (pi-facts §5).
    if (model.provider !== provider || model.id !== modelId) {
      throw protocolError(
        `Pi selected ${String(model.provider)}/${String(model.id)} instead of ${provider}/${modelId}`,
      );
    }
    if (thinking && state.thinkingLevel !== thinking) {
      throw protocolError(
        `Pi selected thinking level ${String(state.thinkingLevel)} instead of ${thinking}`,
      );
    }
  }

  #handleEvent(event: PiMessage): void {
    const active = this.#activeTurn;
    switch (event.type) {
      case "extension_ui_request":
        this.#handleExtensionUiRequest(event);
        return;
      case "extension_error":
        this.#handleExtensionError(event);
        return;
      default:
        break;
    }
    if (!active || active.terminal) return;
    // Turn events can beat the prompt command response under load. Extension
    // handshake notifications and startup errors are session events, so they
    // are deliberately excluded from this delivery receipt.
    if (
      [
        "message_update",
        "message_end",
        "tool_execution_start",
        "tool_execution_end",
        "auto_retry_start",
        "auto_retry_end",
        "agent_settled",
      ].includes(event.type)
    ) {
      this.#ensureRunStarted(active);
    }
    switch (event.type) {
      case "message_start":
        this.#startSteeredMessage(active, event);
        break;
      case "message_update":
        this.#publishMessageUpdate(event);
        break;
      case "message_end":
        this.#publishMessageEnd(active, event);
        break;
      case "tool_execution_start":
        this.#publishToolStarted(event);
        break;
      case "tool_execution_end":
        this.#publishToolCompleted(event);
        break;
      case "agent_settled":
        // `agent_end` repeats for every queued continuation and every retry;
        // only `agent_settled` means this prompt's work is over (pi-facts §2).
        this.#settled?.resolve();
        // A steer still on its way opens the next turn: this one has answered.
        if (active.unansweredSteers.length > 0 && !active.interruptRequested) {
          if (!active.awaitingSteeredTurn) {
            active.awaitingSteeredTurn = true;
            this.#publish({ data: { phase: "background" }, type: "run.phase" });
          }
          break;
        }
        this.#publishTerminal(active, active.interruptRequested ? "interrupted" : "completed");
        break;
      default:
        break;
    }
  }

  /** Pi starts on a steered message: between tool rounds, or as the turn it opens. */
  #startSteeredMessage(active: ActiveTurn, event: PiMessage): void {
    const message = isRecord(event.message) ? event.message : undefined;
    if (message?.role !== "user") return;
    const content = message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (block): block is { readonly text: string; readonly type: "text" } =>
                  isRecord(block) && block.type === "text" && typeof block.text === "string",
              )
              .map((block) => block.text)
              .join("")
          : "";
    const index = active.unansweredSteers.indexOf(text);
    if (index === -1) return;
    active.unansweredSteers.splice(index, 1);
    if (active.awaitingSteeredTurn) {
      active.awaitingSteeredTurn = false;
      this.#settled = new Deferred<void>();
    } else if (active.answered) {
      this.#publish({ data: { phase: "background" }, type: "run.phase" });
    } else return;
    active.answered = false;
    this.#publish({ data: { phase: "turn" }, type: "run.phase" });
  }

  #handleExtensionUiRequest(event: PiMessage): void {
    const id = requireString(event.id, "Pi extension_ui_request id");
    const method = optionalString(event.method);
    if (method === "notify") {
      this.#handleHandshake(optionalString(event.message) ?? "");
      return;
    }
    if (method !== "input") {
      // Nothing else is part of this contract; answering it would let a future
      // prompt hang the Run instead of failing it.
      this.#failHandshake(
        protocolError(`Pi extension asked for an unsupported ${String(method)} dialog`),
      );
      return;
    }
    let request: PiExtensionRequest;
    try {
      request = parseExtensionRequest(requireString(event.title, "Pi extension request"));
    } catch (error) {
      void this.#cancelExtensionRequest(id);
      this.#handleConnectionFailure(
        toHarnessError(error, "Pi sent an unreadable extension request"),
      );
      return;
    }
    const active = this.#activeTurn;
    if (!active || active.terminal || active.interruptRequested) {
      void this.#cancelExtensionRequest(id);
      return;
    }
    this.#ensureRunStarted(active);
    if (request.kind === "tool") {
      void this.#runOpensteerTool(id, request, active);
      return;
    }
    const requestId = createId("request");
    this.#pendingRequests.set(requestId, { extensionRequestId: id, kind: request.kind });
    try {
      this.#publish({
        data: { request: this.#pendingRequest(requestId, request, active) },
        type: "request.opened",
      });
    } catch (error) {
      this.#pendingRequests.delete(requestId);
      void this.#cancelExtensionRequest(id);
      throw error;
    }
  }

  /**
   * One Opensteer tool call, performed by the Runner on the model's behalf. The
   * call is bound to the turn: an interrupt cancels it and the extension turns
   * the refusal into a failed tool result, which is what the model sees.
   */
  async #runOpensteerTool(
    id: string,
    request: Extract<PiExtensionRequest, { kind: "tool" }>,
    active: ActiveTurn,
  ): Promise<void> {
    let answer: PiToolAnswer;
    try {
      const server = this.#toolServers.get(request.name);
      const connection = server ? this.#connections.get(server) : undefined;
      if (!server || server !== request.server || !connection) {
        throw new OpensteerError({
          code: "not_found",
          message: `Opensteer does not serve a tool named ${request.name}`,
        });
      }
      answer = await connection.callTool(
        request.name,
        request.arguments,
        active.toolLifetime.signal,
      );
    } catch (error) {
      const failure = toHarnessError(error, `The ${request.name} tool failed`);
      answer = { content: [{ text: failure.message, type: "text" }], isError: true };
    }
    await this.#answerExtension(id, answer);
  }

  async #answerExtension(id: string, answer: unknown): Promise<void> {
    await this.#client
      ?.send({ id, type: "extension_ui_response", value: JSON.stringify(answer) })
      .catch((error: unknown) => {
        this.#handleConnectionFailure(toHarnessError(error, "Failed to answer the Pi extension"));
      });
  }

  #handleHandshake(message: string): void {
    if (!message.startsWith(piHandshakePrefix)) return;
    let payload: { readonly nonce?: unknown; readonly hasUi?: unknown };
    try {
      payload = JSON.parse(message.slice(piHandshakePrefix.length)) as typeof payload;
    } catch (error) {
      this.#failHandshake(
        toHarnessError(error, "The Opensteer extension sent an unreadable handshake"),
      );
      return;
    }
    if (payload.nonce !== this.#handshakeNonce) {
      this.#failHandshake(protocolError("Pi loaded an Opensteer extension from another session"));
      return;
    }
    if (payload.hasUi !== true) {
      this.#failHandshake(protocolError("Pi cannot forward Opensteer approvals in this mode"));
      return;
    }
    this.#handshakeSeen = true;
    this.#handshake.resolve();
  }

  #handleExtensionError(event: PiMessage): void {
    // Pi reports an extension that threw and then carries on with no gate and
    // none of Opensteer's tools, so this is never survivable.
    const failure = protocolError(
      `The Opensteer extension failed in Pi: ${optionalString(event.error) ?? "unknown error"}`,
    );
    if (!this.#handshakeSeen) {
      this.#failHandshake(failure);
      return;
    }
    this.#handleConnectionFailure(failure);
  }

  #failHandshake(error: OpensteerError): void {
    this.#handshakeFailure ??= error;
    this.#handshake.resolve();
    if (this.#handshakeSeen) this.#handleConnectionFailure(error);
  }

  #pendingRequest(
    requestId: RequestId,
    request: Extract<PiExtensionRequest, { kind: "command" | "file-change" }>,
    active: ActiveTurn,
  ): PendingRequest {
    return {
      callId: request.toolCallId,
      cancellationReason: null,
      createdAt: new Date().toISOString(),
      id: requestId,
      kind: "harness.approval",
      mode: "live",
      originatingOccurrenceId: null,
      originatingRunId: active.runId,
      originatingThreadId: this.#context.threadId,
      originatingWorkspaceId: this.#context.workspaceId,
      payload: { kind: "harness.approval" },
      presentation: piApprovalPresentation(request),
      requestedBy: active.requestedBy,
      requiredActor: "requester",
      resolvedAt: null,
      resolvedBy: null,
      response: null,
      status: "pending",
      targetWorkspaceId: this.#context.workspaceId,
    };
  }

  #publishMessageUpdate(event: PiMessage): void {
    const delta = requireObject(event.assistantMessageEvent, "Pi message_update event");
    const type = optionalString(delta.type);
    const contentIndex = optionalNumber(delta.contentIndex) ?? 0;
    if (type === "text_delta") {
      this.#publish({ data: { text: optionalString(delta.delta) ?? "" }, type: "assistant.delta" });
      return;
    }
    if (type === "thinking_delta") {
      this.#publish({
        data: { blockId: `thinking-${contentIndex}`, text: optionalString(delta.delta) ?? "" },
        type: "reasoning.delta",
      });
      return;
    }
    if (type === "thinking_end") {
      const content = optionalString(delta.content) ?? "";
      if (!content) return;
      this.#publish({
        data: { blockId: `thinking-${contentIndex}`, text: content.slice(0, 250_000) },
        type: "reasoning.completed",
      });
    }
  }

  #publishMessageEnd(active: ActiveTurn, event: PiMessage): void {
    const message = requireObject(event.message, "Pi message_end message");
    if (message.role !== "assistant") return;
    accumulateUsage(active.usage, message.usage);
    if (message.stopReason === "error") {
      // Pi has no error event; a provider failure is an assistant message with
      // `stopReason: "error"` and free-text `errorMessage` (pi-facts §10).
      this.#publishFailure(active, piTurnError(optionalString(message.errorMessage)));
      return;
    }
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .flatMap((part) => {
        const entry = requireObject(part, "Pi assistant content part");
        return entry.type === "text" ? [optionalString(entry.text) ?? ""] : [];
      })
      .join("");
    if (!text) return;
    this.#publish({
      data: { content: [{ text, type: "text" }], messageId: createId("message") },
      type: "assistant.message",
    });
    active.answered = message.stopReason === "stop";
  }

  #publishToolStarted(event: PiMessage): void {
    const callId = optionalString(event.toolCallId);
    const toolName = optionalString(event.toolName);
    if (!callId || !toolName) return;
    this.#publish({
      data: { arguments: event.args, callId, tool: this.#toolIdentity(toolName) },
      type: "tool.started",
    });
  }

  #publishToolCompleted(event: PiMessage): void {
    const callId = optionalString(event.toolCallId);
    if (!callId) return;
    const result =
      typeof event.result === "object" && event.result !== null
        ? (event.result as JsonObject)
        : undefined;
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content
      .flatMap((part) => {
        const entry = requireObject(part, "Pi tool result part");
        return entry.type === "text" ? [optionalString(entry.text) ?? ""] : [];
      })
      .join("\n");
    this.#publish({
      data: { callId, isError: event.isError === true, output: normalizeToolOutput(text) },
      type: "tool.completed",
    });
  }

  /**
   * Opensteer's tools are registered under their own names, so the flat tool
   * name is all Pi reports; which server a name belongs to is what the driver
   * read from that server at session start.
   */
  #toolIdentity(toolName: string): ToolIdentity {
    const server = this.#toolServers.get(toolName);
    return server ? opensteerToolIdentity(server, toolName) : { name: toolName, namespace: "pi" };
  }

  async #interruptActive(active: ActiveTurn): Promise<void> {
    if (active.terminal) return;
    active.interruptPromise ??= this.#performInterrupt(active);
    await active.interruptPromise;
  }

  /**
   * Pi's `abort` cancels the in-flight call and then drains the queue, so an
   * abort on its own lets a queued follow-up start a whole new agent run
   * (measured; pi-facts §2). `clear_queue` first is what makes an interrupt an
   * interrupt, and `agent_settled` is the only event that means the work is
   * over.
   */
  async #performInterrupt(active: ActiveTurn): Promise<void> {
    active.toolLifetime.abort(new Error("Pi turn interrupted"));
    const client = this.#client;
    if (!client || client.failed) {
      await this.#cancelPendingRequests("run-ended");
      this.#publishTerminal(active, "interrupted");
      return;
    }
    try {
      await client.command("clear_queue");
      // A pending approval is holding the turn open: the extension is awaiting
      // this answer, so nothing settles until it is released. Cancelling first
      // makes the extension block the tool, which is the only safe answer and
      // the only way `agent_settled` can arrive.
      await this.#cancelPendingRequests("run-ended");

      await client.command("abort", {}, this.#config.interruptTimeoutMs);
      const settled = this.#settled?.promise;
      if (settled) {
        await withTimeout(settled, this.#config.interruptTimeoutMs, {
          timeoutError: () =>
            new OpensteerError({
              code: "timeout",
              message: "Pi did not settle after the turn was interrupted",
              retryable: true,
            }),
        });
      }
      this.#publishTerminal(active, "interrupted");
    } catch (error) {
      const failure = toHarnessError(error, "Failed to interrupt the Pi turn");
      await this.#cancelPendingRequests("run-ended");
      this.#publishFailure(active, failure);
      this.#publisher.latchUnusable(failure);
      await this.#client?.close(0);
      this.#closeEventStream(failure);
    }
  }

  async #stop(notifyOwner: boolean): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#context.signal.removeEventListener("abort", this.#abortListener);
    const active = this.#activeTurn;
    if (active && !active.terminal) {
      active.interruptRequested = true;
      await this.#interruptActive(active).catch(() => undefined);
    }
    await this.#cancelPendingRequests("run-ended").catch(() => undefined);
    this.#processLifetime.abort(new Error("Pi session stopped"));
    try {
      await this.#client?.close();
    } finally {
      // `close()` is bounded inside the connection: a transport that has
      // stopped answering must not hold the session's shutdown open.
      await Promise.allSettled(
        [...this.#connections.values()].map((connection) => connection.close()),
      );
      this.#connections.clear();
      this.#closeEventStream();
      if (notifyOwner && this.#providerSessionReference) this.#onClose(this);
    }
  }

  /**
   * Cancels every pending Request.
   *
   * The cancellations are published synchronously and before anything else
   * reaches the stream, because a Request the Host still shows as pending after
   * its Run ended can never be answered by anyone. Releasing the provider is a
   * separate errand: awaiting one answer between two cancellations would let a
   * terminal event interleave, which is exactly the ordering this protects.
   */
  #cancelPendingRequests(reason: "run-ended" | "source-closed"): Promise<void> {
    const pending = [...this.#pendingRequests.entries()];
    this.#pendingRequests.clear();
    for (const [requestId] of pending) {
      try {
        this.#publish({ data: { reason, requestId }, type: "request.cancelled" });
      } catch {
        // The stream latched its failure and closed; the remaining
        // cancellations cannot reach anyone either, but the provider still has
        // to be released below or Pi waits on an answer that will never come.
      }
    }
    return Promise.allSettled(
      pending.map(([, request]) => this.#cancelExtensionRequest(request.extensionRequestId)),
    ).then(() => undefined);
  }

  /** A cancelled dialog makes the extension block the tool, which is the only safe answer. */
  async #cancelExtensionRequest(id: string): Promise<void> {
    await this.#client
      ?.send({ cancelled: true, id, type: "extension_ui_response" })
      .catch(() => undefined);
  }

  #ensureRunStarted(active: ActiveTurn): void {
    if (active.started) return;
    active.started = true;
    this.#publish(runStartedEvent());
  }

  #publishTerminal(active: ActiveTurn, status: "completed" | "interrupted"): void {
    if (!this.#publisher.claimTerminal(active)) return;
    active.toolLifetime.abort(new Error(`Pi turn ${status}`));
    // Every terminal path goes through here, so this is the one place that can
    // promise no Request outlives its Run.
    void this.#cancelPendingRequests("run-ended");
    try {
      if (status === "completed") this.#ensureRunStarted(active);
      this.#publishUsage(active);
      this.#publish(runEndedEvent(status));
    } finally {
      active.completion.resolve();
    }
  }

  #publishFailure(active: ActiveTurn, error: OpensteerError): void {
    if (!this.#publisher.claimTerminal(active)) return;
    active.toolLifetime.abort(error);
    // Including a failure the Run never asked for: a process that died while a
    // person was looking at an approval leaves that Request unanswerable.
    void this.#cancelPendingRequests("run-ended");
    try {
      this.#publishUsage(active);
      this.#publish(
        runFailedEvent({
          code: piFailureCode(error),
          message: error.message,
          retryable: error.retryable,
        }),
      );
    } finally {
      active.completion.resolve();
    }
  }

  /**
   * This Run's own consumption, summed from the `usage` Pi states on each
   * assistant `message_end` between the prompt and `agent_settled`. `input` is
   * exclusive of cache reads there, so it maps straight onto `inputTokens`
   * without adding `cacheRead` (pi-facts §9). `cost.total` is Pi's own
   * arithmetic over its catalog prices; a source whose catalog carries no
   * prices reports zero, which is not a price, so a zero cost is left out.
   */
  #publishUsage(active: ActiveTurn): void {
    if (active.usageReported || !active.usage.stated) return;
    active.usageReported = true;
    const usage = active.usage;
    this.#publish({
      data: {
        ...(usage.cachedInputTokens > 0 ? { cachedInputTokens: usage.cachedInputTokens } : {}),
        ...(usage.cacheWriteTokens > 0 ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
        ...(usage.costUsd > 0 ? { costUsd: usage.costUsd } : {}),
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.reasoningTokens > 0 ? { reasoningTokens: usage.reasoningTokens } : {}),
      },
      type: "run.usage",
    });
  }

  #handleConnectionFailure(error: OpensteerError): void {
    if (this.#publisher.unusable || this.#closed) return;
    this.#publisher.latchUnusable(error);
    this.#handshakeFailure ??= error;
    this.#handshake.resolve();
    const active = this.#activeTurn;
    if (active) {
      try {
        this.#publishFailure(active, error);
      } catch {
        // The active turn is terminal even when its terminal event could not fit.
      }
    }
    this.#closeEventStream(error);
  }

  #publish(event: HarnessEvent): void {
    if (this.#publisher.streamClosed) return;
    try {
      this.#publisher.publish(event);
    } catch (error) {
      const failure = toHarnessError(error, "Pi event buffer failed");
      this.#publisher.latchUnusable(failure);
      const active = this.#activeTurn;
      if (active && this.#publisher.claimTerminal(active)) {
        active.toolLifetime.abort(failure);
        active.completion.resolve();
      }
      void this.#client?.close(0);
      throw failure;
    }
  }

  #closeEventStream(error?: unknown): void {
    this.#publisher.closeStream(error);
  }

  #requireClient(): PiRpcClient {
    const client = this.#client;
    if (!client) {
      throw new OpensteerError({ code: "harness_error", message: "Pi is not connected" });
    }
    if (client.exitedWithoutProtocolOutput) {
      // Pi prints a y/N fork prompt on stderr and exits 0 when it is pointed at
      // a session recorded elsewhere by id. A clean exit with no protocol output
      // is that, and it must never look like success (pi-facts risk 5).
      throw new OpensteerError({
        code: "harness_error",
        message: "Pi exited without speaking the RPC protocol; it could not open this session",
      });
    }
    return client;
  }

  #assertUsable(): void {
    if (this.#closed) {
      throw new OpensteerError({ code: "harness_error", message: "Pi session is closed" });
    }
    if (this.#publisher.unusable) throw this.#publisher.unusable;
  }
}

const piApprovalOptionIds: ReadonlySet<string> = new Set(["allow-once", "reject"]);

function invalidPiRequestResponse(): OpensteerError {
  return new OpensteerError({
    code: "bad_request",
    message: "Response does not match the pending Pi Request",
  });
}

function piApprovalPresentation(
  request: Extract<PiExtensionRequest, { kind: "command" | "file-change" }>,
): Extract<PendingRequest["presentation"], { kind: "choice" }> {
  return {
    detail: piApprovalDetail(request),
    kind: "choice",
    options: [
      { hint: "allow-once", id: "allow-once", label: "Allow once" },
      { hint: "reject-once", id: "reject", label: "Reject" },
    ],
    risk: "medium",
    title: request.kind === "command" ? "Approve command" : "Approve file changes",
  };
}

/** Exactly the arguments the model produced, rendered for a person to read. */
function piApprovalDetail(
  request: Extract<PiExtensionRequest, { kind: "command" | "file-change" }>,
): string {
  const input =
    typeof request.input === "object" && request.input !== null
      ? (request.input as JsonObject)
      : {};
  if (request.kind === "command") {
    return optionalString(input.command) ?? `${request.toolName} (no command)`;
  }
  const path = optionalString(input.path) ?? "an unnamed file";
  if (request.toolName === "write") {
    return `Write ${path}\n\n${boundedText(optionalString(input.content) ?? "")}`;
  }
  const edits = Array.isArray(input.edits) ? input.edits : [];
  const rendered = edits
    .map((value, index) => {
      const edit = requireObject(value, `Pi edit ${index}`);
      return `- ${boundedText(optionalString(edit.oldText) ?? "")}\n+ ${boundedText(optionalString(edit.newText) ?? "")}`;
    })
    .join("\n\n");
  return `Edit ${path}\n\n${rendered}`;
}

function boundedText(value: string): string {
  return value.length > 4_000 ? `${value.slice(0, 4_000)}…` : value;
}

export function parseExtensionRequest(title: string): PiExtensionRequest {
  const parsed: unknown = JSON.parse(title);
  const payload = requireObject(parsed, "Pi extension request");
  if (payload.v !== piExtensionProtocolVersion) {
    throw protocolError("Pi extension spoke another protocol version");
  }
  const kind = requireString(payload.kind, "Pi extension request kind");
  const toolCallId = requireString(payload.toolCallId, "Pi extension request toolCallId");
  if (kind === "tool") {
    return {
      arguments: payload.arguments,
      kind,
      name: requireString(payload.name, "Pi tool request name"),
      server: requireString(payload.server, "Pi tool request server"),
      toolCallId,
      v: piExtensionProtocolVersion,
    };
  }
  if (kind !== "command" && kind !== "file-change") {
    throw protocolError(`Pi extension sent an unknown request kind ${kind}`);
  }
  return {
    input: payload.input,
    kind,
    toolCallId,
    toolName: requireString(payload.toolName, "Pi approval toolName"),
    v: piExtensionProtocolVersion,
  };
}

function piDenialNote(kind: "command" | "file-change", note: string): string {
  const subject = kind === "command" ? "command" : "file change";
  return `The user denied this ${subject}.\n\nUser note:\n${note}`;
}

/**
 * Pi's own non-retryable provider-limit classifier, copied verbatim from
 * `pi-mono/packages/ai/src/utils/retry.ts:7-24` (v0.85.1). It is internal to
 * `@earendil-works/pi-ai` and not re-exported, and Pi surfaces a failure only as
 * free text on an assistant message with `stopReason: "error"` (pi-facts §10),
 * so the classifier has to live here. It is pinned to the tested Pi version and
 * must be re-read on every upgrade.
 */
export const piNonRetryableLimitPattern = new RegExp(
  [
    "GoUsageLimitError",
    "FreeUsageLimitError",
    "Monthly usage limit reached",
    "available balance",
    "insufficient_quota",
    "out of budget",
    "quota exceeded",
    "billing",
  ].join("|"),
  "i",
);

/**
 * The same file's retryable set (`retry.ts:26-90`), reduced to what a Run's
 * failure needs: whether Opensteer should offer to run this again. Pi has
 * already exhausted its own retries by the time an error reaches
 * `stopReason: "error"`.
 */
export const piRetryablePattern = new RegExp(
  [
    "overloaded",
    "rate.?limit",
    "too many requests",
    "429",
    "500",
    "502",
    "503",
    "504",
    "524",
    "service.?unavailable",
    "server.?error",
    "internal.?error",
    "fetch failed",
    "socket hang up",
    "timed? out",
    "timeout",
    "ResourceExhausted",
  ].join("|"),
  "i",
);

const piUsageLimitDetailKey = "piUsageLimit";

function piTurnError(errorMessage: string | undefined): OpensteerError {
  const message = errorMessage?.trim() || "Pi reported a provider error";
  const limitReached = piNonRetryableLimitPattern.test(message);
  return new OpensteerError({
    code: "harness_error",
    details: { [piUsageLimitDetailKey]: limitReached },
    message,
    retryable: !limitReached && piRetryablePattern.test(message),
  });
}

function piFailureCode(error: OpensteerError): string {
  if (error.details?.[piUsageLimitDetailKey] === true) return harnessUsageLimitFailureCode;
  return error.code === "harness_error" ? "pi_harness_error" : error.code;
}

function steerConflict(): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    message: "Pi session has no steerable active turn",
  });
}

function emptyUsage(): MutableUsage {
  return {
    cacheWriteTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    stated: false,
  };
}

function accumulateUsage(usage: MutableUsage, value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const stated = value as JsonObject;
  const input = optionalNumber(stated.input);
  const output = optionalNumber(stated.output);
  if (input === undefined && output === undefined) return;
  usage.stated = true;
  usage.inputTokens += Math.max(0, Math.trunc(input ?? 0));
  usage.outputTokens += Math.max(0, Math.trunc(output ?? 0));
  usage.cachedInputTokens += Math.max(0, Math.trunc(optionalNumber(stated.cacheRead) ?? 0));
  usage.cacheWriteTokens += Math.max(0, Math.trunc(optionalNumber(stated.cacheWrite) ?? 0));
  usage.reasoningTokens += Math.max(0, Math.trunc(optionalNumber(stated.reasoning) ?? 0));
  const cost = stated.cost;
  if (typeof cost === "object" && cost !== null) {
    usage.costUsd += Math.max(0, optionalNumber((cost as JsonObject).total) ?? 0);
  }
}

/**
 * The flags every Pi process for a Run carries.
 *
 * `--no-extensions` disables discovery only, so the one Opensteer extension is
 * still named explicitly; the other four switches turn off every other place Pi
 * would otherwise read instructions, skills or trust from the Workspace
 * (pi-facts §7, risk 2). `--model` and `--thinking` are the spawn-time
 * selection, which `set_model` then verifies exactly.
 */
export function piProcessArguments(options: {
  readonly context: Pick<HarnessSessionContext, "modelSelection">;
  readonly extensionPath: string;
  readonly instructionsPath: string;
  readonly sessionPath?: string;
}): readonly string[] {
  const thinking = piThinkingOption(options.context.modelSelection);
  return [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-approve",
    "--extension",
    options.extensionPath,
    "--append-system-prompt",
    options.instructionsPath,
    "--model",
    piModelSelectionId(options.context.modelSelection),
    ...(thinking ? ["--thinking", thinking] : []),
    ...(options.sessionPath ? ["--session", options.sessionPath] : []),
  ];
}

/** Pi's `thinkingLevel`, from the "Thinking" option the catalog offered. */
function piThinkingOption(selection: ModelSelection): string | undefined {
  const thinking = selection.options.thinking;
  return typeof thinking === "string" && thinking ? thinking : undefined;
}

/** The exact id this account's provider answers to, never the canonical one. */
function piModelSelectionId(selection: ModelSelection): string {
  return selection.nativeModelId ?? selection.modelId;
}

/**
 * The per-Run text Pi renders into the system prompt on every turn, resumed or
 * not: `--append-system-prompt <file>` is re-resolved on each process start and
 * nothing of it is persisted in the session (pi-facts §7). The machine-access
 * notice is not here — it changes from Run to Run and travels through the
 * extension's `before_agent_start` hook instead, which was measured firing on
 * the first turn of a resumed conversation.
 */
export function piInstructions(
  context: HarnessSessionContext,
  tools: readonly PiExtensionToolDefinition[],
  skillCatalog?: string,
): string {
  return [
    context.platformGuide,
    context.instructions,
    durableHistoryWindowNotice(context),
    skillCatalog,
    piToolsNotice(tools),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
}

function piToolsNotice(tools: readonly PiExtensionToolDefinition[]): string {
  if (tools.length === 0) return "Opensteer has no additional tools for this Run.";
  return [
    "Call Opensteer tools by these names:",
    tools.map((tool) => `- ${tool.name}`).join("\n"),
    "They need no approval.",
  ].join("\n");
}

function inputsToPiPrompt(
  inputs: readonly HarnessInput[],
  turn: Pick<HarnessRunInput, "context" | "reports"> | null,
  attachments?: ReadonlyMap<string, ResolvedAttachment>,
): string {
  if (inputs.length === 0) {
    throw new OpensteerError({ code: "bad_request", message: "Pi turn inputs cannot be empty" });
  }
  const reportPrompt = harnessTurnPreamble(turn, (input) => piInputBody(input, attachments, false));
  return [
    ...(reportPrompt ? [reportPrompt] : []),
    ...inputs.map((input) => projectPiInput(input, attachments)),
  ].join("\n\n");
}

function projectPiInput(
  input: HarnessInput,
  attachments?: ReadonlyMap<string, ResolvedAttachment>,
): string {
  return harnessInputHeader(input, piInputBody(input, attachments, true));
}

function piInputBody(
  input: HarnessInput,
  attachments?: ReadonlyMap<string, ResolvedAttachment>,
  allowImages = false,
): string {
  const projected = resolvedInputParts(input, attachments);
  if (!allowImages && projected.images.length > 0)
    throw new OpensteerError({
      code: "bad_request",
      message: "Pi report context cannot contain image input",
    });
  return projected.body;
}

/**
 * Pi fits a prompt's images to the selected model's limits (2000×2000 and
 * 4.5 MiB of base64 for every bundled model) but queues a steering message's
 * images as they are, so every image is fitted here to the same limits.
 */
const piNativeImageLimits = {
  maxEdge: 2_000,
  mediaTypes: attachmentNativeImageMediaTypes,
} as const;
const piImageMaxBase64 = 4.5 * 1_024 * 1_024;
/** Pi echoes a message back with its role, timestamp and content wrappers. */
const piEchoAllowance = 1_024;

/**
 * The images of one `prompt` or `steer` command, in order. The command is one
 * protocol line, and Pi echoes the message back as one, so the images share
 * what the line and write-buffer bounds leave after everything else it holds.
 */
async function piImages(
  command: "prompt" | "steer",
  inputs: readonly HarnessInput[],
  message: string,
  config: Pick<PiHarnessConfig, "maxProtocolLineBytes" | "maxWriteBufferBytes">,
  attachments?: ReadonlyMap<string, ResolvedAttachment>,
): Promise<
  readonly { readonly type: "image"; readonly data: string; readonly mimeType: string }[]
> {
  const images = inputs.flatMap((input) => resolvedInputParts(input, attachments).images);
  if (images.length === 0) return [];
  // Exactly what `PiProcess.command` writes, with every image still empty.
  const envelope = Buffer.byteLength(
    `${JSON.stringify({
      message,
      images: images.map(() => ({ type: "image", data: "", mimeType: "image/jpeg" })),
      id: `os-${Number.MAX_SAFE_INTEGER}`,
      type: command,
    })}\n`,
  );
  const maxBytes = nativeImageBase64Budget({
    count: images.length,
    perImage: piImageMaxBase64,
    total:
      Math.min(config.maxProtocolLineBytes, config.maxWriteBufferBytes) -
      envelope -
      piEchoAllowance,
  });
  const prepared = [];
  for (const image of images) {
    const fitted = await prepareNativeImage(image, { ...piNativeImageLimits, maxBytes });
    prepared.push({
      type: "image" as const,
      data: fitted.bytes.toString("base64"),
      mimeType: fitted.mediaType,
    });
  }
  return prepared;
}

function piLaunch(dependencies: PiHarnessDependencies): PiLaunch {
  return { executable: dependencies.executable, nodeExecutable: dependencies.nodeExecutable };
}

/**
 * Pi's own network reach, off. `PI_OFFLINE` freezes the model catalog to the
 * bundled snapshot and stops the pi.dev overlay, `PI_TELEMETRY=0` stops install
 * reporting and provider attribution headers, and `PI_SKIP_VERSION_CHECK` stops
 * the latest-version request (pi-facts §1).
 */
async function piProcessEnvironment(
  environment: Readonly<Record<string, string>>,
  providerState: HarnessProviderState,
): Promise<Readonly<Record<string, string>>> {
  const base = {
    ...environment,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  if (providerState.kind !== "isolated") return base;
  return { ...base, PI_CODING_AGENT_DIR: await materializePiProviderHome(providerState) };
}

function isolatedPiProviderHome(providerState: HarnessProviderState): string {
  const home = providerState.providerHomeDirectory;
  if (!home) throw new Error("Isolated Pi profile has no provider home");
  return resolve(home);
}

async function materializePiProviderHome(providerState: HarnessProviderState): Promise<string> {
  const home = isolatedPiProviderHome(providerState);
  await mkdir(home, { mode: 0o700, recursive: true });
  return home;
}

interface PiCredential extends JsonObject {
  readonly type: string;
}

/**
 * Pi's credential store, which the driver owns for an isolated profile: a flat
 * `Record<providerId, Credential>` at `$PI_CODING_AGENT_DIR/auth.json`, mode
 * 0600 (pi-facts §4). A stored credential owns its provider and suppresses
 * every environment fallback, which is exactly why nothing here ever travels in
 * a process environment: Pi hands its whole environment to the commands the
 * model runs (pi-facts §11).
 */
function piAuthStore(providerState: HarnessProviderState) {
  return providerSecretFile(providerState, piAuthFileName, {
    description: "Pi credential store",
    maximumBytes: piAuthFileMaxBytes,
  });
}

const PiAuthFileSchema = z.record(z.string(), z.looseObject({ type: z.string() }));

async function readPiAuthFile(
  providerState: HarnessProviderState,
): Promise<Record<string, PiCredential>> {
  const stored = await piAuthStore(providerState).read();
  if (stored === undefined) return {};
  const result = PiAuthFileSchema.safeParse(safeJson(stored));
  if (!result.success) {
    throw new OpensteerError({
      code: "harness_error",
      message: "The stored Pi credential store could not be read",
    });
  }
  return result.data as Record<string, PiCredential>;
}

async function readPiCredential(
  providerState: HarnessProviderState,
  authKey: string,
): Promise<PiCredential | undefined> {
  return (await readPiAuthFile(providerState))[authKey];
}

async function writePiCredential(
  providerState: HarnessProviderState,
  authKey: string,
  credential: PiCredential,
): Promise<void> {
  const file = await readPiAuthFile(providerState);
  await piAuthStore(providerState).write(JSON.stringify({ ...file, [authKey]: credential }));
}

async function removePiCredential(
  providerState: HarnessProviderState,
  authKey: string,
): Promise<void> {
  const file = await readPiAuthFile(providerState);
  if (!(authKey in file)) return;
  const remaining = Object.fromEntries(
    Object.entries(file).filter(([candidate]) => candidate !== authKey),
  );
  if (Object.keys(remaining).length === 0) {
    await piAuthStore(providerState).remove();
    return;
  }
  await piAuthStore(providerState).write(JSON.stringify(remaining));
}

/**
 * Pi loads a custom provider's models but leaves them unavailable unless
 * `models.json` names an `apiKey`. A key stored in `auth.json` under the same
 * provider id supersedes this value (measured), and a keyless server ignores
 * the bearer, so the real key never reaches this file. Pi 0.87.1 runs a value
 * starting with `!` as a shell command and interpolates `$NAME`; this one has
 * neither, so it is sent as the literal it is.
 */
const piKeylessEndpointApiKey = "opensteer-keyless-endpoint";

/** Every runnable endpoint model is written together, so concurrent Pi startups see the same catalog. */
async function writePiModelsFile(
  providerState: HarnessProviderState,
  models: readonly HarnessModelDescriptor[],
  config: PiHarnessConfig,
): Promise<void> {
  const home = await materializePiProviderHome(providerState);
  const path = join(home, piModelsFileName);
  if (!config.baseUrl)
    throw new OpensteerError({ code: "bad_request", message: "Configure the endpoint base URL" });
  const nativeModels = models.map((model) => {
    const contextWindow = model.contextWindow;
    if (!contextWindow)
      throw new OpensteerError({
        code: "harness_error",
        message: `Set the context window for ${model.displayName}`,
      });
    const maxTokens =
      model.maxOutputTokens ?? Math.min(8_192, Math.max(1, Math.floor(contextWindow / 4)));
    if (maxTokens + 256 >= contextWindow) {
      throw new OpensteerError({
        code: "harness_error",
        message: `${model.displayName} needs a context window larger than its output budget plus 256 tokens`,
      });
    }
    return {
      id: model.nativeModelId ?? model.modelId,
      name: model.displayName,
      contextWindow,
      maxTokens,
      input: model.acceptsImages ? ["text", "image"] : ["text"],
      ...(config.runtime === "generic"
        ? {}
        : {
            compat: {
              supportsStore: false,
              supportsDeveloperRole: false,
              supportsReasoningEffort: false,
              supportsUsageInStreaming: false,
              maxTokensField: "max_tokens",
            },
          }),
    };
  });
  const document = {
    providers: {
      [piCompatibleProviderId]: {
        api: "openai-completions",
        apiKey: piKeylessEndpointApiKey,
        baseUrl: config.baseUrl,
        models: nativeModels,
        name: compatibleEndpointHost(config.baseUrl),
      },
    },
  };
  await replacePrivateFileAtomically(path, `${JSON.stringify(document, undefined, 2)}\n`);
  if (nativeModels.length) {
    const settingsPath = join(home, "settings.json");
    const invalidSettings = () =>
      new OpensteerError({
        code: "harness_error",
        message: "The stored Pi settings file could not be read",
      });
    const storedSettings = await readBoundedRegularFile(settingsPath, 256 * 1_024, {
      changedError: invalidSettings,
      invalidFileError: invalidSettings,
      missing: "null",
      sizeError: invalidSettings,
    });
    const parsedSettings = storedSettings ? safeJson(storedSettings.toString("utf8")) : {};
    if (!isRecord(parsedSettings)) throw invalidSettings();
    const compaction = isRecord(parsedSettings.compaction) ? parsedSettings.compaction : {};
    const modelOverrides = isRecord(compaction.modelOverrides) ? compaction.modelOverrides : {};
    const nextOverrides: Record<string, unknown> = { ...modelOverrides };
    for (const model of nativeModels) {
      const overhead = Math.min(2_048, Math.max(256, Math.floor(model.contextWindow / 20)));
      const reserveTokens = Math.min(model.contextWindow - 256, model.maxTokens + overhead);
      const keepRecentTokens = Math.min(
        20_000,
        Math.max(1, Math.floor((model.contextWindow - reserveTokens) / 2)),
      );
      const modelKey = `${piCompatibleProviderId}/${model.id}`;
      nextOverrides[modelKey] = {
        ...(isRecord(modelOverrides[modelKey]) ? modelOverrides[modelKey] : {}),
        reserveTokens,
        keepRecentTokens,
      };
    }
    await replacePrivateFileAtomically(
      settingsPath,
      `${JSON.stringify(
        {
          ...parsedSettings,
          compaction: {
            ...compaction,
            modelOverrides: nextOverrides,
          },
        },
        undefined,
        2,
      )}\n`,
    );
  }
}

interface PiSessionHeader {
  readonly cwd: string;
  readonly id: string;
}

const PiSessionHeaderSchema = z.looseObject({
  cwd: z.string().min(1),
  id: z.string().min(1),
  type: z.literal("session"),
  version: z.number(),
});

/**
 * The first line of a Pi session file: `{"type":"session","version":3,"id":…,
 * "cwd":…}` (pi-facts §3). Reading it is how a resume is checked before a
 * process is started.
 */
async function readPiSessionHeader(path: string): Promise<PiSessionHeader | undefined> {
  let handle: Awaited<ReturnType<typeof openFile>>;
  try {
    handle = await openFile(path, "r");
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") return undefined;
    throw toPiProcessError(error, "The Pi session file could not be read");
  }
  try {
    const buffer = Buffer.alloc(64 * 1_024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    const parsed = PiSessionHeaderSchema.safeParse(
      safeJson(newline < 0 ? text : text.slice(0, newline)),
    );
    return parsed.success ? { cwd: parsed.data.cwd, id: parsed.data.id } : undefined;
  } finally {
    await handle.close();
  }
}

function validateProviderReference(reference: string): string {
  const value = reference.trim();
  if (!value || value.length > 2_048 || /[\r\n]/.test(value) || !value.endsWith(".jsonl")) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Invalid Pi provider session reference",
    });
  }
  return value;
}

async function readPiVersion(
  dependencies: PiHarnessDependencies,
  environment: Readonly<Record<string, string>>,
  workingDirectory: string,
  signal: AbortSignal,
): Promise<Extract<HarnessInspectionResult, { status: "unavailable" }> | undefined> {
  let result: Awaited<ReturnType<typeof runPiCommand>>;
  try {
    result = await runPiCommand({
      args: ["--version"],
      cwd: workingDirectory,
      environment,
      launch: piLaunch(dependencies),
      maxOutputBytes: 4 * 1_024,
      signal,
      timeoutMs: piVersionTimeoutMs,
    });
  } catch (error) {
    const failure = toPiProcessError(error, "Pi could not be started");
    if (failure.code === "not_found" || failure.code === "timeout") {
      return {
        detail: `Pi is not usable on this Runner: ${failure.message}`,
        status: "unavailable",
      };
    }
    throw failure;
  }
  // Pi prints exactly `0.85.1\n` — no "v", no banner (pi-facts §1).
  const version = result.stdout.trim();
  if (result.code !== 0 || version !== TESTED_PI_VERSION) {
    return {
      detail: `Unsupported Pi version ${version || "unknown"}; this adapter is pinned to ${TESTED_PI_VERSION}`,
      status: "unavailable",
    };
  }
  return undefined;
}

const PiAuthCheckSchema = z.looseObject({ status: z.string() });

/**
 * `pi auth check --provider <p> --json` is the one thing Pi offers that answers
 * "is this provider signed in" without starting a session: `{"status":"ready"}`
 * and exit 0, or `{"status":"not_ready","reason":…}` and exit 1 (pi-facts §4).
 * It reads the same `auth.json` Opensteer writes and the same ambient
 * credentials a person's own Pi home holds, which is what lets one code path
 * serve both state kinds.
 */
async function readPiAuthStatus(
  dependencies: PiHarnessDependencies,
  environment: Readonly<Record<string, string>>,
  workingDirectory: string,
  provider: string,
  signal: AbortSignal,
): Promise<boolean> {
  const result = await runPiCommand({
    args: ["auth", "check", "--provider", provider, "--json"],
    cwd: workingDirectory,
    environment,
    launch: piLaunch(dependencies),
    maxOutputBytes: 64 * 1_024,
    signal,
    timeoutMs: piAuthCheckTimeoutMs,
  });
  const parsed = PiAuthCheckSchema.safeParse(safeJson(result.stdout));
  if (!parsed.success) throw protocolError("Pi did not report a readable authentication status");
  return parsed.data.status === "ready";
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value.trim());
  } catch {
    return undefined;
  }
}

/** `input` is the registry's input modality list, `("text" | "image")[]` in pi-ai's own types. */
const PiModelSchema = z.looseObject({
  id: z.string().trim().min(1).max(255),
  input: z.array(z.string().max(64)).max(32).optional(),
  name: z.string().max(255).optional(),
  provider: z.string().trim().min(1).max(255),
  reasoning: z.boolean().optional(),
  thinkingLevelMap: z.record(z.string(), z.string().nullable()).optional(),
});

const PiAvailableModelsSchema = z.looseObject({
  command: z.literal("get_available_models"),
  data: z.looseObject({ models: z.array(PiModelSchema) }),
});

/**
 * The catalog, read from one short-lived RPC process in the profile's own home.
 * Pi filters `get_available_models` to providers whose credential resolves, so
 * a source with no models is a source this account cannot run rather than an
 * empty catalog (pi-facts §5). The ids are never hardcoded: this build's
 * bundled snapshot is forward-dated and the overlay can change it.
 */
async function readPiCatalog(
  dependencies: PiHarnessDependencies,
  environment: Readonly<Record<string, string>>,
  workingDirectory: string,
  row: PiSourceRow,
  signal: AbortSignal,
): Promise<readonly HarnessModelDescriptor[]> {
  const result = await runPiCommand({
    args: ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-context-files"],
    cwd: workingDirectory,
    environment,
    launch: piLaunch(dependencies),
    maxOutputBytes: 32 * 1_024 * 1_024,
    signal,
    stdin: `${JSON.stringify({ id: "catalog", type: "get_available_models" })}\n`,
    timeoutMs: piCatalogTimeoutMs,
  });
  const response = piProtocolLines(result.stdout)
    .flatMap((line) => {
      const parsed = PiAvailableModelsSchema.safeParse(safeJson(line));
      return parsed.success ? [parsed.data] : [];
    })
    .at(0);
  if (!response) throw protocolError("Pi did not return an available-model list");
  const models = response.data.models.filter((model) => model.provider === row.provider);
  return assertPiCatalogSize(piModelDescriptors(models, row));
}

function assertPiCatalogSize(
  descriptors: readonly HarnessModelDescriptor[],
): readonly HarnessModelDescriptor[] {
  if (descriptors.length <= maxHarnessModelsPerCatalog) return descriptors;
  throw protocolError(
    `Pi reported ${descriptors.length} models, exceeding Opensteer's complete-catalog limit of ${maxHarnessModelsPerCatalog}`,
  );
}

/** The same strict LF framing the session uses, for a one-shot process's output. */
function piProtocolLines(stdout: string): readonly string[] {
  const framer = new PiLineFramer(32 * 1_024 * 1_024);
  const lines = framer.push(Buffer.from(stdout, "utf8")).map((line) => line.toString("utf8"));
  const trailing = framer.finish();
  return trailing ? [...lines, trailing.toString("utf8")] : lines;
}

function piModelDescriptors(
  models: readonly z.infer<typeof PiModelSchema>[],
  row: PiSourceRow,
): readonly HarnessModelDescriptor[] {
  const seen = new Set<string>();
  const descriptors = models.flatMap((model) => {
    const reference = canonicalModelReference(model.id, row.sourceId);
    const modelId = ModelIdSchema.safeParse(reference.modelId);
    const providerId = ModelProviderIdSchema.safeParse(reference.providerId);
    // One unusable id is Pi's problem, never the catalog's: the rest of the
    // list is still exactly what this account can run.
    if (!modelId.success || !providerId.success) return [];
    const key = JSON.stringify([providerId.data, modelId.data]);
    if (seen.has(key)) return [];
    seen.add(key);
    const levels = piThinkingLevels(model);
    return [
      {
        // Pi's model registry states each model's input modalities; a build
        // whose registry says nothing leaves this absent rather than guessing.
        ...(model.input === undefined ? {} : { acceptsImages: model.input.includes("image") }),
        displayName: model.name?.trim() || modelDisplayName(reference.modelId),
        isDefault: false,
        modelId: modelId.data,
        // Always kept, even when it equals the canonical id: it is the only
        // string `set_model` answers to (pi-facts §5).
        nativeModelId: model.id.trim(),
        options:
          levels.length > 0
            ? [
                {
                  id: "thinking",
                  label: "Thinking",
                  type: "select" as const,
                  values: levels.map((level) => ({
                    label: reasoningEffortLabel(level),
                    value: level,
                  })),
                },
              ]
            : [],
        providerId: providerId.data,
      },
    ];
  });
  // Pi states no per-provider default in `get_available_models`, so the first
  // row is the default — decided after the unusable ids are dropped, because a
  // dropped first entry would otherwise leave the catalog with no default.
  const [first, ...rest] = descriptors;
  return first ? [{ ...first, isDefault: true }, ...rest] : [];
}

/**
 * Pi's seven thinking levels, narrowed to what the model declares.
 * `thinkingLevelMap` is tristate: an omitted key means the standard levels are
 * supported through `high` while `xhigh`/`max` are not, an explicit string means
 * supported, and `null` means unsupported (pi-facts §5).
 */
const piThinkingLevelOrder = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const piStandardThinkingLevels: readonly string[] = ["off", "minimal", "low", "medium", "high"];

export function piThinkingLevels(model: {
  readonly reasoning?: boolean | undefined;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>> | undefined;
}): readonly string[] {
  if (model.reasoning !== true) return [];
  const map = model.thinkingLevelMap;
  return piThinkingLevelOrder.filter((level) => {
    if (!map || !(level in map)) return piStandardThinkingLevels.includes(level);
    return map[level] !== null;
  });
}

/**
 * A compatible endpoint's catalog comes from the endpoint itself: Pi only knows
 * the models `models.json` names, which is the list Opensteer would be writing,
 * so asking Pi would be asking Opensteer. An endpoint that cannot be read is
 * unavailable rather than empty, exactly as the Codex compatible source reports
 * it.
 */
/** Where a model server's own settings are read, and how its API is reached. */
function piModelServerProbeOptions(
  dependencies: Pick<PiHarnessDependencies, "fetchModels" | "modelServerHome">,
  signal: AbortSignal,
): ModelServerProbeOptions {
  return {
    ...(dependencies.fetchModels ? { fetch: dependencies.fetchModels } : {}),
    ...(dependencies.modelServerHome ? { home: dependencies.modelServerHome } : {}),
    signal,
  };
}

async function inspectPiCompatibleEndpoint(
  config: PiHarnessConfig,
  context: HarnessInspectionContext,
  row: PiSourceRow,
  dependencies: Pick<PiHarnessDependencies, "fetchModels" | "modelServerHome">,
): Promise<HarnessInspectionResult> {
  if (context.providerState.kind !== "isolated") {
    return { detail: compatibleAmbientDetail, status: "unavailable" };
  }
  const baseUrl = config.baseUrl;
  if (baseUrl === undefined) {
    return {
      detail: "This account has no base URL for its OpenAI-compatible endpoint",
      status: "unavailable",
    };
  }
  const host = compatibleEndpointHost(baseUrl);
  await materializePiProviderHome(context.providerState);
  const apiKey = optionalString((await readPiCredential(context.providerState, row.authKey))?.key);
  let models: readonly HarnessModelDescriptor[];
  try {
    models = await discoverCompatibleEndpointModels(
      config,
      apiKey === undefined ? { kind: "none" } : { kind: "api-key", apiKey },
      {
        ...(dependencies.fetchModels ? { fetchModels: dependencies.fetchModels } : {}),
        signal: context.signal,
        timeoutMs: piCompatibleModelsTimeoutMs,
      },
    );
  } catch (error) {
    if (
      error instanceof CompatibleEndpointHttpError &&
      (error.status === 401 || error.status === 403)
    ) {
      const settingsKey = await modelServerSettingsKey(
        config,
        piModelServerProbeOptions(dependencies, context.signal),
      );
      return {
        connections: [
          {
            authKind: "api-key",
            connectionSlot: primaryConnectionSlot,
            label: host,
            status: "authentication-required",
          },
        ],
        detail: apiKey === undefined ? `${host} needs an API key` : `${host} rejected the API key`,
        setupMethods: [
          ...(settingsKey === undefined ? [] : [modelServerSettingsMethod(config.runtime)]),
          ...piSetupMethods(row),
        ],
        status: "authentication-required",
      };
    }
    return {
      detail: compatibleEndpointFailureDetail(host, error),
      setupMethods: piSetupMethods(row),
      status: "unavailable",
    };
  }
  if (models.length > maxHarnessModelsPerCatalog) {
    return compatibleEndpointUnavailable(
      host,
      `it reported ${models.length} models, exceeding Opensteer's complete-catalog limit of ${maxHarnessModelsPerCatalog}`,
      row,
    );
  }
  if (models.length === 0) return compatibleEndpointUnavailable(host, "it reported no models", row);
  return {
    connections: [
      {
        authKind: apiKey === undefined ? "none" : "api-key",
        connectionSlot: primaryConnectionSlot,
        label: host,
        logoutSupported: apiKey !== undefined,
        status: "connected",
      },
    ],
    detail: `${host} is reachable and ready`,
    models,
    setupMethods: piSetupMethods(row),
    status: "ready",
  };
}

const compatibleAmbientDetail =
  "An OpenAI-compatible endpoint needs a private Pi profile: the computer's own Pi home is the person's own and must not gain an Opensteer provider.";

function compatibleEndpointUnavailable(
  host: string,
  failure: string,
  row: PiSourceRow,
): HarnessInspectionResult {
  return {
    detail: `${host} did not return a model list: ${failure}`,
    setupMethods: piSetupMethods(row),
    status: "unavailable",
  };
}

/**
 * The device-code sign-in: a generated program the Runner starts with its own
 * Node and never links (see `login.ts` for why), speaking one JSON line per
 * step on stdout.
 */
async function startPiDeviceCodeLogin(
  row: PiSourceRow,
  context: HarnessAuthenticationContext,
  dependencies: PiHarnessDependencies,
): Promise<HarnessAuthenticationStart> {
  const home = await materializePiProviderHome(context.providerState);
  const scriptPath = join(home, piLoginScriptFileName);
  await replacePrivateFileAtomically(scriptPath, piLoginScriptSource());
  const entryUrl = await piPackageEntryUrl(dependencies.executable);
  const lifetime = new AbortController();
  const challenge = new Deferred<
    { readonly userCode: string; readonly verificationUrl: string } | undefined
  >();
  let settled = false;
  let resolveResult!: (result: HarnessAuthenticationResult) => void;
  const result = new Promise<HarnessAuthenticationResult>((resolvePromise) => {
    resolveResult = resolvePromise;
  });
  const finish = (outcome: HarnessAuthenticationResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    context.signal.removeEventListener("abort", abort);
    challenge.resolve(undefined);
    lifetime.abort(new Error("Pi sign-in finished"));
    resolveResult(outcome);
  };
  const abort = () => finish({ detail: `${row.label} sign-in was canceled`, status: "failed" });
  const timer = setTimeout(
    () => finish({ detail: `${row.label} sign-in timed out`, status: "failed" }),
    piDeviceCodeTimeoutMs,
  );
  timer.unref?.();

  const login = (dependencies.spawnLoginProcess ?? spawnSupervised)({
    args: [scriptPath, entryUrl, row.provider],
    cwd: home,
    environment: await piProcessEnvironment(context.environment, context.providerState),
    executable: dependencies.nodeExecutable,
    maxOutputBytes: piLoginLineMaxBytes,
    signal: lifetime.signal,
  });
  login.child.stdin?.end();
  let failure: string | undefined;
  let ready = false;
  /**
   * The child's output is the whole evidence that a sign-in happened, so it is
   * read fail-closed: a line this driver cannot parse means the program on the
   * other end is not the one this driver generated, and an exit code alone
   * never means success — only the `ready` frame does.
   */
  const accept = (line: Buffer): void => {
    const parsed = PiLoginMessageSchema.safeParse(safeJson(line.toString("utf8")));
    if (!parsed.success) {
      failure ??= `${row.label} sign-in sent something Opensteer could not read`;
      void login.terminate(0).catch(() => undefined);
      return;
    }
    if (parsed.data.type === "device_code") {
      challenge.resolve({
        userCode: parsed.data.userCode,
        verificationUrl: parsed.data.verificationUrl,
      });
      return;
    }
    if (parsed.data.type === "ready") {
      ready = true;
      return;
    }
    failure ??= parsed.data.detail;
  };
  const reader = (async () => {
    const framer = new PiLineFramer(piLoginLineMaxBytes);
    for await (const chunk of login.stdout) for (const line of framer.push(chunk)) accept(line);
    // A child that exits without a trailing newline still said something.
    const trailing = framer.finish();
    if (trailing) accept(trailing);
  })().catch((error: unknown) => {
    // An oversized or unreadable line is the same evidence as a malformed
    // frame — the program on the other end is not the one this driver wrote —
    // and it must never be discarded, even after a `ready` frame arrived.
    failure ??= error instanceof Error ? error.message : `${row.label} sign-in could not be read`;
    void login.terminate(0).catch(() => undefined);
  });
  void Promise.allSettled([reader, login.exited]).then(async () => {
    const exit = await login.exited.catch(() => ({ code: 1, signal: null }));
    finish(
      exit.code === 0 && ready && failure === undefined
        ? { status: "ready" }
        : {
            detail: (failure ?? `${row.label} sign-in did not complete`).slice(0, 500),
            status: "failed",
          },
    );
  });
  if (context.signal.aborted) abort();
  else context.signal.addEventListener("abort", abort, { once: true });

  const issued = await challenge.promise;
  if (!issued) {
    // The flow ended before a code was ever shown, so there is nothing for the
    // person to do and the outcome is already known.
    const outcome = await result;
    if (outcome.status === "ready") return { status: "ready" };
    throw new OpensteerError({ code: "harness_error", message: outcome.detail });
  }
  return {
    cancel: async () => {
      finish({ detail: `${row.label} sign-in was canceled`, status: "failed" });
      await login.terminate(0).catch(() => undefined);
    },
    challenge: {
      kind: "device-code",
      userCode: issued.userCode,
      verificationUrl: issued.verificationUrl,
    },
    result,
    status: "pending",
  };
}
