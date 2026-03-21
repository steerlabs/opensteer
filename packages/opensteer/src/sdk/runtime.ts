import path from "node:path";
import { randomUUID } from "node:crypto";
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
  type PageRef,
  type SessionRef,
} from "@opensteer/browser-core";
import {
  OpensteerProtocolError,
  assertValidSemanticOperationInput,
  createNetworkRequestId,
  createSessionRef,
  type OpensteerArtifactReadInput,
  type OpensteerArtifactReadOutput,
  type CaptchaDetectionResult,
  type CookieRecord,
  type OpensteerCaptchaSolveInput,
  type OpensteerCaptchaSolveOutput,
  type OpensteerActionResult,
  type OpensteerAddInitScriptInput,
  type OpensteerAddInitScriptOutput,
  type OpensteerGetRecipeInput,
  type OpensteerAuthRecipeRetryOverrides,
  type OpensteerAuthRecipeStep,
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
  type OpensteerNetworkSaveInput,
  type OpensteerNetworkSaveOutput,
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
  type OpensteerResolvedTarget,
  type OpensteerSemanticOperationName,
  type OpensteerSessionCloseOutput,
  type OpensteerSessionOpenInput,
  type OpensteerSessionOpenOutput,
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
  type OpensteerReverseCandidateRecord,
  type OpensteerExecutableResolver,
  type OpensteerReverseExperimentRecord,
  type OpensteerReverseExportInput,
  type OpensteerReverseExportOutput,
  type OpensteerReverseGuardRecord,
  type OpensteerReverseManualCalibrationMode,
  type OpensteerReverseObservationRecord,
  type OpensteerObservationCluster,
  type OpensteerReversePackageGetInput,
  type OpensteerReversePackageGetOutput,
  type OpensteerReversePackageKind,
  type OpensteerReversePackageListInput,
  type OpensteerReversePackageListOutput,
  type OpensteerReversePackagePatchInput,
  type OpensteerReversePackagePatchOutput,
  type OpensteerReversePackageReadiness,
  type OpensteerReplayStrategy,
  type OpensteerReverseReplayRunRecord,
  type OpensteerReverseReplayInput,
  type OpensteerReverseReplayOutput,
  type OpensteerReverseReportInput,
  type OpensteerReverseReportOutput,
  type OpensteerReverseRequirement,
  type OpensteerReverseSolveInput,
  type OpensteerReverseSolveOutput,
  type OpensteerReverseSuggestedEdit,
  type OpensteerReverseTargetHints,
  type OpensteerReverseWorkflowStep,
  type OpensteerStateDelta,
  type OpensteerStateSnapshot,
  type OpensteerStateSourceKind,
  type OpensteerValidationRule,
  type OpensteerEvent,
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
import { normalizeThrownOpensteerError } from "../internal/errors.js";
import { sha256Hex } from "../internal/filesystem.js";
import { canonicalJsonString, toCanonicalJsonValue } from "../json.js";
import {
  delayWithSignal,
  defaultPolicy,
  runWithPolicyTimeout,
  settleWithPolicy,
  type OpensteerPolicy,
  type TimeoutExecutionContext,
} from "../policy/index.js";
import { createFilesystemOpensteerRoot, type FilesystemOpensteerRoot } from "../root.js";
import {
  buildPathSelectorHint,
  createDomRuntime,
  sanitizeElementPath,
  type DomActionOutcome,
  type DomRuntime,
  type DomTargetRef,
  type ResolvedDomTarget,
} from "../runtimes/dom/index.js";
import {
  createComputerUseRuntime,
  type ComputerUseRuntime,
  type ComputerUseRuntimeOutput,
} from "../runtimes/computer-use/index.js";
import {
  defaultOpensteerEngineFactory,
  normalizeOpensteerBrowserContextOptions,
} from "../internal/engine-selection.js";
import type {
  OpensteerInterceptScriptOptions,
  OpensteerRouteOptions,
  OpensteerRouteRegistration,
} from "./instrumentation.js";
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
import { NetworkJournal } from "../network/journal.js";
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
  compileOpensteerExtractionPayload,
  createOpensteerExtractionDescriptorStore,
  replayOpensteerExtractionPayload,
  type OpensteerExtractionDescriptorRecord,
} from "./extraction.js";
import { compileOpensteerSnapshot, type CompiledOpensteerSnapshot } from "./snapshot/compiler.js";
import type {
  AuthRecipeRecord,
  InteractionTraceRecord,
  RecipeRecord,
  RequestPlanRecord,
  ReverseCaseRecord,
  ReversePackageRecord,
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

const requireForAuthRecipeHook = createRequire(import.meta.url);

export interface OpensteerEngineFactoryOptions {
  readonly browser?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
}

export type OpensteerEngineFactory = (
  options: OpensteerEngineFactoryOptions,
) => Promise<BrowserCoreEngine>;

export interface OpensteerRuntimeOptions {
  readonly name?: string;
  readonly rootDir?: string;
  readonly browser?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
  readonly engine?: BrowserCoreEngine;
  readonly engineFactory?: OpensteerEngineFactory;
  readonly policy?: OpensteerPolicy;
}

interface OpensteerTraceArtifacts {
  readonly manifests: readonly ArtifactManifest[];
}

interface PersistedComputerArtifacts {
  readonly manifests: readonly ArtifactManifest[];
  readonly output: OpensteerComputerExecuteOutput;
}

interface ReverseReplaySelectionInput {
  readonly caseId: string;
  readonly candidateId: string;
  readonly strategyId?: string;
  readonly pageRef?: PageRef;
  readonly packageId?: string;
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
  readonly candidateLimit?: number;
}

interface InternalReverseAnalyzeOutput {
  readonly case: ReverseCaseRecord;
  readonly analyzedObservationIds: readonly string[];
  readonly candidateCount: number;
}

interface ReversePackageWriteInput {
  readonly caseRecord: ReverseCaseRecord;
  readonly candidate?: OpensteerReverseCandidateRecord;
  readonly strategy?: OpensteerReverseCandidateRecord["replayStrategies"][number];
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
  readonly provenanceSource: "reverse.solve" | "reverse.export" | "reverse.package.patch";
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

interface RuntimeOperationOptions {
  readonly signal?: AbortSignal;
}

interface RuntimeBrowserBinding {
  readonly sessionRef: SessionRef;
  readonly pageRef: PageRef;
}

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
  readonly name: string;
  readonly rootPath: string;

  private readonly configuredBrowser: OpensteerBrowserLaunchOptions | undefined;
  private readonly configuredContext: OpensteerBrowserContextOptions | undefined;
  private readonly injectedEngine: BrowserCoreEngine | undefined;
  private readonly engineFactory: OpensteerEngineFactory;
  private readonly policy: OpensteerPolicy;

  private root: FilesystemOpensteerRoot | undefined;
  private engine: DisposableBrowserCoreEngine | undefined;
  private dom: DomRuntime | undefined;
  private computer: ComputerUseRuntime | undefined;
  private readonly networkJournal = new NetworkJournal();
  private extractionDescriptors:
    | ReturnType<typeof createOpensteerExtractionDescriptorStore>
    | undefined;
  private sessionRef: SessionRef | undefined;
  private pageRef: PageRef | undefined;
  private runId: string | undefined;
  private latestSnapshot: CompiledOpensteerSnapshot | undefined;
  private readonly backgroundNetworkPersistence = new Set<Promise<void>>();
  private readonly cookieJars = new Map<string, CookieJarEntry[]>();
  private readonly recipeCache = new Map<string, OpensteerRunRecipeOutput>();
  private ownsEngine = false;

  constructor(options: OpensteerRuntimeOptions = {}) {
    this.name = normalizeNamespace(options.name);
    this.rootPath = path.resolve(options.rootDir ?? process.cwd(), ".opensteer");
    this.configuredBrowser = options.browser;
    this.configuredContext = options.context;
    this.injectedEngine = options.engine;
    this.engineFactory = options.engineFactory ?? defaultOpensteerEngineFactory;
    this.policy = options.policy ?? defaultPolicy();
  }

  async open(
    input: OpensteerSessionOpenInput = {},
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerSessionOpenOutput> {
    assertValidSemanticOperationInput("session.open", input);

    if (input.name !== undefined && normalizeNamespace(input.name) !== this.name) {
      throw new Error(
        `session.open requested namespace "${input.name}" but runtime is bound to "${this.name}"`,
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
          this.latestSnapshot = undefined;
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

      await this.appendTrace({
        operation: "page.list",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          count: output.pages.length,
          ...(output.activePageRef === undefined ? {} : { activePageRef: output.activePageRef }),
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "page.list",
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
          this.latestSnapshot = undefined;
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
          this.latestSnapshot = undefined;
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
          this.latestSnapshot = undefined;

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

    try {
      const { navigation, state } = await this.runWithOperationTimeout(
        "page.goto",
        async (timeout) => {
          const baselineRequestIds = await this.beginMutationCapture(timeout);
          try {
            const navigation = await this.navigatePage(
              {
                operation: "page.goto",
                pageRef,
                url: input.url,
              },
              timeout,
            );
            timeout.throwIfAborted();
            this.latestSnapshot = undefined;
            await this.completeMutationCapture(timeout, baselineRequestIds, input.networkTag);
            return {
              navigation,
              state: await timeout.runStep(() => this.readSessionState()),
            };
          } catch (error) {
            await this.completeMutationCapture(timeout, baselineRequestIds, input.networkTag).catch(
              () => undefined,
            );
            throw error;
          }
        },
        options,
      );
      await this.appendTrace({
        operation: "page.goto",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          url: input.url,
          state,
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

    try {
      const output = await this.runWithOperationTimeout(
        "page.evaluate",
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
        options,
      );

      await this.appendTrace({
        operation: "page.evaluate",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          pageRef: output.pageRef,
          value: output.value,
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
          this.latestSnapshot = compiled;
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

      await this.appendTrace({
        operation: "page.snapshot",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        artifacts,
        data: {
          mode,
          url: output.url,
          title: output.title,
          counterCount: output.counters.length,
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef,
        }),
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
          if (input.schema !== undefined) {
            assertValidOpensteerExtractionSchemaRoot(input.schema);
            const payload = await timeout.runStep(() =>
              compileOpensteerExtractionPayload({
                pageRef,
                schema: input.schema as Record<string, unknown>,
                dom: this.requireDom(),
                ...(this.latestSnapshot?.counterRecords === undefined
                  ? {}
                  : { latestSnapshotCounters: this.latestSnapshot.counterRecords }),
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
            descriptor = await timeout.runStep(() =>
              descriptors.read({
                description: input.description,
              }),
            );
            if (!descriptor) {
              throw new OpensteerProtocolError(
                "not-found",
                `no stored extraction descriptor found for "${input.description}"`,
                {
                  details: {
                    description: input.description,
                    namespace: this.name,
                    kind: "extraction-descriptor",
                  },
                },
              );
            }
          }

          const data = await timeout.runStep(() =>
            replayOpensteerExtractionPayload({
              pageRef,
              dom: this.requireDom(),
              payload: descriptor.payload.root,
            }),
          );
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

    if (input.source !== "saved") {
      await this.ensurePageRef();
    }
    const root = await this.ensureRoot();
    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "network.query",
        async (timeout) => {
          if (input.source === "saved") {
            await timeout.runStep(() => this.flushBackgroundNetworkPersistence());
            return {
              records: await timeout.runStep(() =>
                root.registry.savedNetwork.query({
                  ...(input.recordId === undefined ? {} : { recordId: input.recordId }),
                  ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
                  ...(input.actionId === undefined ? {} : { actionId: input.actionId }),
                  ...(input.tag === undefined ? {} : { tag: input.tag }),
                  ...(input.url === undefined ? {} : { url: input.url }),
                  ...(input.hostname === undefined ? {} : { hostname: input.hostname }),
                  ...(input.path === undefined ? {} : { path: input.path }),
                  ...(input.method === undefined ? {} : { method: input.method }),
                  ...(input.status === undefined ? {} : { status: input.status }),
                  ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
                  ...(input.includeBodies === undefined
                    ? {}
                    : { includeBodies: input.includeBodies }),
                  ...(input.limit === undefined ? {} : { limit: input.limit }),
                }),
              ),
            } satisfies OpensteerNetworkQueryOutput;
          }

          return {
            records: await this.queryLiveNetwork(input, timeout),
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
          source: input.source ?? "live",
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

  async saveNetwork(
    input: OpensteerNetworkSaveInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerNetworkSaveOutput> {
    assertValidSemanticOperationInput("network.save", input);

    await this.ensurePageRef();
    const root = await this.ensureRoot();
    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "network.save",
        async (timeout) => {
          const records = await this.queryLiveNetwork(
            {
              includeBodies: true,
              source: "live",
              ...(input.pageRef === undefined ? {} : { pageRef: input.pageRef }),
              ...(input.recordId === undefined ? {} : { recordId: input.recordId }),
              ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
              ...(input.actionId === undefined ? {} : { actionId: input.actionId }),
              ...(input.url === undefined ? {} : { url: input.url }),
              ...(input.hostname === undefined ? {} : { hostname: input.hostname }),
              ...(input.path === undefined ? {} : { path: input.path }),
              ...(input.method === undefined ? {} : { method: input.method }),
              ...(input.status === undefined ? {} : { status: input.status }),
              ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
            },
            timeout,
            { ignoreLimit: true, redactSecretHeaders: false },
          );
          this.networkJournal.addTag(records, input.tag);
          return {
            savedCount: await timeout.runStep(() =>
              root.registry.savedNetwork.save(records, input.tag),
            ),
          } satisfies OpensteerNetworkSaveOutput;
        },
        options,
      );

      await this.appendTrace({
        operation: "network.save",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          tag: input.tag,
          savedCount: output.savedCount,
        },
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "network.save",
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
          await timeout.runStep(() => this.flushBackgroundNetworkPersistence());
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

  async solveReverse(
    input: OpensteerReverseSolveInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerReverseSolveOutput> {
    assertValidSemanticOperationInput("reverse.solve", input);

    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "reverse.solve",
        async (timeout) => {
          const root = await this.ensureRoot();
          const capture = await this.captureReverseCaseInternal(input, timeout);
          const analyzed = await this.analyzeReverseCaseInternal(
            {
              caseId: capture.case.id,
              observationId: capture.observation.id,
              ...(input.targetHints === undefined ? {} : { targetHints: input.targetHints }),
              ...(input.candidateLimit === undefined
                ? {}
                : { candidateLimit: input.candidateLimit }),
            },
            timeout,
          );
          let caseRecord = analyzed.case;
          const maxReplayAttempts = input.maxReplayAttempts ?? 6;
          const replayRuns: OpensteerReverseReplayRunRecord[] = [];
          const experiments: OpensteerReverseExperimentRecord[] = [];
          let selectedCandidate: OpensteerReverseCandidateRecord | undefined;
          let selectedStrategy:
            | OpensteerReverseCandidateRecord["replayStrategies"][number]
            | undefined;
          let selectedRun: OpensteerReverseReplayRunRecord | undefined;
          let attempts = 0;

          outer: for (const candidate of caseRecord.payload.candidates) {
            for (const strategy of candidate.replayStrategies) {
              if (!strategy.supported) {
                experiments.push({
                  id: `experiment:${randomUUID()}`,
                  createdAt: Date.now(),
                  candidateId: candidate.id,
                  strategyId: strategy.id,
                  kind: "replay-attempt",
                  hypothesis: `replay ${candidate.id} via ${strategy.id}`,
                  success: false,
                  ...(strategy.failureReason === undefined
                    ? {}
                    : { notes: strategy.failureReason }),
                });
                continue;
              }

              if (attempts >= maxReplayAttempts) {
                break outer;
              }

              attempts += 1;
              const replay = await this.replayReverseSelectionInternal(
                {
                  caseId: caseRecord.id,
                  candidateId: candidate.id,
                  strategyId: strategy.id,
                  ...(input.pageRef === undefined ? {} : { pageRef: input.pageRef }),
                },
                timeout,
              );
              replayRuns.push(replay.run);
              experiments.push({
                id: `experiment:${randomUUID()}`,
                createdAt: replay.run.createdAt,
                candidateId: candidate.id,
                strategyId: strategy.id,
                kind: "replay-attempt",
                hypothesis: `replay ${candidate.id} via ${strategy.id}`,
                success: replay.run.success,
                ...(replay.run.status === undefined ? {} : { status: replay.run.status }),
                ...(replay.run.error === undefined ? {} : { notes: replay.run.error }),
                validation: replay.run.validation,
              });

              if (replay.run.success) {
                selectedCandidate = replay.candidate;
                selectedStrategy = replay.strategy;
                selectedRun = replay.run;
                break outer;
              }
            }
          }

          const chosenCandidate = selectedCandidate ?? caseRecord.payload.candidates[0];
          const chosenStrategy =
            selectedStrategy ??
            (chosenCandidate === undefined
              ? undefined
              : (chosenCandidate.replayStrategies.find((strategy) => strategy.supported) ??
                chosenCandidate.replayStrategies[0]));
          const packageValidators =
            chosenCandidate === undefined
              ? []
              : buildReverseValidationRules({
                  record: await this.resolveNetworkRecordByRecordId(
                    chosenCandidate.recordId,
                    timeout,
                    {
                      includeBodies: true,
                      redactSecretHeaders: false,
                    },
                  ),
                  channel: chosenCandidate.channel,
                });
          const packageDraft = await this.buildReversePackageDraft(
            {
              caseRecord,
              ...(chosenCandidate === undefined ? {} : { candidate: chosenCandidate }),
              ...(chosenStrategy === undefined ? {} : { strategy: chosenStrategy }),
              validators: packageValidators,
              ...(input.manualCalibration === undefined
                ? {}
                : { manualCalibration: input.manualCalibration }),
              ...(input.notes === undefined ? {} : { notes: input.notes }),
            },
            timeout,
          );
          const requestPlan =
            packageDraft.kind === "portable-http" &&
            packageDraft.readiness === "runnable" &&
            chosenCandidate !== undefined &&
            chosenStrategy !== undefined
              ? await this.writePortableReverseRequestPlan(
                  caseRecord,
                  chosenCandidate,
                  chosenStrategy,
                  timeout,
                  {
                    key: `${caseRecord.key}:portable`,
                    version: "1.0.0",
                    provenanceSource: "reverse.solve",
                  },
                )
              : undefined;
          const packageRecord = await this.writeReversePackage({
            caseRecord,
            ...(chosenCandidate === undefined ? {} : { candidate: chosenCandidate }),
            ...(chosenStrategy === undefined ? {} : { strategy: chosenStrategy }),
            kind: packageDraft.kind,
            readiness: packageDraft.readiness,
            validators: packageValidators,
            workflow: packageDraft.workflow,
            resolvers: packageDraft.resolvers,
            unresolvedRequirements: packageDraft.unresolvedRequirements,
            suggestedEdits: packageDraft.suggestedEdits,
            attachedTraceIds: packageDraft.attachedTraceIds,
            attachedArtifactIds: packageDraft.attachedArtifactIds,
            attachedRecordIds: packageDraft.attachedRecordIds,
            stateSnapshots: packageDraft.stateSnapshots,
            ...(requestPlan === undefined ? {} : { requestPlan }),
            ...(packageDraft.notes === undefined ? {} : { notes: packageDraft.notes }),
            ...(input.manualCalibration === undefined
              ? {}
              : { manualCalibration: input.manualCalibration }),
            provenanceSource: "reverse.solve",
          });

          const finalRun: OpensteerReverseReplayRunRecord =
            selectedRun === undefined
              ? {
                  id: `reverse-replay:${randomUUID()}`,
                  createdAt: Date.now(),
                  candidateId: chosenCandidate?.id ?? "candidate:none",
                  ...(chosenStrategy === undefined ? {} : { strategyId: chosenStrategy.id }),
                  packageId: packageRecord.id,
                  success: false,
                  ...(chosenCandidate === undefined
                    ? {}
                    : { channel: chosenCandidate.channel.kind }),
                  kind: packageRecord.payload.kind,
                  readiness: packageRecord.payload.readiness,
                  ...(chosenStrategy?.transport === undefined
                    ? {}
                    : { transport: chosenStrategy.transport }),
                  ...(chosenStrategy?.stateSource === undefined
                    ? {}
                    : { stateSource: chosenStrategy.stateSource }),
                  validation: {},
                  error:
                    packageRecord.payload.unresolvedRequirements[0]?.label ??
                    "reverse solve produced a draft package that still needs agent edits before replay can run",
                }
              : {
                  ...selectedRun,
                  packageId: packageRecord.id,
                  kind: packageRecord.payload.kind,
                  readiness: packageRecord.payload.readiness,
                };
          const finalReplayRuns =
            selectedRun === undefined
              ? [...replayRuns, finalRun]
              : replayRuns.map((run) => (run.id === selectedRun.id ? finalRun : run));
          const exportRecord =
            chosenCandidate === undefined
              ? undefined
              : {
                  id: `export:${randomUUID()}`,
                  createdAt: Date.now(),
                  candidateId: chosenCandidate.id,
                  ...(chosenStrategy === undefined ? {} : { strategyId: chosenStrategy.id }),
                  packageId: packageRecord.id,
                  kind: packageRecord.payload.kind,
                  readiness: packageRecord.payload.readiness,
                  ...(requestPlan === undefined ? {} : { requestPlanId: requestPlan.id }),
                };
          caseRecord = await root.registry.reverseCases.update({
            id: caseRecord.id,
            payload: {
              ...caseRecord.payload,
              status: packageRecord.payload.readiness === "runnable" ? "ready" : "attention",
              experiments: [...caseRecord.payload.experiments, ...experiments],
              replayRuns: [...caseRecord.payload.replayRuns, ...finalReplayRuns],
              exports:
                exportRecord === undefined
                  ? caseRecord.payload.exports
                  : [...caseRecord.payload.exports, exportRecord],
            },
          });

          const report = await this.writeReverseReportRecord({
            caseRecord,
            packageRecord,
            ...(chosenCandidate === undefined ? {} : { chosenCandidate }),
            ...(chosenStrategy === undefined ? {} : { chosenStrategy }),
          });

          return {
            caseId: caseRecord.id,
            package: packageRecord,
            report,
          } satisfies OpensteerReverseSolveOutput;
        },
        options,
      );

      await this.appendTrace({
        operation: "reverse.solve",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          caseId: output.caseId,
          packageId: output.package.id,
          reportId: output.report.id,
        },
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "reverse.solve",
        startedAt,
        completedAt: Date.now(),
        outcome: "error",
        error,
      });
      throw error;
    }
  }

  async replayReverse(
    input: OpensteerReverseReplayInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerReverseReplayOutput> {
    assertValidSemanticOperationInput("reverse.replay", input);

    return this.runWithOperationTimeout(
      "reverse.replay",
      async (timeout) => {
        const packageRecord = await this.resolveReversePackageById(input.packageId);

        if (
          packageRecord.payload.readiness !== "runnable" ||
          packageRecord.payload.candidate === undefined ||
          packageRecord.payload.strategy === undefined
        ) {
          return {
            packageId: packageRecord.id,
            caseId: packageRecord.payload.caseId,
            success: false,
            kind: packageRecord.payload.kind,
            readiness: packageRecord.payload.readiness,
            validation: {},
            unresolvedRequirements: packageRecord.payload.unresolvedRequirements,
            suggestedEdits: packageRecord.payload.suggestedEdits,
            error:
              packageRecord.payload.unresolvedRequirements[0]?.label ??
              "reverse package is still a draft and cannot be replayed yet",
          } satisfies OpensteerReverseReplayOutput;
        }

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
                  candidateId: replay.candidate.id,
                  strategyId: replay.strategy.id,
                  kind: "replay-attempt",
                  hypothesis: `replay ${replay.candidate.id} via package ${packageRecord.id}`,
                  success: replay.run.success,
                  ...(replay.run.status === undefined ? {} : { status: replay.run.status }),
                  ...(replay.run.error === undefined ? {} : { notes: replay.run.error }),
                  validation: replay.run.validation,
                },
              ],
              replayRuns: [...caseRecord.payload.replayRuns, replay.run],
            },
          });
        }

        return {
          packageId: packageRecord.id,
          caseId: packageRecord.payload.caseId,
          candidateId: replay.candidate.id,
          strategyId: replay.strategy.id,
          success: replay.run.success,
          kind: packageRecord.payload.kind,
          readiness: packageRecord.payload.readiness,
          channel: replay.candidate.channel.kind,
          ...(replay.strategy.transport === undefined
            ? {}
            : { transport: replay.strategy.transport }),
          stateSource: replay.strategy.stateSource,
          ...(replay.run.recordId === undefined ? {} : { recordId: replay.run.recordId }),
          ...(replay.run.status === undefined ? {} : { status: replay.run.status }),
          validation: replay.run.validation,
          unresolvedRequirements: packageRecord.payload.unresolvedRequirements,
          suggestedEdits: packageRecord.payload.suggestedEdits,
          ...(replay.run.error === undefined ? {} : { error: replay.run.error }),
        } satisfies OpensteerReverseReplayOutput;
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
      async () => {
        const root = await this.ensureRoot();
        const sourcePackage = await this.resolveReversePackageById(input.packageId);
        const packageRecord =
          input.key === undefined && input.version === undefined
            ? sourcePackage
            : await root.registry.reversePackages.write({
                key: input.key ?? `${sourcePackage.key}:copy:${Date.now()}`,
                version: input.version ?? sourcePackage.version,
                tags: sourcePackage.tags,
                provenance: {
                  source: "reverse.export",
                  sourceId: sourcePackage.id,
                },
                payload: sourcePackage.payload,
              });
        const requestPlan =
          packageRecord.payload.requestPlanId === undefined
            ? undefined
            : await root.registry.requestPlans.getById(packageRecord.payload.requestPlanId);

        if (
          packageRecord.id !== sourcePackage.id &&
          packageRecord.payload.candidateId !== undefined
        ) {
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
                    ...(packageRecord.payload.strategyId === undefined
                      ? {}
                      : { strategyId: packageRecord.payload.strategyId }),
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
        if (input.packageId === undefined && input.reportId === undefined) {
          throw new OpensteerProtocolError(
            "invalid-argument",
            "reverse report requires packageId or reportId",
          );
        }
        const report =
          input.reportId === undefined
            ? await this.resolveReverseReportByPackageId(input.packageId!)
            : await this.resolveReverseReportById(input.reportId);
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
        const candidate =
          input.candidateId === undefined
            ? sourcePackage.payload.candidate
            : caseRecord.payload.candidates.find((entry) => entry.id === input.candidateId);
        if (input.candidateId !== undefined && candidate === undefined) {
          throw new OpensteerProtocolError(
            "not-found",
            `reverse candidate ${input.candidateId} was not found`,
          );
        }
        const selectedStrategyId = input.strategyId ?? sourcePackage.payload.strategy?.id;
        const strategy =
          candidate === undefined
            ? undefined
            : selectedStrategyId === undefined
              ? (candidate.replayStrategies.find((entry) => entry.supported) ??
                candidate.replayStrategies[0])
              : candidate.replayStrategies.find((entry) => entry.id === selectedStrategyId);
        if (input.strategyId !== undefined && strategy === undefined) {
          throw new OpensteerProtocolError(
            "not-found",
            `reverse strategy ${input.strategyId} was not found`,
          );
        }

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
            ...(strategy === undefined ? {} : { strategy }),
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
        const requestPlan =
          draft.kind === "portable-http" &&
          draft.readiness === "runnable" &&
          candidate !== undefined &&
          strategy !== undefined
            ? await this.writePortableReverseRequestPlan(caseRecord, candidate, strategy, timeout, {
                key: `${caseRecord.key}:portable:${Date.now()}`,
                version: "1.0.0",
                provenanceSource: "reverse.export",
              })
            : undefined;
        const packageRecord = await this.writeReversePackage({
          caseRecord,
          ...(candidate === undefined ? {} : { candidate }),
          ...(strategy === undefined ? {} : { strategy }),
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
          ...(requestPlan === undefined ? {} : { requestPlan }),
          parentPackageId: sourcePackage.id,
          key: input.key ?? `${sourcePackage.key}:patch:${Date.now()}`,
          version: input.version ?? sourcePackage.version,
          provenanceSource: "reverse.package.patch",
        });
        const report = await this.writeReverseReportRecord({
          caseRecord,
          packageRecord,
          ...(candidate === undefined ? {} : { chosenCandidate: candidate }),
          ...(strategy === undefined ? {} : { chosenStrategy: strategy }),
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
          source: "reverse.solve",
          ...(pageInfo.url.length === 0 ? {} : { sourceId: pageInfo.url }),
        },
        payload: {
          objective: input.objective ?? `Reverse engineer ${pageInfo.url}`,
          ...(input.notes === undefined ? {} : { notes: input.notes }),
          status: "capturing",
          stateSource,
          observations: [],
          observationClusters: [],
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
        source: "live",
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
      this.networkJournal,
      input.captureWindowMs,
    );
    const observationId = `observation:${randomUUID()}`;
    const networkTag = `reverse-case:${caseRecord.id}:${observationId}`;
    if (persistedNetwork.length > 0) {
      await root.registry.savedNetwork.save(persistedNetwork, networkTag);
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
      networkRecordIds: persistedNetwork.map((record) => record.recordId),
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
          observedAt: this.networkJournal.getObservedAt(recordId),
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

      for (const cluster of clusters) {
        const recordId = cluster.primaryRecordId;
        const record = await this.resolveNetworkRecordByRecordId(recordId, timeout, {
          includeBodies: true,
          redactSecretHeaders: false,
        });
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
          role: analysis.role,
          dependencyClass: analysis.dependencyClass,
          score: analysis.score,
          summary: analysis.summary,
          matchedTargetHints: analysis.matchedTargetHints,
          inputs: analysis.inputs,
          resolvers: analysis.resolvers,
          guardIds: Array.from(
            new Set(analysis.replayStrategies.flatMap((strategy) => strategy.guardIds)),
          ).sort((left, right) => left.localeCompare(right)),
          scriptArtifactIds: observation.scriptArtifactIds,
          replayStrategies: analysis.replayStrategies,
        });
      }
    }

    analyzedCandidates.sort(
      (left, right) =>
        compareReverseAnalysisResults(left, right) || left.id.localeCompare(right.id),
    );
    const limitedCandidates =
      input.candidateLimit === undefined
        ? analyzedCandidates
        : analyzedCandidates.slice(0, input.candidateLimit);
    const untouchedCandidates = caseRecord.payload.candidates.filter(
      (candidate) => !targetObservationIds.includes(candidate.observationId),
    );
    const nextCandidates = [...untouchedCandidates, ...limitedCandidates];

    const updatedCase = await root.registry.reverseCases.update({
      id: caseRecord.id,
      payload: {
        ...caseRecord.payload,
        status: nextCandidates.length === 0 ? "attention" : "ready",
        observationClusters: mergeObservationClusters(
          caseRecord.payload.observationClusters,
          analyzedClusters,
        ),
        candidates: nextCandidates,
      },
    });

    return {
      case: updatedCase,
      analyzedObservationIds: targetObservationIds,
      candidateCount: nextCandidates.length,
    };
  }

  private async replayReverseSelectionInternal(
    input: ReverseReplaySelectionInput,
    timeout: TimeoutExecutionContext,
  ): Promise<{
    readonly caseRecord: ReverseCaseRecord;
    readonly candidate: OpensteerReverseCandidateRecord;
    readonly strategy: OpensteerReverseCandidateRecord["replayStrategies"][number];
    readonly run: OpensteerReverseReplayRunRecord;
  }> {
    const caseRecord = await this.resolveReverseCaseById(input.caseId);
    const candidate = resolveReverseCandidate(caseRecord, input.candidateId);
    const strategy =
      input.strategyId === undefined
        ? (candidate.replayStrategies.find((entry) => entry.supported) ??
          candidate.replayStrategies[0])
        : candidate.replayStrategies.find((entry) => entry.id === input.strategyId);
    if (strategy === undefined) {
      throw new OpensteerProtocolError(
        "not-found",
        `reverse replay strategy ${input.strategyId ?? "<default>"} was not found for ${candidate.id}`,
      );
    }
    const validationRules = buildReverseValidationRules({
      record: await this.resolveNetworkRecordByRecordId(candidate.recordId, timeout, {
        includeBodies: true,
        redactSecretHeaders: false,
      }),
      channel: candidate.channel,
    });
    const draft = await this.buildReversePackageDraft(
      {
        caseRecord,
        candidate,
        strategy,
        validators: validationRules,
      },
      timeout,
    );
    if (draft.readiness !== "runnable") {
      const packageId = input.packageId ?? `reverse-package:ephemeral:${randomUUID()}`;
      return {
        caseRecord,
        candidate,
        strategy,
        run: {
          id: `reverse-replay:${randomUUID()}`,
          createdAt: Date.now(),
          candidateId: candidate.id,
          strategyId: strategy.id,
          packageId,
          success: false,
          channel: candidate.channel.kind,
          kind: draft.kind,
          readiness: draft.readiness,
          ...(strategy.transport === undefined ? {} : { transport: strategy.transport }),
          stateSource: strategy.stateSource,
          validation: {},
          error:
            draft.unresolvedRequirements[0]?.label ??
            strategy.failureReason ??
            "strategy draft still needs agent edits before replay can run",
        },
      };
    }
    const ephemeralPackage: ReversePackageRecord = {
      id: input.packageId ?? `reverse-package:ephemeral:${randomUUID()}`,
      key: `${caseRecord.key}:advisory:${candidate.id}`,
      version: "1.0.0",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      contentHash: sha256Hex(Buffer.from(candidate.id, "utf8")),
      tags: caseRecord.tags,
      provenance: {
        source: "reverse.solve",
        sourceId: candidate.id,
      },
      payload: {
        kind: draft.kind,
        readiness: draft.readiness,
        caseId: caseRecord.id,
        objective: caseRecord.payload.objective,
        candidateId: candidate.id,
        candidate,
        strategyId: strategy.id,
        strategy,
        channel: candidate.channel,
        stateSource: strategy.stateSource,
        observationId: candidate.observationId,
        ...(strategy.transport === undefined ? {} : { transport: strategy.transport }),
        guardIds: strategy.guardIds,
        workflow: draft.workflow,
        resolvers: draft.resolvers,
        validators: validationRules,
        stateSnapshots: draft.stateSnapshots,
        requirements: buildReversePackageRequirements({
          stateSource: caseRecord.payload.stateSource,
          strategy,
          candidate,
        }),
        unresolvedRequirements: draft.unresolvedRequirements,
        suggestedEdits: draft.suggestedEdits,
        attachedTraceIds: draft.attachedTraceIds,
        attachedArtifactIds: draft.attachedArtifactIds,
        attachedRecordIds: draft.attachedRecordIds,
      },
    };
    const replay = await this.replayReversePackageInternal(
      ephemeralPackage,
      timeout,
      input.pageRef,
    );

    return {
      caseRecord,
      candidate,
      strategy,
      run: {
        ...replay.run,
        ...(input.packageId === undefined ? {} : { packageId: input.packageId }),
      },
    };
  }

  private async replayReversePackageInternal(
    packageRecord: ReversePackageRecord,
    timeout: TimeoutExecutionContext,
    explicitPageRef: PageRef | undefined,
  ): Promise<{
    readonly candidate: OpensteerReverseCandidateRecord;
    readonly strategy: OpensteerReplayStrategy;
    readonly run: OpensteerReverseReplayRunRecord;
  }> {
    const candidate = packageRecord.payload.candidate;
    const strategy = packageRecord.payload.strategy;
    if (candidate === undefined || strategy === undefined) {
      throw new OpensteerProtocolError(
        "invalid-argument",
        `reverse package ${packageRecord.id} is missing its executable candidate or strategy`,
      );
    }

    if (packageRecord.payload.stateSnapshots.length > 0) {
      await this.restoreReverseStateSnapshots(
        packageRecord.payload.stateSnapshots,
        candidate,
        timeout,
        explicitPageRef,
      );
    }
    const replayResult = await this.executeReversePackageWorkflow(
      packageRecord,
      candidate,
      strategy,
      timeout,
      explicitPageRef,
    );

    return {
      candidate,
      strategy,
      run: {
        id: `reverse-replay:${randomUUID()}`,
        createdAt: Date.now(),
        candidateId: candidate.id,
        strategyId: strategy.id,
        packageId: packageRecord.id,
        success: replayResult.success,
        channel: candidate.channel.kind,
        kind: packageRecord.payload.kind,
        readiness: packageRecord.payload.readiness,
        stateSource: strategy.stateSource,
        ...(strategy.transport === undefined ? {} : { transport: strategy.transport }),
        ...(replayResult.recordId === undefined ? {} : { recordId: replayResult.recordId }),
        ...(replayResult.status === undefined ? {} : { status: replayResult.status }),
        validation: replayResult.validation,
        ...(replayResult.error === undefined ? {} : { error: replayResult.error }),
      },
    };
  }

  private async executeReversePackageWorkflow(
    packageRecord: ReversePackageRecord,
    candidate: OpensteerReverseCandidateRecord,
    strategy: OpensteerReplayStrategy,
    timeout: TimeoutExecutionContext,
    explicitPageRef: PageRef | undefined,
  ): Promise<{
    readonly success: boolean;
    readonly recordId?: string;
    readonly status?: number;
    readonly validation: OpensteerReverseReplayOutput["validation"];
    readonly error?: string;
  }> {
    const bindings = new Map<string, unknown>();
    const baselineRequestIds = await this.beginMutationCapture(timeout);
    const pageRef = explicitPageRef ?? (await this.ensurePageRef());
    const validatorMap = new Map(
      packageRecord.payload.validators.map((validator) => [validator.id, validator]),
    );
    let lastAssertable: unknown;
    let lastRecordId: string | undefined;
    let lastStatus: number | undefined;

    for (const step of packageRecord.payload.workflow) {
      const resolverValues = await this.resolveReversePackageResolverValues(
        packageRecord,
        bindings,
        pageRef,
        timeout,
      );
      switch (step.kind) {
        case "operation": {
          const result = await this.executeReversePackageOperationStep(
            step,
            timeout,
            pageRef,
            bindings,
            resolverValues,
          );
          if (step.bindAs !== undefined) {
            bindings.set(step.bindAs, result);
          }
          lastAssertable = result;
          lastRecordId = extractReverseRecordId(result);
          lastStatus = extractReverseStatus(result);
          break;
        }
        case "await-record": {
          const record = await this.resolveNetworkRecordByRecordId(
            step.recordId ?? candidate.recordId,
            timeout,
            {
              includeBodies: true,
              redactSecretHeaders: false,
            },
          );
          const matchedRecord = await this.waitForObservedReplayRecord(
            record,
            baselineRequestIds,
            timeout,
            pageRef,
          );
          if (matchedRecord === undefined) {
            return {
              success: false,
              validation: {},
              error: "package workflow did not emit the expected observed record",
            };
          }
          const bindingName = step.bindAs ?? `record:${step.id}`;
          bindings.set(bindingName, matchedRecord);
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
              validation: {},
              error: `assert step ${step.id} did not find a bound result`,
            };
          }
          return evaluateReversePackageAssertion(
            boundValue,
            candidate.channel.kind,
            validators,
            lastRecordId,
            lastStatus,
          );
        }
      }
    }

    return {
      success: true,
      ...(lastRecordId === undefined ? {} : { recordId: lastRecordId }),
      ...(lastStatus === undefined ? {} : { status: lastStatus }),
      validation: {},
    };
  }

  private async executeReversePackageOperationStep(
    step: Extract<OpensteerReverseWorkflowStep, { readonly kind: "operation" }>,
    timeout: TimeoutExecutionContext,
    pageRef: PageRef,
    bindings: ReadonlyMap<string, unknown>,
    resolverValues: ReadonlyMap<string, unknown>,
  ): Promise<unknown> {
    const input = normalizeReversePackageOperationInput(step.input, bindings, resolverValues);
    switch (step.operation) {
      case "page.goto":
        return this.goto(input as OpensteerPageGotoInput, { signal: timeout.signal });
      case "page.evaluate":
        return this.evaluate(
          withReverseOperationPageRef(input, pageRef) as OpensteerPageEvaluateInput,
          {
            signal: timeout.signal,
          },
        );
      case "dom.click":
        return this.click(withReverseOperationPageRef(input, pageRef) as OpensteerDomClickInput, {
          signal: timeout.signal,
        });
      case "dom.hover":
        return this.hover(withReverseOperationPageRef(input, pageRef) as OpensteerDomHoverInput, {
          signal: timeout.signal,
        });
      case "dom.input":
        return this.input(withReverseOperationPageRef(input, pageRef) as OpensteerDomInputInput, {
          signal: timeout.signal,
        });
      case "dom.scroll":
        return this.scroll(withReverseOperationPageRef(input, pageRef) as OpensteerDomScrollInput, {
          signal: timeout.signal,
        });
      case "interaction.replay":
        return this.replayInteraction(
          withReverseOperationPageRef(input, pageRef) as OpensteerInteractionReplayInput,
          {
            signal: timeout.signal,
          },
        );
      case "request.raw":
        return this.rawRequest(input as OpensteerRawRequestInput, {
          signal: timeout.signal,
        });
      default:
        throw new OpensteerProtocolError(
          "invalid-argument",
          `reverse package operation ${step.operation} is not supported by the workflow runner`,
        );
    }
  }

  private async resolveReversePackageResolverValues(
    packageRecord: ReversePackageRecord,
    bindings: ReadonlyMap<string, unknown>,
    pageRef: PageRef,
    timeout: TimeoutExecutionContext,
  ): Promise<ReadonlyMap<string, unknown>> {
    const values = new Map<string, unknown>();
    for (const resolver of packageRecord.payload.resolvers) {
      const value = await this.resolveReversePackageResolverValue(
        resolver,
        bindings,
        packageRecord.payload.stateSnapshots,
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
    bindings: ReadonlyMap<string, unknown>,
    stateSnapshots: readonly OpensteerStateSnapshot[],
    pageRef: PageRef,
    timeout: TimeoutExecutionContext,
  ): Promise<unknown> {
    if (resolver.value !== undefined) {
      return resolver.value;
    }

    if (resolver.binding !== undefined) {
      const boundValue = bindings.get(resolver.binding);
      return extractReverseRuntimeValue(boundValue, resolver.pointer);
    }

    switch (resolver.kind) {
      case "literal":
      case "manual":
      case "runtime-managed":
        return undefined;
      case "cookie":
        return resolveReverseCookieResolverValue(stateSnapshots, resolver);
      case "storage":
        return resolveReverseStorageResolverValue(stateSnapshots, resolver);
      case "prior-response":
        if (resolver.sourceRecordId === undefined) {
          return undefined;
        }
        return extractReverseRuntimeValue(
          await this.resolveNetworkRecordByRecordId(resolver.sourceRecordId, timeout, {
            includeBodies: true,
            redactSecretHeaders: false,
          }),
          resolver.pointer,
        );
      case "guard-output":
        if (resolver.traceId !== undefined) {
          return extractReverseRuntimeValue(
            await this.resolveInteractionTraceById(resolver.traceId),
            resolver.pointer,
          );
        }
        return undefined;
      case "page-eval":
        if (
          resolver.expression === undefined ||
          !looksLikeExecutablePageResolverExpression(resolver.expression)
        ) {
          return undefined;
        }
        return (
          await this.evaluate(
            {
              pageRef,
              script: PAGE_EVAL_RESOLVER_SCRIPT,
              args: [
                {
                  expression: resolver.expression,
                },
              ],
            },
            { signal: timeout.signal },
          )
        ).value;
      case "script-sandbox":
        return undefined;
    }
  }

  private async buildReverseTransportOperationInput(
    candidate: OpensteerReverseCandidateRecord,
    strategy: OpensteerReplayStrategy,
    timeout: TimeoutExecutionContext,
  ): Promise<OpensteerRawRequestInput> {
    if (strategy.transport === undefined) {
      throw new OpensteerProtocolError(
        "invalid-argument",
        `reverse strategy ${strategy.id} is missing a transport`,
      );
    }
    const record = await this.resolveNetworkRecordByRecordId(candidate.recordId, timeout, {
      includeBodies: true,
      redactSecretHeaders: false,
    });
    const headers = stripManagedRequestHeaders(record.record.requestHeaders, strategy.transport);
    const body = toReverseRawRequestBodyInput(
      record.record.requestBody,
      record.record.requestHeaders,
    );
    return {
      transport: strategy.transport,
      url: record.record.url,
      method: record.record.method,
      ...(headers === undefined ? {} : { headers }),
      ...(body === undefined ? {} : { body }),
    };
  }

  private async writePortableReverseRequestPlan(
    caseRecord: ReverseCaseRecord,
    candidate: OpensteerReverseCandidateRecord,
    strategy: OpensteerReverseCandidateRecord["replayStrategies"][number],
    timeout: TimeoutExecutionContext,
    input: {
      readonly key: string;
      readonly version: string;
      readonly provenanceSource: "reverse.solve" | "reverse.export";
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
      lifecycle: "draft",
    });
    const defaultHeaders =
      inferred.payload.endpoint.defaultHeaders === undefined
        ? undefined
        : stripManagedRequestHeaders(
            inferred.payload.endpoint.defaultHeaders,
            strategy.transport ?? "direct-http",
          );
    const payload = normalizeRequestPlanPayload({
      ...inferred.payload,
      transport: {
        kind: strategy.transport ?? "direct-http",
        ...(strategy.transport === "page-http" ? { requireSameOrigin: false } : {}),
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
      ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
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
        sourceId: candidate?.id ?? input.caseRecord.id,
      },
      payload: {
        kind: input.kind,
        readiness: input.readiness,
        caseId: input.caseRecord.id,
        objective: input.caseRecord.payload.objective,
        ...(candidate === undefined ? {} : { candidateId: candidate.id }),
        ...(candidate === undefined ? {} : { candidate }),
        ...(input.strategy === undefined ? {} : { strategyId: input.strategy.id }),
        ...(input.strategy === undefined ? {} : { strategy: input.strategy }),
        ...(candidate === undefined ? {} : { channel: candidate.channel }),
        ...(input.strategy === undefined
          ? { stateSource: input.caseRecord.payload.stateSource }
          : { stateSource: input.strategy.stateSource }),
        ...(candidate === undefined ? {} : { observationId: candidate.observationId }),
        ...(input.strategy?.transport === undefined ? {} : { transport: input.strategy.transport }),
        guardIds: input.strategy?.guardIds ?? candidate?.guardIds ?? ([] as readonly string[]),
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
      readonly strategy?: OpensteerReplayStrategy;
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
    const strategy = input.strategy;
    const observation =
      candidate === undefined
        ? undefined
        : input.caseRecord.payload.observations.find(
            (entry) => entry.id === candidate.observationId,
          );
    const guards =
      strategy === undefined
        ? []
        : input.caseRecord.payload.guards.filter((guard) => strategy.guardIds.includes(guard.id));
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
      candidate === undefined || strategy === undefined || strategy.execution === "page-observation"
        ? undefined
        : await this.buildReverseTransportOperationInput(candidate, strategy, timeout);
    const executeStepValue =
      executeStepInput === undefined ? undefined : toCanonicalJsonValue(executeStepInput);
    const workflow =
      input.workflow ??
      buildReversePackageWorkflow({
        ...(candidate === undefined ? {} : { candidate }),
        ...(strategy === undefined ? {} : { strategy }),
        ...(observation === undefined ? {} : { observation }),
        guards,
        validators: input.validators,
        ...(executeStepValue === undefined ? {} : { executeStepInput: executeStepValue }),
      });
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
      ...resolvers.flatMap((resolver) =>
        resolver.artifactId === undefined && resolver.scriptArtifactId === undefined
          ? []
          : [resolver.artifactId ?? resolver.scriptArtifactId!],
      ),
      ...(input.attachedArtifactIds ?? []),
    ]);
    const attachedRecordIds = dedupeStringList([
      ...(observation?.networkRecordIds ?? []),
      ...(candidate === undefined ? [] : [candidate.recordId]),
      ...(input.attachedRecordIds ?? []),
    ]);
    const kind = deriveReversePackageKind({
      ...(candidate === undefined ? {} : { candidate }),
      ...(strategy === undefined ? {} : { strategy }),
    });
    const unresolvedRequirements = deriveReversePackageUnresolvedRequirements({
      ...(candidate === undefined ? {} : { candidate }),
      ...(strategy === undefined ? {} : { strategy }),
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
    readonly caseRecord: ReverseCaseRecord;
    readonly packageRecord: ReversePackageRecord;
    readonly chosenCandidate?: OpensteerReverseCandidateRecord;
    readonly chosenStrategy?: OpensteerReplayStrategy;
  }): Promise<ReverseReportRecord> {
    const root = await this.ensureRoot();
    return root.registry.reverseReports.write({
      key: `${input.caseRecord.key}:report:${Date.now()}`,
      version: "1.0.0",
      tags: input.caseRecord.tags,
      provenance: {
        source: "reverse.solve",
        sourceId: input.packageRecord.id,
      },
      payload: {
        caseId: input.caseRecord.id,
        objective: input.caseRecord.payload.objective,
        packageId: input.packageRecord.id,
        packageKind: input.packageRecord.payload.kind,
        packageReadiness: input.packageRecord.payload.readiness,
        ...(input.chosenCandidate === undefined
          ? {}
          : { chosenCandidateId: input.chosenCandidate.id }),
        ...(input.chosenStrategy === undefined
          ? {}
          : { chosenStrategyId: input.chosenStrategy.id }),
        observations: input.caseRecord.payload.observations,
        observationClusters: input.caseRecord.payload.observationClusters,
        guards: input.caseRecord.payload.guards,
        stateDeltas: input.caseRecord.payload.stateDeltas,
        candidateRankings: input.caseRecord.payload.candidates.map((candidate) => ({
          candidateId: candidate.id,
          clusterId: candidate.clusterId,
          score: candidate.score,
          role: candidate.role,
          dependencyClass: candidate.dependencyClass,
          bodyCodec: candidate.bodyCodec,
          summary: candidate.summary,
          reasons: buildReverseCandidateRankingReasons(candidate),
        })),
        experiments: input.caseRecord.payload.experiments,
        replayRuns: input.caseRecord.payload.replayRuns,
        unresolvedRequirements: input.packageRecord.payload.unresolvedRequirements,
        suggestedEdits: input.packageRecord.payload.suggestedEdits,
        linkedNetworkRecordIds: input.packageRecord.payload.attachedRecordIds,
        linkedInteractionTraceIds: input.packageRecord.payload.attachedTraceIds,
        linkedArtifactIds: input.packageRecord.payload.attachedArtifactIds,
        linkedStateSnapshotIds: input.packageRecord.payload.stateSnapshots.map((entry) => entry.id),
        package: input.packageRecord,
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
          await root.registry.savedNetwork.save(deltaRecords, `interaction:${pageRef}`);
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
            ...(this.networkJournal.getObservedAt(source.recordId) === undefined
              ? {}
              : { observedAt: this.networkJournal.getObservedAt(source.recordId)! }),
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
          lifecycle: record.lifecycle,
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
          lifecycle: record.lifecycle,
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
          lifecycle: record.lifecycle,
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
    return this.writeAuthRecipe(input, options);
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
    return this.getAuthRecipe(input, options);
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
    return this.listAuthRecipes(input, options);
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
        async (timeout) => this.runResolvedAuthRecipe(input, timeout),
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
    return this.runAuthRecipe(input, options);
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

    try {
      const { artifacts, output } = await this.runWithOperationTimeout(
        "computer.execute",
        async (timeout) => {
          const baselineRequestIds = await this.beginMutationCapture(timeout);
          try {
            const output = await this.requireComputer().execute({
              pageRef,
              input,
              timeout,
            });
            timeout.throwIfAborted();
            this.pageRef = output.pageRef;
            this.latestSnapshot = undefined;
            await this.completeMutationCapture(timeout, baselineRequestIds, input.networkTag);
            const artifacts = await this.persistComputerArtifacts(output, timeout);
            return {
              artifacts: { manifests: artifacts.manifests },
              output: artifacts.output,
            };
          } catch (error) {
            await this.completeMutationCapture(timeout, baselineRequestIds, input.networkTag).catch(
              () => undefined,
            );
            throw error;
          }
        },
        options,
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
          await timeout.runStep(() => this.flushBackgroundNetworkPersistence());
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
    }

    if (closeError !== undefined) {
      throw closeError;
    }

    return {
      closed: true,
    };
  }

  isOpen(): boolean {
    return this.sessionRef !== undefined && this.pageRef !== undefined;
  }

  private async runDomAction<
    TInput extends {
      readonly target: OpensteerTargetInput;
      readonly persistAsDescription?: string;
      readonly networkTag?: string;
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

    try {
      const { executed, preparedTarget } = await this.runWithOperationTimeout(
        operation,
        async (timeout) => {
          const baselineRequestIds = await this.beginMutationCapture(timeout);
          try {
            const preparedTarget = await this.prepareDomTarget(
              pageRef,
              operation,
              input.target,
              input.persistAsDescription,
              timeout,
            );
            const executed = await executor(pageRef, preparedTarget.target, timeout);
            await this.completeMutationCapture(timeout, baselineRequestIds, input.networkTag);
            return {
              executed,
              preparedTarget,
            };
          } catch (error) {
            await this.completeMutationCapture(timeout, baselineRequestIds, input.networkTag).catch(
              () => undefined,
            );
            throw error;
          }
        },
        options,
      );
      const output = toOpensteerActionResult(executed.result, preparedTarget.persistedDescription);

      await this.appendTrace({
        operation,
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          target: output.target,
          ...(output.point === undefined ? {} : { point: output.point }),
          ...(output.persistedDescription === undefined
            ? {}
            : { persistedDescription: output.persistedDescription }),
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
      const counter = this.latestSnapshot?.counterRecords.get(target.element);
      if (!counter) {
        throw new Error(`no counter ${String(target.element)} is available in the latest snapshot`);
      }

      const resolved = await timeout.runStep(() =>
        this.requireDom().resolveTarget({
          pageRef,
          method,
          target: {
            kind: "live",
            locator: counter.locator,
            anchor: counter.anchor,
          },
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
    const requestIds = resolveLiveQueryRequestIds(input, this.networkJournal);
    if (requestIds !== undefined && requestIds.length === 0) {
      return [];
    }

    const pageRef = resolveLiveQueryPageRef(input, this.pageRef, requestIds, this.networkJournal);
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
      ...(input.actionId === undefined ? {} : { actionId: input.actionId }),
      ...(input.tag === undefined ? {} : { tag: input.tag }),
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.hostname === undefined ? {} : { hostname: input.hostname }),
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.method === undefined ? {} : { method: input.method }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
    });
    const sorted = sortLiveNetworkRecords(filtered, this.networkJournal);
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
    root: FilesystemOpensteerRoot,
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

  private beginMutationCapture(timeout: TimeoutExecutionContext): Promise<ReadonlySet<string>> {
    return this.readLiveRequestIds(timeout, {
      includeCurrentPageOnly: true,
    });
  }

  private async completeMutationCapture(
    timeout: TimeoutExecutionContext,
    baselineRequestIds: ReadonlySet<string>,
    networkTag: string | undefined,
  ): Promise<void> {
    const records = await timeout.runStep(() =>
      this.readLiveNetworkRecords(
        {
          includeBodies: false,
          includeCurrentPageOnly: true,
        },
        timeout.signal,
      ),
    );
    const delta = records.filter((record) => !baselineRequestIds.has(record.record.requestId));
    if (delta.length === 0) {
      return;
    }

    this.networkJournal.assignActionId(delta, `action:${randomUUID()}`);
    if (networkTag === undefined) {
      return;
    }

    this.networkJournal.addTag(delta, networkTag);
    this.scheduleBackgroundNetworkSaveByRequestIds(
      delta.map((record) => record.record.requestId),
      networkTag,
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
    const live = await this.queryLiveNetwork(
      {
        source: "live",
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
    if (live.length > 0) {
      return live[0]!;
    }

    await timeout.runStep(() => this.flushBackgroundNetworkPersistence());
    const saved = await timeout.runStep(() =>
      root.registry.savedNetwork.getByRecordId(recordId, {
        includeBodies: options.includeBodies,
      }),
    );
    if (!saved) {
      throw new OpensteerProtocolError("not-found", `network record ${recordId} was not found`, {
        details: {
          recordId,
          kind: "network-record",
        },
      });
    }
    return saved;
  }

  private resolveCurrentStateSource(): OpensteerStateSourceKind {
    const browser = this.configuredBrowser;
    if (browser === undefined || browser.kind === undefined || browser.kind === "managed") {
      return "managed";
    }
    return browser.kind;
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
    const report = reports.find((entry) => entry.payload.packageId === packageId);
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
          source: "live",
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
    const sessionRef = this.sessionRef;
    if (!sessionRef) {
      throw new Error("Opensteer session is not initialized");
    }

    const records = await this.requireEngine().getNetworkRecords({
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
    return this.networkJournal.sync(records, {
      redactSecretHeaders: input.redactSecretHeaders ?? true,
    });
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
    return sortLiveNetworkRecords(delta, this.networkJournal)[0]?.recordId;
  }

  private async executeTransportRequestWithJournal(
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: import("@opensteer/browser-core").BodyPayload;
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
      binding?.sessionRef ?? createSessionRef(`${transportLabel}-${this.name}`);
    const record: NetworkQueryRecord = {
      recordId,
      source: "saved",
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

    await root.registry.savedNetwork.save([record], tag);
    return recordId;
  }

  private async executeResolvedRequestPlan(
    plan: RequestPlanRecord,
    input: OpensteerRequestExecuteInput,
    timeout: TimeoutExecutionContext,
    binding: RuntimeBrowserBinding | undefined,
  ): Promise<OpensteerRequestExecuteOutput> {
    const prepareBinding = plan.payload.recipes?.prepare;
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
    await this.requireRoot().registry.requestPlans.updateMetadata({
      id: plan.id,
      ...(freshness === undefined ? {} : { freshness }),
    });
  }

  private async executeConfiguredRecipeBinding(
    binding: {
      readonly recipe: {
        readonly key: string;
        readonly version?: string;
      };
      readonly cachePolicy?: "none" | "untilFailure";
    },
    timeout: TimeoutExecutionContext,
  ): Promise<OpensteerRunRecipeOutput> {
    const cacheKey = `${binding.recipe.key}@${binding.recipe.version ?? "latest"}`;
    if (binding.cachePolicy === "untilFailure") {
      const cached = this.recipeCache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }

    const output = await this.executeAuthRecipeRecord(
      await this.resolveAuthRecipe(binding.recipe.key, binding.recipe.version),
      timeout,
      {},
    );
    if (binding.cachePolicy === "untilFailure") {
      this.recipeCache.set(cacheKey, output);
    }
    return output;
  }

  private clearRecipeBindingCache(binding: {
    readonly recipe: {
      readonly key: string;
      readonly version?: string;
    };
  }): void {
    const cacheKey = `${binding.recipe.key}@${binding.recipe.version ?? "latest"}`;
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

  private async resolveAuthRecipe(
    key: string,
    version: string | undefined,
  ): Promise<AuthRecipeRecord> {
    const recipe = await this.requireRoot().registry.authRecipes.resolve({
      key,
      ...(version === undefined ? {} : { version }),
    });
    if (recipe === undefined) {
      throw new OpensteerProtocolError(
        "not-found",
        version === undefined
          ? `auth recipe ${key} was not found`
          : `auth recipe ${key}@${version} was not found`,
        {
          details: {
            key,
            ...(version === undefined ? {} : { version }),
            kind: "auth-recipe",
          },
        },
      );
    }
    return recipe;
  }

  private async runResolvedAuthRecipe(
    input: OpensteerRunAuthRecipeInput,
    timeout: TimeoutExecutionContext,
  ): Promise<OpensteerRunAuthRecipeOutput> {
    const recipe = await this.resolveAuthRecipe(input.key, input.version);
    return this.executeAuthRecipeRecord(recipe, timeout, input.variables ?? {});
  }

  private async executeAuthRecipeRecord(
    recipe: AuthRecipeRecord,
    timeout: TimeoutExecutionContext,
    initialVariables: Readonly<Record<string, string>>,
  ): Promise<OpensteerRunAuthRecipeOutput> {
    const variables = new Map<string, string>(Object.entries(initialVariables));
    let overrides: OpensteerAuthRecipeRetryOverrides | undefined;

    for (const [index, step] of recipe.payload.steps.entries()) {
      const stepResult = await this.executeAuthRecipeStep(step, variables, timeout);
      mergeVariables(variables, stepResult.variables);
      overrides = mergeAuthRecipeOverrides(overrides, stepResult.overrides);

      await this.appendTrace({
        operation: "auth-recipe.step",
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

  private async executeAuthRecipeStep(
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
              source: "live",
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

  private scheduleBackgroundNetworkSaveByRequestIds(
    requestIds: readonly string[],
    tag: string,
  ): void {
    const task = (async () => {
      const root = await this.ensureRoot();
      const requestIdSet = new Set(requestIds);
      const records = await this.readLiveNetworkRecords(
        {
          includeBodies: true,
          includeCurrentPageOnly: false,
          ...(this.pageRef === undefined ? {} : { pageRef: this.pageRef }),
          requestIds,
          redactSecretHeaders: false,
        },
        new AbortController().signal,
      );
      const filtered = records.filter((record) => requestIdSet.has(record.record.requestId));
      if (filtered.length === 0) {
        return;
      }
      await root.registry.savedNetwork.save(filtered, tag);
    })();
    this.backgroundNetworkPersistence.add(task);
    task.finally(() => {
      this.backgroundNetworkPersistence.delete(task);
    });
    void task.catch(() => undefined);
  }

  private async flushBackgroundNetworkPersistence(): Promise<void> {
    if (this.backgroundNetworkPersistence.size === 0) {
      return;
    }
    await Promise.all([...this.backgroundNetworkPersistence]);
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

    const counter = this.latestSnapshot?.counterRecords.get(target.element);
    if (!counter) {
      throw new Error(`no counter ${String(target.element)} is available in the latest snapshot`);
    }

    return {
      kind: "live",
      locator: counter.locator,
      anchor: counter.anchor,
    };
  }

  private async ensureRoot(): Promise<FilesystemOpensteerRoot> {
    this.root ??= await createFilesystemOpensteerRoot({
      rootPath: this.rootPath,
    });
    return this.root;
  }

  private async ensureEngine(
    overrides: OpensteerEngineFactoryOptions = {},
  ): Promise<DisposableBrowserCoreEngine> {
    if (this.engine) {
      return this.engine;
    }

    if (this.injectedEngine) {
      this.engine = this.injectedEngine as DisposableBrowserCoreEngine;
      this.ownsEngine = false;
      return this.engine;
    }

    const browser = overrides.browser ?? this.configuredBrowser;
    const context = normalizeOpensteerBrowserContextOptions(
      overrides.context ?? this.configuredContext,
    );
    const factoryOptions: OpensteerEngineFactoryOptions = {
      ...(browser === undefined ? {} : { browser }),
      ...(context === undefined ? {} : { context }),
    };
    this.engine = (await this.engineFactory(factoryOptions)) as DisposableBrowserCoreEngine;
    this.ownsEngine = true;
    return this.engine;
  }

  private async ensureSemantics(): Promise<void> {
    const root = await this.ensureRoot();
    const engine = await this.ensureEngine();
    this.dom = createDomRuntime({
      engine,
      root,
      namespace: this.name,
      policy: this.policy,
    });
    this.computer = createComputerUseRuntime({
      engine,
      dom: this.dom,
      policy: this.policy,
    });
    this.extractionDescriptors = createOpensteerExtractionDescriptorStore({
      root,
      namespace: this.name,
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

  private requireRoot(): FilesystemOpensteerRoot {
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

  private async readSessionState(): Promise<OpensteerSessionOpenOutput> {
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

    await root.traces.append(runId, {
      operation: input.operation,
      outcome: input.outcome,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      ...(input.context === undefined ? {} : { context: input.context }),
      ...(input.events === undefined ? {} : { events: input.events }),
      ...(artifacts === undefined ? {} : { artifacts }),
      ...(input.data === undefined ? {} : { data: toCanonicalJsonValue(input.data) }),
      ...(input.error === undefined
        ? {}
        : {
            error: normalizeOpensteerError(input.error),
          }),
    });
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

    this.networkJournal.clear();
    this.backgroundNetworkPersistence.clear();
    this.sessionRef = undefined;
    this.pageRef = undefined;
    this.latestSnapshot = undefined;
    this.runId = undefined;
    this.dom = undefined;
    this.computer = undefined;
    this.extractionDescriptors = undefined;
    this.engine = undefined;

    if (options.disposeEngine && this.ownsEngine && engine?.dispose) {
      await engine.dispose();
    }
    this.ownsEngine = false;
  }

  private runWithOperationTimeout<T>(
    operation: OpensteerSemanticOperationName,
    callback: (context: TimeoutExecutionContext) => Promise<T>,
    options: RuntimeOperationOptions = {},
  ): Promise<T> {
    return runWithPolicyTimeout(
      this.policy.timeout,
      {
        operation,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      callback,
    );
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
  input: Pick<OpensteerNetworkQueryInput, "recordId" | "requestId" | "actionId" | "tag">,
  journal: NetworkJournal,
): readonly string[] | undefined {
  const requestIdCandidates: ReadonlySet<string>[] = [];

  if (input.recordId !== undefined) {
    const requestId = journal.getRequestId(input.recordId);
    if (requestId === undefined) {
      return [];
    }
    requestIdCandidates.push(new Set([requestId]));
  }

  if (input.requestId !== undefined) {
    requestIdCandidates.push(new Set([input.requestId]));
  }

  if (input.actionId !== undefined) {
    requestIdCandidates.push(journal.getRequestIdsForActionId(input.actionId));
  }

  if (input.tag !== undefined) {
    requestIdCandidates.push(journal.getRequestIdsForTag(input.tag));
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
  journal: NetworkJournal,
): PageRef | undefined {
  const requestedPageRef = selectLiveQueryPageRef(input, currentPageRef);
  if (requestedPageRef !== undefined || requestIds === undefined) {
    return requestedPageRef;
  }

  const pageRefs = new Set<PageRef>();
  for (const requestId of requestIds) {
    const pageRef = journal.getPageRefForRequestId(requestId);
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
    readonly actionId?: string;
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
    if (input.actionId !== undefined && record.actionId !== input.actionId) {
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
  journal: NetworkJournal,
): NetworkQueryRecord[] {
  return [...records].sort((left, right) => {
    const leftObservedAt = journal.getObservedAt(left.recordId) ?? 0;
    const rightObservedAt = journal.getObservedAt(right.recordId) ?? 0;
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
      ...(input.record.source === "saved" && input.record.savedAt !== undefined
        ? { capturedAt: input.record.savedAt }
        : {}),
    },
    lifecycle: "draft",
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
    if (resolver.stateSnapshotId !== undefined) {
      snapshotIds.add(resolver.stateSnapshotId);
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
  journal: NetworkJournal,
  captureWindowMs: number | undefined,
): readonly NetworkQueryRecord[] {
  if (captureWindowMs === undefined) {
    return records;
  }
  const observedAfter = Date.now() - captureWindowMs;
  return records.filter((record) => (journal.getObservedAt(record.recordId) ?? 0) >= observedAfter);
}

function isReverseRelevantNetworkRecord(record: NetworkQueryRecord): boolean {
  return (
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

function dedupeStringList(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function buildReverseCandidateRankingReasons(
  candidate: OpensteerReverseCandidateRecord,
): readonly string[] {
  const reasons = [
    candidate.summary,
    `${candidate.role} ${candidate.boundary} candidate scored ${candidate.score}`,
    `${candidate.dependencyClass} dependency class`,
    `${candidate.bodyCodec.kind} body codec`,
  ];
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

function normalizeReversePackageOperationInput(
  input: unknown,
  bindings: ReadonlyMap<string, unknown>,
  resolverValues: ReadonlyMap<string, unknown>,
): unknown {
  const normalized = resolveReversePackageReference(input, bindings, resolverValues);
  if (Array.isArray(normalized)) {
    return normalized.map((entry) =>
      normalizeReversePackageOperationInput(entry, bindings, resolverValues),
    );
  }
  if (normalized === null || typeof normalized !== "object") {
    return normalized;
  }
  const next = Object.fromEntries(
    Object.entries(normalized).map(([key, value]) => [
      key,
      normalizeReversePackageOperationInput(value, bindings, resolverValues),
    ]),
  );
  return next;
}

function resolveReversePackageReference(
  value: unknown,
  bindings: ReadonlyMap<string, unknown>,
  resolverValues: ReadonlyMap<string, unknown>,
): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const bindingName =
    typeof (value as { readonly $binding?: unknown }).$binding === "string"
      ? (value as { readonly $binding: string }).$binding
      : undefined;
  const resolverId =
    typeof (value as { readonly $resolver?: unknown }).$resolver === "string"
      ? (value as { readonly $resolver: string }).$resolver
      : undefined;
  const pointer =
    typeof (value as { readonly pointer?: unknown }).pointer === "string"
      ? (value as { readonly pointer: string }).pointer
      : undefined;
  if (bindingName !== undefined) {
    return extractReverseRuntimeValue(bindings.get(bindingName), pointer);
  }
  if (resolverId !== undefined) {
    return extractReverseRuntimeValue(resolverValues.get(resolverId), pointer);
  }
  return value;
}

function withReverseOperationPageRef(value: unknown, pageRef: PageRef): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  if ("pageRef" in value) {
    return value;
  }
  return {
    ...(value as Record<string, unknown>),
    pageRef,
  };
}

function looksLikeExecutablePageResolverExpression(expression: string): boolean {
  const normalized = expression.trim();
  return (
    normalized.startsWith("window.") ||
    normalized.startsWith("document.") ||
    normalized.startsWith("globalThis.") ||
    normalized.startsWith("location.") ||
    normalized.startsWith("navigator.") ||
    normalized.startsWith("(") ||
    normalized.startsWith("[") ||
    normalized.startsWith("{") ||
    normalized.startsWith("function") ||
    normalized.includes("=>")
  );
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

function resolveReverseCookieResolverValue(
  snapshots: readonly OpensteerStateSnapshot[],
  resolver: OpensteerExecutableResolver,
): string | undefined {
  const cookieName = resolver.inputNames?.[0];
  if (cookieName === undefined) {
    return undefined;
  }
  for (const snapshot of [...snapshots].sort((left, right) => right.capturedAt - left.capturedAt)) {
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
  const storageView = {
    origins: snapshots.flatMap((snapshot) => snapshot.storage?.origins ?? []),
    sessionStorage: snapshots.flatMap((snapshot) => snapshot.storage?.sessionStorage ?? []),
    hiddenFields: snapshots.flatMap((snapshot) => snapshot.hiddenFields ?? []),
    globals: snapshots
      .map((snapshot) => snapshot.globals)
      .filter((value): value is Record<string, unknown> => value !== undefined),
  };
  if (resolver.pointer !== undefined) {
    return extractReverseRuntimeValue(storageView, resolver.pointer);
  }
  const inputName = resolver.inputNames?.[0];
  if (inputName === undefined) {
    return undefined;
  }
  for (const snapshot of [...snapshots].sort((left, right) => right.capturedAt - left.capturedAt)) {
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

function evaluateReversePackageAssertion(
  boundValue: unknown,
  channelKind: OpensteerReverseCandidateRecord["channel"]["kind"],
  validators: readonly OpensteerValidationRule[],
  fallbackRecordId?: string,
  fallbackStatus?: number,
): {
  readonly success: boolean;
  readonly recordId?: string;
  readonly status?: number;
  readonly validation: OpensteerReverseReplayOutput["validation"];
  readonly error?: string;
} {
  if (isNetworkQueryRecordValue(boundValue)) {
    switch (channelKind) {
      case "http": {
        const evaluation = evaluateValidationRulesForObservedRecord(boundValue, validators);
        return {
          ...evaluation,
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
          recordId: boundValue.recordId,
          status: boundValue.response.status,
        };
      }
      case "websocket":
        return {
          success: false,
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
      ...(fallbackRecordId === undefined ? {} : { recordId: fallbackRecordId }),
      ...(fallbackStatus === undefined ? {} : { status: fallbackStatus }),
    };
  }

  return {
    success: false,
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

function resolveRecoverRecipeBinding(
  plan: RequestPlanRecord,
): NonNullable<RequestPlanRecord["payload"]["recipes"]>["recover"] | undefined {
  if (plan.payload.recipes?.recover !== undefined) {
    return plan.payload.recipes.recover;
  }
  if (plan.payload.auth?.recipe !== undefined && plan.payload.auth.failurePolicy !== undefined) {
    return {
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

function isIgnorableRuntimeBindingError(error: unknown): boolean {
  return (
    isBrowserCoreError(error) &&
    (error.code === "not-found" || error.code === "page-closed" || error.code === "session-closed")
  );
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
