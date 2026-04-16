import path from "node:path";
import { randomUUID } from "node:crypto";

import type { BrowserCoreEngine } from "@opensteer/browser-core";
import {
  type OpensteerExtractionDescriptorStore,
  OpensteerSessionRuntime as SharedOpensteerSessionRuntime,
  type DomDescriptorStore,
  type OpensteerEngineFactory,
  type OpensteerEngineFactoryOptions,
  type OpensteerSessionRuntimeOptions as SharedOpensteerSessionRuntimeOptions,
  type OpensteerRuntimeWorkspace,
} from "@opensteer/runtime-core";
import type {
  OpensteerBrowserOptions,
  OpensteerBrowserContextOptions,
  OpensteerBrowserLaunchOptions,
  OpensteerOpenInput,
  OpensteerOpenOutput,
  OpensteerPageActivateInput,
  OpensteerPageActivateOutput,
  OpensteerPageCloseInput,
  OpensteerPageCloseOutput,
  OpensteerPageGotoInput,
  OpensteerPageGotoOutput,
  OpensteerPageNewInput,
  OpensteerPageNewOutput,
  ObservabilityConfig,
  ObservationSink,
} from "@opensteer/protocol";

import { OpensteerBrowserManager } from "../browser-manager.js";
import {
  assertSupportedEngineOptions,
  DEFAULT_OPENSTEER_ENGINE,
  type OpensteerEngineName,
} from "../internal/engine-selection.js";
import type { OpensteerEnvironment } from "../env.js";
import {
  readPersistedLocalBrowserSessionRecord,
  writePersistedSessionRecord,
} from "../live-session.js";
import type { OpensteerPolicy } from "../policy/index.js";
import { resolveFilesystemWorkspacePath } from "../root.js";

export type { OpensteerEngineFactory, OpensteerEngineFactoryOptions, OpensteerRuntimeWorkspace };

export interface OpensteerRuntimeOptions {
  readonly workspace?: string;
  readonly rootDir?: string;
  readonly rootPath?: string;
  readonly engineName?: OpensteerEngineName;
  readonly environment?: OpensteerEnvironment;
  readonly browser?: OpensteerBrowserOptions;
  readonly launch?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
  readonly engine?: BrowserCoreEngine;
  readonly engineFactory?: OpensteerEngineFactory;
  readonly policy?: OpensteerPolicy;
  readonly descriptorStore?: DomDescriptorStore;
  readonly extractionDescriptorStore?: OpensteerExtractionDescriptorStore;
  readonly cleanupRootOnClose?: boolean;
  readonly observability?: Partial<ObservabilityConfig>;
  readonly observationSessionId?: string;
  readonly observationSink?: ObservationSink;
}

export interface OpensteerSessionRuntimeOptions {
  readonly name: string;
  readonly rootDir?: string;
  readonly rootPath?: string;
  readonly engineName?: OpensteerEngineName;
  readonly environment?: OpensteerEnvironment;
  readonly browser?: OpensteerBrowserOptions;
  readonly launch?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
  readonly engine?: BrowserCoreEngine;
  readonly engineFactory?: OpensteerEngineFactory;
  readonly policy?: OpensteerPolicy;
  readonly descriptorStore?: DomDescriptorStore;
  readonly extractionDescriptorStore?: OpensteerExtractionDescriptorStore;
  readonly cleanupRootOnClose?: boolean;
  readonly observability?: Partial<ObservabilityConfig>;
  readonly observationSessionId?: string;
  readonly observationSink?: ObservationSink;
}

abstract class LocalActivePageHintRuntime extends SharedOpensteerSessionRuntime {
  protected async completeWithLocalActivePageHint<T>(operation: () => Promise<T>): Promise<T> {
    const output = await operation();
    await persistLocalActivePageHint(this, this.rootPath);
    return output;
  }

  override async open(
    input: OpensteerOpenInput = {},
    options: Parameters<SharedOpensteerSessionRuntime["open"]>[1] = {},
  ): Promise<OpensteerOpenOutput> {
    return this.completeWithLocalActivePageHint(() => super.open(input, options));
  }

  override async newPage(
    input: OpensteerPageNewInput = {},
    options: Parameters<SharedOpensteerSessionRuntime["newPage"]>[1] = {},
  ): Promise<OpensteerPageNewOutput> {
    return this.completeWithLocalActivePageHint(() => super.newPage(input, options));
  }

  override async activatePage(
    input: OpensteerPageActivateInput,
    options: Parameters<SharedOpensteerSessionRuntime["activatePage"]>[1] = {},
  ): Promise<OpensteerPageActivateOutput> {
    return this.completeWithLocalActivePageHint(() => super.activatePage(input, options));
  }

