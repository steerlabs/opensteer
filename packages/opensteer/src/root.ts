import path from "node:path";

import { createArtifactStore, type OpensteerArtifactStore } from "./artifacts.js";
import {
  encodePathSegment,
  ensureDirectory,
  normalizeTimestamp,
  pathExists,
  readJsonFile,
  withFilesystemLock,
  writeJsonFileAtomic,
} from "./internal/filesystem.js";
import {
  createAuthRecipeRegistry,
  createDescriptorRegistry,
  createInteractionTraceRegistry,
  createRequestPlanRegistry,
  createReverseCaseRegistry,
  createReversePackageRegistry,
  createReverseReportRegistry,
  type AuthRecipeRegistryStore,
  type DescriptorRegistryStore,
  type InteractionTraceRegistryStore,
  type RecipeRegistryStore,
  type RequestPlanRegistryStore,
  type ReverseCaseRegistryStore,
  type ReversePackageRegistryStore,
  type ReverseReportRegistryStore,
} from "./registry.js";
import { createSavedNetworkStore, type SavedNetworkStore } from "./network/saved-store.js";
import { createTraceStore, type OpensteerTraceStore } from "./traces.js";

export const OPENSTEER_FILESYSTEM_WORKSPACE_LAYOUT = "opensteer-workspace";
export const OPENSTEER_FILESYSTEM_WORKSPACE_VERSION = 2;

export interface OpensteerWorkspaceManifest {
  readonly layout: typeof OPENSTEER_FILESYSTEM_WORKSPACE_LAYOUT;
  readonly version: typeof OPENSTEER_FILESYSTEM_WORKSPACE_VERSION;
  readonly scope: "workspace" | "temporary";
  readonly workspace?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly paths: {
    readonly browser: "browser";
    readonly live: "live";
    readonly artifacts: "artifacts";
    readonly traces: "traces";
    readonly registry: "registry";
  };
}

export interface CreateFilesystemOpensteerWorkspaceOptions {
  readonly rootPath: string;
  readonly workspace?: string;
  readonly scope?: "workspace" | "temporary";
  readonly createdAt?: number;
}

export interface FilesystemOpensteerWorkspace {
  readonly rootPath: string;
  readonly manifestPath: string;
  readonly manifest: OpensteerWorkspaceManifest;
  readonly browserPath: string;
  readonly browserManifestPath: string;
  readonly browserUserDataDir: string;
  readonly livePath: string;
  readonly liveBrowserPath: string;
  readonly artifactsPath: string;
  readonly tracesPath: string;
  readonly registryPath: string;
  readonly lockPath: string;
  readonly artifacts: OpensteerArtifactStore;
  readonly traces: OpensteerTraceStore;
  readonly registry: {
    readonly descriptors: DescriptorRegistryStore;
    readonly requestPlans: RequestPlanRegistryStore;
    readonly authRecipes: AuthRecipeRegistryStore;
    readonly recipes: RecipeRegistryStore;
    readonly savedNetwork: SavedNetworkStore;
    readonly reverseCases: ReverseCaseRegistryStore;
    readonly interactionTraces: InteractionTraceRegistryStore;
    readonly reversePackages: ReversePackageRegistryStore;
    readonly reverseReports: ReverseReportRegistryStore;
  };
  lock<T>(task: () => Promise<T>): Promise<T>;
}

export function normalizeWorkspaceId(workspace: string): string {
  return encodePathSegment(workspace);
}

export function resolveFilesystemWorkspacePath(input: {
  readonly rootDir: string;
  readonly workspace: string;
}): string {
  return path.join(input.rootDir, ".opensteer", "workspaces", normalizeWorkspaceId(input.workspace));
}

