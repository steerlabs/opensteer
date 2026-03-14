import path from "node:path";

import {
  type BrowserCoreEngine,
  type DocumentEpoch,
  type DocumentRef,
  type FrameRef,
  type PageRef,
  type SessionRef,
} from "@opensteer/browser-core";
import {
  OpensteerProtocolError,
  assertValidSemanticOperationInput,
  type OpensteerActionResult,
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
  type OpensteerGetRequestPlanInput,
  type OpensteerPageGotoInput,
  type OpensteerPageGotoOutput,
  type OpensteerPageSnapshotInput,
  type OpensteerPageSnapshotOutput,
  type OpensteerListRequestPlansInput,
  type OpensteerListRequestPlansOutput,
  type OpensteerRequestCaptureStartInput,
  type OpensteerRequestCaptureStartOutput,
  type OpensteerRequestCaptureStopOutput,
  type OpensteerRequestExecuteInput,
  type OpensteerRequestExecuteOutput,
  type OpensteerResolvedTarget,
  type OpensteerSemanticOperationName,
  type OpensteerSessionCloseOutput,
  type OpensteerSessionOpenInput,
  type OpensteerSessionOpenOutput,
  type OpensteerSnapshotMode,
  type OpensteerTargetInput,
  type OpensteerEvent,
  type TraceContext,
  type OpensteerWriteRequestPlanInput,
} from "@opensteer/protocol";

import { type ArtifactManifest } from "../artifacts.js";
import { normalizeThrownOpensteerError } from "../internal/errors.js";
import { canonicalJsonString, toCanonicalJsonValue } from "../json.js";
import {
  defaultPolicy,
  runWithPolicyTimeout,
  settleWithPolicy,
  type OpensteerPolicy,
  type TimeoutExecutionContext,
} from "../policy/index.js";
import { createFilesystemOpensteerRoot, type FilesystemOpensteerRoot } from "../root.js";
import type { RequestPlanRecord } from "../registry.js";
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
} from "../runtimes/computer-use/index.js";
import { OpensteerRequestCaptureRuntime } from "../requests/capture/index.js";
import { executeSessionHttpRequest } from "../requests/execution/session-http/index.js";
import { normalizeRequestPlanPayload } from "../requests/plans/index.js";
import {
  assertValidOpensteerExtractionSchemaRoot,
  compileOpensteerExtractionPayload,
  createOpensteerExtractionDescriptorStore,
  replayOpensteerExtractionPayload,
  type OpensteerExtractionDescriptorRecord,
} from "./extraction.js";
import { compileOpensteerSnapshot, type CompiledOpensteerSnapshot } from "./snapshot/compiler.js";

