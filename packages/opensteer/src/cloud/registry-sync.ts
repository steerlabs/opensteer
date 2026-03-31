import {
  type AuthRecipeRecord,
  type DescriptorRecord,
  type FilesystemOpensteerWorkspace,
  type RecipeRecord,
  type ReverseCaseRecord,
  type ReversePackageRecord,
  type RequestPlanRecord,
} from "@opensteer/runtime-core";
import type { CloudRegistryImportEntry, CloudRequestPlanImportEntry } from "@opensteer/protocol";

import type { OpensteerCloudClient } from "./client.js";

export const REGISTRY_SYNC_MAX_PAYLOAD_BYTES = 1_500_000;
export const REGISTRY_SYNC_MAX_ENTRIES_PER_BATCH = 100;

type RegistryImportClient = Pick<
  OpensteerCloudClient,
  | "importDescriptors"
  | "importRequestPlans"
  | "importRecipes"
  | "importAuthRecipes"
  | "importReverseCases"
  | "importReversePackages"
>;

export async function syncLocalRegistryToCloud(
  client: RegistryImportClient,
  workspace: string,
  store: FilesystemOpensteerWorkspace,
): Promise<void> {
  const [descriptors, requestPlans, recipes, authRecipes, reverseCases, reversePackages] =
    await Promise.all([
      store.registry.descriptors.list(),
      store.registry.requestPlans.list(),
      store.registry.recipes.list(),
      store.registry.authRecipes.list(),
      store.registry.reverseCases.list(),
      store.registry.reversePackages.list(),
    ]);

  const descriptorEntries = descriptors.map((record) => toDescriptorImportEntry(workspace, record));

  await Promise.all([
    importInBatches(descriptorEntries, (entries) => client.importDescriptors(entries)),
    importInBatches(
      requestPlans.map((record) => toRequestPlanImportEntry(workspace, record)),
      (entries) => client.importRequestPlans(entries),
    ),
    importInBatches(
      recipes.map((record) => toRegistryImportEntry(workspace, record)),
      (entries) => client.importRecipes(entries),
    ),
    importInBatches(
      authRecipes.map((record) => toRegistryImportEntry(workspace, record)),
      (entries) => client.importAuthRecipes(entries),
    ),
    importInBatches(
      reverseCases.map((record) => toRegistryImportEntry(workspace, record)),
      (entries) => client.importReverseCases(entries),
    ),
    importInBatches(
      reversePackages.map((record) => toRegistryImportEntry(workspace, record)),
      (entries) => client.importReversePackages(entries),
    ),
  ]);
}

function toDescriptorImportEntry(
  workspace: string,
  record: DescriptorRecord,
): CloudRegistryImportEntry {
  return {
    workspace,
    recordId: record.id,
    key: record.key,
    version: record.version,
    contentHash: record.contentHash,
    tags: [...record.tags],
    ...(record.provenance === undefined ? {} : { provenance: record.provenance }),
    payload: record.payload,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toRegistryImportEntry(
  workspace: string,
  record: RecipeRecord | AuthRecipeRecord | ReverseCaseRecord | ReversePackageRecord,
): CloudRegistryImportEntry {
  return {
    workspace,
    recordId: record.id,
    key: record.key,
    version: record.version,
    contentHash: record.contentHash,
    tags: record.tags,
    ...(record.provenance === undefined ? {} : { provenance: record.provenance }),
    payload: record.payload,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toRequestPlanImportEntry(
  workspace: string,
  record: RequestPlanRecord,
): CloudRequestPlanImportEntry {
  return {
    workspace,
    recordId: record.id,
    key: record.key,
    version: record.version,
    contentHash: record.contentHash,
    tags: record.tags,
    ...(record.provenance === undefined ? {} : { provenance: record.provenance }),
    payload: record.payload,
    ...(record.freshness === undefined ? {} : { freshness: record.freshness }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function importInBatches<T>(
  entries: readonly T[],
  importBatch: (entries: readonly T[]) => Promise<unknown>,
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  for (const batch of chunkEntries(entries)) {
    await importBatch(batch);
  }
}

function chunkEntries<T>(entries: readonly T[]): readonly (readonly T[])[] {
  const batches: T[][] = [];
  let currentBatch: T[] = [];

  for (const entry of entries) {
    if (payloadByteLength([entry]) > REGISTRY_SYNC_MAX_PAYLOAD_BYTES) {
      continue;
    }

    if (currentBatch.length === 0) {
      currentBatch = [entry];
      continue;
    }

    const nextBatch = [...currentBatch, entry];
    if (
      nextBatch.length > REGISTRY_SYNC_MAX_ENTRIES_PER_BATCH ||
      payloadByteLength(nextBatch) > REGISTRY_SYNC_MAX_PAYLOAD_BYTES
    ) {
      batches.push(currentBatch);
      currentBatch = [entry];
      continue;
    }

    currentBatch = nextBatch;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function payloadByteLength<T>(entries: readonly T[]): number {
  return Buffer.byteLength(JSON.stringify({ entries }), "utf8");
}
