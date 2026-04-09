import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

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
  opensteerExposedSemanticOperationNames,
  type BodyPayload as ProtocolBodyPayload,
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
  type OpensteerNetworkQueryInput,
  type OpensteerNetworkQueryOutput,
  type OpensteerNetworkDetailOutput,
  type OpensteerNetworkReplayInput,
  type OpensteerNetworkReplayOutput,
  type OpensteerNetworkRedirectHop,
  type OpensteerCookieQueryInput,
  type OpensteerCookieQueryOutput,
  type OpensteerStorageQueryInput,
  type OpensteerStorageQueryOutput,
  type OpensteerStateQueryInput,
  type OpensteerStateQueryOutput,
  type OpensteerSessionFetchInput,
  type OpensteerSessionFetchOutput,
  type OpensteerNetworkSummaryRecord,
  type OpensteerReplayAttempt,
  type OpensteerStorageDomainSnapshot,
  type OpensteerStateDomainSnapshot,
  type OpensteerHiddenField,
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
  type OpensteerRawRequestOutput,
  type OpensteerRequestBodyInput,
  type OpensteerRequestTransportResult,
  type OpensteerRequestResponseResult,
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
  type OpensteerInteractionCaptureInput,
  type OpensteerInteractionCaptureOutput,
  type OpensteerInteractionCaptureStep,
  type OpensteerInteractionDiffInput,
  type OpensteerInteractionDiffOutput,
  type OpensteerInteractionGetInput,
  type OpensteerInteractionGetOutput,
  type OpensteerInteractionReplayInput,
  type OpensteerInteractionReplayOutput,
  type OpensteerStateDelta,
  type OpensteerStateSnapshot,
  type OpensteerEvent,
  type AppendObservationEventInput,
  type ObservationSink,
  type ObservationContext,
  type ObservabilityConfig,
  type SessionObservationSink,
  type StorageSnapshot,
  type TraceContext,
  type TransportKind,
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
import {
  filterValidHttpHeaders,
  headerValue,
  parseStructuredResponseData,
  toProtocolBodyPayload,
  toProtocolRequestResponseResult,
  toProtocolRequestTransportResult,
} from "../requests/shared.js";
import { finalizeMaterializedTransportRequest } from "../reverse/materialization.js";
import { NetworkHistory } from "../network/history.js";
import type { SavedNetworkQueryInput } from "../network/saved-store.js";
import { executeMatchedTlsTransportRequest as executeMatchedTlsTransportRequestWithCurl } from "../requests/execution/matched-tls/index.js";
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
import { clearOpensteerLiveCounters, compileOpensteerSnapshot } from "./snapshot/compiler.js";
import type { InteractionTraceRecord } from "../registry.js";
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
        semanticOperations: opensteerExposedSemanticOperationNames,
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
          ...(input.button === undefined ? {} : { button: input.button }),
          ...(input.clickCount === undefined ? {} : { clickCount: input.clickCount }),
          ...(input.modifiers === undefined ? {} : { modifiers: input.modifiers }),
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
            const persist = input.persist;
            if (persist !== undefined) {
              const descriptors = this.requireExtractionDescriptors();
              descriptor = await timeout.runStep(() =>
                descriptors.write({
                  persist,
                  root: payload,
                  schemaHash: canonicalJsonString(input.schema),
                  sourceUrl: pageInfo.url,
                }),
              );
            }
          } else {
            const persist = input.persist!;
            const descriptors = this.requireExtractionDescriptors();
            const storedDescriptor = await timeout.runStep(() =>
              descriptors.read({
                persist,
              }),
            );
            if (!storedDescriptor) {
              throw new OpensteerProtocolError(
                "not-found",
                `no stored extraction descriptor found for "${persist}"`,
                {
                  details: {
                    persist,
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
          ...(input.persist === undefined ? {} : { persist: input.persist }),
          ...(descriptor?.payload.schemaHash === undefined
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
            includeBodies: false,
          });
          const rawRecords = await timeout.runStep(() =>
            root.registry.savedNetwork.query({
              ...this.toSavedNetworkQueryInput(input),
              limit: Math.max(input.limit ?? 50, 1000),
            }),
          );
          const filtered = filterNetworkSummaryRecords(rawRecords, input);
          const sorted = sortPersistedNetworkRecordsChronologically(filtered);
          const sliced = sliceNetworkSummaryWindow(sorted, input);
          const limited = sliced.slice(0, Math.max(1, Math.min(input.limit ?? 50, 200)));
          const summaries = await this.buildNetworkSummaryRecords(limited, timeout);
          return {
            records: summaries,
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
          limit: input.limit ?? 50,
          ...(input.capture === undefined ? {} : { capture: input.capture }),
          ...(input.json === true ? { json: true } : {}),
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

  async getNetworkDetail(
    input: {
      readonly recordId: string;
      readonly probe?: boolean;
    },
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerNetworkDetailOutput> {
    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "network.detail",
        async (timeout) => {
          const record = await this.resolveNetworkRecordByRecordId(input.recordId, timeout, {
            includeBodies: true,
            redactSecretHeaders: false,
          });
          const detail = await this.buildNetworkDetail(record, timeout);
          if (input.probe !== true) {
            return detail;
          }
          const transportProbe = await this.probeTransportsForRecord(record, timeout);
          return transportProbe === undefined ? detail : { ...detail, transportProbe };
        },
        options,
      );

      await this.appendTrace({
        operation: "network.detail",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          recordId: input.recordId,
          status: output.summary.status,
          url: output.summary.url,
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });
      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "network.detail",
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

  async getCookies(
    input: OpensteerCookieQueryInput = {},
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerCookieQueryOutput> {
    assertValidSemanticOperationInput("session.cookies", input);

    const pageRef = await this.ensurePageRef();
    const sessionRef = this.requireSessionRef();
    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "session.cookies",
        async (timeout) => this.readCookieQueryOutput(sessionRef, pageRef, input.domain, timeout),
        options,
      );

      await this.appendTrace({
        operation: "session.cookies",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          count: output.cookies.length,
          ...(input.domain === undefined ? {} : { domain: input.domain }),
        },
        context: buildRuntimeTraceContext({
          sessionRef,
          pageRef,
        }),
      });

      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "session.cookies",
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
    input: OpensteerStorageQueryInput = {},
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerStorageQueryOutput> {
    assertValidSemanticOperationInput("session.storage", input);

    const pageRef = await this.ensurePageRef();
    const sessionRef = this.requireSessionRef();
    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "session.storage",
        async (timeout) => this.readStorageQueryOutput(sessionRef, pageRef, input.domain, timeout),
        options,
      );

      await this.appendTrace({
        operation: "session.storage",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          domains: output.domains.length,
          ...(input.domain === undefined ? {} : { domain: input.domain }),
        },
        context: buildRuntimeTraceContext({
          sessionRef,
          pageRef,
        }),
      });

      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "session.storage",
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

  async getBrowserState(
    input: OpensteerStateQueryInput = {},
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerStateQueryOutput> {
    assertValidSemanticOperationInput("session.state", input);

    const pageRef = await this.ensurePageRef();
    const sessionRef = this.requireSessionRef();
    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "session.state",
        async (timeout) => this.readBrowserStateOutput(sessionRef, pageRef, input.domain, timeout),
        options,
      );

      await this.appendTrace({
        operation: "session.state",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          domains: output.domains.length,
          ...(input.domain === undefined ? {} : { domain: input.domain }),
        },
        context: buildRuntimeTraceContext({
          sessionRef,
          pageRef,
        }),
      });

      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "session.state",
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

  async fetch(
    input: OpensteerSessionFetchInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerSessionFetchOutput> {
    assertValidSemanticOperationInput("session.fetch", input);

    const startedAt = Date.now();
    try {
      const output = await this.runWithOperationTimeout(
        "session.fetch",
        async (timeout) => {
          const request = buildSessionFetchTransportRequest(input);
          return this.executeSessionFetch(request, input, timeout);
        },
        options,
      );

      await this.appendTrace({
        operation: "session.fetch",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          ...(output.transport === undefined ? {} : { transport: output.transport }),
          attempts: output.attempts.length,
          ...(output.response === undefined ? {} : { status: output.response.status }),
          url: input.url,
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });

      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "session.fetch",
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
            await this.invalidateLiveSnapshotCounters([pageRef, output.pageRef], timeout);
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
      readonly persist?: string;
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
            input.persist,
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
      const output = toOpensteerActionResult(executed.result);
      const actionEvents = "events" in executed.result ? executed.result.events : undefined;

      await this.appendTrace({
        operation,
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        ...(actionEvents === undefined ? {} : { events: actionEvents }),
        data: {
          target: output.target,
          ...(output.point === undefined ? {} : { point: output.point }),
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
    persist: string | undefined,
    timeout: TimeoutExecutionContext,
  ): Promise<{
    readonly target: DomTargetRef;
  }> {
    const domTarget = this.toDomTargetRef(target);
    if (target.kind === "persist") {
      return {
        target: domTarget,
      };
    }

    if (persist === undefined) {
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
          persist,
          path: stablePath,
          sourceUrl: resolved.snapshot.url,
        }),
      );
      return {
        target: {
          kind: "descriptor",
          persist,
        },
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
        `unable to persist "${persist}" because no stable DOM path could be built for ${method}`,
      );
    }

    await timeout.runStep(() =>
      this.requireDom().writeDescriptor({
        method,
        persist,
        path: stablePath,
        sourceUrl: resolved.snapshot.url,
      }),
    );

    return {
      target: {
        kind: "descriptor",
        persist,
      },
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

  private async invalidateLiveSnapshotCounters(
    pageRefs: readonly PageRef[],
    timeout: TimeoutExecutionContext,
  ): Promise<void> {
    const engine = this.requireEngine();
    for (const pageRef of new Set(pageRefs)) {
      try {
        await timeout.runStep(() => clearOpensteerLiveCounters(engine, pageRef));
      } catch (error) {
        if (!isIgnorableRuntimeBindingError(error)) {
          throw error;
        }
      }
    }
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

  private async buildNetworkSummaryRecords(
    records: readonly NetworkQueryRecord[],
    timeout: TimeoutExecutionContext,
  ): Promise<readonly OpensteerNetworkSummaryRecord[]> {
    const summaries: OpensteerNetworkSummaryRecord[] = [];
    for (const record of records) {
      let hydrated = record;
      if (looksLikeGraphqlRecord(record)) {
        hydrated = await this.resolveNetworkRecordByRecordId(record.recordId, timeout, {
          includeBodies: true,
          redactSecretHeaders: false,
        }).catch(() => record);
      }
      summaries.push(buildNetworkSummaryRecord(hydrated));
    }
    return summaries;
  }

  private async buildNetworkDetail(
    record: NetworkQueryRecord,
    timeout: TimeoutExecutionContext,
  ): Promise<OpensteerNetworkDetailOutput> {
    const requestCookieHeader = headerValue(record.record.requestHeaders, "cookie");
    const graphql = extractGraphqlMetadata(record);
    const graphqlVariables =
      graphql?.variables === undefined ? undefined : truncateStructuredValue(graphql.variables);
    const graphqlSummary =
      graphql === undefined
        ? undefined
        : {
            ...(graphql.operationType === undefined
              ? {}
              : { operationType: graphql.operationType }),
            ...(graphql.operationName === undefined
              ? {}
              : { operationName: graphql.operationName }),
            ...(graphql.persisted === undefined ? {} : { persisted: graphql.persisted }),
            ...(graphqlVariables === undefined ? {} : { variables: graphqlVariables }),
          };
    const requestBody =
      shouldShowRequestBody(record.record.method) && record.record.requestBody !== undefined
        ? buildStructuredBodyPreview(record.record.requestBody, record.record.requestHeaders)
        : undefined;
    const responseBody =
      record.record.responseBody === undefined
        ? undefined
        : buildStructuredBodyPreview(record.record.responseBody, record.record.responseHeaders);
    const notes = detectNetworkRecordNotes(record);

    return {
      recordId: record.recordId,
      ...(record.capture === undefined ? {} : { capture: record.capture }),
      ...(record.savedAt === undefined ? {} : { savedAt: record.savedAt }),
      summary: buildNetworkSummaryRecord(record),
      requestHeaders: record.record.requestHeaders.filter(
        (header) => normalizeHeaderName(header.name) !== "cookie",
      ),
      responseHeaders: record.record.responseHeaders,
      ...(requestCookieHeader === undefined
        ? {}
        : { cookiesSent: parseCookieHeaderEntries(requestCookieHeader) }),
      ...(requestBody === undefined ? {} : { requestBody }),
      ...(responseBody === undefined ? {} : { responseBody }),
      ...(graphqlSummary === undefined ? {} : { graphql: graphqlSummary }),
      ...(await this.buildRedirectChain(record, timeout)),
      ...(notes.length === 0 ? {} : { notes }),
    };
  }

  private async probeTransportsForRecord(
    record: NetworkQueryRecord,
    timeout: TimeoutExecutionContext,
  ): Promise<
    | { readonly recommended?: TransportKind; readonly attempts: readonly OpensteerReplayAttempt[] }
    | undefined
  > {
    if (record.record.status === undefined) {
      return undefined;
    }
    const request = buildReplayTransportRequest(record, { recordId: record.recordId });
    const fingerprint = buildCapturedRecordSuccessFingerprint(record);
    const attempts: OpensteerReplayAttempt[] = [];
    let recommended: TransportKind | undefined;

    for (const transport of REPLAY_TRANSPORT_LADDER) {
      const attemptStartedAt = Date.now();
      try {
        const output = await this.executeReplayTransportAttempt(transport, request, timeout);
        const ok = matchesSuccessFingerprintFromProtocolResponse(output.response, fingerprint);
        attempts.push({
          transport,
          status: output.response.status,
          ok,
          durationMs: Date.now() - attemptStartedAt,
        });
        if (ok && recommended === undefined) {
          recommended = transport;
        }
      } catch (error) {
        attempts.push({
          transport,
          ok: false,
          durationMs: Date.now() - attemptStartedAt,
          error: normalizeRuntimeErrorMessage(error),
        });
      }
    }

    return {
      ...(recommended === undefined ? {} : { recommended }),
      attempts,
    };
  }

  private async buildRedirectChain(
    record: NetworkQueryRecord,
    timeout: TimeoutExecutionContext,
  ): Promise<{
    readonly redirectChain?: readonly OpensteerNetworkRedirectHop[];
  }> {
    if (
      record.record.redirectFromRequestId === undefined &&
      record.record.redirectToRequestId === undefined
    ) {
      return {};
    }

    const root = await this.ensureRoot();
    const byRequestId = new Map<string, NetworkQueryRecord>();
    const seen = new Set<string>();
    const queue = [record.record.requestId];
    while (queue.length > 0) {
      const requestId = queue.shift()!;
      if (seen.has(requestId)) {
        continue;
      }
      seen.add(requestId);
      const [match] = await timeout.runStep(() =>
        root.registry.savedNetwork.query({
          requestId,
          includeBodies: false,
          limit: 1,
        }),
      );
      if (match === undefined) {
        continue;
      }
      byRequestId.set(requestId, match);
      if (match.record.redirectFromRequestId !== undefined) {
        queue.push(match.record.redirectFromRequestId);
      }
      if (match.record.redirectToRequestId !== undefined) {
        queue.push(match.record.redirectToRequestId);
      }
    }

    const chain = [...byRequestId.values()].sort((left, right) => {
      const leftTime = left.savedAt ?? 0;
      const rightTime = right.savedAt ?? 0;
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      return left.recordId.localeCompare(right.recordId);
    });
    if (chain.length <= 1) {
      return {};
    }
    return {
      redirectChain: chain.map((entry) => ({
        method: entry.record.method,
        ...(entry.record.status === undefined ? {} : { status: entry.record.status }),
        url: entry.record.url,
        ...(headerValue(entry.record.responseHeaders, "location") === undefined
          ? {}
          : { location: headerValue(entry.record.responseHeaders, "location")! }),
        ...(collectSetCookieHeaders(entry.record.responseHeaders).length === 0
          ? {}
          : { setCookie: collectSetCookieHeaders(entry.record.responseHeaders) }),
      })),
    };
  }

  private async readCookieQueryOutput(
    sessionRef: SessionRef,
    pageRef: PageRef,
    domain: string | undefined,
    timeout: TimeoutExecutionContext,
  ): Promise<OpensteerCookieQueryOutput> {
    const pageInfo = await timeout.runStep(() => this.requireEngine().getPageInfo({ pageRef }));
    const effectiveDomain = domain ?? hostnameFromUrl(pageInfo.url);
    const cookies = await timeout.runStep(() =>
      this.requireEngine().getCookies({
        sessionRef,
      }),
    );
    const filtered = filterCookieRecordsByDomain(cookies, effectiveDomain);
    return {
      ...(effectiveDomain === undefined ? {} : { domain: effectiveDomain }),
      cookies: [...filtered].sort(compareCookieRecords),
    };
  }

  private async readStorageQueryOutput(
    sessionRef: SessionRef,
    pageRef: PageRef,
    domain: string | undefined,
    timeout: TimeoutExecutionContext,
  ): Promise<OpensteerStorageQueryOutput> {
    const pageInfo = await timeout.runStep(() => this.requireEngine().getPageInfo({ pageRef }));
    const effectiveDomain = domain ?? hostnameFromUrl(pageInfo.url);
    const snapshot = await timeout.runStep(() =>
      this.requireEngine().getStorageSnapshot({
        sessionRef,
        includeSessionStorage: true,
        includeIndexedDb: false,
      }),
    );
    return {
      domains: collapseStorageSnapshot(snapshot, effectiveDomain),
    };
  }

  private async readBrowserStateOutput(
    sessionRef: SessionRef,
    pageRef: PageRef,
    domain: string | undefined,
    timeout: TimeoutExecutionContext,
  ): Promise<OpensteerStateQueryOutput> {
    const pageInfo = await timeout.runStep(() => this.requireEngine().getPageInfo({ pageRef }));
    const effectiveDomain = domain ?? hostnameFromUrl(pageInfo.url);
    const cookies = await timeout.runStep(() =>
      this.requireEngine().getCookies({
        sessionRef,
      }),
    );
    const storage = await timeout.runStep(() =>
      this.requireEngine().getStorageSnapshot({
        sessionRef,
        includeSessionStorage: true,
        includeIndexedDb: false,
      }),
    );
    const pageState = await timeout.runStep(() =>
      this.requireEngine().evaluatePage({
        pageRef,
        script: CAPTURE_PAGE_STATE_SCRIPT,
        args: [
          {
            globalNames: DEFAULT_STATE_GLOBAL_NAMES,
          },
        ],
      }),
    );

    const currentPageDomain = hostnameFromUrl(pageInfo.url);
    return {
      domains: buildBrowserStateDomains({
        ...(effectiveDomain === undefined ? {} : { effectiveDomain }),
        ...(currentPageDomain === undefined ? {} : { currentPageDomain }),
        cookies,
        storage,
        pageState: pageState.data,
      }),
    };
  }

  private async executeSessionFetch(
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
      readonly followRedirects?: boolean;
    },
    input: OpensteerSessionFetchInput,
    timeout: TimeoutExecutionContext,
  ): Promise<OpensteerSessionFetchOutput> {
    const attempts: OpensteerReplayAttempt[] = [];
    let lastOutput: OpensteerRawRequestOutput | undefined;
    const ladder = resolveSessionFetchTransportLadder(input.transport);

    for (const transport of ladder) {
      const attemptStartedAt = Date.now();
      try {
        const output = await this.executeFetchTransportAttempt(transport, request, timeout, input);
        lastOutput = output;
        const note = detectChallengeNoteFromResponse(output.response);
        const ok = shouldAcceptFetchResponse(output.response, transport, note);
        attempts.push({
          transport,
          status: output.response.status,
          ok,
          durationMs: Date.now() - attemptStartedAt,
          ...(note === undefined ? {} : { note }),
        });
        if (ok) {
          const fallbackNote =
            attempts.length > 1 ? buildReplayFallbackNote(attempts, transport) : undefined;
          const previewData = toStructuredPreviewData(output.data);
          return {
            transport,
            attempts,
            response: output.response,
            ...(previewData === undefined ? {} : { data: previewData }),
            ...(fallbackNote === undefined ? {} : { note: fallbackNote }),
          };
        }
      } catch (error) {
        attempts.push({
          transport,
          ok: false,
          durationMs: Date.now() - attemptStartedAt,
          error: normalizeRuntimeErrorMessage(error),
        });
      }
    }

    const previewData = toStructuredPreviewData(lastOutput?.data);
    return {
      attempts,
      ...(lastOutput?.response === undefined ? {} : { response: lastOutput.response }),
      ...(previewData === undefined ? {} : { data: previewData }),
      note: "no transport completed successfully",
    };
  }

  private async executeReplayTransportAttempt(
    transport: TransportKind,
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
      readonly followRedirects?: boolean;
    },
    timeout: TimeoutExecutionContext,
    explicitPageRef?: PageRef,
  ): Promise<OpensteerRawRequestOutput> {
    const normalized = finalizeMaterializedTransportRequest(request, transport);
    switch (transport) {
      case "direct-http":
        return this.executeDirectTransportRequestWithPersistence(normalized, timeout);
      case "matched-tls":
        return this.executeMatchedTlsTransportRequestWithPersistence(
          normalized,
          timeout,
          this.currentBinding(),
        );
      case "context-http":
        return this.executeContextTransportRequestWithPersistence(
          normalized,
          timeout,
          this.currentBinding(),
        );
      case "page-http": {
        const binding = await this.resolvePageHttpBinding(
          normalized.url,
          explicitPageRef ?? this.currentBinding()?.pageRef,
          false,
        );
        return this.executePageHttpTransportRequestWithPersistence(normalized, timeout, binding);
      }
      case "session-http": {
        const binding = this.currentBinding() ?? (await this.ensureBrowserTransportBinding());
        return this.executeTransportRequestWithJournal(normalized, timeout, binding.sessionRef);
      }
    }
  }

  private async executeFetchTransportAttempt(
    transport: TransportKind,
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
      readonly followRedirects?: boolean;
    },
    timeout: TimeoutExecutionContext,
    input: OpensteerSessionFetchInput,
  ): Promise<OpensteerRawRequestOutput> {
    let prepared = finalizeMaterializedTransportRequest(request, transport);
    if (
      input.cookies !== false &&
      transport === "direct-http" &&
      this.currentBinding() !== undefined
    ) {
      const cookies = await this.requireEngine().getCookies({
        sessionRef: this.currentBinding()!.sessionRef,
        urls: [prepared.url],
      });
      prepared = applyBrowserCookiesToTransportRequest(prepared, cookies);
    }
    return this.executeReplayTransportAttempt(transport, prepared, timeout, input.pageRef);
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
      readonly status?: string | number;
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
      ...(input.status === undefined ? {} : { status: normalizeNetworkStatusFilter(input.status) }),
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
      readonly status?: string | number;
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
        "browser transport completed but no live network record was journaled for the request",
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

  private async executeDirectTransportRequestWithPersistence(
    request: {
      readonly method: string;
      readonly url: string;
      readonly headers?: readonly HeaderEntry[];
      readonly body?: BrowserBodyPayload;
      readonly followRedirects?: boolean;
    },
    timeout: TimeoutExecutionContext,
  ): Promise<OpensteerRawRequestOutput> {
    const response = await timeout.runStep(() =>
      executeDirectTransportRequest(request, timeout.signal),
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
  ): Promise<OpensteerRawRequestOutput> {
    const response = await this.executePageHttpTransportRequest(request, timeout, binding);
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
  ): Promise<OpensteerRawRequestOutput> {
    const response = await this.executeContextTransportRequest(request, timeout, binding);
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
  ): Promise<OpensteerRawRequestOutput> {
    const response = await this.executeMatchedTlsTransportRequest(request, timeout, binding);
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

  private async flushPersistedNetworkHistory(): Promise<void> {
    if (this.sessionRef === undefined) {
      return;
    }

    if (this.networkHistory.getKnownRequestIds().size === 0) {
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
    if (target.kind === "persist") {
      return {
        kind: "descriptor",
        persist: target.persist,
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
      this.root = await createFilesystemOpensteerWorkspace({
        rootPath: this.rootPath,
        ...(this.workspaceName === undefined ? {} : { workspace: this.workspaceName }),
        scope: this.workspaceName === undefined ? "temporary" : "workspace",
      });
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
        const remainingPages = await engine.listPages({ sessionRef }).catch(() => undefined);
        const replacementPageRef = remainingPages?.[0]?.pageRef;
        if (replacementPageRef !== undefined) {
          this.pageRef = replacementPageRef;
          return "live";
        }
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
      this.consumePendingOperationEventCapture(input.operation, input.startedAt, input.completedAt);
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
          ).flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));

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
  return [...merged.values()].sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0));
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
    ...(input.status === undefined ? {} : { status: normalizeNetworkStatusFilter(input.status) }),
    ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
  };
}

function normalizeNetworkStatusFilter(status: string | number): string {
  return String(status);
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
    readonly status?: string | number;
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

function toBrowserRequestBody(input: OpensteerRequestBodyInput): {
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

function buildCapturedRecordSuccessFingerprint(record: NetworkQueryRecord): {
  readonly status: number;
  readonly structureHash?: string;
} {
  const bodyText = decodeProtocolBody(record.record.responseBody);
  return {
    status: record.record.status ?? 0,
    ...(bodyText === undefined
      ? {}
      : (() => {
          const structureHash = jsonStructureHash(bodyText);
          return structureHash === undefined ? {} : { structureHash };
        })()),
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

  const bodyText = decodeProtocolBody(response.body);
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

const DEFAULT_STATE_GLOBAL_NAMES = [
  "__NEXT_DATA__",
  "__NUXT__",
  "__APOLLO_STATE__",
  "__INITIAL_STATE__",
  "__PRELOADED_STATE__",
  "__STATE__",
  "__data__",
] as const;

const REPLAY_TRANSPORT_LADDER: readonly TransportKind[] = [
  "direct-http",
  "matched-tls",
  "context-http",
  "page-http",
] as const;

function filterNetworkSummaryRecords(
  records: readonly NetworkQueryRecord[],
  input: OpensteerNetworkQueryInput,
): readonly NetworkQueryRecord[] {
  return records.filter((record) => {
    if (record.record.resourceType === "preflight" || record.record.method === "OPTIONS") {
      return false;
    }
    if (input.json !== true) {
      return true;
    }
    const contentType =
      headerValue(record.record.responseHeaders, "content-type") ??
      headerValue(record.record.requestHeaders, "content-type");
    const normalized = contentType?.toLowerCase();
    return (
      normalized?.includes("json") === true ||
      normalized?.includes("+json") === true ||
      looksLikeGraphqlRecord(record)
    );
  });
}

function sortPersistedNetworkRecordsChronologically(
  records: readonly NetworkQueryRecord[],
): NetworkQueryRecord[] {
  return [...records].sort((left, right) => {
    const leftTime = left.savedAt ?? 0;
    const rightTime = right.savedAt ?? 0;
    if (leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.recordId.localeCompare(right.recordId);
  });
}

function sliceNetworkSummaryWindow(
  records: readonly NetworkQueryRecord[],
  input: OpensteerNetworkQueryInput,
): readonly NetworkQueryRecord[] {
  let start = 0;
  let end = records.length;
  if (input.after !== undefined) {
    const index = records.findIndex((record) => record.recordId === input.after);
    if (index >= 0) {
      start = index + 1;
    }
  }
  if (input.before !== undefined) {
    const index = records.findIndex((record) => record.recordId === input.before);
    if (index >= 0) {
      end = index;
    }
  }
  return records.slice(start, end);
}

function buildReplayTransportRequest(
  source: NetworkQueryRecord,
  input: OpensteerNetworkReplayInput,
): {
  readonly method: string;
  readonly url: string;
  readonly headers?: readonly HeaderEntry[];
  readonly body?: BrowserBodyPayload;
  readonly followRedirects?: boolean;
} {
  const url = new URL(source.record.url);
  for (const [name, value] of Object.entries(input.query ?? {})) {
    url.searchParams.set(name, String(value));
  }

  const headers = [...source.record.requestHeaders];
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    setHeaderValue(headers, name, String(value));
  }

  let body =
    source.record.requestBody === undefined
      ? undefined
      : toBrowserBodyPayload(source.record.requestBody);
  if (input.body !== undefined) {
    body = toBrowserRequestBody(input.body).payload;
  } else if (input.variables !== undefined) {
    const graphql = extractGraphqlMetadata(source);
    if (graphql?.rawBody !== undefined) {
      const nextBody = {
        ...graphql.rawBody,
        variables:
          graphql.rawBody.variables !== null && typeof graphql.rawBody.variables === "object"
            ? {
                ...(graphql.rawBody.variables as Record<string, unknown>),
                ...(input.variables as Record<string, unknown>),
              }
            : input.variables,
      };
      body = toBrowserRequestBody({ json: toCanonicalJsonValue(nextBody) }).payload;
    }
  }

  return {
    method: source.record.method,
    url: url.toString(),
    ...(headers.length === 0 ? {} : { headers }),
    ...(body === undefined ? {} : { body }),
  };
}

function buildSessionFetchTransportRequest(input: OpensteerSessionFetchInput): {
  readonly method: string;
  readonly url: string;
  readonly headers?: readonly HeaderEntry[];
  readonly body?: BrowserBodyPayload;
  readonly followRedirects?: boolean;
} {
  const url = new URL(input.url);
  for (const [name, value] of Object.entries(input.query ?? {})) {
    url.searchParams.set(name, String(value));
  }
  const headers = Object.entries(input.headers ?? {}).map(([name, value]) => ({
    name,
    value: String(value),
  }));
  const body = input.body === undefined ? undefined : toBrowserRequestBody(input.body);
  if (
    body?.contentType !== undefined &&
    !headers.some((header) => normalizeHeaderName(header.name) === "content-type")
  ) {
    headers.push({
      name: "content-type",
      value: body.contentType,
    });
  }
  return {
    method: input.method ?? (body === undefined ? "GET" : "POST"),
    url: url.toString(),
    ...(headers.length === 0 ? {} : { headers }),
    ...(body === undefined ? {} : { body: body.payload }),
    ...(input.followRedirects === undefined ? {} : { followRedirects: input.followRedirects }),
  };
}

function looksLikeGraphqlRecord(record: NetworkQueryRecord): boolean {
  return extractGraphqlMetadata(record) !== undefined;
}

function buildNetworkSummaryRecord(record: NetworkQueryRecord): OpensteerNetworkSummaryRecord {
  const request = summarizeBody(record.record.requestBody, record.record.requestHeaders);
  const response =
    record.record.kind === "event-stream"
      ? {
          ...(summarizeBody(record.record.responseBody, record.record.responseHeaders) ?? {}),
          streaming: true,
        }
      : summarizeBody(record.record.responseBody, record.record.responseHeaders);
  const graphql = extractGraphqlMetadata(record);
  const websocketProtocols = parseWebSocketProtocols(record.record.requestHeaders);
  const websocketSubprotocol = websocketProtocols[0];

  return {
    recordId: record.recordId,
    ...(record.capture === undefined ? {} : { capture: record.capture }),
    ...(record.savedAt === undefined ? {} : { savedAt: record.savedAt }),
    kind: record.record.kind,
    method: record.record.method,
    ...(record.record.status === undefined ? {} : { status: record.record.status }),
    resourceType: record.record.resourceType,
    url: record.record.url,
    ...(request === undefined ? {} : { request }),
    ...(response === undefined ? {} : { response }),
    ...(graphql === undefined
      ? {}
      : {
          graphql: {
            ...(graphql.operationType === undefined
              ? {}
              : { operationType: graphql.operationType }),
            ...(graphql.operationName === undefined
              ? {}
              : { operationName: graphql.operationName }),
            ...(graphql.persisted === undefined ? {} : { persisted: graphql.persisted }),
          },
        }),
    ...(websocketSubprotocol === undefined
      ? {}
      : { websocket: { subprotocol: websocketSubprotocol } }),
  };
}

function extractGraphqlMetadata(record: NetworkQueryRecord):
  | (OpensteerNetworkSummaryRecord["graphql"] & {
      readonly variables?: JsonValue;
      readonly rawBody?: Record<string, unknown>;
    })
  | undefined {
  const url = record.record.url.toLowerCase();
  const requestContentType = headerValue(
    record.record.requestHeaders,
    "content-type",
  )?.toLowerCase();
  const text = decodeProtocolBody(record.record.requestBody);
  let payload: Record<string, unknown> | undefined;
  if (text !== undefined && requestContentType?.includes("json")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {}
  }

  if (payload === undefined && !url.includes("graphql")) {
    return undefined;
  }

  const queryText =
    typeof payload?.query === "string"
      ? payload.query
      : typeof payload?.operationName === "string"
        ? payload.operationName
        : undefined;
  const operationType =
    queryText === undefined
      ? undefined
      : queryText.trim().startsWith("mutation")
        ? "mutation"
        : queryText.trim().startsWith("subscription")
          ? "subscription"
          : queryText.trim().startsWith("query")
            ? "query"
            : "unknown";
  const operationName =
    typeof payload?.operationName === "string"
      ? payload.operationName
      : extractGraphqlOperationName(queryText);
  const variables =
    payload?.variables === undefined ? undefined : toCanonicalJsonValue(payload.variables);
  const persisted =
    payload?.extensions !== undefined &&
    typeof payload.extensions === "object" &&
    payload.extensions !== null &&
    "persistedQuery" in payload.extensions
      ? true
      : undefined;

  return {
    ...(operationType === undefined ? {} : { operationType }),
    ...(operationName === undefined ? {} : { operationName }),
    ...(persisted === undefined ? {} : { persisted }),
    ...(variables === undefined ? {} : { variables }),
    ...(payload === undefined ? {} : { rawBody: payload }),
  };
}

function extractGraphqlOperationName(queryText: string | undefined): string | undefined {
  if (queryText === undefined) {
    return undefined;
  }
  const match = queryText.match(/\b(query|mutation|subscription)\s+([A-Za-z0-9_]+)/u);
  return match?.[2];
}

function shouldShowRequestBody(method: string): boolean {
  return !["GET", "HEAD", "DELETE", "OPTIONS"].includes(method.trim().toUpperCase());
}

function buildStructuredBodyPreview(
  body: NetworkQueryRecord["record"]["requestBody"] | NetworkQueryRecord["record"]["responseBody"],
  headers: readonly HeaderEntry[],
): OpensteerNetworkDetailOutput["requestBody"] {
  const contentType = headerValue(headers, "content-type") ?? body?.mimeType;
  const parsed = parseStructuredPayload(body, contentType);
  const data =
    parsed === undefined
      ? undefined
      : typeof parsed === "string"
        ? truncateInlineText(parsed)
        : truncateStructuredValue(parsed);
  return {
    bytes: body?.originalByteLength ?? body?.capturedByteLength ?? 0,
    ...(contentType === undefined ? {} : { contentType }),
    truncated: body?.truncated ?? false,
    ...(data === undefined ? {} : { data }),
  };
}

function parseStructuredPayload(
  body: NetworkQueryRecord["record"]["requestBody"] | NetworkQueryRecord["record"]["responseBody"],
  contentType: string | undefined,
): JsonValue | string | undefined {
  const text = decodeProtocolBody(body);
  if (text === undefined) {
    return undefined;
  }
  const mimeType = parseContentType(contentType).mimeType?.toLowerCase();
  if (mimeType === "application/json" || mimeType?.endsWith("+json") === true) {
    try {
      return toCanonicalJsonValue(JSON.parse(text));
    } catch {
      return truncateInlineText(text);
    }
  }
  if (mimeType?.startsWith("text/") === true || mimeType === undefined) {
    return truncateInlineText(text);
  }
  return undefined;
}

function detectNetworkRecordNotes(record: NetworkQueryRecord): readonly string[] {
  const challenge = detectChallengeNoteFromRecord(record);
  return challenge === undefined ? [] : [challenge];
}

function normalizeHeaderName(name: string): string {
  return name.trim().toLowerCase();
}

function parseCookieHeaderEntries(
  value: string,
): readonly { readonly name: string; readonly value: string }[] {
  return parseCookiePairs(value).map(([name, cookieValue]) => ({
    name,
    value: cookieValue,
  }));
}

function truncateStructuredValue(
  value: JsonValue | undefined,
  depth = 0,
): JsonValue | string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return truncateInlineText(value);
  }
  if (Array.isArray(value)) {
    if (value.length <= 3) {
      return value.map(
        (entry) => truncateStructuredValue(entry as JsonValue, depth + 1) as JsonValue,
      );
    }
    return [
      `... ${value.length} items, first 2 shown`,
      truncateStructuredValue(value[0] as JsonValue, depth + 1) as JsonValue,
      truncateStructuredValue(value[1] as JsonValue, depth + 1) as JsonValue,
    ];
  }
  const entries = Object.entries(value);
  if (depth >= 4) {
    return `... ${entries.length} keys`;
  }
  const truncated = Object.fromEntries(
    entries.map(([key, entry]) => [key, truncateStructuredValue(entry as JsonValue, depth + 1)]),
  ) as JsonValue;
  const serialized = JSON.stringify(truncated);
  if (serialized !== undefined && serialized.length > 4096) {
    return `${serialized.slice(0, 4000)}... use network.detail for the full structure`;
  }
  return truncated;
}

function truncateInlineText(value: string, limit = 200): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...${value.length} chars total`;
}

function collectSetCookieHeaders(headers: readonly HeaderEntry[]): readonly string[] {
  return headers
    .filter((header) => normalizeHeaderName(header.name) === "set-cookie")
    .map((header) => header.value);
}

function hostnameFromUrl(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function filterCookieRecordsByDomain(
  cookies: readonly CookieRecord[],
  domain: string | undefined,
): readonly CookieRecord[] {
  if (domain === undefined) {
    return cookies;
  }
  return cookies.filter((cookie) => cookieDomainMatches(cookie.domain, domain));
}

function compareCookieRecords(left: CookieRecord, right: CookieRecord): number {
  const byDomain = left.domain.localeCompare(right.domain);
  if (byDomain !== 0) {
    return byDomain;
  }
  const byName = left.name.localeCompare(right.name);
  if (byName !== 0) {
    return byName;
  }
  return left.path.localeCompare(right.path);
}

function collapseStorageSnapshot(
  snapshot: StorageSnapshot,
  domain: string | undefined,
): readonly OpensteerStorageDomainSnapshot[] {
  const grouped = new Map<string, OpensteerStorageDomainSnapshot>();
  for (const origin of snapshot.origins) {
    const hostname = hostnameFromUrl(origin.origin);
    if (hostname === undefined || (domain !== undefined && hostname !== domain)) {
      continue;
    }
    grouped.set(hostname, {
      domain: hostname,
      localStorage: origin.localStorage,
      sessionStorage: grouped.get(hostname)?.sessionStorage ?? [],
    });
  }
  for (const entry of snapshot.sessionStorage ?? []) {
    const hostname = hostnameFromUrl(entry.origin);
    if (hostname === undefined || (domain !== undefined && hostname !== domain)) {
      continue;
    }
    const current = grouped.get(hostname);
    grouped.set(hostname, {
      domain: hostname,
      localStorage: current?.localStorage ?? [],
      sessionStorage: entry.entries,
    });
  }
  return [...grouped.values()].sort((left, right) => left.domain.localeCompare(right.domain));
}

function buildBrowserStateDomains(input: {
  readonly effectiveDomain?: string;
  readonly currentPageDomain?: string;
  readonly cookies: readonly CookieRecord[];
  readonly storage: StorageSnapshot;
  readonly pageState: unknown;
}): readonly OpensteerStateDomainSnapshot[] {
  const domains = collapseStorageSnapshot(input.storage, input.effectiveDomain);
  const pageState = normalizeCapturedPageState(input.pageState);
  const selectedDomain =
    input.effectiveDomain ?? input.currentPageDomain ?? domains[0]?.domain ?? undefined;
  if (selectedDomain === undefined) {
    return [];
  }
  const storage = domains.find((entry) => entry.domain === selectedDomain);
  return [
    {
      domain: selectedDomain,
      cookies: [...filterCookieRecordsByDomain(input.cookies, selectedDomain)].sort(
        compareCookieRecords,
      ),
      hiddenFields: pageState.hiddenFields,
      localStorage: storage?.localStorage ?? [],
      sessionStorage: storage?.sessionStorage ?? [],
      ...(Object.keys(pageState.globals).length === 0 ? {} : { globals: pageState.globals }),
    },
  ];
}

function normalizeCapturedPageState(value: unknown): {
  readonly hiddenFields: readonly OpensteerHiddenField[];
  readonly globals: Readonly<Record<string, JsonValue>>;
} {
  if (value === null || typeof value !== "object") {
    return {
      hiddenFields: [],
      globals: {},
    };
  }
  const source = value as {
    readonly hiddenFields?: readonly {
      readonly path?: unknown;
      readonly name?: unknown;
      readonly value?: unknown;
    }[];
    readonly globals?: Record<string, unknown>;
  };
  return {
    hiddenFields: (source.hiddenFields ?? [])
      .filter(
        (
          field,
        ): field is { readonly path: string; readonly name: string; readonly value: string } =>
          typeof field?.path === "string" &&
          typeof field.name === "string" &&
          typeof field.value === "string",
      )
      .map((field) => ({
        path: field.path,
        name: field.name,
        value: field.value,
      })),
    globals: Object.fromEntries(
      Object.entries(source.globals ?? {})
        .map(([key, entry]) => [key, toCanonicalJsonValue(entry)])
        .filter((entry): entry is [string, JsonValue] => entry[1] !== undefined),
    ),
  };
}

function toBrowserBodyPayload(body: ProtocolBodyPayload): BrowserBodyPayload {
  return createBodyPayload(new Uint8Array(Buffer.from(body.data, "base64")), {
    encoding: body.encoding,
    ...(body.mimeType === undefined ? {} : { mimeType: body.mimeType }),
    ...(body.charset === undefined ? {} : { charset: body.charset }),
    truncated: body.truncated,
    ...(body.originalByteLength === undefined
      ? {}
      : { originalByteLength: body.originalByteLength }),
  });
}

function toStructuredPreviewData(value: unknown): JsonValue | string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return truncateInlineText(value);
  }
  return truncateStructuredValue(toCanonicalJsonValue(value));
}

function buildReplayFallbackNote(
  attempts: readonly OpensteerReplayAttempt[],
  transport: TransportKind,
): string | undefined {
  const previous = attempts.at(-2);
  if (previous === undefined) {
    return undefined;
  }
  if (previous.status !== undefined) {
    return `${previous.transport} returned ${previous.status}, fell back to ${transport}`;
  }
  if (previous.error !== undefined) {
    return `${previous.transport} failed (${previous.error}), fell back to ${transport}`;
  }
  return undefined;
}

function resolveSessionFetchTransportLadder(
  transport: OpensteerSessionFetchInput["transport"],
): readonly TransportKind[] {
  switch (transport ?? "auto") {
    case "direct":
      return ["direct-http"];
    case "matched-tls":
      return ["matched-tls"];
    case "page":
      return ["page-http"];
    case "auto":
      return ["direct-http", "matched-tls", "page-http"];
  }
}

function detectChallengeNoteFromRecord(record: NetworkQueryRecord): string | undefined {
  if (record.record.responseBody === undefined) {
    return undefined;
  }
  return detectChallengeNoteFromText(
    decodeProtocolBody(record.record.responseBody),
    headerValue(record.record.responseHeaders, "content-type"),
  );
}

function detectChallengeNoteFromResponse(
  response: OpensteerRequestResponseResult,
): string | undefined {
  return detectChallengeNoteFromText(
    decodeProtocolBody(response.body),
    headerValue(response.headers, "content-type"),
  );
}

function detectChallengeNoteFromText(
  text: string | undefined,
  contentType: string | undefined,
): string | undefined {
  if (text === undefined || contentType?.toLowerCase().includes("html") !== true) {
    return undefined;
  }
  const normalized = text.toLowerCase();
  if (normalized.includes("cloudflare")) {
    return "response appears to be a Cloudflare challenge page";
  }
  if (normalized.includes("akamai")) {
    return "response appears to be an Akamai challenge page";
  }
  if (normalized.includes("datadome")) {
    return "response appears to be a DataDome challenge page";
  }
  if (normalized.includes("perimeterx")) {
    return "response appears to be a PerimeterX challenge page";
  }
  if (normalized.includes("attention required") || normalized.includes("verify you are human")) {
    return "response appears to be a bot challenge page";
  }
  return undefined;
}

function shouldAcceptFetchResponse(
  response: OpensteerRequestResponseResult,
  transport: TransportKind,
  challengeNote: string | undefined,
): boolean {
  if (challengeNote !== undefined) {
    return false;
  }
  if (response.status >= 200 && response.status < 400) {
    return true;
  }
  return transport === "page-http" && response.status >= 200 && response.status < 500;
}

function summarizeBody(
  body:
    | NetworkQueryRecord["record"]["requestBody"]
    | NetworkQueryRecord["record"]["responseBody"]
    | undefined,
  headers: readonly HeaderEntry[],
): OpensteerNetworkSummaryRecord["request"] | undefined {
  if (body === undefined) {
    return undefined;
  }
  const contentType = headerValue(headers, "content-type") ?? body.mimeType;
  return {
    bytes: body.originalByteLength ?? body.capturedByteLength,
    ...(contentType === undefined ? {} : { contentType }),
  };
}

function buildInteractionTraceKey(pageUrl: string): string {
  const slug = pageUrl
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `interaction-${slug || `trace-${Date.now()}`}`;
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

function cookieDomainMatches(domain: string, hostname: string): boolean {
  const normalizedDomain = domain.startsWith(".") ? domain.slice(1) : domain;
  return hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`);
}

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname === "/") {
    return "/";
  }
  const index = pathname.lastIndexOf("/");
  return index <= 0 ? "/" : pathname.slice(0, index);
}

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

function decodeProtocolBody(body: OpensteerRequestResponseResult["body"]): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  return Buffer.from(body.data, "base64").toString("utf8");
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
    ...(target.persist === undefined ? {} : { persist: target.persist }),
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