type DisposableBrowserCoreEngine = BrowserCoreEngine & {
  dispose?: () => Promise<void>;
};

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
  private readonly requestCapture = new OpensteerRequestCaptureRuntime();
  private extractionDescriptors:
    | ReturnType<typeof createOpensteerExtractionDescriptorStore>
    | undefined;
  private sessionRef: SessionRef | undefined;
  private pageRef: PageRef | undefined;
  private runId: string | undefined;
  private latestSnapshot: CompiledOpensteerSnapshot | undefined;
  private ownsEngine = false;

  constructor(options: OpensteerRuntimeOptions = {}) {
    this.name = normalizeNamespace(options.name);
    this.rootPath = path.resolve(options.rootDir ?? process.cwd(), ".opensteer");
    this.configuredBrowser = options.browser;
    this.configuredContext = options.context;
    this.injectedEngine = options.engine;
    this.engineFactory = options.engineFactory ?? defaultEngineFactory;
    this.policy = options.policy ?? defaultPolicy();
  }

  async open(input: OpensteerSessionOpenInput = {}): Promise<OpensteerSessionOpenOutput> {
    assertValidSemanticOperationInput("session.open", input);

    if (input.name !== undefined && normalizeNamespace(input.name) !== this.name) {
      throw new Error(
        `session.open requested namespace "${input.name}" but runtime is bound to "${this.name}"`,
      );
    }

    if (this.sessionRef && this.pageRef) {
      if (input.url !== undefined) {
        return this.goto({
          url: input.url,
        });
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

  async goto(input: OpensteerPageGotoInput): Promise<OpensteerPageGotoOutput> {
    assertValidSemanticOperationInput("page.goto", input);

    const pageRef = await this.ensurePageRef();
    const startedAt = Date.now();

    try {
      const { navigation, state } = await this.runWithOperationTimeout(
        "page.goto",
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
          this.latestSnapshot = undefined;
          return {
            navigation,
            state: await timeout.runStep(() => this.readSessionState()),
          };
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

  async snapshot(input: OpensteerPageSnapshotInput = {}): Promise<OpensteerPageSnapshotOutput> {
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

  async click(input: OpensteerDomClickInput): Promise<OpensteerActionResult> {
    assertValidSemanticOperationInput("dom.click", input);

    return this.runDomAction("dom.click", input, async (pageRef, target, timeout) => {
      const result = await this.requireDom().click({
        pageRef,
        target,
        timeout,
      });
      return {
        result,
      };
    });
  }

  async hover(input: OpensteerDomHoverInput): Promise<OpensteerActionResult> {
    assertValidSemanticOperationInput("dom.hover", input);

    return this.runDomAction("dom.hover", input, async (pageRef, target, timeout) => {
      const result = await this.requireDom().hover({
        pageRef,
        target,
        timeout,
      });
      return {
        result,
      };
    });
  }

  async input(input: OpensteerDomInputInput): Promise<OpensteerActionResult> {
    assertValidSemanticOperationInput("dom.input", input);

    return this.runDomAction("dom.input", input, async (pageRef, target, timeout) => {
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
    });
  }

  async scroll(input: OpensteerDomScrollInput): Promise<OpensteerActionResult> {
    assertValidSemanticOperationInput("dom.scroll", input);

    return this.runDomAction("dom.scroll", input, async (pageRef, target, timeout) => {
      const result = await this.requireDom().scroll({
        pageRef,
        target,
        delta: directionToDelta(input.direction, input.amount),
        timeout,
      });
      return {
        result,
      };
    });
  }

  async extract(input: OpensteerDomExtractInput): Promise<OpensteerDomExtractOutput> {
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

  async startRequestCapture(
    input: OpensteerRequestCaptureStartInput = {},
  ): Promise<OpensteerRequestCaptureStartOutput> {
    assertValidSemanticOperationInput("request-capture.start", input);

    const pageRef = await this.ensurePageRef();
    const sessionRef = this.sessionRef;
    if (!sessionRef) {
      throw new Error("Opensteer session is not initialized");
    }
    const startedAt = Date.now();

    try {
      const output = await this.runWithOperationTimeout("request-capture.start", async () =>
        this.requestCapture.start({
          engine: this.requireEngine(),
          sessionRef,
          pageRef,
          request: input,
        }),
      );

      await this.appendTrace({
        operation: "request-capture.start",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: output,
        context: buildRuntimeTraceContext({
          sessionRef,
          pageRef,
        }),
      });

      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "request-capture.start",
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

  async stopRequestCapture(): Promise<OpensteerRequestCaptureStopOutput> {
    assertValidSemanticOperationInput("request-capture.stop", {});

    const startedAt = Date.now();
    try {
      const { artifactManifest, output } = await this.runWithOperationTimeout(
        "request-capture.stop",
        async () =>
          this.requestCapture.stop({
            engine: this.requireEngine(),
            artifacts: this.requireRoot().artifacts,
          }),
      );

      await this.appendTrace({
        operation: "request-capture.stop",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        artifacts: {
          manifests: [artifactManifest],
        },
        data: {
          scope: output.scope,
          baselineCount: output.baselineCount,
          recordCount: output.recordCount,
          artifactId: output.artifactId,
        },
        context: buildRuntimeTraceContext({
          sessionRef: this.sessionRef,
          pageRef: this.pageRef,
        }),
      });

      return output;
    } catch (error) {
      await this.appendTrace({
        operation: "request-capture.stop",
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

  async writeRequestPlan(input: OpensteerWriteRequestPlanInput): Promise<RequestPlanRecord> {
    assertValidSemanticOperationInput("request-plan.write", input);

    const startedAt = Date.now();
    try {
      const payload = normalizeRequestPlanPayload(input.payload);
      const record = await (await this.ensureRoot()).registry.requestPlans.write({
        ...input,
        payload,
      });

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

  async getRequestPlan(input: OpensteerGetRequestPlanInput): Promise<RequestPlanRecord> {
    assertValidSemanticOperationInput("request-plan.get", input);

    const startedAt = Date.now();
    try {
      const record = await (await this.ensureRoot()).registry.requestPlans.resolve(input);
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
  ): Promise<OpensteerListRequestPlansOutput> {
    assertValidSemanticOperationInput("request-plan.list", input);

    const startedAt = Date.now();
    try {
      const plans = await (await this.ensureRoot()).registry.requestPlans.list(input);
      const output = {
        plans,
      } satisfies OpensteerListRequestPlansOutput;

      await this.appendTrace({
        operation: "request-plan.list",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: {
          ...(input.key === undefined ? {} : { key: input.key }),
          count: plans.length,
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

  async request(input: OpensteerRequestExecuteInput): Promise<OpensteerRequestExecuteOutput> {
    assertValidSemanticOperationInput("request.execute", input);

    const pageRef = await this.ensurePageRef();
    const sessionRef = this.sessionRef;
    if (!sessionRef) {
      throw new Error("Opensteer session is not initialized");
    }
    const startedAt = Date.now();

    try {
      const output = await this.runWithOperationTimeout("request.execute", async () =>
        executeSessionHttpRequest({
          engine: this.requireEngine(),
          registry: this.requireRoot().registry.requestPlans,
          sessionRef,
          request: input,
        }),
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
        },
        context: buildRuntimeTraceContext({
          sessionRef,
          pageRef,
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
          sessionRef,
          pageRef,
        }),
      });
      throw error;
    }
  }

  async computerExecute(input: OpensteerComputerExecuteInput): Promise<OpensteerComputerExecuteOutput> {
    assertValidSemanticOperationInput("computer.execute", input);

    const pageRef = await this.ensurePageRef();
    const startedAt = Date.now();

    try {
      const { artifacts, output } = await this.runWithOperationTimeout(
        "computer.execute",
        async (timeout) => {
          const output = await this.requireComputer().execute({
            pageRef,
            input,
            timeout,
          });
          timeout.throwIfAborted();
          this.pageRef = output.pageRef;
          this.latestSnapshot = undefined;
          const artifacts = await this.persistComputerArtifacts(output, timeout);
          return {
            artifacts,
            output,
          };
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
          viewport: output.viewport,
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

  async close(): Promise<OpensteerSessionCloseOutput> {
    const engine = this.engine;
    const pageRef = this.pageRef;
    const sessionRef = this.sessionRef;
    const startedAt = Date.now();
    let closeError: unknown;

    try {
      await this.runWithOperationTimeout("session.close", async (timeout) => {
        if (pageRef !== undefined) {
          await timeout.runStep(() =>
            this.requireEngine().closePage({
              pageRef,
            }),
          );
        }
        if (sessionRef !== undefined) {
          await timeout.runStep(() =>
            this.requireEngine().closeSession({
              sessionRef,
            }),
          );
        }
      });
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
  ): Promise<OpensteerActionResult> {
    const pageRef = await this.ensurePageRef();
    const startedAt = Date.now();

    try {
      const { executed, preparedTarget } = await this.runWithOperationTimeout(
        operation,
        async (timeout) => {
          const preparedTarget = await this.prepareDomTarget(
            pageRef,
            operation,
            input.target,
            input.persistAsDescription,
            timeout,
          );
          return {
            executed: await executor(pageRef, preparedTarget.target, timeout),
            preparedTarget,
          };
        },
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

      const stablePath = sanitizeElementPath(counter.path);
      if (stablePath.nodes.length === 0) {
        throw new Error(
          `unable to persist "${persistAsDescription}" because no stable DOM path could be built for ${method}`,
        );
      }

      await timeout.runStep(() =>
        this.requireDom().writeDescriptor({
          method,
          description: persistAsDescription,
          path: stablePath,
          ...(this.latestSnapshot?.url === undefined ? {} : { sourceUrl: this.latestSnapshot.url }),
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
    if (resolved.path.nodes.length === 0) {
      throw new Error(
        `unable to persist "${persistAsDescription}" because no stable DOM path could be built for ${method}`,
      );
    }

    await timeout.runStep(() =>
      this.requireDom().writeDescriptor({
        method,
        description: persistAsDescription,
        path: resolved.path,
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

    if (counter.path.nodes.length > 0) {
      return {
        kind: "path",
        path: sanitizeElementPath(counter.path),
      };
    }

    return {
      kind: "live",
      locator: counter.locator,
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
    const context = overrides.context ?? this.configuredContext;
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
    if (!this.pageRef) {
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
    output: OpensteerComputerExecuteOutput,
    timeout: TimeoutExecutionContext,
  ): Promise<OpensteerTraceArtifacts> {
    const root = this.requireRoot();
    const manifests: ArtifactManifest[] = [];

    manifests.push(
      await timeout.runStep(() =>
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
          data: new Uint8Array(Buffer.from(output.screenshot.payload.data, "base64")),
        }),
      ),
    );

    return {
      manifests,
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

    this.requestCapture.clear();
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
  ): Promise<T> {
    return runWithPolicyTimeout(
      this.policy.timeout,
      {
        operation,
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

async function defaultEngineFactory(
  options: OpensteerEngineFactoryOptions,
): Promise<BrowserCoreEngine> {
  const { createPlaywrightBrowserCoreEngine } = await import("@opensteer/engine-playwright");
  return createPlaywrightBrowserCoreEngine({
    ...(options.browser === undefined ? {} : { launch: options.browser }),
    ...(options.context === undefined ? {} : { context: options.context }),
  });
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
    pathHint: buildPathSelectorHint(target.path),
    ...(target.description === undefined ? {} : { description: target.description }),
    ...(target.selectorUsed === undefined ? {} : { selectorUsed: target.selectorUsed }),
  };
}

function normalizeOpensteerError(error: unknown) {
  return normalizeThrownOpensteerError(error, "Unknown Opensteer runtime failure");
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
