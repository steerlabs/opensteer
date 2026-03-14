import path from "node:path";

import {
  isBrowserCoreError,
  type BrowserCoreEngine,
  type DocumentEpoch,
  type DocumentRef,
  type DomSnapshot as BrowserCoreDomSnapshot,
  type FrameRef,
  type HtmlSnapshot as BrowserCoreHtmlSnapshot,
  type PageRef,
  type SessionRef,
} from "@opensteer/browser-core";
import {
  createDocumentRef,
  createFrameRef,
  createNodeRef,
  createOpensteerError,
  createPageRef,
  createSessionRef,
  type OpensteerActionResult,
  type OpensteerBrowserContextOptions,
  type OpensteerBrowserLaunchOptions,
  type DomSnapshot as ProtocolDomSnapshot,
  type HtmlSnapshot as ProtocolHtmlSnapshot,
  type OpensteerDomClickInput,
  type OpensteerDomExtractInput,
  type OpensteerDomExtractOutput,
  type OpensteerDomHoverInput,
  type OpensteerDomInputInput,
  type OpensteerDomScrollInput,
  type OpensteerPageGotoInput,
  type OpensteerPageGotoOutput,
  type OpensteerPageSnapshotInput,
  type OpensteerPageSnapshotOutput,
  type OpensteerResolvedTarget,
  type OpensteerSessionCloseOutput,
  type OpensteerSessionOpenInput,
  type OpensteerSessionOpenOutput,
  type OpensteerSnapshotMode,
  type OpensteerTargetInput,
  type TraceContext,
} from "@opensteer/protocol";

import {
  type ArtifactManifest,
} from "../artifacts.js";
import { canonicalJsonString, toCanonicalJsonValue } from "../json.js";
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
  assertValidOpensteerExtractionSchemaRoot,
  compileOpensteerExtractionPayload,
  createOpensteerExtractionDescriptorStore,
  replayOpensteerExtractionPayload,
  type OpensteerExtractionDescriptorRecord,
} from "./extraction.js";
import {
  compileOpensteerSnapshot,
  type CompiledOpensteerSnapshot,
} from "./snapshot/compiler.js";

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
}

interface OpensteerTraceArtifacts {
  readonly manifests: readonly ArtifactManifest[];
}

interface OpensteerSessionTraceInput {
  readonly operation: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly outcome: "ok" | "error";
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

