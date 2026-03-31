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
} from "@opensteer/protocol";

import { OpensteerBrowserManager } from "../browser-manager.js";
import {
  assertSupportedEngineOptions,
  DEFAULT_OPENSTEER_ENGINE,
  type OpensteerEngineName,
} from "../internal/engine-selection.js";
import type { OpensteerPolicy } from "../policy/index.js";
import type {
  AuthRecipeRegistryStore,
  RecipeRegistryStore,
  RequestPlanRegistryStore,
  ReverseCaseRegistryStore,
  ReversePackageRegistryStore,
} from "../registry.js";
import { resolveFilesystemWorkspacePath } from "../root.js";

export type { OpensteerEngineFactory, OpensteerEngineFactoryOptions, OpensteerRuntimeWorkspace };

export interface OpensteerRuntimeOptions {
  readonly workspace?: string;
  readonly rootDir?: string;
  readonly rootPath?: string;
  readonly engineName?: OpensteerEngineName;
  readonly browser?: OpensteerBrowserOptions;
  readonly launch?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
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
}

export interface OpensteerSessionRuntimeOptions {
  readonly name: string;
  readonly rootDir?: string;
  readonly rootPath?: string;
  readonly engineName?: OpensteerEngineName;
  readonly browser?: OpensteerBrowserOptions;
  readonly launch?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
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
}

export class OpensteerRuntime extends SharedOpensteerSessionRuntime {
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
        rootPath,
        ...(publicWorkspace === undefined ? {} : { workspaceName: publicWorkspace }),
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
        ...(options.registryOverrides === undefined
          ? {}
          : { registryOverrides: options.registryOverrides }),
        cleanupRootOnClose,
      }),
    );
  }
}

export class OpensteerSessionRuntime extends SharedOpensteerSessionRuntime {
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
        rootPath,
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
        ...(options.registryOverrides === undefined
          ? {}
          : { registryOverrides: options.registryOverrides }),
        cleanupRootOnClose,
      }),
    );
  }
}

function buildSharedRuntimeOptions(input: {
  readonly name: string;
  readonly rootPath: string;
  readonly workspaceName?: string;
  readonly browser?: OpensteerBrowserOptions;
  readonly launch?: OpensteerBrowserLaunchOptions;
  readonly context?: OpensteerBrowserContextOptions;
  readonly engineName: OpensteerEngineName;
  readonly engine?: BrowserCoreEngine;
  readonly engineFactory?: OpensteerEngineFactory;
  readonly policy?: OpensteerPolicy;
  readonly descriptorStore?: DomDescriptorStore;
  readonly extractionDescriptorStore?: OpensteerExtractionDescriptorStore;
  readonly registryOverrides?: SharedOpensteerSessionRuntimeOptions["registryOverrides"];
  readonly cleanupRootOnClose: boolean;
}): SharedOpensteerSessionRuntimeOptions {
  const ownership = resolveOwnership(input.browser);
  const engineFactory =
    input.engineFactory ??
    ((factoryOptions: OpensteerEngineFactoryOptions) =>
      new OpensteerBrowserManager({
        rootPath: input.rootPath,
        ...(input.workspaceName === undefined ? {} : { workspace: input.workspaceName }),
        engineName: input.engineName,
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
    ...(input.registryOverrides === undefined
      ? {}
      : { registryOverrides: input.registryOverrides }),
    cleanupRootOnClose: input.cleanupRootOnClose,
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
