import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import {
  bodyPayloadFromUtf8,
  createBodyPayload,
  matchesNetworkRecordFilters,
  type BrowserCoreEngine,
  isBrowserCoreError,
  type BodyPayload as BrowserBodyPayload,
  type DocumentEpoch,
  type DocumentRef,
  type FrameRef,
  type NetworkRecord as BrowserNetworkRecord,
  type PageRef,
  type SessionRef,
} from "@opensteer/browser-core";
import {
  OPENSTEER_PROTOCOL_VERSION,
  OpensteerProtocolError,
  assertValidSemanticOperationInput,
  createNetworkRequestId,
  createSessionRef,
  opensteerSemanticOperationNames,
  opensteerSemanticOperationSpecificationMap,
  type OpensteerArtifactReadInput,
  type OpensteerArtifactReadOutput,
  type CaptchaDetectionResult,
  type CookieRecord,
  type JsonValue,
  type OpensteerCaptchaSolveInput,
  type OpensteerCaptchaSolveOutput,
  type OpensteerActionResult,
  type OpensteerAddInitScriptInput,
  type OpensteerAddInitScriptOutput,
  type OpensteerGetRecipeInput,
  type OpensteerAuthRecipeRetryOverrides,
  type OpensteerAuthRecipeStep,
  type OpensteerBrowserOptions,
  type OpensteerBrowserContextOptions,
  type OpensteerBrowserLaunchOptions,
  type OpensteerComputerExecuteInput,
  type OpensteerComputerExecuteOutput,
  type OpensteerCaptureScriptsInput,
  type OpensteerCaptureScriptsOutput,
  type OpensteerDomClickInput,
  type OpensteerDomExtractInput,
  type OpensteerDomExtractOutput,
  type OpensteerDomHoverInput,
  type OpensteerDomInputInput,
  type OpensteerDomScrollInput,
  type OpensteerError,
  type OpensteerGetAuthRecipeInput,
  type OpensteerGetRequestPlanInput,
  type OpensteerInferRequestPlanInput,
  type OpensteerListRecipesInput,
  type OpensteerListRecipesOutput,
  type OpensteerListAuthRecipesInput,
  type OpensteerListAuthRecipesOutput,
  type OpensteerNetworkClearInput,
  type OpensteerNetworkClearOutput,
  type OpensteerNetworkDiffInput,
  type OpensteerNetworkDiffOutput,
  type OpensteerNetworkMinimizeInput,
  type OpensteerNetworkMinimizeOutput,
  type OpensteerNetworkQueryInput,
  type OpensteerNetworkQueryOutput,
  type OpensteerNetworkTagInput,
  type OpensteerNetworkTagOutput,
  type OpensteerPageActivateInput,
  type OpensteerPageActivateOutput,
  type OpensteerPageCloseInput,
  type OpensteerPageCloseOutput,
  type OpensteerPageEvaluateInput,
  type OpensteerPageEvaluateOutput,
  type OpensteerPageGotoInput,
  type OpensteerPageGotoOutput,
  type OpensteerPageListInput,
  type OpensteerPageListOutput,
  type OpensteerPageNewInput,
  type OpensteerPageNewOutput,
  type OpensteerPageSnapshotInput,
  type OpensteerPageSnapshotOutput,
  type OpensteerListRequestPlansInput,
  type OpensteerListRequestPlansOutput,
  type OpensteerRawRequestInput,
  type OpensteerRawRequestOutput,
  type OpensteerRequestFailurePolicy,
  type OpensteerRequestExecuteInput,
  type OpensteerRequestExecuteOutput,
  type OpensteerRunRecipeInput,
  type OpensteerRunRecipeOutput,
  type OpensteerRequestTransportResult,
  type OpensteerRequestResponseResult,
  type OpensteerRunAuthRecipeInput,
  type OpensteerRunAuthRecipeOutput,
  type NetworkQueryRecord,
  type OpensteerOpenInput,
  type OpensteerOpenOutput,
  type OpensteerResolvedTarget,
  type OpensteerSemanticOperationName,
  type OpensteerSessionInfo,
  type OpensteerSessionCloseOutput,
  type OpensteerScriptBeautifyInput,
  type OpensteerScriptBeautifyOutput,
  type OpensteerScriptDeobfuscateInput,
  type OpensteerScriptDeobfuscateOutput,
  type OpensteerScriptSandboxInput,
  type OpensteerScriptSandboxOutput,
  type OpensteerSnapshotMode,
  type OpensteerTargetInput,
  type OpensteerTransportProbeInput,
  type OpensteerTransportProbeOutput,
  type OpensteerInteractionCaptureInput,
  type OpensteerInteractionCaptureOutput,
  type OpensteerInteractionCaptureStep,
  type OpensteerInteractionDiffInput,
  type OpensteerInteractionDiffOutput,
  type OpensteerInteractionGetInput,
  type OpensteerInteractionGetOutput,
  type OpensteerInteractionReplayInput,
  type OpensteerInteractionReplayOutput,
  type OpensteerObservationCluster,
  type OpensteerReverseAdvisoryTemplate,
  type OpensteerReverseCandidateRecord,
  type OpensteerExecutableResolver,
  type OpensteerReverseExperimentRecord,
  type OpensteerReverseDiscoverInput,
  type OpensteerReverseDiscoverOutput,
  type OpensteerReverseExportInput,
  type OpensteerReverseExportOutput,
  type OpensteerReverseGuardRecord,
  type OpensteerReverseManualCalibrationMode,
  type OpensteerReverseObservationRecord,
  type OpensteerReverseObservedRecord,
  type OpensteerReverseQueryFilters,
  type OpensteerReverseQueryInput,
  type OpensteerReverseQueryOutput,
  type OpensteerReverseSortKey,
  type OpensteerReverseQuerySort,
  type OpensteerReverseQuerySnapshot,
  type OpensteerReverseQueryView,
  type OpensteerReversePackageCreateInput,
  type OpensteerReversePackageCreateOutput,
  type OpensteerReversePackageGetInput,
  type OpensteerReversePackageGetOutput,
  type OpensteerReversePackageKind,
  type OpensteerReversePackageListInput,
  type OpensteerReversePackageListOutput,
  type OpensteerReversePackagePatchInput,
  type OpensteerReversePackagePatchOutput,
  type OpensteerReversePackageReadiness,
  type OpensteerReverseReplayRunRecord,
  type OpensteerReversePackageRunInput,
  type OpensteerReversePackageRunOutput,
  type OpensteerReverseReportInput,
  type OpensteerReverseReportOutput,
  type OpensteerReverseReportKind,
  type OpensteerReverseRequirement,
  type OpensteerReverseSuggestedEdit,
  type OpensteerReverseTargetHints,
  type OpensteerReverseWorkflowStep,
  type OpensteerStateDelta,
  type OpensteerStateSnapshot,
  type OpensteerStateSourceKind,
  type OpensteerValueReference,
  type OpensteerValueTemplate,
  type OpensteerValidationRule,
  type OpensteerEvent,
  type AppendObservationEventInput,
  type ObservationSink,
  type ObservationContext,
  type ObservabilityConfig,
  type SessionObservationSink,
  type OpensteerWriteRecipeInput,
  type StorageSnapshot,
  type TraceContext,
  type TransportKind,
  type OpensteerWriteAuthRecipeInput,
  type OpensteerWriteRequestPlanInput,
  type HeaderEntry,
  type ScriptSourceArtifactData,
} from "@opensteer/protocol";

import { manifestToExternalBinaryLocation, type ArtifactManifest } from "../artifacts.js";
import {
  takeActionBoundaryDiagnostics,
  type ActionBoundaryDiagnostics,
} from "../action-boundary.js";
import { normalizeThrownOpensteerError } from "../internal/errors.js";
import { sha256Hex } from "../internal/filesystem.js";
import { canonicalJsonString, toCanonicalJsonValue } from "../json.js";
import { normalizeObservationContext } from "../observation-utils.js";
import { normalizeObservabilityConfig } from "../observations.js";
import {
  delayWithSignal,
  defaultPolicy,
  runWithPolicyTimeout,
  settleWithPolicy,
  type OpensteerPolicy,
  type TimeoutExecutionContext,
} from "../policy/index.js";
import { createFilesystemOpensteerWorkspace, type FilesystemOpensteerWorkspace } from "../root.js";
import { OPENSTEER_RUNTIME_CORE_VERSION } from "../version.js";
import {
  buildPathSelectorHint,
  createDomRuntime,
  sanitizeElementPath,
  type DomActionOutcome,
  type DomDescriptorStore,
  type DomRuntime,
  type DomTargetRef,
  type ResolvedDomTarget,
} from "../runtimes/dom/index.js";
import {
  createComputerUseRuntime,
  type ComputerUseRuntime,
  type ComputerUseRuntimeOutput,
} from "../runtimes/computer-use/index.js";
import type {
  OpensteerInterceptScriptOptions,
  OpensteerRouteOptions,
  OpensteerRouteRegistration,
} from "./instrumentation.js";
import { dispatchSemanticOperation } from "./semantic-dispatch.js";
import { inferRequestPlanFromNetworkRecord } from "../requests/inference.js";
import { normalizeRequestPlanPayload } from "../requests/plans/index.js";
import {
  filterValidHttpHeaders,
  headerValue,
  parseStructuredResponseData,
  toProtocolBodyPayload,
  toProtocolRequestResponseResult,
  toProtocolRequestTransportResult,
} from "../requests/shared.js";
import {
  finalizeMaterializedTransportRequest,
  stripManagedRequestHeaders,
} from "../reverse/materialization.js";
import { diffNetworkRecords } from "../network/diff.js";
import { NetworkHistory } from "../network/history.js";
import type { SavedNetworkQueryInput } from "../network/saved-store.js";
import {
  materializePreparedMinimizationRequest,
  minimizePreparedRequest,
  prepareMinimizationRequest,
  type PreparedMinimizationRequest,
} from "../network/minimize.js";
import { TRANSPORT_PROBE_LADDER, selectTransportProbeRecommendation } from "../network/probe.js";
import {
  analyzeReverseCandidate,
  buildChannelDescriptor,
  compareReverseAnalysisResults,
  describeReverseBodyCodec,
  matchReverseTargetHints,
} from "../reverse/analysis.js";
import { clusterReverseObservationRecords } from "../reverse/discovery.js";
import { executeMatchedTlsTransportRequest as executeMatchedTlsTransportRequestWithCurl } from "../requests/execution/matched-tls/index.js";
import {
  evaluateValidationRulesForEventStreamReplay,
  evaluateValidationRulesForHttpResponse,
  evaluateValidationRulesForObservedRecord,
  evaluateValidationRulesForWebSocketReplay,
  buildReverseValidationRules,
} from "../reverse/validation.js";
import {
  buildReversePackageRequirements,
  buildReversePackageWorkflow,
  buildReversePackageSuggestedEdits,
  cloneReversePackageResolvers,
  deriveReversePackageKind,
  deriveReversePackageReadiness,
  deriveReversePackageUnresolvedRequirements,
} from "../reverse/workflows.js";
import {
  assertValidOpensteerExtractionSchemaRoot,
  compileOpensteerExtractionFieldTargets,
  compilePersistedOpensteerExtractionPayloadFromFieldTargets,
  createOpensteerExtractionDescriptorStore,
  extractOpensteerExtractionFieldTargets,
  replayOpensteerExtractionPayload,
  type OpensteerExtractionDescriptorStore,
  type OpensteerExtractionDescriptorRecord,
} from "./extraction.js";
import { inflateDataPathObject } from "./extraction-data-path.js";
import { compileOpensteerSnapshot } from "./snapshot/compiler.js";
import type {
  AuthRecipeRecord,
  AuthRecipeRegistryStore,
  InteractionTraceRecord,
  RecipeRecord,
  RecipeRegistryStore,
  RequestPlanRecord,
  RequestPlanRegistryStore,
  ReverseCaseRecord,
  ReverseCaseRegistryStore,
  ReversePackageRecord,
  ReversePackageRegistryStore,
  ReverseReportRecord,
} from "../registry.js";
import { beautifyScriptContent } from "../scripts/beautify.js";
import { deobfuscateScriptContent } from "../scripts/deobfuscate.js";
import { runScriptSandbox } from "../scripts/sandbox.js";
import { createCapSolver } from "../captcha/solver-capsolver.js";
import { createTwoCaptchaSolver } from "../captcha/solver-2captcha.js";
import { detectCaptchaOnPage } from "../captcha/detect.js";
import { injectCaptchaToken } from "../captcha/inject.js";
import { diffInteractionTraces } from "../interaction/diff.js";

type DisposableBrowserCoreEngine = BrowserCoreEngine & {
  dispose?: () => Promise<void>;
};

type RecipeRegistryKind = "recipe" | "auth-recipe";

interface ResolvedRecipeBinding {
  readonly source: RecipeRegistryKind;
  readonly recipe: {
    readonly key: string;
    readonly version?: string;
  };
  readonly cachePolicy?: "none" | "untilFailure";
}

const requireForAuthRecipeHook = createRequire(import.meta.url);

export interface OpensteerEngineFactoryOptions {
  readonly browser?: OpensteerBrowserOptions;
  readonly launch?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
}

export type OpensteerEngineFactory = (
  options: OpensteerEngineFactoryOptions,
) => Promise<BrowserCoreEngine>;

export type OpensteerRuntimeWorkspace = FilesystemOpensteerWorkspace;

export interface OpensteerSessionRuntimeOptions {
  readonly name: string;
  readonly workspace?: OpensteerRuntimeWorkspace;
  readonly workspaceName?: string;
  readonly rootPath?: string;
  readonly engine?: BrowserCoreEngine;
  readonly engineFactory?: OpensteerEngineFactory;
  readonly policy?: OpensteerPolicy;
  readonly descriptorStore?: DomDescriptorStore;
  readonly extractionDescriptorStore?: OpensteerExtractionDescriptorStore;
  readonly registryOverrides?: {
    readonly requestPlans?: RequestPlanRegistryStore;
    readonly authRecipes?: AuthRecipeRegistryStore;
    readonly recipes?: RecipeRegistryStore;
    readonly reverseCases?: ReverseCaseRegistryStore;
    readonly reversePackages?: ReversePackageRegistryStore;
  };
  readonly cleanupRootOnClose?: boolean;
  readonly sessionInfo?: Partial<Omit<OpensteerSessionInfo, "sessionId" | "activePageRef">>;
  readonly observability?: Partial<ObservabilityConfig>;
  readonly observationSessionId?: string;
  readonly observationSink?: ObservationSink;
}

interface OpensteerTraceArtifacts {
  readonly manifests: readonly ArtifactManifest[];
}

interface PersistedComputerArtifacts {
  readonly manifests: readonly ArtifactManifest[];
  readonly output: OpensteerComputerExecuteOutput;
}

interface InternalReverseCaptureInput {
  readonly caseId?: string;
  readonly key?: string;
  readonly objective?: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
  readonly pageRef?: PageRef;
  readonly stateSource?: OpensteerStateSourceKind;
  readonly network?: {
    readonly url?: string;
    readonly hostname?: string;
    readonly path?: string;
    readonly method?: string;
    readonly resourceType?: string;
    readonly includeBodies?: boolean;
  };
  readonly includeScripts?: boolean;
  readonly includeStorage?: boolean;
  readonly includeSessionStorage?: boolean;
  readonly includeIndexedDb?: boolean;
  readonly interactionTraceIds?: readonly string[];
  readonly captureWindowMs?: number;
}

interface InternalReverseCaptureOutput {
  readonly case: ReverseCaseRecord;
  readonly observation: OpensteerReverseObservationRecord;
}

interface InternalReverseAnalyzeInput {
  readonly caseId: string;
  readonly observationId?: string;
  readonly targetHints?: OpensteerReverseTargetHints;
}

interface InternalReverseAnalyzeOutput {
  readonly case: ReverseCaseRecord;
  readonly analyzedObservationIds: readonly string[];
  readonly candidateCount: number;
}

interface ReverseQueryExecutionInput {
  readonly caseRecord: ReverseCaseRecord;
  readonly view: OpensteerReverseQueryView;
  readonly filters?: OpensteerReverseQueryFilters;
  readonly sort?: OpensteerReverseQuerySort;
  readonly limit?: number;
  readonly cursor?: string;
}

interface ReverseQueryExecutionResult {
  readonly query: OpensteerReverseQuerySnapshot;
  readonly output: OpensteerReverseQueryOutput;
}

interface ReversePackageWriteInput {
  readonly caseRecord: ReverseCaseRecord;
  readonly source: OpensteerReversePackageCreateInput["source"];
  readonly sourceRecordId: string;
  readonly candidate?: OpensteerReverseCandidateRecord;
  readonly template?: OpensteerReverseAdvisoryTemplate;
  readonly kind: OpensteerReversePackageKind;
  readonly readiness: OpensteerReversePackageReadiness;
  readonly validators: readonly OpensteerValidationRule[];
  readonly workflow: readonly OpensteerReverseWorkflowStep[];
  readonly resolvers: readonly OpensteerExecutableResolver[];
  readonly unresolvedRequirements: readonly OpensteerReverseRequirement[];
  readonly suggestedEdits: readonly OpensteerReverseSuggestedEdit[];
  readonly attachedTraceIds: readonly string[];
  readonly attachedArtifactIds: readonly string[];
  readonly attachedRecordIds: readonly string[];
  readonly stateSnapshots: readonly OpensteerStateSnapshot[];
  readonly requestPlan?: RequestPlanRecord;
  readonly notes?: string;
  readonly parentPackageId?: string;
  readonly manualCalibration?: OpensteerReverseManualCalibrationMode;
  readonly key?: string;
  readonly version?: string;
  readonly provenanceSource:
    | "reverse.discover"
    | "reverse.package.create"
    | "reverse.export"
    | "reverse.package.patch";
}

interface OpensteerSessionTraceInput {
  readonly operation: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly outcome: "ok" | "error";
  readonly events?: readonly OpensteerEvent[];
  readonly data?: unknown;
  readonly error?: unknown;
  readonly artifacts?: OpensteerTraceArtifacts;
  readonly context?: TraceContext;
}

interface PendingOperationEventCapture {
  readonly operation: OpensteerSemanticOperationName;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly events: readonly OpensteerEvent[];
}

interface RuntimeOperationOptions {
  readonly signal?: AbortSignal;
}

interface RuntimeBrowserBinding {
  readonly sessionRef: SessionRef;
  readonly pageRef: PageRef;
}

interface MutationCapturePlan {
  readonly baselineRequestIds: ReadonlySet<string>;
  readonly capture: string;
}

interface MutationCaptureFinalizeDiagnostics {
  readonly finalizeError?: OpensteerError;
}

const MUTATION_CAPTURE_FINALIZE_TIMEOUT_MS = 5_000;
const PERSISTED_NETWORK_FLUSH_TIMEOUT_MS = 5_000;
const PENDING_OPERATION_EVENT_CAPTURE_LIMIT = 64;
const PENDING_OPERATION_EVENT_CAPTURE_SKEW_MS = 1_000;

interface CookieJarEntry {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly expiresAt?: number;
}

interface ScriptTransformSource {
  readonly content: string;
  readonly artifactId?: string;
  readonly data?: ScriptSourceArtifactData;
  readonly scope?: ArtifactManifest["scope"];
}

export class OpensteerSessionRuntime {
  readonly workspace: string;
  readonly rootPath: string;

  private readonly workspaceName: string | undefined;
  private readonly injectedEngine: BrowserCoreEngine | undefined;
  private readonly engineFactory: OpensteerEngineFactory | undefined;
  private readonly policy: OpensteerPolicy;
  private readonly injectedDescriptorStore: DomDescriptorStore | undefined;
  private readonly injectedExtractionDescriptorStore:
    | OpensteerExtractionDescriptorStore
    | undefined;
  private readonly registryOverrides: OpensteerSessionRuntimeOptions["registryOverrides"];
  private readonly cleanupRootOnClose: boolean;
  private readonly sessionInfoBase: Partial<
    Omit<OpensteerSessionInfo, "sessionId" | "activePageRef">
  >;
  private observationConfig: ObservabilityConfig;
  private readonly observationSessionId: string | undefined;
  private readonly injectedObservationSink: ObservationSink | undefined;

  private root: OpensteerRuntimeWorkspace | undefined;
  private engine: DisposableBrowserCoreEngine | undefined;
  private dom: DomRuntime | undefined;
  private computer: ComputerUseRuntime | undefined;
  private readonly networkHistory = new NetworkHistory();
  private extractionDescriptors: OpensteerExtractionDescriptorStore | undefined;
  private sessionRef: SessionRef | undefined;
  private pageRef: PageRef | undefined;
  private runId: string | undefined;
  private observations: SessionObservationSink | undefined;
  private readonly operationEventStorage = new AsyncLocalStorage<OpensteerEvent[]>();
  private readonly pendingOperationEventCaptures: PendingOperationEventCapture[] = [];
  private readonly cookieJars = new Map<string, CookieJarEntry[]>();
  private readonly recipeCache = new Map<string, OpensteerRunRecipeOutput>();
  private ownsEngine = false;

  constructor(options: OpensteerSessionRuntimeOptions) {
    this.workspace = normalizeNamespace(options.name);
    this.workspaceName =
      options.workspaceName?.trim() === undefined || options.workspaceName?.trim().length === 0
        ? undefined
        : options.workspaceName.trim();
    this.root = options.workspace;
    this.rootPath =
      options.workspace?.rootPath ??
      options.rootPath ??
      path.resolve(process.cwd(), ".opensteer", "temporary", randomUUID());
    this.injectedEngine = options.engine;
    this.engineFactory = options.engineFactory;
    this.policy = options.policy ?? defaultPolicy();
    this.injectedDescriptorStore = options.descriptorStore;
    this.injectedExtractionDescriptorStore = options.extractionDescriptorStore;
    this.registryOverrides = options.registryOverrides;
    this.cleanupRootOnClose = options.cleanupRootOnClose ?? options.workspace === undefined;
    this.sessionInfoBase = options.sessionInfo ?? {};
    this.observationConfig = normalizeObservabilityConfig(options.observability);
    this.observationSessionId = options.observationSessionId;
    this.injectedObservationSink = options.observationSink;

    if (this.injectedEngine === undefined && this.engineFactory === undefined) {
      throw new Error("OpensteerSessionRuntime requires an engine or engineFactory.");
    }
  }

  async info(): Promise<OpensteerSessionInfo> {
    const base = this.sessionInfoBase;
    return {
      provider: base.provider ?? {
        mode: "local",
        ownership: "owned",
        engine: "playwright",
      },
      ...(base.workspace === undefined ? {} : { workspace: base.workspace }),
      ...(this.sessionRef === undefined ? {} : { sessionId: this.sessionRef }),
      ...(this.pageRef === undefined ? {} : { activePageRef: this.pageRef }),
      reconnectable: base.reconnectable ?? !this.cleanupRootOnClose,
      capabilities: base.capabilities ?? {
        semanticOperations: opensteerSemanticOperationNames,
        instrumentation: {
          route: true,
          interceptScript: true,
          networkStream: false,
        },
      },
      ...(base.grants === undefined ? {} : { grants: base.grants }),
      runtime: base.runtime ?? {
        protocolVersion: OPENSTEER_PROTOCOL_VERSION,
        runtimeCoreVersion: OPENSTEER_RUNTIME_CORE_VERSION,
      },
    };
  }

  async setObservabilityConfig(
    input: Partial<ObservabilityConfig> | undefined,
  ): Promise<ObservabilityConfig> {
    this.observationConfig = normalizeObservabilityConfig(input);
    const observationSessionId = this.resolveObservationSessionId();
    if (observationSessionId === undefined) {
      return this.observationConfig;
    }

    const sink = this.injectedObservationSink ?? (await this.ensureRoot()).observations;
    this.observations = await sink.openSession({
      sessionId: observationSessionId,
      openedAt: Date.now(),
      config: this.observationConfig,
    });
    return this.observationConfig;
  }

  async open(
    input: OpensteerOpenInput = {},
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerOpenOutput> {
    assertValidSemanticOperationInput("session.open", input);

    if (input.workspace !== undefined && normalizeNamespace(input.workspace) !== this.workspace) {
      throw new Error(
        `session.open requested workspace "${input.workspace}" but runtime is bound to "${this.workspace}"`,
      );
    }

    if ((await this.ensureLiveRuntimeBinding()) === "live") {
      if (input.url !== undefined) {
        return this.goto(
          {
            url: input.url,
          },
          options,
        );
      }
      return this.readSessionState();
    }

    const startedAt = Date.now();
    const root = await this.ensureRoot();
    const engine = await this.ensureEngine({
      ...(input.browser === undefined ? {} : { browser: input.browser }),
      ...(input.launch === undefined ? {} : { launch: input.launch }),
      ...(input.context === undefined ? {} : { context: input.context }),
    });
    const run = await root.traces.createRun();
    this.runId = run.runId;
    let openedSessionRef: SessionRef | undefined;
    let openedPageRef: PageRef | undefined;

    try {
      const { state, frameRef } = await this.runWithOperationTimeout(
        "session.open",
        async (timeout) => {
          const sessionRef = await timeout.runStep(() => engine.createSession());
          openedSessionRef = sessionRef;
          const createdPage = await timeout.runStep(() =>
            engine.createPage({
              sessionRef,
            }),
          );
          openedPageRef = createdPage.data.pageRef;

          timeout.throwIfAborted();
          this.sessionRef = sessionRef;
          this.pageRef = createdPage.data.pageRef;
          await timeout.runStep(() => this.ensureSemantics());

          let frameRef = createdPage.frameRef;
          if (input.url !== undefined) {
            const navigation = await this.navigatePage(
              {
                operation: "session.open",
                pageRef: createdPage.data.pageRef,
                url: input.url,
              },
              timeout,
            );
            frameRef = navigation.data.mainFrame.frameRef;
          }

          return {
            state: await timeout.runStep(() => this.readSessionState()),
            frameRef,
          };
        },
        options,
      );
      await this.appendTrace({
        operation: "session.open",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: state,
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
          ...(frameRef === undefined ? {} : { frameRef }),
        }),
      });
      return state;
    } catch (error) {
      await this.appendTrace({
        operation: "session.open",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      await this.cleanupSessionResources(engine, openedPageRef, openedSessionRef);
      await this.resetRuntimeState({
        disposeEngine: true,
      });
      throw error;
    }
  }

  async listPages(
    input: OpensteerPageListInput = {},
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerPageListOutput> {
    assertValidSemanticOperationInput("page.list", input);

    if ((await this.ensureLiveRuntimeBinding()) === "unbound") {
      return { pages: [] };
    }

    const startedAt = Date.now();
    const context = buildRuntimeTraceContext({
      sessionRef: this.sessionRef,
      pageRef: this.pageRef,
    });
    try {
      const output = await this.runWithOperationTimeout(
        "page.list",
        async (timeout) => {
          const pages = await timeout.runStep(() =>
            this.requireEngine().listPages({ sessionRef: this.requireSessionRef() }),
          );
          return {
            ...(this.pageRef === undefined ? {} : { activePageRef: this.pageRef }),
            pages,
          } satisfies OpensteerPageListOutput;
        },
        options,
      );
      const events = await this.drainPendingEngineEvents(context);

      await this.appendTrace({
        operation: "page.list",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        ...(events === undefined ? {} : { events }),
        data: {
          count: output.pages.length,
          ...(output.activePageRef === undefined ? {} : { activePageRef: output.activePageRef }),
        },
        context,
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "page.list",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        context,
      });
      throw error;
    }
  }

  async newPage(
    input: OpensteerPageNewInput = {},
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerPageNewOutput> {
    assertValidSemanticOperationInput("page.new", input);

    if ((await this.ensureLiveRuntimeBinding()) === "unbound") {
      if (input.openerPageRef !== undefined) {
        throw new OpensteerProtocolError(
          "invalid-request",
          "page.new cannot use openerPageRef before a session exists",
        );
      }
      return this.open(input.url === undefined ? {} : { url: input.url }, options);
    }

    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "page.new",
        async (timeout) => {
          const created = await timeout.runStep(() =>
            this.requireEngine().createPage({
              sessionRef: this.requireSessionRef(),
              ...(input.openerPageRef === undefined ? {} : { openerPageRef: input.openerPageRef }),
              ...(input.url === undefined ? {} : { url: input.url }),
            }),
          );
          this.pageRef = created.data.pageRef;
          return this.readSessionState();
        },
        options,
      );

      await this.appendTrace({
        operation: "page.new",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: output,
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "page.new",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });
      throw error;
    }
  }

  async activatePage(
    input: OpensteerPageActivateInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerPageActivateOutput> {
    assertValidSemanticOperationInput("page.activate", input);
    const startedAt = Date.now();

    try {
      const output = await this.runWithOperationTimeout(
        "page.activate",
        async (timeout) => {
          await timeout.runStep(() =>
            this.requireEngine().activatePage({ pageRef: input.pageRef }),
          );
          this.pageRef = input.pageRef;
          return this.readSessionState();
        },
        options,
      );

      await this.appendTrace({
        operation: "page.activate",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: output,
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "page.activate",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });
      throw error;
    }
  }

  async closePage(
    input: OpensteerPageCloseInput = {},
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerPageCloseOutput> {
    assertValidSemanticOperationInput("page.close", input);
    const targetPageRef = input.pageRef ?? (await this.ensurePageRef());
    const startedAt = Date.now();

    try {
      const output = await this.runWithOperationTimeout(
        "page.close",
        async (timeout) => {
          await timeout.runStep(() => this.requireEngine().closePage({ pageRef: targetPageRef }));
          let pages = await timeout.runStep(() =>
            this.requireEngine().listPages({ sessionRef: this.requireSessionRef() }),
          );
          let activePageRef =
            pages.find((page) => page.pageRef === this.pageRef)?.pageRef ?? pages.at(-1)?.pageRef;

          if (pages.length === 0) {
            const created = await timeout.runStep(() =>
              this.requireEngine().createPage({
                sessionRef: this.requireSessionRef(),
              }),
            );
            activePageRef = created.data.pageRef;
            pages = await timeout.runStep(() =>
              this.requireEngine().listPages({ sessionRef: this.requireSessionRef() }),
            );
          }

          if (activePageRef !== undefined) {
            await timeout.runStep(() =>
              this.requireEngine().activatePage({
                pageRef: activePageRef,
              }),
            );
          }

          this.pageRef = activePageRef;

          return {
            closedPageRef: targetPageRef,
            ...(activePageRef === undefined ? {} : { activePageRef }),
            pages,
          } satisfies OpensteerPageCloseOutput;
        },
        options,
      );

      await this.appendTrace({
        operation: "page.close",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          closedPageRef: output.closedPageRef,
          ...(output.activePageRef === undefined ? {} : { activePageRef: output.activePageRef }),
          count: output.pages.length,
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "page.close",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });
      throw error;
    }
  }

  async goto(
    input: OpensteerPageGotoInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerPageGotoOutput> {
    assertValidSemanticOperationInput("page.goto", input);

    const pageRef = await this.ensurePageRef();
    const startedAt = Date.now();
    let mutationCaptureDiagnostics: MutationCaptureFinalizeDiagnostics | undefined;

    try {
      const { navigation, state } = await this.runMutationCapturedOperation(
        "page.goto",
        {
          ...(input.captureNetwork === undefined ? {} : { captureNetwork: input.captureNetwork }),
          options,
        },
        async (timeout) => {
          const navigation = await this.navigatePage(
            {
              operation: "page.goto",
              pageRef,
              url: input.url,
            },
            timeout,
          );
          timeout.throwIfAborted();
          return {
            navigation,
            state: await timeout.runStep(() => this.readSessionState()),
          };
        },
        (diagnostics) => {
          mutationCaptureDiagnostics = diagnostics;
        },
      );
      await this.appendTrace({
        operation: "page.goto",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          url: input.url,
          state,
          ...buildMutationCaptureTraceData(mutationCaptureDiagnostics),
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef,
          frameRef: navigation.data.mainFrame.frameRef,
        }),
      });
      return state;
    } catch (error) {
      await this.appendTrace({
        operation: "page.goto",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        data: buildMutationCaptureTraceData(mutationCaptureDiagnostics),
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef,
        }),
      });
      throw error;
    }
  }

  async evaluate(
    input: OpensteerPageEvaluateInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerPageEvaluateOutput> {
    assertValidSemanticOperationInput("page.evaluate", input);
    const pageRef = input.pageRef ?? (await this.ensurePageRef());
    const startedAt = Date.now();
    let mutationCaptureDiagnostics: MutationCaptureFinalizeDiagnostics | undefined;

    try {
      const output = await this.runMutationCapturedOperation(
        "page.evaluate",
        { options },
        async (timeout) => {
          const remainingMs = timeout.remainingMs();
          const evaluated = await timeout.runStep(() =>
            this.requireEngine().evaluatePage({
              pageRef,
              script: input.script,
              ...(input.args === undefined ? {} : { args: input.args }),
              ...(remainingMs === undefined ? {} : { timeoutMs: remainingMs }),
            }),
          );

          return {
            pageRef,
            value: toJsonValueOrNull(evaluated.data),
          } satisfies OpensteerPageEvaluateOutput;
        },
        (diagnostics) => {
          mutationCaptureDiagnostics = diagnostics;
        },
      );

      await this.appendTrace({
        operation: "page.evaluate",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          pageRef: output.pageRef,
          value: output.value,
          ...buildMutationCaptureTraceData(mutationCaptureDiagnostics),
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef,
        }),
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "page.evaluate",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        data: buildMutationCaptureTraceData(mutationCaptureDiagnostics),
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef,
        }),
      });
      throw error;
    }
  }

  async addInitScript(
    input: OpensteerAddInitScriptInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerAddInitScriptOutput> {
    assertValidSemanticOperationInput("page.add-init-script", input);
    const binding = await this.ensureBrowserTransportBinding();
    const pageRef = input.pageRef ?? binding.pageRef;
    const startedAt = Date.now();

    try {
      const output = await this.runWithOperationTimeout(
        "page.add-init-script",
        async () =>
          this.requireEngine().addInitScript({
            sessionRef: binding.sessionRef,
            ...(input.pageRef === undefined ? {} : { pageRef }),
            script: input.script,
            ...(input.args === undefined ? {} : { args: input.args }),
          }),
        options,
      );

      await this.appendTrace({
        operation: "page.add-init-script",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: output,
        context: buildRuntimeTraceContext({
          sessionRef: binding.sessionRef,
          pageRef,
        }),
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "page.add-init-script",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        context: buildRuntimeTraceContext({
          sessionRef: binding.sessionRef,
          pageRef,
        }),
      });
      throw error;
    }
  }

  async snapshot(
    input: OpensteerPageSnapshotInput = {},
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerPageSnapshotOutput> {
    assertValidSemanticOperationInput("page.snapshot", input);

    const pageRef = await this.ensurePageRef();
    const mode: OpensteerSnapshotMode = input.mode ?? "action";
    const startedAt = Date.now();

    try {
      const { artifacts, output } = await this.runWithOperationTimeout(
        "page.snapshot",
        async (timeout) => {
          await timeout.runStep(() =>
            settleWithPolicy(this.policy.settle, {
              operation: "page.snapshot",
              trigger: "snapshot",
              engine: this.requireEngine(),
              pageRef,
              signal: timeout.signal,
              remainingMs: timeout.remainingMs(),
            }),
          );
          const compiled = await timeout.runStep(() =>
            compileOpensteerSnapshot({
              engine: this.requireEngine(),
              pageRef,
              mode,
            }),
          );
          timeout.throwIfAborted();
          const artifacts = await this.captureSnapshotArtifacts(
            pageRef,
            {
              includeHtmlSnapshot: true,
            },
            timeout,
          );

          const output: OpensteerPageSnapshotOutput = {
            url: compiled.url,
            title: compiled.title,
            mode,
            html: compiled.html,
            counters: compiled.counters,
          };

          return {
            artifacts,
            output,
          };
        },
        options,
      );
      const context = buildRuntimeTraceContext({
        sessionRef: this.sessionRef,
        pageRef,
      });
      const events = await this.drainPendingEngineEvents(context);

      await this.appendTrace({
        operation: "page.snapshot",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        artifacts,
        ...(events === undefined ? {} : { events }),
        data: {
          mode,
          url: output.url,
          title: output.title,
          counterCount: output.counters.length,
        },
        context,
      });

      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "page.snapshot",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef,
        }),
      });
      throw error;
    }
  }

  async click(
    input: OpensteerDomClickInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerActionResult> {
    assertValidSemanticOperationInput("dom.click", input);

    return this.runDomAction(
      "dom.click",
      input,
      async (pageRef, target, timeout) => {
        const result = await this.requireDom().click({
          pageRef,
          target,
          timeout,
        });
        return {
          result,
        };
      },
      options,
    );
  }

  async hover(
    input: OpensteerDomHoverInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerActionResult> {
    assertValidSemanticOperationInput("dom.hover", input);

    return this.runDomAction(
      "dom.hover",
      input,
      async (pageRef, target, timeout) => {
        const result = await this.requireDom().hover({
          pageRef,
          target,
          timeout,
        });
        return {
          result,
        };
      },
      options,
    );
  }

  async input(
    input: OpensteerDomInputInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerActionResult> {
    assertValidSemanticOperationInput("dom.input", input);

    return this.runDomAction(
      "dom.input",
      input,
      async (pageRef, target, timeout) => {
        const resolved = await this.requireDom().input({
          pageRef,
          target,
          text: input.text,
          ...(input.pressEnter === undefined ? {} : { pressEnter: input.pressEnter }),
          timeout,
        });
        return {
          result: {
            resolved,
            point: undefined,
          },
        };
      },
      options,
    );
  }

  async scroll(
    input: OpensteerDomScrollInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerActionResult> {
    assertValidSemanticOperationInput("dom.scroll", input);

    return this.runDomAction(
      "dom.scroll",
      input,
      async (pageRef, target, timeout) => {
        const result = await this.requireDom().scroll({
          pageRef,
          target,
          delta: directionToDelta(input.direction, input.amount),
          timeout,
        });
        return {
          result,
        };
      },
      options,
    );
  }

  async extract(
    input: OpensteerDomExtractInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerDomExtractOutput> {
    assertValidSemanticOperationInput("dom.extract", input);

    const pageRef = await this.ensurePageRef();
    const descriptors = this.requireExtractionDescriptors();
    const startedAt = Date.now();

    try {
      const { artifacts, descriptor, output } = await this.runWithOperationTimeout(
        "dom.extract",
        async (timeout) => {
          let descriptor: OpensteerExtractionDescriptorRecord | undefined;
          let data: JsonValue;
          if (input.schema !== undefined) {
            assertValidOpensteerExtractionSchemaRoot(input.schema);
            const fieldTargets = await timeout.runStep(() =>
              compileOpensteerExtractionFieldTargets({
                pageRef,
                schema: input.schema as Record<string, unknown>,
                dom: this.requireDom(),
              }),
            );
            data = toCanonicalJsonValue(
              inflateDataPathObject(
                await timeout.runStep(() =>
                  extractOpensteerExtractionFieldTargets({
                    pageRef,
                    dom: this.requireDom(),
                    fieldTargets,
                  }),
                ),
              ),
            );
            const payload = await timeout.runStep(() =>
              compilePersistedOpensteerExtractionPayloadFromFieldTargets({
                pageRef,
                dom: this.requireDom(),
                fieldTargets,
              }),
            );
            const pageInfo = await timeout.runStep(() =>
              this.requireEngine().getPageInfo({ pageRef }),
            );
            descriptor = await timeout.runStep(() =>
              descriptors.write({
                description: input.description,
                root: payload,
                schemaHash: canonicalJsonString(input.schema),
                sourceUrl: pageInfo.url,
              }),
            );
          } else {
            const storedDescriptor = await timeout.runStep(() =>
              descriptors.read({
                description: input.description,
              }),
            );
            if (!storedDescriptor) {
              throw new OpensteerProtocolError(
                "not-found",
                `no stored extraction descriptor found for "${input.description}"`,
                {
                  details: {
                    description: input.description,
                    workspace: this.workspace,
                    kind: "extraction-descriptor",
                  },
                },
              );
            }
            descriptor = storedDescriptor;
            data = await timeout.runStep(() =>
              replayOpensteerExtractionPayload({
                pageRef,
                dom: this.requireDom(),
                payload: storedDescriptor.payload.root,
              }),
            );
          }

          const artifacts = await this.captureSnapshotArtifacts(
            pageRef,
            {
              includeHtmlSnapshot: false,
            },
            timeout,
          );
          return {
            artifacts,
            descriptor,
            output: {
              data,
            } satisfies OpensteerDomExtractOutput,
          };
        },
        options,
      );

      await this.appendTrace({
        operation: "dom.extract",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        artifacts,
        data: {
          description: input.description,
          ...(descriptor.payload.schemaHash === undefined
            ? {}
            : { schemaHash: descriptor.payload.schemaHash }),
          data: output.data,
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef,
        }),
      });

      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "dom.extract",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef,
        }),
      });
      throw error;
    }
  }

  async queryNetwork(
    input: OpensteerNetworkQueryInput = {},
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerNetworkQueryOutput> {
    assertValidSemanticOperationInput("network.query", input);

    const root = await this.ensureRoot();
    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "network.query",
        async (timeout) => {
          await this.syncPersistedNetworkSelection(timeout, input, {
            includeBodies: input.includeBodies ?? false,
          });
          return {
            records: await timeout.runStep(() =>
              root.registry.savedNetwork.query(this.toSavedNetworkQueryInput(input)),
            ),
          } satisfies OpensteerNetworkQueryOutput;
        },
        options,
      );

      await this.appendTrace({
        operation: "network.query",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          includeBodies: input.includeBodies ?? false,
          limit: input.limit ?? 50,
          count: output.records.length,
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "network.query",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });
      throw error;
    }
  }

  async tagNetwork(
    input: OpensteerNetworkTagInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerNetworkTagOutput> {
    assertValidSemanticOperationInput("network.tag", input);

    const root = await this.ensureRoot();
    const filter = this.toQueryInputFromTagInput(input);
    const savedFilter = this.toSavedNetworkQueryInput(filter);
    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "network.tag",
        async (timeout) => {
          const records = await this.syncPersistedNetworkSelection(timeout, filter, {
            includeBodies: false,
          });
          this.networkHistory.addTag(records, input.tag);
          return {
            taggedCount: await timeout.runStep(() =>
              root.registry.savedNetwork.tagByFilter(savedFilter, input.tag),
            ),
          } satisfies OpensteerNetworkTagOutput;
        },
        options,
      );

      await this.appendTrace({
        operation: "network.tag",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          tag: input.tag,
          taggedCount: output.taggedCount,
        },
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "network.tag",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async clearNetwork(
    input: OpensteerNetworkClearInput = {},
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerNetworkClearOutput> {
    assertValidSemanticOperationInput("network.clear", input);

    const root = await this.ensureRoot();
    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "network.clear",
        async (timeout) => {
          if (this.sessionRef !== undefined) {
            if (input.capture !== undefined || input.tag !== undefined) {
              const records = await this.queryLiveNetwork(
                {
                  ...(input.capture === undefined ? {} : { capture: input.capture }),
                  ...(input.tag === undefined ? {} : { tag: input.tag }),
                },
                timeout,
                {
                  ignoreLimit: true,
                },
              );
              this.networkHistory.tombstoneRequestIds(
                records.map((record) => record.record.requestId),
              );
            } else {
              const liveRequestIds = await this.readLiveRequestIds(timeout, {
                includeCurrentPageOnly: false,
              });
              this.networkHistory.tombstoneRequestIds(liveRequestIds);
            }
          }
          if (input.capture === undefined && input.tag === undefined) {
            this.networkHistory.tombstoneRequestIds(this.networkHistory.getKnownRequestIds());
          }
          return {
            clearedCount: await timeout.runStep(() => root.registry.savedNetwork.clear(input)),
          } satisfies OpensteerNetworkClearOutput;
        },
        options,
      );

      await this.appendTrace({
        operation: "network.clear",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          ...(input.capture === undefined ? {} : { capture: input.capture }),
          ...(input.tag === undefined ? {} : { tag: input.tag }),
          clearedCount: output.clearedCount,
        },
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "network.clear",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async captureScripts(
    input: OpensteerCaptureScriptsInput = {},
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerCaptureScriptsOutput> {
    assertValidSemanticOperationInput("scripts.capture", input);
    const pageRef = input.pageRef ?? (await this.ensurePageRef());
    const startedAt = Date.now();

    try {
      const output = await this.runWithOperationTimeout(
        "scripts.capture",
        async (timeout) => this.captureScriptsInternal(pageRef, input, timeout),
        options,
      );

      await this.appendTrace({
        operation: "scripts.capture",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          pageRef: output.pageRef,
          scriptCount: output.scripts.length,
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef,
        }),
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "scripts.capture",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef,
        }),
      });
      throw error;
    }
  }

  async minimizeNetwork(
    input: OpensteerNetworkMinimizeInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerNetworkMinimizeOutput> {
    assertValidSemanticOperationInput("network.minimize", input);

    const transport = normalizeTransportKind(input.transport ?? "session-http");
    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "network.minimize",
        async (timeout) => {
          const record = await this.resolveNetworkRecordByRecordId(input.recordId, timeout, {
            includeBodies: true,
            redactSecretHeaders: false,
          });
          const prepared = prepareMinimizationRequest(record, input.preserve);
          const fullKeepState = createFullMinimizationKeepState(prepared);
          const referenceRequest = materializePreparedMinimizationRequest(prepared, fullKeepState);
          const baselineResponse = await this.executeAnalysisTransportRequest(
            transport,
            referenceRequest,
            timeout,
          );
          const baselineFingerprint = buildSuccessFingerprint(baselineResponse);
          const maxTrials = Math.max(1, input.maxTrials ?? 50);
          const preserve = input.preserve;
          const analysis = await minimizePreparedRequest({
            prepared,
            ...(preserve === undefined ? {} : { preserve }),
            maxTrials: Math.max(0, maxTrials - 1),
            test: async (request) => {
              const response = await this.executeAnalysisTransportRequest(
                transport,
                request,
                timeout,
              );
              return matchesSuccessFingerprint(response, baselineFingerprint, input.successPolicy);
            },
          });

          return {
            recordId: input.recordId,
            totalTrials: analysis.totalTrials + 1,
            fields: analysis.fields,
            minimizedPlan: buildMinimizedRequestPlan({
              record,
              request: analysis.minimizedRequest,
              transport,
              kept: analysis.kept,
            }),
          } satisfies OpensteerNetworkMinimizeOutput;
        },
        options,
      );

      await this.appendTrace({
        operation: "network.minimize",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          recordId: input.recordId,
          totalTrials: output.totalTrials,
          fieldCount: output.fields.length,
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "network.minimize",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });
      throw error;
    }
  }

  async diffNetwork(
    input: OpensteerNetworkDiffInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerNetworkDiffOutput> {
    assertValidSemanticOperationInput("network.diff", input);

    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "network.diff",
        async (timeout) => {
          const [left, right] = await Promise.all([
            this.resolveNetworkRecordByRecordId(input.leftRecordId, timeout, {
              includeBodies: true,
              redactSecretHeaders: false,
            }),
            this.resolveNetworkRecordByRecordId(input.rightRecordId, timeout, {
              includeBodies: true,
              redactSecretHeaders: false,
            }),
          ]);
          return diffNetworkRecords(left, right, input);
        },
        options,
      );

      await this.appendTrace({
        operation: "network.diff",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          leftRecordId: input.leftRecordId,
          rightRecordId: input.rightRecordId,
          summary: output.summary,
        },
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "network.diff",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async readArtifact(
    input: OpensteerArtifactReadInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerArtifactReadOutput> {
    assertValidSemanticOperationInput("artifact.read", input);
    return this.runWithOperationTimeout(
      "artifact.read",
      async () => {
        const artifact = await (
          await this.ensureRoot()
        ).artifacts.toProtocolArtifact(input.artifactId);
        if (artifact === undefined) {
          throw new OpensteerProtocolError(
            "not-found",
            `artifact ${input.artifactId} was not found`,
            {
              details: {
                artifactId: input.artifactId,
              },
            },
          );
        }
        return {
          artifact,
        } satisfies OpensteerArtifactReadOutput;
      },
      options,
    );
  }

  async probeNetwork(
    input: OpensteerTransportProbeInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerTransportProbeOutput> {
    assertValidSemanticOperationInput("network.probe", input);

    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "network.probe",
        async (timeout) => {
          const record = await this.resolveNetworkRecordByRecordId(input.recordId, timeout, {
            includeBodies: true,
            redactSecretHeaders: false,
          });
          const prepared = prepareMinimizationRequest(record);
          const request = materializePreparedMinimizationRequest(
            prepared,
            createFullMinimizationKeepState(prepared),
          );
          const baselineFingerprint = buildCapturedRecordSuccessFingerprint(record);

          const results: OpensteerTransportProbeOutput["results"][number][] = [];
          for (const transport of TRANSPORT_PROBE_LADDER) {
            const trialStartedAt = Date.now();
            try {
              const response = await this.executeAnalysisTransportRequest(
                transport,
                request,
                timeout,
              );
              results.push({
                transport,
                status: response.status,
                success: matchesSuccessFingerprint(response, baselineFingerprint),
                durationMs: Date.now() - trialStartedAt,
              });
            } catch (error) {
              results.push({
                transport,
                status: null,
                success: false,
                durationMs: Date.now() - trialStartedAt,
                error: normalizeRuntimeErrorMessage(error),
              });
            }
          }

          return {
            results,
            recommendation: selectTransportProbeRecommendation(results),
          } satisfies OpensteerTransportProbeOutput;
        },
        options,
      );

      await this.appendTrace({
        operation: "network.probe",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          recordId: input.recordId,
          recommendation: output.recommendation,
        },
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "network.probe",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async discoverReverse(
    input: OpensteerReverseDiscoverInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerReverseDiscoverOutput> {
    assertValidSemanticOperationInput("reverse.discover", input);

    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "reverse.discover",
        async (timeout) => {
          const capture = await this.captureReverseCaseInternal(input, timeout);
          const analyzed = await this.analyzeReverseCaseInternal(
            {
              caseId: capture.case.id,
              observationId: capture.observation.id,
              ...(input.targetHints === undefined ? {} : { targetHints: input.targetHints }),
            },
            timeout,
          );
          const report = await this.writeReverseReportRecord({
            kind: "discovery",
            caseRecord: analyzed.case,
          });
          return {
            caseId: analyzed.case.id,
            reportId: report.id,
            summary: {
              observationIds: analyzed.analyzedObservationIds,
              recordCount: analyzed.case.payload.observedRecords.length,
              clusterCount: analyzed.case.payload.observationClusters.length,
              candidateCount: analyzed.case.payload.candidates.length,
            },
            index: buildReverseDiscoveryIndex(analyzed.case),
          } satisfies OpensteerReverseDiscoverOutput;
        },
        options,
      );

      await this.appendTrace({
        operation: "reverse.discover",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          caseId: output.caseId,
          reportId: output.reportId,
        },
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "reverse.discover",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async queryReverse(
    input: OpensteerReverseQueryInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerReverseQueryOutput> {
    assertValidSemanticOperationInput("reverse.query", input);
    return this.runWithOperationTimeout(
      "reverse.query",
      async () => {
        const caseRecord = await this.resolveReverseCaseById(input.caseId);
        return this.queryReverseCaseInternal({
          caseRecord,
          view: input.view ?? "candidates",
          ...(input.filters === undefined ? {} : { filters: input.filters }),
          ...(input.sort === undefined ? {} : { sort: input.sort }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        }).output;
      },
      options,
    );
  }

  async createReversePackage(
    input: OpensteerReversePackageCreateInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerReversePackageCreateOutput> {
    assertValidSemanticOperationInput("reverse.package.create", input);
    return this.runWithOperationTimeout(
      "reverse.package.create",
      async (timeout) => {
        const caseRecord = await this.resolveReverseCaseById(input.caseId);
        const source = await this.resolveReversePackageSource(caseRecord, input.source, timeout);
        const template =
          source.candidate === undefined
            ? undefined
            : resolveReverseTemplate(source.candidate, input.templateId);
        const sourceChannel = source.candidate?.channel ?? source.observedRecord.channel;
        const validators = buildReverseValidationRules({
          record: await this.resolveNetworkRecordByRecordId(source.sourceRecordId, timeout, {
            includeBodies: true,
            redactSecretHeaders: false,
          }),
          channel: sourceChannel,
        });
        const draft = await this.buildReversePackageDraft(
          {
            caseRecord,
            ...(source.candidate === undefined ? {} : { candidate: source.candidate }),
            ...(template === undefined ? {} : { template }),
            validators,
            ...(input.notes === undefined ? {} : { notes: input.notes }),
          },
          timeout,
        );
        const packageRecord = await this.writeReversePackage({
          caseRecord,
          source: input.source,
          sourceRecordId: source.sourceRecordId,
          ...(source.candidate === undefined ? {} : { candidate: source.candidate }),
          ...(template === undefined ? {} : { template }),
          kind: draft.kind,
          readiness: draft.readiness,
          validators,
          workflow: draft.workflow,
          resolvers: draft.resolvers,
          unresolvedRequirements: draft.unresolvedRequirements,
          suggestedEdits: draft.suggestedEdits,
          attachedTraceIds: draft.attachedTraceIds,
          attachedArtifactIds: draft.attachedArtifactIds,
          attachedRecordIds: draft.attachedRecordIds,
          stateSnapshots: draft.stateSnapshots,
          ...(draft.notes === undefined ? {} : { notes: draft.notes }),
          ...(input.key === undefined ? {} : { key: input.key }),
          ...(input.version === undefined ? {} : { version: input.version }),
          provenanceSource: "reverse.package.create",
        });
        const report = await this.writeReverseReportRecord({
          kind: "package",
          caseRecord,
          packageRecord,
        });
        return {
          package: packageRecord,
          report,
        } satisfies OpensteerReversePackageCreateOutput;
      },
      options,
    );
  }

  async runReversePackage(
    input: OpensteerReversePackageRunInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerReversePackageRunOutput> {
    assertValidSemanticOperationInput("reverse.package.run", input);

    return this.runWithOperationTimeout(
      "reverse.package.run",
      async (timeout) => {
        const packageRecord = await this.resolveReversePackageById(input.packageId);

        const replay = await this.replayReversePackageInternal(
          packageRecord,
          timeout,
          input.pageRef,
        );
        const caseRecord = await this.tryResolveReverseCaseById(packageRecord.payload.caseId);
        if (caseRecord !== undefined) {
          await (
            await this.ensureRoot()
          ).registry.reverseCases.update({
            id: caseRecord.id,
            payload: {
              ...caseRecord.payload,
              experiments: [
                ...caseRecord.payload.experiments,
                {
                  id: `experiment:${randomUUID()}`,
                  createdAt: replay.run.createdAt,
                  ...(replay.candidate === undefined ? {} : { candidateId: replay.candidate.id }),
                  ...(replay.template === undefined ? {} : { templateId: replay.template.id }),
                  kind: "replay-attempt",
                  hypothesis: `replay ${replay.candidate?.id ?? packageRecord.payload.source.id} via package ${packageRecord.id}`,
                  success: replay.run.success,
                  ...(replay.run.status === undefined ? {} : { status: replay.run.status }),
                  ...(replay.run.error === undefined ? {} : { notes: replay.run.error }),
                  validation: replay.run.validation,
                },
              ],
              replayRuns: [...caseRecord.payload.replayRuns, replay.run],
            },
          });
          const refreshedCaseRecord = await this.resolveReverseCaseById(caseRecord.id);
          await this.writeReverseReportRecord({
            kind: "package",
            caseRecord: refreshedCaseRecord,
            packageRecord,
          });
        }

        return {
          packageId: packageRecord.id,
          caseId: packageRecord.payload.caseId,
          source: packageRecord.payload.source,
          ...(replay.candidate === undefined ? {} : { candidateId: replay.candidate.id }),
          ...(replay.template === undefined ? {} : { templateId: replay.template.id }),
          success: replay.run.success,
          kind: packageRecord.payload.kind,
          readiness: packageRecord.payload.readiness,
          ...(replay.candidate === undefined ? {} : { channel: replay.candidate.channel.kind }),
          ...(replay.template?.transport === undefined
            ? {}
            : { transport: replay.template.transport }),
          ...(packageRecord.payload.stateSource === undefined
            ? {}
            : { stateSource: packageRecord.payload.stateSource }),
          ...(replay.run.recordId === undefined ? {} : { recordId: replay.run.recordId }),
          ...(replay.run.status === undefined ? {} : { status: replay.run.status }),
          validation: replay.run.validation,
          executedStepIds: replay.run.executedStepIds,
          ...(replay.run.failedStepId === undefined
            ? {}
            : { failedStepId: replay.run.failedStepId }),
          bindings: replay.run.bindings ?? {},
          replayRunId: replay.run.id,
          unresolvedRequirements: packageRecord.payload.unresolvedRequirements,
          suggestedEdits: packageRecord.payload.suggestedEdits,
          ...(replay.run.error === undefined ? {} : { error: replay.run.error }),
        } satisfies OpensteerReversePackageRunOutput;
      },
      options,
    );
  }

  async exportReverse(
    input: OpensteerReverseExportInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerReverseExportOutput> {
    assertValidSemanticOperationInput("reverse.export", input);

    return this.runWithOperationTimeout(
      "reverse.export",
      async (timeout) => {
        const root = await this.ensureRoot();
        const sourcePackage = await this.resolveReversePackageById(input.packageId);
        let requestPlan =
          sourcePackage.payload.requestPlanId === undefined
            ? undefined
            : await root.registry.requestPlans.getById(sourcePackage.payload.requestPlanId);
        let exportedPayload = sourcePackage.payload;

        if (
          requestPlan === undefined &&
          sourcePackage.payload.kind === "portable-http" &&
          sourcePackage.payload.readiness === "runnable" &&
          sourcePackage.payload.candidate !== undefined &&
          sourcePackage.payload.template !== undefined
        ) {
          const caseRecord = await this.resolveReverseCaseById(sourcePackage.payload.caseId);
          requestPlan = await this.writePortableReverseRequestPlan(
            caseRecord,
            sourcePackage.payload.candidate,
            sourcePackage.payload.template,
            timeout,
            {
              key: `${caseRecord.key}:portable:${Date.now()}`,
              version: "1.0.0",
              provenanceSource: "reverse.export",
            },
          );
          exportedPayload = {
            ...exportedPayload,
            requestPlanId: requestPlan.id,
          };
        }

        const packageRecord =
          input.key === undefined &&
          input.version === undefined &&
          exportedPayload === sourcePackage.payload
            ? sourcePackage
            : await root.registry.reversePackages.write({
                key: input.key ?? `${sourcePackage.key}:copy:${Date.now()}`,
                version: input.version ?? sourcePackage.version,
                tags: sourcePackage.tags,
                provenance: {
                  source: "reverse.export",
                  sourceId: sourcePackage.id,
                },
                payload: exportedPayload,
              });

        if (packageRecord.payload.candidateId !== undefined) {
          const caseRecord = await this.tryResolveReverseCaseById(packageRecord.payload.caseId);
          if (caseRecord !== undefined) {
            await root.registry.reverseCases.update({
              id: caseRecord.id,
              payload: {
                ...caseRecord.payload,
                exports: [
                  ...caseRecord.payload.exports,
                  {
                    id: `export:${randomUUID()}`,
                    createdAt: Date.now(),
                    candidateId: packageRecord.payload.candidateId,
                    ...(packageRecord.payload.templateId === undefined
                      ? {}
                      : { templateId: packageRecord.payload.templateId }),
                    packageId: packageRecord.id,
                    kind: packageRecord.payload.kind,
                    readiness: packageRecord.payload.readiness,
                    ...(requestPlan === undefined ? {} : { requestPlanId: requestPlan.id }),
                  },
                ],
              },
            });
          }
        }

        return {
          package: packageRecord,
          ...(requestPlan === undefined ? {} : { requestPlan }),
        } satisfies OpensteerReverseExportOutput;
      },
      options,
    );
  }

  async getReverseReport(
    input: OpensteerReverseReportInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerReverseReportOutput> {
    assertValidSemanticOperationInput("reverse.report", input);

    return this.runWithOperationTimeout(
      "reverse.report",
      async () => {
        if (
          input.packageId === undefined &&
          input.reportId === undefined &&
          input.caseId === undefined
        ) {
          throw new OpensteerProtocolError(
            "invalid-argument",
            "reverse report requires packageId, caseId, or reportId",
          );
        }
        const report =
          input.reportId !== undefined
            ? await this.resolveReverseReportById(input.reportId)
            : input.packageId !== undefined
              ? await this.resolveReverseReportByPackageId(input.packageId)
              : await this.resolveReverseReportByCaseId(input.caseId!, input.kind ?? "discovery");
        return {
          report,
        } satisfies OpensteerReverseReportOutput;
      },
      options,
    );
  }

  async getReversePackage(
    input: OpensteerReversePackageGetInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerReversePackageGetOutput> {
    assertValidSemanticOperationInput("reverse.package.get", input);
    return this.runWithOperationTimeout(
      "reverse.package.get",
      async () => ({
        package: await this.resolveReversePackageById(input.packageId),
      }),
      options,
    );
  }

  async listReversePackages(
    input: OpensteerReversePackageListInput = {},
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerReversePackageListOutput> {
    assertValidSemanticOperationInput("reverse.package.list", input);
    return this.runWithOperationTimeout(
      "reverse.package.list",
      async () => {
        const packages = await (
          await this.ensureRoot()
        ).registry.reversePackages.list(input.key === undefined ? {} : { key: input.key });
        return {
          packages: packages.filter((entry) => {
            if (input.caseId !== undefined && entry.payload.caseId !== input.caseId) {
              return false;
            }
            if (input.kind !== undefined && entry.payload.kind !== input.kind) {
              return false;
            }
            if (input.readiness !== undefined && entry.payload.readiness !== input.readiness) {
              return false;
            }
            return true;
          }),
        } satisfies OpensteerReversePackageListOutput;
      },
      options,
    );
  }

  async patchReversePackage(
    input: OpensteerReversePackagePatchInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerReversePackagePatchOutput> {
    assertValidSemanticOperationInput("reverse.package.patch", input);

    return this.runWithOperationTimeout(
      "reverse.package.patch",
      async (timeout) => {
        const sourcePackage = await this.resolveReversePackageById(input.packageId);
        const caseRecord = await this.resolveReverseCaseById(sourcePackage.payload.caseId);
        const candidate = sourcePackage.payload.candidate;
        const template = sourcePackage.payload.template;

        const validators =
          input.validators ??
          (candidate === undefined
            ? sourcePackage.payload.validators
            : buildReverseValidationRules({
                record: await this.resolveNetworkRecordByRecordId(candidate.recordId, timeout, {
                  includeBodies: true,
                  redactSecretHeaders: false,
                }),
                channel: candidate.channel,
              }));
        const notes = input.notes ?? sourcePackage.payload.notes;
        const draft = await this.buildReversePackageDraft(
          {
            caseRecord,
            ...(candidate === undefined ? {} : { candidate }),
            ...(template === undefined ? {} : { template }),
            validators,
            ...(input.workflow === undefined ? {} : { workflow: input.workflow }),
            ...(input.resolvers === undefined ? {} : { resolvers: input.resolvers }),
            ...(input.attachedTraceIds === undefined
              ? {}
              : { attachedTraceIds: input.attachedTraceIds }),
            ...(input.attachedArtifactIds === undefined
              ? {}
              : { attachedArtifactIds: input.attachedArtifactIds }),
            ...(input.attachedRecordIds === undefined
              ? {}
              : { attachedRecordIds: input.attachedRecordIds }),
            ...(input.stateSnapshotIds === undefined
              ? {}
              : { stateSnapshotIds: input.stateSnapshotIds }),
            ...(notes === undefined ? {} : { notes }),
          },
          timeout,
        );
        const packageRecord = await this.writeReversePackage({
          caseRecord,
          source: sourcePackage.payload.source,
          sourceRecordId: sourcePackage.payload.sourceRecordId,
          ...(candidate === undefined ? {} : { candidate }),
          ...(template === undefined ? {} : { template }),
          kind: draft.kind,
          readiness: draft.readiness,
          validators,
          workflow: draft.workflow,
          resolvers: draft.resolvers,
          unresolvedRequirements: draft.unresolvedRequirements,
          suggestedEdits: draft.suggestedEdits,
          attachedTraceIds: draft.attachedTraceIds,
          attachedArtifactIds: draft.attachedArtifactIds,
          attachedRecordIds: draft.attachedRecordIds,
          stateSnapshots: draft.stateSnapshots,
          ...(draft.notes === undefined ? {} : { notes: draft.notes }),
          parentPackageId: sourcePackage.id,
          key: input.key ?? `${sourcePackage.key}:patch:${Date.now()}`,
          version: input.version ?? sourcePackage.version,
          provenanceSource: "reverse.package.patch",
        });
        const report = await this.writeReverseReportRecord({
          kind: "package",
          caseRecord,
          packageRecord,
        });
        return {
          package: packageRecord,
          report,
        } satisfies OpensteerReversePackagePatchOutput;
      },
      options,
    );
  }

  private async captureReverseCaseInternal(
    input: InternalReverseCaptureInput,
    timeout: TimeoutExecutionContext,
  ): Promise<InternalReverseCaptureOutput> {
    const root = await this.ensureRoot();
    const pageRef = input.pageRef ?? (await this.ensurePageRef());
    const pageInfo = await this.requireEngine().getPageInfo({ pageRef });
    const stateSource = input.stateSource ?? this.resolveCurrentStateSource();
    const existingCase =
      input.caseId === undefined ? undefined : await this.resolveReverseCaseById(input.caseId);
    const caseRecord =
      existingCase ??
      (await root.registry.reverseCases.write({
        key: input.key ?? buildReverseCaseKey(input.objective, pageInfo.url),
        version: "1.0.0",
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        provenance: {
          source: "reverse.discover",
          ...(pageInfo.url.length === 0 ? {} : { sourceId: pageInfo.url }),
        },
        payload: {
          objective: input.objective ?? `Reverse engineer ${pageInfo.url}`,
          ...(input.notes === undefined ? {} : { notes: input.notes }),
          status: "capturing",
          stateSource,
          observations: [],
          observationClusters: [],
          observedRecords: [],
          candidates: [],
          guards: [],
          stateSnapshots: [],
          stateDeltas: [],
          experiments: [],
          replayRuns: [],
          exports: [],
        },
      }));

    const networkRecords = await this.queryLiveNetwork(
      {
        pageRef,
        ...(input.network?.url === undefined ? {} : { url: input.network.url }),
        ...(input.network?.hostname === undefined ? {} : { hostname: input.network.hostname }),
        ...(input.network?.path === undefined ? {} : { path: input.network.path }),
        ...(input.network?.method === undefined ? {} : { method: input.network.method }),
        includeBodies: input.network?.includeBodies ?? true,
      },
      timeout,
      {
        ignoreLimit: true,
        redactSecretHeaders: false,
      },
    );
    const persistedNetwork = filterReverseObservationWindow(
      networkRecords.filter(isReverseRelevantNetworkRecord),
      this.networkHistory,
      input.captureWindowMs,
    );
    const fallbackSavedNetwork =
      persistedNetwork.length === 0
        ? (
            await root.registry.savedNetwork.query({
              ...(input.network?.url === undefined ? {} : { url: input.network.url }),
              ...(input.network?.hostname === undefined
                ? {}
                : { hostname: input.network.hostname }),
              ...(input.network?.path === undefined ? {} : { path: input.network.path }),
              ...(input.network?.method === undefined ? {} : { method: input.network.method }),
              includeBodies: input.network?.includeBodies ?? true,
              limit: 200,
            })
          ).filter(isReverseRelevantNetworkRecord)
        : [];
    const observationNetwork =
      persistedNetwork.length > 0 ? persistedNetwork : fallbackSavedNetwork;
    const observationId = `observation:${randomUUID()}`;
    const networkTag = `reverse-case:${caseRecord.id}:${observationId}`;
    if (observationNetwork.length > 0) {
      await root.registry.savedNetwork.save(observationNetwork, {
        tag: networkTag,
        bodyWriteMode: input.network?.includeBodies === false ? "metadata-only" : "authoritative",
      });
    }

    const scriptArtifactIds =
      input.includeScripts === false
        ? []
        : (
            await this.captureScriptsInternal(
              pageRef,
              {
                pageRef,
                includeExternal: true,
                includeInline: true,
                includeDynamic: true,
                includeWorkers: true,
                persist: true,
              },
              timeout,
            )
          ).scripts.flatMap((script) =>
            script.artifactId === undefined ? [] : [script.artifactId],
          );

    const stateSnapshot = await this.captureReverseStateSnapshot(pageRef, timeout, {
      includeStorage: input.includeStorage ?? true,
      includeSessionStorage: input.includeSessionStorage ?? true,
      includeIndexedDb: input.includeIndexedDb ?? false,
    });

    const linkedInteractionTraceIds = await Promise.all(
      (input.interactionTraceIds ?? []).map(
        async (traceId) => (await this.resolveInteractionTraceById(traceId)).id,
      ),
    );
    const nextGuards = mergeReverseGuards(
      caseRecord.payload.guards,
      linkedInteractionTraceIds.map((traceId) => ({
        id: `guard:${traceId}`,
        kind: "interaction" as const,
        label: `Interaction guard ${traceId}`,
        status: "satisfied" as const,
        interactionTraceId: traceId,
      })),
    );
    const nextStateDeltas = [
      ...caseRecord.payload.stateDeltas,
      ...(
        await Promise.all(
          linkedInteractionTraceIds.map(async (traceId) => {
            const trace = await this.resolveInteractionTraceById(traceId);
            return trace.payload.stateDelta;
          }),
        )
      ).filter((delta): delta is OpensteerStateDelta => delta !== undefined),
    ];

    const observation: OpensteerReverseObservationRecord = {
      id: observationId,
      capturedAt: Date.now(),
      pageRef,
      url: pageInfo.url,
      stateSource,
      networkRecordIds: observationNetwork.map((record) => record.recordId),
      scriptArtifactIds,
      interactionTraceIds: linkedInteractionTraceIds,
      stateSnapshotIds: [stateSnapshot.id],
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    };

    const updatedCase = await root.registry.reverseCases.update({
      id: caseRecord.id,
      tags: mergeStringArrays(caseRecord.tags, input.tags ?? []),
      payload: {
        ...caseRecord.payload,
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        stateSource,
        status: "capturing",
        observations: [...caseRecord.payload.observations, observation],
        guards: nextGuards,
        stateSnapshots: [...caseRecord.payload.stateSnapshots, stateSnapshot],
        stateDeltas: nextStateDeltas,
      },
    });

    return {
      case: updatedCase,
      observation,
    };
  }

  private async analyzeReverseCaseInternal(
    input: InternalReverseAnalyzeInput & {
      readonly targetHints?: OpensteerReverseTargetHints;
    },
    timeout: TimeoutExecutionContext,
  ): Promise<InternalReverseAnalyzeOutput> {
    const root = await this.ensureRoot();
    const caseRecord = await this.resolveReverseCaseById(input.caseId);
    const targetObservationIds =
      input.observationId === undefined
        ? caseRecord.payload.observations.map((observation) => observation.id)
        : [input.observationId];
    const targetObservations = caseRecord.payload.observations.filter((observation) =>
      targetObservationIds.includes(observation.id),
    );

    const analyzedCandidates: OpensteerReverseCandidateRecord[] = [];
    const analyzedClusters: OpensteerObservationCluster[] = [];
    const analyzedObservedRecords: OpensteerReverseObservedRecord[] = [];
    for (const observation of targetObservations) {
      const guards = caseRecord.payload.guards.filter((guard) =>
        observation.interactionTraceIds.includes(guard.interactionTraceId ?? ""),
      );
      const observationRecords = await Promise.all(
        observation.networkRecordIds.map(async (recordId) => ({
          record: await this.resolveNetworkRecordByRecordId(recordId, timeout, {
            includeBodies: true,
            redactSecretHeaders: false,
          }),
          observedAt: this.networkHistory.getObservedAt(recordId),
        })),
      );
      const clusteredRecords = observationRecords.map((entry) => {
        const bodyCodec = describeReverseBodyCodec(entry.record).codec;
        const channel = buildChannelDescriptor(entry.record);
        const matchedTargetHints = matchReverseTargetHints(channel, bodyCodec, input.targetHints);
        return {
          record: entry.record,
          ...(entry.observedAt === undefined ? {} : { observedAt: entry.observedAt }),
          channel,
          bodyCodec,
          matchedTargetHints,
        };
      });
      const clusters = clusterReverseObservationRecords({
        observationId: observation.id,
        records: clusteredRecords,
      });
      analyzedClusters.push(...clusters);
      const clusterByRecordId = new Map<string, OpensteerObservationCluster>();
      const relationKindsByRecordId = new Map<
        string,
        Set<OpensteerObservationCluster["members"][number]["relation"]>
      >();
      for (const cluster of clusters) {
        for (const member of cluster.members) {
          clusterByRecordId.set(member.recordId, cluster);
          const relationKinds = relationKindsByRecordId.get(member.recordId) ?? new Set();
          relationKinds.add(member.relation);
          relationKindsByRecordId.set(member.recordId, relationKinds);
        }
      }

      for (const entry of clusteredRecords) {
        const record = entry.record;
        const cluster = clusterByRecordId.get(record.recordId);
        if (cluster === undefined) {
          continue;
        }
        const analysis = analyzeReverseCandidate({
          observationId: observation.id,
          record,
          ...(observation.url === undefined ? {} : { observationUrl: observation.url }),
          stateSource: caseRecord.payload.stateSource,
          guards,
          scriptArtifactIds: observation.scriptArtifactIds,
          ...(input.targetHints === undefined ? {} : { targetHints: input.targetHints }),
        });
        analyzedCandidates.push({
          id: `candidate:${record.recordId}`,
          observationId: observation.id,
          clusterId: cluster.id,
          recordId: record.recordId,
          channel: analysis.channel,
          bodyCodec: analysis.bodyCodec,
          boundary: analysis.boundary,
          summary: analysis.summary,
          matchedTargetHints: analysis.matchedTargetHints,
          advisoryTags: analysis.advisoryTags,
          constraints: analysis.constraints,
          signals: analysis.signals,
          inputs: analysis.inputs,
          resolvers: analysis.resolvers,
          guardIds: Array.from(
            new Set(analysis.advisoryTemplates.flatMap((template) => template.guardIds)),
          ).sort((left, right) => left.localeCompare(right)),
          scriptArtifactIds: observation.scriptArtifactIds,
          advisoryTemplates: analysis.advisoryTemplates,
        });
      }

      analyzedObservedRecords.push(
        ...clusteredRecords.map((entry) => {
          const cluster = clusterByRecordId.get(entry.record.recordId);
          if (cluster === undefined) {
            throw new OpensteerProtocolError(
              "operation-failed",
              `reverse observation cluster missing record ${entry.record.recordId}`,
            );
          }
          return {
            recordId: entry.record.recordId,
            observationId: observation.id,
            clusterId: cluster.id,
            ...(entry.observedAt === undefined ? {} : { observedAt: entry.observedAt }),
            channel: entry.channel,
            bodyCodec: entry.bodyCodec,
            ...(entry.record.record.resourceType === undefined
              ? {}
              : { resourceType: entry.record.record.resourceType }),
            ...(entry.record.record.status === undefined
              ? {}
              : { status: entry.record.record.status }),
            matchedTargetHints: entry.matchedTargetHints,
            relationKinds: [...(relationKindsByRecordId.get(entry.record.recordId) ?? new Set())],
          } satisfies OpensteerReverseObservedRecord;
        }),
      );
    }

    analyzedCandidates.sort(
      (left, right) =>
        compareReverseAnalysisResults(left, right) || left.id.localeCompare(right.id),
    );
    const untouchedCandidates = caseRecord.payload.candidates.filter(
      (candidate) => !targetObservationIds.includes(candidate.observationId),
    );
    const untouchedObservedRecords = caseRecord.payload.observedRecords.filter(
      (record) => !targetObservationIds.includes(record.observationId),
    );
    const nextCandidates = [...untouchedCandidates, ...analyzedCandidates];
    const nextObservedRecords = [...untouchedObservedRecords, ...analyzedObservedRecords].sort(
      (left, right) =>
        (right.observedAt ?? 0) - (left.observedAt ?? 0) ||
        left.recordId.localeCompare(right.recordId),
    );

    const updatedCase = await root.registry.reverseCases.update({
      id: caseRecord.id,
      payload: {
        ...caseRecord.payload,
        status: nextCandidates.length === 0 ? "attention" : "ready",
        observationClusters: mergeObservationClusters(
          caseRecord.payload.observationClusters,
          analyzedClusters,
        ),
        observedRecords: nextObservedRecords,
        candidates: nextCandidates,
      },
    });

    return {
      case: updatedCase,
      analyzedObservationIds: targetObservationIds,
      candidateCount: nextCandidates.length,
    };
  }

  private queryReverseCaseInternal(input: ReverseQueryExecutionInput): ReverseQueryExecutionResult {
    const view = input.view;
    const sort = normalizeReverseQuerySort(input.sort);
    const limit = normalizeReverseQueryLimit(input.limit);
    const offset = parseReverseQueryCursor(input.cursor);

    if (view === "records") {
      const rankedRecords = input.caseRecord.payload.observedRecords
        .filter((record) =>
          matchesReverseRecordFilters(record, input.caseRecord.payload.candidates, input.filters),
        )
        .sort((left, right) =>
          compareReverseObservedRecords(left, right, input.caseRecord.payload.candidates, sort),
        );
      const page = rankedRecords.slice(offset, offset + limit).map((record) => ({
        record,
        candidateIds: input.caseRecord.payload.candidates
          .filter((candidate) => candidate.recordId === record.recordId)
          .map((candidate) => candidate.id),
      }));
      const query = buildReverseQuerySnapshot({
        view,
        ...(input.filters === undefined ? {} : { filters: input.filters }),
        sort,
        limit,
        totalCount: rankedRecords.length,
        offset,
        resultIds: page.map((item) => item.record.recordId),
      });
      return {
        query,
        output: {
          caseId: input.caseRecord.id,
          view,
          query,
          totalCount: rankedRecords.length,
          ...(query.nextCursor === undefined ? {} : { nextCursor: query.nextCursor }),
          records: page,
        },
      };
    }

    if (view === "clusters") {
      const rankedClusters = input.caseRecord.payload.observationClusters
        .filter((cluster) =>
          matchesReverseClusterFilters(cluster, input.caseRecord.payload.candidates, input.filters),
        )
        .sort((left, right) =>
          compareReverseClusters(left, right, input.caseRecord.payload.candidates, sort),
        );
      const page = rankedClusters.slice(offset, offset + limit).map((cluster) => ({
        cluster,
        candidateIds: input.caseRecord.payload.candidates
          .filter((candidate) => candidate.clusterId === cluster.id)
          .map((candidate) => candidate.id),
      }));
      const query = buildReverseQuerySnapshot({
        view,
        ...(input.filters === undefined ? {} : { filters: input.filters }),
        sort,
        limit,
        totalCount: rankedClusters.length,
        offset,
        resultIds: page.map((item) => item.cluster.id),
      });
      return {
        query,
        output: {
          caseId: input.caseRecord.id,
          view,
          query,
          totalCount: rankedClusters.length,
          ...(query.nextCursor === undefined ? {} : { nextCursor: query.nextCursor }),
          clusters: page,
        },
      };
    }

    const rankedCandidates = input.caseRecord.payload.candidates
      .filter((candidate) =>
        matchesReverseCandidateFilters(candidate, input.filters, {
          ...(input.caseRecord.payload.observedRecords.find(
            (entry) => entry.recordId === candidate.recordId,
          ) === undefined
            ? {}
            : {
                observedRecord: input.caseRecord.payload.observedRecords.find(
                  (entry) => entry.recordId === candidate.recordId,
                )!,
              }),
          ...(input.caseRecord.payload.observations.find(
            (entry) => entry.id === candidate.observationId,
          ) === undefined
            ? {}
            : {
                observation: input.caseRecord.payload.observations.find(
                  (entry) => entry.id === candidate.observationId,
                )!,
              }),
        }),
      )
      .sort((left, right) => compareReverseCandidates(left, right, sort));
    const page = rankedCandidates.slice(offset, offset + limit).map((candidate) => ({
      candidate,
      reasons: buildReverseCandidateRankingReasons(candidate),
    }));
    const query = buildReverseQuerySnapshot({
      view,
      ...(input.filters === undefined ? {} : { filters: input.filters }),
      sort,
      limit,
      totalCount: rankedCandidates.length,
      offset,
      resultIds: page.map((item) => item.candidate.id),
    });
    return {
      query,
      output: {
        caseId: input.caseRecord.id,
        view,
        query,
        totalCount: rankedCandidates.length,
        ...(query.nextCursor === undefined ? {} : { nextCursor: query.nextCursor }),
        candidates: page,
      },
    };
  }

  private async resolveReversePackageSource(
    caseRecord: ReverseCaseRecord,
    source: OpensteerReversePackageCreateInput["source"],
    timeout: TimeoutExecutionContext,
  ): Promise<{
    readonly sourceRecordId: string;
    readonly observedRecord: OpensteerReverseObservedRecord;
    readonly candidate?: OpensteerReverseCandidateRecord;
  }> {
    if (source.kind === "candidate") {
      const candidate = resolveReverseCandidate(caseRecord, source.id);
      const observedRecord = resolveReverseObservedRecord(caseRecord, candidate.recordId);
      return {
        sourceRecordId: candidate.recordId,
        observedRecord,
        candidate,
      };
    }

    const observedRecord = resolveReverseObservedRecord(caseRecord, source.id);
    const existingCandidate = caseRecord.payload.candidates.find(
      (entry) => entry.recordId === observedRecord.recordId,
    );
    if (existingCandidate !== undefined) {
      return {
        sourceRecordId: existingCandidate.recordId,
        observedRecord,
        candidate: existingCandidate,
      };
    }

    const observation = caseRecord.payload.observations.find(
      (entry) => entry.id === observedRecord.observationId,
    );
    const record = await this.resolveNetworkRecordByRecordId(observedRecord.recordId, timeout, {
      includeBodies: true,
      redactSecretHeaders: false,
    });
    const analysis = analyzeReverseCandidate({
      observationId: observedRecord.observationId,
      record,
      ...(observation?.url === undefined ? {} : { observationUrl: observation.url }),
      stateSource: caseRecord.payload.stateSource,
      guards: caseRecord.payload.guards,
      scriptArtifactIds: observation?.scriptArtifactIds ?? [],
    });
    return {
      sourceRecordId: observedRecord.recordId,
      observedRecord,
      candidate: {
        id: `candidate:${observedRecord.recordId}`,
        observationId: observedRecord.observationId,
        clusterId: observedRecord.clusterId,
        recordId: observedRecord.recordId,
        channel: analysis.channel,
        bodyCodec: analysis.bodyCodec,
        boundary: analysis.boundary,
        summary: analysis.summary,
        matchedTargetHints: analysis.matchedTargetHints,
        advisoryTags: analysis.advisoryTags,
        constraints: analysis.constraints,
        signals: analysis.signals,
        inputs: analysis.inputs,
        resolvers: analysis.resolvers,
        guardIds: Array.from(
          new Set(analysis.advisoryTemplates.flatMap((entry) => entry.guardIds)),
        ).sort((left, right) => left.localeCompare(right)),
        scriptArtifactIds: observation?.scriptArtifactIds ?? [],
        advisoryTemplates: analysis.advisoryTemplates,
      },
    };
  }

  private async replayReversePackageInternal(
    packageRecord: ReversePackageRecord,
    timeout: TimeoutExecutionContext,
    explicitPageRef: PageRef | undefined,
  ): Promise<{
    readonly candidate?: OpensteerReverseCandidateRecord;
    readonly template?: OpensteerReverseAdvisoryTemplate;
    readonly run: OpensteerReverseReplayRunRecord;
  }> {
    const candidate = packageRecord.payload.candidate;
    const template = packageRecord.payload.template;

    if (candidate !== undefined && packageRecord.payload.stateSnapshots.length > 0) {
      await this.restoreReverseStateSnapshots(
        packageRecord.payload.stateSnapshots,
        candidate,
        timeout,
        explicitPageRef,
      );
    }
    const replayResult = await this.executeReversePackageWorkflow(
      packageRecord,
      timeout,
      explicitPageRef,
    );

    return {
      ...(candidate === undefined ? {} : { candidate }),
      ...(template === undefined ? {} : { template }),
      run: {
        id: `reverse-replay:${randomUUID()}`,
        createdAt: Date.now(),
        ...(candidate === undefined ? {} : { candidateId: candidate.id }),
        ...(template === undefined ? {} : { templateId: template.id }),
        packageId: packageRecord.id,
        success: replayResult.success,
        ...(candidate === undefined ? {} : { channel: candidate.channel.kind }),
        kind: packageRecord.payload.kind,
        readiness: packageRecord.payload.readiness,
        ...(packageRecord.payload.stateSource === undefined
          ? {}
          : { stateSource: packageRecord.payload.stateSource }),
        ...(template?.transport === undefined ? {} : { transport: template.transport }),
        executedStepIds: replayResult.executedStepIds,
        ...(replayResult.failedStepId === undefined
          ? {}
          : { failedStepId: replayResult.failedStepId }),
        ...(replayResult.bindings === undefined ? {} : { bindings: replayResult.bindings }),
        ...(replayResult.recordId === undefined ? {} : { recordId: replayResult.recordId }),
        ...(replayResult.status === undefined ? {} : { status: replayResult.status }),
        validation: replayResult.validation,
        ...(replayResult.error === undefined ? {} : { error: replayResult.error }),
      },
    };
  }

  private async executeReversePackageWorkflow(
    packageRecord: ReversePackageRecord,
    timeout: TimeoutExecutionContext,
    explicitPageRef: PageRef | undefined,
  ): Promise<{
    readonly success: boolean;
    readonly executedStepIds: readonly string[];
    readonly failedStepId?: string;
    readonly bindings?: Readonly<Record<string, JsonValue>>;
    readonly recordId?: string;
    readonly status?: number;
    readonly validation: OpensteerReversePackageRunOutput["validation"];
    readonly error?: string;
  }> {
    const caseRecord = await this.tryResolveReverseCaseById(packageRecord.payload.caseId);
    if (packageRecord.payload.workflow.length === 0) {
      return {
        success: false,
        executedStepIds: [],
        bindings: {},
        validation: {},
        error: "package workflow is empty",
      };
    }
    const bindings = new Map<string, unknown>();
    const baselineRequestIds = await this.readLiveRequestIds(timeout, {
      includeCurrentPageOnly: true,
    });
    const pageRef = explicitPageRef ?? (await this.ensurePageRef());
    const validatorMap = new Map(
      packageRecord.payload.validators.map((validator) => [validator.id, validator]),
    );
    let lastAssertable: unknown;
    let lastRecordId: string | undefined;
    let lastStatus: number | undefined;
    const executedStepIds: string[] = [];

    for (const step of packageRecord.payload.workflow) {
      const resolverValues = await this.resolveReversePackageResolverValues(
        packageRecord,
        caseRecord,
        bindings,
        pageRef,
        timeout,
      );
      switch (step.kind) {
        case "operation": {
          const result = await this.executeReversePackageOperationStep(
            step,
            packageRecord,
            caseRecord,
            timeout,
            pageRef,
            bindings,
            resolverValues,
          );
          if (step.bindAs !== undefined) {
            bindings.set(step.bindAs, result);
          }
          executedStepIds.push(step.id);
          lastAssertable = result;
          lastRecordId = extractReverseRecordId(result);
          lastStatus = extractReverseStatus(result);
          break;
        }
        case "await-record": {
          const matchedRecord = await this.waitForReversePackageRecord(
            step,
            baselineRequestIds,
            timeout,
            pageRef,
          );
          if (matchedRecord === undefined) {
            return {
              success: false,
              executedStepIds,
              failedStepId: step.id,
              bindings: serializeReverseBindings(bindings),
              validation: {},
              error: "package workflow did not emit the expected observed record",
            };
          }
          const bindingName = step.bindAs ?? `record:${step.id}`;
          bindings.set(bindingName, matchedRecord);
          executedStepIds.push(step.id);
          lastAssertable = matchedRecord;
          lastRecordId = matchedRecord.recordId;
          lastStatus = matchedRecord.record.status;
          break;
        }
        case "assert": {
          const validators = step.validationRuleIds
            .map((validatorId) => validatorMap.get(validatorId))
            .filter((validator): validator is OpensteerValidationRule => validator !== undefined);
          const boundValue =
            step.binding === undefined ? lastAssertable : bindings.get(step.binding);
          if (boundValue === undefined) {
            return {
              success: false,
              executedStepIds,
              failedStepId: step.id,
              bindings: serializeReverseBindings(bindings),
              validation: {},
              error: `assert step ${step.id} did not find a bound result`,
            };
          }
          executedStepIds.push(step.id);
          return evaluateReversePackageAssertion(
            boundValue,
            packageRecord.payload.channel?.kind ?? "http",
            validators,
            lastRecordId,
            lastStatus,
            executedStepIds,
            serializeReverseBindings(bindings),
            step.id,
          );
        }
      }
    }

    return {
      success: true,
      executedStepIds,
      bindings: serializeReverseBindings(bindings),
      ...(lastRecordId === undefined ? {} : { recordId: lastRecordId }),
      ...(lastStatus === undefined ? {} : { status: lastStatus }),
      validation: {},
    };
  }

  private async executeReversePackageOperationStep(
    step: Extract<OpensteerReverseWorkflowStep, { readonly kind: "operation" }>,
    packageRecord: ReversePackageRecord,
    caseRecord: ReverseCaseRecord | undefined,
    timeout: TimeoutExecutionContext,
    pageRef: PageRef,
    bindings: ReadonlyMap<string, unknown>,
    resolverValues: ReadonlyMap<string, unknown>,
  ): Promise<unknown> {
    const operationName = step.operation as OpensteerSemanticOperationName;
    const spec = opensteerSemanticOperationSpecificationMap[operationName];
    if (spec === undefined || spec.packageRunnable !== true) {
      throw new OpensteerProtocolError(
        "invalid-argument",
        `reverse package operation ${step.operation} is not runnable inside packages`,
      );
    }
    const input = await this.resolveReverseValueTemplate(
      step.input,
      packageRecord,
      caseRecord,
      bindings,
      resolverValues,
      pageRef,
      timeout,
    );
    assertValidSemanticOperationInput(operationName, input);
    return dispatchSemanticOperation(this, operationName, input, { signal: timeout.signal });
  }

  private async resolveReversePackageResolverValues(
    packageRecord: ReversePackageRecord,
    caseRecord: ReverseCaseRecord | undefined,
    bindings: ReadonlyMap<string, unknown>,
    pageRef: PageRef,
    timeout: TimeoutExecutionContext,
  ): Promise<ReadonlyMap<string, unknown>> {
    const values = new Map<string, unknown>();
    for (const resolver of packageRecord.payload.resolvers) {
      const value = await this.resolveReversePackageResolverValue(
        resolver,
        packageRecord,
        caseRecord,
        bindings,
        pageRef,
        timeout,
      );
      if (value !== undefined) {
        values.set(resolver.id, value);
      }
    }
    return values;
  }

  private async resolveReversePackageResolverValue(
    resolver: OpensteerExecutableResolver,
    packageRecord: ReversePackageRecord,
    caseRecord: ReverseCaseRecord | undefined,
    bindings: ReadonlyMap<string, unknown>,
    pageRef: PageRef,
    timeout: TimeoutExecutionContext,
  ): Promise<unknown> {
    switch (resolver.kind) {
      case "manual":
      case "runtime-managed":
        return undefined;
      case "cookie":
        return resolveReverseCookieResolverValue(packageRecord.payload.stateSnapshots, resolver);
      case "storage":
      case "state-snapshot":
        return resolveReverseStorageResolverValue(packageRecord.payload.stateSnapshots, resolver);
      case "prior-record":
      case "literal":
      case "binding":
      case "candidate":
      case "case":
      case "artifact":
        return this.resolveReverseValueReference(
          resolver.valueRef,
          packageRecord,
          caseRecord,
          bindings,
          pageRef,
          timeout,
        );
    }
  }

  private async resolveReverseValueTemplate(
    template: OpensteerValueTemplate,
    packageRecord: ReversePackageRecord,
    caseRecord: ReverseCaseRecord | undefined,
    bindings: ReadonlyMap<string, unknown>,
    resolverValues: ReadonlyMap<string, unknown>,
    pageRef: PageRef,
    timeout: TimeoutExecutionContext,
  ): Promise<unknown> {
    if (Array.isArray(template)) {
      return Promise.all(
        template.map((entry) =>
          this.resolveReverseValueTemplate(
            entry,
            packageRecord,
            caseRecord,
            bindings,
            resolverValues,
            pageRef,
            timeout,
          ),
        ),
      );
    }
    if (template === null || typeof template !== "object") {
      return template;
    }
    if (
      "$ref" in (template as Record<string, unknown>) &&
      (template as { readonly $ref?: unknown }).$ref !== undefined
    ) {
      return this.resolveReverseValueReference(
        (template as { readonly $ref: OpensteerValueReference }).$ref,
        packageRecord,
        caseRecord,
        bindings,
        pageRef,
        timeout,
        resolverValues,
      );
    }
    const entries = await Promise.all(
      Object.entries(template as Record<string, OpensteerValueTemplate>).map(
        async ([key, value]) => [
          key,
          await this.resolveReverseValueTemplate(
            value,
            packageRecord,
            caseRecord,
            bindings,
            resolverValues,
            pageRef,
            timeout,
          ),
        ],
      ),
    );
    return Object.fromEntries(entries);
  }

  private async resolveReverseValueReference(
    valueRef: OpensteerValueReference | undefined,
    packageRecord: ReversePackageRecord,
    caseRecord: ReverseCaseRecord | undefined,
    bindings: ReadonlyMap<string, unknown>,
    pageRef: PageRef,
    timeout: TimeoutExecutionContext,
    resolverValues?: ReadonlyMap<string, unknown>,
  ): Promise<unknown> {
    if (valueRef === undefined) {
      return undefined;
    }
    switch (valueRef.kind) {
      case "literal":
        return valueRef.value;
      case "resolver":
        return extractReverseRuntimeValue(
          resolverValues?.get(valueRef.resolverId ?? ""),
          valueRef.pointer,
        );
      case "binding":
        return extractReverseRuntimeValue(bindings.get(valueRef.binding ?? ""), valueRef.pointer);
      case "candidate":
        return extractReverseRuntimeValue(packageRecord.payload.candidate, valueRef.pointer);
      case "case":
        return extractReverseRuntimeValue(caseRecord, valueRef.pointer);
      case "record":
        if (valueRef.recordId === undefined) {
          return undefined;
        }
        return extractReverseRuntimeValue(
          await this.resolveNetworkRecordByRecordId(valueRef.recordId, timeout, {
            includeBodies: true,
            redactSecretHeaders: false,
          }),
          valueRef.pointer,
        );
      case "artifact":
        if (valueRef.artifactId === undefined) {
          return undefined;
        }
        return extractReverseRuntimeValue(
          await this.readArtifact({ artifactId: valueRef.artifactId }, { signal: timeout.signal }),
          valueRef.pointer,
        );
      case "state-snapshot": {
        const snapshots = packageRecord.payload.stateSnapshots;
        const snapshot =
          valueRef.stateSnapshotId === undefined
            ? snapshots.length === 1
              ? snapshots[0]
              : snapshots.at(-1)
            : snapshots.find((entry) => entry.id === valueRef.stateSnapshotId);
        return extractReverseRuntimeValue(snapshot, valueRef.pointer);
      }
      case "runtime":
        return extractReverseRuntimeValue(
          resolveReversePackageRuntimeValue(packageRecord, pageRef, valueRef.runtimeKey),
          valueRef.pointer,
        );
      case "manual":
        return undefined;
    }
  }

  private async waitForReversePackageRecord(
    step: Extract<OpensteerReverseWorkflowStep, { readonly kind: "await-record" }>,
    baselineRequestIds: ReadonlySet<string>,
    timeout: TimeoutExecutionContext,
    pageRef: PageRef,
  ): Promise<NetworkQueryRecord | undefined> {
    let expectedRecord: NetworkQueryRecord | undefined;
    if (step.recordId !== undefined || step.match?.recordId !== undefined) {
      expectedRecord = await this.resolveNetworkRecordByRecordId(
        step.recordId ?? step.match!.recordId!,
        timeout,
        {
          includeBodies: true,
          redactSecretHeaders: false,
        },
      );
    }
    if (expectedRecord !== undefined && step.match === undefined) {
      return this.waitForObservedReplayRecord(expectedRecord, baselineRequestIds, timeout, pageRef);
    }
    if (expectedRecord === undefined && step.match === undefined) {
      throw new OpensteerProtocolError(
        "invalid-argument",
        `await-record step ${step.id} requires a recordId or match filter`,
      );
    }
    const method = step.match?.method ?? expectedRecord?.record.method;
    const filter = {
      channel: step.channel.kind,
      ...(method === undefined ? {} : { method }),
      ...(expectedRecord?.record.url === undefined ? {} : { url: expectedRecord.record.url }),
      ...(step.match?.host === undefined ? {} : { host: step.match.host }),
      ...(step.match?.path === undefined ? {} : { path: step.match.path }),
      ...(step.match?.status === undefined ? {} : { status: step.match.status }),
      ...(step.match?.text === undefined ? {} : { text: step.match.text }),
    };
    return this.waitForMatchingReplayRecord(filter, baselineRequestIds, timeout, pageRef);
  }

  private async buildReverseTransportOperationInput(
    candidate: OpensteerReverseCandidateRecord,
    template: OpensteerReverseAdvisoryTemplate,
    timeout: TimeoutExecutionContext,
  ): Promise<OpensteerRawRequestInput> {
    if (template.transport === undefined) {
      throw new OpensteerProtocolError(
        "invalid-argument",
        `reverse template ${template.id} is missing a transport`,
      );
    }
    const record = await this.resolveNetworkRecordByRecordId(candidate.recordId, timeout, {
      includeBodies: true,
      redactSecretHeaders: false,
    });
    const headers = stripManagedRequestHeaders(record.record.requestHeaders, template.transport);
    const body = toReverseRawRequestBodyInput(
      record.record.requestBody,
      record.record.requestHeaders,
    );
    return {
      transport: template.transport,
      url: record.record.url,
      method: record.record.method,
      ...(headers === undefined ? {} : { headers }),
      ...(body === undefined ? {} : { body }),
    };
  }

  private async writePortableReverseRequestPlan(
    caseRecord: ReverseCaseRecord,
    candidate: OpensteerReverseCandidateRecord,
    template: OpensteerReverseAdvisoryTemplate,
    timeout: TimeoutExecutionContext,
    input: {
      readonly key: string;
      readonly version: string;
      readonly provenanceSource: "reverse.package.create" | "reverse.export";
    },
  ): Promise<RequestPlanRecord> {
    const root = await this.ensureRoot();
    const record = await this.resolveNetworkRecordByRecordId(candidate.recordId, timeout, {
      includeBodies: true,
      redactSecretHeaders: false,
    });
    const inferred = inferRequestPlanFromNetworkRecord(record, {
      recordId: candidate.recordId,
      key: input.key,
      version: input.version,
    });
    const defaultHeaders =
      inferred.payload.endpoint.defaultHeaders === undefined
        ? undefined
        : stripManagedRequestHeaders(
            inferred.payload.endpoint.defaultHeaders,
            template.transport ?? "direct-http",
          );
    const payload = normalizeRequestPlanPayload({
      ...inferred.payload,
      transport: {
        kind: template.transport ?? "direct-http",
        ...(template.transport === "page-http" ? { requireSameOrigin: false } : {}),
      },
      endpoint: {
        ...inferred.payload.endpoint,
        ...(defaultHeaders === undefined ? {} : { defaultHeaders }),
      },
    });
    return root.registry.requestPlans.write({
      ...inferred,
      key: input.key,
      version: input.version,
      tags: caseRecord.tags,
      provenance: {
        source: input.provenanceSource,
        sourceId: candidate.recordId,
      },
      payload,
    });
  }

  private async writeReversePackage(
    input: ReversePackageWriteInput,
  ): Promise<ReversePackageRecord> {
    const root = await this.ensureRoot();
    const candidate = input.candidate;
    const requirements = buildReversePackageRequirements({
      stateSource: input.caseRecord.payload.stateSource,
      ...(input.template === undefined ? {} : { template: input.template }),
      ...(candidate === undefined ? {} : { candidate }),
      ...(input.manualCalibration === undefined
        ? {}
        : { manualCalibration: input.manualCalibration }),
    });
    return root.registry.reversePackages.write({
      key: input.key ?? `${input.caseRecord.key}:package:${candidate?.id ?? "draft"}:${Date.now()}`,
      version: input.version ?? "1.0.0",
      tags: input.caseRecord.tags,
      provenance: {
        source: input.provenanceSource,
        sourceId: input.source.id,
      },
      payload: {
        kind: input.kind,
        readiness: input.readiness,
        caseId: input.caseRecord.id,
        objective: input.caseRecord.payload.objective,
        source: input.source,
        sourceRecordId: input.sourceRecordId,
        ...(candidate === undefined ? {} : { candidateId: candidate.id }),
        ...(candidate === undefined ? {} : { candidate }),
        ...(input.template === undefined ? {} : { templateId: input.template.id }),
        ...(input.template === undefined ? {} : { template: input.template }),
        ...(candidate === undefined ? {} : { channel: candidate.channel }),
        ...(input.template === undefined
          ? { stateSource: input.caseRecord.payload.stateSource }
          : { stateSource: input.template.stateSource }),
        ...(candidate === undefined ? {} : { observationId: candidate.observationId }),
        ...(input.template?.transport === undefined ? {} : { transport: input.template.transport }),
        guardIds: input.template?.guardIds ?? candidate?.guardIds ?? ([] as readonly string[]),
        workflow: input.workflow,
        resolvers: cloneReversePackageResolvers(input.resolvers ?? []),
        validators: input.validators,
        stateSnapshots: input.stateSnapshots,
        requirements,
        ...(input.requestPlan === undefined ? {} : { requestPlanId: input.requestPlan.id }),
        unresolvedRequirements: input.unresolvedRequirements,
        suggestedEdits: input.suggestedEdits,
        attachedTraceIds: input.attachedTraceIds,
        attachedArtifactIds: input.attachedArtifactIds,
        attachedRecordIds: input.attachedRecordIds,
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        ...(input.parentPackageId === undefined ? {} : { parentPackageId: input.parentPackageId }),
      },
    });
  }

  private async buildReversePackageDraft(
    input: {
      readonly caseRecord: ReverseCaseRecord;
      readonly candidate?: OpensteerReverseCandidateRecord;
      readonly template?: OpensteerReverseAdvisoryTemplate;
      readonly validators: readonly OpensteerValidationRule[];
      readonly workflow?: readonly OpensteerReverseWorkflowStep[];
      readonly resolvers?: readonly OpensteerExecutableResolver[];
      readonly attachedTraceIds?: readonly string[];
      readonly attachedArtifactIds?: readonly string[];
      readonly attachedRecordIds?: readonly string[];
      readonly stateSnapshotIds?: readonly string[];
      readonly manualCalibration?: OpensteerReverseManualCalibrationMode;
      readonly notes?: string;
    },
    timeout: TimeoutExecutionContext,
  ): Promise<{
    readonly kind: OpensteerReversePackageKind;
    readonly readiness: OpensteerReversePackageReadiness;
    readonly workflow: readonly OpensteerReverseWorkflowStep[];
    readonly resolvers: readonly OpensteerExecutableResolver[];
    readonly unresolvedRequirements: readonly OpensteerReverseRequirement[];
    readonly suggestedEdits: readonly OpensteerReverseSuggestedEdit[];
    readonly attachedTraceIds: readonly string[];
    readonly attachedArtifactIds: readonly string[];
    readonly attachedRecordIds: readonly string[];
    readonly stateSnapshots: readonly OpensteerStateSnapshot[];
    readonly notes?: string;
  }> {
    const candidate = input.candidate;
    const template = input.template;
    const observation =
      candidate === undefined
        ? undefined
        : input.caseRecord.payload.observations.find(
            (entry) => entry.id === candidate.observationId,
          );
    const guards =
      template === undefined
        ? []
        : input.caseRecord.payload.guards.filter((guard) => template.guardIds.includes(guard.id));
    const resolvers = input.resolvers ?? candidate?.resolvers ?? [];
    const stateSnapshots =
      input.stateSnapshotIds === undefined
        ? candidate === undefined
          ? []
          : collectReverseReplayStateSnapshotsFromCase(input.caseRecord, candidate)
        : input.stateSnapshotIds.map((snapshotId) => {
            const snapshot = input.caseRecord.payload.stateSnapshots.find(
              (entry) => entry.id === snapshotId,
            );
            if (snapshot === undefined) {
              throw new OpensteerProtocolError(
                "not-found",
                `reverse state snapshot ${snapshotId} was not found`,
              );
            }
            return snapshot;
          });
    const executeStepInput =
      candidate === undefined || template === undefined || template.execution === "page-observation"
        ? undefined
        : await this.buildReverseTransportOperationInput(candidate, template, timeout);
    const executeStepValue =
      executeStepInput === undefined ? undefined : toCanonicalJsonValue(executeStepInput);
    const workflow =
      input.workflow ??
      (candidate === undefined
        ? []
        : buildReversePackageWorkflow({
            candidate,
            ...(template === undefined ? {} : { template }),
            ...(observation === undefined ? {} : { observation }),
            guards,
            validators: input.validators,
            ...(executeStepValue === undefined ? {} : { executeStepInput: executeStepValue }),
          }));
    const attachedTraceIds = dedupeStringList([
      ...(observation?.interactionTraceIds ?? []),
      ...guards.flatMap((guard) =>
        guard.interactionTraceId === undefined ? [] : [guard.interactionTraceId],
      ),
      ...(input.attachedTraceIds ?? []),
    ]);
    const attachedArtifactIds = dedupeStringList([
      ...(observation?.scriptArtifactIds ?? []),
      ...(candidate?.scriptArtifactIds ?? []),
      ...resolvers.flatMap((resolver) => {
        const artifactId = extractReverseResolverArtifactId(resolver);
        return artifactId === undefined ? [] : [artifactId];
      }),
      ...(input.attachedArtifactIds ?? []),
    ]);
    const attachedRecordIds = dedupeStringList([
      ...(observation?.networkRecordIds ?? []),
      ...(candidate === undefined ? [] : [candidate.recordId]),
      ...(input.attachedRecordIds ?? []),
    ]);
    const kind = deriveReversePackageKind({
      ...(candidate === undefined ? {} : { candidate }),
      ...(template === undefined ? {} : { template }),
      workflow,
      resolvers,
      stateSnapshots,
    });
    const unresolvedRequirements = deriveReversePackageUnresolvedRequirements({
      ...(candidate === undefined ? {} : { candidate }),
      ...(template === undefined ? {} : { template }),
      workflow,
      resolvers,
      guards,
      stateSource: input.caseRecord.payload.stateSource,
    });
    const readiness = deriveReversePackageReadiness({
      kind,
      unresolvedRequirements,
    });
    const suggestedEdits = buildReversePackageSuggestedEdits(unresolvedRequirements);
    return {
      kind,
      readiness,
      workflow,
      resolvers,
      unresolvedRequirements,
      suggestedEdits,
      attachedTraceIds,
      attachedArtifactIds,
      attachedRecordIds,
      stateSnapshots,
      ...(input.notes === undefined ? {} : { notes: input.notes }),
    };
  }

  private async writeReverseReportRecord(input: {
    readonly kind: OpensteerReverseReportKind;
    readonly caseRecord: ReverseCaseRecord;
    readonly packageRecord?: ReversePackageRecord;
    readonly query?: OpensteerReverseQuerySnapshot;
  }): Promise<ReverseReportRecord> {
    const root = await this.ensureRoot();
    return root.registry.reverseReports.write({
      key: `${input.caseRecord.key}:${input.kind}-report:${Date.now()}`,
      version: "1.0.0",
      tags: input.caseRecord.tags,
      provenance: {
        source: input.kind === "discovery" ? "reverse.discover" : "reverse.package.create",
        sourceId: input.packageRecord?.id ?? input.caseRecord.id,
      },
      payload: {
        kind: input.kind,
        caseId: input.caseRecord.id,
        objective: input.caseRecord.payload.objective,
        ...(input.packageRecord === undefined ? {} : { packageId: input.packageRecord.id }),
        ...(input.packageRecord === undefined
          ? {}
          : { packageKind: input.packageRecord.payload.kind }),
        ...(input.packageRecord === undefined
          ? {}
          : { packageReadiness: input.packageRecord.payload.readiness }),
        observations: input.caseRecord.payload.observations,
        observationClusters: input.caseRecord.payload.observationClusters,
        observedRecords: input.caseRecord.payload.observedRecords,
        guards: input.caseRecord.payload.guards,
        stateDeltas: input.caseRecord.payload.stateDeltas,
        summaryCounts: buildReverseSummaryCounts(input.caseRecord),
        ...(input.query === undefined ? {} : { query: input.query }),
        candidateAdvisories: input.caseRecord.payload.candidates.map((candidate) => ({
          candidateId: candidate.id,
          clusterId: candidate.clusterId,
          advisoryRank: candidate.signals.advisoryRank,
          bodyCodec: candidate.bodyCodec,
          summary: candidate.summary,
          advisoryTags: candidate.advisoryTags,
          constraints: candidate.constraints,
          signals: candidate.signals,
          reasons: buildReverseCandidateRankingReasons(candidate),
        })),
        experiments: input.caseRecord.payload.experiments,
        replayRuns: input.caseRecord.payload.replayRuns,
        ...(input.packageRecord === undefined
          ? {}
          : { unresolvedRequirements: input.packageRecord.payload.unresolvedRequirements }),
        ...(input.packageRecord === undefined
          ? {}
          : { suggestedEdits: input.packageRecord.payload.suggestedEdits }),
        linkedNetworkRecordIds:
          input.packageRecord?.payload.attachedRecordIds ??
          input.caseRecord.payload.observedRecords.map((record) => record.recordId),
        linkedInteractionTraceIds:
          input.packageRecord?.payload.attachedTraceIds ??
          input.caseRecord.payload.observations.flatMap((entry) => entry.interactionTraceIds),
        linkedArtifactIds:
          input.packageRecord?.payload.attachedArtifactIds ??
          input.caseRecord.payload.observations.flatMap((entry) => entry.scriptArtifactIds),
        linkedStateSnapshotIds:
          input.packageRecord?.payload.stateSnapshots.map((entry) => entry.id) ??
          input.caseRecord.payload.stateSnapshots.map((entry) => entry.id),
        ...(input.packageRecord === undefined ? {} : { package: input.packageRecord }),
      },
    });
  }

  async captureInteraction(
    input: OpensteerInteractionCaptureInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerInteractionCaptureOutput> {
    assertValidSemanticOperationInput("interaction.capture", input);
    if (input.script !== undefined && input.steps !== undefined) {
      throw new OpensteerProtocolError(
        "invalid-argument",
        "interaction capture accepts either script or steps, not both",
      );
    }

    return this.runWithOperationTimeout(
      "interaction.capture",
      async (timeout) => {
        const root = await this.ensureRoot();
        const pageRef = input.pageRef ?? (await this.ensurePageRef());
        const pageInfo = await this.requireEngine().getPageInfo({ pageRef });
        const baselineRequestIds = await this.readLiveRequestIds(timeout, {
          includeCurrentPageOnly: true,
        });
        const beforeState = await this.captureReverseStateSnapshot(pageRef, timeout, {
          includeStorage: input.includeStorage ?? true,
          includeSessionStorage: input.includeSessionStorage ?? false,
          includeIndexedDb: input.includeIndexedDb ?? false,
          ...(input.globalNames === undefined ? {} : { globalNames: input.globalNames }),
        });
        await timeout.runStep(() =>
          this.requireEngine().evaluatePage({
            pageRef,
            script: INTERACTION_RECORDER_INSTALL_SCRIPT,
          }),
        );

        if (input.script !== undefined) {
          await this.runInteractionCaptureScript(pageRef, input.script, input.args, timeout);
        } else if (input.steps !== undefined) {
          await this.runInteractionCaptureSteps(pageRef, input.steps, timeout);
        } else {
          await delayWithSignal(input.durationMs ?? 2_000, timeout.signal);
        }

        const recorded = await timeout.runStep(() =>
          this.requireEngine().evaluatePage({
            pageRef,
            script: INTERACTION_RECORDER_READ_SCRIPT,
          }),
        );
        const afterState = await this.captureReverseStateSnapshot(pageRef, timeout, {
          includeStorage: input.includeStorage ?? true,
          includeSessionStorage: input.includeSessionStorage ?? false,
          includeIndexedDb: input.includeIndexedDb ?? false,
          ...(input.globalNames === undefined ? {} : { globalNames: input.globalNames }),
        });
        const deltaRecords = (
          await this.readLiveNetworkRecords(
            {
              includeBodies: true,
              includeCurrentPageOnly: true,
            },
            timeout.signal,
          )
        ).filter((record) => !baselineRequestIds.has(record.record.requestId));
        if (deltaRecords.length > 0) {
          await root.registry.savedNetwork.save(deltaRecords, {
            tag: `interaction:${pageRef}`,
            bodyWriteMode: "authoritative",
          });
        }

        const trace = await root.registry.interactionTraces.write({
          key: input.key ?? buildInteractionTraceKey(pageInfo.url),
          version: "1.0.0",
          ...(input.tags === undefined ? {} : { tags: input.tags }),
          provenance: {
            source: "interaction.capture",
            ...(pageInfo.url.length === 0 ? {} : { sourceId: pageInfo.url }),
          },
          payload: {
            mode: input.script === undefined ? "manual" : "automated",
            pageRef,
            url: pageInfo.url,
            startedAt: beforeState.capturedAt,
            completedAt: afterState.capturedAt,
            beforeState,
            afterState,
            stateDelta: buildStateDelta(beforeState, afterState),
            events: normalizeInteractionEvents(recorded.data),
            networkRecordIds: deltaRecords.map((record) => record.recordId),
            ...(input.caseId === undefined ? {} : { caseId: input.caseId }),
            ...(input.notes === undefined ? {} : { notes: input.notes }),
          },
        });

        return {
          trace,
        } satisfies OpensteerInteractionCaptureOutput;
      },
      options,
    );
  }

  async getInteraction(
    input: OpensteerInteractionGetInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerInteractionGetOutput> {
    assertValidSemanticOperationInput("interaction.get", input);
    return this.runWithOperationTimeout(
      "interaction.get",
      async () => ({
        trace: await this.resolveInteractionTraceById(input.traceId),
      }),
      options,
    );
  }

  private async runInteractionCaptureScript(
    pageRef: PageRef,
    script: string,
    args: OpensteerInteractionCaptureInput["args"],
    timeout: TimeoutExecutionContext,
  ): Promise<void> {
    await timeout.runStep(() =>
      this.requireEngine().evaluatePage({
        pageRef,
        script,
        ...(args === undefined ? {} : { args }),
      }),
    );
  }

  private async runInteractionCaptureSteps(
    pageRef: PageRef,
    steps: readonly OpensteerInteractionCaptureStep[],
    timeout: TimeoutExecutionContext,
  ): Promise<void> {
    for (const step of steps) {
      timeout.throwIfAborted();
      switch (step.kind) {
        case "goto":
          await this.navigatePage(
            {
              operation: "page.goto",
              pageRef,
              url: step.url,
            },
            timeout,
          );
          break;
        case "click": {
          const target = this.toDomTargetRef(step.target);
          await timeout.runStep(() =>
            this.requireDom().click({
              pageRef,
              target,
              timeout,
            }),
          );
          break;
        }
        case "hover": {
          const target = this.toDomTargetRef(step.target);
          await timeout.runStep(() =>
            this.requireDom().hover({
              pageRef,
              target,
              timeout,
            }),
          );
          break;
        }
        case "input": {
          const target = this.toDomTargetRef(step.target);
          await timeout.runStep(() =>
            this.requireDom().input({
              pageRef,
              target,
              text: step.text,
              ...(step.pressEnter === undefined ? {} : { pressEnter: step.pressEnter }),
              timeout,
            }),
          );
          break;
        }
        case "scroll": {
          const target = this.toDomTargetRef(step.target);
          await timeout.runStep(() =>
            this.requireDom().scroll({
              pageRef,
              target,
              delta: directionToDelta(step.direction, step.amount),
              timeout,
            }),
          );
          break;
        }
        case "wait":
          await delayWithSignal(step.durationMs, timeout.signal);
          break;
      }
    }
  }

  async diffInteraction(
    input: OpensteerInteractionDiffInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerInteractionDiffOutput> {
    assertValidSemanticOperationInput("interaction.diff", input);
    return this.runWithOperationTimeout(
      "interaction.diff",
      async () => {
        const [left, right] = await Promise.all([
          this.resolveInteractionTraceById(input.leftTraceId),
          this.resolveInteractionTraceById(input.rightTraceId),
        ]);
        return diffInteractionTraces(left, right);
      },
      options,
    );
  }

  async replayInteraction(
    input: OpensteerInteractionReplayInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerInteractionReplayOutput> {
    assertValidSemanticOperationInput("interaction.replay", input);
    return this.runWithOperationTimeout(
      "interaction.replay",
      async (timeout) => this.replayInteractionTraceById(input.traceId, input.pageRef, timeout),
      options,
    );
  }

  async beautifyScript(
    input: OpensteerScriptBeautifyInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerScriptBeautifyOutput> {
    assertValidSemanticOperationInput("scripts.beautify", input);

    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "scripts.beautify",
        async () => {
          const source = await this.resolveScriptTransformSource(input);
          const content = await beautifyScriptContent(source.content);
          return this.buildScriptTransformOutput({
            source,
            transformedContent: content,
            persist: input.persist !== false,
            transform: "beautify",
          });
        },
        options,
      );

      await this.appendTrace({
        operation: "scripts.beautify",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          bytesBefore: output.bytesBefore,
          bytesAfter: output.bytesAfter,
          ...(output.artifactId === undefined ? {} : { artifactId: output.artifactId }),
        },
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "scripts.beautify",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async deobfuscateScript(
    input: OpensteerScriptDeobfuscateInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerScriptDeobfuscateOutput> {
    assertValidSemanticOperationInput("scripts.deobfuscate", input);

    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "scripts.deobfuscate",
        async () => {
          const source = await this.resolveScriptTransformSource(input);
          const transformed = await deobfuscateScriptContent({
            content: source.content,
          });
          const persisted = await this.buildScriptTransformOutput({
            source,
            transformedContent: transformed.content,
            persist: input.persist !== false,
            transform: "deobfuscate",
          });
          return {
            ...persisted,
            transforms: transformed.transforms,
          } satisfies OpensteerScriptDeobfuscateOutput;
        },
        options,
      );

      await this.appendTrace({
        operation: "scripts.deobfuscate",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          bytesBefore: output.bytesBefore,
          bytesAfter: output.bytesAfter,
          transforms: output.transforms,
          ...(output.artifactId === undefined ? {} : { artifactId: output.artifactId }),
        },
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "scripts.deobfuscate",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async sandboxScript(
    input: OpensteerScriptSandboxInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerScriptSandboxOutput> {
    assertValidSemanticOperationInput("scripts.sandbox", input);

    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "scripts.sandbox",
        async () => {
          const source = await this.resolveScriptTransformSource(input);
          return runScriptSandbox({
            ...input,
            content: source.content,
          });
        },
        options,
      );

      await this.appendTrace({
        operation: "scripts.sandbox",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          capturedAjax: output.capturedAjax.length,
          errors: output.errors.length,
          durationMs: output.durationMs,
        },
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "scripts.sandbox",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async solveCaptcha(
    input: OpensteerCaptchaSolveInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerCaptchaSolveOutput> {
    assertValidSemanticOperationInput("captcha.solve", input);

    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "captcha.solve",
        async (timeout) => {
          const pageRef = input.pageRef ?? (await this.ensurePageRef());
          const captcha =
            resolveExplicitCaptchaInput(input) ??
            (await detectCaptchaOnPage(this.requireEngine(), pageRef));
          if (captcha === undefined) {
            throw new OpensteerProtocolError(
              "not-found",
              "no supported CAPTCHA challenge was detected on the current page",
            );
          }

          const solver =
            input.provider === "2captcha"
              ? createTwoCaptchaSolver(input.apiKey)
              : createCapSolver(input.apiKey);
          const solved = await solver.solve({
            type: captcha.type,
            siteKey: captcha.siteKey,
            pageUrl: captcha.pageUrl,
            signal: timeout.signal,
          });
          const injected = await injectCaptchaToken({
            engine: this.requireEngine(),
            pageRef,
            type: captcha.type,
            token: solved.token,
          });
          return {
            captcha,
            token: solved.token,
            injected,
            provider: input.provider,
          } satisfies OpensteerCaptchaSolveOutput;
        },
        options,
      );

      await this.appendTrace({
        operation: "captcha.solve",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          provider: output.provider,
          captcha: output.captcha.type,
          injected: output.injected,
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: input.pageRef ?? this.pageRef,
        }),
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "captcha.solve",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async inferRequestPlan(
    input: OpensteerInferRequestPlanInput,
    options: RuntimeOperationOptions = {},
  ): Promise<RequestPlanRecord> {
    assertValidSemanticOperationInput("request-plan.infer", input);

    const root = await this.ensureRoot();
    const startedAt = Date.now();
    try {
      const record = await this.runWithOperationTimeout(
        "request-plan.infer",
        async (timeout) => {
          const source = await this.resolveNetworkRecordByRecordId(input.recordId, timeout, {
            includeBodies: true,
          });
          const inferred = inferRequestPlanFromNetworkRecord(source, input, {
            ...(this.networkHistory.getObservedAt(source.recordId) === undefined
              ? {}
              : { observedAt: this.networkHistory.getObservedAt(source.recordId)! }),
          });
          return timeout.runStep(() =>
            root.registry.requestPlans.write({
              ...inferred,
              payload: normalizeRequestPlanPayload(inferred.payload),
            }),
          );
        },
        options,
      );

      await this.appendTrace({
        operation: "request-plan.infer",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          recordId: input.recordId,
          id: record.id,
          key: record.key,
          version: record.version,
        },
      });
      return record;
    } catch (error) {
      await this.appendTrace({
        operation: "request-plan.infer",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async writeRequestPlan(
    input: OpensteerWriteRequestPlanInput,
    options: RuntimeOperationOptions = {},
  ): Promise<RequestPlanRecord> {
    assertValidSemanticOperationInput("request-plan.write", input);

    const root = await this.ensureRoot();
    const startedAt = Date.now();
    try {
      const record = await this.runWithOperationTimeout(
        "request-plan.write",
        async (timeout) => {
          const payload = normalizeRequestPlanPayload(input.payload);
          return timeout.runStep(() =>
            root.registry.requestPlans.write({
              ...input,
              payload,
            }),
          );
        },
        options,
      );

      await this.appendTrace({
        operation: "request-plan.write",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          id: record.id,
          key: record.key,
          version: record.version,
        },
      });

      return record;
    } catch (error) {
      await this.appendTrace({
        operation: "request-plan.write",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async getRequestPlan(
    input: OpensteerGetRequestPlanInput,
    options: RuntimeOperationOptions = {},
  ): Promise<RequestPlanRecord> {
    assertValidSemanticOperationInput("request-plan.get", input);

    const root = await this.ensureRoot();
    const startedAt = Date.now();
    try {
      const record = await this.runWithOperationTimeout(
        "request-plan.get",
        async (timeout) => timeout.runStep(() => root.registry.requestPlans.resolve(input)),
        options,
      );
      if (record === undefined) {
        throw new OpensteerProtocolError(
          "not-found",
          input.version === undefined
            ? `no request plan found for "${input.key}"`
            : `no request plan found for "${input.key}" version "${input.version}"`,
          {
            details: {
              key: input.key,
              ...(input.version === undefined ? {} : { version: input.version }),
              kind: "request-plan",
            },
          },
        );
      }

      await this.appendTrace({
        operation: "request-plan.get",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          id: record.id,
          key: record.key,
          version: record.version,
        },
      });

      return record;
    } catch (error) {
      await this.appendTrace({
        operation: "request-plan.get",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async listRequestPlans(
    input: OpensteerListRequestPlansInput = {},
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerListRequestPlansOutput> {
    assertValidSemanticOperationInput("request-plan.list", input);

    const root = await this.ensureRoot();
    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "request-plan.list",
        async (timeout) => ({
          plans: await timeout.runStep(() => root.registry.requestPlans.list(input)),
        }),
        options,
      );

      await this.appendTrace({
        operation: "request-plan.list",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          ...(input.key === undefined ? {} : { key: input.key }),
          count: output.plans.length,
        },
      });

      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "request-plan.list",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async writeAuthRecipe(
    input: OpensteerWriteAuthRecipeInput,
    options: RuntimeOperationOptions = {},
  ): Promise<AuthRecipeRecord> {
    assertValidSemanticOperationInput("auth-recipe.write", input);

    const root = await this.ensureRoot();
    const startedAt = Date.now();
    try {
      const record = await this.runWithOperationTimeout(
        "auth-recipe.write",
        async (timeout) => timeout.runStep(() => root.registry.authRecipes.write(input)),
        options,
      );

      await this.appendTrace({
        operation: "auth-recipe.write",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          id: record.id,
          key: record.key,
          version: record.version,
        },
      });

      return record;
    } catch (error) {
      await this.appendTrace({
        operation: "auth-recipe.write",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async writeRecipe(
    input: OpensteerWriteRecipeInput,
    options: RuntimeOperationOptions = {},
  ): Promise<RecipeRecord> {
    assertValidSemanticOperationInput("recipe.write", input);

    const root = await this.ensureRoot();
    const startedAt = Date.now();
    try {
      const record = await this.runWithOperationTimeout(
        "recipe.write",
        async (timeout) => timeout.runStep(() => root.registry.recipes.write(input)),
        options,
      );

      await this.appendTrace({
        operation: "recipe.write",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          id: record.id,
          key: record.key,
          version: record.version,
        },
      });

      return record;
    } catch (error) {
      await this.appendTrace({
        operation: "recipe.write",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async getAuthRecipe(
    input: OpensteerGetAuthRecipeInput,
    options: RuntimeOperationOptions = {},
  ): Promise<AuthRecipeRecord> {
    assertValidSemanticOperationInput("auth-recipe.get", input);

    const root = await this.ensureRoot();
    const startedAt = Date.now();
    try {
      const record = await this.runWithOperationTimeout(
        "auth-recipe.get",
        async (timeout) => timeout.runStep(() => root.registry.authRecipes.resolve(input)),
        options,
      );
      if (record === undefined) {
        throw new OpensteerProtocolError(
          "not-found",
          input.version === undefined
            ? `no auth recipe found for "${input.key}"`
            : `no auth recipe found for "${input.key}" version "${input.version}"`,
          {
            details: {
              key: input.key,
              ...(input.version === undefined ? {} : { version: input.version }),
              kind: "auth-recipe",
            },
          },
        );
      }

      await this.appendTrace({
        operation: "auth-recipe.get",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          id: record.id,
          key: record.key,
          version: record.version,
        },
      });

      return record;
    } catch (error) {
      await this.appendTrace({
        operation: "auth-recipe.get",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async getRecipe(
    input: OpensteerGetRecipeInput,
    options: RuntimeOperationOptions = {},
  ): Promise<RecipeRecord> {
    assertValidSemanticOperationInput("recipe.get", input);

    const root = await this.ensureRoot();
    const startedAt = Date.now();
    try {
      const record = await this.runWithOperationTimeout(
        "recipe.get",
        async (timeout) => timeout.runStep(() => root.registry.recipes.resolve(input)),
        options,
      );
      if (record === undefined) {
        throw new OpensteerProtocolError(
          "not-found",
          input.version === undefined
            ? `no recipe found for "${input.key}"`
            : `no recipe found for "${input.key}" version "${input.version}"`,
          {
            details: {
              key: input.key,
              ...(input.version === undefined ? {} : { version: input.version }),
              kind: "recipe",
            },
          },
        );
      }

      await this.appendTrace({
        operation: "recipe.get",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          id: record.id,
          key: record.key,
          version: record.version,
        },
      });

      return record;
    } catch (error) {
      await this.appendTrace({
        operation: "recipe.get",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async listAuthRecipes(
    input: OpensteerListAuthRecipesInput = {},
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerListAuthRecipesOutput> {
    assertValidSemanticOperationInput("auth-recipe.list", input);

    const root = await this.ensureRoot();
    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "auth-recipe.list",
        async (timeout) => ({
          recipes: await timeout.runStep(() => root.registry.authRecipes.list(input)),
        }),
        options,
      );

      await this.appendTrace({
        operation: "auth-recipe.list",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          ...(input.key === undefined ? {} : { key: input.key }),
          count: output.recipes.length,
        },
      });

      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "auth-recipe.list",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async listRecipes(
    input: OpensteerListRecipesInput = {},
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerListRecipesOutput> {
    assertValidSemanticOperationInput("recipe.list", input);

    const root = await this.ensureRoot();
    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "recipe.list",
        async (timeout) => ({
          recipes: await timeout.runStep(() => root.registry.recipes.list(input)),
        }),
        options,
      );

      await this.appendTrace({
        operation: "recipe.list",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          ...(input.key === undefined ? {} : { key: input.key }),
          count: output.recipes.length,
        },
      });

      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "recipe.list",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async getCookies(
    input: { readonly urls?: readonly string[] } = {},
    options: RuntimeOperationOptions = {},
  ): Promise<readonly CookieRecord[]> {
    assertValidSemanticOperationInput("inspect.cookies", input);

    const pageRef = await this.ensurePageRef();
    const sessionRef = this.requireSessionRef();
    const startedAt = Date.now();
    try {
      const cookies = await this.runWithOperationTimeout(
        "inspect.cookies",
        async (timeout) =>
          timeout.runStep(() =>
            this.requireEngine().getCookies({
              sessionRef,
              ...(input.urls === undefined ? {} : { urls: input.urls }),
            }),
          ),
        options,
      );

      await this.appendTrace({
        operation: "inspect.cookies",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          count: cookies.length,
          ...(input.urls === undefined ? {} : { urls: input.urls }),
        },
        context: buildRuntimeTraceContext({
          sessionRef,
          pageRef,
        }),
      });

      return cookies;
    } catch (error) {
      await this.appendTrace({
        operation: "inspect.cookies",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        context: buildRuntimeTraceContext({
          sessionRef,
          pageRef,
        }),
      });
      throw error;
    }
  }

  async getStorageSnapshot(
    input: {
      readonly includeSessionStorage?: boolean;
      readonly includeIndexedDb?: boolean;
    } = {},
    options: RuntimeOperationOptions = {},
  ): Promise<StorageSnapshot> {
    assertValidSemanticOperationInput("inspect.storage", input);

    const pageRef = await this.ensurePageRef();
    const sessionRef = this.requireSessionRef();
    const startedAt = Date.now();
    try {
      const snapshot = await this.runWithOperationTimeout(
        "inspect.storage",
        async (timeout) =>
          timeout.runStep(() =>
            this.requireEngine().getStorageSnapshot({
              sessionRef,
              ...(input.includeSessionStorage === undefined
                ? {}
                : { includeSessionStorage: input.includeSessionStorage }),
              ...(input.includeIndexedDb === undefined
                ? {}
                : { includeIndexedDb: input.includeIndexedDb }),
            }),
          ),
        options,
      );

      await this.appendTrace({
        operation: "inspect.storage",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          origins: snapshot.origins.length,
          sessionStorage: snapshot.sessionStorage?.length ?? 0,
        },
        context: buildRuntimeTraceContext({
          sessionRef,
          pageRef,
        }),
      });

      return snapshot;
    } catch (error) {
      await this.appendTrace({
        operation: "inspect.storage",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        context: buildRuntimeTraceContext({
          sessionRef,
          pageRef,
        }),
      });
      throw error;
    }
  }

  async runAuthRecipe(
    input: OpensteerRunAuthRecipeInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerRunAuthRecipeOutput> {
    assertValidSemanticOperationInput("auth-recipe.run", input);

    await this.ensureRoot();
    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "auth-recipe.run",
        async (timeout) => this.runResolvedRecipe("auth-recipe", input, timeout),
        options,
      );

      await this.appendTrace({
        operation: "auth-recipe.run",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          recipe: output.recipe,
          variables: Object.keys(output.variables).sort(),
          ...(output.overrides === undefined ? {} : { overrides: output.overrides }),
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });

      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "auth-recipe.run",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });
      throw error;
    }
  }

  async runRecipe(
    input: OpensteerRunRecipeInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerRunRecipeOutput> {
    assertValidSemanticOperationInput("recipe.run", input);

    await this.ensureRoot();
    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "recipe.run",
        async (timeout) => this.runResolvedRecipe("recipe", input, timeout),
        options,
      );

      await this.appendTrace({
        operation: "recipe.run",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          recipe: output.recipe,
          variables: Object.keys(output.variables).sort(),
          ...(output.overrides === undefined ? {} : { overrides: output.overrides }),
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });

      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "recipe.run",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });
      throw error;
    }
  }

  async rawRequest(
    input: OpensteerRawRequestInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerRawRequestOutput> {
    assertValidSemanticOperationInput("request.raw", input);

    const transport = normalizeTransportKind(input.transport ?? "context-http");
    const binding = transportRequiresBrowserBinding(transport)
      ? await this.ensureBrowserTransportBinding()
      : this.currentBinding();
    const startedAt = Date.now();

    try {
      const output = await this.runWithOperationTimeout(
        "request.raw",
        async (timeout) => this.executeRawTransportRequest(input, timeout, binding),
        options,
      );

      await this.appendTrace({
        operation: "request.raw",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          recordId: output.recordId,
          request: {
            method: output.request.method,
            url: output.request.url,
          },
          response: {
            url: output.response.url,
            status: output.response.status,
            redirected: output.response.redirected,
          },
        },
        context: buildRuntimeTraceContext({
          sessionRef: binding?.sessionRef,
          pageRef: binding?.pageRef,
        }),
      });

      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "request.raw",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        context: buildRuntimeTraceContext({
          sessionRef: binding?.sessionRef,
          pageRef: binding?.pageRef,
        }),
      });
      throw error;
    }
  }

  async route(input: OpensteerRouteOptions): Promise<OpensteerRouteRegistration> {
    const binding = await this.ensureBrowserTransportBinding();
    const pageRef = input.pageRef ?? binding.pageRef;

    return this.requireEngine().registerRoute({
      sessionRef: binding.sessionRef,
      ...(input.pageRef === undefined ? {} : { pageRef }),
      urlPattern: input.urlPattern,
      ...(input.resourceTypes === undefined ? {} : { resourceTypes: input.resourceTypes }),
      ...(input.times === undefined ? {} : { times: input.times }),
      handler: async ({ request, fetchOriginal }) => {
        const decision = await input.handler({
          request,
          fetchOriginal,
        });

        if (decision.kind !== "fulfill") {
          return decision;
        }

        const routeBody =
          decision.body === undefined
            ? undefined
            : typeof decision.body === "string"
              ? bodyPayloadFromUtf8(decision.body, {
                  ...(decision.contentType === undefined
                    ? {}
                    : { mimeType: decision.contentType.split(";")[0] }),
                })
              : createBodyPayload(new Uint8Array(decision.body));

        return {
          kind: "fulfill",
          ...(decision.status === undefined ? {} : { status: decision.status }),
          ...(decision.headers === undefined ? {} : { headers: decision.headers }),
          ...(routeBody === undefined ? {} : { body: routeBody }),
          ...(decision.contentType === undefined ? {} : { contentType: decision.contentType }),
        };
      },
    });
  }

  async interceptScript(
    input: OpensteerInterceptScriptOptions,
  ): Promise<OpensteerRouteRegistration> {
    return this.route({
      ...(input.pageRef === undefined ? {} : { pageRef: input.pageRef }),
      urlPattern: input.urlPattern,
      resourceTypes: ["script"],
      ...(input.times === undefined ? {} : { times: input.times }),
      handler: async ({ request, fetchOriginal }) => {
        const original = await fetchOriginal();
        const content =
          original.body === undefined ? "" : Buffer.from(original.body.bytes).toString("utf8");
        const body = await input.handler({
          url: request.url,
          content,
          headers: original.headers,
          status: original.status,
        });
        return {
          kind: "fulfill",
          status: original.status,
          headers: original.headers,
          body,
          contentType:
            original.headers.find((header) => header.name.toLowerCase() === "content-type")
              ?.value ?? "application/javascript; charset=utf-8",
        };
      },
    });
  }

  async request(
    input: OpensteerRequestExecuteInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerRequestExecuteOutput> {
    assertValidSemanticOperationInput("request.execute", input);

    const root = await this.ensureRoot();
    const plan = await root.registry.requestPlans.resolve({
      key: input.key,
      ...(input.version === undefined ? {} : { version: input.version }),
    });
    if (plan === undefined) {
      throw new OpensteerProtocolError(
        "not-found",
        input.version === undefined
          ? `no request plan found for "${input.key}"`
          : `no request plan found for "${input.key}" version "${input.version}"`,
        {
          details: {
            key: input.key,
            ...(input.version === undefined ? {} : { version: input.version }),
            kind: "request-plan",
          },
        },
      );
    }
    const binding = transportRequiresBrowserBinding(
      normalizeTransportKind(plan.payload.transport.kind),
    )
      ? await this.ensureBrowserTransportBinding()
      : this.currentBinding();
    const startedAt = Date.now();

    try {
      const output = await this.runWithOperationTimeout(
        "request.execute",
        async (timeout) => this.executeResolvedRequestPlan(plan, input, timeout, binding),
        options,
      );

      await this.appendTrace({
        operation: "request.execute",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          plan: output.plan,
          request: {
            method: output.request.method,
            url: output.request.url,
          },
          response: {
            url: output.response.url,
            status: output.response.status,
            redirected: output.response.redirected,
          },
          ...(output.recovery === undefined ? {} : { recovery: output.recovery }),
        },
        context: buildRuntimeTraceContext({
          sessionRef: binding?.sessionRef,
          pageRef: binding?.pageRef,
        }),
      });

      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "request.execute",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        context: buildRuntimeTraceContext({
          sessionRef: binding?.sessionRef,
          pageRef: binding?.pageRef,
        }),
      });
      throw error;
    }
  }

  async computerExecute(
    input: OpensteerComputerExecuteInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerComputerExecuteOutput> {
    assertValidSemanticOperationInput("computer.execute", input);

    const pageRef = await this.ensurePageRef();
    const startedAt = Date.now();
    let mutationCaptureDiagnostics: MutationCaptureFinalizeDiagnostics | undefined;
    let boundaryDiagnostics: ActionBoundaryDiagnostics | undefined;

    try {
      const { artifacts, output } = await this.runMutationCapturedOperation(
        "computer.execute",
        {
          ...(input.captureNetwork === undefined ? {} : { captureNetwork: input.captureNetwork }),
          options,
        },
        async (timeout) => {
          try {
            const output = await this.requireComputer().execute({
              pageRef,
              input,
              timeout,
            });
            boundaryDiagnostics = takeActionBoundaryDiagnostics(timeout.signal);
            timeout.throwIfAborted();
            this.pageRef = output.pageRef;
            const artifacts = await this.persistComputerArtifacts(output, timeout);
            return {
              artifacts: { manifests: artifacts.manifests },
              output: artifacts.output,
            };
          } catch (error) {
            boundaryDiagnostics ??= takeActionBoundaryDiagnostics(timeout.signal);
            throw error;
          }
        },
        (diagnostics) => {
          mutationCaptureDiagnostics = diagnostics;
        },
      );

      await this.appendTrace({
        operation: "computer.execute",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        artifacts,
        events: output.events,
        data: {
          action: output.action,
          pageRef: output.pageRef,
          displayViewport: output.displayViewport,
          nativeViewport: output.nativeViewport,
          displayScale: output.displayScale,
          timing: output.timing,
          ...(boundaryDiagnostics === undefined ? {} : { settle: boundaryDiagnostics }),
          ...buildMutationCaptureTraceData(mutationCaptureDiagnostics),
          ...(output.trace === undefined ? {} : { trace: output.trace }),
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: output.pageRef,
          frameRef: output.screenshot.frameRef,
          documentRef: output.screenshot.documentRef,
          documentEpoch: output.screenshot.documentEpoch,
        }),
      });

      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "computer.execute",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        data: {
          ...(boundaryDiagnostics === undefined ? {} : { settle: boundaryDiagnostics }),
          ...buildMutationCaptureTraceData(mutationCaptureDiagnostics),
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });
      throw error;
    }
  }

  async close(options: RuntimeOperationOptions = {}): Promise<OpensteerSessionCloseOutput> {
    const engine = this.engine;
    const pageRef = this.pageRef;
    const sessionRef = this.sessionRef;
    const startedAt = Date.now();
    let closeError: unknown;

    try {
      await this.runWithOperationTimeout(
        "session.close",
        async (timeout) => {
          await timeout.runStep(() => this.flushPersistedNetworkHistory());
          if (engine === undefined) {
            return;
          }
          if (pageRef !== undefined) {
            await timeout.runStep(async () => {
              try {
                await engine.closePage({
                  pageRef,
                });
              } catch (error) {
                if (!isIgnorableRuntimeBindingError(error)) {
                  throw error;
                }
              }
            });
          }
          if (sessionRef !== undefined) {
            await timeout.runStep(async () => {
              try {
                await engine.closeSession({
                  sessionRef,
                });
              } catch (error) {
                if (!isIgnorableRuntimeBindingError(error)) {
                  throw error;
                }
              }
            });
          }
        },
        options,
      );
    } catch (error) {
      closeError = error;
    }

    const completedAt = Date.now();
    try {
      await this.appendTrace({
        operation: "session.close",
        startedAt,
        completedAt,
        outcome: closeError === undefined ? "ok" : "error",
        ...(closeError === undefined ? {} : { error: closeError }),
        context: buildRuntimeTraceContext({
          sessionRef,
          pageRef,
        }),
      });
    } finally {
      if (closeError !== undefined && engine !== undefined) {
        await this.cleanupSessionResources(engine, pageRef, sessionRef);
      }
      await this.resetRuntimeState({
        disposeEngine: true,
      });
      if (this.cleanupRootOnClose) {
        await rm(this.rootPath, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    if (closeError !== undefined) {
      throw closeError;
    }

    return {
      closed: true,
    };
  }

  async disconnect(): Promise<void> {
    try {
      await this.flushPersistedNetworkHistory();
    } finally {
      await this.resetRuntimeState({
        disposeEngine: true,
      });
      if (this.cleanupRootOnClose) {
        await rm(this.rootPath, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  isOpen(): boolean {
    return this.sessionRef !== undefined && this.pageRef !== undefined;
  }

  private async runDomAction<
    TInput extends {
      readonly target: OpensteerTargetInput;
      readonly persistAsDescription?: string;
      readonly captureNetwork?: string;
    },
  >(
    operation: "dom.click" | "dom.hover" | "dom.input" | "dom.scroll",
    input: TInput,
    executor: (
      pageRef: PageRef,
      target: DomTargetRef,
      timeout: TimeoutExecutionContext,
    ) => Promise<{
      readonly result:
        | DomActionOutcome
        | {
            readonly resolved: ResolvedDomTarget;
            readonly point?: undefined;
          };
    }>,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerActionResult> {
    const pageRef = await this.ensurePageRef();
    const startedAt = Date.now();
    let mutationCaptureDiagnostics: MutationCaptureFinalizeDiagnostics | undefined;
    let boundaryDiagnostics: ActionBoundaryDiagnostics | undefined;

    try {
      const { executed, preparedTarget } = await this.runMutationCapturedOperation(
        operation,
        {
          ...(input.captureNetwork === undefined ? {} : { captureNetwork: input.captureNetwork }),
          options,
        },
        async (timeout) => {
          const preparedTarget = await this.prepareDomTarget(
            pageRef,
            operation,
            input.target,
            input.persistAsDescription,
            timeout,
          );
          try {
            const executed = await executor(pageRef, preparedTarget.target, timeout);
            boundaryDiagnostics = takeActionBoundaryDiagnostics(timeout.signal);
            return {
              executed,
              preparedTarget,
            };
          } catch (error) {
            boundaryDiagnostics ??= takeActionBoundaryDiagnostics(timeout.signal);
            throw error;
          }
        },
        (diagnostics) => {
          mutationCaptureDiagnostics = diagnostics;
        },
      );
      const output = toOpensteerActionResult(executed.result, preparedTarget.persistedDescription);
      const actionEvents =
        "events" in executed.result ? executed.result.events : undefined;

      await this.appendTrace({
        operation,
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        ...(actionEvents === undefined ? {} : { events: actionEvents }),
        data: {
          target: output.target,
          ...(output.point === undefined ? {} : { point: output.point }),
          ...(output.persistedDescription === undefined
            ? {}
            : { persistedDescription: output.persistedDescription }),
          ...(boundaryDiagnostics === undefined ? {} : { settle: boundaryDiagnostics }),
          ...buildMutationCaptureTraceData(mutationCaptureDiagnostics),
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef,
          frameRef: executed.result.resolved.frameRef,
          documentRef: executed.result.resolved.documentRef,
          documentEpoch: executed.result.resolved.documentEpoch,
        }),
      });

      return output;
    } catch (error) {
      await this.appendTrace({
        operation,
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
        data: {
          ...(boundaryDiagnostics === undefined ? {} : { settle: boundaryDiagnostics }),
          ...buildMutationCaptureTraceData(mutationCaptureDiagnostics),
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef,
        }),
      });
      throw error;
    }
  }

  private async prepareDomTarget(
    pageRef: PageRef,
    method: string,
    target: OpensteerTargetInput,
    persistAsDescription: string | undefined,
    timeout: TimeoutExecutionContext,
  ): Promise<{
    readonly target: DomTargetRef;
    readonly persistedDescription?: string;
  }> {
    const domTarget = this.toDomTargetRef(target);
    if (target.kind === "description") {
      return {
        target: domTarget,
      };
    }

    if (persistAsDescription === undefined) {
      return {
        target: domTarget,
      };
    }

    if (target.kind === "element") {
      const elementTarget: DomTargetRef = {
        kind: "selector",
        selector: `[c="${String(target.element)}"]`,
      };

      const resolved = await timeout.runStep(() =>
        this.requireDom().resolveTarget({
          pageRef,
          method,
          target: elementTarget,
        }),
      );
      const stablePath =
        resolved.replayPath ??
        (await timeout.runStep(() =>
          this.requireDom().buildPath({
            locator: resolved.locator,
          }),
        ));

      await timeout.runStep(() =>
        this.requireDom().writeDescriptor({
          method,
          description: persistAsDescription,
          path: stablePath,
          sourceUrl: resolved.snapshot.url,
        }),
      );
      return {
        target: {
          kind: "descriptor",
          description: persistAsDescription,
        },
        persistedDescription: persistAsDescription,
      };
    }

    const resolved = await timeout.runStep(() =>
      this.requireDom().resolveTarget({
        pageRef,
        method,
        target: domTarget,
      }),
    );
    const stablePath =
      resolved.replayPath ??
      (await timeout.runStep(() =>
        this.requireDom().buildPath({
          locator: resolved.locator,
        }),
      ));
    if (!stablePath) {
      throw new Error(
        `unable to persist "${persistAsDescription}" because no stable DOM path could be built for ${method}`,
      );
    }

    await timeout.runStep(() =>
      this.requireDom().writeDescriptor({
        method,
        description: persistAsDescription,
        path: stablePath,
        sourceUrl: resolved.snapshot.url,
      }),
    );

    return {
      target: {
        kind: "descriptor",
        description: persistAsDescription,
      },
      persistedDescription: persistAsDescription,
    };
  }

  private async queryLiveNetwork(
    input: OpensteerNetworkQueryInput,
    timeout: TimeoutExecutionContext,
    options: {
      readonly ignoreLimit?: boolean;
      readonly redactSecretHeaders?: boolean;
    } = {},
  ): Promise<readonly NetworkQueryRecord[]> {
    const requestIds = resolveLiveQueryRequestIds(input, this.networkHistory);
    if (requestIds !== undefined && requestIds.length === 0) {
      return [];
    }

    const pageRef = resolveLiveQueryPageRef(input, this.pageRef, requestIds, this.networkHistory);
    const includeCurrentPageOnly = pageRef === undefined && input.recordId === undefined;
    const metadataRecords = await timeout.runStep(() =>
      this.readLiveNetworkRecords(
        {
          ...(pageRef === undefined ? {} : { pageRef }),
          includeBodies: false,
          includeCurrentPageOnly,
          ...(requestIds === undefined ? {} : { requestIds }),
          ...(options.redactSecretHeaders === undefined
            ? {}
            : { redactSecretHeaders: options.redactSecretHeaders }),
          ...buildEngineNetworkRecordFilters(input),
        },
        timeout.signal,
      ),
    );
    const filtered = filterNetworkQueryRecords(metadataRecords, {
      ...(input.recordId === undefined ? {} : { recordId: input.recordId }),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.capture === undefined ? {} : { capture: input.capture }),
      ...(input.tag === undefined ? {} : { tag: input.tag }),
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.hostname === undefined ? {} : { hostname: input.hostname }),
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
    });
    const sorted = sortLiveNetworkRecords(filtered, this.networkHistory);
    const limit = options.ignoreLimit
      ? sorted.length
      : Math.max(1, Math.min(input.limit ?? 50, 200));
    const limited = sorted.slice(0, limit);

    if (!(input.includeBodies ?? false) || limited.length === 0) {
      return limited;
    }

    const withBodies = await timeout.runStep(() =>
      this.readLiveNetworkRecords(
        {
          ...(pageRef === undefined ? {} : { pageRef }),
          includeBodies: true,
          requestIds: limited.map((record) => record.record.requestId),
          includeCurrentPageOnly,
          ...(options.redactSecretHeaders === undefined
            ? {}
            : { redactSecretHeaders: options.redactSecretHeaders }),
        },
        timeout.signal,
      ),
    );
    const byRequestId = new Map(withBodies.map((record) => [record.record.requestId, record]));
    return limited.map((record) => byRequestId.get(record.record.requestId) ?? record);
  }

  private async captureScriptsInternal(
    pageRef: PageRef,
    input: OpensteerCaptureScriptsInput,
    timeout: TimeoutExecutionContext,
  ): Promise<OpensteerCaptureScriptsOutput> {
    const root = await this.ensureRoot();
    const evaluated = await timeout.runStep(() =>
      this.requireEngine().evaluatePage({
        pageRef,
        script: `() => {
          const navigationEntry = performance.getEntriesByType("navigation")[0];
          const loadEventStart =
            navigationEntry && typeof navigationEntry.loadEventStart === "number"
              ? navigationEntry.loadEventStart
              : undefined;
          const scripts = Array.from(document.scripts).map((script, index) => ({
            loadOrder: index,
            url: script.src || undefined,
            type: script.type || undefined,
            source: script.src ? "external" : "inline",
            content: script.src ? "" : script.textContent || "",
          }));
          const resourceEntries = Array.from(performance.getEntriesByType("resource"))
            .map((entry) => ({
              url: entry.name,
              initiatorType: entry.initiatorType || undefined,
              startTime: typeof entry.startTime === "number" ? entry.startTime : undefined,
            }))
            .filter((entry) => typeof entry.url === "string" && entry.url.length > 0);
          return { loadEventStart, scripts, resourceEntries };
        }`,
      }),
    );
    const pageScripts = normalizePageScriptScan(evaluated.data);
    const resourceEntriesByUrl = new Map(
      pageScripts.resourceEntries.map((entry) => [entry.url, entry]),
    );
    const workerUrls = new Set(
      pageScripts.resourceEntries
        .filter((entry) => entry.initiatorType === "worker")
        .map((entry) => entry.url),
    );
    const urlFilter = input.urlFilter?.trim();
    const networkRecords = await this.queryLiveNetwork(
      {
        pageRef,
        ...(input.includeWorkers === true ? {} : { resourceType: "script" }),
        includeBodies: true,
      },
      timeout,
      {
        ignoreLimit: true,
      },
    );
    const networkContentByUrl = new Map<string, string>();
    for (const record of networkRecords) {
      if (record.record.responseBody === undefined) {
        continue;
      }
      networkContentByUrl.set(
        record.record.url,
        Buffer.from(record.record.responseBody.data, "base64").toString("utf8"),
      );
    }

    const scripts: OpensteerCaptureScriptsOutput["scripts"][number][] = [];
    const domUrls = new Set<string>();
    let nextDynamicOrder = pageScripts.scripts.length;

    for (const script of pageScripts.scripts) {
      if (script.url !== undefined) {
        domUrls.add(script.url);
      }

      if (script.source === "inline") {
        if (input.includeInline === false) {
          continue;
        }
        if (urlFilter !== undefined) {
          continue;
        }
        scripts.push(
          await this.materializeCapturedScript(
            root,
            pageRef,
            {
              source: "inline",
              hash: sha256Hex(Buffer.from(script.content, "utf8")),
              loadOrder: script.loadOrder,
              content: script.content,
              ...(script.type === undefined ? {} : { type: script.type }),
            },
            input.persist !== false,
          ),
        );
        continue;
      }

      if (script.url === undefined) {
        continue;
      }
      if (urlFilter !== undefined && !script.url.includes(urlFilter)) {
        continue;
      }
      const resourceEntry = resourceEntriesByUrl.get(script.url);
      const source = workerUrls.has(script.url)
        ? "worker"
        : pageScripts.loadEventStart !== undefined &&
            resourceEntry?.startTime !== undefined &&
            resourceEntry.startTime >= pageScripts.loadEventStart
          ? "dynamic"
          : "external";
      if (source === "external" && input.includeExternal === false) {
        continue;
      }
      if (source === "worker" && input.includeWorkers !== true) {
        continue;
      }
      if (source === "dynamic" && input.includeDynamic === false) {
        continue;
      }
      const content = networkContentByUrl.get(script.url) ?? "";
      scripts.push(
        await this.materializeCapturedScript(
          root,
          pageRef,
          {
            source,
            url: script.url,
            hash: sha256Hex(Buffer.from(content, "utf8")),
            loadOrder: script.loadOrder,
            content,
            ...(script.type === undefined ? {} : { type: script.type }),
          },
          input.persist !== false,
        ),
      );
    }

    if (input.includeDynamic !== false || input.includeWorkers === true) {
      for (const record of networkRecords) {
        if (record.record.resourceType !== "script") {
          continue;
        }
        if (domUrls.has(record.record.url)) {
          continue;
        }
        if (urlFilter !== undefined && !record.record.url.includes(urlFilter)) {
          continue;
        }
        const source =
          workerUrls.has(record.record.url) ||
          record.record.source?.workerRef !== undefined ||
          (input.includeWorkers === true &&
            record.record.initiator?.type !== undefined &&
            record.record.initiator.type !== "parser" &&
            record.record.initiator.type !== "script")
            ? "worker"
            : "dynamic";
        if (source === "worker" ? input.includeWorkers !== true : input.includeDynamic === false) {
          continue;
        }
        const content = networkContentByUrl.get(record.record.url) ?? "";
        scripts.push(
          await this.materializeCapturedScript(
            root,
            pageRef,
            {
              source,
              url: record.record.url,
              hash: sha256Hex(Buffer.from(content, "utf8")),
              loadOrder: nextDynamicOrder++,
              content,
            },
            input.persist !== false,
          ),
        );
      }
    }

    return {
      pageRef,
      scripts,
    };
  }

  private async materializeCapturedScript(
    root: OpensteerRuntimeWorkspace,
    pageRef: PageRef,
    data: ScriptSourceArtifactData,
    persist: boolean,
  ): Promise<OpensteerCaptureScriptsOutput["scripts"][number]> {
    if (!persist) {
      return data;
    }
    const manifest = await root.artifacts.writeStructured({
      kind: "script-source",
      scope: {
        ...(this.sessionRef === undefined ? {} : { sessionRef: this.sessionRef }),
        pageRef,
      },
      data,
    });
    return {
      ...data,
      artifactId: manifest.artifactId,
    };
  }

  private async runMutationCapturedOperation<T>(
    operation: OpensteerSemanticOperationName,
    input: {
      readonly captureNetwork?: string;
      readonly options?: RuntimeOperationOptions;
    },
    execute: (timeout: TimeoutExecutionContext) => Promise<T>,
    onFinalized?: (diagnostics: MutationCaptureFinalizeDiagnostics) => void,
  ): Promise<T> {
    let plan: MutationCapturePlan | undefined;

    try {
      const result = await this.runWithOperationTimeout(
        operation,
        async (timeout) => {
          plan = await this.beginMutationCapture(timeout, input.captureNetwork);
          return execute(timeout);
        },
        input.options,
      );
      const diagnostics = await this.finalizeMutationCaptureBestEffort(plan);
      onFinalized?.(diagnostics);
      return result;
    } catch (error) {
      const diagnostics = await this.finalizeMutationCaptureBestEffort(plan);
      onFinalized?.(diagnostics);
      throw error;
    }
  }

  private async beginMutationCapture(
    timeout: TimeoutExecutionContext,
    capture: string | undefined,
  ): Promise<MutationCapturePlan | undefined> {
    if (capture === undefined) {
      return undefined;
    }

    return {
      baselineRequestIds: await this.readLiveRequestIds(timeout, {
        includeCurrentPageOnly: true,
      }),
      capture,
    };
  }

  private async finalizeMutationCaptureBestEffort(
    plan: MutationCapturePlan | undefined,
  ): Promise<MutationCaptureFinalizeDiagnostics> {
    if (plan === undefined) {
      return {};
    }

    try {
      await withDetachedTimeoutSignal(MUTATION_CAPTURE_FINALIZE_TIMEOUT_MS, async (signal) => {
        await this.completeMutationCaptureWithSignal(signal, plan);
      });
      return {};
    } catch (error) {
      return {
        finalizeError: normalizeOpensteerError(error),
      };
    }
  }

  private async completeMutationCaptureWithSignal(
    signal: AbortSignal,
    plan: MutationCapturePlan,
  ): Promise<void> {
    const records = await this.readLiveNetworkRecords(
      {
        includeBodies: false,
        includeCurrentPageOnly: true,
      },
      signal,
    );
    const delta = records.filter((record) => !plan.baselineRequestIds.has(record.record.requestId));
    if (delta.length === 0) {
      return;
    }
    this.networkHistory.assignCapture(delta, plan.capture);
    await this.persistLiveRequestIdsWithSignal(
      delta.map((record) => record.record.requestId),
      signal,
      {
        includeCurrentPageOnly: true,
      },
    );
  }

  private async resolveNetworkRecordByRecordId(
    recordId: string,
    timeout: TimeoutExecutionContext,
    options: {
      readonly includeBodies: boolean;
      readonly redactSecretHeaders?: boolean;
    },
  ): Promise<NetworkQueryRecord> {
    const root = await this.ensureRoot();
    await this.syncPersistedNetworkSelection(
      timeout,
      {
        recordId,
        includeBodies: options.includeBodies,
      },
      {
        includeBodies: options.includeBodies,
      },
    );
    const saved = await timeout.runStep(() =>
      root.registry.savedNetwork.getByRecordId(recordId, {
        includeBodies: options.includeBodies,
      }),
    );
    if (saved) {
      return saved;
    }

    const live = await this.queryLiveNetwork(
      {
        recordId,
        includeBodies: options.includeBodies,
        limit: 1,
      },
      timeout,
      {
        ignoreLimit: true,
        ...(options.redactSecretHeaders === undefined
          ? {}
          : { redactSecretHeaders: options.redactSecretHeaders }),
      },
    );
    if (live[0] !== undefined) {
      return live[0];
    }
    throw new OpensteerProtocolError("not-found", `network record ${recordId} was not found`, {
      details: {
        recordId,
        kind: "network-record",
      },
    });
  }

  private resolveCurrentStateSource(): OpensteerStateSourceKind {
    const ownership = this.sessionInfoBase.provider?.ownership;
    if (ownership === "attached") {
      return "attach";
    }
    if (this.workspaceName !== undefined || this.cleanupRootOnClose === false) {
      return "persistent";
    }
    return "temporary";
  }

  private async resolveReverseCaseById(caseId: string): Promise<ReverseCaseRecord> {
    const record = await (await this.ensureRoot()).registry.reverseCases.getById(caseId);
    if (record === undefined) {
      throw new OpensteerProtocolError("not-found", `reverse case ${caseId} was not found`, {
        details: {
          caseId,
          kind: "reverse-case",
        },
      });
    }
    return record;
  }

  private async tryResolveReverseCaseById(caseId: string): Promise<ReverseCaseRecord | undefined> {
    return (await this.ensureRoot()).registry.reverseCases.getById(caseId);
  }

  private async resolveReversePackageById(packageId: string): Promise<ReversePackageRecord> {
    const record = await (await this.ensureRoot()).registry.reversePackages.getById(packageId);
    if (record === undefined) {
      throw new OpensteerProtocolError("not-found", `reverse package ${packageId} was not found`, {
        details: {
          packageId,
          kind: "reverse-package",
        },
      });
    }
    return record;
  }

  private async resolveReverseReportById(reportId: string): Promise<ReverseReportRecord> {
    const record = await (await this.ensureRoot()).registry.reverseReports.getById(reportId);
    if (record === undefined) {
      throw new OpensteerProtocolError("not-found", `reverse report ${reportId} was not found`, {
        details: {
          reportId,
          kind: "reverse-report",
        },
      });
    }
    return record;
  }

  private async resolveReverseReportByPackageId(packageId: string): Promise<ReverseReportRecord> {
    const reports = await (await this.ensureRoot()).registry.reverseReports.list();
    const report = reports
      .filter((entry) => entry.payload.packageId === packageId)
      .sort(
        (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id),
      )[0];
    if (report === undefined) {
      throw new OpensteerProtocolError(
        "not-found",
        `reverse report for package ${packageId} was not found`,
        {
          details: {
            packageId,
            kind: "reverse-report",
          },
        },
      );
    }
    return report;
  }

  private async resolveReverseReportByCaseId(
    caseId: string,
    kind: OpensteerReverseReportKind,
  ): Promise<ReverseReportRecord> {
    const reports = await (await this.ensureRoot()).registry.reverseReports.list();
    const report = reports
      .filter((entry) => entry.payload.caseId === caseId && entry.payload.kind === kind)
      .sort(
        (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id),
      )[0];
    if (report === undefined) {
      throw new OpensteerProtocolError(
        "not-found",
        `reverse ${kind} report for case ${caseId} was not found`,
        {
          details: {
            caseId,
            kind: "reverse-report",
          },
        },
      );
    }
    return report;
  }

  private async resolveInteractionTraceById(traceId: string): Promise<InteractionTraceRecord> {
    const trace = await (await this.ensureRoot()).registry.interactionTraces.getById(traceId);
    if (trace === undefined) {
      throw new OpensteerProtocolError("not-found", `interaction trace ${traceId} was not found`, {
        details: {
          traceId,
          kind: "interaction-trace",
        },
      });
    }
    return trace;
  }

  private async captureReverseStateSnapshot(
    pageRef: PageRef,
    timeout: TimeoutExecutionContext,
    options: {
      readonly includeStorage: boolean;
      readonly includeSessionStorage: boolean;
      readonly includeIndexedDb: boolean;
      readonly globalNames?: readonly string[];
    },
  ): Promise<OpensteerStateSnapshot> {
    const pageInfo = await timeout.runStep(() => this.requireEngine().getPageInfo({ pageRef }));
    const cookies = await timeout.runStep(() =>
      this.requireEngine().getCookies({
        sessionRef: pageInfo.sessionRef,
        urls: [pageInfo.url],
      }),
    );
    const storage = options.includeStorage
      ? await timeout.runStep(() =>
          this.requireEngine().getStorageSnapshot({
            sessionRef: pageInfo.sessionRef,
            includeSessionStorage: options.includeSessionStorage,
            includeIndexedDb: options.includeIndexedDb,
          }),
        )
      : undefined;
    const pageState = await timeout.runStep(() =>
      this.requireEngine().evaluatePage({
        pageRef,
        script: CAPTURE_PAGE_STATE_SCRIPT,
        args: [
          {
            globalNames: [...(options.globalNames ?? [])],
          },
        ],
      }),
    );

    return {
      id: `state:${randomUUID()}`,
      capturedAt: Date.now(),
      pageRef,
      url: pageInfo.url,
      cookies: cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
        ...(cookie.priority === undefined ? {} : { priority: cookie.priority }),
        ...(cookie.partitionKey === undefined ? {} : { partitionKey: cookie.partitionKey }),
        session: cookie.session,
        ...(cookie.expiresAt === undefined ? {} : { expiresAt: cookie.expiresAt }),
      })),
      ...(storage === undefined ? {} : { storage }),
      ...(Array.isArray((pageState.data as { hiddenFields?: unknown }).hiddenFields)
        ? {
            hiddenFields: (
              pageState.data as {
                hiddenFields: readonly { path: string; name: string; value: string }[];
              }
            ).hiddenFields,
          }
        : {}),
      ...(pageState.data !== null &&
      typeof pageState.data === "object" &&
      !Array.isArray(pageState.data) &&
      "globals" in pageState.data
        ? {
            globals: (pageState.data as { globals?: Readonly<Record<string, unknown>> }).globals,
          }
        : {}),
    };
  }

  private async restoreReverseStateSnapshots(
    snapshots: readonly OpensteerStateSnapshot[],
    candidate: OpensteerReverseCandidateRecord,
    timeout: TimeoutExecutionContext,
    explicitPageRef: PageRef | undefined,
  ): Promise<void> {
    if (snapshots.length === 0) {
      return;
    }

    const pageRef = explicitPageRef ?? (await this.ensurePageRef());
    const engine = this.requireEngine();
    const pageInfo = await timeout.runStep(() => engine.getPageInfo({ pageRef }));
    const cookies = mergeReverseStateSnapshotCookies(snapshots, pageInfo.sessionRef);
    if (cookies.length > 0) {
      await timeout.runStep(() =>
        engine.setCookies({
          sessionRef: pageInfo.sessionRef,
          cookies,
        }),
      );
    }

    const currentPageOrigin = originFromUrl(pageInfo.url);
    const targetUrl = resolveReverseReplayStateRestoreUrl(candidate, snapshots, pageInfo.url);
    const targetOrigin = originFromUrl(targetUrl);
    const localStorageByOrigin = mergeReverseStateSnapshotLocalStorage(snapshots);
    const sessionStorageByOrigin = mergeReverseStateSnapshotSessionStorage(snapshots);

    if (
      targetOrigin !== undefined &&
      (localStorageByOrigin.has(targetOrigin) || sessionStorageByOrigin.has(targetOrigin))
    ) {
      if (currentPageOrigin !== targetOrigin) {
        await this.navigatePage(
          {
            operation: "page.goto",
            pageRef,
            url: buildReverseStateRestoreNavigationUrl(targetUrl, targetOrigin),
          },
          timeout,
        );
      }
      await timeout.runStep(() =>
        engine.evaluatePage({
          pageRef,
          script: RESTORE_PAGE_STORAGE_SCRIPT,
          args: [
            {
              ...(localStorageByOrigin.has(targetOrigin)
                ? { localStorageEntries: localStorageByOrigin.get(targetOrigin) ?? [] }
                : {}),
              ...(sessionStorageByOrigin.has(targetOrigin)
                ? { sessionStorageEntries: sessionStorageByOrigin.get(targetOrigin) ?? [] }
                : {}),
            },
          ],
        }),
      );
      localStorageByOrigin.delete(targetOrigin);
      sessionStorageByOrigin.delete(targetOrigin);
    }

    for (const [origin, localStorageEntries] of localStorageByOrigin.entries()) {
      const createdPage = await timeout.runStep(() =>
        engine.createPage({
          sessionRef: pageInfo.sessionRef,
        }),
      );
      const restorePageRef = createdPage.data.pageRef;
      try {
        await this.navigatePage(
          {
            operation: "page.goto",
            pageRef: restorePageRef,
            url: buildReverseStateRestoreNavigationUrl(undefined, origin),
          },
          timeout,
        );
        await timeout.runStep(() =>
          engine.evaluatePage({
            pageRef: restorePageRef,
            script: RESTORE_PAGE_STORAGE_SCRIPT,
            args: [
              {
                localStorageEntries,
              },
            ],
          }),
        );
      } finally {
        await engine.closePage({ pageRef: restorePageRef }).catch(() => undefined);
      }
    }
  }

  private async waitForObservedReplayRecord(
    capturedRecord: NetworkQueryRecord,
    baselineRequestIds: ReadonlySet<string>,
    timeout: TimeoutExecutionContext,
    pageRef: PageRef,
  ): Promise<NetworkQueryRecord | undefined> {
    const method = capturedRecord.record.method;
    const url = capturedRecord.record.url;
    while (true) {
      timeout.throwIfAborted();
      const records = await this.queryLiveNetwork(
        {
          pageRef,
          url,
          method,
          includeBodies: true,
          limit: 50,
        },
        timeout,
        {
          ignoreLimit: true,
          redactSecretHeaders: false,
        },
      );
      const match = [...records]
        .reverse()
        .find(
          (record) =>
            !baselineRequestIds.has(record.record.requestId) &&
            this.isObservedReplayRecordSettled(record),
        );
      if (match !== undefined) {
        return match;
      }
      const remainingMs = timeout.remainingMs();
      if (remainingMs !== undefined && remainingMs <= 0) {
        return undefined;
      }
      await runtimeDelay(Math.min(200, remainingMs ?? 200));
    }
  }

  private async waitForMatchingReplayRecord(
    filter: {
      readonly channel?: OpensteerReverseCandidateRecord["channel"]["kind"];
      readonly method?: string;
      readonly url?: string;
      readonly host?: string;
      readonly path?: string;
      readonly status?: number;
      readonly text?: string;
    },
    baselineRequestIds: ReadonlySet<string>,
    timeout: TimeoutExecutionContext,
    pageRef: PageRef,
  ): Promise<NetworkQueryRecord | undefined> {
    while (true) {
      timeout.throwIfAborted();
      const records = await this.queryLiveNetwork(
        {
          pageRef,
          ...(filter.url === undefined ? {} : { url: filter.url }),
          ...(filter.host === undefined ? {} : { hostname: filter.host }),
          ...(filter.path === undefined ? {} : { path: filter.path }),
          ...(filter.method === undefined ? {} : { method: filter.method }),
          includeBodies: true,
          limit: 100,
        },
        timeout,
        {
          ignoreLimit: true,
          redactSecretHeaders: false,
        },
      );
      const match = [...records]
        .reverse()
        .find(
          (record) =>
            !baselineRequestIds.has(record.record.requestId) &&
            this.isObservedReplayRecordSettled(record) &&
            matchesReverseAwaitRecordFilter(record, filter),
        );
      if (match !== undefined) {
        return match;
      }
      const remainingMs = timeout.remainingMs();
      if (remainingMs !== undefined && remainingMs <= 0) {
        return undefined;
      }
      await runtimeDelay(Math.min(200, remainingMs ?? 200));
    }
  }

  private isObservedReplayRecordSettled(record: NetworkQueryRecord): boolean {
    if (record.record.captureState !== "complete") {
      return false;
    }
    switch (record.record.kind) {
      case "http":
      case "event-stream":
        return (
          record.record.status !== undefined ||
          record.record.responseBodyState === "complete" ||
          record.record.responseBodyState === "failed" ||
          record.record.responseBodyState === "skipped"
        );
      case "websocket":
        return true;
    }
  }

  private async replayInteractionTraceById(
    traceId: string,
    explicitPageRef: PageRef | undefined,
    timeout: TimeoutExecutionContext,
  ): Promise<OpensteerInteractionReplayOutput> {
    const trace = await this.resolveInteractionTraceById(traceId);
    const pageRef = explicitPageRef ?? trace.payload.pageRef ?? (await this.ensurePageRef());
    try {
      const result = await timeout.runStep(() =>
        this.requireEngine().evaluatePage({
          pageRef,
          script: INTERACTION_REPLAY_SCRIPT,
          args: [trace.payload.events],
        }),
      );
      const replayedEventCount =
        typeof (result.data as { replayedEventCount?: unknown }).replayedEventCount === "number"
          ? (result.data as { replayedEventCount: number }).replayedEventCount
          : trace.payload.events.length;
      return {
        traceId: trace.id,
        replayedEventCount,
        success: true,
      };
    } catch (error) {
      return {
        traceId: trace.id,
        replayedEventCount: 0,
        success: false,
        error: normalizeRuntimeErrorMessage(error),
      };
    }
  }

  private async readBrowserNetworkRecords(
    input: {
      readonly pageRef?: PageRef;
      readonly requestIds?: readonly string[];
      readonly url?: string;
      readonly hostname?: string;
      readonly path?: string;
      readonly method?: string;
      readonly status?: string;
      readonly resourceType?: NetworkQueryRecord["record"]["resourceType"];
      readonly includeBodies: boolean;
      readonly includeCurrentPageOnly?: boolean;
    },
    signal: AbortSignal,
  ): Promise<readonly BrowserNetworkRecord[]> {
    const sessionRef = this.sessionRef;
    if (!sessionRef) {
      throw new Error("Opensteer session is not initialized");
    }

    return this.requireEngine().getNetworkRecords({
      sessionRef,
      ...(input.includeCurrentPageOnly === false || input.pageRef !== undefined
        ? input.pageRef === undefined
          ? {}
          : { pageRef: input.pageRef }
        : this.pageRef === undefined
          ? {}
          : { pageRef: this.pageRef }),
      ...(input.requestIds === undefined ? {} : { requestIds: input.requestIds }),
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.hostname === undefined ? {} : { hostname: input.hostname }),
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
      includeBodies: input.includeBodies,
      signal,
    });
  }

  private async readLiveNetworkRecords(
    input: {
      readonly pageRef?: PageRef;
      readonly requestIds?: readonly string[];
      readonly url?: string;
      readonly hostname?: string;
      readonly path?: string;
      readonly method?: string;
      readonly status?: string;
      readonly resourceType?: NetworkQueryRecord["record"]["resourceType"];
      readonly includeBodies: boolean;
      readonly includeCurrentPageOnly?: boolean;
      readonly redactSecretHeaders?: boolean;
    },
    signal: AbortSignal,
  ): Promise<readonly NetworkQueryRecord[]> {
    const records = await this.readBrowserNetworkRecords(input, signal);
    return this.networkHistory.materialize(records, {
      redactSecretHeaders: input.redactSecretHeaders ?? true,
    });
  }

  private async persistLiveRequestIds(
    requestIds: readonly string[],
    timeout: TimeoutExecutionContext,
    options: {
      readonly includeCurrentPageOnly: boolean;
      readonly pageRef?: PageRef;
    },
  ): Promise<readonly NetworkQueryRecord[]> {
    return timeout.runStep(() =>
      this.persistLiveRequestIdsWithSignal(requestIds, timeout.signal, options),
    );
  }

  private async persistLiveRequestIdsWithSignal(
    requestIds: readonly string[],
    signal: AbortSignal,
    options: {
      readonly includeCurrentPageOnly: boolean;
      readonly pageRef?: PageRef;
    },
  ): Promise<readonly NetworkQueryRecord[]> {
    if (requestIds.length === 0) {
      return [];
    }
    const root = await this.ensureRoot();
    const browserRecords = await this.readBrowserNetworkRecords(
      {
        includeBodies: true,
        includeCurrentPageOnly: options.includeCurrentPageOnly,
        ...(options.pageRef === undefined ? {} : { pageRef: options.pageRef }),
        requestIds,
      },
      signal,
    );
    return this.networkHistory.persist(browserRecords, root.registry.savedNetwork, {
      bodyWriteMode: "authoritative",
      redactSecretHeaders: false,
    });
  }

  private async syncPersistedNetworkSelection(
    timeout: TimeoutExecutionContext,
    input: Pick<
      OpensteerNetworkQueryInput,
      | "pageRef"
      | "recordId"
      | "requestId"
      | "capture"
      | "tag"
      | "url"
      | "hostname"
      | "path"
      | "method"
      | "status"
      | "resourceType"
      | "includeBodies"
    >,
    options: {
      readonly includeBodies: boolean;
    },
  ): Promise<readonly NetworkQueryRecord[]> {
    if (this.sessionRef === undefined) {
      return [];
    }

    const requestIds = resolveLiveQueryRequestIds(input, this.networkHistory);
    if (requestIds !== undefined && requestIds.length === 0) {
      return [];
    }
    const pageRef = resolveLiveQueryPageRef(input, this.pageRef, requestIds, this.networkHistory);
    const includeCurrentPageOnly = pageRef === undefined && input.recordId === undefined;
    const browserRecords = await timeout.runStep(() =>
      this.readBrowserNetworkRecords(
        {
          ...(pageRef === undefined ? {} : { pageRef }),
          ...(requestIds === undefined ? {} : { requestIds }),
          ...(input.url === undefined ? {} : { url: input.url }),
          ...(input.hostname === undefined ? {} : { hostname: input.hostname }),
          ...(input.path === undefined ? {} : { path: input.path }),
          ...(input.method === undefined ? {} : { method: input.method }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
          includeBodies: options.includeBodies,
          includeCurrentPageOnly,
        },
        timeout.signal,
      ),
    );
    const root = await this.ensureRoot();
    return timeout.runStep(() =>
      this.networkHistory.persist(browserRecords, root.registry.savedNetwork, {
        bodyWriteMode: options.includeBodies ? "authoritative" : "metadata-only",
        redactSecretHeaders: false,
      }),
    );
  }

  private toSavedNetworkQueryInput(input: OpensteerNetworkQueryInput): SavedNetworkQueryInput {
    return {
      ...(input.pageRef === undefined ? {} : { pageRef: input.pageRef }),
      ...(input.recordId === undefined ? {} : { recordId: input.recordId }),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.capture === undefined ? {} : { capture: input.capture }),
      ...(input.tag === undefined ? {} : { tag: input.tag }),
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.hostname === undefined ? {} : { hostname: input.hostname }),
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
      ...(input.includeBodies === undefined ? {} : { includeBodies: input.includeBodies }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    };
  }

  private toQueryInputFromTagInput(input: OpensteerNetworkTagInput): OpensteerNetworkQueryInput {
    return {
      ...(input.pageRef === undefined ? {} : { pageRef: input.pageRef }),
      ...(input.recordId === undefined ? {} : { recordId: input.recordId }),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.capture === undefined ? {} : { capture: input.capture }),
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.hostname === undefined ? {} : { hostname: input.hostname }),
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
    };
  }

  private async readLiveRequestIds(
    timeout: TimeoutExecutionContext,
    options: {
      readonly includeCurrentPageOnly: boolean;
    },
  ): Promise<ReadonlySet<string>> {
    const records = await timeout.runStep(() =>
      this.readLiveNetworkRecords(
        {
          includeBodies: false,
          includeCurrentPageOnly: options.includeCurrentPageOnly,
        },
        timeout.signal,
      ),
    );
    return new Set(records.map((record) => record.record.requestId));
  }

  private async observeLiveTransportDelta(
    timeout: TimeoutExecutionContext,
    baselineRequestIds: ReadonlySet<string>,
    options: {
      readonly includeCurrentPageOnly: boolean;
    },
  ): Promise<string | undefined> {
    const records = await timeout.runStep(() =>
      this.readLiveNetworkRecords(
        {
          includeBodies: false,
          includeCurrentPageOnly: options.includeCurrentPageOnly,
        },
        timeout.signal,
      ),
    );
    const delta = records.filter((record) => !baselineRequestIds.has(record.record.requestId));
    if (delta.length === 0) {
      return undefined;
    }
    await this.persistLiveRequestIds(
      delta.map((record) => record.record.requestId),
      timeout,
      {
        includeCurrentPageOnly: options.includeCurrentPageOnly,
      },
    );
    return sortLiveNetworkRecords(delta, this.networkHistory)[0]?.recordId;
  }

  private async executeTransportRequestWithJournal(
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
      readonly followRedirects?: boolean;
    },
    timeout: TimeoutExecutionContext,
    sessionRef: SessionRef,
  ): Promise<OpensteerRawRequestOutput> {
    const baselineRequestIds = await this.readLiveRequestIds(timeout, {
      includeCurrentPageOnly: false,
    });
    const response = await timeout.runStep(() =>
      this.requireEngine().executeRequest({
        sessionRef,
        request,
        signal: timeout.signal,
      }),
    );
    const recordId = await this.observeLiveTransportDelta(timeout, baselineRequestIds, {
      includeCurrentPageOnly: false,
    });

    const requestResult: OpensteerRequestTransportResult =
      toProtocolRequestTransportResult(request);
    const responseResult: OpensteerRequestResponseResult = toProtocolRequestResponseResult(
      response.data,
    );
    if (recordId === undefined) {
      throw new OpensteerProtocolError(
        "operation-failed",
        "request.raw completed but no live network record was journaled for the transport request",
      );
    }
    return {
      recordId,
      request: requestResult,
      response: responseResult,
      ...(parseStructuredResponseData(response.data) === undefined
        ? {}
        : { data: parseStructuredResponseData(response.data) }),
    };
  }

  private currentBinding(): RuntimeBrowserBinding | undefined {
    return this.sessionRef === undefined || this.pageRef === undefined
      ? undefined
      : {
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        };
  }

  private requireSessionRef(): SessionRef {
    if (!this.sessionRef) {
      throw new Error("Opensteer session is not initialized");
    }
    return this.sessionRef;
  }

  private async ensureBrowserTransportBinding(): Promise<RuntimeBrowserBinding> {
    const pageRef = await this.ensurePageRef();
    return {
      sessionRef: this.requireSessionRef(),
      pageRef,
    };
  }

  private requireExistingBrowserBindingForRecovery(): RuntimeBrowserBinding {
    const binding = this.currentBinding();
    if (binding !== undefined) {
      return binding;
    }

    throw new OpensteerProtocolError(
      "browser-required",
      "auth recovery requires a live browser session, but none is currently attached or open",
      {
        details: {
          kind: "auth-recovery",
        },
      },
    );
  }

  private async executeRawTransportRequest(
    input: OpensteerRawRequestInput,
    timeout: TimeoutExecutionContext,
    binding: RuntimeBrowserBinding | undefined,
  ): Promise<OpensteerRawRequestOutput> {
    const transport = normalizeTransportKind(input.transport ?? "context-http");
    const request = finalizeMaterializedTransportRequest(
      this.applyCookieJarToTransportRequest(buildRawTransportRequest(input), input.cookieJar),
      transport,
    );

    if (transport === "direct-http") {
      return this.executeDirectTransportRequestWithPersistence(request, timeout, input.cookieJar);
    }

    if (transport === "matched-tls") {
      return this.executeMatchedTlsTransportRequestWithPersistence(
        request,
        timeout,
        binding,
        input.cookieJar,
      );
    }

    if (transport === "context-http") {
      return this.executeContextTransportRequestWithPersistence(
        request,
        timeout,
        binding,
        input.cookieJar,
      );
    }

    if (transport === "page-http") {
      const pageBinding = await this.resolvePageHttpBinding(request.url, input.pageRef, false);
      return this.executePageHttpTransportRequestWithPersistence(
        request,
        timeout,
        pageBinding,
        input.cookieJar,
      );
    }

    if (binding === undefined) {
      throw new Error("Opensteer session is not initialized");
    }

    const output = await this.executeTransportRequestWithJournal(
      request,
      timeout,
      binding.sessionRef,
    );
    this.updateCookieJarFromResponse(input.cookieJar, output.response, request.url);
    return output;
  }

  private async executeDirectTransportRequestWithPersistence(
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
      readonly followRedirects?: boolean;
    },
    timeout: TimeoutExecutionContext,
    cookieJarName?: string,
  ): Promise<OpensteerRawRequestOutput> {
    const response = await timeout.runStep(() =>
      executeDirectTransportRequest(request, timeout.signal),
    );
    this.updateCookieJarFromResponse(
      cookieJarName,
      toProtocolRequestResponseResult(response),
      request.url,
    );
    const recordId = await this.persistDirectTransportRecord(request, response, undefined);
    return {
      recordId,
      request: toProtocolRequestTransportResult(request),
      response: toProtocolRequestResponseResult(response),
      ...(parseStructuredResponseData(response) === undefined
        ? {}
        : { data: parseStructuredResponseData(response) }),
    };
  }

  private async executePageHttpTransportRequestWithPersistence(
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
      readonly followRedirects?: boolean;
    },
    timeout: TimeoutExecutionContext,
    binding: RuntimeBrowserBinding,
    cookieJarName?: string,
  ): Promise<OpensteerRawRequestOutput> {
    const response = await this.executePageHttpTransportRequest(request, timeout, binding);
    this.updateCookieJarFromResponse(
      cookieJarName,
      toProtocolRequestResponseResult(response),
      request.url,
    );
    const recordId = await this.persistDirectTransportRecord(
      request,
      response,
      undefined,
      "page-http",
      binding,
    );
    return {
      recordId,
      request: toProtocolRequestTransportResult(request),
      response: toProtocolRequestResponseResult(response),
      ...(parseStructuredResponseData(response) === undefined
        ? {}
        : { data: parseStructuredResponseData(response) }),
    };
  }

  private async executeContextTransportRequestWithPersistence(
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
      readonly followRedirects?: boolean;
    },
    timeout: TimeoutExecutionContext,
    binding: RuntimeBrowserBinding | undefined,
    cookieJarName?: string,
  ): Promise<OpensteerRawRequestOutput> {
    const response = await this.executeContextTransportRequest(request, timeout, binding);
    this.updateCookieJarFromResponse(
      cookieJarName,
      toProtocolRequestResponseResult(response),
      request.url,
    );
    const recordId = await this.persistDirectTransportRecord(
      request,
      response,
      undefined,
      "context-http",
      binding,
    );
    return {
      recordId,
      request: toProtocolRequestTransportResult(request),
      response: toProtocolRequestResponseResult(response),
      ...(parseStructuredResponseData(response) === undefined
        ? {}
        : { data: parseStructuredResponseData(response) }),
    };
  }

  private async executeMatchedTlsTransportRequestWithPersistence(
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
      readonly followRedirects?: boolean;
    },
    timeout: TimeoutExecutionContext,
    binding: RuntimeBrowserBinding | undefined,
    cookieJarName?: string,
  ): Promise<OpensteerRawRequestOutput> {
    const response = await this.executeMatchedTlsTransportRequest(request, timeout, binding);
    this.updateCookieJarFromResponse(
      cookieJarName,
      toProtocolRequestResponseResult(response),
      request.url,
    );
    const recordId = await this.persistDirectTransportRecord(
      request,
      response,
      undefined,
      "matched-tls",
      binding,
    );
    return {
      recordId,
      request: toProtocolRequestTransportResult(request),
      response: toProtocolRequestResponseResult(response),
      ...(parseStructuredResponseData(response) === undefined
        ? {}
        : { data: parseStructuredResponseData(response) }),
    };
  }

  private async executePageHttpTransportRequest(
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
      readonly followRedirects?: boolean;
    },
    timeout: TimeoutExecutionContext,
    binding: RuntimeBrowserBinding,
  ): Promise<{
    readonly url: string;
    readonly status: number;
    readonly statusText: string;
    readonly headers: readonly HeaderEntry[];
    readonly body?: BrowserBodyPayload;
    readonly redirected: boolean;
  }> {
    const remainingMs = timeout.remainingMs();
    const result = await timeout.runStep(() =>
      this.requireEngine().evaluatePage({
        pageRef: binding.pageRef,
        script: PAGE_HTTP_REQUEST_SCRIPT,
        args: [
          {
            url: request.url,
            method: request.method,
            headers: request.headers ?? [],
            bodyBase64:
              request.body === undefined
                ? undefined
                : Buffer.from(request.body.bytes).toString("base64"),
            followRedirects: request.followRedirects !== false,
          },
        ],
        ...(remainingMs === undefined ? {} : { timeoutMs: remainingMs }),
      }),
    );
    return toPageHttpTransportResponse(result.data);
  }

  private async executePageHttpEventStreamRequest(
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
      readonly followRedirects?: boolean;
    },
    timeout: TimeoutExecutionContext,
    binding: RuntimeBrowserBinding,
  ): Promise<{
    readonly status: number;
    readonly firstChunkPreview?: string;
  }> {
    const remainingMs = timeout.remainingMs();
    const result = await timeout.runStep(() =>
      this.requireEngine().evaluatePage({
        pageRef: binding.pageRef,
        script: PAGE_HTTP_EVENT_STREAM_SCRIPT,
        args: [
          {
            url: request.url,
            method: request.method,
            headers: request.headers ?? [],
            bodyBase64:
              request.body === undefined
                ? undefined
                : Buffer.from(request.body.bytes).toString("base64"),
            followRedirects: request.followRedirects !== false,
            readTimeoutMs: computeStreamReadTimeoutMs(timeout),
          },
        ],
        ...(remainingMs === undefined ? {} : { timeoutMs: remainingMs }),
      }),
    );
    return toPageHttpEventStreamResponse(result.data);
  }

  private async executePageHttpWebSocketRequest(
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
    },
    timeout: TimeoutExecutionContext,
    binding: RuntimeBrowserBinding,
  ): Promise<{
    readonly opened: boolean;
    readonly messageCount: number;
    readonly error?: string;
  }> {
    const remainingMs = timeout.remainingMs();
    const result = await timeout.runStep(() =>
      this.requireEngine().evaluatePage({
        pageRef: binding.pageRef,
        script: PAGE_HTTP_WEBSOCKET_SCRIPT,
        args: [
          {
            url: request.url,
            protocols: parseWebSocketProtocols(request.headers),
            waitMs: computeStreamReadTimeoutMs(timeout),
          },
        ],
        ...(remainingMs === undefined ? {} : { timeoutMs: remainingMs }),
      }),
    );
    return toPageHttpWebSocketResponse(result.data);
  }

  private async executeContextTransportRequest(
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
      readonly followRedirects?: boolean;
    },
    timeout: TimeoutExecutionContext,
    binding: RuntimeBrowserBinding | undefined,
  ): Promise<{
    readonly url: string;
    readonly status: number;
    readonly statusText: string;
    readonly headers: readonly HeaderEntry[];
    readonly body?: BrowserBodyPayload;
    readonly redirected: boolean;
  }> {
    const liveBinding = binding ?? (await this.ensureBrowserTransportBinding());
    const cookies = await this.requireEngine().getCookies({
      sessionRef: liveBinding.sessionRef,
      urls: [request.url],
    });
    const requestWithCookies = applyBrowserCookiesToTransportRequest(request, cookies);
    return timeout.runStep(() => executeDirectTransportRequest(requestWithCookies, timeout.signal));
  }

  private async executeMatchedTlsTransportRequest(
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
      readonly followRedirects?: boolean;
    },
    timeout: TimeoutExecutionContext,
    binding: RuntimeBrowserBinding | undefined,
  ): Promise<{
    readonly url: string;
    readonly status: number;
    readonly statusText: string;
    readonly headers: readonly HeaderEntry[];
    readonly body?: BrowserBodyPayload;
    readonly redirected: boolean;
  }> {
    const liveBinding = binding ?? (await this.ensureBrowserTransportBinding());
    const cookies = await this.requireEngine().getCookies({
      sessionRef: liveBinding.sessionRef,
      urls: [request.url],
    });
    const requestWithCookies = applyBrowserCookiesToTransportRequest(request, cookies);
    const cookieHeader = headerValue(requestWithCookies.headers ?? [], "cookie");
    return timeout.runStep(() =>
      executeMatchedTlsTransportRequestWithCurl({
        request: omitTransportRequestHeader(requestWithCookies, "cookie"),
        cookies: cookieHeaderToCookieRecords(cookieHeader, request.url, liveBinding.sessionRef),
        signal: timeout.signal,
      }),
    );
  }

  private async persistDirectTransportRecord(
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
    },
    response: {
      readonly url: string;
      readonly status: number;
      readonly statusText: string;
      readonly headers: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
      readonly redirected: boolean;
    },
    tag: string | undefined,
    transportLabel = "direct-http",
    binding?: RuntimeBrowserBinding,
  ): Promise<string> {
    const root = await this.ensureRoot();
    const now = Date.now();
    const recordId = `record:${randomUUID()}`;
    const requestId = createNetworkRequestId(`${transportLabel}-${randomUUID()}`);
    const syntheticSessionRef =
      binding?.sessionRef ?? createSessionRef(`${transportLabel}-${this.workspace}`);
    const record: NetworkQueryRecord = {
      recordId,
      savedAt: now,
      record: {
        kind: "http",
        requestId,
        sessionRef: syntheticSessionRef,
        ...(binding?.pageRef === undefined ? {} : { pageRef: binding.pageRef }),
        method: request.method,
        url: request.url,
        requestHeaders: request.headers ?? [],
        responseHeaders: response.headers,
        status: response.status,
        statusText: response.statusText,
        resourceType: "fetch",
        navigationRequest: false,
        captureState: "complete",
        requestBodyState: request.body === undefined ? "skipped" : "complete",
        responseBodyState: response.body === undefined ? "skipped" : "complete",
        ...(request.body === undefined ? {} : { requestBody: toProtocolBodyPayload(request.body) }),
        ...(response.body === undefined
          ? {}
          : { responseBody: toProtocolBodyPayload(response.body) }),
      },
    };

    await root.registry.savedNetwork.save([record], {
      bodyWriteMode: "authoritative",
      ...(tag === undefined ? {} : { tag }),
    });
    return recordId;
  }

  private async executeResolvedRequestPlan(
    plan: RequestPlanRecord,
    input: OpensteerRequestExecuteInput,
    timeout: TimeoutExecutionContext,
    binding: RuntimeBrowserBinding | undefined,
  ): Promise<OpensteerRequestExecuteOutput> {
    const prepareBinding =
      plan.payload.recipes?.prepare === undefined
        ? undefined
        : {
            source: "recipe" as const,
            ...plan.payload.recipes.prepare,
          };
    let resolvedInput = input;
    let executionOverrides: OpensteerAuthRecipeRetryOverrides | undefined;
    if (prepareBinding !== undefined) {
      const prepareOutput = await this.executeConfiguredRecipeBinding(prepareBinding, timeout);
      resolvedInput = mergeExecutionInputOverrides(resolvedInput, prepareOutput.overrides);
      executionOverrides = mergeAuthRecipeOverrides(executionOverrides, prepareOutput.overrides);
    }

    const cookieJarName = resolvedInput.cookieJar ?? plan.payload.transport.cookieJar;
    const transportKind = normalizeTransportKind(plan.payload.transport.kind);
    let transportRequest = this.applyCookieJarToTransportRequest(
      applyTransportRequestOverrides(
        buildTransportRequestFromPlan(plan, resolvedInput),
        executionOverrides,
      ),
      cookieJarName,
    );
    transportRequest = finalizeMaterializedTransportRequest(transportRequest, transportKind);
    let current = await this.executePlanTransportRequest(
      plan,
      transportRequest,
      timeout,
      binding,
      cookieJarName,
    );
    const validateResponse = input.validateResponse ?? true;
    const recoverBinding = resolveRecoverRecipeBinding(plan);
    const matchedFailurePolicy =
      recoverBinding !== undefined &&
      matchesFailurePolicy(recoverBinding.failurePolicy, current.output.response);

    let recoveryOutput: OpensteerRunRecipeOutput | undefined;
    if (matchedFailurePolicy) {
      if (prepareBinding?.cachePolicy === "untilFailure") {
        this.clearRecipeBindingCache(prepareBinding);
      }

      try {
        recoveryOutput = await this.executeConfiguredRecipeBinding(recoverBinding, timeout);
      } catch (error) {
        if (error instanceof OpensteerProtocolError && error.code === "browser-required") {
          throw error;
        }
        throw new OpensteerProtocolError(
          "auth-recovery-failed",
          `request plan ${plan.key}@${plan.version} failed during deterministic recovery`,
          {
            cause: error,
            details: {
              key: plan.key,
              version: plan.version,
              recipe: recoverBinding.recipe,
            },
          },
        );
      }

      resolvedInput = mergeExecutionInputOverrides(resolvedInput, recoveryOutput.overrides);
      executionOverrides = mergeAuthRecipeOverrides(executionOverrides, recoveryOutput.overrides);
      transportRequest = this.applyCookieJarToTransportRequest(
        applyTransportRequestOverrides(
          buildTransportRequestFromPlan(plan, resolvedInput),
          executionOverrides,
        ),
        cookieJarName,
      );
      transportRequest = finalizeMaterializedTransportRequest(transportRequest, transportKind);
      current = await this.executePlanTransportRequest(
        plan,
        transportRequest,
        timeout,
        binding,
        cookieJarName,
      );
      if (matchesFailurePolicy(recoverBinding.failurePolicy, current.output.response)) {
        throw new OpensteerProtocolError(
          "auth-recovery-failed",
          `request plan ${plan.key}@${plan.version} still matched its recovery failure policy after deterministic recovery`,
          {
            details: {
              key: plan.key,
              version: plan.version,
              recipe: {
                key: recoveryOutput.recipe.key,
                version: recoveryOutput.recipe.version,
              },
            },
          },
        );
      }
    }

    if (plan.payload.retryPolicy !== undefined) {
      current = await this.retryResolvedRequestPlan(
        plan,
        plan.payload.retryPolicy,
        current,
        transportRequest,
        timeout,
        binding,
        cookieJarName,
      );
    }

    if (validateResponse) {
      assertResponseMatchesPlan(plan, current.transportResponse);
      await this.touchRequestPlanFreshness(plan);
    }

    return {
      ...current.output,
      ...(recoverBinding === undefined
        ? {}
        : {
            recovery: {
              attempted: matchedFailurePolicy,
              succeeded: matchedFailurePolicy,
              matchedFailurePolicy,
              ...(recoveryOutput === undefined
                ? {}
                : {
                    recipe: {
                      key: recoveryOutput.recipe.key,
                      version: recoveryOutput.recipe.version,
                    },
                  }),
            },
          }),
    };
  }

  private async executePlanTransportRequest(
    plan: RequestPlanRecord,
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
      readonly followRedirects?: boolean;
    },
    timeout: TimeoutExecutionContext,
    binding: RuntimeBrowserBinding | undefined,
    cookieJarName: string | undefined,
  ): Promise<{
    readonly output: OpensteerRequestExecuteOutput;
    readonly transportResponse: {
      readonly url: string;
      readonly status: number;
      readonly statusText: string;
      readonly headers: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
      readonly redirected: boolean;
    };
  }> {
    const transportKind = normalizeTransportKind(plan.payload.transport.kind);
    if (transportKind === "session-http") {
      const liveBinding = binding ?? (await this.ensureBrowserTransportBinding());
      const baselineRequestIds = await this.readLiveRequestIds(timeout, {
        includeCurrentPageOnly: false,
      });
      const response = await timeout.runStep(() =>
        this.requireEngine().executeRequest({
          sessionRef: liveBinding.sessionRef,
          request,
          signal: timeout.signal,
        }),
      );
      await this.observeLiveTransportDelta(timeout, baselineRequestIds, {
        includeCurrentPageOnly: false,
      });
      this.updateCookieJarFromResponse(
        cookieJarName,
        toProtocolRequestResponseResult(response.data),
        request.url,
      );
      return {
        output: buildPlanExecuteOutput(plan, request, response.data),
        transportResponse: response.data,
      };
    }

    if (transportKind === "context-http") {
      const response = await this.executeContextTransportRequest(request, timeout, binding);
      this.updateCookieJarFromResponse(
        cookieJarName,
        toProtocolRequestResponseResult(response),
        request.url,
      );
      return {
        output: buildPlanExecuteOutput(plan, request, response),
        transportResponse: response,
      };
    }

    if (transportKind === "matched-tls") {
      const response = await this.executeMatchedTlsTransportRequest(request, timeout, binding);
      this.updateCookieJarFromResponse(
        cookieJarName,
        toProtocolRequestResponseResult(response),
        request.url,
      );
      return {
        output: buildPlanExecuteOutput(plan, request, response),
        transportResponse: response,
      };
    }

    if (transportKind === "page-http") {
      const pageBinding = await this.resolvePageHttpBinding(
        request.url,
        binding?.pageRef,
        plan.payload.transport.requireSameOrigin ?? false,
      );
      const response = await this.executePageHttpTransportRequest(request, timeout, pageBinding);
      this.updateCookieJarFromResponse(
        cookieJarName,
        toProtocolRequestResponseResult(response),
        request.url,
      );
      return {
        output: buildPlanExecuteOutput(plan, request, response),
        transportResponse: response,
      };
    }

    const response = await timeout.runStep(() =>
      executeDirectTransportRequest(request, timeout.signal),
    );
    this.updateCookieJarFromResponse(
      cookieJarName,
      toProtocolRequestResponseResult(response),
      request.url,
    );
    return {
      output: buildPlanExecuteOutput(plan, request, response),
      transportResponse: response,
    };
  }

  private async touchRequestPlanFreshness(plan: RequestPlanRecord): Promise<void> {
    const freshness = touchFreshness(plan.freshness);
    await this.requireRoot().registry.requestPlans.updateFreshness({
      id: plan.id,
      ...(freshness === undefined ? {} : { freshness }),
    });
  }

  private async executeConfiguredRecipeBinding(
    binding: ResolvedRecipeBinding,
    timeout: TimeoutExecutionContext,
  ): Promise<OpensteerRunRecipeOutput> {
    const cacheKey = `${binding.source}:${binding.recipe.key}@${binding.recipe.version ?? "latest"}`;
    if (binding.cachePolicy === "untilFailure") {
      const cached = this.recipeCache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    const output = await this.executeRecipeRecord(
      await this.resolveRecipeRecord(binding.source, binding.recipe.key, binding.recipe.version),
      timeout,
      {},
      binding.source,
    );
    if (binding.cachePolicy === "untilFailure") {
      this.recipeCache.set(cacheKey, output);
    }
    return output;
  }

  private clearRecipeBindingCache(binding: ResolvedRecipeBinding): void {
    const cacheKey = `${binding.source}:${binding.recipe.key}@${binding.recipe.version ?? "latest"}`;
    this.recipeCache.delete(cacheKey);
  }

  private async retryResolvedRequestPlan(
    plan: RequestPlanRecord,
    retryPolicy: NonNullable<RequestPlanRecord["payload"]["retryPolicy"]>,
    current: {
      readonly output: OpensteerRequestExecuteOutput;
      readonly transportResponse: {
        readonly url: string;
        readonly status: number;
        readonly statusText: string;
        readonly headers: readonly HeaderEntry[];
        readonly body?: BrowserBodyPayload;
        readonly redirected: boolean;
      };
    },
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
      readonly followRedirects?: boolean;
    },
    timeout: TimeoutExecutionContext,
    binding: RuntimeBrowserBinding | undefined,
    cookieJarName: string | undefined,
  ) {
    if (
      retryPolicy.failurePolicy === undefined ||
      retryPolicy.maxRetries <= 0 ||
      !matchesFailurePolicy(retryPolicy.failurePolicy, current.output.response)
    ) {
      return current;
    }

    let latest = current;
    for (let attempt = 0; attempt < retryPolicy.maxRetries; attempt += 1) {
      const delayMs = resolveRetryDelayMs(retryPolicy, latest.output.response, attempt);
      if (delayMs > 0) {
        await delayWithSignal(delayMs, timeout.signal);
      }
      latest = await this.executePlanTransportRequest(
        plan,
        request,
        timeout,
        binding,
        cookieJarName,
      );
      if (!matchesFailurePolicy(retryPolicy.failurePolicy, latest.output.response)) {
        break;
      }
    }

    return latest;
  }

  private async resolveRecipeRecord(
    kind: RecipeRegistryKind,
    key: string,
    version: string | undefined,
  ): Promise<RecipeRecord | AuthRecipeRecord> {
    const registry =
      kind === "auth-recipe"
        ? this.requireRoot().registry.authRecipes
        : this.requireRoot().registry.recipes;
    const recipe = await registry.resolve({
      key,
      ...(version === undefined ? {} : { version }),
    });
    if (recipe === undefined) {
      const label = kind === "auth-recipe" ? "auth recipe" : "recipe";
      throw new OpensteerProtocolError(
        "not-found",
        version === undefined
          ? `${label} ${key} was not found`
          : `${label} ${key}@${version} was not found`,
        {
          details: {
            key,
            ...(version === undefined ? {} : { version }),
            kind,
          },
        },
      );
    }
    return recipe;
  }

  private async runResolvedRecipe(
    kind: RecipeRegistryKind,
    input: OpensteerRunRecipeInput | OpensteerRunAuthRecipeInput,
    timeout: TimeoutExecutionContext,
  ): Promise<OpensteerRunRecipeOutput> {
    const recipe = await this.resolveRecipeRecord(kind, input.key, input.version);
    return this.executeRecipeRecord(recipe, timeout, input.variables ?? {}, kind);
  }

  private async executeRecipeRecord(
    recipe: RecipeRecord | AuthRecipeRecord,
    timeout: TimeoutExecutionContext,
    initialVariables: Readonly<Record<string, string>>,
    kind: RecipeRegistryKind,
  ): Promise<OpensteerRunRecipeOutput> {
    const variables = new Map<string, string>(Object.entries(initialVariables));
    let overrides: OpensteerAuthRecipeRetryOverrides | undefined;

    for (const [index, step] of recipe.payload.steps.entries()) {
      const stepResult = await this.executeRecipeStep(step, variables, timeout);
      mergeVariables(variables, stepResult.variables);
      overrides = mergeAuthRecipeOverrides(overrides, stepResult.overrides);

      await this.appendTrace({
        operation: `${kind}.step`,
        startedAt: Date.now(),
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          recipe: {
            key: recipe.key,
            version: recipe.version,
          },
          index,
          kind: step.kind,
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });
    }

    const outputOverrides = renderOverrides(recipe.payload.outputs, variables);
    const renderedOverrides = mergeAuthRecipeOverrides(overrides, outputOverrides);

    return {
      recipe: {
        id: recipe.id,
        key: recipe.key,
        version: recipe.version,
      },
      variables: Object.fromEntries(
        [...variables.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
      ...(renderedOverrides === undefined ? {} : { overrides: renderedOverrides }),
    };
  }

  private async executeRecipeStep(
    step: OpensteerAuthRecipeStep,
    variables: ReadonlyMap<string, string>,
    timeout: TimeoutExecutionContext,
  ): Promise<{
    readonly variables?: Readonly<Record<string, string>>;
    readonly overrides?: OpensteerAuthRecipeRetryOverrides;
  }> {
    switch (step.kind) {
      case "goto": {
        const binding = this.requireExistingBrowserBindingForRecovery();
        await this.navigatePage(
          {
            operation: "page.goto",
            pageRef: binding.pageRef,
            url: interpolateTemplate(step.url, variables),
          },
          timeout,
        );
        return {};
      }
      case "reload": {
        const binding = this.requireExistingBrowserBindingForRecovery();
        const remainingMs = timeout.remainingMs();
        await timeout.runStep(() =>
          this.requireEngine().reload({
            pageRef: binding.pageRef,
            ...(remainingMs === undefined ? {} : { timeoutMs: remainingMs }),
          }),
        );
        await timeout.runStep(() =>
          settleWithPolicy(this.policy.settle, {
            operation: "page.goto",
            trigger: "navigation",
            engine: this.requireEngine(),
            pageRef: binding.pageRef,
            signal: timeout.signal,
            remainingMs: timeout.remainingMs(),
          }),
        );
        return {};
      }
      case "waitForUrl": {
        const binding = this.requireExistingBrowserBindingForRecovery();
        await pollUntil(timeout, async () => {
          const page = await this.requireEngine().getPageInfo({ pageRef: binding.pageRef });
          return page.url.includes(interpolateTemplate(step.includes, variables));
        });
        return {};
      }
      case "waitForNetwork": {
        this.requireExistingBrowserBindingForRecovery();
        const record = await pollUntilResult(timeout, async () => {
          const matches = await this.queryLiveNetwork(
            {
              ...(step.url === undefined ? {} : { url: interpolateTemplate(step.url, variables) }),
              ...(step.hostname === undefined
                ? {}
                : { hostname: interpolateTemplate(step.hostname, variables) }),
              ...(step.path === undefined
                ? {}
                : { path: interpolateTemplate(step.path, variables) }),
              ...(step.method === undefined
                ? {}
                : { method: interpolateTemplate(step.method, variables) }),
              ...(step.status === undefined
                ? {}
                : { status: interpolateTemplate(step.status, variables) }),
              includeBodies: step.includeBodies ?? false,
              limit: 1,
            },
            timeout,
          );
          return matches[0];
        });
        return step.saveAs === undefined ? {} : { variables: { [step.saveAs]: record.recordId } };
      }
      case "waitForCookie": {
        const value = await pollUntilResult(timeout, async () =>
          this.readCookieValue(interpolateTemplate(step.name, variables), step.url, variables),
        );
        return step.saveAs === undefined ? {} : { variables: { [step.saveAs]: value } };
      }
      case "waitForStorage": {
        const value = await pollUntilResult(timeout, async () =>
          this.readStorageValue(
            {
              area: step.area,
              origin: step.origin,
              key: step.key,
            },
            variables,
          ),
        );
        return step.saveAs === undefined ? {} : { variables: { [step.saveAs]: value } };
      }
      case "readCookie": {
        const value = await this.readCookieValue(step.name, step.url, variables);
        if (value === undefined) {
          throw new OpensteerProtocolError(
            "not-found",
            `auth recipe cookie ${step.name} was not found`,
          );
        }
        return {
          variables: {
            [step.saveAs]: value,
          },
        };
      }
      case "readStorage": {
        const value = await this.readStorageValue(step, variables);
        if (value === undefined) {
          throw new OpensteerProtocolError(
            "not-found",
            `auth recipe storage key ${step.origin}:${step.key} was not found`,
          );
        }
        return {
          variables: {
            [step.saveAs]: value,
          },
        };
      }
      case "evaluate": {
        const pageRef = step.pageRef ?? this.requireExistingBrowserBindingForRecovery().pageRef;
        const remainingMs = timeout.remainingMs();
        const evaluated = await timeout.runStep(() =>
          this.requireEngine().evaluatePage({
            pageRef,
            script: interpolateTemplate(step.script, variables),
            ...(step.args === undefined
              ? {}
              : { args: step.args.map((entry) => interpolateJsonValue(entry, variables)) }),
            ...(remainingMs === undefined ? {} : { timeoutMs: remainingMs }),
          }),
        );
        if (step.saveAs === undefined) {
          return {};
        }
        return {
          variables: {
            [step.saveAs]: stringifyRecipeVariableValue(evaluated.data),
          },
        };
      }
      case "syncCookiesToJar": {
        await this.syncBrowserCookiesToJar(step.jar, step.urls, variables);
        return {};
      }
      case "request": {
        const output = await this.executeRecipeRequest(step.request, variables, timeout);
        return captureRecipeResponse(step, output.response, output.data);
      }
      case "sessionRequest": {
        const output = await this.executeRecipeRequest(
          {
            ...step.request,
            transport: "session-http",
          },
          variables,
          timeout,
        );
        return captureRecipeResponse(step, output.response, output.data);
      }
      case "directRequest": {
        const output = await this.executeRecipeRequest(
          {
            ...step.request,
            transport: "direct-http",
          },
          variables,
          timeout,
        );
        return captureRecipeResponse(step, output.response, output.data);
      }
      case "solveCaptcha": {
        const output = await this.solveCaptcha(
          {
            provider: step.provider,
            apiKey: interpolateTemplate(step.apiKey, variables),
            ...(step.pageRef === undefined ? {} : { pageRef: step.pageRef }),
            ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
            ...(step.type === undefined ? {} : { type: step.type }),
            ...(step.siteKey === undefined
              ? {}
              : { siteKey: interpolateTemplate(step.siteKey, variables) }),
            ...(step.pageUrl === undefined
              ? {}
              : { pageUrl: interpolateTemplate(step.pageUrl, variables) }),
          },
          {
            signal: timeout.signal,
          },
        );
        return step.saveAs === undefined ? {} : { variables: { [step.saveAs]: output.token } };
      }
      case "hook":
        return this.executeAuthRecipeHook(step, variables);
    }
  }

  private async executeAuthRecipeHook(
    step: Extract<OpensteerAuthRecipeStep, { readonly kind: "hook" }>,
    variables: ReadonlyMap<string, string>,
  ): Promise<{
    readonly variables?: Readonly<Record<string, string>>;
    readonly overrides?: OpensteerAuthRecipeRetryOverrides;
  }> {
    const resolved = requireForAuthRecipeHook.resolve(step.hook.specifier, {
      paths: [path.dirname(this.rootPath)],
    });
    const module = await import(pathToFileURL(resolved).href);
    const handler = module[step.hook.export] as
      | ((input: {
          readonly variables: Readonly<Record<string, string>>;
          readonly context: {
            goto: (input: { readonly url: string }) => Promise<unknown>;
            reload: () => Promise<unknown>;
            queryNetwork: (
              input?: OpensteerNetworkQueryInput,
            ) => Promise<OpensteerNetworkQueryOutput>;
            rawRequest: (input: OpensteerRawRequestInput) => Promise<OpensteerRawRequestOutput>;
            getCookies: (input?: {
              readonly urls?: readonly string[];
            }) => Promise<readonly CookieRecord[]>;
            getStorageSnapshot: (input?: {
              readonly includeSessionStorage?: boolean;
              readonly includeIndexedDb?: boolean;
            }) => Promise<StorageSnapshot>;
            extract: (input: OpensteerDomExtractInput) => Promise<OpensteerDomExtractOutput>;
          };
        }) => Promise<{
          readonly variables?: Readonly<Record<string, string>>;
          readonly overrides?: OpensteerAuthRecipeRetryOverrides;
        } | void>)
      | undefined;
    if (typeof handler !== "function") {
      throw new OpensteerProtocolError(
        "invalid-request",
        `auth recipe hook ${step.hook.specifier}#${step.hook.export} is not a function`,
      );
    }

    const result = await handler({
      variables: Object.fromEntries(variables),
      context: {
        goto: async (input) => {
          const binding = this.requireExistingBrowserBindingForRecovery();
          await this.runWithOperationTimeout("page.goto", (timeout) =>
            this.navigatePage(
              {
                operation: "page.goto",
                pageRef: binding.pageRef,
                url: input.url,
              },
              timeout,
            ),
          );
          return undefined;
        },
        reload: async () => {
          const binding = this.requireExistingBrowserBindingForRecovery();
          await this.requireEngine().reload({
            pageRef: binding.pageRef,
          });
          return undefined;
        },
        queryNetwork: (input = {}) => this.queryNetwork(input),
        rawRequest: (input) => this.rawRequest(input),
        getCookies: async (input = {}) => {
          const binding = this.requireExistingBrowserBindingForRecovery();
          return this.requireEngine().getCookies({
            sessionRef: binding.sessionRef,
            ...(input.urls === undefined ? {} : { urls: input.urls }),
          });
        },
        getStorageSnapshot: async (input = {}) => {
          const binding = this.requireExistingBrowserBindingForRecovery();
          return this.requireEngine().getStorageSnapshot({
            sessionRef: binding.sessionRef,
            ...(input.includeSessionStorage === undefined
              ? {}
              : { includeSessionStorage: input.includeSessionStorage }),
            ...(input.includeIndexedDb === undefined
              ? {}
              : { includeIndexedDb: input.includeIndexedDb }),
          });
        },
        extract: async (input) => {
          this.requireExistingBrowserBindingForRecovery();
          return this.extract(input);
        },
      },
    });
    return result ?? {};
  }

  private async executeRecipeRequest(
    requestInput: {
      readonly url: string;
      readonly transport?: TransportKind;
      readonly pageRef?: PageRef;
      readonly cookieJar?: string;
      readonly method?: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly query?: Readonly<Record<string, string>>;
      readonly body?: OpensteerRawRequestInput["body"];
      readonly followRedirects?: boolean;
    },
    variables: ReadonlyMap<string, string>,
    timeout: TimeoutExecutionContext,
  ): Promise<OpensteerRawRequestOutput> {
    const transport = normalizeTransportKind(requestInput.transport ?? "context-http");
    const cookieJar =
      requestInput.cookieJar === undefined
        ? undefined
        : interpolateTemplate(requestInput.cookieJar, variables);
    const request = finalizeMaterializedTransportRequest(
      this.applyCookieJarToTransportRequest(buildRecipeRequest(requestInput, variables), cookieJar),
      transport,
    );

    switch (transport) {
      case "direct-http":
        return this.executeDirectTransportRequestWithPersistence(request, timeout, cookieJar);
      case "matched-tls":
        return this.executeMatchedTlsTransportRequestWithPersistence(
          request,
          timeout,
          this.requireExistingBrowserBindingForRecovery(),
          cookieJar,
        );
      case "page-http": {
        const binding = await this.resolvePageHttpBinding(request.url, requestInput.pageRef, false);
        return this.executePageHttpTransportRequestWithPersistence(
          request,
          timeout,
          binding,
          cookieJar,
        );
      }
      case "context-http": {
        return this.executeContextTransportRequestWithPersistence(
          request,
          timeout,
          this.requireExistingBrowserBindingForRecovery(),
          cookieJar,
        );
      }
      case "session-http": {
        const binding = this.requireExistingBrowserBindingForRecovery();
        const output = await this.executeTransportRequestWithJournal(
          request,
          timeout,
          binding.sessionRef,
        );
        this.updateCookieJarFromResponse(cookieJar, output.response, request.url);
        return output;
      }
    }
  }

  private async resolvePageHttpBinding(
    requestUrl: string,
    explicitPageRef: PageRef | undefined,
    requireSameOrigin = false,
  ): Promise<RuntimeBrowserBinding> {
    const pageRef = explicitPageRef ?? (await this.ensurePageRef());
    const pageInfo = await this.requireEngine().getPageInfo({ pageRef });
    if (requireSameOrigin && new URL(pageInfo.url).origin !== new URL(requestUrl).origin) {
      throw new OpensteerProtocolError(
        "invalid-request",
        `page-http requires a bound page on the same origin as ${requestUrl}`,
        {
          details: {
            pageRef,
            pageUrl: pageInfo.url,
            requestUrl,
          },
        },
      );
    }
    return {
      sessionRef: pageInfo.sessionRef,
      pageRef,
    };
  }

  private async syncBrowserCookiesToJar(
    jarName: string,
    urls: readonly string[] | undefined,
    variables: ReadonlyMap<string, string>,
  ): Promise<void> {
    const binding = this.requireExistingBrowserBindingForRecovery();
    const cookies = await this.requireEngine().getCookies({
      sessionRef: binding.sessionRef,
      ...(urls === undefined
        ? {}
        : { urls: urls.map((url) => interpolateTemplate(url, variables)) }),
    });
    this.cookieJars.set(
      interpolateTemplate(jarName, variables),
      cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        ...(cookie.expiresAt === undefined || cookie.expiresAt === null || cookie.expiresAt <= 0
          ? {}
          : { expiresAt: cookie.expiresAt }),
      })),
    );
  }

  private async executeAnalysisTransportRequest(
    transport: TransportKind,
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
      readonly followRedirects?: boolean;
    },
    timeout: TimeoutExecutionContext,
  ): Promise<{
    readonly url: string;
    readonly status: number;
    readonly statusText: string;
    readonly headers: readonly HeaderEntry[];
    readonly body?: BrowserBodyPayload;
    readonly redirected: boolean;
  }> {
    const normalizedRequest = finalizeMaterializedTransportRequest(request, transport);
    switch (transport) {
      case "direct-http":
        return timeout.runStep(() =>
          executeDirectTransportRequest(normalizedRequest, timeout.signal),
        );
      case "matched-tls":
        return this.executeMatchedTlsTransportRequest(
          normalizedRequest,
          timeout,
          this.currentBinding(),
        );
      case "context-http":
        return this.executeContextTransportRequest(
          normalizedRequest,
          timeout,
          this.currentBinding(),
        );
      case "page-http":
        return this.executePageHttpTransportRequest(
          normalizedRequest,
          timeout,
          await this.resolvePageHttpBinding(
            normalizedRequest.url,
            this.currentBinding()?.pageRef,
            false,
          ),
        );
      case "session-http": {
        const binding = this.currentBinding() ?? (await this.ensureBrowserTransportBinding());
        const output = await this.executeTransportRequestWithJournal(
          normalizedRequest,
          timeout,
          binding.sessionRef,
        );
        return {
          url: output.response.url,
          status: output.response.status,
          statusText: output.response.statusText,
          headers: output.response.headers,
          ...(output.response.body === undefined
            ? {}
            : {
                body: createBodyPayload(
                  new Uint8Array(Buffer.from(output.response.body.data, "base64")),
                  {
                    encoding: output.response.body.encoding,
                    ...(output.response.body.mimeType === undefined
                      ? {}
                      : { mimeType: output.response.body.mimeType }),
                    ...(output.response.body.charset === undefined
                      ? {}
                      : { charset: output.response.body.charset }),
                    truncated: output.response.body.truncated,
                    ...(output.response.body.originalByteLength === undefined
                      ? {}
                      : { originalByteLength: output.response.body.originalByteLength }),
                  },
                ),
              }),
          redirected: output.response.redirected,
        };
      }
    }
  }

  private async resolveScriptTransformSource(input: {
    readonly artifactId?: string;
    readonly content?: string;
  }): Promise<ScriptTransformSource> {
    if (typeof input.content === "string") {
      return {
        content: input.content,
      };
    }

    if (input.artifactId === undefined) {
      throw new OpensteerProtocolError(
        "invalid-request",
        "script transforms require either content or artifactId",
      );
    }

    const root = await this.ensureRoot();
    const artifact = await root.artifacts.read(input.artifactId);
    if (artifact === undefined || artifact.payload.kind !== "script-source") {
      throw new OpensteerProtocolError(
        "not-found",
        `script artifact ${input.artifactId} was not found`,
        {
          details: {
            artifactId: input.artifactId,
            kind: "script-source",
          },
        },
      );
    }

    return {
      content: artifact.payload.data.content,
      artifactId: artifact.manifest.artifactId,
      data: artifact.payload.data,
      scope: artifact.manifest.scope,
    };
  }

  private async buildScriptTransformOutput(input: {
    readonly source: ScriptTransformSource;
    readonly transformedContent: string;
    readonly persist: boolean;
    readonly transform: "beautify" | "deobfuscate";
  }): Promise<OpensteerScriptBeautifyOutput> {
    const root = await this.ensureRoot();
    const bytesBefore = Buffer.byteLength(input.source.content, "utf8");
    const bytesAfter = Buffer.byteLength(input.transformedContent, "utf8");
    if (!input.persist) {
      return {
        content: input.transformedContent,
        bytesBefore,
        bytesAfter,
      };
    }

    const scriptArtifact: ScriptSourceArtifactData = {
      source: input.source.data?.source ?? "inline",
      ...(input.source.data?.url === undefined ? {} : { url: input.source.data.url }),
      ...(input.source.data?.type === undefined ? {} : { type: input.source.data.type }),
      hash: sha256Hex(Buffer.from(input.transformedContent, "utf8")),
      loadOrder: input.source.data?.loadOrder ?? 0,
      content: input.transformedContent,
    };
    const provenance =
      input.source.artifactId === undefined
        ? undefined
        : {
            sourceArtifactId: input.source.artifactId,
            transform: input.transform,
          };
    const manifest = await root.artifacts.writeStructured({
      kind: "script-source",
      ...(input.source.scope === undefined ? {} : { scope: input.source.scope }),
      ...(provenance === undefined ? {} : { provenance }),
      data: scriptArtifact,
    });

    return {
      content: input.transformedContent,
      artifactId: manifest.artifactId,
      bytesBefore,
      bytesAfter,
    };
  }

  private applyCookieJarToTransportRequest(
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
      readonly followRedirects?: boolean;
    },
    jarName: string | undefined,
  ) {
    if (jarName === undefined) {
      return request;
    }

    const cookieHeader = serializeCookieJarHeader(this.cookieJars.get(jarName) ?? [], request.url);
    if (cookieHeader === undefined) {
      return request;
    }

    const headers = [...(request.headers ?? [])];
    setHeaderValue(headers, "cookie", cookieHeader);
    return {
      ...request,
      headers,
    };
  }

  private updateCookieJarFromResponse(
    jarName: string | undefined,
    response: OpensteerRequestResponseResult,
    requestUrl: string,
  ): void {
    if (jarName === undefined) {
      return;
    }

    const current = this.cookieJars.get(jarName) ?? [];
    const merged = mergeCookieJarEntries(
      current,
      response.headers
        .filter((header) => header.name.toLowerCase() === "set-cookie")
        .flatMap((header) => parseSetCookieHeader(header.value, requestUrl)),
    );
    this.cookieJars.set(jarName, merged);
  }

  private async readCookieValue(
    name: string,
    url: string | undefined,
    variables: ReadonlyMap<string, string>,
  ): Promise<string | undefined> {
    const binding = this.requireExistingBrowserBindingForRecovery();
    const cookies = await this.requireEngine().getCookies({
      sessionRef: binding.sessionRef,
      ...(url === undefined ? {} : { urls: [interpolateTemplate(url, variables)] }),
    });
    return cookies.find((cookie) => cookie.name === interpolateTemplate(name, variables))?.value;
  }

  private async readStorageValue(
    step: {
      readonly area: "local" | "session";
      readonly origin: string;
      readonly key: string;
      readonly pageUrl?: string;
    },
    variables: ReadonlyMap<string, string>,
  ): Promise<string | undefined> {
    const binding = this.requireExistingBrowserBindingForRecovery();
    const snapshot = await this.requireEngine().getStorageSnapshot({
      sessionRef: binding.sessionRef,
      includeSessionStorage: step.area === "session",
      includeIndexedDb: false,
    });
    const origin = interpolateTemplate(step.origin, variables);
    const key = interpolateTemplate(step.key, variables);
    if (step.area === "local") {
      return snapshot.origins
        .find((entry) => entry.origin === origin)
        ?.localStorage.find((entry) => entry.key === key)?.value;
    }

    const pageUrl =
      step.pageUrl === undefined ? undefined : interpolateTemplate(step.pageUrl, variables);
    return snapshot.sessionStorage
      ?.filter((entry) => entry.origin === origin)
      .find((entry) => pageUrl === undefined || entry.origin === new URL(pageUrl).origin)
      ?.entries.find((entry) => entry.key === key)?.value;
  }

  private async flushPersistedNetworkHistory(): Promise<void> {
    if (this.sessionRef === undefined) {
      return;
    }

    const root = await this.ensureRoot();

    try {
      await withDetachedTimeoutSignal(PERSISTED_NETWORK_FLUSH_TIMEOUT_MS, async (signal) => {
        const browserRecords = await this.readBrowserNetworkRecords(
          {
            includeBodies: true,
            includeCurrentPageOnly: false,
          },
          signal,
        );
        await this.networkHistory.persist(browserRecords, root.registry.savedNetwork, {
          bodyWriteMode: "authoritative",
          redactSecretHeaders: false,
        });
      });
    } catch (error) {
      if (!isIgnorableRuntimeBindingError(error)) {
        throw error;
      }
    }
  }

  private toDomTargetRef(target: OpensteerTargetInput): DomTargetRef {
    if (target.kind === "description") {
      return {
        kind: "descriptor",
        description: target.description,
      };
    }

    if (target.kind === "selector") {
      return {
        kind: "selector",
        selector: target.selector,
      };
    }

    return {
      kind: "selector",
      selector: `[c="${String(target.element)}"]`,
    };
  }

  private async ensureRoot(): Promise<OpensteerRuntimeWorkspace> {
    if (!this.root) {
      const workspace = await createFilesystemOpensteerWorkspace({
        rootPath: this.rootPath,
        ...(this.workspaceName === undefined ? {} : { workspace: this.workspaceName }),
        scope: this.workspaceName === undefined ? "temporary" : "workspace",
      });

      if (this.registryOverrides) {
        const overrides = this.registryOverrides;
        this.root = {
          ...workspace,
          registry: {
            ...workspace.registry,
            ...(overrides.requestPlans === undefined
              ? {}
              : { requestPlans: overrides.requestPlans }),
            ...(overrides.authRecipes === undefined ? {} : { authRecipes: overrides.authRecipes }),
            ...(overrides.recipes === undefined ? {} : { recipes: overrides.recipes }),
            ...(overrides.reverseCases === undefined
              ? {}
              : { reverseCases: overrides.reverseCases }),
            ...(overrides.reversePackages === undefined
              ? {}
              : { reversePackages: overrides.reversePackages }),
          },
        };
      } else {
        this.root = workspace;
      }
    }

    return this.root;
  }

  private async ensureEngine(
    overrides: OpensteerEngineFactoryOptions = {},
  ): Promise<DisposableBrowserCoreEngine> {
    if (this.engine) {
      return this.engine;
    }

    if (this.injectedEngine) {
      this.engine = this.wrapEngineWithObservationCapture(
        this.injectedEngine as DisposableBrowserCoreEngine,
      );
      this.ownsEngine = false;
      return this.engine;
    }

    if (this.engineFactory === undefined) {
      throw new Error("Opensteer engine factory is not initialized");
    }

    this.engine = this.wrapEngineWithObservationCapture(
      (await this.engineFactory(overrides)) as DisposableBrowserCoreEngine,
    );
    this.ownsEngine = true;
    return this.engine;
  }

  private async ensureSemantics(): Promise<void> {
    const root = await this.ensureRoot();
    const engine = await this.ensureEngine();
    this.dom = createDomRuntime({
      engine,
      root,
      namespace: this.workspace,
      ...(this.injectedDescriptorStore === undefined
        ? {}
        : { descriptorStore: this.injectedDescriptorStore }),
      policy: this.policy,
    });
    this.computer = createComputerUseRuntime({
      engine,
      dom: this.dom,
      policy: this.policy,
    });
    this.extractionDescriptors =
      this.injectedExtractionDescriptorStore ??
      createOpensteerExtractionDescriptorStore({
        root,
        namespace: this.workspace,
      });
  }

  private async ensurePageRef(): Promise<PageRef> {
    if ((await this.ensureLiveRuntimeBinding()) === "unbound") {
      await this.open();
    }
    if (!this.pageRef) {
      throw new Error("Opensteer page is not available");
    }
    return this.pageRef;
  }

  private requireRoot(): OpensteerRuntimeWorkspace {
    if (!this.root) {
      throw new Error("Opensteer root is not initialized");
    }
    return this.root;
  }

  private requireEngine(): DisposableBrowserCoreEngine {
    if (!this.engine) {
      throw new Error("Opensteer engine is not initialized");
    }
    return this.engine;
  }

  private requireDom(): DomRuntime {
    if (!this.dom) {
      throw new Error("Opensteer DOM runtime is not initialized");
    }
    return this.dom;
  }

  private requireComputer(): ComputerUseRuntime {
    if (!this.computer) {
      throw new Error("Opensteer computer-use runtime is not initialized");
    }
    return this.computer;
  }

  private requireExtractionDescriptors() {
    if (!this.extractionDescriptors) {
      throw new Error("Opensteer extraction descriptor store is not initialized");
    }
    return this.extractionDescriptors;
  }

  private async ensureLiveRuntimeBinding(): Promise<"unbound" | "live"> {
    const health = await this.probeRuntimeBindingHealth();
    if (health === "invalid") {
      const engine = this.engine;
      if (engine) {
        await this.cleanupSessionResources(engine, this.pageRef, this.sessionRef);
      }
      await this.resetRuntimeState({
        disposeEngine: true,
      });
      return "unbound";
    }
    return health;
  }

  private async probeRuntimeBindingHealth(): Promise<"unbound" | "live" | "invalid"> {
    const pageRef = this.pageRef;
    const sessionRef = this.sessionRef;
    if (pageRef === undefined && sessionRef === undefined) {
      return "unbound";
    }
    if (pageRef === undefined || sessionRef === undefined) {
      return "invalid";
    }

    const engine = this.engine;
    if (!engine) {
      return "invalid";
    }

    try {
      await engine.getPageInfo({ pageRef });
      return "live";
    } catch (error) {
      if (isIgnorableRuntimeBindingError(error)) {
        return "invalid";
      }
      throw error;
    }
  }

  private async readSessionState(): Promise<OpensteerOpenOutput> {
    const pageRef = await this.ensurePageRef();
    const pageInfo = await this.requireEngine().getPageInfo({ pageRef });
    const sessionRef = this.sessionRef;
    if (!sessionRef) {
      throw new Error("Opensteer session is not initialized");
    }

    return {
      sessionRef,
      pageRef,
      url: pageInfo.url,
      title: pageInfo.title,
    };
  }

  private async captureSnapshotArtifacts(
    pageRef: PageRef,
    options: {
      readonly includeHtmlSnapshot: boolean;
    },
    timeout: TimeoutExecutionContext,
  ): Promise<OpensteerTraceArtifacts> {
    const root = this.requireRoot();
    const mainFrame = await timeout.runStep(() => getMainFrame(this.requireEngine(), pageRef));
    const domSnapshot = await timeout.runStep(() =>
      this.requireEngine().getDomSnapshot({
        frameRef: mainFrame.frameRef,
      }),
    );
    const manifests: ArtifactManifest[] = [];

    manifests.push(
      await timeout.runStep(() =>
        root.artifacts.writeStructured({
          kind: "dom-snapshot",
          scope: buildArtifactScope({
            sessionRef: this.sessionRef,
            pageRef,
            frameRef: domSnapshot.frameRef,
            documentRef: domSnapshot.documentRef,
            documentEpoch: domSnapshot.documentEpoch,
          }),
          data: domSnapshot,
        }),
      ),
    );

    if (options.includeHtmlSnapshot) {
      const htmlSnapshot = await timeout.runStep(() =>
        this.requireEngine().getHtmlSnapshot({
          frameRef: mainFrame.frameRef,
        }),
      );
      manifests.push(
        await timeout.runStep(() =>
          root.artifacts.writeStructured({
            kind: "html-snapshot",
            scope: buildArtifactScope({
              sessionRef: this.sessionRef,
              pageRef,
              frameRef: htmlSnapshot.frameRef,
              documentRef: htmlSnapshot.documentRef,
              documentEpoch: htmlSnapshot.documentEpoch,
            }),
            data: htmlSnapshot,
          }),
        ),
      );
    }

    return {
      manifests,
    };
  }

  private async persistComputerArtifacts(
    output: ComputerUseRuntimeOutput,
    timeout: TimeoutExecutionContext,
  ): Promise<PersistedComputerArtifacts> {
    const root = this.requireRoot();
    const manifests: ArtifactManifest[] = [];

    const screenshotManifest = await timeout.runStep(() =>
      root.artifacts.writeBinary({
        kind: "screenshot",
        scope: buildArtifactScope({
          sessionRef: this.sessionRef,
          pageRef: output.pageRef,
          frameRef: output.screenshot.frameRef,
          documentRef: output.screenshot.documentRef,
          documentEpoch: output.screenshot.documentEpoch,
        }),
        mediaType: screenshotMediaType(output.screenshot.format),
        data: output.screenshot.payload.bytes,
      }),
    );
    manifests.push(screenshotManifest);

    const screenshotPayload = manifestToExternalBinaryLocation(root.rootPath, screenshotManifest);
    return {
      manifests,
      output: {
        ...output,
        screenshot: {
          ...output.screenshot,
          payload: screenshotPayload,
        },
      },
    };
  }

  private async appendTrace(input: OpensteerSessionTraceInput): Promise<void> {
    const runId = this.runId;
    if (runId === undefined) {
      return;
    }

    const root = await this.ensureRoot();
    const capturedStepEvents =
      input.events ??
      this.consumePendingOperationEventCapture(
        input.operation,
        input.startedAt,
        input.completedAt,
      );
    const drainedStepEvents =
      input.events === undefined ? await this.drainPendingEngineEvents(input.context) : undefined;
    const stepEvents = mergeObservedStepEvents(capturedStepEvents, drainedStepEvents);
    const normalizedData = input.data === undefined ? undefined : toCanonicalJsonValue(input.data);
    const normalizedError =
      input.error === undefined ? undefined : normalizeOpensteerError(input.error);
    const artifacts =
      input.artifacts === undefined
        ? undefined
        : await Promise.all(
            input.artifacts.manifests.map(async (manifest) => {
              const reference = await root.artifacts.toProtocolArtifactReference(
                manifest.artifactId,
                "capture",
              );
              if (!reference) {
                throw new Error(`failed to materialize artifact reference ${manifest.artifactId}`);
              }
              return reference;
            }),
          );

    const traceEntry = await root.traces.append(runId, {
      operation: input.operation,
      outcome: input.outcome,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      ...(input.context === undefined ? {} : { context: input.context }),
      ...(stepEvents === undefined ? {} : { events: stepEvents }),
      ...(artifacts === undefined ? {} : { artifacts }),
      ...(normalizedData === undefined ? {} : { data: normalizedData }),
      ...(normalizedError === undefined
        ? {}
        : {
            error: normalizedError,
          }),
    });

    const observationSession = await this.ensureObservationSession().catch(() => undefined);
    if (observationSession === undefined || this.observationConfig.profile === "off") {
      return;
    }

    const observationArtifactIds =
      input.artifacts === undefined
        ? undefined
        : (
            await Promise.allSettled(
              input.artifacts.manifests.map(async (manifest) => {
                const artifact = await observationSession.writeArtifact({
                  artifactId: manifest.artifactId,
                  kind: observationArtifactKindFromManifest(manifest.kind),
                  createdAt: manifest.createdAt,
                  context: manifest.scope,
                  mediaType: manifest.mediaType,
                  byteLength: manifest.byteLength,
                  sha256: manifest.sha256,
                  opensteerArtifactId: manifest.artifactId,
                  storageKey: manifestToExternalBinaryLocation(root.rootPath, manifest).uri,
                });
                return artifact.artifactId;
              }),
            )
          )
            .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));

    const observationEvents = buildObservationEventsFromTrace({
      traceId: traceEntry.traceId,
      stepId: traceEntry.stepId,
      operation: input.operation,
      outcome: input.outcome,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      ...(input.context === undefined ? {} : { context: input.context }),
      ...(stepEvents === undefined ? {} : { events: stepEvents }),
      ...(normalizedData === undefined ? {} : { data: normalizedData }),
      ...(normalizedError === undefined ? {} : { error: normalizedError }),
      ...(observationArtifactIds === undefined ? {} : { artifactIds: observationArtifactIds }),
      profile: this.observationConfig.profile,
    });
    if (observationEvents.length > 0) {
      await observationSession.appendBatch(observationEvents).catch(() => undefined);
    }
  }

  private async cleanupSessionResources(
    engine: BrowserCoreEngine,
    pageRef: PageRef | undefined,
    sessionRef: SessionRef | undefined,
  ): Promise<void> {
    if (pageRef !== undefined) {
      await engine.closePage({ pageRef }).catch(() => undefined);
    }
    if (sessionRef !== undefined) {
      await engine.closeSession({ sessionRef }).catch(() => undefined);
    }
  }

  private async resetRuntimeState(options: { readonly disposeEngine: boolean }): Promise<void> {
    const engine = this.engine;
    const observations = this.observations;

    this.networkHistory.clear();
    this.sessionRef = undefined;
    this.pageRef = undefined;
    this.runId = undefined;
    this.dom = undefined;
    this.computer = undefined;
    this.extractionDescriptors = undefined;
    this.engine = undefined;
    this.observations = undefined;
    this.pendingOperationEventCaptures.length = 0;

    await observations?.close("runtime_reset").catch(() => undefined);
    if (options.disposeEngine && this.ownsEngine && engine?.dispose) {
      await engine.dispose();
    }
    this.ownsEngine = false;
  }

  private async ensureObservationSession(): Promise<SessionObservationSink | undefined> {
    if (this.observationConfig.profile === "off") {
      return undefined;
    }
    if (this.observations !== undefined) {
      return this.observations;
    }
    const observationSessionId = this.resolveObservationSessionId();
    if (observationSessionId === undefined) {
      return undefined;
    }

    const sink = this.injectedObservationSink ?? (await this.ensureRoot()).observations;
    this.observations = await sink.openSession({
      sessionId: observationSessionId,
      openedAt: Date.now(),
      config: this.observationConfig,
    });
    return this.observations;
  }

  private resolveObservationSessionId(): string | undefined {
    return this.observationSessionId ?? this.sessionRef;
  }

  private runWithOperationTimeout<T>(
    operation: OpensteerSemanticOperationName,
    callback: (context: TimeoutExecutionContext) => Promise<T>,
    options: RuntimeOperationOptions = {},
  ): Promise<T> {
    const existingCollector = this.operationEventStorage.getStore();
    if (existingCollector !== undefined) {
      return runWithPolicyTimeout(
        this.policy.timeout,
        {
          operation,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        callback,
      );
    }

    const collector: OpensteerEvent[] = [];
    const startedAt = Date.now();
    return this.operationEventStorage.run(collector, async () => {
      try {
        return await runWithPolicyTimeout(
          this.policy.timeout,
          {
            operation,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
          callback,
        );
      } finally {
        this.recordPendingOperationEventCapture({
          operation,
          startedAt,
          completedAt: Date.now(),
          events: collector,
        });
      }
    });
  }

  private wrapEngineWithObservationCapture(
    engine: DisposableBrowserCoreEngine,
  ): DisposableBrowserCoreEngine {
    return new Proxy(engine, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") {
          return value;
        }

        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          if (!(result instanceof Promise)) {
            return result;
          }

          return result.then((resolved) => {
            this.captureObservedStepEvents(resolved);
            return resolved;
          });
        };
      },
    }) as DisposableBrowserCoreEngine;
  }

  private captureObservedStepEvents(value: unknown): void {
    const collector = this.operationEventStorage.getStore();
    if (collector === undefined) {
      return;
    }

    const events = readStepResultEvents(value);
    if (events === undefined || events.length === 0) {
      return;
    }

    collector.push(...events);
  }

  private recordPendingOperationEventCapture(capture: PendingOperationEventCapture): void {
    if (capture.events.length === 0) {
      return;
    }

    this.pendingOperationEventCaptures.push({
      ...capture,
      events: [...capture.events],
    });
    if (this.pendingOperationEventCaptures.length > PENDING_OPERATION_EVENT_CAPTURE_LIMIT) {
      this.pendingOperationEventCaptures.splice(
        0,
        this.pendingOperationEventCaptures.length - PENDING_OPERATION_EVENT_CAPTURE_LIMIT,
      );
    }
  }

  private consumePendingOperationEventCapture(
    operation: string,
    startedAt: number,
    completedAt: number,
  ): readonly OpensteerEvent[] | undefined {
    for (let index = this.pendingOperationEventCaptures.length - 1; index >= 0; index -= 1) {
      const capture = this.pendingOperationEventCaptures[index];
      if (capture === undefined) {
        continue;
      }
      if (capture.operation !== operation) {
        continue;
      }
      if (
        capture.startedAt < startedAt - PENDING_OPERATION_EVENT_CAPTURE_SKEW_MS ||
        capture.completedAt > completedAt + PENDING_OPERATION_EVENT_CAPTURE_SKEW_MS
      ) {
        continue;
      }

      this.pendingOperationEventCaptures.splice(index, 1);
      return capture.events;
    }

    return undefined;
  }

  private async drainPendingEngineEvents(
    context: TraceContext | undefined,
  ): Promise<readonly OpensteerEvent[] | undefined> {
    const pageRef = context?.pageRef ?? this.pageRef;
    if (pageRef === undefined || this.engine === undefined) {
      return undefined;
    }

    const events = await this.engine.drainEvents({ pageRef }).catch(() => []);
    return events.length > 0 ? events : undefined;
  }

  private async navigatePage(
    input: {
      readonly operation: "session.open" | "page.goto";
      readonly pageRef: PageRef;
      readonly url: string;
    },
    timeout: TimeoutExecutionContext,
  ) {
    const remainingMs = timeout.remainingMs();
    const navigation = await timeout.runStep(() =>
      this.requireEngine().navigate({
        pageRef: input.pageRef,
        url: input.url,
        ...(remainingMs === undefined ? {} : { timeoutMs: remainingMs }),
      }),
    );
    await timeout.runStep(() =>
      settleWithPolicy(this.policy.settle, {
        operation: input.operation,
        trigger: "navigation",
        engine: this.requireEngine(),
        pageRef: input.pageRef,
        signal: timeout.signal,
        remainingMs: timeout.remainingMs(),
      }),
    );
    return navigation;
  }
}

function buildRuntimeTraceContext(input: {
  readonly sessionRef: SessionRef | undefined;
  readonly pageRef: PageRef | undefined;
  readonly frameRef?: FrameRef | undefined;
  readonly documentRef?: DocumentRef | undefined;
  readonly documentEpoch?: DocumentEpoch | undefined;
}): TraceContext {
  return {
    ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
    ...(input.pageRef === undefined ? {} : { pageRef: input.pageRef }),
    ...(input.frameRef === undefined ? {} : { frameRef: input.frameRef }),
    ...(input.documentRef === undefined ? {} : { documentRef: input.documentRef }),
    ...(input.documentEpoch === undefined ? {} : { documentEpoch: input.documentEpoch }),
  };
}

function buildArtifactScope(input: {
  readonly sessionRef: SessionRef | undefined;
  readonly pageRef: PageRef | undefined;
  readonly frameRef?: FrameRef | undefined;
  readonly documentRef?: DocumentRef | undefined;
  readonly documentEpoch?: DocumentEpoch | undefined;
}): TraceContext {
  return buildRuntimeTraceContext(input);
}

function readStepResultEvents(value: unknown): readonly OpensteerEvent[] | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }

  if (!("events" in value)) {
    return undefined;
  }

  const events = (value as { readonly events?: unknown }).events;
  return Array.isArray(events) ? (events as readonly OpensteerEvent[]) : undefined;
}

function mergeObservedStepEvents(
  primary: readonly OpensteerEvent[] | undefined,
  secondary: readonly OpensteerEvent[] | undefined,
): readonly OpensteerEvent[] | undefined {
  if (primary === undefined || primary.length === 0) {
    return secondary === undefined || secondary.length === 0 ? undefined : secondary;
  }
  if (secondary === undefined || secondary.length === 0) {
    return primary;
  }

  const merged = new Map<string, OpensteerEvent>();
  for (const event of primary) {
    merged.set(event.eventId, event);
  }
  for (const event of secondary) {
    merged.set(event.eventId, event);
  }
  return [...merged.values()].sort(
    (left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0),
  );
}

function selectLiveQueryPageRef(
  input: Pick<OpensteerNetworkQueryInput, "pageRef" | "recordId">,
  currentPageRef: PageRef | undefined,
): PageRef | undefined {
  if (input.pageRef !== undefined) {
    return input.pageRef;
  }
  if (input.recordId !== undefined) {
    return undefined;
  }
  return currentPageRef;
}

function buildEngineNetworkRecordFilters(
  input: Pick<
    OpensteerNetworkQueryInput,
    "url" | "hostname" | "path" | "method" | "status" | "resourceType"
  >,
): {
  readonly url?: string;
  readonly hostname?: string;
  readonly path?: string;
  readonly method?: string;
  readonly status?: string;
  readonly resourceType?: NetworkQueryRecord["record"]["resourceType"];
} {
  return {
    ...(input.url === undefined ? {} : { url: input.url }),
    ...(input.hostname === undefined ? {} : { hostname: input.hostname }),
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.method === undefined ? {} : { method: input.method }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
  };
}

function resolveLiveQueryRequestIds(
  input: Pick<OpensteerNetworkQueryInput, "recordId" | "requestId" | "capture" | "tag">,
  history: NetworkHistory,
): readonly string[] | undefined {
  const requestIdCandidates: ReadonlySet<string>[] = [];

  if (input.recordId !== undefined) {
    const requestId = history.getRequestId(input.recordId);
    if (requestId === undefined) {
      return [];
    }
    requestIdCandidates.push(new Set([requestId]));
  }

  if (input.requestId !== undefined) {
    requestIdCandidates.push(new Set([input.requestId]));
  }

  if (input.capture !== undefined) {
    requestIdCandidates.push(history.getRequestIdsForCapture(input.capture));
  }

  if (input.tag !== undefined) {
    requestIdCandidates.push(history.getRequestIdsForTag(input.tag));
  }

  if (requestIdCandidates.length === 0) {
    return undefined;
  }

  return intersectRequestIdSets(requestIdCandidates);
}

function resolveLiveQueryPageRef(
  input: Pick<OpensteerNetworkQueryInput, "pageRef" | "recordId">,
  currentPageRef: PageRef | undefined,
  requestIds: readonly string[] | undefined,
  history: NetworkHistory,
): PageRef | undefined {
  const requestedPageRef = selectLiveQueryPageRef(input, currentPageRef);
  if (requestedPageRef !== undefined || requestIds === undefined) {
    return requestedPageRef;
  }

  const pageRefs = new Set<PageRef>();
  for (const requestId of requestIds) {
    const pageRef = history.getPageRefForRequestId(requestId);
    if (pageRef === undefined) {
      continue;
    }
    pageRefs.add(pageRef);
    if (pageRefs.size > 1) {
      return undefined;
    }
  }

  return pageRefs.values().next().value;
}

function intersectRequestIdSets(requestIdSets: readonly ReadonlySet<string>[]): readonly string[] {
  let current = new Set<string>(requestIdSets[0] ?? []);
  for (const requestIds of requestIdSets.slice(1)) {
    current = new Set([...current].filter((requestId) => requestIds.has(requestId)));
    if (current.size === 0) {
      return [];
    }
  }
  return [...current];
}

function filterNetworkQueryRecords(
  records: readonly NetworkQueryRecord[],
  input: {
    readonly recordId?: string;
    readonly requestId?: string;
    readonly capture?: string;
    readonly tag?: string;
    readonly url?: string;
    readonly hostname?: string;
    readonly path?: string;
    readonly method?: string;
    readonly status?: string;
    readonly resourceType?: NetworkQueryRecord["record"]["resourceType"];
  },
): readonly NetworkQueryRecord[] {
  const networkFilters = buildEngineNetworkRecordFilters(input);
  return records.filter((record) => {
    if (input.recordId !== undefined && record.recordId !== input.recordId) {
      return false;
    }
    if (input.requestId !== undefined && record.record.requestId !== input.requestId) {
      return false;
    }
    if (input.capture !== undefined && record.capture !== input.capture) {
      return false;
    }
    if (input.tag !== undefined && !(record.tags ?? []).includes(input.tag)) {
      return false;
    }
    if (!matchesNetworkRecordFilters(record.record, networkFilters)) {
      return false;
    }
    return true;
  });
}

function sortLiveNetworkRecords(
  records: readonly NetworkQueryRecord[],
  history: NetworkHistory,
): NetworkQueryRecord[] {
  return [...records].sort((left, right) => {
    const leftObservedAt = history.getObservedAt(left.recordId) ?? 0;
    const rightObservedAt = history.getObservedAt(right.recordId) ?? 0;
    if (leftObservedAt !== rightObservedAt) {
      return rightObservedAt - leftObservedAt;
    }
    return left.recordId.localeCompare(right.recordId);
  });
}

function buildRawTransportRequest(input: OpensteerRawRequestInput): {
  readonly method: string;
  readonly url: string;
  readonly headers?: readonly HeaderEntry[];
  readonly body?: BrowserBodyPayload;
  readonly followRedirects?: boolean;
} {
  const body = input.body === undefined ? undefined : toBrowserRequestBody(input.body);
  const headers = [...(input.headers ?? [])];
  if (
    body?.contentType !== undefined &&
    !headers.some((header) => header.name.toLowerCase() === "content-type")
  ) {
    headers.push({
      name: "content-type",
      value: body.contentType,
    });
  }

  return {
    method: input.method ?? "GET",
    url: input.url,
    ...(headers.length === 0 ? {} : { headers }),
    ...(body === undefined ? {} : { body: body.payload }),
    ...(input.followRedirects === undefined ? {} : { followRedirects: input.followRedirects }),
  };
}

function toBrowserRequestBody(input: OpensteerRawRequestInput["body"]): {
  readonly payload: BrowserBodyPayload;
  readonly contentType?: string;
} {
  if (input === undefined) {
    throw new Error("request body input is required");
  }
  if ("json" in input) {
    const contentType = input.contentType ?? "application/json; charset=utf-8";
    return {
      payload: bodyPayloadFromUtf8(JSON.stringify(input.json), parseContentType(contentType)),
      contentType,
    };
  }
  if ("text" in input) {
    const contentType = input.contentType ?? "text/plain; charset=utf-8";
    return {
      payload: bodyPayloadFromUtf8(input.text, parseContentType(contentType)),
      contentType,
    };
  }
  return {
    payload: createBodyPayload(
      new Uint8Array(Buffer.from(input.base64, "base64")),
      parseContentType(input.contentType),
    ),
    ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
  };
}

function parseContentType(contentType: string | undefined): {
  readonly mimeType?: string;
  readonly charset?: string;
} {
  if (contentType === undefined) {
    return {};
  }
  const [mimeTypePart, ...parts] = contentType.split(";");
  const mimeType = mimeTypePart?.trim();
  let charset: string | undefined;
  for (const part of parts) {
    const [name, rawValue] = part.split("=");
    if (name?.trim().toLowerCase() === "charset" && rawValue !== undefined) {
      charset = rawValue.trim();
    }
  }
  return {
    ...(mimeType === undefined || mimeType.length === 0 ? {} : { mimeType }),
    ...(charset === undefined || charset.length === 0 ? {} : { charset }),
  };
}

function toJsonValueOrNull(value: unknown) {
  if (value === undefined) {
    return null as Exclude<OpensteerPageEvaluateOutput["value"], undefined>;
  }
  return (toCanonicalJsonValue(value) ?? null) as Exclude<
    OpensteerPageEvaluateOutput["value"],
    undefined
  >;
}

function stringifyRecipeVariableValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(toCanonicalJsonValue(value));
}

function normalizePageScriptScan(value: unknown): {
  readonly loadEventStart?: number;
  readonly scripts: readonly {
    readonly source: "inline" | "external";
    readonly url?: string;
    readonly type?: string;
    readonly loadOrder: number;
    readonly content: string;
  }[];
  readonly resourceEntries: readonly {
    readonly url: string;
    readonly initiatorType?: string;
    readonly startTime?: number;
  }[];
} {
  if (value === null || typeof value !== "object") {
    return {
      scripts: [],
      resourceEntries: [],
    };
  }
  const source = value as {
    readonly loadEventStart?: unknown;
    readonly scripts?: readonly {
      readonly source?: unknown;
      readonly url?: unknown;
      readonly type?: unknown;
      readonly loadOrder?: unknown;
      readonly content?: unknown;
    }[];
    readonly resourceEntries?: readonly {
      readonly url?: unknown;
      readonly initiatorType?: unknown;
      readonly startTime?: unknown;
    }[];
  };

  return {
    ...(typeof source.loadEventStart === "number" ? { loadEventStart: source.loadEventStart } : {}),
    scripts: (source.scripts ?? [])
      .filter(
        (
          script,
        ): script is {
          readonly source: "inline" | "external";
          readonly url?: string;
          readonly type?: string;
          readonly loadOrder: number;
          readonly content: string;
        } =>
          (script?.source === "inline" || script?.source === "external") &&
          typeof script.loadOrder === "number" &&
          typeof script.content === "string" &&
          (script.url === undefined || typeof script.url === "string") &&
          (script.type === undefined || typeof script.type === "string"),
      )
      .sort((left, right) => left.loadOrder - right.loadOrder),
    resourceEntries: (source.resourceEntries ?? [])
      .filter(
        (
          entry,
        ): entry is {
          readonly url: string;
          readonly initiatorType?: string;
          readonly startTime?: number;
        } =>
          typeof entry?.url === "string" &&
          entry.url.length > 0 &&
          (entry.initiatorType === undefined || typeof entry.initiatorType === "string") &&
          (entry.startTime === undefined || typeof entry.startTime === "number"),
      )
      .map((entry) => ({
        url: entry.url,
        ...(entry.initiatorType === undefined ? {} : { initiatorType: entry.initiatorType }),
        ...(entry.startTime === undefined ? {} : { startTime: entry.startTime }),
      })),
  };
}

function normalizeTransportKind(value: TransportKind): TransportKind {
  return value;
}

function transportRequiresBrowserBinding(value: TransportKind): boolean {
  return value !== "direct-http";
}

function createFullMinimizationKeepState(
  prepared: PreparedMinimizationRequest,
): Parameters<typeof materializePreparedMinimizationRequest>[1] {
  return {
    headers: new Set(
      prepared.headerGroups.map((header) => `header:${header.name.trim().toLowerCase()}`),
    ),
    cookies: new Set(
      prepared.cookies.map((cookie) => `cookie:${cookie.name.trim().toLowerCase()}`),
    ),
    query: new Set(prepared.queryEntries.map((entry) => `query:${entry.name}`)),
    bodyFields: new Set(prepared.bodyJsonEntries.map(([name]) => `body-field:${name}`)),
  };
}

function buildSuccessFingerprint(response: {
  readonly status: number;
  readonly body?: BrowserBodyPayload;
}): {
  readonly status: number;
  readonly structureHash?: string;
} {
  const bodyText = decodeBrowserBody(response.body);
  return {
    status: response.status,
    ...(bodyText === undefined
      ? {}
      : (() => {
          const structureHash = jsonStructureHash(bodyText);
          return structureHash === undefined ? {} : { structureHash };
        })()),
  };
}

function matchesSuccessFingerprint(
  response: {
    readonly status: number;
    readonly body?: BrowserBodyPayload;
  },
  fingerprint: {
    readonly status: number;
    readonly structureHash?: string;
  },
  policy?: OpensteerNetworkMinimizeInput["successPolicy"],
): boolean {
  const expectedStatuses = policy?.statusCodes ?? [fingerprint.status];
  if (!expectedStatuses.includes(response.status)) {
    return false;
  }

  const bodyText = decodeBrowserBody(response.body);
  if (policy?.responseBodyIncludes?.some((value) => !(bodyText?.includes(value) ?? false))) {
    return false;
  }

  const mustMatchStructure =
    policy?.responseStructureMatch ?? fingerprint.structureHash !== undefined;
  if (!mustMatchStructure) {
    return true;
  }
  return jsonStructureHash(bodyText) === fingerprint.structureHash;
}

function jsonStructureHash(bodyText: string | undefined): string | undefined {
  if (bodyText === undefined) {
    return undefined;
  }
  try {
    return sha256Hex(
      Buffer.from(canonicalJsonString(jsonStructureShape(JSON.parse(bodyText))), "utf8"),
    );
  } catch {
    return undefined;
  }
}

function jsonStructureShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => jsonStructureShape(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, jsonStructureShape((value as Record<string, unknown>)[key])]),
    );
  }
  return typeof value;
}

function decodeBrowserBody(body: BrowserBodyPayload | undefined): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  return Buffer.from(body.bytes).toString(resolveBrowserBodyEncoding(body.charset));
}

function resolveBrowserBodyEncoding(charset: string | undefined): BufferEncoding {
  switch (charset?.trim().toLowerCase()) {
    case "ascii":
    case "latin1":
    case "utf16le":
    case "utf-16le":
      return charset.replace("-", "").toLowerCase() as BufferEncoding;
    case "utf8":
    case "utf-8":
    default:
      return "utf8";
  }
}

function buildMinimizedRequestPlan(input: {
  readonly record: NetworkQueryRecord;
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headers?: readonly HeaderEntry[];
    readonly body?: BrowserBodyPayload;
  };
  readonly transport: TransportKind;
  readonly kept: {
    readonly headers: readonly string[];
    readonly cookies: readonly string[];
    readonly query: readonly string[];
    readonly bodyFields: readonly string[];
  };
}): OpensteerWriteRequestPlanInput {
  const url = new URL(input.request.url);
  const headers = input.request.headers ?? [];
  const validHeaders = filterValidHttpHeaders(headers);
  const requestContentType =
    headerValue(validHeaders, "content-type") ?? input.request.body?.mimeType;
  const body = buildMinimizedRequestPlanBody(input.request.body, requestContentType);
  const responseContentType = headerValue(input.record.record.responseHeaders, "content-type");

  return {
    key: buildMinimizedRequestPlanKey(input.record),
    version: "1.0.0",
    ...(input.record.tags === undefined || input.record.tags.length === 0
      ? {}
      : { tags: input.record.tags }),
    provenance: {
      source: "network-minimize",
      sourceId: input.record.recordId,
      ...(input.record.savedAt === undefined ? {} : { capturedAt: input.record.savedAt }),
    },
    payload: normalizeRequestPlanPayload({
      transport: {
        kind: input.transport,
      },
      endpoint: {
        method: input.request.method,
        urlTemplate: `${url.origin}${url.pathname}`,
        ...(url.searchParams.size === 0
          ? {}
          : {
              defaultQuery: Array.from(url.searchParams.entries()).map(([name, value]) => ({
                name,
                value,
              })),
            }),
        ...(validHeaders.length === 0
          ? {}
          : {
              defaultHeaders: validHeaders.map((header) => ({
                name: header.name,
                value: header.value,
              })),
            }),
      },
      ...(body === undefined ? {} : { body }),
      ...(typeof input.record.record.status !== "number"
        ? {}
        : {
            response: {
              status: input.record.record.status,
              ...(responseContentType === undefined ? {} : { contentType: responseContentType }),
            },
          }),
      ...(inferMinimizedPlanAuth(validHeaders) === undefined
        ? {}
        : { auth: inferMinimizedPlanAuth(validHeaders)! }),
    }),
  };
}

function buildMinimizedRequestPlanBody(
  body: BrowserBodyPayload | undefined,
  contentType: string | undefined,
): OpensteerWriteRequestPlanInput["payload"]["body"] | undefined {
  if (body === undefined) {
    return undefined;
  }
  const bodyText = decodeBrowserBody(body) ?? "";
  const normalizedContentType = contentType?.toLowerCase();
  if (
    normalizedContentType?.includes("application/json") === true ||
    normalizedContentType?.includes("+json") === true
  ) {
    try {
      return {
        kind: "json",
        required: true,
        ...(contentType === undefined ? {} : { contentType }),
        template: toCanonicalJsonValue(JSON.parse(bodyText)),
      };
    } catch {}
  }
  if (normalizedContentType?.includes("application/x-www-form-urlencoded") === true) {
    const params = new URLSearchParams(bodyText);
    return {
      kind: "form",
      required: true,
      ...(contentType === undefined ? {} : { contentType }),
      fields: Array.from(params.entries()).map(([name, value]) => ({
        name,
        value,
      })),
    };
  }
  return {
    kind: "text",
    required: true,
    ...(contentType === undefined ? {} : { contentType }),
    template: bodyText,
  };
}

function inferMinimizedPlanAuth(
  headers: readonly HeaderEntry[],
): OpensteerWriteRequestPlanInput["payload"]["auth"] | undefined {
  const headerNames = new Set(headers.map((header) => header.name.trim().toLowerCase()));
  if (headerNames.has("authorization")) {
    return {
      strategy: "bearer-token",
      description: "Inferred from a required Authorization header in the minimized request.",
    };
  }
  if (headerNames.has("cookie")) {
    return {
      strategy: "session-cookie",
      description: "Inferred from required cookies in the minimized request.",
    };
  }
  if (
    headerNames.has("api-key") ||
    headerNames.has("x-api-key") ||
    headerNames.has("x-auth-token")
  ) {
    return {
      strategy: "api-key",
      description: "Inferred from a required API key style header in the minimized request.",
    };
  }
  return undefined;
}

function buildMinimizedRequestPlanKey(record: NetworkQueryRecord): string {
  const url = new URL(record.record.url);
  const slug = `${record.record.method}-${url.hostname}${url.pathname}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `minimized-${slug || "request"}`;
}

function buildReverseCaseKey(objective: string | undefined, pageUrl: string): string {
  const seed = objective ?? pageUrl;
  return (
    seed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || `reverse-${Date.now()}`
  );
}

function buildInteractionTraceKey(pageUrl: string): string {
  return `interaction-${buildReverseCaseKey(undefined, pageUrl)}`;
}

function mergeStringArrays(left: readonly string[], right: readonly string[]): readonly string[] {
  return [...new Set([...left, ...right])];
}

function mergeReverseGuards(
  existing: readonly OpensteerReverseGuardRecord[],
  incoming: readonly OpensteerReverseGuardRecord[],
): readonly OpensteerReverseGuardRecord[] {
  const merged = new Map(existing.map((guard) => [guard.id, guard]));
  for (const guard of incoming) {
    merged.set(guard.id, guard);
  }
  return [...merged.values()];
}

function mergeObservationClusters(
  existing: readonly OpensteerObservationCluster[],
  incoming: readonly OpensteerObservationCluster[],
): readonly OpensteerObservationCluster[] {
  const merged = new Map(existing.map((cluster) => [cluster.id, cluster]));
  for (const cluster of incoming) {
    merged.set(cluster.id, cluster);
  }
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function collectReverseReplayStateSnapshotsFromCase(
  caseRecord: ReverseCaseRecord,
  candidate: OpensteerReverseCandidateRecord,
): readonly OpensteerStateSnapshot[] {
  const snapshotIds = new Set<string>();
  const observation = caseRecord.payload.observations.find(
    (entry) => entry.id === candidate.observationId,
  );
  for (const snapshotId of observation?.stateSnapshotIds ?? []) {
    snapshotIds.add(snapshotId);
  }
  for (const resolver of candidate.resolvers) {
    if (
      resolver.valueRef?.kind === "state-snapshot" &&
      resolver.valueRef.stateSnapshotId !== undefined
    ) {
      snapshotIds.add(resolver.valueRef.stateSnapshotId);
    }
  }
  return caseRecord.payload.stateSnapshots.filter((snapshot) => snapshotIds.has(snapshot.id));
}

function mergeReverseStateSnapshotCookies(
  snapshots: readonly OpensteerStateSnapshot[],
  sessionRef: SessionRef,
): readonly CookieRecord[] {
  const merged = new Map<string, CookieRecord>();
  for (const snapshot of [...snapshots].sort((left, right) => left.capturedAt - right.capturedAt)) {
    for (const cookie of snapshot.cookies ?? []) {
      merged.set(`${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`, {
        sessionRef,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
        ...(cookie.priority === undefined ? {} : { priority: cookie.priority }),
        ...(cookie.partitionKey === undefined ? {} : { partitionKey: cookie.partitionKey }),
        session: cookie.session,
        ...(cookie.expiresAt === undefined ? {} : { expiresAt: cookie.expiresAt }),
      });
    }
  }
  return [...merged.values()];
}

function mergeReverseStateSnapshotLocalStorage(
  snapshots: readonly OpensteerStateSnapshot[],
): Map<string, readonly { readonly key: string; readonly value: string }[]> {
  const merged = new Map<string, Map<string, string>>();
  for (const snapshot of [...snapshots].sort((left, right) => left.capturedAt - right.capturedAt)) {
    for (const origin of snapshot.storage?.origins ?? []) {
      const entries = merged.get(origin.origin) ?? new Map<string, string>();
      entries.clear();
      for (const entry of origin.localStorage) {
        entries.set(entry.key, entry.value);
      }
      merged.set(origin.origin, entries);
    }
  }
  return new Map(
    [...merged.entries()].map(([origin, entries]) => [
      origin,
      [...entries.entries()].map(([key, value]) => ({ key, value })),
    ]),
  );
}

function mergeReverseStateSnapshotSessionStorage(
  snapshots: readonly OpensteerStateSnapshot[],
): Map<string, readonly { readonly key: string; readonly value: string }[]> {
  const merged = new Map<string, Map<string, string>>();
  for (const snapshot of [...snapshots].sort((left, right) => left.capturedAt - right.capturedAt)) {
    for (const sessionStorage of snapshot.storage?.sessionStorage ?? []) {
      const entries = merged.get(sessionStorage.origin) ?? new Map<string, string>();
      entries.clear();
      for (const entry of sessionStorage.entries) {
        entries.set(entry.key, entry.value);
      }
      merged.set(sessionStorage.origin, entries);
    }
  }
  return new Map(
    [...merged.entries()].map(([origin, entries]) => [
      origin,
      [...entries.entries()].map(([key, value]) => ({ key, value })),
    ]),
  );
}

function resolveReverseReplayStateRestoreUrl(
  candidate: OpensteerReverseCandidateRecord,
  snapshots: readonly OpensteerStateSnapshot[],
  currentUrl: string,
): string {
  const navigationUrl = candidate.channel.kind === "http" ? candidate.channel.url : undefined;
  const preferredSnapshotUrl = [...snapshots]
    .sort((left, right) => right.capturedAt - left.capturedAt)
    .find((snapshot) => typeof snapshot.url === "string" && snapshot.url.length > 0)?.url;
  return preferredSnapshotUrl ?? navigationUrl ?? currentUrl;
}

function buildReverseStateRestoreNavigationUrl(
  preferredUrl: string | undefined,
  origin: string,
): string {
  if (preferredUrl !== undefined) {
    const preferredOrigin = originFromUrl(preferredUrl);
    if (preferredOrigin === origin) {
      return preferredUrl;
    }
  }
  return origin.endsWith("/") ? origin : `${origin}/`;
}

function originFromUrl(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function filterReverseObservationWindow(
  records: readonly NetworkQueryRecord[],
  history: NetworkHistory,
  captureWindowMs: number | undefined,
): readonly NetworkQueryRecord[] {
  if (captureWindowMs === undefined) {
    return records;
  }
  const observedAfter = Date.now() - captureWindowMs;
  return records.filter((record) => (history.getObservedAt(record.recordId) ?? 0) >= observedAfter);
}

function isReverseRelevantNetworkRecord(record: NetworkQueryRecord): boolean {
  return (
    record.record.resourceType === "document" ||
    record.record.resourceType === "fetch" ||
    record.record.resourceType === "xhr" ||
    record.record.resourceType === "websocket" ||
    record.record.resourceType === "event-stream"
  );
}

function resolveReverseCandidate(
  caseRecord: ReverseCaseRecord,
  candidateId: string,
): OpensteerReverseCandidateRecord {
  const candidate = caseRecord.payload.candidates.find((entry) => entry.id === candidateId);
  if (candidate === undefined) {
    throw new OpensteerProtocolError(
      "not-found",
      `reverse candidate ${candidateId} was not found in case ${caseRecord.id}`,
    );
  }
  return candidate;
}

function resolveReverseTemplate(
  candidate: OpensteerReverseCandidateRecord,
  templateId: string | undefined,
): OpensteerReverseAdvisoryTemplate | undefined {
  if (templateId === undefined) {
    return undefined;
  }
  const template = candidate.advisoryTemplates.find((entry) => entry.id === templateId);
  if (template === undefined) {
    throw new OpensteerProtocolError(
      "not-found",
      `reverse template ${templateId} was not found for ${candidate.id}`,
    );
  }
  return template;
}

function dedupeStringList(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function resolveReverseObservedRecord(
  caseRecord: ReverseCaseRecord,
  recordId: string,
): OpensteerReverseObservedRecord {
  const record = caseRecord.payload.observedRecords.find((entry) => entry.recordId === recordId);
  if (record === undefined) {
    throw new OpensteerProtocolError(
      "not-found",
      `reverse observed record ${recordId} was not found in case ${caseRecord.id}`,
    );
  }
  return record;
}

function buildReverseDiscoveryIndex(
  caseRecord: ReverseCaseRecord,
): OpensteerReverseDiscoverOutput["index"] {
  return {
    views: ["records", "clusters", "candidates"],
    sortableKeys: [
      "observed-at",
      "advisory-rank",
      "target-hint-matches",
      "response-richness",
      "portability",
      "boundary",
      "success",
    ],
    channels: dedupeStringList(
      caseRecord.payload.observedRecords.map((entry) => entry.channel.kind),
    ) as OpensteerReverseDiscoverOutput["index"]["channels"],
    hosts: dedupeStringList(
      caseRecord.payload.observedRecords.map((entry) => new URL(entry.channel.url).hostname),
    ),
    relationKinds: dedupeStringList(
      caseRecord.payload.observedRecords.flatMap((entry) => entry.relationKinds),
    ) as OpensteerReverseDiscoverOutput["index"]["relationKinds"],
  };
}

function buildReverseSummaryCounts(
  caseRecord: ReverseCaseRecord,
): ReverseReportRecord["payload"]["summaryCounts"] {
  const hosts: Record<string, number> = {};
  const channels: Record<string, number> = {};
  const resourceTypes: Record<string, number> = {};
  const advisoryTags: Record<string, number> = {};
  const constraints: Record<string, number> = {};
  const relationKinds: Record<string, number> = {};

  for (const record of caseRecord.payload.observedRecords) {
    const host = new URL(record.channel.url).hostname;
    hosts[host] = (hosts[host] ?? 0) + 1;
    channels[record.channel.kind] = (channels[record.channel.kind] ?? 0) + 1;
    if (record.resourceType !== undefined) {
      resourceTypes[record.resourceType] = (resourceTypes[record.resourceType] ?? 0) + 1;
    }
    for (const relationKind of record.relationKinds) {
      relationKinds[relationKind] = (relationKinds[relationKind] ?? 0) + 1;
    }
  }

  for (const candidate of caseRecord.payload.candidates) {
    for (const tag of candidate.advisoryTags) {
      advisoryTags[tag] = (advisoryTags[tag] ?? 0) + 1;
    }
    for (const constraint of candidate.constraints) {
      constraints[constraint] = (constraints[constraint] ?? 0) + 1;
    }
  }

  return {
    hosts,
    channels,
    resourceTypes,
    advisoryTags,
    constraints,
    relationKinds,
  };
}

function buildReverseCandidateRankingReasons(
  candidate: OpensteerReverseCandidateRecord,
): readonly string[] {
  const reasons = [
    candidate.summary,
    `${candidate.boundary} candidate advisory rank ${candidate.signals.advisoryRank}`,
    `${candidate.bodyCodec.kind} body codec`,
  ];
  if (candidate.advisoryTags.length > 0) {
    reasons.push(`advisory tags: ${candidate.advisoryTags.join(", ")}`);
  }
  if (candidate.constraints.length > 0) {
    reasons.push(`constraints: ${candidate.constraints.join(", ")}`);
  }
  if (candidate.matchedTargetHints.length > 0) {
    reasons.push(`matched target hints: ${candidate.matchedTargetHints.join(", ")}`);
  }
  if (candidate.guardIds.length > 0) {
    reasons.push(`depends on ${candidate.guardIds.length} guard(s)`);
  }
  if (candidate.resolvers.length > 0) {
    reasons.push(`tracks ${candidate.resolvers.length} resolver(s)`);
  }
  return reasons;
}

function normalizeReverseQuerySort(sort: OpensteerReverseQuerySort | undefined): {
  readonly preset?: OpensteerReverseQuerySort["preset"];
  readonly keys: readonly {
    readonly key: OpensteerReverseSortKey;
    readonly direction: "asc" | "desc";
  }[];
} {
  const normalizedKeys =
    sort?.keys?.map((entry) => ({
      key: entry.key,
      direction: entry.direction ?? "desc",
    })) ?? [];
  if (normalizedKeys.length > 0) {
    return {
      ...(sort?.preset === undefined ? {} : { preset: sort.preset }),
      keys: normalizedKeys,
    };
  }
  const preset = sort?.preset ?? "observed-at";
  return {
    ...(preset === undefined ? {} : { preset }),
    keys: presetToReverseSortKeys(preset),
  };
}

function normalizeReverseQueryLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 20;
  }
  return Math.max(1, Math.min(200, Math.trunc(limit)));
}

function presetToReverseSortKeys(
  preset: NonNullable<OpensteerReverseQuerySort["preset"]>,
): readonly {
  readonly key: OpensteerReverseSortKey;
  readonly direction: "asc" | "desc";
}[] {
  switch (preset) {
    case "advisory-rank":
      return [{ key: "advisory-rank", direction: "desc" }];
    case "portability":
      return [{ key: "portability", direction: "desc" }];
    case "first-party":
      return [{ key: "boundary", direction: "desc" }];
    case "hint-match":
      return [{ key: "target-hint-matches", direction: "desc" }];
    case "response-richness":
      return [{ key: "response-richness", direction: "desc" }];
    case "observed-at":
    default:
      return [{ key: "observed-at", direction: "desc" }];
  }
}

function primaryReverseSortDirection(
  sort: ReturnType<typeof normalizeReverseQuerySort>,
): "asc" | "desc" {
  return sort.keys[0]?.direction ?? "desc";
}

function reverseCandidateSortValue(
  candidate: OpensteerReverseCandidateRecord,
  key: OpensteerReverseSortKey,
): number {
  switch (key) {
    case "observed-at":
      return candidate.signals.observedAt ?? 0;
    case "advisory-rank":
      return candidate.signals.advisoryRank;
    case "target-hint-matches":
      return candidate.signals.targetHintMatches;
    case "response-richness":
      return candidate.signals.responseRichness;
    case "portability":
      return candidate.signals.portabilityWeight;
    case "boundary":
      return candidate.signals.boundaryWeight;
    case "success":
      return candidate.signals.successfulStatus ? 1 : 0;
  }
}

function parseReverseQueryCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  const value = Number.parseInt(cursor, 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function buildReverseQuerySnapshot(input: {
  readonly view: OpensteerReverseQueryView;
  readonly filters?: OpensteerReverseQueryFilters;
  readonly sort: ReturnType<typeof normalizeReverseQuerySort>;
  readonly limit: number;
  readonly totalCount: number;
  readonly offset: number;
  readonly resultIds: readonly string[];
}): OpensteerReverseQuerySnapshot {
  const nextOffset = input.offset + input.resultIds.length;
  return {
    view: input.view,
    ...(input.filters === undefined ? {} : { filters: input.filters }),
    sort:
      input.sort.preset === undefined
        ? { keys: input.sort.keys }
        : { preset: input.sort.preset, keys: input.sort.keys },
    limit: input.limit,
    totalCount: input.totalCount,
    ...(nextOffset >= input.totalCount ? {} : { nextCursor: String(nextOffset) }),
    resultIds: input.resultIds,
  };
}

function compareReverseCandidates(
  left: OpensteerReverseCandidateRecord,
  right: OpensteerReverseCandidateRecord,
  sort: ReturnType<typeof normalizeReverseQuerySort>,
): number {
  for (const entry of sort.keys) {
    const compare = compareNumbers(
      reverseCandidateSortValue(left, entry.key),
      reverseCandidateSortValue(right, entry.key),
      entry.direction === "asc" ? 1 : -1,
    );
    if (compare !== 0) {
      return compare;
    }
  }
  return left.id.localeCompare(right.id);
}

function compareReverseObservedRecords(
  left: OpensteerReverseObservedRecord,
  right: OpensteerReverseObservedRecord,
  candidates: readonly OpensteerReverseCandidateRecord[],
  sort: ReturnType<typeof normalizeReverseQuerySort>,
): number {
  const leftCandidate = bestReverseCandidateForRecord(left.recordId, candidates, sort);
  const rightCandidate = bestReverseCandidateForRecord(right.recordId, candidates, sort);
  return (
    compareReverseCandidatesProxy(leftCandidate, rightCandidate, sort) ||
    compareNumbers(
      left.observedAt ?? 0,
      right.observedAt ?? 0,
      primaryReverseSortDirection(sort) === "asc" ? 1 : -1,
    ) ||
    left.recordId.localeCompare(right.recordId)
  );
}

function compareReverseClusters(
  left: OpensteerObservationCluster,
  right: OpensteerObservationCluster,
  candidates: readonly OpensteerReverseCandidateRecord[],
  sort: ReturnType<typeof normalizeReverseQuerySort>,
): number {
  const leftCandidate = bestReverseCandidateForCluster(left.id, candidates, sort);
  const rightCandidate = bestReverseCandidateForCluster(right.id, candidates, sort);
  return (
    compareReverseCandidatesProxy(leftCandidate, rightCandidate, sort) ||
    left.id.localeCompare(right.id)
  );
}

function compareReverseCandidatesProxy(
  left: OpensteerReverseCandidateRecord | undefined,
  right: OpensteerReverseCandidateRecord | undefined,
  sort: ReturnType<typeof normalizeReverseQuerySort>,
): number {
  if (left === undefined && right === undefined) {
    return 0;
  }
  if (left === undefined) {
    return 1;
  }
  if (right === undefined) {
    return -1;
  }
  return compareReverseCandidates(left, right, sort);
}

function compareNumbers(left: number, right: number, direction: 1 | -1): number {
  return direction === 1 ? left - right : right - left;
}

function bestReverseCandidateForRecord(
  recordId: string,
  candidates: readonly OpensteerReverseCandidateRecord[],
  sort: ReturnType<typeof normalizeReverseQuerySort>,
): OpensteerReverseCandidateRecord | undefined {
  return [...candidates]
    .filter((candidate) => candidate.recordId === recordId)
    .sort((left, right) => compareReverseCandidates(left, right, sort))[0];
}

function bestReverseCandidateForCluster(
  clusterId: string,
  candidates: readonly OpensteerReverseCandidateRecord[],
  sort: ReturnType<typeof normalizeReverseQuerySort>,
): OpensteerReverseCandidateRecord | undefined {
  return [...candidates]
    .filter((candidate) => candidate.clusterId === clusterId)
    .sort((left, right) => compareReverseCandidates(left, right, sort))[0];
}

function matchesReverseCandidateFilters(
  candidate: OpensteerReverseCandidateRecord,
  filters: OpensteerReverseQueryFilters | undefined,
  context: {
    readonly observedRecord?: OpensteerReverseObservedRecord;
    readonly observation?: OpensteerReverseObservationRecord;
  } = {},
): boolean {
  if (filters === undefined) {
    return true;
  }
  if (filters.candidateId !== undefined && candidate.id !== filters.candidateId) {
    return false;
  }
  if (filters.clusterId !== undefined && candidate.clusterId !== filters.clusterId) {
    return false;
  }
  if (filters.recordId !== undefined && candidate.recordId !== filters.recordId) {
    return false;
  }
  if (filters.channel !== undefined && candidate.channel.kind !== filters.channel) {
    return false;
  }
  if (filters.boundary !== undefined && candidate.boundary !== filters.boundary) {
    return false;
  }
  if (filters.advisoryTag !== undefined && !candidate.advisoryTags.includes(filters.advisoryTag)) {
    return false;
  }
  if (filters.constraint !== undefined && !candidate.constraints.includes(filters.constraint)) {
    return false;
  }
  if (filters.bodyCodec !== undefined && candidate.bodyCodec.kind !== filters.bodyCodec) {
    return false;
  }
  if (
    filters.relationKind !== undefined &&
    context.observedRecord !== undefined &&
    !context.observedRecord.relationKinds.includes(filters.relationKind)
  ) {
    return false;
  }
  if (filters.hasGuards !== undefined && candidate.guardIds.length > 0 !== filters.hasGuards) {
    return false;
  }
  if (
    filters.hasResolvers !== undefined &&
    candidate.resolvers.length > 0 !== filters.hasResolvers
  ) {
    return false;
  }
  const url = new URL(candidate.channel.url);
  if (filters.host !== undefined && url.hostname !== filters.host) {
    return false;
  }
  if (filters.path !== undefined && !url.pathname.includes(filters.path)) {
    return false;
  }
  if (filters.method !== undefined && candidate.channel.method !== filters.method) {
    return false;
  }
  if (filters.status !== undefined) {
    const matchesStatus = candidate.signals.successfulStatus
      ? filters.status === "2xx" || filters.status === "200"
      : true;
    if (!matchesStatus) {
      return false;
    }
  }
  if (
    filters.artifactId !== undefined &&
    !candidate.scriptArtifactIds.includes(filters.artifactId) &&
    !candidate.resolvers.some(
      (resolver) => extractReverseResolverArtifactId(resolver) === filters.artifactId,
    )
  ) {
    return false;
  }
  if (
    filters.stateSnapshotId !== undefined &&
    !candidate.resolvers.some(
      (resolver) =>
        resolver.valueRef?.kind === "state-snapshot" &&
        resolver.valueRef.stateSnapshotId === filters.stateSnapshotId,
    ) &&
    !(context.observation?.stateSnapshotIds.includes(filters.stateSnapshotId) === true)
  ) {
    return false;
  }
  if (
    filters.traceId !== undefined &&
    !candidate.resolvers.some((resolver) => resolver.traceId === filters.traceId) &&
    !(context.observation?.interactionTraceIds.includes(filters.traceId) === true)
  ) {
    return false;
  }
  if (filters.evidenceRef !== undefined) {
    const matchesEvidence =
      candidate.id === filters.evidenceRef ||
      candidate.clusterId === filters.evidenceRef ||
      candidate.recordId === filters.evidenceRef ||
      candidate.scriptArtifactIds.includes(filters.evidenceRef) ||
      candidate.guardIds.includes(filters.evidenceRef) ||
      candidate.resolvers.some(
        (resolver) =>
          resolver.id === filters.evidenceRef ||
          resolver.traceId === filters.evidenceRef ||
          extractReverseResolverArtifactId(resolver) === filters.evidenceRef ||
          extractReverseResolverRecordId(resolver) === filters.evidenceRef,
      );
    if (!matchesEvidence) {
      return false;
    }
  }
  if (filters.text !== undefined) {
    const haystack = [
      candidate.summary,
      candidate.channel.url,
      candidate.bodyCodec.operationName,
      ...candidate.matchedTargetHints,
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("\n")
      .toLowerCase();
    if (!haystack.includes(filters.text.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function matchesReverseRecordFilters(
  record: OpensteerReverseObservedRecord,
  candidates: readonly OpensteerReverseCandidateRecord[],
  filters: OpensteerReverseQueryFilters | undefined,
): boolean {
  if (filters === undefined) {
    return true;
  }
  if (filters.recordId !== undefined && record.recordId !== filters.recordId) {
    return false;
  }
  if (filters.clusterId !== undefined && record.clusterId !== filters.clusterId) {
    return false;
  }
  if (filters.channel !== undefined && record.channel.kind !== filters.channel) {
    return false;
  }
  if (filters.resourceType !== undefined && record.resourceType !== filters.resourceType) {
    return false;
  }
  if (filters.bodyCodec !== undefined && record.bodyCodec.kind !== filters.bodyCodec) {
    return false;
  }
  const url = new URL(record.channel.url);
  if (filters.host !== undefined && url.hostname !== filters.host) {
    return false;
  }
  if (filters.path !== undefined && !url.pathname.includes(filters.path)) {
    return false;
  }
  if (filters.method !== undefined && record.channel.method !== filters.method) {
    return false;
  }
  if (filters.status !== undefined && String(record.status ?? "") !== filters.status) {
    return false;
  }
  const relatedCandidates = candidates.filter(
    (candidate) => candidate.recordId === record.recordId,
  );
  return relatedCandidates.length === 0
    ? true
    : relatedCandidates.some((candidate) => matchesReverseCandidateFilters(candidate, filters));
}

function matchesReverseClusterFilters(
  cluster: OpensteerObservationCluster,
  candidates: readonly OpensteerReverseCandidateRecord[],
  filters: OpensteerReverseQueryFilters | undefined,
): boolean {
  if (filters === undefined) {
    return true;
  }
  if (filters.clusterId !== undefined && cluster.id !== filters.clusterId) {
    return false;
  }
  if (filters.channel !== undefined && cluster.channel !== filters.channel) {
    return false;
  }
  const url = new URL(cluster.url);
  if (filters.host !== undefined && url.hostname !== filters.host) {
    return false;
  }
  if (filters.path !== undefined && !url.pathname.includes(filters.path)) {
    return false;
  }
  if (filters.method !== undefined && cluster.method !== filters.method) {
    return false;
  }
  const relatedCandidates = candidates.filter((candidate) => candidate.clusterId === cluster.id);
  return relatedCandidates.length === 0
    ? true
    : relatedCandidates.some((candidate) => matchesReverseCandidateFilters(candidate, filters));
}

function toReverseRawRequestBodyInput(
  body: NetworkQueryRecord["record"]["requestBody"] | undefined,
  headers: readonly HeaderEntry[],
): OpensteerRawRequestInput["body"] | undefined {
  if (body === undefined) {
    return undefined;
  }
  const contentType = headerValue(headers, "content-type") ?? body.mimeType;
  const text = decodeProtocolBody(body);
  if (text !== undefined) {
    const normalizedContentType = contentType?.toLowerCase();
    if (
      normalizedContentType?.includes("application/json") === true ||
      normalizedContentType?.includes("+json") === true
    ) {
      try {
        return {
          json: JSON.parse(text),
          ...(contentType === undefined ? {} : { contentType }),
        };
      } catch {
        return {
          text,
          ...(contentType === undefined ? {} : { contentType }),
        };
      }
    }
    return {
      text,
      ...(contentType === undefined ? {} : { contentType }),
    };
  }
  return {
    base64: body.data,
    ...(contentType === undefined ? {} : { contentType }),
  };
}

function extractReverseRuntimeValue(value: unknown, pointer: string | undefined): unknown {
  if (pointer === undefined || pointer.length === 0) {
    return value;
  }
  if (pointer.startsWith("/")) {
    return readJsonPointer(value, pointer);
  }
  return readDotPath(value, pointer);
}

function readDotPath(value: unknown, path: string): unknown {
  if (path.length === 0) {
    return value;
  }
  let current = value;
  for (const segment of path.split(".").filter((entry) => entry.length > 0)) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveReversePackageRuntimeValue(
  packageRecord: ReversePackageRecord,
  pageRef: PageRef,
  runtimeKey: OpensteerValueReference["runtimeKey"] | undefined,
): unknown {
  switch (runtimeKey) {
    case "pageRef":
      return pageRef;
    case "packageId":
      return packageRecord.id;
    case "caseId":
      return packageRecord.payload.caseId;
    case "candidateId":
      return packageRecord.payload.candidateId;
    case "objective":
      return packageRecord.payload.objective;
    case undefined:
      return undefined;
  }
}

function matchesReverseAwaitRecordFilter(
  record: NetworkQueryRecord,
  filter: {
    readonly channel?: OpensteerReverseCandidateRecord["channel"]["kind"];
    readonly method?: string;
    readonly url?: string;
    readonly host?: string;
    readonly path?: string;
    readonly status?: number;
    readonly text?: string;
  },
): boolean {
  if (filter.channel !== undefined && buildChannelDescriptor(record).kind !== filter.channel) {
    return false;
  }
  if (filter.method !== undefined && record.record.method !== filter.method) {
    return false;
  }
  if (filter.url !== undefined && record.record.url !== filter.url) {
    return false;
  }
  const parsedUrl = new URL(record.record.url);
  if (filter.host !== undefined && parsedUrl.hostname !== filter.host) {
    return false;
  }
  if (filter.path !== undefined && !parsedUrl.pathname.includes(filter.path)) {
    return false;
  }
  if (filter.status !== undefined && record.record.status !== filter.status) {
    return false;
  }
  if (filter.text !== undefined) {
    const haystack = [
      record.record.url,
      decodeProtocolBody(record.record.requestBody) ?? "",
      decodeProtocolBody(record.record.responseBody) ?? "",
    ]
      .join("\n")
      .toLowerCase();
    if (!haystack.includes(filter.text.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function resolveReverseCookieResolverValue(
  snapshots: readonly OpensteerStateSnapshot[],
  resolver: OpensteerExecutableResolver,
): string | undefined {
  const scopedSnapshots = filterSnapshotsForResolver(snapshots, resolver);
  const cookieName = resolver.inputNames?.[0];
  if (cookieName === undefined) {
    return undefined;
  }
  for (const snapshot of [...scopedSnapshots].sort(
    (left, right) => right.capturedAt - left.capturedAt,
  )) {
    const match = snapshot.cookies?.find((cookie) => cookie.name === cookieName);
    if (match !== undefined) {
      return match.value;
    }
  }
  return undefined;
}

function resolveReverseStorageResolverValue(
  snapshots: readonly OpensteerStateSnapshot[],
  resolver: OpensteerExecutableResolver,
): unknown {
  const scopedSnapshots = filterSnapshotsForResolver(snapshots, resolver);
  const storageView = {
    origins: scopedSnapshots.flatMap((snapshot) => snapshot.storage?.origins ?? []),
    sessionStorage: scopedSnapshots.flatMap((snapshot) => snapshot.storage?.sessionStorage ?? []),
    hiddenFields: scopedSnapshots.flatMap((snapshot) => snapshot.hiddenFields ?? []),
    globals: scopedSnapshots
      .map((snapshot) => snapshot.globals)
      .filter((value): value is Record<string, unknown> => value !== undefined),
  };
  if (resolver.valueRef?.pointer !== undefined) {
    return extractReverseRuntimeValue(storageView, resolver.valueRef.pointer);
  }
  const inputName = resolver.inputNames?.[0];
  if (inputName === undefined) {
    return undefined;
  }
  for (const snapshot of [...scopedSnapshots].sort(
    (left, right) => right.capturedAt - left.capturedAt,
  )) {
    for (const origin of snapshot.storage?.origins ?? []) {
      const entry = origin.localStorage.find((item) => item.key === inputName);
      if (entry !== undefined) {
        return entry.value;
      }
    }
    for (const origin of snapshot.storage?.sessionStorage ?? []) {
      const entry = origin.entries.find((item) => item.key === inputName);
      if (entry !== undefined) {
        return entry.value;
      }
    }
  }
  return undefined;
}

function filterSnapshotsForResolver(
  snapshots: readonly OpensteerStateSnapshot[],
  resolver: OpensteerExecutableResolver,
): readonly OpensteerStateSnapshot[] {
  if (resolver.valueRef?.stateSnapshotId === undefined) {
    return snapshots;
  }
  return snapshots.filter((snapshot) => snapshot.id === resolver.valueRef?.stateSnapshotId);
}

function extractReverseResolverArtifactId(
  resolver: OpensteerExecutableResolver,
): string | undefined {
  return resolver.valueRef?.kind === "artifact" ? resolver.valueRef.artifactId : undefined;
}

function extractReverseResolverRecordId(resolver: OpensteerExecutableResolver): string | undefined {
  return resolver.valueRef?.kind === "record" ? resolver.valueRef.recordId : undefined;
}

function extractReverseRecordId(value: unknown): string | undefined {
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { readonly recordId?: unknown }).recordId === "string"
  ) {
    return (value as { readonly recordId: string }).recordId;
  }
  return undefined;
}

function extractReverseStatus(value: unknown): number | undefined {
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { readonly response?: { readonly status?: unknown } }).response?.status ===
      "number"
  ) {
    return (value as { readonly response: { readonly status: number } }).response.status;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { readonly record?: { readonly status?: unknown } }).record?.status ===
      "number"
  ) {
    return (value as { readonly record: { readonly status: number } }).record.status;
  }
  return undefined;
}

function serializeReverseBindings(
  bindings: ReadonlyMap<string, unknown>,
): Readonly<Record<string, JsonValue>> {
  const entries = [...bindings.entries()].map(([key, value]) => [key, toCanonicalJsonValue(value)]);
  return Object.fromEntries(entries);
}

function evaluateReversePackageAssertion(
  boundValue: unknown,
  channelKind: NonNullable<OpensteerReversePackageRunOutput["channel"]>,
  validators: readonly OpensteerValidationRule[],
  fallbackRecordId?: string,
  fallbackStatus?: number,
  executedStepIds: readonly string[] = [],
  bindings: Readonly<Record<string, JsonValue>> = {},
  failedStepId?: string,
): {
  readonly success: boolean;
  readonly executedStepIds: readonly string[];
  readonly failedStepId?: string;
  readonly bindings?: Readonly<Record<string, JsonValue>>;
  readonly recordId?: string;
  readonly status?: number;
  readonly validation: OpensteerReversePackageRunOutput["validation"];
  readonly error?: string;
} {
  if (isNetworkQueryRecordValue(boundValue)) {
    switch (channelKind) {
      case "http": {
        const evaluation = evaluateValidationRulesForObservedRecord(boundValue, validators);
        return {
          ...evaluation,
          executedStepIds,
          bindings,
          recordId: boundValue.recordId,
          ...(boundValue.record.status === undefined ? {} : { status: boundValue.record.status }),
        };
      }
      case "event-stream": {
        const firstChunkPreview = firstTextPreview(
          decodeProtocolBody(boundValue.record.responseBody),
        );
        const evaluation = evaluateValidationRulesForEventStreamReplay(
          firstChunkPreview === undefined
            ? { status: boundValue.record.status ?? 0 }
            : {
                status: boundValue.record.status ?? 0,
                firstChunkPreview,
              },
          validators,
        );
        return {
          ...evaluation,
          executedStepIds,
          bindings,
          recordId: boundValue.recordId,
          ...(boundValue.record.status === undefined ? {} : { status: boundValue.record.status }),
        };
      }
      case "websocket": {
        const evaluation = evaluateValidationRulesForWebSocketReplay(
          {
            opened: true,
            messageCount: boundValue.record.responseBody === undefined ? 0 : 1,
          },
          validators,
        );
        return {
          ...evaluation,
          executedStepIds,
          bindings,
          recordId: boundValue.recordId,
          ...(boundValue.record.status === undefined ? {} : { status: boundValue.record.status }),
        };
      }
    }
  }

  if (isRawRequestOutputValue(boundValue)) {
    switch (channelKind) {
      case "http": {
        const evaluation = evaluateValidationRulesForHttpResponse(boundValue.response, validators);
        return {
          ...evaluation,
          executedStepIds,
          bindings,
          recordId: boundValue.recordId,
          status: boundValue.response.status,
        };
      }
      case "event-stream": {
        const firstChunkPreview = firstTextPreview(decodeProtocolBody(boundValue.response.body));
        const evaluation = evaluateValidationRulesForEventStreamReplay(
          firstChunkPreview === undefined
            ? { status: boundValue.response.status }
            : {
                status: boundValue.response.status,
                firstChunkPreview,
              },
          validators,
        );
        return {
          ...evaluation,
          executedStepIds,
          bindings,
          recordId: boundValue.recordId,
          status: boundValue.response.status,
        };
      }
      case "websocket":
        return {
          success: false,
          executedStepIds,
          ...(failedStepId === undefined ? {} : { failedStepId }),
          bindings,
          ...(fallbackRecordId === undefined ? {} : { recordId: fallbackRecordId }),
          ...(fallbackStatus === undefined ? {} : { status: fallbackStatus }),
          validation: {},
          error:
            "request.raw cannot validate websocket replay directly; await the observed websocket record instead",
        };
    }
  }

  if (
    channelKind === "websocket" &&
    boundValue !== null &&
    typeof boundValue === "object" &&
    typeof (boundValue as { readonly opened?: unknown }).opened === "boolean"
  ) {
    const evaluation = evaluateValidationRulesForWebSocketReplay(
      {
        opened: (boundValue as { readonly opened: boolean }).opened,
        messageCount:
          typeof (boundValue as { readonly messageCount?: unknown }).messageCount === "number"
            ? (boundValue as { readonly messageCount: number }).messageCount
            : 0,
      },
      validators,
    );
    return {
      ...evaluation,
      executedStepIds,
      bindings,
      ...(fallbackRecordId === undefined ? {} : { recordId: fallbackRecordId }),
      ...(fallbackStatus === undefined ? {} : { status: fallbackStatus }),
    };
  }

  return {
    success: false,
    executedStepIds,
    ...(failedStepId === undefined ? {} : { failedStepId }),
    bindings,
    ...(fallbackRecordId === undefined ? {} : { recordId: fallbackRecordId }),
    ...(fallbackStatus === undefined ? {} : { status: fallbackStatus }),
    validation: {},
    error: "assert step received an unsupported replay result binding",
  };
}

function isNetworkQueryRecordValue(value: unknown): value is NetworkQueryRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { readonly recordId?: unknown }).recordId === "string" &&
    value !== null &&
    typeof (value as { readonly record?: unknown }).record === "object"
  );
}

function isRawRequestOutputValue(value: unknown): value is OpensteerRawRequestOutput {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { readonly recordId?: unknown }).recordId === "string" &&
    value !== null &&
    typeof (value as { readonly request?: unknown }).request === "object" &&
    typeof (value as { readonly response?: unknown }).response === "object"
  );
}

function buildCapturedRecordSuccessFingerprint(record: NetworkQueryRecord): {
  readonly status: number;
  readonly structureHash?: string;
} {
  const structureHash =
    record.record.responseBody === undefined
      ? undefined
      : protocolJsonStructureHash(record.record.responseBody);
  return {
    status: record.record.status ?? 0,
    ...(structureHash === undefined ? {} : { structureHash }),
  };
}

function matchesSuccessFingerprintFromProtocolResponse(
  response: OpensteerRequestResponseResult,
  fingerprint: {
    readonly status: number;
    readonly structureHash?: string;
  },
): boolean {
  if (response.status !== fingerprint.status) {
    return false;
  }
  if (fingerprint.structureHash === undefined) {
    return true;
  }
  return protocolJsonStructureHash(response.body) === fingerprint.structureHash;
}

function protocolJsonStructureHash(
  body:
    | OpensteerRequestResponseResult["body"]
    | NetworkQueryRecord["record"]["responseBody"]
    | undefined,
): string | undefined {
  const text = decodeProtocolBody(body);
  if (text === undefined) {
    return undefined;
  }
  return jsonStructureHash(text);
}

function normalizeInteractionEvents(
  value: unknown,
): OpensteerInteractionCaptureOutput["trace"]["payload"]["events"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (
        entry,
      ): entry is {
        readonly type: string;
        readonly timestamp: number;
        readonly targetPath?: string;
        readonly properties?: Readonly<Record<string, unknown>>;
      } =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { type?: unknown }).type === "string" &&
        typeof (entry as { timestamp?: unknown }).timestamp === "number",
    )
    .map((entry) => ({
      type: entry.type,
      timestamp: entry.timestamp,
      ...(entry.targetPath === undefined ? {} : { targetPath: entry.targetPath }),
      properties: stripUndefinedRecordValues(entry.properties ?? {}),
    }));
}

function stripUndefinedRecordValues(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function buildStateDelta(
  before: OpensteerStateSnapshot,
  after: OpensteerStateSnapshot,
): OpensteerStateDelta {
  const cookieNames = diffNamedEntries(
    before.cookies?.map((cookie) => cookie.name) ?? [],
    after.cookies?.map((cookie) => cookie.name) ?? [],
  );
  const storageNames = diffStorageSnapshot(before.storage, after.storage);
  const hiddenFieldNames = diffNamedEntries(
    before.hiddenFields?.map((field) => field.name) ?? [],
    after.hiddenFields?.map((field) => field.name) ?? [],
  );
  const globalNames = diffNamedEntries(
    Object.keys(before.globals ?? {}),
    Object.keys(after.globals ?? {}),
  );
  return {
    beforeStateId: before.id,
    afterStateId: after.id,
    cookiesChanged: cookieNames,
    storageChanged: storageNames,
    hiddenFieldsChanged: hiddenFieldNames,
    globalsChanged: globalNames,
  };
}

function diffNamedEntries(left: readonly string[], right: readonly string[]): readonly string[] {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return [...new Set([...left, ...right])].filter(
    (value) => !leftSet.has(value) || !rightSet.has(value),
  );
}

function diffStorageSnapshot(
  left: StorageSnapshot | undefined,
  right: StorageSnapshot | undefined,
): readonly string[] {
  const leftKeys = new Set<string>();
  const rightKeys = new Set<string>();
  for (const snapshot of left?.origins ?? []) {
    for (const entry of snapshot.localStorage ?? []) {
      leftKeys.add(`${snapshot.origin}:local:${entry.key}`);
    }
    for (const database of snapshot.indexedDb ?? []) {
      leftKeys.add(`${snapshot.origin}:indexeddb:${database.name}`);
    }
  }
  for (const snapshot of right?.origins ?? []) {
    for (const entry of snapshot.localStorage ?? []) {
      rightKeys.add(`${snapshot.origin}:local:${entry.key}`);
    }
    for (const database of snapshot.indexedDb ?? []) {
      rightKeys.add(`${snapshot.origin}:indexeddb:${database.name}`);
    }
  }
  for (const snapshot of left?.sessionStorage ?? []) {
    for (const entry of snapshot.entries ?? []) {
      leftKeys.add(`${snapshot.origin}:session:${entry.key}`);
    }
  }
  for (const snapshot of right?.sessionStorage ?? []) {
    for (const entry of snapshot.entries ?? []) {
      rightKeys.add(`${snapshot.origin}:session:${entry.key}`);
    }
  }
  return [...new Set([...leftKeys, ...rightKeys])].filter(
    (value) => !leftKeys.has(value) || !rightKeys.has(value),
  );
}

function normalizeRuntimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyBrowserCookiesToTransportRequest(
  request: {
    readonly method: string;
    readonly url: string;
    readonly headers?: readonly HeaderEntry[];
    readonly body?: BrowserBodyPayload;
    readonly followRedirects?: boolean;
  },
  cookies: readonly CookieRecord[],
): {
  readonly method: string;
  readonly url: string;
  readonly headers?: readonly HeaderEntry[];
  readonly body?: BrowserBodyPayload;
  readonly followRedirects?: boolean;
} {
  if (cookies.length === 0) {
    return request;
  }
  const existingCookieMap = new Map<string, string>();
  for (const [name, value] of parseCookiePairs(headerValue(request.headers ?? [], "cookie"))) {
    existingCookieMap.set(name, value);
  }
  for (const cookie of cookies) {
    if (!existingCookieMap.has(cookie.name)) {
      existingCookieMap.set(cookie.name, cookie.value);
    }
  }

  const mergedCookieHeader = [...existingCookieMap.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  const headers = [...(request.headers ?? [])];
  setHeaderValue(headers, "cookie", mergedCookieHeader);
  return {
    ...request,
    headers,
  };
}

function omitTransportRequestHeader(
  request: {
    readonly method: string;
    readonly url: string;
    readonly headers?: readonly HeaderEntry[];
    readonly body?: BrowserBodyPayload;
    readonly followRedirects?: boolean;
  },
  headerName: string,
): {
  readonly method: string;
  readonly url: string;
  readonly headers?: readonly HeaderEntry[];
  readonly body?: BrowserBodyPayload;
  readonly followRedirects?: boolean;
} {
  const headers = (request.headers ?? []).filter(
    (header) => header.name.toLowerCase() !== headerName.toLowerCase(),
  );
  return {
    ...request,
    ...(headers.length === 0 ? {} : { headers }),
  };
}

function cookieHeaderToCookieRecords(
  cookieHeader: string | undefined,
  requestUrl: string,
  sessionRef: SessionRef,
): readonly CookieRecord[] {
  const url = new URL(requestUrl);
  return parseCookiePairs(cookieHeader).map(([name, value]) => ({
    sessionRef,
    name,
    value,
    domain: url.hostname,
    path: defaultCookiePath(url.pathname),
    secure: url.protocol === "https:",
    httpOnly: false,
    session: true,
    expiresAt: null,
  }));
}

function parseCookiePairs(cookieHeader: string | undefined): readonly [string, string][] {
  if (cookieHeader === undefined || cookieHeader.trim().length === 0) {
    return [];
  }
  return cookieHeader
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.includes("="))
    .map((entry) => {
      const separator = entry.indexOf("=");
      return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()] as const;
    });
}

function resolveExplicitCaptchaInput(
  input: OpensteerCaptchaSolveInput,
): CaptchaDetectionResult | undefined {
  if (input.type === undefined && input.siteKey === undefined && input.pageUrl === undefined) {
    return undefined;
  }
  if (input.type === undefined || input.siteKey === undefined || input.pageUrl === undefined) {
    throw new OpensteerProtocolError(
      "invalid-request",
      "explicit CAPTCHA solve input requires type, siteKey, and pageUrl together",
    );
  }
  return {
    type: input.type,
    siteKey: input.siteKey,
    pageUrl: input.pageUrl,
  };
}

function serializeCookieJarHeader(
  entries: readonly CookieJarEntry[],
  requestUrl: string,
): string | undefined {
  const validEntries = entries.filter((entry) => cookieAppliesToUrl(entry, requestUrl));
  if (validEntries.length === 0) {
    return undefined;
  }
  return validEntries.map((entry) => `${entry.name}=${entry.value}`).join("; ");
}

function cookieAppliesToUrl(entry: CookieJarEntry, requestUrl: string): boolean {
  if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
    return false;
  }

  const url = new URL(requestUrl);
  if (entry.secure && url.protocol !== "https:") {
    return false;
  }
  if (!cookieDomainMatches(entry.domain, url.hostname)) {
    return false;
  }
  return url.pathname.startsWith(entry.path);
}

function cookieDomainMatches(domain: string, hostname: string): boolean {
  const normalizedDomain = domain.startsWith(".") ? domain.slice(1) : domain;
  return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
}

function parseSetCookieHeader(value: string, requestUrl: string): readonly CookieJarEntry[] {
  const [nameValue, ...attributeParts] = value.split(";");
  const [rawName, ...rawValueParts] = (nameValue ?? "").split("=");
  const name = rawName?.trim();
  if (!name) {
    return [];
  }

  const url = new URL(requestUrl);
  let domain = url.hostname;
  let path = defaultCookiePath(url.pathname);
  let secure = url.protocol === "https:";
  let expiresAt: number | undefined;
  const cookieValue = rawValueParts.join("=").trim();

  for (const attribute of attributeParts) {
    const [rawKey, ...rawAttributeValueParts] = attribute.split("=");
    const key = rawKey?.trim().toLowerCase();
    const attributeValue = rawAttributeValueParts.join("=").trim();
    if (key === "domain" && attributeValue.length > 0) {
      domain = attributeValue.startsWith(".") ? attributeValue : `.${attributeValue}`;
      continue;
    }
    if (key === "path" && attributeValue.length > 0) {
      path = attributeValue;
      continue;
    }
    if (key === "secure") {
      secure = true;
      continue;
    }
    if (key === "expires") {
      const timestamp = Date.parse(attributeValue);
      if (Number.isFinite(timestamp)) {
        expiresAt = timestamp;
      }
      continue;
    }
    if (key === "max-age") {
      const maxAge = Number.parseInt(attributeValue, 10);
      if (Number.isFinite(maxAge)) {
        expiresAt = Date.now() + maxAge * 1000;
      }
    }
  }

  return [
    {
      name,
      value: cookieValue,
      domain,
      path,
      secure,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    },
  ];
}

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname === "/") {
    return "/";
  }
  const index = pathname.lastIndexOf("/");
  return index <= 0 ? "/" : pathname.slice(0, index);
}

function mergeCookieJarEntries(
  current: readonly CookieJarEntry[],
  updates: readonly CookieJarEntry[],
): CookieJarEntry[] {
  const merged = new Map<string, CookieJarEntry>();
  for (const entry of current) {
    merged.set(cookieJarKey(entry), entry);
  }
  for (const entry of updates) {
    merged.set(cookieJarKey(entry), entry);
  }
  return [...merged.values()].filter(
    (entry) => entry.expiresAt === undefined || entry.expiresAt > Date.now(),
  );
}

function cookieJarKey(entry: CookieJarEntry): string {
  return `${entry.domain}\u0000${entry.path}\u0000${entry.name}`;
}

const RESTORE_PAGE_STORAGE_SCRIPT = `(input => {
  if (Array.isArray(input.localStorageEntries)) {
    window.localStorage.clear();
    for (const entry of input.localStorageEntries) {
      if (!entry || typeof entry.key !== "string") {
        continue;
      }
      window.localStorage.setItem(entry.key, typeof entry.value === "string" ? entry.value : "");
    }
  }

  if (Array.isArray(input.sessionStorageEntries)) {
    window.sessionStorage.clear();
    for (const entry of input.sessionStorageEntries) {
      if (!entry || typeof entry.key !== "string") {
        continue;
      }
      window.sessionStorage.setItem(entry.key, typeof entry.value === "string" ? entry.value : "");
    }
  }

  return {
    localStorageSize: window.localStorage.length,
    sessionStorageSize: window.sessionStorage.length,
  };
})`;

const CAPTURE_PAGE_STATE_SCRIPT = `(input => {
  const cssPath = element => {
    if (!(element instanceof Element)) {
      return undefined;
    }
    const segments = [];
    let current = element;
    while (current instanceof Element && segments.length < 8) {
      let segment = current.localName;
      if (current.id) {
        segment += "#" + CSS.escape(current.id);
        segments.unshift(segment);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(node => node.localName === current.localName);
        const index = siblings.indexOf(current);
        segment += ":nth-of-type(" + String(index + 1) + ")";
      }
      segments.unshift(segment);
      current = parent;
    }
    return segments.join(" > ");
  };

  const hiddenFields = Array.from(document.querySelectorAll('input[type="hidden"], input[hidden]'))
    .map(element => ({
      path: cssPath(element) || "input",
      name: element.getAttribute("name") || "",
      value: element.getAttribute("value") || "",
    }))
    .filter(entry => entry.name.length > 0);

  const globals = {};
  for (const name of input.globalNames ?? []) {
    try {
      const value = window[name];
      globals[name] =
        value === null || ["string", "number", "boolean"].includes(typeof value)
          ? value
          : Array.isArray(value)
            ? value
            : typeof value === "object"
              ? JSON.parse(JSON.stringify(value))
              : String(value);
    } catch (error) {
      globals[name] = "[unavailable:" + String(error) + "]";
    }
  }

  return { hiddenFields, globals };
})`;

const PAGE_EVAL_RESOLVER_SCRIPT = `(input => {
  const expression = typeof input?.expression === "string" ? input.expression.trim() : "";
  if (expression.length === 0) {
    return undefined;
  }
  return Function(\`return (\${expression});\`)();
})`;

const INTERACTION_RECORDER_INSTALL_SCRIPT = `(() => {
  const storeKey = "__opensteerInteractionRecorder";
  const existing = window[storeKey];
  if (existing && typeof existing.dispose === "function") {
    existing.dispose();
  }

  const cssPath = element => {
    if (!(element instanceof Element)) {
      return undefined;
    }
    const segments = [];
    let current = element;
    while (current instanceof Element && segments.length < 8) {
      let segment = current.localName;
      if (current.id) {
        segment += "#" + CSS.escape(current.id);
        segments.unshift(segment);
        break;
      }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(node => node.localName === current.localName);
        const index = siblings.indexOf(current);
        segment += ":nth-of-type(" + String(index + 1) + ")";
      }
      segments.unshift(segment);
      current = parent;
    }
    return segments.join(" > ");
  };

  const eventTypes = [
    "pointerdown",
    "pointerup",
    "pointermove",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "keydown",
    "keyup",
    "input",
    "change",
    "wheel",
    "dragstart",
    "dragover",
    "drop",
    "dragend",
  ];
  const events = [];
  const listener = event => {
    const target = event.target instanceof Element ? event.target : undefined;
    const properties = {
      isTrusted: event.isTrusted,
      button: "button" in event ? event.button : undefined,
      buttons: "buttons" in event ? event.buttons : undefined,
      clientX: "clientX" in event ? event.clientX : undefined,
      clientY: "clientY" in event ? event.clientY : undefined,
      pressure: "pressure" in event ? event.pressure : undefined,
      pointerType: "pointerType" in event ? event.pointerType : undefined,
      key: "key" in event ? event.key : undefined,
      code: "code" in event ? event.code : undefined,
      deltaX: "deltaX" in event ? event.deltaX : undefined,
      deltaY: "deltaY" in event ? event.deltaY : undefined,
      value:
        target && "value" in target && typeof target.value === "string"
          ? target.value
          : undefined,
    };
    events.push({
      type: event.type,
      timestamp: Date.now(),
      targetPath: target ? cssPath(target) : undefined,
      properties,
    });
  };

  for (const type of eventTypes) {
    window.addEventListener(type, listener, true);
  }

  window[storeKey] = {
    read() {
      return events.slice();
    },
    dispose() {
      for (const type of eventTypes) {
        window.removeEventListener(type, listener, true);
      }
    },
  };

  return { installed: true };
})()`;

const INTERACTION_RECORDER_READ_SCRIPT = `(() => {
  const store = window.__opensteerInteractionRecorder;
  const events = store && typeof store.read === "function" ? store.read() : [];
  if (store && typeof store.dispose === "function") {
    store.dispose();
  }
  delete window.__opensteerInteractionRecorder;
  return events;
})()`;

const INTERACTION_REPLAY_SCRIPT = `(async events => {
  const resolveTarget = event => {
    if (typeof event.targetPath === "string" && event.targetPath.length > 0) {
      const direct = document.querySelector(event.targetPath);
      if (direct) {
        return direct;
      }
    }
    if (typeof event.properties?.clientX === "number" && typeof event.properties?.clientY === "number") {
      const hit = document.elementFromPoint(event.properties.clientX, event.properties.clientY);
      if (hit) {
        return hit;
      }
    }
    return document.body;
  };

  for (const event of events ?? []) {
    const target = resolveTarget(event);
    const properties = event.properties ?? {};
    if ((event.type === "input" || event.type === "change") && "value" in target && typeof properties.value === "string") {
      target.value = properties.value;
    }
    let dispatched;
    if (event.type.startsWith("pointer")) {
      dispatched = new PointerEvent(event.type, properties);
    } else if (event.type.startsWith("mouse") || event.type === "click" || event.type === "dblclick") {
      dispatched = new MouseEvent(event.type, properties);
    } else if (event.type.startsWith("key")) {
      dispatched = new KeyboardEvent(event.type, properties);
    } else if (event.type === "wheel") {
      dispatched = new WheelEvent(event.type, properties);
    } else if (event.type === "input") {
      dispatched = new InputEvent(event.type, properties);
    } else {
      dispatched = new Event(event.type, properties);
    }
    target.dispatchEvent(dispatched);
  }
  return { replayedEventCount: Array.isArray(events) ? events.length : 0 };
})`;

const PAGE_HTTP_REQUEST_SCRIPT = `(async (input) => {
  const decodeBase64 = (value) => {
    if (typeof value !== "string" || value.length === 0) {
      return undefined;
    }
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  };

  const encodeBase64 = (bytes) => {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  };

  const headers = new Headers();
  for (const header of input.headers ?? []) {
    headers.set(header.name, header.value);
  }

  const response = await fetch(input.url, {
    method: input.method,
    headers,
    ...(input.bodyBase64 === undefined ? {} : { body: decodeBase64(input.bodyBase64) }),
    redirect: input.followRedirects === false ? "manual" : "follow",
  });

  const bodyBuffer = new Uint8Array(await response.arrayBuffer());
  return {
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()).map(([name, value]) => ({ name, value })),
    bodyBase64: bodyBuffer.byteLength === 0 ? undefined : encodeBase64(bodyBuffer),
    redirected: response.redirected,
  };
})`;

const PAGE_HTTP_EVENT_STREAM_SCRIPT = `(async (input) => {
  const decodeBase64 = (value) => {
    if (typeof value !== "string" || value.length === 0) {
      return undefined;
    }
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  };

  const headers = new Headers();
  for (const header of input.headers ?? []) {
    headers.set(header.name, header.value);
  }

  const response = await fetch(input.url, {
    method: input.method,
    headers,
    ...(input.bodyBase64 === undefined ? {} : { body: decodeBase64(input.bodyBase64) }),
    redirect: input.followRedirects === false ? "manual" : "follow",
  });

  let firstChunkPreview;
  if (response.body) {
    const reader = response.body.getReader();
    const readPromise = reader.read();
    const timerPromise = new Promise(resolve => setTimeout(() => resolve(null), input.readTimeoutMs ?? 1500));
    const readResult = await Promise.race([readPromise, timerPromise]);
    if (readResult && !readResult.done && readResult.value) {
      firstChunkPreview = new TextDecoder().decode(readResult.value).slice(0, 256);
    }
    try {
      await reader.cancel();
    } catch {}
  }

  return {
    status: response.status,
    firstChunkPreview,
  };
})`;

const PAGE_HTTP_WEBSOCKET_SCRIPT = `(async (input) => {
  return await new Promise(resolve => {
    let settled = false;
    let messageCount = 0;
    let opened = false;
    const finish = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      resolve(payload);
    };
    const socket = Array.isArray(input.protocols) && input.protocols.length > 0
      ? new WebSocket(input.url, input.protocols)
      : new WebSocket(input.url);
    const timer = setTimeout(() => {
      finish({ opened, messageCount, ...(opened ? {} : { error: "timed out before websocket opened" }) });
    }, input.waitMs ?? 1500);

    socket.addEventListener("open", () => {
      opened = true;
      if ((input.waitMs ?? 1500) <= 0) {
        finish({ opened, messageCount });
      }
    });
    socket.addEventListener("message", () => {
      messageCount += 1;
      finish({ opened: true, messageCount });
    });
    socket.addEventListener("error", () => {
      finish({ opened, messageCount, error: "websocket error" });
    });
    socket.addEventListener("close", () => {
      finish({ opened, messageCount, ...(opened ? {} : { error: "websocket closed before open" }) });
    });
  });
})`;

function toPageHttpTransportResponse(value: unknown): {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly HeaderEntry[];
  readonly body?: BrowserBodyPayload;
  readonly redirected: boolean;
} {
  if (value === null || typeof value !== "object") {
    throw new OpensteerProtocolError(
      "operation-failed",
      "page-http returned an invalid response payload",
    );
  }

  const response = value as {
    readonly url?: unknown;
    readonly status?: unknown;
    readonly statusText?: unknown;
    readonly headers?: readonly { readonly name?: unknown; readonly value?: unknown }[];
    readonly bodyBase64?: unknown;
    readonly redirected?: unknown;
  };
  const headers = (response.headers ?? [])
    .filter(
      (header): header is { readonly name: string; readonly value: string } =>
        typeof header?.name === "string" && typeof header?.value === "string",
    )
    .map((header) => ({ name: header.name, value: header.value }));
  const contentType = headers.find((header) => header.name.toLowerCase() === "content-type")?.value;
  const body =
    typeof response.bodyBase64 === "string"
      ? createBodyPayload(
          new Uint8Array(Buffer.from(response.bodyBase64, "base64")),
          parseContentType(contentType),
        )
      : undefined;

  return {
    url: typeof response.url === "string" ? response.url : "",
    status: typeof response.status === "number" ? response.status : 0,
    statusText: typeof response.statusText === "string" ? response.statusText : "",
    headers,
    ...(body === undefined ? {} : { body }),
    redirected: response.redirected === true,
  };
}

function toPageHttpEventStreamResponse(value: unknown): {
  readonly status: number;
  readonly firstChunkPreview?: string;
} {
  if (value === null || typeof value !== "object") {
    throw new OpensteerProtocolError(
      "operation-failed",
      "page-http event-stream replay returned an invalid payload",
    );
  }
  const response = value as {
    readonly status?: unknown;
    readonly firstChunkPreview?: unknown;
  };
  return {
    status: typeof response.status === "number" ? response.status : 0,
    ...(typeof response.firstChunkPreview === "string"
      ? { firstChunkPreview: response.firstChunkPreview }
      : {}),
  };
}

function toPageHttpWebSocketResponse(value: unknown): {
  readonly opened: boolean;
  readonly messageCount: number;
  readonly error?: string;
} {
  if (value === null || typeof value !== "object") {
    throw new OpensteerProtocolError(
      "operation-failed",
      "page-http websocket replay returned an invalid payload",
    );
  }
  const response = value as {
    readonly opened?: unknown;
    readonly messageCount?: unknown;
    readonly error?: unknown;
  };
  return {
    opened: response.opened === true,
    messageCount: typeof response.messageCount === "number" ? response.messageCount : 0,
    ...(typeof response.error === "string" ? { error: response.error } : {}),
  };
}

function buildTransportRequestFromPlan(
  plan: RequestPlanRecord,
  input: OpensteerRequestExecuteInput,
): {
  readonly method: string;
  readonly url: string;
  readonly headers?: readonly HeaderEntry[];
  readonly body?: BrowserBodyPayload;
} {
  const payload = plan.payload;
  const parameters = payload.parameters ?? [];
  const pathParameters = parameters.filter((parameter) => parameter.in === "path");
  const queryParameters = parameters.filter((parameter) => parameter.in === "query");
  const headerParameters = parameters.filter((parameter) => parameter.in === "header");

  const resolvedPath = resolvePlanParameterValues(plan, pathParameters, input.params, "params");
  const resolvedQuery = resolvePlanParameterValues(plan, queryParameters, input.query);
  const resolvedHeaders = resolvePlanParameterValues(plan, headerParameters, input.headers);
  const extraQuery = resolveUnmappedExecutionValues(queryParameters, input.query);
  const extraHeaders = resolveUnmappedExecutionValues(headerParameters, input.headers);

  let url = payload.endpoint.urlTemplate;
  for (const [name, value] of resolvedPath.entries()) {
    url = url.replaceAll(`{${name}}`, encodeURIComponent(value));
  }

  const targetUrl = new URL(url);
  for (const entry of payload.endpoint.defaultQuery ?? []) {
    targetUrl.searchParams.set(entry.name, entry.value);
  }
  for (const parameter of queryParameters) {
    const value = resolvedQuery.get(parameter.name);
    if (value !== undefined) {
      targetUrl.searchParams.set(parameter.wireName ?? parameter.name, value);
    }
  }
  for (const [name, value] of extraQuery.entries()) {
    targetUrl.searchParams.set(name, value);
  }

  const headers = [...(payload.endpoint.defaultHeaders ?? [])];
  for (const parameter of headerParameters) {
    const value = resolvedHeaders.get(parameter.name);
    if (value !== undefined) {
      setHeaderValue(headers, parameter.wireName ?? parameter.name, value);
    }
  }
  for (const [name, value] of extraHeaders.entries()) {
    setHeaderValue(headers, name, value);
  }

  const planBodyInput = buildPlanBodyInput(payload.body, input.body, input.bodyVars);
  const body = planBodyInput === undefined ? undefined : toBrowserRequestBody(planBodyInput);
  if (
    body?.contentType !== undefined &&
    !headers.some((header) => header.name.toLowerCase() === "content-type")
  ) {
    headers.push({
      name: "content-type",
      value: body.contentType,
    });
  }

  return {
    method: payload.endpoint.method,
    url: targetUrl.toString(),
    ...(headers.length === 0 ? {} : { headers }),
    ...(body === undefined ? {} : { body: body.payload }),
  };
}

function buildPlanBodyInput(
  planBody: RequestPlanRecord["payload"]["body"],
  overrideBody: OpensteerRequestExecuteInput["body"],
  bodyVariables: OpensteerRequestExecuteInput["bodyVars"],
): OpensteerRawRequestInput["body"] | undefined {
  if (overrideBody !== undefined) {
    return overrideBody;
  }
  if (planBody === undefined || planBody.kind === undefined) {
    return undefined;
  }

  const variables = new Map(
    Object.entries(bodyVariables ?? {}).map(([name, value]) => [name, String(value)]),
  );
  switch (planBody.kind) {
    case "json":
      return {
        json: toCanonicalJsonValue(interpolateJsonValue(planBody.template ?? null, variables)),
        ...(planBody.contentType === undefined ? {} : { contentType: planBody.contentType }),
      };
    case "text":
      return {
        text: interpolateTemplate(String(planBody.template ?? ""), variables),
        ...(planBody.contentType === undefined ? {} : { contentType: planBody.contentType }),
      };
    case "form": {
      const fields = Object.fromEntries(
        (planBody.fields ?? []).map((entry) => [
          entry.name,
          interpolateTemplate(entry.value, variables),
        ]),
      );
      return {
        text: new URLSearchParams(fields).toString(),
        contentType: planBody.contentType ?? "application/x-www-form-urlencoded; charset=utf-8",
      };
    }
  }
}

function resolvePlanParameterValues(
  plan: RequestPlanRecord,
  parameters: readonly {
    readonly name: string;
    readonly in: "path" | "query" | "header";
    readonly wireName?: string;
    readonly required?: boolean;
    readonly defaultValue?: string;
  }[],
  values: Readonly<Record<string, string | number | boolean>> | undefined,
  fieldName?: "params",
): ReadonlyMap<string, string> {
  const normalizedValues = new Map(
    Object.entries(values ?? {}).map(([name, value]) => [name, String(value)]),
  );
  if (fieldName === "params") {
    const knownParameters = new Set(parameters.map((parameter) => parameter.name));
    for (const name of normalizedValues.keys()) {
      if (!knownParameters.has(name)) {
        throw new OpensteerProtocolError(
          "invalid-request",
          `unknown ${fieldName} input "${name}" for request plan ${plan.key}@${plan.version}`,
          {
            details: {
              key: plan.key,
              version: plan.version,
              field: fieldName,
              name,
            },
          },
        );
      }
    }
  }

  const resolved = new Map<string, string>();
  for (const parameter of parameters) {
    const value = normalizedValues.get(parameter.name) ?? parameter.defaultValue;
    if (value === undefined) {
      if (parameter.required ?? parameter.in === "path") {
        throw new OpensteerProtocolError(
          "invalid-request",
          `missing required ${parameter.in} parameter "${parameter.name}" for request plan ${plan.key}@${plan.version}`,
          {
            details: {
              key: plan.key,
              version: plan.version,
              field: fieldName,
              parameter: parameter.name,
              location: parameter.in,
            },
          },
        );
      }
      continue;
    }

    resolved.set(parameter.name, value);
  }
  return resolved;
}

function resolveUnmappedExecutionValues(
  parameters: readonly {
    readonly name: string;
  }[],
  values: Readonly<Record<string, string | number | boolean>> | undefined,
): ReadonlyMap<string, string> {
  const knownParameters = new Set(parameters.map((parameter) => parameter.name));
  return new Map(
    Object.entries(values ?? {})
      .filter(([name]) => !knownParameters.has(name))
      .map(([name, value]) => [name, String(value)]),
  );
}

function setHeaderValue(
  headers: { name: string; value: string }[],
  name: string,
  value: string,
): void {
  const normalized = name.toLowerCase();
  const existing = headers.find((header) => header.name.toLowerCase() === normalized);
  if (existing) {
    existing.value = value;
    return;
  }
  headers.push({ name, value });
}

function buildPlanExecuteOutput(
  plan: RequestPlanRecord,
  request: {
    readonly method: string;
    readonly url: string;
    readonly headers?: readonly HeaderEntry[];
    readonly body?: BrowserBodyPayload;
  },
  response: {
    readonly url: string;
    readonly status: number;
    readonly statusText: string;
    readonly headers: readonly HeaderEntry[];
    readonly body?: BrowserBodyPayload;
    readonly redirected: boolean;
  },
): OpensteerRequestExecuteOutput {
  const data = parseStructuredResponseData(response);
  return {
    plan: {
      id: plan.id,
      key: plan.key,
      version: plan.version,
    },
    request: toProtocolRequestTransportResult(request),
    response: toProtocolRequestResponseResult(response),
    ...(data === undefined ? {} : { data }),
  };
}

function assertResponseMatchesPlan(
  plan: RequestPlanRecord,
  response: {
    readonly status: number;
    readonly headers: readonly HeaderEntry[];
  },
): void {
  const expectation = plan.payload.response;
  if (expectation === undefined) {
    return;
  }

  const expectedStatuses = Array.isArray(expectation.status)
    ? expectation.status
    : [expectation.status];
  if (!expectedStatuses.includes(response.status)) {
    throw new OpensteerProtocolError(
      "conflict",
      `request plan ${plan.key}@${plan.version} expected status ${expectedStatuses.join(", ")} but received ${String(response.status)}`,
      {
        details: {
          key: plan.key,
          version: plan.version,
          expectedStatus: expectedStatuses,
          actualStatus: response.status,
        },
      },
    );
  }

  if (expectation.contentType !== undefined) {
    const actualContentType = response.headers.find(
      (header) => header.name.toLowerCase() === "content-type",
    )?.value;
    if (
      actualContentType === undefined ||
      !actualContentType.toLowerCase().includes(expectation.contentType.toLowerCase())
    ) {
      throw new OpensteerProtocolError(
        "conflict",
        `request plan ${plan.key}@${plan.version} expected content-type ${expectation.contentType} but received ${actualContentType ?? "none"}`,
        {
          details: {
            key: plan.key,
            version: plan.version,
            expectedContentType: expectation.contentType,
            actualContentType: actualContentType ?? null,
          },
        },
      );
    }
  }
}

function touchFreshness(freshness: RequestPlanRecord["freshness"]): RequestPlanRecord["freshness"] {
  return {
    ...(freshness ?? {}),
    lastValidatedAt: Date.now(),
  };
}

async function executeDirectTransportRequest(
  request: {
    readonly method: string;
    readonly url: string;
    readonly headers?: readonly HeaderEntry[];
    readonly body?: BrowserBodyPayload;
    readonly followRedirects?: boolean;
  },
  signal: AbortSignal,
): Promise<{
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly HeaderEntry[];
  readonly body?: BrowserBodyPayload;
  readonly redirected: boolean;
}> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: Object.fromEntries(
      filterValidHttpHeaders(request.headers ?? []).map((header) => [header.name, header.value]),
    ),
    ...(request.body === undefined ? {} : { body: Buffer.from(request.body.bytes) }),
    redirect: request.followRedirects === false ? "manual" : "follow",
    signal,
  });

  const headers = [...response.headers.entries()].map(([name, value]) => ({ name, value }));
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = headers.find((header) => header.name.toLowerCase() === "content-type")?.value;
  return {
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    headers,
    ...(buffer.byteLength === 0
      ? {}
      : { body: createBodyPayload(new Uint8Array(buffer), parseContentType(contentType)) }),
    redirected: response.redirected,
  };
}

async function executeDirectEventStreamRequest(
  request: {
    readonly method: string;
    readonly url: string;
    readonly headers?: readonly HeaderEntry[];
    readonly body?: BrowserBodyPayload;
    readonly followRedirects?: boolean;
  },
  signal: AbortSignal,
  readTimeoutMs: number,
): Promise<{
  readonly status: number;
  readonly firstChunkPreview?: string;
}> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: Object.fromEntries(
      filterValidHttpHeaders(request.headers ?? []).map((header) => [header.name, header.value]),
    ),
    ...(request.body === undefined ? {} : { body: Buffer.from(request.body.bytes) }),
    redirect: request.followRedirects === false ? "manual" : "follow",
    signal,
  });

  const firstChunkPreview = await readFirstResponseChunk(response.body, signal, readTimeoutMs);
  return {
    status: response.status,
    ...(firstChunkPreview === undefined ? {} : { firstChunkPreview }),
  };
}

async function readFirstResponseChunk(
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal,
  readTimeoutMs: number,
): Promise<string | undefined> {
  if (body === null) {
    return undefined;
  }
  const reader = body.getReader();
  try {
    const timeoutPromise = new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), readTimeoutMs);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve(null);
        },
        { once: true },
      );
    });
    const readResult = await Promise.race([reader.read(), timeoutPromise]);
    if (readResult === null || readResult.done || readResult.value === undefined) {
      return undefined;
    }
    return firstTextPreview(new TextDecoder().decode(readResult.value));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function computeStreamReadTimeoutMs(timeout: TimeoutExecutionContext): number {
  return Math.max(250, Math.min(timeout.remainingMs() ?? 1_500, 1_500));
}

function firstTextPreview(value: string | undefined, limit = 256): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.slice(0, limit);
}

function parseWebSocketProtocols(headers: readonly HeaderEntry[] | undefined): readonly string[] {
  const protocols = headerValue(headers ?? [], "sec-websocket-protocol");
  if (protocols === undefined) {
    return [];
  }
  return protocols
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function matchesFailurePolicy(
  policy: OpensteerRequestFailurePolicy,
  response: OpensteerRequestExecuteOutput["response"],
): boolean {
  if (policy.statusCodes?.includes(response.status)) {
    return true;
  }

  if (policy.finalUrlIncludes?.some((value) => response.url.includes(value))) {
    return true;
  }

  if (
    policy.responseHeaders?.some((match) =>
      response.headers.some(
        (header) =>
          header.name.toLowerCase() === match.name.toLowerCase() &&
          header.value.includes(match.valueIncludes),
      ),
    )
  ) {
    return true;
  }

  const responseText = decodeProtocolBody(response.body);
  if (
    responseText !== undefined &&
    policy.responseBodyIncludes?.some((value) => responseText.includes(value))
  ) {
    return true;
  }

  return false;
}

function applyTransportRequestOverrides(
  request: {
    readonly method: string;
    readonly url: string;
    readonly headers?: readonly HeaderEntry[];
    readonly body?: BrowserBodyPayload;
    readonly followRedirects?: boolean;
  },
  overrides: OpensteerAuthRecipeRetryOverrides | undefined,
): {
  readonly method: string;
  readonly url: string;
  readonly headers?: readonly HeaderEntry[];
  readonly body?: BrowserBodyPayload;
  readonly followRedirects?: boolean;
} {
  if (overrides === undefined) {
    return request;
  }

  const url = new URL(request.url);
  for (const [name, value] of Object.entries(overrides.query ?? {})) {
    url.searchParams.set(name, value);
  }
  const headers = [...(request.headers ?? [])];
  for (const [name, value] of Object.entries(overrides.headers ?? {})) {
    setHeaderValue(headers, name, value);
  }
  return {
    ...request,
    url: url.toString(),
    ...(headers.length === 0 ? {} : { headers }),
  };
}

function interpolateTemplate(value: string, variables: ReadonlyMap<string, string>): string {
  return value.replace(
    /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g,
    (_match, name: string) => variables.get(name) ?? "",
  );
}

function interpolateRecord(
  value: Readonly<Record<string, string>> | undefined,
  variables: ReadonlyMap<string, string>,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, interpolateTemplate(entry, variables)]),
  );
}

function buildRecipeRequest(
  request: {
    readonly url: string;
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly query?: Readonly<Record<string, string>>;
    readonly body?: OpensteerRawRequestInput["body"];
    readonly followRedirects?: boolean;
  },
  variables: ReadonlyMap<string, string>,
): {
  readonly method: string;
  readonly url: string;
  readonly headers?: readonly HeaderEntry[];
  readonly body?: BrowserBodyPayload;
  readonly followRedirects?: boolean;
} {
  const url = new URL(interpolateTemplate(request.url, variables));
  for (const [name, value] of Object.entries(interpolateRecord(request.query, variables) ?? {})) {
    url.searchParams.set(name, value);
  }

  const headers = Object.entries(interpolateRecord(request.headers, variables) ?? {}).map(
    ([name, value]) => ({ name, value }),
  );
  const body =
    request.body === undefined
      ? undefined
      : toBrowserRequestBody(interpolateRequestBody(request.body, variables));
  if (
    body?.contentType !== undefined &&
    !headers.some((header) => header.name.toLowerCase() === "content-type")
  ) {
    headers.push({
      name: "content-type",
      value: body.contentType,
    });
  }

  return {
    method: request.method === undefined ? "GET" : interpolateTemplate(request.method, variables),
    url: url.toString(),
    ...(headers.length === 0 ? {} : { headers }),
    ...(body === undefined ? {} : { body: body.payload }),
    ...(request.followRedirects === undefined ? {} : { followRedirects: request.followRedirects }),
  };
}

function interpolateRequestBody(
  body: OpensteerRawRequestInput["body"],
  variables: ReadonlyMap<string, string>,
): OpensteerRawRequestInput["body"] {
  if (body === undefined) {
    return undefined;
  }
  if ("json" in body) {
    return {
      json: toCanonicalJsonValue(interpolateJsonValue(body.json, variables)),
      ...(body.contentType === undefined
        ? {}
        : { contentType: interpolateTemplate(body.contentType, variables) }),
    };
  }
  if ("text" in body) {
    return {
      text: interpolateTemplate(body.text, variables),
      ...(body.contentType === undefined
        ? {}
        : { contentType: interpolateTemplate(body.contentType, variables) }),
    };
  }
  return {
    base64: interpolateTemplate(body.base64, variables),
    ...(body.contentType === undefined
      ? {}
      : { contentType: interpolateTemplate(body.contentType, variables) }),
  };
}

function interpolateJsonValue(value: unknown, variables: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    return interpolateTemplate(value, variables);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => interpolateJsonValue(entry, variables));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        interpolateJsonValue(entry, variables),
      ]),
    );
  }
  return value;
}

function captureRecipeResponse(
  step:
    | Extract<OpensteerAuthRecipeStep, { readonly kind: "request" }>
    | Extract<OpensteerAuthRecipeStep, { readonly kind: "sessionRequest" }>
    | Extract<OpensteerAuthRecipeStep, { readonly kind: "directRequest" }>,
  response: OpensteerRequestResponseResult,
  data: unknown,
): {
  readonly variables?: Readonly<Record<string, string>>;
} {
  if (step.capture === undefined) {
    return {};
  }

  const variables: Record<string, string> = {};
  if (step.capture.header !== undefined) {
    const value = response.headers.find(
      (header) => header.name.toLowerCase() === step.capture!.header!.name.toLowerCase(),
    )?.value;
    if (value !== undefined) {
      variables[step.capture.header.saveAs] = value;
    }
  }
  if (step.capture.bodyText !== undefined) {
    const text = decodeProtocolBody(response.body);
    if (text !== undefined) {
      variables[step.capture.bodyText.saveAs] = text;
    }
  }
  if (step.capture.bodyJsonPointer !== undefined && data !== undefined) {
    const value = readJsonPointer(data, step.capture.bodyJsonPointer.pointer);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      variables[step.capture.bodyJsonPointer.saveAs] = String(value);
    }
  }
  return Object.keys(variables).length === 0 ? {} : { variables };
}

function decodeProtocolBody(body: OpensteerRequestResponseResult["body"]): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  return Buffer.from(body.data, "base64").toString("utf8");
}

function readJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") {
    return value;
  }
  const parts = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let current = value;
  for (const part of parts) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function renderOverrides(
  overrides: OpensteerAuthRecipeRetryOverrides | undefined,
  variables: ReadonlyMap<string, string>,
): OpensteerAuthRecipeRetryOverrides | undefined {
  if (overrides === undefined) {
    return undefined;
  }
  const params =
    overrides.params === undefined ? undefined : interpolateRecord(overrides.params, variables);
  const headers =
    overrides.headers === undefined ? undefined : interpolateRecord(overrides.headers, variables);
  const query =
    overrides.query === undefined ? undefined : interpolateRecord(overrides.query, variables);
  const body =
    overrides.body === undefined ? undefined : interpolateRecord(overrides.body, variables);
  return {
    ...(params === undefined ? {} : { params }),
    ...(headers === undefined ? {} : { headers }),
    ...(query === undefined ? {} : { query }),
    ...(body === undefined ? {} : { body }),
  };
}

function mergeVariables(
  target: Map<string, string>,
  source: Readonly<Record<string, string>> | undefined,
): void {
  if (source === undefined) {
    return;
  }
  for (const [key, value] of Object.entries(source)) {
    target.set(key, value);
  }
}

function mergeAuthRecipeOverrides(
  base: OpensteerAuthRecipeRetryOverrides | undefined,
  next: OpensteerAuthRecipeRetryOverrides | undefined,
): OpensteerAuthRecipeRetryOverrides | undefined {
  if (base === undefined) {
    return next;
  }
  if (next === undefined) {
    return base;
  }
  return {
    ...(base.params === undefined && next.params === undefined
      ? {}
      : { params: { ...(base.params ?? {}), ...(next.params ?? {}) } }),
    ...(base.headers === undefined && next.headers === undefined
      ? {}
      : { headers: { ...(base.headers ?? {}), ...(next.headers ?? {}) } }),
    ...(base.query === undefined && next.query === undefined
      ? {}
      : { query: { ...(base.query ?? {}), ...(next.query ?? {}) } }),
    ...(base.body === undefined && next.body === undefined
      ? {}
      : { body: { ...(base.body ?? {}), ...(next.body ?? {}) } }),
  };
}

function mergeExecutionInputOverrides(
  input: OpensteerRequestExecuteInput,
  overrides: OpensteerAuthRecipeRetryOverrides | undefined,
): OpensteerRequestExecuteInput {
  if (overrides === undefined) {
    return input;
  }

  return {
    ...input,
    ...(overrides.params === undefined
      ? {}
      : { params: { ...(input.params ?? {}), ...overrides.params } }),
    ...(overrides.query === undefined
      ? {}
      : { query: { ...(input.query ?? {}), ...overrides.query } }),
    ...(overrides.headers === undefined
      ? {}
      : { headers: { ...(input.headers ?? {}), ...overrides.headers } }),
    ...(overrides.body === undefined
      ? {}
      : { bodyVars: { ...(input.bodyVars ?? {}), ...overrides.body } }),
  };
}

function resolveRecoverRecipeBinding(plan: RequestPlanRecord):
  | (ResolvedRecipeBinding & {
      readonly failurePolicy: OpensteerRequestFailurePolicy;
    })
  | undefined {
  if (plan.payload.recipes?.recover !== undefined) {
    return {
      source: "recipe",
      ...plan.payload.recipes.recover,
    };
  }
  if (plan.payload.auth?.recipe !== undefined && plan.payload.auth.failurePolicy !== undefined) {
    return {
      source: "auth-recipe",
      recipe: plan.payload.auth.recipe,
      failurePolicy: plan.payload.auth.failurePolicy,
      cachePolicy: "none",
    };
  }
  return undefined;
}

function resolveRetryDelayMs(
  retryPolicy: NonNullable<RequestPlanRecord["payload"]["retryPolicy"]>,
  response: OpensteerRequestExecuteOutput["response"],
  attempt: number,
): number {
  if (retryPolicy.respectRetryAfter) {
    const retryAfter = response.headers.find(
      (header) => header.name.toLowerCase() === "retry-after",
    )?.value;
    const retryAfterMs = parseRetryAfterDelayMs(retryAfter);
    if (retryAfterMs !== undefined) {
      return retryAfterMs;
    }
  }

  const baseDelayMs = retryPolicy.backoff?.delayMs ?? 0;
  if (baseDelayMs <= 0) {
    return 0;
  }

  if (retryPolicy.backoff?.strategy === "exponential") {
    const value = baseDelayMs * 2 ** attempt;
    return retryPolicy.backoff.maxDelayMs === undefined
      ? value
      : Math.min(value, retryPolicy.backoff.maxDelayMs);
  }

  return retryPolicy.backoff?.maxDelayMs === undefined
    ? baseDelayMs
    : Math.min(baseDelayMs, retryPolicy.backoff.maxDelayMs);
}

function parseRetryAfterDelayMs(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }
  return undefined;
}

async function pollUntil(
  timeout: TimeoutExecutionContext,
  predicate: () => Promise<boolean>,
): Promise<void> {
  await pollUntilResult(timeout, async () => ((await predicate()) ? true : undefined));
}

async function pollUntilResult<T>(
  timeout: TimeoutExecutionContext,
  producer: () => Promise<T | undefined>,
): Promise<T> {
  while (true) {
    timeout.throwIfAborted();
    const produced = await producer();
    if (produced !== undefined) {
      return produced;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function getMainFrame(engine: BrowserCoreEngine, pageRef: PageRef) {
  const frames = await engine.listFrames({ pageRef });
  const mainFrame = frames.find((frame) => frame.isMainFrame);
  if (!mainFrame) {
    throw new Error(`page ${pageRef} does not expose a main frame`);
  }
  return mainFrame;
}

function directionToDelta(
  direction: OpensteerDomScrollInput["direction"],
  amount: number,
): { readonly x: number; readonly y: number } {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`scroll amount must be a positive number, received ${String(amount)}`);
  }

  switch (direction) {
    case "up":
      return { x: 0, y: -amount };
    case "down":
      return { x: 0, y: amount };
    case "left":
      return { x: -amount, y: 0 };
    case "right":
      return { x: amount, y: 0 };
  }
}

function normalizeNamespace(value: string | undefined): string {
  const normalized = String(value ?? "default").trim();
  return normalized.length === 0 ? "default" : normalized;
}

function toOpensteerActionResult(
  result:
    | DomActionOutcome
    | {
        readonly resolved: ResolvedDomTarget;
        readonly point?: undefined;
      },
  persistedDescription: string | undefined,
): OpensteerActionResult {
  return {
    target: toOpensteerResolvedTarget(result.resolved),
    ...(result.point === undefined
      ? {}
      : {
          point: {
            x: result.point.x,
            y: result.point.y,
          },
        }),
    ...(persistedDescription === undefined ? {} : { persistedDescription }),
  };
}

function toOpensteerResolvedTarget(target: ResolvedDomTarget): OpensteerResolvedTarget {
  return {
    pageRef: target.pageRef,
    frameRef: target.frameRef,
    documentRef: target.documentRef,
    documentEpoch: target.documentEpoch,
    nodeRef: target.nodeRef,
    tagName: target.node.nodeName.toUpperCase(),
    pathHint: buildPathSelectorHint(target.replayPath ?? target.anchor),
    ...(target.description === undefined ? {} : { description: target.description }),
    ...(target.selectorUsed === undefined ? {} : { selectorUsed: target.selectorUsed }),
  };
}

function normalizeOpensteerError(error: unknown) {
  return normalizeThrownOpensteerError(error, "Unknown Opensteer runtime failure");
}

function observationArtifactKindFromManifest(
  kind: ArtifactManifest["kind"],
): "screenshot" | "dom-snapshot" | "html-snapshot" | "other" {
  switch (kind) {
    case "screenshot":
      return "screenshot";
    case "dom-snapshot":
      return "dom-snapshot";
    case "html-snapshot":
      return "html-snapshot";
    default:
      return "other";
  }
}

function buildObservationEventsFromTrace(input: {
  readonly traceId: string;
  readonly stepId: string;
  readonly operation: string;
  readonly outcome: "ok" | "error";
  readonly startedAt: number;
  readonly completedAt: number;
  readonly context?: TraceContext;
  readonly events?: readonly OpensteerEvent[];
  readonly data?: JsonValue;
  readonly error?: OpensteerError;
  readonly artifactIds?: readonly string[];
  readonly profile: ObservabilityConfig["profile"];
}): readonly AppendObservationEventInput[] {
  const context = normalizeObservationContext(input.context);
  const baseCorrelationId = input.traceId;
  const startedEvent: AppendObservationEventInput = {
    kind:
      input.operation === "session.open" || input.operation === "session.close"
        ? "session"
        : "operation",
    phase: "started",
    createdAt: input.startedAt,
    correlationId: baseCorrelationId,
    spanId: input.stepId,
    ...(context === undefined ? {} : { context }),
    data: {
      operation: input.operation,
    },
  };
  const stepEvents: AppendObservationEventInput[] = (input.events ?? [])
    .filter((event) => shouldCaptureObservationStepEvent(event, input.profile))
    .map((event) => {
      const eventContext = buildObservationContextFromEvent(event);
      return {
        kind: observationKindForStepEvent(event),
        phase: "occurred",
        createdAt: event.timestamp,
        correlationId: baseCorrelationId,
        parentSpanId: input.stepId,
        ...(eventContext === undefined ? {} : { context: eventContext }),
        data: stripObservationStepEvent(event),
        ...(event.kind === "page-error"
          ? {
              error: {
                message: event.message,
                ...(event.stack === undefined ? {} : { details: { stack: event.stack } }),
              },
            }
          : {}),
      };
    });
  const completedEvent: AppendObservationEventInput = {
    kind:
      input.operation === "session.open" || input.operation === "session.close"
        ? "session"
        : "operation",
    phase: input.outcome === "ok" ? "completed" : "failed",
    createdAt: input.completedAt,
    correlationId: baseCorrelationId,
    spanId: input.stepId,
    ...(context === undefined ? {} : { context }),
    data: {
      operation: input.operation,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      durationMs: input.completedAt - input.startedAt,
      ...(input.data === undefined ? {} : { output: input.data }),
    },
    ...(input.error === undefined
      ? {}
      : {
          error: {
            ...(input.error.code === undefined ? {} : { code: input.error.code }),
            message: input.error.message,
            ...(input.error.retriable === undefined ? {} : { retriable: input.error.retriable }),
            ...(input.error.details === undefined
              ? {}
              : { details: toCanonicalJsonValue(input.error.details) }),
          },
        }),
    ...(input.artifactIds === undefined || input.artifactIds.length === 0
      ? {}
      : { artifactIds: input.artifactIds }),
  };

  return [startedEvent, ...stepEvents, completedEvent];
}

function buildObservationContextFromEvent(event: OpensteerEvent): ObservationContext | undefined {
  return normalizeObservationContext({
    sessionRef: event.sessionRef,
    ...(event.pageRef === undefined ? {} : { pageRef: event.pageRef }),
    ...(event.frameRef === undefined ? {} : { frameRef: event.frameRef }),
    ...(event.documentRef === undefined ? {} : { documentRef: event.documentRef }),
    ...(event.documentEpoch === undefined ? {} : { documentEpoch: event.documentEpoch }),
  });
}

function shouldCaptureObservationStepEvent(
  event: OpensteerEvent,
  profile: ObservabilityConfig["profile"],
): boolean {
  if (profile === "diagnostic") {
    return true;
  }

  switch (event.kind) {
    case "page-created":
    case "popup-opened":
    case "page-closed":
    case "page-error":
      return true;
    case "console":
      return event.level === "warn" || event.level === "error";
    default:
      return false;
  }
}

function observationKindForStepEvent(
  event: OpensteerEvent,
): "page" | "console" | "error" | "runtime" {
  switch (event.kind) {
    case "console":
      return "console";
    case "page-error":
      return "error";
    case "paused":
    case "resumed":
    case "frozen":
      return "runtime";
    default:
      return "page";
  }
}

function stripObservationStepEvent(event: OpensteerEvent): JsonValue {
  const {
    eventId: _eventId,
    kind,
    timestamp,
    sessionRef: _sessionRef,
    pageRef: _pageRef,
    frameRef: _frameRef,
    documentRef: _documentRef,
    documentEpoch: _documentEpoch,
    ...rest
  } = event;

  return toCanonicalJsonValue({
    eventKind: kind,
    timestamp,
    ...rest,
  });
}

function buildMutationCaptureTraceData(
  diagnostics: MutationCaptureFinalizeDiagnostics | undefined,
): Record<string, unknown> {
  if (diagnostics?.finalizeError === undefined) {
    return {};
  }

  return {
    networkCapture: {
      finalizeError: diagnostics.finalizeError,
    },
  };
}

function isIgnorableRuntimeBindingError(error: unknown): boolean {
  return (
    isBrowserCoreError(error) &&
    (error.code === "not-found" || error.code === "page-closed" || error.code === "session-closed")
  );
}

async function withDetachedTimeoutSignal<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new OpensteerProtocolError(
    "timeout",
    `mutation capture finalization exceeded ${String(timeoutMs)}ms timeout`,
    {
      details: {
        policy: "mutation-capture-finalize",
        budgetMs: timeoutMs,
      },
    },
  );
  const timer = setTimeout(() => {
    controller.abort(timeoutError);
  }, timeoutMs);

  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function screenshotMediaType(format: "png" | "jpeg" | "webp"): string {
  switch (format) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
  }
}
