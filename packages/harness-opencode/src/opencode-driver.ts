import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { isRecord } from "@opensteer/shared/isRecord";
import { toolsForCapabilityProfile } from "@opensteer/agent-tools";
import { pathToFileURL } from "node:url";
import {
  attachmentMaxBytes,
  attachmentImageMaxPixels,
  attachmentNativeImageMediaTypes,
  HarnessIdSchema,
  ModelIdSchema,
  ModelProviderIdSchema,
  OpensteerError,
  RequestFormAnswersSchema,
  RunUsageSchema,
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
  type RunUsage,
  type ThreadAccessMode,
  type UserId,
  type ExecutionNodeId,
} from "@opensteer/core";
import { integrationGatewayToolNames } from "@opensteer/integration-core";
import { maxHarnessModelsPerCatalog } from "@opensteer/protocol";
import {
  Deferred,
  runTitleProcess,
  withTitleDirectory,
  type HarnessTitleInput,
  HarnessSessionRegistry,
  TurnPublisher,
  assertFreshProviderSessionContext,
  initialContinuationContextPrompt,
  boundedDenialNote,
  CompatibleEndpointHttpError,
  compatibleEndpointFailureDetail,
  discoverCompatibleEndpointModels,
  durableHistoryWindowNotice,
  compatibleEndpointHost,
  importModelServerSettingsKey,
  modelServerSettingsKey,
  modelServerSettingsMethod,
  modelServerSettingsMethodId,
  harnessTurnPreamble,
  resolvedInputParts,
  nativeImageBase64Budget,
  nativeImageNeedsPreparation,
  prepareNativeImage,
  resolvedInputSequence,
  providerSecretFile,
  reasoningEffortLabel,
  runEndedEvent,
  runFailedEvent,
  runStartedEvent,
  secretInputAuthentication,
  toHarnessError,
  type HarnessAdapter,
  type HarnessAuthenticationContext,
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
  type HarnessProviderState,
  type HarnessProviderStoreScope,
  type HarnessRunInput,
  type HarnessSession,
  type HarnessSessionContext,
  type ResolvedAttachment,
  type HarnessSkill,
  SubagentNodes,
} from "@opensteer/harness";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { mkdir, rm, symlink, writeFile, readFile, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { OpencodeHarnessConfigSchema, type OpencodeHarnessConfig } from "./config.js";
import {
  opencodeAgentToolsServer,
  opencodeInspectionConfiguration,
  opencodeIntegrationToolsServer,
  opencodeSessionConfiguration,
  opencodeToolIdentity,
} from "./configuration.js";
import {
  OpencodeAskSettledSchema,
  OpencodeMessageUpdatedSchema,
  OpencodePartDeltaSchema,
  OpencodePartUpdatedSchema,
  OpencodePermissionRequestSchema,
  OpencodeProviderSchema,
  OpencodeProvidersSchema,
  OpencodeQuestionRequestSchema,
  OpencodeSavedPermissionsSchema,
  OpencodeSessionErrorSchema,
  OpencodeSessionEventSchema,
  OpencodeSessionIdleSchema,
  OpencodeSessionSchema,
  opencodeProtocolError,
  parseOpencode,
  type OpencodeErrorPayload,
  type OpencodeMessageInfo,
  type OpencodePart,
} from "./protocol.js";
import { opencodeDisableEnvironment, OpencodeServer } from "./server.js";
import {
  opencodeApiKeySetupMethodId,
  opencodeCompatibleSourceId,
  opencodeCompatibleProviderId,
  opencodeProviderId,
  opencodeSetupMethods,
  opencodeSource,
  opencodeSources,
  opencodeZenSourceId,
} from "./sources.js";

/**
 * OpenCode has no command sandbox of its own: its `bash` tool runs commands
 * straight through the user's shell, inheriting the server's whole environment
 * — both verified live (opencode-facts §11, and a Run asked to print its own
 * environment). Nothing the Runner puts in the harness process tree is
 * therefore private from the model, and the Runner's outer sandbox binds the
 * account's provider home and the Thread's state directory into that tree, so
 * on an isolated-service Runner one tenant's Run could read another account's
 * `auth.json` and this Run's tool tokens. The engine is offered only where the
 * Runner belongs to the one person whose credentials those are.
 */
const opencodeNativeUserOnlyDetail =
  "OpenCode has no command sandbox of its own, so it runs only on a computer you own.";

const opencodeIsolatedProfileDetail =
  "An OpenCode account keeps its own private credential store, so it needs a private profile.";

/** Every OpenCode adapter runs with the same provider capabilities. */
const opencodeHarnessCapabilities: HarnessCapabilities = Object.freeze({
  approvals: true,
  attachments: true,
  messageAttachments: {
    nativeImages: {
      maxBytes: attachmentMaxBytes,
      maxPixels: attachmentImageMaxPixels,
      mediaTypes: attachmentNativeImageMediaTypes,
      steering: false,
    },
  },
  interruption: true,
  // OpenCode hands an MCP tool result's content straight to the AI SDK, so an
  // image content block reaches the model as an image.
  mcpImageContent: true,
  resume: true,
  // OpenCode's v1 engine has no steer route: the whole v1 surface is
  // `POST /session/{id}/message` and `POST /session/{id}/prompt_async`, neither
  // of which admits input into a running turn (confirmed against the server's
  // own `GET /doc`). Queuing a second prompt would be a different promise.
  steering: false,
  toolCalls: true,
  userInput: true,
  // One server serves a session's Runs; its tokens are the Runner proxy's,
  // which the Runner points at each Run.
  warmReuse: true,
});

const opencodeCompatibleModelsTimeoutMs = 5_000;
const opencodeAuthFileMaxBytes = 256 * 1_024;
const opencodeDenialNoteMaxBytes = 20_000;

const OpencodeAuthDocumentSchema = z.record(
  z.string().min(1).max(255),
  z.looseObject({ key: z.string().max(8_192).optional(), type: z.string().max(64) }),
);

export interface OpencodeHarnessDependencies {
  /** The `opencode` binary this distribution staged. */
  readonly executable: string;
  /** Arguments that precede `serve`; the tests point the driver at a fake server. */
  readonly arguments?: readonly string[];
  /** How a compatible endpoint's model list is fetched; injected by tests. */
  readonly fetchModels?: typeof fetch;
  /** Where model server apps keep their own settings; the Runner's home by default. */
  readonly modelServerHome?: string;
}

export class OpencodeHarnessDriver implements HarnessDriver {
  readonly kind = HarnessIdSchema.parse("opencode");
  readonly sources = opencodeSources;
  /**
   * Three modes, each an explicit `permission` table. `auto` is not declared:
   * it needs a routine/non-routine judgement, and OpenCode's rules are per tool
   * and per glob with nothing in between.
   */
  readonly accessModes = [
    "approval-required",
    "auto-accept-edits",
    "full-access",
  ] as const satisfies readonly ThreadAccessMode[];
  readonly capabilities = opencodeHarnessCapabilities;
  readonly configSchema = OpencodeHarnessConfigSchema;
  /**
   * OpenCode keeps every conversation in one sqlite database inside the XDG
   * data home, and that home holds the account's `auth.json` too, so a store is
   * exactly one profile and two profiles are mutually unresumable.
   */
  readonly providerStoreScope: HarnessProviderStoreScope = { kind: "profile" };
  readonly #dependencies: OpencodeHarnessDependencies;

  constructor(dependencies: OpencodeHarnessDependencies) {
    this.#dependencies = dependencies;
  }

  // No `modelCommandLaunch`: OpenCode has no command sandbox to replay, so the
  // machine-access allowance on its catalog entry is a measured fact rather
  // than a probed one.

  async authenticate(
    context: HarnessAuthenticationContext,
    selection: HarnessAuthenticationSelection = { methodId: opencodeApiKeySetupMethodId },
  ): Promise<HarnessAuthenticationStart> {
    const config = OpencodeHarnessConfigSchema.parse(context.config);
    if (selection.connectionSlot && selection.connectionSlot !== "primary") {
      throw new OpensteerError({ code: "bad_request", message: "Unknown OpenCode connection" });
    }
    const importing =
      context.sourceId === opencodeCompatibleSourceId &&
      selection.methodId === modelServerSettingsMethodId;
    if (selection.methodId !== opencodeApiKeySetupMethodId && !importing) {
      throw new OpensteerError({ code: "bad_request", message: "Unknown OpenCode setup method" });
    }
    if (!opencodeSource(context.sourceId)) {
      throw new OpensteerError({ code: "bad_request", message: "Unknown OpenCode source" });
    }
    if (context.providerState.kind !== "isolated") {
      throw new OpensteerError({ code: "bad_request", message: opencodeIsolatedProfileDetail });
    }
    const providerId = opencodeProviderId(context.sourceId);
    if (importing) {
      await importModelServerSettingsKey(
        config,
        (key) => writeOpencodeAuthEntry(context.providerState, providerId, key),
        {
          ...(this.#dependencies.fetchModels ? { fetch: this.#dependencies.fetchModels } : {}),
          ...(this.#dependencies.modelServerHome
            ? { home: this.#dependencies.modelServerHome }
            : {}),
          signal: context.signal,
        },
      );
      return { status: "ready" };
    }
    return secretInputAuthentication({
      cancelledDetail: "The API key was not entered",
      engineLabel: "OpenCode",
      inputLabel: `${opencodeSource(context.sourceId)?.label ?? "Provider"} API key`,
      requiredMessage: "API key is required",
      // `PUT /auth/{provider}` would write the same file through a running
      // server; the Runner writes it itself so a sign-in needs no process and
      // the key never travels through an HTTP request.
      store: async (key) => {
        await writeOpencodeAuthEntry(context.providerState, providerId, key);
      },
      storeFailedDetail: "The API key could not be stored",
    });
  }

  async logout(
    context: HarnessAuthenticationContext,
    selection: HarnessLogoutSelection = {},
  ): Promise<void> {
    OpencodeHarnessConfigSchema.parse(context.config);
    if (selection.connectionSlot && selection.connectionSlot !== "primary") {
      throw new OpensteerError({ code: "bad_request", message: "Unknown OpenCode connection" });
    }
    if (context.providerState.kind !== "isolated") return;
    await removeOpencodeAuthEntry(context.providerState, opencodeProviderId(context.sourceId));
  }

  async removeProfile(context: HarnessAuthenticationContext): Promise<void> {
    // Only an isolated profile has provider files of its own; nothing else is
    // this driver's to delete.
    if (context.providerState.kind !== "isolated") return;
    await opencodeAuthFile(context.providerState).remove();
  }

  async inspect(context: HarnessInspectionContext): Promise<HarnessInspectionResult> {
    const config = OpencodeHarnessConfigSchema.parse(context.config);
    const source = opencodeSource(context.sourceId);
    if (!source) {
      return {
        detail: `OpenCode does not offer the source ${context.sourceId}`,
        status: "unavailable",
      };
    }
    if (context.runtimeBoundary.kind !== "native-user") {
      return { detail: opencodeNativeUserOnlyDetail, status: "unavailable" };
    }
    if (context.providerState.kind !== "isolated") {
      return { detail: opencodeIsolatedProfileDetail, status: "unavailable" };
    }
    if (context.sourceId === opencodeCompatibleSourceId && config.baseUrl === undefined) {
      return {
        detail: "This account has no base URL for its OpenAI-compatible endpoint",
        status: "unavailable",
      };
    }
    const providerId = opencodeProviderId(context.sourceId);
    const apiKey = await readOpencodeAuthKey(context.providerState, providerId);
    // OpenCode Zen answers its free models with no credential at all
    // (`request.body.apiKey: "public"`), so an unkeyed Zen account is a working
    // account rather than one waiting to be signed in. A compatible endpoint
    // decides for itself: discovery below asks it without a key.
    if (
      apiKey === undefined &&
      context.sourceId !== opencodeZenSourceId &&
      context.sourceId !== opencodeCompatibleSourceId
    ) {
      return {
        connections: [
          {
            authKind: "api-key",
            connectionSlot: "primary",
            label: opencodeConnectionLabel(source.label, config.baseUrl),
            status: "authentication-required",
          },
        ],
        detail: `Add an API key for ${source.label} before using this account`,
        setupMethods: opencodeSetupMethods(context.sourceId),
        status: "authentication-required",
      };
    }
    if (context.sourceId === opencodeCompatibleSourceId) {
      try {
        const models = await opencodeCompatibleModels(
          config,
          apiKey,
          context.signal,
          this.#dependencies,
        );
        if (models.length === 0) {
          return {
            detail: `${opencodeConnectionLabel(source.label, config.baseUrl)} reported no models`,
            setupMethods: opencodeSetupMethods(context.sourceId),
            status: "unavailable",
          };
        }
        const inspectionModel = models.find((model) => !model.unavailableReason);
        await writeOpencodeConfigurationFile(
          opencodeInspectionConfigHome(context.providerState),
          opencodeInspectionConfiguration({
            baseUrl: config.baseUrl,
            providerId,
            sourceId: context.sourceId,
            ...(inspectionModel
              ? {
                  modelId: inspectionModel.nativeModelId ?? inspectionModel.modelId,
                  modelContextWindow: inspectionModel.contextWindow,
                  modelMaxOutputTokens: inspectionModel.maxOutputTokens,
                  modelAcceptsImages: inspectionModel.acceptsImages,
                }
              : {}),
          }),
        );
        return {
          connections: [
            {
              authKind: apiKey === undefined ? "none" : "api-key",
              connectionSlot: "primary",
              label: opencodeConnectionLabel(source.label, config.baseUrl),
              logoutSupported: apiKey !== undefined,
              status: "connected",
            },
          ],
          detail: `${opencodeConnectionLabel(source.label, config.baseUrl)} is ready`,
          models,
          setupMethods: opencodeSetupMethods(context.sourceId),
          status: "ready",
        };
      } catch (error) {
        if (
          error instanceof CompatibleEndpointHttpError &&
          (error.status === 401 || error.status === 403)
        ) {
          const settingsKey = await modelServerSettingsKey(config, {
            ...(this.#dependencies.fetchModels ? { fetch: this.#dependencies.fetchModels } : {}),
            ...(this.#dependencies.modelServerHome
              ? { home: this.#dependencies.modelServerHome }
              : {}),
            signal: context.signal,
          });
          return {
            connections: [
              {
                authKind: "api-key",
                connectionSlot: "primary",
                label: opencodeConnectionLabel(source.label, config.baseUrl),
                status: "authentication-required",
              },
            ],
            detail:
              apiKey === undefined
                ? `${opencodeConnectionLabel(source.label, config.baseUrl)} needs an API key`
                : `${opencodeConnectionLabel(source.label, config.baseUrl)} rejected the API key`,
            setupMethods: [
              ...(settingsKey === undefined ? [] : [modelServerSettingsMethod(config.runtime)]),
              ...opencodeSetupMethods(context.sourceId),
            ],
            status: "authentication-required",
          };
        }
        return {
          detail: compatibleEndpointFailureDetail(
            opencodeConnectionLabel(source.label, config.baseUrl),
            error,
          ),
          setupMethods: opencodeSetupMethods(context.sourceId),
          status: "unavailable",
        };
      }
    }
    let server: OpencodeServer | undefined;
    try {
      await writeOpencodeConfigurationFile(
        opencodeInspectionConfigHome(context.providerState),
        opencodeInspectionConfiguration({
          baseUrl: config.baseUrl,
          providerId,
          sourceId: context.sourceId,
        }),
      );
      server = await OpencodeServer.start({
        ...(this.#dependencies.arguments ? { args: this.#dependencies.arguments } : {}),
        cacheHome: opencodeCacheHome(context.providerState),
        config,
        configHome: opencodeInspectionConfigHome(context.providerState),
        dataHome: opencodeDataHome(context.providerState),
        environment: context.environment,
        executable: this.#dependencies.executable,
        signal: context.signal,
        stateHome: opencodeStateHome(context.providerState),
        workingDirectory: context.workingDirectory,
      });
      const providers = parseOpencode(
        OpencodeProvidersSchema,
        await server.request("GET", "/provider", {
          directory: context.workingDirectory,
          signal: context.signal,
        }),
        "provider list",
      );
      const entry = providers.all.find((candidate) => candidate.id === providerId);
      if (!entry) {
        // The catalogue is fetched from models.dev at runtime, so a profile
        // that has never been online has nothing to report. An empty catalog
        // would read as "this account has no models", which is a different and
        // wrong statement.
        return {
          detail: `OpenCode could not list ${source.label} models. Its model catalogue is downloaded on first use, so this account needs network access once.`,
          setupMethods: opencodeSetupMethods(context.sourceId),
          status: "unavailable",
        };
      }
      const models = opencodeCatalogModels(entry, providers.default[providerId], context.sourceId);
      if (models.length === 0) {
        return {
          detail: `OpenCode reported no models for ${opencodeConnectionLabel(source.label, config.baseUrl)}`,
          setupMethods: opencodeSetupMethods(context.sourceId),
          status: "unavailable",
        };
      }
      const connected = providers.connected.includes(providerId);
      if (!connected) {
        return {
          connections: [
            {
              authKind: "api-key",
              connectionSlot: "primary",
              label: opencodeConnectionLabel(source.label, config.baseUrl),
              status: "authentication-required",
            },
          ],
          detail: `OpenCode has no credential for ${source.label}`,
          setupMethods: opencodeSetupMethods(context.sourceId),
          status: "authentication-required",
        };
      }
      return {
        connections: [
          {
            authKind: "api-key",
            connectionSlot: "primary",
            label: opencodeConnectionLabel(source.label, config.baseUrl),
            ...(apiKey === undefined ? {} : { logoutSupported: true }),
            status: "connected",
          },
        ],
        detail: `${opencodeConnectionLabel(source.label, config.baseUrl)} is ready`,
        models,
        setupMethods: opencodeSetupMethods(context.sourceId),
        status: "ready",
      };
    } catch (error) {
      if (error instanceof OpensteerError && error.details?.testedVersion !== undefined) {
        return { detail: error.message, status: "unavailable" };
      }
      if (
        error instanceof OpensteerError &&
        (error.code === "timeout" || error.code === "harness_error")
      ) {
        return { detail: error.message, status: "unavailable" };
      }
      throw error;
    } finally {
      await server?.stop().catch(() => undefined);
    }
  }

  async create(context: HarnessDriverCreateContext): Promise<HarnessAdapter> {
    const config = OpencodeHarnessConfigSchema.parse(context.config);
    if (!opencodeSource(context.sourceId)) {
      throw new OpensteerError({ code: "bad_request", message: "Unknown OpenCode source" });
    }
    return new OpencodeHarnessAdapter(
      context.instanceId,
      config,
      context.sourceId,
      this.#dependencies,
    );
  }
}

class OpencodeHarnessAdapter implements HarnessAdapter {
  readonly capabilities = opencodeHarnessCapabilities;
  readonly instanceId: HarnessInstanceId;
  readonly #config: OpencodeHarnessConfig;
  readonly #sourceId: string;
  readonly #dependencies: OpencodeHarnessDependencies;
  readonly #sessions = new HarnessSessionRegistry<OpencodeHarnessSession>("OpenCode");

  constructor(
    instanceId: HarnessInstanceId,
    config: OpencodeHarnessConfig,
    sourceId: string,
    dependencies: OpencodeHarnessDependencies,
  ) {
    this.instanceId = instanceId;
    this.#config = config;
    this.#sourceId = sourceId;
    this.#dependencies = dependencies;
  }

  async startSession(context: HarnessSessionContext): Promise<HarnessSession> {
    this.#sessions.assertOpen();
    assertFreshProviderSessionContext(context);
    // OpenCode mints the session id, so the reference is only known once the
    // server has answered.
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

  #open(
    context: HarnessSessionContext,
    mode: OpencodeSessionMode,
  ): Promise<OpencodeHarnessSession> {
    return OpencodeHarnessSession.open(
      this.#config,
      this.#sourceId,
      this.#dependencies,
      context,
      mode,
      (closed) => this.#sessions.release(closed),
    );
  }
}

type OpencodeSessionMode =
  { readonly type: "start" } | { readonly reference: string; readonly type: "resume" };

interface OpencodeActiveTurn {
  /** Each child session's assistant messages, so their parts are the subagent's. */
  readonly childMessages: Set<string>;
  /** Child sessions of this turn's subagents. */
  readonly children: Set<string>;
  /** Usage of each subagent's steps, by child session; the Run's usage includes it. */
  readonly childUsage: Map<string, OpencodeUsage>;
  readonly completion: Deferred<void>;
  failure: OpensteerError | undefined;
  /** This turn's subagents, keyed by child session. */
  readonly nodes: SubagentNodes;
  /** Each `task` call's child session. */
  readonly taskChildren: Map<string, string>;
  interruptRequested: boolean;
  interruptPromise?: Promise<void>;
  readonly requestedBy: UserId;
  readonly runId: HarnessRunInput["runId"];
  started: boolean;
  terminal: boolean;
  usageEmitted: boolean;
  readonly usage: OpencodeUsage;
}

interface OpencodeUsage {
  cacheWriteTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  steps: number;
}

function emptyOpencodeUsage(): OpencodeUsage {
  return {
    cacheWriteTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    steps: 0,
  };
}

interface OpencodePendingApproval {
  readonly providerRequestId: string;
  readonly type: "approval";
}

interface OpencodePendingQuestion {
  readonly providerRequestId: string;
  readonly questionIds: readonly string[];
  readonly type: "question";
}

type OpencodePendingRequest = OpencodePendingApproval | OpencodePendingQuestion;

class OpencodeHarnessSession implements HarnessSession {
  readonly events: AsyncIterable<HarnessEvent>;
  readonly #config: OpencodeHarnessConfig;
  readonly #sourceId: string;
  #context: HarnessSessionContext;
  readonly #publisher: TurnPublisher;
  readonly #onClose: (session: OpencodeHarnessSession) => void;
  readonly #pendingRequests = new Map<RequestId, OpencodePendingRequest>();
  /** Asks this driver is answering now, so their settlement is not taken for another's. */
  readonly #answeringAsks = new Set<string>();
  readonly #assistantMessages = new Set<string>();
  readonly #partTypes = new Map<string, string>();
  readonly #startedTools = new Set<string>();
  readonly #startedToolArguments = new Map<string, unknown>();
  readonly #providerRejections = new Set<Promise<void>>();
  readonly #streamLifetime = new AbortController();
  readonly #abortListener: () => void;
  #server: OpencodeServer | undefined;
  #titleLaunch: Pick<OpencodeHarnessDependencies, "executable" | "arguments"> | undefined;
  #sessionId: string | undefined;
  #activeTurn: OpencodeActiveTurn | undefined;
  #closed = false;
  #stopPromise: Promise<void> | undefined;
  #streamDone: Promise<void> | undefined;

  private constructor(
    config: OpencodeHarnessConfig,
    sourceId: string,
    context: HarnessSessionContext,
    onClose: (session: OpencodeHarnessSession) => void,
  ) {
    this.#config = config;
    this.#sourceId = sourceId;
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
    config: OpencodeHarnessConfig,
    sourceId: string,
    dependencies: OpencodeHarnessDependencies,
    context: HarnessSessionContext,
    mode: OpencodeSessionMode,
    onClose: (session: OpencodeHarnessSession) => void,
  ): Promise<OpencodeHarnessSession> {
    if (context.signal.aborted) {
      throw new OpensteerError({
        code: "harness_error",
        message: "OpenCode session was cancelled before startup",
      });
    }
    const session = new OpencodeHarnessSession(config, sourceId, context, onClose);
    try {
      await session.#initialize(dependencies, mode);
      return session;
    } catch (error) {
      await session.#stop(false);
      throw error;
    }
  }

  get providerSessionReference(): string {
    if (!this.#sessionId) {
      throw new OpensteerError({
        code: "internal",
        message: "OpenCode session has not finished opening",
      });
    }
    return this.#sessionId;
  }

  async generateTitle({ prompt, signal }: HarnessTitleInput): Promise<string> {
    const context = this.#context;
    const launch = this.#titleLaunch;
    if (!launch) throw new Error("OpenCode title launch is unavailable");
    return withTitleDirectory(context, async (directory) => {
      const data = join(directory, "data");
      await mkdir(join(data, "opencode"), { recursive: true, mode: 0o700 });
      // Only the account's credentials cross into the disposable store. Its
      // Run database, permissions, instructions and MCP configuration do not.
      await copyFile(
        join(opencodeDataHome(context.providerState), "opencode", "auth.json"),
        join(data, "opencode", "auth.json"),
      ).catch((error: unknown) => {
        if (nodeErrorCode(error) !== "ENOENT") throw error;
      });
      const runConfig: unknown = JSON.parse(
        await readFile(
          join(opencodeSessionConfigHome(context), "opencode", "opencode.json"),
          "utf8",
        ),
      );
      if (!isRecord(runConfig)) throw new Error("OpenCode Run config is invalid");
      const providerId = opencodeProviderId(this.#sourceId);
      const providers = parseOpencode(
        OpencodeProvidersSchema,
        await this.#requireServer().request("GET", "/provider", {
          directory: context.workspacePath,
          signal,
        }),
        "provider list",
      );
      const model = `${providerId}/${opencodeTitleModel(
        providers.all.find((candidate) => candidate.id === providerId),
        harnessModelId(context.modelSelection),
      )}`;
      const configuration = {
        provider: runConfig.provider,
        enabled_providers: [opencodeProviderId(this.#sourceId)],
        model,
        small_model: model,
        instructions: [],
        skills: { paths: [], urls: [] },
        mcp: {},
        plugin: [],
        tools: { "*": false },
        permission: { "*": "deny" },
        agent: {
          title: { disable: true },
          "opensteer-title": {
            mode: "primary",
            prompt:
              "You name tasks. Reply exactly in the format the request asks for. Never use tools.",
            tools: { "*": false },
            permission: { "*": "deny" },
          },
          compaction: { disable: true },
          explore: { disable: true },
          general: { disable: true },
        },
        autoupdate: false,
        share: "disabled",
        snapshot: false,
        formatter: false,
        lsp: false,
      };
      const configFile = join(directory, "opencode.json");
      await writeFile(configFile, JSON.stringify(configuration), { mode: 0o600 });
      const environment = {
        ...context.environment,
        ...opencodeDisableEnvironment,
        OPENCODE_CONFIG: configFile,
        OPENCODE_CONFIG_DIR: join(directory, "config"),
        OPENCODE_CONFIG_CONTENT: "",
        OPENCODE_TEST_HOME: directory,
        OPENCODE_EXPERIMENTAL: "0",
        OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "0",
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_DATA_HOME: data,
        XDG_STATE_HOME: join(directory, "state"),
        // The account's model catalogue and provider packages; without them
        // a cold start downloads both before it can name anything.
        XDG_CACHE_HOME: opencodeCacheHome(context.providerState),
        ...(this.#sourceId === opencodeCompatibleSourceId
          ? { OPENCODE_DISABLE_MODELS_FETCH: "1" }
          : {}),
      };
      const output = await runTitleProcess(
        context,
        {
          executable: launch.executable,
          args: [
            ...(launch.arguments ?? []),
            "run",
            "--agent",
            "opensteer-title",
            "--format",
            "json",
            "--model",
            model,
            "--title",
            "Thread title",
            "--print-logs",
            "--log-level",
            "ERROR",
          ],
          cwd: directory,
          environment,
        },
        signal,
        prompt,
        // OpenCode retries a refused model call without end, a free account
        // past its usage limit included, and says so only in its log.
        /level=ERROR .*message="stream error"/u,
      );
      return output
        .split(/\r?\n/u)
        .flatMap((line) => {
          if (!line.trim()) return [];
          const value: unknown = JSON.parse(line);
          return isRecord(value) &&
            value.type === "text" &&
            isRecord(value.part) &&
            typeof value.part.text === "string"
            ? [value.part.text]
            : [];
        })
        .join("");
    });
  }

  async execute(run: HarnessRunInput): Promise<void> {
    this.#assertUsable();
    if (this.#activeTurn) {
      throw new OpensteerError({
        code: "conflict",
        message: "OpenCode session already has an active turn",
      });
    }
    const parts = await inputsToOpencodeParts(run.inputs, run, run.attachments);
    const initialContext = initialContinuationContextPrompt(this.#context);
    if (initialContext) parts.unshift({ text: initialContext, type: "text" });
    const active: OpencodeActiveTurn = {
      childMessages: new Set(),
      childUsage: new Map(),
      children: new Set(),
      completion: new Deferred<void>(),
      failure: undefined,
      interruptRequested: run.signal.aborted,
      nodes: new SubagentNodes((event) => this.#publish(event)),
      requestedBy: run.requestedBy,
      runId: run.runId,
      started: false,
      taskChildren: new Map(),
      terminal: false,
      usage: emptyOpencodeUsage(),
      usageEmitted: false,
    };
    this.#activeTurn = active;
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
      const selection = this.#context.modelSelection;
      const variant = selection.options.effort;
      // `prompt_async` answers 204 the moment the prompt is admitted; the turn
      // is then driven entirely from the event stream. The blocking
      // `POST /session/{id}/message` would hold one HTTP request open for the
      // whole turn, which no request timeout can bound honestly.
      await this.#requireServer().request(
        "POST",
        `/session/${encodeURIComponent(this.#requireSessionId())}/prompt_async`,
        {
          body: {
            model: {
              modelID: harnessModelId(selection),
              providerID: opencodeProviderId(this.#sourceId),
            },
            parts,
            // Per-Run facts travel on the prompt, not on the configuration: the
            // machine-access inventory changes from Run to Run and a resumed
            // conversation would otherwise hold an earlier Run's. Verified live
            // — the text reaches the model and is echoed on the user message.
            system: opencodeRunSystemPrompt(this.#context),
            ...(typeof variant === "string" ? { variant } : {}),
          },
          directory: this.#context.workspacePath,
          signal: run.signal,
        },
      );
      this.#ensureRunStarted(active);
      if (active.interruptRequested) void this.#interruptActive(active);
      await active.completion.promise;
    } catch (error) {
      if (!active.terminal) {
        if (run.signal.aborted || this.#closed) this.#publishTerminal(active, "interrupted");
        else this.#publishFailure(active, toHarnessError(error, "OpenCode turn failed"));
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

  rebind(context: HarnessSessionContext): void {
    if (this.#activeTurn) throw new Error("An OpenCode session cannot be rebound during a Run");
    this.#context = context;
  }

  /**
   * OpenCode keeps nothing of a finished turn, and no answer this driver sends
   * outlives the one call it was asked for; only an ask still open is held.
   */
  async releaseForReuse(): Promise<boolean> {
    return (
      !this.#closed &&
      !this.#publisher.unusable &&
      !this.#activeTurn &&
      this.#pendingRequests.size === 0
    );
  }

  async resolveRequest(requestId: RequestId, response: RequestResponse): Promise<void> {
    this.#assertUsable();
    const pending = this.#pendingRequests.get(requestId);
    if (!pending) {
      throw new OpensteerError({ code: "not_found", message: "OpenCode Request not found" });
    }
    const directory = this.#context.workspacePath;
    if (pending.type === "approval") {
      if (
        response.kind !== "choice" ||
        (response.optionId !== "allow-once" && response.optionId !== "reject")
      ) {
        throw invalidOpencodeRequestResponse();
      }
      const note =
        response.optionId === "reject"
          ? boundedDenialNote(response.text, {
              maximumBytes: opencodeDenialNoteMaxBytes,
              tooLong: invalidOpencodeRequestResponse,
            })
          : undefined;
      // Only "once" and "reject" are ever sent. "always" writes a rule into the
      // project's saved permissions that survives a restart, which would widen
      // the account permanently on one person's answer to one Run.
      this.#answeringAsks.add(pending.providerRequestId);
      try {
        await this.#requireServer().request(
          "POST",
          `/permission/${encodeURIComponent(pending.providerRequestId)}/reply`,
          {
            body: {
              reply: response.optionId === "reject" ? "reject" : "once",
              // The v1 reply carries the person's note to the model verbatim:
              // the tool call fails with "The user rejected permission to use
              // this specific tool call with the following feedback: <note>".
              ...(note ? { message: note } : {}),
            },
            directory,
          },
        );
      } finally {
        this.#answeringAsks.delete(pending.providerRequestId);
      }
      // Forgotten only once OpenCode has taken the answer: a reply that timed
      // out or was refused leaves the engine still holding the permission, and
      // the Request has to stay answerable so the person can try again.
      this.#pendingRequests.delete(requestId);
      return;
    }
    if (response.kind !== "form") throw invalidOpencodeRequestResponse();
    const answers = RequestFormAnswersSchema.parse(response.answers);
    validateQuestionAnswers(pending.questionIds, answers);
    this.#answeringAsks.add(pending.providerRequestId);
    try {
      await this.#requireServer().request(
        "POST",
        `/question/${encodeURIComponent(pending.providerRequestId)}/reply`,
        {
          body: {
            answers: pending.questionIds.map((questionId) => answers[questionId] ?? []),
          },
          directory,
        },
      );
    } finally {
      this.#answeringAsks.delete(pending.providerRequestId);
    }
    this.#pendingRequests.delete(requestId);
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop(true);
    return this.#stopPromise;
  }

  async #initialize(
    dependencies: OpencodeHarnessDependencies,
    mode: OpencodeSessionMode,
  ): Promise<void> {
    const context = this.#context;
    this.#titleLaunch = dependencies;
    if (context.runtimeBoundary.kind !== "native-user") {
      throw new OpensteerError({ code: "forbidden", message: opencodeNativeUserOnlyDetail });
    }
    if (context.providerState.kind !== "isolated") {
      throw new OpensteerError({ code: "forbidden", message: opencodeIsolatedProfileDetail });
    }
    let compatibleModel: HarnessModelDescriptor | undefined;
    if (this.#sourceId === opencodeCompatibleSourceId) {
      const apiKey = await readOpencodeAuthKey(context.providerState, opencodeCompatibleProviderId);
      const models = await opencodeCompatibleModels(
        this.#config,
        apiKey,
        context.signal,
        dependencies,
        harnessModelId(context.modelSelection),
      );
      compatibleModel = models.find(
        (candidate) => candidate.nativeModelId === harnessModelId(context.modelSelection),
      );
      if (!compatibleModel) {
        throw new OpensteerError({
          code: "harness_error",
          message: `The endpoint no longer lists ${harnessModelId(context.modelSelection)}`,
        });
      }
      if (compatibleModel.unavailableReason || !compatibleModel.contextWindow) {
        throw new OpensteerError({
          code: "harness_error",
          message:
            compatibleModel.unavailableReason ??
            `Set the context window for ${harnessModelId(context.modelSelection)}`,
        });
      }
    }
    const openSteerToolIds = opencodeOpensteerToolIds(context.agentTools.capabilityProfileId);
    const configHome = opencodeSessionConfigHome(context);
    const instructionsFile = join(context.threadStateDirectory, "opencode", "instructions.md");
    const skillsDirectory = await materializeOpencodeSkills(context);
    await writeOpencodeInstructionsFile(instructionsFile, context, openSteerToolIds);
    await writeOpencodeConfigurationFile(
      configHome,
      opencodeSessionConfiguration({
        accessMode: context.accessMode,
        agentTools: { token: context.agentTools.token, url: context.agentTools.url },
        baseUrl: this.#config.baseUrl,
        instructionsFile,
        integrationTools: {
          token: context.integrationTools.token,
          url: context.integrationTools.url,
        },
        modelId: harnessModelId(context.modelSelection),
        ...(compatibleModel
          ? {
              modelContextWindow: compatibleModel.contextWindow,
              modelMaxOutputTokens: compatibleModel.maxOutputTokens,
              modelAcceptsImages: compatibleModel.acceptsImages,
            }
          : {}),
        openSteerToolIds,
        providerId: opencodeProviderId(this.#sourceId),
        skillsDirectory,
        sourceId: this.#sourceId,
      }),
    );
    this.#server = await OpencodeServer.start({
      ...(dependencies.arguments ? { args: dependencies.arguments } : {}),
      cacheHome: opencodeCacheHome(context.providerState),
      config: this.#config,
      configHome,
      dataHome: opencodeDataHome(context.providerState),
      disableModelsFetch: this.#sourceId === opencodeCompatibleSourceId,
      environment: context.environment,
      executable: dependencies.executable,
      signal: this.#streamLifetime.signal,
      stateHome: opencodeStateHome(context.providerState),
      wrapProcessLaunch: context.wrapProcessLaunch,
      workingDirectory: context.workspacePath,
    });
    await this.#sweepSavedPermissions();
    if (mode.type === "resume") {
      const existing = parseOpencode(
        OpencodeSessionSchema,
        await this.#requireServer().request(
          "GET",
          `/session/${encodeURIComponent(mode.reference)}`,
          {
            directory: context.workspacePath,
          },
        ),
        "session",
      );
      // The provider's own durable session is the continuation. A reference the
      // profile's database does not hold is a missing conversation, never a
      // reason to open a fresh one.
      if (existing.id !== mode.reference) {
        throw opencodeProtocolError(
          `OpenCode returned session ${existing.id} while Opensteer asked for ${mode.reference}`,
        );
      }
      this.#sessionId = mode.reference;
    } else {
      const created = parseOpencode(
        OpencodeSessionSchema,
        await this.#requireServer().request("POST", "/session", {
          body: {},
          directory: context.workspacePath,
        }),
        "session",
      );
      this.#sessionId = created.id;
    }
    // The subscription is established before any prompt: a turn admitted while
    // nobody is listening would have nowhere to report its events.
    this.#streamDone = this.#consumeEvents(
      await this.#requireServer().openEvents({
        directory: context.workspacePath,
        signal: this.#streamLifetime.signal,
      }),
    );
  }

  /**
   * An `"always"` answer persists in the project's saved permissions across
   * restarts. This driver never sends one, so a row here is a bug or another
   * client's leftover; either way it would silently widen this Run.
   */
  async #sweepSavedPermissions(): Promise<void> {
    const saved = parseOpencode(
      OpencodeSavedPermissionsSchema,
      await this.#requireServer().request("GET", "/api/permission/saved"),
      "saved permissions",
    );
    for (const row of saved.data) {
      await this.#requireServer().request(
        "DELETE",
        `/api/permission/saved/${encodeURIComponent(row.id)}`,
      );
    }
  }

  async #consumeEvents(
    stream: AsyncIterable<{ readonly type: string; readonly properties: unknown }>,
  ): Promise<void> {
    try {
      for await (const event of stream) {
        this.#handleEvent(event.type, event.properties);
      }
      if (!this.#streamLifetime.signal.aborted) {
        this.#handleStreamFailure(
          opencodeProtocolError("OpenCode closed its event stream while the session was open"),
        );
      }
    } catch (error) {
      if (this.#streamLifetime.signal.aborted) return;
      this.#handleStreamFailure(toHarnessError(error, "OpenCode event stream failed"));
    }
  }

  #handleEvent(type: string, properties: unknown): void {
    switch (type) {
      case "session.created":
      case "session.updated": {
        // A subagent's child session names this one as its parent.
        const created = parseOpencode(OpencodeSessionEventSchema, properties, type);
        const active = this.#liveTurn();
        if (active && created.info.parentID === this.#sessionId)
          active.children.add(created.info.id);
        return;
      }
      case "message.updated": {
        const updated = parseOpencode(OpencodeMessageUpdatedSchema, properties, "message.updated");
        if (updated.info.role !== "assistant") return;
        const child = this.#childSession(updated.info.sessionID);
        if (child) {
          child.active.childMessages.add(updated.info.id);
          if (updated.info.providerID && updated.info.modelID) {
            child.active.nodes.update(child.session, {
              model: `${updated.info.providerID}/${updated.info.modelID}`,
            });
          }
          return;
        }
        if (updated.info.sessionID !== this.#sessionId) return;
        this.#assistantMessages.add(updated.info.id);
        this.#handleAssistantMessage(updated.info);
        return;
      }
      case "message.part.updated": {
        const updated = parseOpencode(
          OpencodePartUpdatedSchema,
          properties,
          "message.part.updated",
        );
        const child = this.#childSession(updated.sessionID);
        if (child) {
          this.#handleChildPart(child.active, child.session, updated.part);
          return;
        }
        if (updated.sessionID !== this.#sessionId) return;
        this.#handlePart(updated.part);
        return;
      }
      case "message.part.delta": {
        const delta = parseOpencode(OpencodePartDeltaSchema, properties, "message.part.delta");
        if (delta.sessionID !== this.#sessionId) return;
        if (!this.#assistantMessages.has(delta.messageID)) return;
        this.#handleDelta(delta.partID, delta.delta);
        return;
      }
      case "permission.asked": {
        const request = parseOpencode(
          OpencodePermissionRequestSchema,
          properties,
          "permission.asked",
        );
        if (request.sessionID !== this.#sessionId && !this.#childSession(request.sessionID)) return;
        this.#openApproval(request);
        return;
      }
      case "question.asked": {
        // Verified live against 1.18.31 by Workstream O, because the fact sheet
        // records only the v2 shape and marks it UNVERIFIED: the v1 stream
        // emits `question.asked` with
        // `{id: "que_…", sessionID, questions: [{question, header, options:
        // [{label, description}]}], tool: {messageID, callID}}`, and
        // `POST /question/{id}/reply?directory=…` with `{"answers":[["Staging"]]}`
        // answers it with `200 true`, followed by `question.replied`. Recorded
        // in opencode-facts.md §3 under "verified by Workstream O".
        const request = parseOpencode(OpencodeQuestionRequestSchema, properties, "question.asked");
        if (request.sessionID !== this.#sessionId && !this.#childSession(request.sessionID)) return;
        this.#openQuestion(request);
        return;
      }
      case "permission.replied":
      case "question.replied":
      case "question.rejected": {
        // Rejecting one ask rejects the rest of its session's asks too; a
        // Request whose ask OpenCode settled without this driver is over.
        const settled = parseOpencode(OpencodeAskSettledSchema, properties, type);
        if (this.#answeringAsks.has(settled.requestID)) return;
        for (const [requestId, pending] of this.#pendingRequests) {
          if (pending.providerRequestId !== settled.requestID) continue;
          this.#pendingRequests.delete(requestId);
          this.#publish({
            data: { reason: "source-closed", requestId },
            type: "request.cancelled",
          });
        }
        return;
      }
      case "session.error": {
        const failure = parseOpencode(OpencodeSessionErrorSchema, properties, "session.error");
        // A subagent's failure is its `task` call's result, never the Run's own.
        if (failure.sessionID !== undefined && failure.sessionID !== this.#sessionId) return;
        this.#latchTurnError(failure.error ?? undefined);
        return;
      }
      case "session.idle": {
        const idle = parseOpencode(OpencodeSessionIdleSchema, properties, "session.idle");
        if (idle.sessionID !== this.#sessionId) return;
        this.#settleTurn();
        return;
      }
      default:
        // An ask this driver cannot answer blocks the model inside OpenCode
        // forever: no `session.idle` ever arrives, so the Run would hang with
        // no terminal event at all. Failing the Run by name is the only honest
        // answer, and it is how a wire change announces itself.
        if (type.endsWith(".asked")) {
          this.#handleStreamFailure(
            opencodeProtocolError(`OpenCode asked ${type}, which Opensteer cannot answer`),
          );
        }
        return;
    }
  }

  /** The turn this session is executing, or nothing once it has ended. */
  #liveTurn(): OpencodeActiveTurn | undefined {
    const active = this.#activeTurn;
    return active && !active.terminal ? active : undefined;
  }

  #handleAssistantMessage(info: OpencodeMessageInfo): void {
    if (info.error) this.#latchTurnError(info.error);
  }

  #handlePart(part: OpencodePart): void {
    // Nothing a turn produced may be published once that turn has ended: a
    // part snapshot arriving after `session.idle` would put content after the
    // Run's terminal event.
    if (!this.#liveTurn()) return;
    if (!this.#assistantMessages.has(part.messageID)) return;
    this.#partTypes.set(part.id, part.type);
    const finished = part.time?.end !== undefined;
    switch (part.type) {
      case "text":
        if (finished && part.text) {
          this.#publish({
            data: { content: [{ text: part.text, type: "text" }], messageId: createId("message") },
            type: "assistant.message",
          });
        }
        return;
      case "reasoning":
        if (finished && part.text) {
          this.#publish({
            data: { blockId: part.id, text: truncateReasoning(part.text) },
            type: "reasoning.completed",
          });
        }
        return;
      case "tool":
        this.#handleToolPart(part);
        return;
      case "step-finish":
        this.#accumulateUsage(part);
        return;
      default:
        return;
    }
  }

  #handleDelta(partId: string, delta: string): void {
    if (!this.#liveTurn()) return;
    const type = this.#partTypes.get(partId);
    if (type === "text") {
      this.#publish({ data: { text: delta }, type: "assistant.delta" });
      return;
    }
    if (type === "reasoning") {
      this.#publish({ data: { blockId: partId, text: delta }, type: "reasoning.delta" });
    }
  }

  #handleToolPart(part: OpencodePart): void {
    const active = this.#liveTurn();
    if (!active) return;
    const callId = part.callID;
    const state = part.state;
    if (!callId || !state) return;
    if (part.tool === "task") this.#trackTask(active, callId, state);
    if (state.status === "running" && !this.#startedTools.has(callId)) {
      this.#startedTools.add(callId);
      this.#startedToolArguments.set(callId, state.input);
      this.#publish({
        data: {
          arguments: state.input,
          callId,
          tool: opencodeToolIdentity(part.tool ?? "unknown"),
        },
        type: "tool.started",
      });
      return;
    }
    if (state.status !== "completed" && state.status !== "error") return;
    if (!this.#startedTools.has(callId)) {
      this.#startedTools.add(callId);
      this.#publish({
        data: {
          arguments: state.input,
          callId,
          tool: opencodeToolIdentity(part.tool ?? "unknown"),
        },
        type: "tool.started",
      });
    } else if (
      this.#startedToolArguments.has(callId) &&
      typeof state.input === "object" &&
      state.input !== null &&
      !Array.isArray(state.input) &&
      Object.keys(this.#startedToolArguments.get(callId) ?? {}).every((key) =>
        Object.hasOwn(state.input as Record<string, unknown>, key),
      ) &&
      !isDeepStrictEqual(this.#startedToolArguments.get(callId), state.input)
    ) {
      // The running part can precede its complete input. Keep the first start
      // live, then give the durable transcript the arguments the tool ran with.
      this.#publish({
        data: {
          arguments: state.input,
          callId,
          tool: opencodeToolIdentity(part.tool ?? "unknown"),
        },
        type: "tool.started",
      });
    }
    this.#startedToolArguments.delete(callId);
    this.#publish({
      data: {
        callId,
        isError: state.status === "error",
        output: normalizeToolOutput(
          state.status === "error" ? (state.error ?? "") : (state.output ?? ""),
        ),
      },
      type: "tool.completed",
    });
  }

  /**
   * One `step-finish` part per model call, each carrying that step's own
   * `tokens` and `cost`. The accumulator is per Run — it lives on the active
   * turn — so a resumed conversation's earlier steps are never re-counted, and
   * the session aggregate (`Session.tokens`), which is cumulative, is not used.
   */
  #accumulateUsage(part: OpencodePart): void {
    const active = this.#activeTurn;
    if (!active || active.terminal) return;
    addOpencodeStep(active.usage, part);
  }

  /** The live turn and child session a session id names, if it is one of this turn's subagents. */
  #childSession(
    sessionId: string,
  ): { readonly active: OpencodeActiveTurn; readonly session: string } | undefined {
    const active = this.#liveTurn();
    if (!active || sessionId === this.#sessionId || !active.children.has(sessionId))
      return undefined;
    return { active, session: sessionId };
  }

  /**
   * A `task` call starts or resumes a child session: its running state names
   * the session, and its end carries what the subagent returned. A resumed
   * session is a new node; one whose question arrived first keeps its node.
   */
  #trackTask(
    active: OpencodeActiveTurn,
    callId: string,
    state: NonNullable<OpencodePart["state"]>,
  ) {
    const input = isRecord(state.input) ? state.input : {};
    const metadata = isRecord(state.metadata) ? state.metadata : {};
    const session = typeof metadata.sessionId === "string" ? metadata.sessionId : undefined;
    if (session && !active.taskChildren.has(callId)) {
      active.taskChildren.set(callId, session);
      active.children.add(session);
      const model = isRecord(metadata.model) ? metadata.model : {};
      const start = {
        model:
          typeof model.providerID === "string" && typeof model.modelID === "string"
            ? `${model.providerID}/${model.modelID}`
            : null,
        originCallId: callId,
        prompt: typeof input.prompt === "string" ? input.prompt : null,
        title:
          typeof input.description === "string"
            ? input.description
            : typeof state.title === "string"
              ? state.title
              : null,
      };
      // A child seen before the call that spawned it opened its node unnamed,
      // and this call names that same invocation. A node another call started
      // is the child's previous invocation; this call is its next one.
      const origin = active.nodes.originCallId(session);
      if (origin === null || origin === callId) active.nodes.update(session, start);
      else active.nodes.open(session, { ...start, nativeRef: callId, sessionRef: session });
    }
    if (state.status !== "completed" && state.status !== "error") return;
    const child = active.taskChildren.get(callId);
    if (!child) return;
    const usage = active.childUsage.get(child);
    active.childUsage.delete(child);
    // OpenCode reports a task its Run stopped as an error: "Task cancelled".
    const outcome =
      state.status === "completed"
        ? "completed"
        : active.interruptRequested
          ? "interrupted"
          : "failed";
    active.nodes.complete(child, outcome, {
      result: state.status === "error" ? (state.error ?? null) : opencodeTaskResult(state.output),
      usage: usage ? (opencodeRunUsage(usage) ?? null) : null,
    });
  }

  /** A subagent's own part: its tools, its words, and the model calls it made. */
  #handleChildPart(active: OpencodeActiveTurn, session: string, part: OpencodePart): void {
    if (!active.childMessages.has(part.messageID)) return;
    const nodeId = active.nodes.ensure(session, { sessionRef: session });
    if (part.type === "text" && part.time?.end !== undefined && part.text) {
      active.nodes.noteResult(session, part.text);
      return;
    }
    if (part.type === "step-finish") {
      // A subagent's model calls are the Run's too.
      this.#accumulateUsage(part);
      const usage = active.childUsage.get(session) ?? emptyOpencodeUsage();
      active.childUsage.set(session, usage);
      addOpencodeStep(usage, part);
      return;
    }
    if (part.type !== "tool" || !part.callID || !part.state) return;
    const key = `${session}:${part.callID}`;
    const tool = opencodeToolIdentity(part.tool ?? "unknown");
    const { state } = part;
    if (!this.#startedTools.has(key)) {
      this.#startedTools.add(key);
      this.#publish({
        data: { arguments: state.input, callId: part.callID, nodeId, tool },
        type: "tool.started",
      });
    }
    if (state.status !== "completed" && state.status !== "error") return;
    this.#publish({
      data: {
        callId: part.callID,
        isError: state.status === "error",
        nodeId,
        output: normalizeToolOutput(
          state.status === "error" ? (state.error ?? "") : (state.output ?? ""),
        ),
      },
      type: "tool.completed",
    });
  }

  #latchTurnError(error: OpencodeErrorPayload | undefined): void {
    const active = this.#activeTurn;
    if (!active || active.terminal || !error) return;
    if (error.name === "MessageAbortedError") {
      active.interruptRequested = true;
      return;
    }
    active.failure ??= opencodeFailure(error);
  }

  /**
   * `session.idle` is the only end-of-turn signal OpenCode gives, and it is
   * emitted after a failure as well as after a clean finish, so the failure
   * latched from `session.error` or from the assistant message decides what the
   * Run reports.
   */
  #settleTurn(): void {
    const active = this.#activeTurn;
    if (!active || active.terminal) return;
    if (active.failure) {
      this.#publishFailure(active, active.failure);
      return;
    }
    this.#publishTerminal(active, active.interruptRequested ? "interrupted" : "completed");
  }

  async #interruptActive(active: OpencodeActiveTurn): Promise<void> {
    if (active.terminal) return;
    active.interruptPromise ??= this.#performInterrupt(active);
    await active.interruptPromise;
  }

  async #performInterrupt(active: OpencodeActiveTurn): Promise<void> {
    try {
      // Every outstanding ask is answered before the abort, not after it. An
      // abort does not release the rows OpenCode is blocked on, so a turn
      // sitting inside a permission prompt cannot reach idle until something
      // answers it — and waiting first would spend the whole settle budget on a
      // turn that was never going to move.
      await this.#cancelPendingRequests("run-ended");
      await this.#requireServer().request(
        "POST",
        `/session/${encodeURIComponent(this.#requireSessionId())}/abort`,
        { body: {}, directory: this.#context.workspacePath },
      );
      await this.#awaitTurnSettled(active);
      if (!active.terminal) this.#publishTerminal(active, "interrupted");
    } catch (error) {
      if (active.terminal) return;
      this.#publishFailure(active, toHarnessError(error, "Failed to interrupt the OpenCode turn"));
    }
  }

  /**
   * How long an aborted turn is given to wind down. The deadline is cleared as
   * soon as the turn settles: a pending timer would otherwise hold a handle for
   * the rest of the budget after the work it was bounding is already done.
   */
  async #awaitTurnSettled(active: OpencodeActiveTurn): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        active.completion.promise,
        new Promise<void>((resolveTimer) => {
          timer = setTimeout(resolveTimer, this.#config.interruptTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Refuses whichever kind of ask OpenCode is holding open. */
  #rejectProviderRequest(request: OpencodePendingRequest): Promise<void> | undefined {
    if (request.type === "approval") {
      return this.#rejectProviderPermission(request.providerRequestId);
    }
    return this.#rejectProviderQuestion(request.providerRequestId);
  }

  #rejectProviderQuestion(providerRequestId: string): Promise<void> | undefined {
    return this.#trackProviderRejection(
      this.#server?.request("POST", `/question/${encodeURIComponent(providerRequestId)}/reject`, {
        body: {},
        directory: this.#context.workspacePath,
      }),
    );
  }

  /**
   * Answers one of OpenCode's own permission rows. Interrupt waits for this
   * response before aborting because the engine is blocked on the row.
   */
  #rejectProviderPermission(providerRequestId: string): Promise<void> | undefined {
    return this.#trackProviderRejection(
      this.#server?.request("POST", `/permission/${encodeURIComponent(providerRequestId)}/reply`, {
        body: { reply: "reject" },
        directory: this.#context.workspacePath,
      }),
    );
  }

  /** Tracks replies so interruption can order abort after them and session
   * shutdown cannot kill the server while one is still in flight. */
  #trackProviderRejection(request: Promise<unknown> | undefined): Promise<void> | undefined {
    if (!request) return undefined;
    const settled = request.then(
      () => undefined,
      () => undefined,
    );
    this.#providerRejections.add(settled);
    void settled.finally(() => this.#providerRejections.delete(settled));
    return settled;
  }

  #openApproval(request: z.infer<typeof OpencodePermissionRequestSchema>): void {
    if (!this.#liveTurn()) {
      // No Run can answer this, and leaving it unanswered blocks the engine.
      void this.#rejectProviderPermission(request.id);
      return;
    }
    const requestId = createId("request");
    this.#pendingRequests.set(requestId, { providerRequestId: request.id, type: "approval" });
    this.#publish({
      data: {
        request: this.#pendingRequest(
          requestId,
          request.tool?.callID ?? request.id,
          "harness.approval",
          {
            ...opencodeApprovalDescriptor(request),
            kind: "choice",
            options: [
              { hint: "allow-once", id: "allow-once", label: "Allow once" },
              { hint: "reject-once", id: "reject", label: "Reject" },
            ],
          },
          this.#askingNode(request.sessionID),
        ),
      },
      type: "request.opened",
    });
  }

  #openQuestion(request: z.infer<typeof OpencodeQuestionRequestSchema>): void {
    if (!this.#liveTurn()) {
      // No Run can answer this, and leaving it unanswered blocks the engine.
      void this.#rejectProviderQuestion(request.id);
      return;
    }
    const requestId = createId("request");
    const questionIds = request.questions.map((_question, index) => `question-${index}`);
    this.#pendingRequests.set(requestId, {
      providerRequestId: request.id,
      questionIds,
      type: "question",
    });
    this.#publish({
      data: {
        request: this.#pendingRequest(
          requestId,
          request.tool?.callID ?? request.id,
          "harness.input",
          {
            fields: request.questions.map((question, index) => ({
              ...(question.options.length > 0
                ? {
                    choices: question.options.map((option) => ({
                      ...(option.description ? { description: option.description } : {}),
                      label: option.label,
                      value: option.label,
                    })),
                  }
                : {}),
              id: questionIds[index] ?? `question-${index}`,
              multiSelect: question.multiple === true,
              prompt: question.question,
              secret: false,
            })),
            kind: "form",
            title: "More information needed",
          },
          this.#askingNode(request.sessionID),
        ),
      },
      type: "request.opened",
    });
  }

  /** The subagent a child session's ask comes from, opened now if nothing named it yet. */
  #askingNode(sessionId: string): ExecutionNodeId | undefined {
    const child = this.#childSession(sessionId);
    return child?.active.nodes.ensure(child.session, { sessionRef: child.session });
  }

  #pendingRequest(
    id: RequestId,
    callId: string,
    kind: "harness.approval" | "harness.input",
    presentation: PendingRequest["presentation"],
    nodeId: ExecutionNodeId | undefined,
  ): PendingRequest {
    const active = this.#activeTurn;
    if (!active || active.terminal) {
      throw opencodeProtocolError("OpenCode opened a Request without an active turn");
    }
    return {
      callId,
      cancellationReason: null,
      createdAt: new Date().toISOString(),
      id,
      kind,
      mode: "live",
      ...(nodeId ? { originatingNodeId: nodeId } : {}),
      originatingOccurrenceId: null,
      originatingRunId: active.runId,
      originatingThreadId: this.#context.threadId,
      originatingWorkspaceId: this.#context.workspaceId,
      payload: { kind },
      presentation,
      requestedBy: active.requestedBy,
      requiredActor: "requester",
      resolvedAt: null,
      resolvedBy: null,
      response: null,
      status: "pending",
      targetWorkspaceId: this.#context.workspaceId,
    };
  }

  /**
   * The message, part and tool ids this turn accumulated. A session may execute
   * more than one Run, and nothing here outlives the turn that filled it.
   */
  #forgetTurnState(): void {
    this.#assistantMessages.clear();
    this.#partTypes.clear();
    this.#startedTools.clear();
    this.#startedToolArguments.clear();
  }

  async #cancelPendingRequests(reason: "run-ended" | "source-closed"): Promise<void> {
    const pending = [...this.#pendingRequests.entries()];
    this.#pendingRequests.clear();
    const replies: Promise<void>[] = [];
    for (const [requestId, request] of pending) {
      // An abort does not answer the rows OpenCode is blocked on, so a Run that
      // ends with an ask outstanding leaves the engine waiting on a reply that
      // can never come. Rejecting it is what actually unblocks the tool call.
      const reply = this.#rejectProviderRequest(request);
      if (reply) replies.push(reply);
      try {
        this.#publish({ data: { reason, requestId }, type: "request.cancelled" });
      } catch {
        // The stream is already unusable; the terminal event is what matters.
      }
    }
    await Promise.allSettled(replies);
  }

  #ensureRunStarted(active: OpencodeActiveTurn): void {
    if (active.started) return;
    active.started = true;
    this.#publish(runStartedEvent());
  }

  /** Usage is stated once per Run and always before the Run's terminal event. */
  #publishUsage(active: OpencodeActiveTurn): void {
    if (active.usageEmitted || active.usage.steps === 0) return;
    active.usageEmitted = true;
    const usage: RunUsage | undefined = opencodeRunUsage(active.usage);
    if (usage) this.#publish({ data: usage, type: "run.usage" });
  }

  #publishTerminal(active: OpencodeActiveTurn, status: "completed" | "interrupted"): void {
    if (!this.#publisher.claimTerminal(active)) return;
    this.#forgetTurnState();
    void this.#cancelPendingRequests("run-ended");
    try {
      if (status === "completed") this.#ensureRunStarted(active);
      active.nodes.endAll();
      this.#publishUsage(active);
      this.#publish(runEndedEvent(status));
    } finally {
      active.completion.resolve();
    }
  }

  #publishFailure(active: OpencodeActiveTurn, error: OpensteerError): void {
    if (!this.#publisher.claimTerminal(active)) return;
    this.#forgetTurnState();
    void this.#cancelPendingRequests("run-ended");
    try {
      active.nodes.endAll();
      this.#publishUsage(active);
      this.#publish(
        runFailedEvent({
          code: opencodeFailureCode(error),
          message: error.message,
          retryable: error.retryable,
        }),
      );
    } finally {
      active.completion.resolve();
    }
  }

  /**
   * The server is gone, or its event stream is, so nothing it owes will arrive
   * — least of all the end of a turn a stop is waiting on. The Run ends now, as
   * the stop it was asked for if one was, and the session stops, which frees
   * its conversation for the next Run at once.
   */
  #handleStreamFailure(error: OpensteerError): void {
    if (!this.#publisher.unusable) {
      this.#publisher.latchUnusable(error);
      const active = this.#activeTurn;
      if (active) {
        try {
          if (this.#closed || active.interruptRequested) {
            this.#publishTerminal(active, "interrupted");
          } else this.#publishFailure(active, error);
        } catch {
          // The turn is terminal even when its terminal event could not fit.
        }
      }
      this.#publisher.closeStream(error);
    }
    void this.stop();
  }

  #publish(event: HarnessEvent): void {
    if (this.#publisher.streamClosed) return;
    try {
      this.#publisher.publish(event);
    } catch (error) {
      const failure = toHarnessError(error, "OpenCode event buffer failed");
      this.#publisher.latchUnusable(failure);
      const active = this.#activeTurn;
      if (active && this.#publisher.claimTerminal(active)) active.completion.resolve();
      void this.#server?.stop();
      throw failure;
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
    await this.#cancelPendingRequests("source-closed");
    // Rejections already in flight are given their own deadline to land: the
    // server is about to go, and a permission left unanswered is the engine
    // blocked on this driver.
    await Promise.allSettled(this.#providerRejections);
    this.#streamLifetime.abort(new Error("OpenCode session stopped"));
    await this.#streamDone?.catch(() => undefined);
    try {
      await this.#server?.stop();
    } finally {
      this.#publisher.closeStream();
      if (notifyOwner && this.#sessionId) this.#onClose(this);
    }
  }

  #requireServer(): OpencodeServer {
    if (!this.#server) {
      throw new OpensteerError({
        code: "harness_error",
        message: "OpenCode server is not running",
      });
    }
    return this.#server;
  }

  #requireSessionId(): string {
    if (!this.#sessionId) {
      throw new OpensteerError({
        code: "harness_error",
        message: "OpenCode session has not finished opening",
      });
    }
    return this.#sessionId;
  }

  #assertUsable(): void {
    if (this.#closed) {
      throw new OpensteerError({ code: "harness_error", message: "OpenCode session is closed" });
    }
    if (this.#publisher.unusable) throw this.#publisher.unusable;
  }
}

/* ------------------------------------------------------------------ profile */

function opencodeProfileHome(providerState: HarnessProviderState): string {
  const home = providerState.kind === "isolated" ? providerState.providerHomeDirectory : undefined;
  if (!home)
    throw new OpensteerError({ code: "bad_request", message: opencodeIsolatedProfileDetail });
  return resolve(home);
}

/** `$XDG_DATA_HOME`: the account's `auth.json` and the one sqlite conversation store. */
export function opencodeDataHome(providerState: HarnessProviderState): string {
  return join(opencodeProfileHome(providerState), "data");
}

function opencodeCacheHome(providerState: HarnessProviderState): string {
  return join(opencodeProfileHome(providerState), "cache");
}

function opencodeStateHome(providerState: HarnessProviderState): string {
  return join(opencodeProfileHome(providerState), "state");
}

/** Inspection reads the account, not a Thread, so its configuration is the account's. */
function opencodeInspectionConfigHome(providerState: HarnessProviderState): string {
  return join(opencodeProfileHome(providerState), "inspect-config");
}

/**
 * `$XDG_CONFIG_HOME` for one session. It sits under the Thread's own state
 * directory because the configuration describes this Run — its model, its
 * access mode, its instructions, its MCP tokens — and two Runs of one account
 * are two servers reading two configurations at once.
 */
export function opencodeSessionConfigHome(context: HarnessSessionContext): string {
  return join(context.threadStateDirectory, "opencode", "config");
}

export function opencodeAuthFile(providerState: HarnessProviderState) {
  // OpenCode reads `$XDG_DATA_HOME/opencode/auth.json` at 0600; the Runner
  // writes it rather than calling `PUT /auth/{provider}`, so a sign-in needs no
  // running server and the key never travels over HTTP.
  return providerSecretFile(providerState, join("data", "opencode", "auth.json"), {
    description: "OpenCode credential file",
    maximumBytes: opencodeAuthFileMaxBytes,
  });
}

type OpencodeAuthDocument = z.infer<typeof OpencodeAuthDocumentSchema>;

async function readOpencodeAuthDocument(
  providerState: HarnessProviderState,
): Promise<OpencodeAuthDocument> {
  const stored = await opencodeAuthFile(providerState).read();
  if (!stored) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored) as unknown;
  } catch {
    throw new OpensteerError({
      code: "harness_error",
      message: "The stored OpenCode credential file could not be read",
    });
  }
  const document = OpencodeAuthDocumentSchema.safeParse(parsed);
  if (!document.success) {
    throw new OpensteerError({
      code: "harness_error",
      message: "The stored OpenCode credential file is not an OpenCode auth document",
    });
  }
  return document.data;
}

