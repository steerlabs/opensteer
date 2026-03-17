import path from "node:path";

import { createArtifactStore, type OpensteerArtifactStore } from "./artifacts.js";
import {
  ensureDirectory,
  normalizeTimestamp,
  pathExists,
  readJsonFile,
  writeJsonFileAtomic,
} from "./internal/filesystem.js";
import {
  createAuthRecipeRegistry,
  createDescriptorRegistry,
  createRequestPlanRegistry,
  type AuthRecipeRegistryStore,
  type DescriptorRegistryStore,
  type RequestPlanRegistryStore,
} from "./registry.js";
import { createSavedNetworkStore, type SavedNetworkStore } from "./network/saved-store.js";
import { createTraceStore, type OpensteerTraceStore } from "./traces.js";

export const OPENSTEER_FILESYSTEM_ROOT_LAYOUT = "opensteer-filesystem-root";
export const OPENSTEER_FILESYSTEM_ROOT_VERSION = 1;

export interface OpensteerRootManifest {
  readonly layout: typeof OPENSTEER_FILESYSTEM_ROOT_LAYOUT;
  readonly version: typeof OPENSTEER_FILESYSTEM_ROOT_VERSION;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly paths: {
    readonly artifacts: "artifacts";
    readonly traces: "traces";
    readonly registry: "registry";
  };
}

export interface CreateFilesystemOpensteerRootOptions {
  readonly rootPath: string;
  readonly createdAt?: number;
}

export interface FilesystemOpensteerRoot {
  readonly rootPath: string;
  readonly manifest: OpensteerRootManifest;
  readonly artifacts: OpensteerArtifactStore;
  readonly traces: OpensteerTraceStore;
  readonly registry: {
    readonly descriptors: DescriptorRegistryStore;
    readonly requestPlans: RequestPlanRegistryStore;
    readonly authRecipes: AuthRecipeRegistryStore;
    readonly savedNetwork: SavedNetworkStore;
  };
}

export async function createFilesystemOpensteerRoot(
  options: CreateFilesystemOpensteerRootOptions,
): Promise<FilesystemOpensteerRoot> {
  await ensureDirectory(options.rootPath);
  const manifestPath = path.join(options.rootPath, "opensteer-root.json");

  let manifest: OpensteerRootManifest;
  if (await pathExists(manifestPath)) {
    manifest = await readJsonFile<OpensteerRootManifest>(manifestPath);
    if (manifest.layout !== OPENSTEER_FILESYSTEM_ROOT_LAYOUT) {
      throw new Error(
        `root ${options.rootPath} is not an ${OPENSTEER_FILESYSTEM_ROOT_LAYOUT} layout`,
      );
    }
    if (manifest.version !== OPENSTEER_FILESYSTEM_ROOT_VERSION) {
      throw new Error(
        `root ${options.rootPath} uses unsupported version ${String(manifest.version)}`,
      );
    }
  } else {
    const createdAt = normalizeTimestamp("createdAt", options.createdAt ?? Date.now());
    manifest = {
      layout: OPENSTEER_FILESYSTEM_ROOT_LAYOUT,
      version: OPENSTEER_FILESYSTEM_ROOT_VERSION,
      createdAt,
      updatedAt: createdAt,
      paths: {
        artifacts: "artifacts",
        traces: "traces",
        registry: "registry",
      },
    };
    await writeJsonFileAtomic(manifestPath, manifest);
  }

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

  const traces = createTraceStore(options.rootPath, artifacts);
  await traces.initialize();

  return {
    rootPath: options.rootPath,
    manifest,
    artifacts,
    traces,
    registry: {
      descriptors,
      requestPlans,
      authRecipes,
      savedNetwork,
    },
  };
}