  override async closePage(
    input: OpensteerPageCloseInput = {},
    options: Parameters<SharedOpensteerSessionRuntime["closePage"]>[1] = {},
  ): Promise<OpensteerPageCloseOutput> {
    return this.completeWithLocalActivePageHint(() => super.closePage(input, options));
  }

  override async goto(
    input: OpensteerPageGotoInput,
    options: Parameters<SharedOpensteerSessionRuntime["goto"]>[1] = {},
  ): Promise<OpensteerPageGotoOutput> {
    return this.completeWithLocalActivePageHint(() => super.goto(input, options));
  }
}

export class OpensteerRuntime extends LocalActivePageHintRuntime {
  constructor(options: OpensteerRuntimeOptions = {}) {
    const publicWorkspace = normalizeWorkspace(options.workspace);
    const rootPath =
      options.rootPath ??
      (publicWorkspace === undefined
        ? path.resolve(options.rootDir ?? process.cwd(), ".opensteer", "temporary", randomUUID())
        : resolveFilesystemWorkspacePath({
            rootDir: path.resolve(options.rootDir ?? process.cwd()),
            workspace: publicWorkspace,
          }));
    const cleanupRootOnClose = options.cleanupRootOnClose ?? publicWorkspace === undefined;
    const engineName = options.engineName ?? DEFAULT_OPENSTEER_ENGINE;

    assertSupportedEngineOptions({
      engineName,
      ...(options.browser === undefined ? {} : { browser: options.browser }),
      ...(options.context === undefined ? {} : { context: options.context }),
    });

    super(
      buildSharedRuntimeOptions({
        name: publicWorkspace ?? "default",
        ...(options.rootDir === undefined ? {} : { rootDir: options.rootDir }),
        rootPath,
        ...(publicWorkspace === undefined ? {} : { workspaceName: publicWorkspace }),
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        ...(options.browser === undefined ? {} : { browser: options.browser }),
        ...(options.launch === undefined ? {} : { launch: options.launch }),
        ...(options.context === undefined ? {} : { context: options.context }),
        engineName,
        ...(options.engine === undefined ? {} : { engine: options.engine }),
        ...(options.engineFactory === undefined ? {} : { engineFactory: options.engineFactory }),
        ...(options.policy === undefined ? {} : { policy: options.policy }),
        ...(options.descriptorStore === undefined
          ? {}
          : { descriptorStore: options.descriptorStore }),
        ...(options.extractionDescriptorStore === undefined
          ? {}
          : { extractionDescriptorStore: options.extractionDescriptorStore }),
        cleanupRootOnClose,
        ...(options.observability === undefined ? {} : { observability: options.observability }),
        ...(options.observationSessionId === undefined
          ? {}
          : { observationSessionId: options.observationSessionId }),
        ...(options.observationSink === undefined
          ? {}
          : { observationSink: options.observationSink }),
      }),
    );
  }
}

export class OpensteerSessionRuntime extends LocalActivePageHintRuntime {
  constructor(options: OpensteerSessionRuntimeOptions) {
    const rootPath = options.rootPath ?? path.resolve(options.rootDir ?? process.cwd());
    const cleanupRootOnClose = options.cleanupRootOnClose ?? false;
    const engineName = options.engineName ?? DEFAULT_OPENSTEER_ENGINE;

    assertSupportedEngineOptions({
      engineName,
      ...(options.browser === undefined ? {} : { browser: options.browser }),
      ...(options.context === undefined ? {} : { context: options.context }),
    });

    super(
      buildSharedRuntimeOptions({
        name: options.name,
        ...(options.rootDir === undefined ? {} : { rootDir: options.rootDir }),
        rootPath,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        ...(options.browser === undefined ? {} : { browser: options.browser }),
        ...(options.launch === undefined ? {} : { launch: options.launch }),
        ...(options.context === undefined ? {} : { context: options.context }),
        engineName,
        ...(options.engine === undefined ? {} : { engine: options.engine }),
        ...(options.engineFactory === undefined ? {} : { engineFactory: options.engineFactory }),
        ...(options.policy === undefined ? {} : { policy: options.policy }),
        ...(options.descriptorStore === undefined
          ? {}
          : { descriptorStore: options.descriptorStore }),
        ...(options.extractionDescriptorStore === undefined
          ? {}
          : { extractionDescriptorStore: options.extractionDescriptorStore }),
        cleanupRootOnClose,
        ...(options.observability === undefined ? {} : { observability: options.observability }),
        ...(options.observationSessionId === undefined
          ? {}
          : { observationSessionId: options.observationSessionId }),
        ...(options.observationSink === undefined
          ? {}
          : { observationSink: options.observationSink }),
      }),
    );
  }
}

async function persistLocalActivePageHint(
  runtime: SharedOpensteerSessionRuntime,
  rootPath: string,
): Promise<void> {
  try {
    await syncPersistedLocalActivePageHint(runtime, rootPath);
  } catch {}
}