async function readOpencodeAuthKey(
  providerState: HarnessProviderState,
  providerId: string,
): Promise<string | undefined> {
  const key = (await readOpencodeAuthDocument(providerState))[providerId]?.key;
  return key && key.length > 0 ? key : undefined;
}

async function writeOpencodeAuthEntry(
  providerState: HarnessProviderState,
  providerId: string,
  key: string,
): Promise<void> {
  const file = opencodeAuthFile(providerState);
  await mkdir(dirname(file.path), { mode: 0o700, recursive: true });
  const document = await readOpencodeAuthDocument(providerState);
  await file.write(JSON.stringify({ ...document, [providerId]: { key, type: "api" } }));
}

async function removeOpencodeAuthEntry(
  providerState: HarnessProviderState,
  providerId: string,
): Promise<void> {
  const file = opencodeAuthFile(providerState);
  const document = await readOpencodeAuthDocument(providerState);
  if (document[providerId] === undefined) return;
  const remaining = Object.fromEntries(
    Object.entries(document).filter(([candidate]) => candidate !== providerId),
  );
  if (Object.keys(remaining).length === 0) {
    await file.remove();
    return;
  }
  await file.write(JSON.stringify(remaining));
}

async function writeOpencodeConfigurationFile(
  configHome: string,
  document: Record<string, unknown>,
): Promise<void> {
  const directory = join(configHome, "opencode");
  await mkdir(directory, { mode: 0o700, recursive: true });
  // The document carries this Run's Opensteer tool bearer tokens, which
  // `OPENCODE_CONFIG_CONTENT` would instead put in an environment the model's
  // own shell commands can read. It is replaced whole rather than written in
  // place: `writeFile`'s mode applies only when it creates the file, so a
  // profile that already holds a permissive `opencode.json` would keep it.
  await replacePrivateFileAtomically(
    join(directory, "opencode.json"),
    `${JSON.stringify(document, null, 2)}\n`,
  );
}