  private root: FilesystemOpensteerRoot | undefined;
  private engine: DisposableBrowserCoreEngine | undefined;
  private dom: DomRuntime | undefined;
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
  }

  async open(input: OpensteerSessionOpenInput = {}): Promise<OpensteerSessionOpenOutput> {
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

    try {
      const sessionRef = await engine.createSession();
      const createdPage = await engine.createPage({
        sessionRef,
        ...(input.url === undefined ? {} : { url: input.url }),
      });

      this.sessionRef = sessionRef;
      this.pageRef = createdPage.data.pageRef;
      this.latestSnapshot = undefined;
      await this.ensureSemantics();

      const state = await this.readSessionState();
      await this.appendTrace({
        operation: "session.open",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        data: state,
        context: buildRuntimeTraceContext({
          sessionRef,
          pageRef: this.pageRef,
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
      await this.resetRuntimeState({
        disposeEngine: true,
      });
      throw error;
    }
  }

  async goto(input: OpensteerPageGotoInput): Promise<OpensteerPageGotoOutput> {
    const pageRef = await this.ensurePageRef();
    const startedAt = Date.now();

    try {
      const navigation = await this.requireEngine().navigate({
        pageRef,
        url: input.url,
      });
      this.latestSnapshot = undefined;
      const state = await this.readSessionState();
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
    const pageRef = await this.ensurePageRef();
    const root = await this.ensureRoot();
    const mode: OpensteerSnapshotMode = input.mode ?? "action";
    const startedAt = Date.now();

    try {
      const compiled = await compileOpensteerSnapshot({
        engine: this.requireEngine(),
        pageRef,
        mode,
      });
      this.latestSnapshot = compiled;
      const artifacts = await this.captureSnapshotArtifacts(pageRef, {
        includeHtmlSnapshot: true,
      });

      const output: OpensteerPageSnapshotOutput = {
        url: compiled.url,
        title: compiled.title,
        mode,
        html: compiled.html,
        counters: compiled.counters,
      };

      await this.appendTrace({
        operation: "page.snapshot",
        startedAt,
        completedAt: Date.now(),
        outcome: "ok",
        artifacts,
        data: {
          mode,
          url: compiled.url,
          title: compiled.title,
          counterCount: compiled.counters.length,
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
    return this.runDomAction("dom.click", input, async (pageRef, target) => {
      const result = await this.requireDom().click({
        pageRef,
        target,
      });
      return {
        result,
      };
    });
  }

  async hover(input: OpensteerDomHoverInput): Promise<OpensteerActionResult> {
    return this.runDomAction("dom.hover", input, async (pageRef, target) => {
      const result = await this.requireDom().hover({
        pageRef,
        target,
      });
      return {
        result,
      };
    });
  }

  async input(input: OpensteerDomInputInput): Promise<OpensteerActionResult> {
    return this.runDomAction("dom.input", input, async (pageRef, target) => {
      const resolved = await this.requireDom().input({
        pageRef,
        target,
        text: input.text,
        ...(input.pressEnter === undefined ? {} : { pressEnter: input.pressEnter }),
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
    return this.runDomAction("dom.scroll", input, async (pageRef, target) => {
      const result = await this.requireDom().scroll({
        pageRef,
        target,
        delta: directionToDelta(input.direction, input.amount),
      });
      return {
        result,
      };
    });
  }

  async extract(input: OpensteerDomExtractInput): Promise<OpensteerDomExtractOutput> {
    const pageRef = await this.ensurePageRef();
    const descriptors = this.requireExtractionDescriptors();
    const startedAt = Date.now();

    try {
      let descriptor: OpensteerExtractionDescriptorRecord | undefined;
      if (input.schema !== undefined) {
        assertValidOpensteerExtractionSchemaRoot(input.schema);
        const payload = await compileOpensteerExtractionPayload({
          pageRef,
          schema: input.schema as Record<string, unknown>,
          dom: this.requireDom(),
          ...(this.latestSnapshot?.counterRecords === undefined
            ? {}
            : { latestSnapshotCounters: this.latestSnapshot.counterRecords }),
        });
        descriptor = await descriptors.write({
          description: input.description,
          root: payload,
          schemaHash: canonicalJsonString(input.schema),
          sourceUrl: (await this.requireEngine().getPageInfo({ pageRef })).url,
        });
      } else {
        descriptor = await descriptors.read({
          description: input.description,
        });
        if (!descriptor) {
          throw new Error(`no stored extraction descriptor found for "${input.description}"`);
        }
      }

      const data = await replayOpensteerExtractionPayload({
        pageRef,
        dom: this.requireDom(),
        payload: descriptor.payload.root,
      });
      const artifacts = await this.captureSnapshotArtifacts(pageRef, {
        includeHtmlSnapshot: false,
      });
      const output: OpensteerDomExtractOutput = {
        data,
      };

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
          data,
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

  async close(): Promise<OpensteerSessionCloseOutput> {
    const pageRef = this.pageRef;
    const sessionRef = this.sessionRef;
    const startedAt = Date.now();
    let closeError: unknown;

    try {
      if (pageRef !== undefined) {
        await this.requireEngine().closePage({
          pageRef,
        });
      }
    } catch (error) {
      closeError = error;
    }

    try {
      if (sessionRef !== undefined) {
        await this.requireEngine().closeSession({
          sessionRef,
        });
      }
    } catch (error) {
      closeError ??= error;
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
    TInput extends { readonly target: OpensteerTargetInput; readonly persistAsDescription?: string },
  >(
    operation: "dom.click" | "dom.hover" | "dom.input" | "dom.scroll",
    input: TInput,
    executor: (
      pageRef: PageRef,
      target: DomTargetRef,
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
      const preparedTarget = await this.prepareDomTarget(
        pageRef,
        operation,
        input.target,
        input.persistAsDescription,
      );
      const executed = await executor(pageRef, preparedTarget.target);
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

      await this.requireDom().writeDescriptor({
        method,
        description: persistAsDescription,
        path: stablePath,
        ...(this.latestSnapshot?.url === undefined ? {} : { sourceUrl: this.latestSnapshot.url }),
      });
      return {
        target: {
          kind: "descriptor",
          description: persistAsDescription,
        },
        persistedDescription: persistAsDescription,
      };
    }

    const resolved = await this.requireDom().resolveTarget({
      pageRef,
      method,
      target: domTarget,
    });
    if (resolved.path.nodes.length === 0) {
      throw new Error(
        `unable to persist "${persistAsDescription}" because no stable DOM path could be built for ${method}`,
      );
    }

    await this.requireDom().writeDescriptor({
      method,
      description: persistAsDescription,
      path: resolved.path,
      sourceUrl: resolved.snapshot.url,
    });

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
      sessionRef: createSessionRef(sessionRef),
      pageRef: createPageRef(pageRef),
      url: pageInfo.url,
      title: pageInfo.title,
    };
  }

  private async captureSnapshotArtifacts(
    pageRef: PageRef,
    options: {
      readonly includeHtmlSnapshot: boolean;
    },
  ): Promise<OpensteerTraceArtifacts> {
    const root = this.requireRoot();
    const mainFrame = await getMainFrame(this.requireEngine(), pageRef);
    const domSnapshot = await this.requireEngine().getDomSnapshot({
      frameRef: mainFrame.frameRef,
    });
    const manifests: ArtifactManifest[] = [];

    manifests.push(
      await root.artifacts.writeStructured({
        kind: "dom-snapshot",
        scope: buildArtifactScope({
          sessionRef: this.sessionRef,
          pageRef,
          frameRef: domSnapshot.frameRef,
          documentRef: domSnapshot.documentRef,
          documentEpoch: domSnapshot.documentEpoch,
        }),
        data: toProtocolDomSnapshot(domSnapshot),
      }),
    );

    if (options.includeHtmlSnapshot) {
      const htmlSnapshot = await this.requireEngine().getHtmlSnapshot({
        frameRef: mainFrame.frameRef,
      });
      manifests.push(
        await root.artifacts.writeStructured({
          kind: "html-snapshot",
          scope: buildArtifactScope({
            sessionRef: this.sessionRef,
            pageRef,
            frameRef: htmlSnapshot.frameRef,
            documentRef: htmlSnapshot.documentRef,
            documentEpoch: htmlSnapshot.documentEpoch,
          }),
          data: toProtocolHtmlSnapshot(htmlSnapshot),
        }),
      );
    }

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
      ...(artifacts === undefined ? {} : { artifacts }),
      ...(input.data === undefined ? {} : { data: toCanonicalJsonValue(input.data) }),
      ...(input.error === undefined
        ? {}
        : {
            error: normalizeOpensteerError(input.error),
          }),
    });
  }

  private async resetRuntimeState(options: {
    readonly disposeEngine: boolean;
  }): Promise<void> {
    const engine = this.engine;

    this.sessionRef = undefined;
    this.pageRef = undefined;
    this.latestSnapshot = undefined;
    this.runId = undefined;
    this.dom = undefined;
    this.extractionDescriptors = undefined;
    this.engine = undefined;

    if (options.disposeEngine && this.ownsEngine && engine?.dispose) {
      await engine.dispose();
    }
    this.ownsEngine = false;
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
    ...(input.sessionRef === undefined ? {} : { sessionRef: createSessionRef(input.sessionRef) }),
    ...(input.pageRef === undefined ? {} : { pageRef: createPageRef(input.pageRef) }),
    ...(input.frameRef === undefined ? {} : { frameRef: createFrameRef(input.frameRef) }),
    ...(input.documentRef === undefined
      ? {}
      : { documentRef: createDocumentRef(input.documentRef) }),
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

function toProtocolDomSnapshot(snapshot: BrowserCoreDomSnapshot): ProtocolDomSnapshot {
  return {
    pageRef: createPageRef(snapshot.pageRef),
    frameRef: createFrameRef(snapshot.frameRef),
    documentRef: createDocumentRef(snapshot.documentRef),
    ...(snapshot.parentDocumentRef === undefined
      ? {}
      : { parentDocumentRef: createDocumentRef(snapshot.parentDocumentRef) }),
    documentEpoch: snapshot.documentEpoch,
    url: snapshot.url,
    capturedAt: snapshot.capturedAt,
    rootSnapshotNodeId: snapshot.rootSnapshotNodeId,
    shadowDomMode: snapshot.shadowDomMode,
    ...(snapshot.geometryCoordinateSpace === undefined
      ? {}
      : { geometryCoordinateSpace: snapshot.geometryCoordinateSpace }),
    nodes: snapshot.nodes.map((node) => ({
      snapshotNodeId: node.snapshotNodeId,
      ...(node.nodeRef === undefined ? {} : { nodeRef: createNodeRef(node.nodeRef) }),
      ...(node.parentSnapshotNodeId === undefined
        ? {}
        : { parentSnapshotNodeId: node.parentSnapshotNodeId }),
      childSnapshotNodeIds: [...node.childSnapshotNodeIds],
      ...(node.shadowRootType === undefined ? {} : { shadowRootType: node.shadowRootType }),
      ...(node.shadowHostNodeRef === undefined
        ? {}
        : { shadowHostNodeRef: createNodeRef(node.shadowHostNodeRef) }),
      ...(node.contentDocumentRef === undefined
        ? {}
        : { contentDocumentRef: createDocumentRef(node.contentDocumentRef) }),
      nodeType: node.nodeType,
      nodeName: node.nodeName,
      nodeValue: node.nodeValue,
      ...(node.textContent === undefined ? {} : { textContent: node.textContent }),
      attributes: node.attributes.map((attribute) => ({
        name: attribute.name,
        value: attribute.value,
      })),
      ...(node.layout === undefined
        ? {}
        : {
            layout: {
              ...(node.layout.rect === undefined ? {} : { rect: node.layout.rect }),
              ...(node.layout.quad === undefined ? {} : { quad: node.layout.quad }),
              ...(node.layout.paintOrder === undefined
                ? {}
                : { paintOrder: node.layout.paintOrder }),
            },
          }),
    })),
  };
}

function toProtocolHtmlSnapshot(snapshot: BrowserCoreHtmlSnapshot): ProtocolHtmlSnapshot {
  return {
    pageRef: createPageRef(snapshot.pageRef),
    frameRef: createFrameRef(snapshot.frameRef),
    documentRef: createDocumentRef(snapshot.documentRef),
    documentEpoch: snapshot.documentEpoch,
    url: snapshot.url,
    capturedAt: snapshot.capturedAt,
    html: snapshot.html,
  };
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
    ...(persistedDescription === undefined
      ? {}
      : { persistedDescription }),
  };
}

function toOpensteerResolvedTarget(target: ResolvedDomTarget): OpensteerResolvedTarget {
  return {
    pageRef: createPageRef(target.pageRef),
    frameRef: createFrameRef(target.frameRef),
    documentRef: createDocumentRef(target.documentRef),
    documentEpoch: target.documentEpoch,
    nodeRef: createNodeRef(target.nodeRef),
    tagName: target.node.nodeName.toUpperCase(),
    pathHint: buildPathSelectorHint(target.path),
    ...(target.description === undefined ? {} : { description: target.description }),
    ...(target.selectorUsed === undefined ? {} : { selectorUsed: target.selectorUsed }),
  };
}

function normalizeOpensteerError(error: unknown) {
  if (isBrowserCoreError(error)) {
    return createOpensteerError(error.code, error.message, {
      retriable: error.retriable,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  }

  if (error instanceof Error) {
    return createOpensteerError("operation-failed", error.message, {
      details: {
        name: error.name,
      },
    });
  }

  return createOpensteerError("internal", "Unknown Opensteer runtime failure", {
    details: {
      value: error,
    },
  });
}
