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
  type CookieRecord,
  type OpensteerActionResult,
  type OpensteerGetRecipeInput,
  type OpensteerAuthRecipeRetryOverrides,
  type OpensteerAuthRecipeStep,
  type OpensteerBrowserContextOptions,
  type OpensteerBrowserLaunchOptions,
  type OpensteerComputerExecuteInput,
  type OpensteerComputerExecuteOutput,
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
  type OpensteerSnapshotMode,
  type OpensteerTargetInput,
  type OpensteerEvent,
  type OpensteerWriteRecipeInput,
  type StorageSnapshot,
  type TraceContext,
  type OpensteerWriteAuthRecipeInput,
  type OpensteerWriteRequestPlanInput,
  type HeaderEntry,
} from "@opensteer/protocol";

import { manifestToExternalBinaryLocation, type ArtifactManifest } from "../artifacts.js";
import { normalizeThrownOpensteerError } from "../internal/errors.js";
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
import { inferRequestPlanFromNetworkRecord } from "../requests/inference.js";
import { normalizeRequestPlanPayload } from "../requests/plans/index.js";
import {
  parseStructuredResponseData,
  toProtocolBodyPayload,
  toProtocolRequestResponseResult,
  toProtocolRequestTransportResult,
} from "../requests/shared.js";
import { NetworkJournal } from "../network/journal.js";
import {
  assertValidOpensteerExtractionSchemaRoot,
  compileOpensteerExtractionPayload,
  createOpensteerExtractionDescriptorStore,
  replayOpensteerExtractionPayload,
  type OpensteerExtractionDescriptorRecord,
} from "./extraction.js";
import { compileOpensteerSnapshot, type CompiledOpensteerSnapshot } from "./snapshot/compiler.js";
import type { AuthRecipeRecord, RecipeRecord, RequestPlanRecord } from "../registry.js";

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
          await timeout.runStep(() => this.requireEngine().activatePage({ pageRef: input.pageRef }));
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
            pages.find((page) => page.pageRef === this.pageRef)?.pageRef ??
            pages.at(-1)?.pageRef;

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
            { ignoreLimit: true },
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
    const binding =
      transport === "direct-http" ? this.currentBinding() : await this.ensureBrowserTransportBinding();
    const startedAt = Date.now();

    try {
      const output = await this.runWithOperationTimeout(
        "request.raw",
        async (timeout) =>
          this.executeRawTransportRequest(
            input,
            timeout,
            binding,
          ),
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
    const binding =
      normalizeTransportKind(plan.payload.transport.kind) === "direct-http"
        ? this.currentBinding()
        : await this.ensureBrowserTransportBinding();
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
        },
        timeout.signal,
      ),
    );
    const byRequestId = new Map(withBodies.map((record) => [record.record.requestId, record]));
    return limited.map((record) => byRequestId.get(record.record.requestId) ?? record);
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
      { ignoreLimit: true },
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
      redactSecretHeaders: true,
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
    const request = this.applyCookieJarToTransportRequest(buildRawTransportRequest(input), input.cookieJar);

    if (transport === "direct-http") {
      return this.executeDirectTransportRequestWithPersistence(request, timeout, input.cookieJar);
    }

    if (transport === "page-eval-http") {
      const pageBinding = await this.resolvePageEvalBinding(request.url, input.pageRef);
      return this.executePageEvalTransportRequestWithPersistence(
        request,
        timeout,
        pageBinding,
        input.cookieJar,
      );
    }

    if (binding === undefined) {
      throw new Error("Opensteer session is not initialized");
    }

    const output = await this.executeTransportRequestWithJournal(request, timeout, binding.sessionRef);
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
    this.updateCookieJarFromResponse(cookieJarName, toProtocolRequestResponseResult(response), request.url);
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

  private async executePageEvalTransportRequestWithPersistence(
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
    const response = await this.executePageEvalTransportRequest(request, timeout, binding);
    this.updateCookieJarFromResponse(cookieJarName, toProtocolRequestResponseResult(response), request.url);
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

  private async executePageEvalTransportRequest(
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
        script: PAGE_EVAL_HTTP_SCRIPT,
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
    return toPageEvalTransportResponse(result.data);
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
  ): Promise<string> {
    const root = await this.ensureRoot();
    const now = Date.now();
    const recordId = `record:${randomUUID()}`;
    const requestId = createNetworkRequestId(`direct-http-${randomUUID()}`);
    const syntheticSessionRef = createSessionRef(`direct-http-${this.name}`);
    const record: NetworkQueryRecord = {
      recordId,
      source: "saved",
      savedAt: now,
      record: {
        kind: "http",
        requestId,
        sessionRef: syntheticSessionRef,
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
        ...(request.body === undefined
          ? {}
          : { requestBody: toProtocolBodyPayload(request.body) }),
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
    let transportRequest = this.applyCookieJarToTransportRequest(
      applyTransportRequestOverrides(
        buildTransportRequestFromPlan(plan, resolvedInput),
        executionOverrides,
      ),
      cookieJarName,
    );
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
    if (transportKind === "context-http") {
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
      this.updateCookieJarFromResponse(cookieJarName, toProtocolRequestResponseResult(response.data), request.url);
      return {
        output: buildPlanExecuteOutput(plan, request, response.data),
        transportResponse: response.data,
      };
    }

    if (transportKind === "page-eval-http") {
      const pageBinding = await this.resolvePageEvalBinding(request.url, binding?.pageRef);
      const response = await this.executePageEvalTransportRequest(request, timeout, pageBinding);
      this.updateCookieJarFromResponse(cookieJarName, toProtocolRequestResponseResult(response), request.url);
      return {
        output: buildPlanExecuteOutput(plan, request, response),
        transportResponse: response,
      };
    }

    const response = await timeout.runStep(() => executeDirectTransportRequest(request, timeout.signal));
    this.updateCookieJarFromResponse(cookieJarName, toProtocolRequestResponseResult(response), request.url);
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

  private async resolveAuthRecipe(key: string, version: string | undefined): Promise<AuthRecipeRecord> {
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
      variables: Object.fromEntries([...variables.entries()].sort(([left], [right]) => left.localeCompare(right))),
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
              ...(step.path === undefined ? {} : { path: interpolateTemplate(step.path, variables) }),
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
            transport: "context-http",
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
            queryNetwork: (input?: OpensteerNetworkQueryInput) => Promise<OpensteerNetworkQueryOutput>;
            rawRequest: (input: OpensteerRawRequestInput) => Promise<OpensteerRawRequestOutput>;
            getCookies: (input?: { readonly urls?: readonly string[] }) => Promise<readonly CookieRecord[]>;
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
      readonly transport?: "context-http" | "direct-http" | "page-eval-http" | "session-http";
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
    const request = this.applyCookieJarToTransportRequest(
      buildRecipeRequest(requestInput, variables),
      cookieJar,
    );

    switch (transport) {
      case "direct-http":
        return this.executeDirectTransportRequestWithPersistence(request, timeout, cookieJar);
      case "page-eval-http": {
        const binding = await this.resolvePageEvalBinding(request.url, requestInput.pageRef);
        return this.executePageEvalTransportRequestWithPersistence(request, timeout, binding, cookieJar);
      }
      case "context-http": {
        const binding = this.requireExistingBrowserBindingForRecovery();
        const output = await this.executeTransportRequestWithJournal(request, timeout, binding.sessionRef);
        this.updateCookieJarFromResponse(cookieJar, output.response, request.url);
        return output;
      }
    }
  }

  private async resolvePageEvalBinding(
    requestUrl: string,
    explicitPageRef: PageRef | undefined,
  ): Promise<RuntimeBrowserBinding> {
    const pageRef = explicitPageRef ?? (await this.ensurePageRef());
    const pageInfo = await this.requireEngine().getPageInfo({ pageRef });
    if (new URL(pageInfo.url).origin !== new URL(requestUrl).origin) {
      throw new OpensteerProtocolError(
        "invalid-request",
        `page-eval-http requires a bound page on the same origin as ${requestUrl}`,
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
      ...(urls === undefined ? {} : { urls: urls.map((url) => interpolateTemplate(url, variables)) }),
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

    const cookieHeader = serializeCookieJarHeader(
      this.cookieJars.get(jarName) ?? [],
      request.url,
    );
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

    const pageUrl = step.pageUrl === undefined ? undefined : interpolateTemplate(step.pageUrl, variables);
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

function normalizeTransportKind(
  value: "context-http" | "direct-http" | "page-eval-http" | "session-http",
): "context-http" | "direct-http" | "page-eval-http" {
  return value === "session-http" ? "context-http" : value;
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

const PAGE_EVAL_HTTP_SCRIPT = `(async (input) => {
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

function toPageEvalTransportResponse(value: unknown): {
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
      "page-eval-http returned an invalid response payload",
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
      ? createBodyPayload(new Uint8Array(Buffer.from(response.bodyBase64, "base64")), parseContentType(contentType))
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
  const resolvedQuery = resolvePlanParameterValues(plan, queryParameters, input.query, "query");
  const resolvedHeaders = resolvePlanParameterValues(plan, headerParameters, input.headers, "headers");

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

  const headers = [...(payload.endpoint.defaultHeaders ?? [])];
  for (const parameter of headerParameters) {
    const value = resolvedHeaders.get(parameter.name);
    if (value !== undefined) {
      setHeaderValue(headers, parameter.wireName ?? parameter.name, value);
    }
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
        contentType:
          planBody.contentType ?? "application/x-www-form-urlencoded; charset=utf-8",
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
  fieldName: "params" | "query" | "headers",
): ReadonlyMap<string, string> {
  const normalizedValues = new Map(
    Object.entries(values ?? {}).map(([name, value]) => [name, String(value)]),
  );
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
    if (actualContentType === undefined || !actualContentType.toLowerCase().includes(expectation.contentType.toLowerCase())) {
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

function touchFreshness(
  freshness: RequestPlanRecord["freshness"],
): RequestPlanRecord["freshness"] {
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
    headers: Object.fromEntries((request.headers ?? []).map((header) => [header.name, header.value])),
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
  if (responseText !== undefined && policy.responseBodyIncludes?.some((value) => responseText.includes(value))) {
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

function interpolateTemplate(
  value: string,
  variables: ReadonlyMap<string, string>,
): string {
  return value.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, name: string) =>
    variables.get(name) ?? "",
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
  const body = request.body === undefined ? undefined : toBrowserRequestBody(interpolateRequestBody(request.body, variables));
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
  const params = overrides.params === undefined ? undefined : interpolateRecord(overrides.params, variables);
  const headers = overrides.headers === undefined ? undefined : interpolateRecord(overrides.headers, variables);
  const query = overrides.query === undefined ? undefined : interpolateRecord(overrides.query, variables);
  const body = overrides.body === undefined ? undefined : interpolateRecord(overrides.body, variables);
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
    const retryAfter = response.headers.find((header) => header.name.toLowerCase() === "retry-after")?.value;
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