/**
 * The instructions file every Run is given. Everything in it is stable for the
 * Thread; the one fact that changes from Run to Run — the machine-access
 * inventory — travels on the prompt instead, because a configuration file is
 * read once when the server starts.
 */
async function writeOpencodeInstructionsFile(
  path: string,
  context: HarnessSessionContext,
  openSteerToolIds: readonly string[],
): Promise<void> {
  const body = [
    context.platformGuide,
    context.instructions,
    durableHistoryWindowNotice(context),
    opencodeToolsNotice(openSteerToolIds),
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  await writeFile(path, `${body}\n`, { mode: 0o600 });
}

/**
 * What Opensteer's own tools are called once OpenCode has flattened them.
 *
 * The model is told the names it must actually type: OpenCode renames an MCP
 * tool to `<server>_<tool>`, so a notice naming the servers alone would leave
 * the model guessing at every call.
 */
export function opencodeToolsNotice(openSteerToolIds: readonly string[]): string | undefined {
  const agentTools = openSteerToolIds.filter(
    (id) =>
      id.startsWith(`${opencodeAgentToolsServer}_`) &&
      !id.startsWith(`${opencodeIntegrationToolsServer}_`),
  );
  const integrationTools = openSteerToolIds.filter((id) =>
    id.startsWith(`${opencodeIntegrationToolsServer}_`),
  );
  if (agentTools.length === 0 && integrationTools.length === 0) return undefined;
  return [
    "## Opensteer tools",
    "Call Opensteer tools as `<server>_<tool>`; they need no prompt in any access mode.",
    ...(agentTools.length > 0
      ? [`\nFrom \`${opencodeAgentToolsServer}\`: ${agentTools.join(", ")}.`]
      : []),
    ...(integrationTools.length > 0
      ? [`\nFrom \`${opencodeIntegrationToolsServer}\`: ${integrationTools.join(", ")}.`]
      : []),
  ].join("\n");
}

/**
 * OpenCode discovers skills as `<path>/**\/SKILL.md`, so the vendor-neutral
 * plan becomes one private directory of links inside the Thread's state
 * directory. It is rebuilt in place each session because the Thread's
 * directory is deterministic across Runs.
 */
async function materializeOpencodeSkills(context: HarnessSessionContext): Promise<string> {
  const directory = join(context.threadStateDirectory, "opencode", "skills");
  await rm(directory, { force: true, recursive: true });
  await mkdir(directory, { mode: 0o700, recursive: true });
  assertUniqueSkillNames(context.skills?.skills ?? []);
  for (const skill of context.skills?.skills ?? []) {
    await symlink(skill.path, join(directory, skill.name), "dir");
  }
  return directory;
}

function assertUniqueSkillNames(skills: readonly HarnessSkill[]): void {
  const names = new Set<string>();
  for (const skill of skills) {
    if (names.has(skill.name)) {
      throw new OpensteerError({
        code: "conflict",
        message: `OpenCode cannot load duplicate Agent Skill name ${skill.name}`,
      });
    }
    names.add(skill.name);
  }
}

/* ------------------------------------------------------------------ catalog */

const OpencodeTitleCandidateSchema = z.looseObject({
  family: z.string().optional(),
  id: z.string(),
  release_date: z.string().optional(),
});

/** 1.18.32 `Provider.getSmallModel`'s families, which OpenCode's own titles prefer. */
const opencodeSmallModelFamilies = ["gemini-flash", "gpt-nano", "claude-haiku"];

/**
 * The model OpenCode itself would title with: the newest of the provider's
 * small-model families (only `gpt-nano` on OpenCode's own gateway), else the
 * Run's model, which this account is known to be able to use.
 */
function opencodeTitleModel(
  provider: z.infer<typeof OpencodeProviderSchema> | undefined,
  runModelId: string,
): string {
  const models = Object.values(provider?.models ?? {}).flatMap((model) => {
    const parsed = OpencodeTitleCandidateSchema.safeParse(model);
    return parsed.success ? [parsed.data] : [];
  });
  const families = provider?.id.startsWith("opencode") ? ["gpt-nano"] : opencodeSmallModelFamilies;
  for (const family of families) {
    const [small] = models
      .filter((model) => model.family === family)
      .sort(
        (left, right) =>
          (right.release_date ?? "").localeCompare(left.release_date ?? "") ||
          right.id.localeCompare(left.id),
      );
    if (small) return small.id;
  }
  return runModelId;
}

function opencodeCatalogModels(
  provider: z.infer<typeof OpencodeProviderSchema>,
  defaultModelId: string | undefined,
  sourceId: string,
): readonly HarnessModelDescriptor[] {
  const descriptors: HarnessModelDescriptor[] = [];
  const canonicalIndexes = new Map<string, number>();
  for (const model of Object.values(provider.models)) {
    const reference = canonicalModelReference(model.id, sourceId);
    const modelId = ModelIdSchema.safeParse(reference.modelId);
    const providerId = ModelProviderIdSchema.safeParse(reference.providerId);
    if (!modelId.success || !providerId.success) continue;
    const key = JSON.stringify([providerId.data, modelId.data]);
    const variants = Object.keys(model.variants ?? {});
    const acceptsImages = model.capabilities?.input?.image;
    const descriptor = {
      // OpenCode's own capability is the only thing that knows, and it is
      // also what OpenCode checks before passing an image on; a model without
      // one leaves this absent rather than guessing.
      ...(acceptsImages === undefined ? {} : { acceptsImages }),
      ...(model.limit?.context === undefined ? {} : { contextWindow: model.limit.context }),
      ...(model.limit?.output === undefined ? {} : { maxOutputTokens: model.limit.output }),
      displayName: model.name ?? modelDisplayName(reference.modelId),
      isDefault: model.id === defaultModelId,
      modelId: modelId.data,
      // The gateway's own spelling is what a Run must send back, always,
      // even when it equals the canonical id: the canonical pair only
      // groups this model with the same model served elsewhere.
      nativeModelId: model.id,
      options:
        variants.length > 0
          ? [
              {
                id: "effort",
                label: "Reasoning",
                type: "select" as const,
                values: variants.map((variant) => ({
                  label: reasoningEffortLabel(variant),
                  value: variant,
                })),
              },
            ]
          : [],
      providerId: providerId.data,
    } satisfies HarnessModelDescriptor;
    const existingIndex = canonicalIndexes.get(key);
    if (existingIndex === undefined) {
      canonicalIndexes.set(key, descriptors.length);
      descriptors.push(descriptor);
    } else if (descriptor.isDefault && !descriptors[existingIndex]?.isDefault) {
      // Canonical aliases are one selectable model. Prefer the endpoint's
      // declared default spelling, because that is the native route it chose.
      descriptors[existingIndex] = descriptor;
    }
  }
  return withOpencodeDefault(assertOpencodeCatalogSize(descriptors));
}

function assertOpencodeCatalogSize(
  descriptors: readonly HarnessModelDescriptor[],
): readonly HarnessModelDescriptor[] {
  if (descriptors.length <= maxHarnessModelsPerCatalog) return descriptors;
  throw opencodeProtocolError(
    `OpenCode reported ${descriptors.length} models, exceeding Opensteer's complete-catalog limit of ${maxHarnessModelsPerCatalog}`,
  );
}

/**
 * A catalog always names one default. OpenCode's per-provider default can be a
 * model the list does not contain — an id that failed to canonicalize, or one
 * beyond the catalog cap — and a catalog where nothing is default leaves the
 * client with no model to open on.
 */
function withOpencodeDefault(
  descriptors: readonly HarnessModelDescriptor[],
): readonly HarnessModelDescriptor[] {
  if (
    descriptors.length === 0 ||
    descriptors.some((model) => model.isDefault && !model.unavailableReason)
  )
    return descriptors;
  const firstAvailable = descriptors.findIndex((model) => !model.unavailableReason);
  return descriptors.map((model, index) => ({ ...model, isDefault: index === firstAvailable }));
}

/**
 * A compatible endpoint's catalog comes from the endpoint itself. OpenCode's
 * own provider list would describe only the models this driver declared in the
 * configuration, which is the one it is about to run rather than the set the
 * account can reach.
 */
async function opencodeCompatibleModels(
  config: OpencodeHarnessConfig,
  apiKey: string | undefined,
  signal: AbortSignal,
  dependencies: OpencodeHarnessDependencies,
  nativeModelId?: string,
): Promise<readonly HarnessModelDescriptor[]> {
  const models = await discoverCompatibleEndpointModels(
    config,
    apiKey === undefined ? { kind: "none" } : { kind: "api-key", apiKey },
    {
      ...(dependencies.fetchModels ? { fetchModels: dependencies.fetchModels } : {}),
      ...(nativeModelId === undefined ? {} : { nativeModelId }),
      signal,
      timeoutMs: opencodeCompatibleModelsTimeoutMs,
    },
  );
  return withOpencodeDefault(assertOpencodeCatalogSize(models));
}

function opencodeConnectionLabel(sourceLabel: string, baseUrl: string | undefined): string {
  return baseUrl === undefined ? sourceLabel : compatibleEndpointHost(baseUrl);
}

/* ------------------------------------------------------------------- turn */

/** Every Opensteer tool id as OpenCode will flatten it, for the permission table. */
export function opencodeOpensteerToolIds(
  capabilityProfileId: Parameters<typeof toolsForCapabilityProfile>[0],
): readonly string[] {
  return [
    ...toolsForCapabilityProfile(capabilityProfileId).map(
      ({ name }) => `${opencodeAgentToolsServer}_${name}`,
    ),
    ...integrationGatewayToolNames.map((name) => `${opencodeIntegrationToolsServer}_${name}`),
  ];
}

const opencodeCurrentRunHeading = "## This Run's computers";

/**
 * What must be in front of the model on this Run's turn whatever the
 * conversation's age. The v1 prompt body's `system` field is the only per-turn
 * channel OpenCode has — v2's prompt has no `system` at all — and it was
 * verified live to reach the model and to be echoed back on the user message.
 */
export function opencodeRunSystemPrompt(
  context: Pick<HarnessSessionContext, "machineAccessNotice">,
): string {
  return `${opencodeCurrentRunHeading}\n${context.machineAccessNotice}`;
}

function harnessModelId(selection: ModelSelection): string {
  return selection.nativeModelId ?? selection.modelId;
}

/**
 * OpenCode fits prompt images to 2000×2000 and 5 MiB of base64 itself, with a
 * WebAssembly decoder whose memory bounds full-resolution photos. An image
 * already inside those limits goes by path, which also names the file to the
 * model; any other goes as a fitted copy. A delivery's images share a budget
 * that leaves room in a 32 MiB provider request.
 */
const opencodeNativeImageLimits = {
  maxEdge: 2_000,
  mediaTypes: attachmentNativeImageMediaTypes,
} as const;
const opencodeImageMaxBase64 = 5 * 1_024 * 1_024;
const opencodeDeliveryImageMaxBase64 = 24 * 1_024 * 1_024;

async function inputsToOpencodeParts(
  inputs: readonly HarnessInput[],
  turn: Pick<HarnessRunInput, "context" | "reports">,
  attachments?: ReadonlyMap<string, ResolvedAttachment>,
): Promise<Record<string, unknown>[]> {
  if (inputs.length === 0) {
    throw new OpensteerError({
      code: "bad_request",
      message: "OpenCode turn inputs cannot be empty",
    });
  }
  const reportPrompt = harnessTurnPreamble(turn, (input) => opencodeInputBody(input, attachments));
  const limits = {
    ...opencodeNativeImageLimits,
    maxBytes: nativeImageBase64Budget({
      count: inputs.reduce(
        (count, input) => count + resolvedInputParts(input, attachments).images.length,
        0,
      ),
      perImage: opencodeImageMaxBase64,
      total: opencodeDeliveryImageMaxBase64,
    }),
  };
  const parts: Record<string, unknown>[] = reportPrompt
    ? [{ text: reportPrompt, type: "text" }]
    : [];
  for (const input of inputs) {
    for (const part of resolvedInputSequence(input, attachments)) {
      if (part.type === "text") {
        parts.push({ text: part.text, type: "text" });
        continue;
      }
      const { attachment, path } = part.attachment;
      if (!(await nativeImageNeedsPreparation(part.attachment, limits))) {
        parts.push({
          filename: attachment.name,
          mime: attachment.mediaType,
          type: "file",
          url: pathToFileURL(path).href,
        });
        continue;
      }
      const prepared = await prepareNativeImage(part.attachment, limits);
      parts.push({
        filename: attachment.name,
        mime: prepared.mediaType,
        type: "file",
        url: `data:${prepared.mediaType};base64,${prepared.bytes.toString("base64")}`,
      });
    }
  }
  return parts;
}

function opencodeInputBody(
  input: HarnessInput,
  attachments?: ReadonlyMap<string, ResolvedAttachment>,
): string {
  const projected = resolvedInputParts(input, attachments);
  if (projected.images.length > 0)
    throw new OpensteerError({
      code: "bad_request",
      message: "OpenCode report context cannot contain image input",
    });
  return projected.body;
}

/**
 * How a permission ask reads. `metadata` carries `{command}` for bash and
 * `{filepath, diff}` for an edit or a write, both observed live; anything else
 * is a generic approval named by the permission key OpenCode asked under.
 */
function opencodeApprovalDescriptor(request: z.infer<typeof OpencodePermissionRequestSchema>): {
  readonly detail: string;
  readonly risk: "high" | "medium";
  readonly title: string;
} {
  const metadata = request.metadata;
  const command = typeof metadata.command === "string" ? metadata.command : undefined;
  if (request.permission === "bash" && command) {
    return { detail: command, risk: "medium", title: "Approve command" };
  }
  const diff = typeof metadata.diff === "string" ? metadata.diff : undefined;
  const filepath = typeof metadata.filepath === "string" ? metadata.filepath : undefined;
  if (diff || filepath) {
    return {
      detail: diff ? `${filepath ?? ""}\n\n${diff}`.trim() : `Allow changes to ${filepath ?? ""}`,
      risk: "medium",
      title: "Approve file changes",
    };
  }
  return {
    detail:
      request.patterns.length > 0
        ? `${request.permission}: ${request.patterns.join(", ")}`
        : `Allow ${request.permission}`,
    risk: request.permission === "external_directory" ? "high" : "medium",
    title: `Approve ${request.permission}`,
  };
}

function validateQuestionAnswers(
  questionIds: readonly string[],
  answers: Record<string, readonly string[]>,
): void {
  for (const id of questionIds) {
    if (!(id in answers)) {
      throw new OpensteerError({
        code: "bad_request",
        message: `Missing answer for OpenCode question ${id}`,
      });
    }
  }
  for (const id of Object.keys(answers)) {
    if (!questionIds.includes(id)) {
      throw new OpensteerError({
        code: "bad_request",
        message: `Unexpected answer for OpenCode question ${id}`,
      });
    }
  }
}

function invalidOpencodeRequestResponse(): OpensteerError {
  return new OpensteerError({
    code: "bad_request",
    message: "Response does not match the pending OpenCode Request",
  });
}

function toCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** What a subagent returned: the text inside its `task` output's `<task_result>`. */
function opencodeTaskResult(output: string | undefined): string | null {
  if (!output) return null;
  const match = /<task_result>([\s\S]*?)<\/task_result>/u.exec(output);
  return (match?.[1] ?? output).trim() || null;
}

/**
 * One `step-finish` part's own `tokens` and `cost`. OpenCode computes `cost`
 * itself from its model catalogue's prices rather than reading it back from
 * the provider's billing, which is the same kind of number Claude's
 * `total_cost_usd` is. Its `output` leaves out the step's `reasoning`, which
 * Opensteer's output includes.
 */
function addOpencodeStep(usage: OpencodeUsage, part: OpencodePart): void {
  const tokens = part.tokens;
  if (!tokens) return;
  usage.steps += 1;
  usage.inputTokens += toCount(tokens.input);
  usage.outputTokens += toCount(tokens.output) + toCount(tokens.reasoning);
  usage.reasoningTokens += toCount(tokens.reasoning);
  usage.cachedInputTokens += toCount(tokens.cache?.read);
  usage.cacheWriteTokens += toCount(tokens.cache?.write);
  if (typeof part.cost === "number" && Number.isFinite(part.cost) && part.cost > 0) {
    usage.costUsd += part.cost;
  }
}

function opencodeRunUsage(totals: OpencodeActiveTurn["usage"]): RunUsage | undefined {
  const parsed = RunUsageSchema.safeParse({
    cacheWriteTokens: Math.round(totals.cacheWriteTokens),
    cachedInputTokens: Math.round(totals.cachedInputTokens),
    ...(totals.costUsd > 0 ? { costUsd: totals.costUsd } : {}),
    inputTokens: Math.round(totals.inputTokens),
    outputTokens: Math.round(totals.outputTokens),
    reasoningTokens: Math.round(totals.reasoningTokens),
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * OpenCode reports an exhausted plan as the upstream provider's own HTTP
 * status: it retries five times and then puts an `APIError` with
 * `statusCode: 429` on `session.error` and on the assistant message (verified
 * live against an endpoint answering 429). There is no dedicated rate-limit
 * error type to key on.
 */
function opencodeFailure(error: OpencodeErrorPayload): OpensteerError {
  const status = typeof error.data.statusCode === "number" ? error.data.statusCode : undefined;
  const message = error.data.message?.trim() || `OpenCode reported ${error.name}`;
  if (error.name === "ProviderAuthError" || status === 401 || status === 403) {
    return new OpensteerError({
      code: "harness_error",
      details: { opencodeError: error.name, opencodeStatusCode: status ?? null },
      message: `${message} — sign this OpenCode account in again`,
    });
  }
  return new OpensteerError({
    code: "harness_error",
    details: { opencodeError: error.name, opencodeStatusCode: status ?? null },
    message,
    retryable: error.data.isRetryable === true,
  });
}

function opencodeFailureCode(error: OpensteerError): string {
  if (error.details?.opencodeStatusCode === 429) return harnessUsageLimitFailureCode;
  const name = error.details?.opencodeError;
  if (typeof name === "string" && name) return `opencode_${name}`;
  return error.code === "harness_error" ? "opencode_harness_error" : error.code;
}

function truncateReasoning(text: string): string {
  return text.length > 250_000 ? `${text.slice(0, 250_000)}…` : text;
}

function validateProviderReference(reference: string): string {
  const value = reference.trim();
  if (!value || value.length > 2_048 || /[\r\n]/u.test(value)) {
    throw new OpensteerError({
      code: "bad_request",
      message: "Invalid OpenCode provider session reference",
    });
  }
  return value;
}
