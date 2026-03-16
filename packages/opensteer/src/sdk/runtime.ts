import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  bodyPayloadFromUtf8,
  createBodyPayload,
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
  type OpensteerInferRequestPlanInput,
  type OpensteerNetworkClearInput,
  type OpensteerNetworkClearOutput,
  type OpensteerNetworkQueryInput,
  type OpensteerNetworkQueryOutput,
  type OpensteerNetworkSaveInput,
  type OpensteerNetworkSaveOutput,
  type OpensteerPageGotoInput,
  type OpensteerPageGotoOutput,
  type OpensteerPageSnapshotInput,
  type OpensteerPageSnapshotOutput,
  type OpensteerListRequestPlansInput,
  type OpensteerListRequestPlansOutput,
  type OpensteerRawRequestInput,
  type OpensteerRawRequestOutput,
  type OpensteerRequestExecuteInput,
  type OpensteerRequestExecuteOutput,
  type OpensteerRequestTransportResult,
  type OpensteerRequestResponseResult,
  type NetworkQueryRecord,
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
  type HeaderEntry,
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
import {
  defaultOpensteerEngineFactory,
  normalizeOpensteerBrowserContextOptions,
} from "../internal/engine-selection.js";
import { executeSessionHttpRequest } from "../requests/execution/session-http/index.js";
import { inferRequestPlanFromNetworkRecord } from "../requests/inference.js";
import { normalizeRequestPlanPayload } from "../requests/plans/index.js";
import {
  parseStructuredResponseData,
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

interface RuntimeOperationOptions {
  readonly signal?: AbortSignal;
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

  async rawRequest(
    input: OpensteerRawRequestInput,
    options: RuntimeOperationOptions = {},
  ): Promise<OpensteerRawRequestOutput> {
    assertValidSemanticOperationInput("request.raw", input);

    const pageRef = await this.ensurePageRef();
    const sessionRef = this.sessionRef;
    if (!sessionRef) {
      throw new Error("Opensteer session is not initialized");
    }
    const startedAt = Date.now();

    try {
      const output = await this.runWithOperationTimeout(
        "request.raw",
        async (timeout) =>
          this.executeTransportRequestWithJournal(
            buildRawTransportRequest(input),
            timeout,
            sessionRef,
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
          sessionRef,
          pageRef,
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
          sessionRef,
          pageRef,
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

    const pageRef = await this.ensurePageRef();
    const sessionRef = this.sessionRef;
    if (!sessionRef) {
      throw new Error("Opensteer session is not initialized");
    }
    const root = await this.ensureRoot();
    const startedAt = Date.now();

    try {
      const output = await this.runWithOperationTimeout(
        "request.execute",
        async (timeout) => {
          const baselineRequestIds = await this.readLiveRequestIds(timeout, {
            includeCurrentPageOnly: false,
          });
          const output = await timeout.runStep(() =>
            executeSessionHttpRequest({
              engine: this.requireEngine(),
              registry: root.registry.requestPlans,
              sessionRef,
              request: input,
              signal: timeout.signal,
            }),
          );
          await this.observeLiveTransportDelta(timeout, baselineRequestIds, {
            includeCurrentPageOnly: false,
          });
          return output;
        },
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
              artifacts,
              output,
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
    const requestIdForRecordId =
      input.recordId === undefined ? undefined : this.networkJournal.getRequestId(input.recordId);
    const metadataRecords = await timeout.runStep(() =>
      this.readLiveNetworkRecords(
        {
          ...(selectLiveQueryPageRef(input, this.pageRef) === undefined
            ? {}
            : { pageRef: selectLiveQueryPageRef(input, this.pageRef)! }),
          includeBodies: false,
          ...(input.recordId === undefined ? {} : { includeCurrentPageOnly: false }),
          ...(requestIdForRecordId === undefined ? {} : { requestIds: [requestIdForRecordId] }),
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
          ...(selectLiveQueryPageRef(input, this.pageRef) === undefined
            ? {}
            : { pageRef: selectLiveQueryPageRef(input, this.pageRef)! }),
          includeBodies: true,
          requestIds: limited.map((record) => record.record.requestId),
          includeCurrentPageOnly: input.recordId === undefined,
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
    readonly resourceType?: string;
  },
): readonly NetworkQueryRecord[] {
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
    if (input.url !== undefined && !includesCaseInsensitive(record.record.url, input.url)) {
      return false;
    }
    if (
      input.hostname !== undefined &&
      !includesCaseInsensitive(new URL(record.record.url).hostname, input.hostname)
    ) {
      return false;
    }
    if (
      input.path !== undefined &&
      !includesCaseInsensitive(new URL(record.record.url).pathname, input.path)
    ) {
      return false;
    }
    if (
      input.method !== undefined &&
      !includesCaseInsensitive(record.record.method, input.method)
    ) {
      return false;
    }
    if (
      input.status !== undefined &&
      !includesCaseInsensitive(
        record.record.status === undefined ? "" : String(record.record.status),
        input.status,
      )
    ) {
      return false;
    }
    if (input.resourceType !== undefined && record.record.resourceType !== input.resourceType) {
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

function includesCaseInsensitive(value: string, search: string): boolean {
  return value.toLowerCase().includes(search.toLowerCase());
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