async function syncPersistedLocalActivePageHint(
  runtime: SharedOpensteerSessionRuntime,
  rootPath: string,
): Promise<void> {
  const record = await readPersistedLocalBrowserSessionRecord(rootPath);
  if (!record) {
    return;
  }

  const sessionInfo = await runtime.info();
  const activePageRef = sessionInfo.activePageRef;
  let activePageUrl: string | undefined;
  let activePageTitle: string | undefined;

  if (activePageRef !== undefined) {
    const pages = await runtime.listPages();
    const activePage = pages.pages.find((page) => page.pageRef === activePageRef);
    activePageUrl = activePage?.url;
    activePageTitle = activePage?.title;
  }

  const {
    activePageRef: _previousActivePageRef,
    activePageUrl: _previousActivePageUrl,
    activePageTitle: _previousActivePageTitle,
    ...restRecord
  } = record;

  await writePersistedSessionRecord(rootPath, {
    ...restRecord,
    updatedAt: Date.now(),
    ...(activePageRef === undefined ? {} : { activePageRef }),
    ...(activePageUrl === undefined ? {} : { activePageUrl }),
    ...(activePageTitle === undefined ? {} : { activePageTitle }),
  });
}

function buildSharedRuntimeOptions(input: {
  readonly name: string;
  readonly rootDir?: string;
  readonly rootPath: string;
  readonly workspaceName?: string;
  readonly environment?: OpensteerEnvironment;
  readonly browser?: OpensteerBrowserOptions;
  readonly launch?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
  readonly engineName: OpensteerEngineName;
  readonly engine?: BrowserCoreEngine;
  readonly engineFactory?: OpensteerEngineFactory;
  readonly policy?: OpensteerPolicy;
  readonly descriptorStore?: DomDescriptorStore;
  readonly extractionDescriptorStore?: OpensteerExtractionDescriptorStore;
  readonly cleanupRootOnClose: boolean;
  readonly observability?: SharedOpensteerSessionRuntimeOptions["observability"];
  readonly observationSessionId?: SharedOpensteerSessionRuntimeOptions["observationSessionId"];
  readonly observationSink?: SharedOpensteerSessionRuntimeOptions["observationSink"];
}): SharedOpensteerSessionRuntimeOptions {
  const ownership = resolveOwnership(input.browser);
  const engineFactory =
    input.engineFactory ??
    ((factoryOptions: OpensteerEngineFactoryOptions) =>
      new OpensteerBrowserManager({
        ...(input.rootDir === undefined ? {} : { rootDir: input.rootDir }),
        rootPath: input.rootPath,
        ...(input.workspaceName === undefined ? {} : { workspace: input.workspaceName }),
        engineName: input.engineName,
        ...(input.environment === undefined ? {} : { environment: input.environment }),
        ...((factoryOptions.browser ?? input.browser) === undefined
          ? {}
          : { browser: factoryOptions.browser ?? input.browser }),
        ...((factoryOptions.launch ?? input.launch) === undefined
          ? {}
          : { launch: factoryOptions.launch ?? input.launch }),
        ...((factoryOptions.context ?? input.context) === undefined
          ? {}
          : { context: factoryOptions.context ?? input.context }),
      }).createEngine());

  return {
    name: input.name,
    ...(input.workspaceName === undefined ? {} : { workspaceName: input.workspaceName }),
    rootPath: input.rootPath,
    ...(input.engine === undefined ? {} : { engine: input.engine }),
    ...(input.engine === undefined ? { engineFactory } : {}),
    ...(input.policy === undefined ? {} : { policy: input.policy }),
    ...(input.descriptorStore === undefined ? {} : { descriptorStore: input.descriptorStore }),
    ...(input.extractionDescriptorStore === undefined
      ? {}
      : { extractionDescriptorStore: input.extractionDescriptorStore }),
    cleanupRootOnClose: input.cleanupRootOnClose,
    ...(input.observability === undefined ? {} : { observability: input.observability }),
    ...(input.observationSessionId === undefined
      ? {}
      : { observationSessionId: input.observationSessionId }),
    ...(input.observationSink === undefined ? {} : { observationSink: input.observationSink }),
    sessionInfo: {
      provider: {
        mode: "local",
        ownership,
        engine: input.engineName,
      },
      ...(input.workspaceName === undefined ? {} : { workspace: input.workspaceName }),
      reconnectable: !input.cleanupRootOnClose,
    },
  };
}

function normalizeWorkspace(workspace: string | undefined): string | undefined {
  if (workspace === undefined) {
    return undefined;
  }
  const trimmed = workspace.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function resolveOwnership(browser: OpensteerBrowserOptions | undefined): "owned" | "attached" {
  return typeof browser === "object" && browser.mode === "attach" ? "attached" : "owned";
}