export async function createFilesystemOpensteerWorkspace(
  options: CreateFilesystemOpensteerWorkspaceOptions,
): Promise<FilesystemOpensteerWorkspace> {
  await ensureDirectory(options.rootPath);

  const manifestPath = path.join(options.rootPath, "workspace.json");
  const browserPath = path.join(options.rootPath, "browser");
  const browserManifestPath = path.join(browserPath, "manifest.json");
  const browserUserDataDir = path.join(browserPath, "user-data");
  const livePath = path.join(options.rootPath, "live");
  const liveBrowserPath = path.join(livePath, "browser.json");
  const artifactsPath = path.join(options.rootPath, "artifacts");
  const tracesPath = path.join(options.rootPath, "traces");
  const registryPath = path.join(options.rootPath, "registry");
  const lockPath = path.join(options.rootPath, ".lock");

  let manifest: OpensteerWorkspaceManifest;
  if (await pathExists(manifestPath)) {
    manifest = await readJsonFile<OpensteerWorkspaceManifest>(manifestPath);
    if (manifest.layout !== OPENSTEER_FILESYSTEM_WORKSPACE_LAYOUT) {
      throw new Error(
        `workspace ${options.rootPath} is not an ${OPENSTEER_FILESYSTEM_WORKSPACE_LAYOUT} layout`,
      );
    }
    if (manifest.version !== OPENSTEER_FILESYSTEM_WORKSPACE_VERSION) {
      throw new Error(
        `workspace ${options.rootPath} uses unsupported version ${String(manifest.version)}`,
      );
    }
  } else {
    const createdAt = normalizeTimestamp("createdAt", options.createdAt ?? Date.now());
    manifest = {
      layout: OPENSTEER_FILESYSTEM_WORKSPACE_LAYOUT,
      version: OPENSTEER_FILESYSTEM_WORKSPACE_VERSION,
      scope: options.scope ?? (options.workspace === undefined ? "temporary" : "workspace"),
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
      createdAt,
      updatedAt: createdAt,
      paths: {
        browser: "browser",
        live: "live",
        artifacts: "artifacts",
        traces: "traces",
        registry: "registry",
      },
    };
    await writeJsonFileAtomic(manifestPath, manifest);
  }

  await Promise.all([
    ensureDirectory(browserPath),
    ensureDirectory(browserUserDataDir),
    ensureDirectory(livePath),
    ensureDirectory(artifactsPath),
    ensureDirectory(tracesPath),
    ensureDirectory(registryPath),
  ]);

  const artifacts = createArtifactStore(options.rootPath);
  await artifacts.initialize();

  const descriptors = createDescriptorRegistry(options.rootPath);
  await descriptors.initialize();

  const requestPlans = createRequestPlanRegistry(options.rootPath);
  await requestPlans.initialize();

  const authRecipes = createAuthRecipeRegistry(options.rootPath);
  await authRecipes.initialize();

  const savedNetwork = createSavedNetworkStore(options.rootPath);
  await savedNetwork.initialize();

  const reverseCases = createReverseCaseRegistry(options.rootPath);
  await reverseCases.initialize();

  const interactionTraces = createInteractionTraceRegistry(options.rootPath);
  await interactionTraces.initialize();

  const reversePackages = createReversePackageRegistry(options.rootPath);
  await reversePackages.initialize();

  const reverseReports = createReverseReportRegistry(options.rootPath);
  await reverseReports.initialize();

  const traces = createTraceStore(options.rootPath, artifacts);
  await traces.initialize();

  return {
    rootPath: options.rootPath,
    manifestPath,
    manifest,
    browserPath,
    browserManifestPath,
    browserUserDataDir,
    livePath,
    liveBrowserPath,
    artifactsPath,
    tracesPath,
    registryPath,
    lockPath,
    artifacts,
    traces,
    registry: {
      descriptors,
      requestPlans,
      authRecipes,
      recipes: authRecipes,
      savedNetwork,
      reverseCases,
      interactionTraces,
      reversePackages,
      reverseReports,
    },
    lock<T>(task: () => Promise<T>): Promise<T> {
      return withFilesystemLock(lockPath, task);
    },
  };
}
