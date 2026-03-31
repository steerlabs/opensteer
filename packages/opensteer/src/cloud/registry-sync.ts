import {
  hashDomDescriptorDescription,
  parseDomDescriptorRecord,
  type AuthRecipeRecord,
  type DescriptorRecord,
  type FilesystemOpensteerWorkspace,
  type RecipeRecord,
  type RequestPlanRecord,
} from "@opensteer/runtime-core";
import type {
  CloudRegistryImportEntry,
  CloudRequestPlanImportEntry,
  CloudSelectorCacheImportEntry,
} from "@opensteer/protocol";

import type { OpensteerCloudClient } from "./client.js";

export const REGISTRY_SYNC_MAX_PAYLOAD_BYTES = 1_500_000;
export const REGISTRY_SYNC_MAX_ENTRIES_PER_BATCH = 100;

type RegistryImportClient = Pick<
  OpensteerCloudClient,
  "importSelectorCache" | "importRequestPlans" | "importRecipes" | "importAuthRecipes"
>;

export async function syncLocalRegistryToCloud(
  client: RegistryImportClient,
  workspace: string,
  store: FilesystemOpensteerWorkspace,
): Promise<void> {
  const [descriptors, requestPlans, recipes, authRecipes] = await Promise.all([
    store.registry.descriptors.list(),
    store.registry.requestPlans.list(),
    store.registry.recipes.list(),
    store.registry.authRecipes.list(),
  ]);

  console.warn("[opensteer:sync] Local registry counts:", {
    descriptors: descriptors.length,
    requestPlans: requestPlans.length,
    recipes: recipes.length,
    authRecipes: authRecipes.length,
  });

  const selectorEntries = descriptors.flatMap((record) => {
    const entry = toSelectorCacheImportEntry(workspace, record);
    if (entry === undefined) {
      console.warn("[opensteer:sync] Descriptor skipped (could not convert):", record.id);
    }
    return entry === undefined ? [] : [entry];
  });

  console.warn("[opensteer:sync] Selector entries to import:", selectorEntries.length);
  if (selectorEntries.length > 0) {
    console.warn("[opensteer:sync] First selector entry sample:", JSON.stringify(selectorEntries[0], null, 2));
  }

  await Promise.all([
    importInBatches(selectorEntries, async (entries) => {
      console.warn("[opensteer:sync] Importing selector cache batch, count:", entries.length);
      const result = await client.importSelectorCache(entries);
      console.warn("[opensteer:sync] Selector cache import response:", JSON.stringify(result));
      return result;
    }),
    importInBatches(
      requestPlans.map((record) => toRequestPlanImportEntry(workspace, record)),
      (entries) => {
        console.warn("[opensteer:sync] Importing request plans batch, count:", entries.length);
        return client.importRequestPlans(entries);
      },
    ),
    importInBatches(
      recipes.map((record) => toRegistryImportEntry(workspace, record)),
      (entries) => {
        console.warn("[opensteer:sync] Importing recipes batch, count:", entries.length);
        return client.importRecipes(entries);
      },
    ),
    importInBatches(
      authRecipes.map((record) => toRegistryImportEntry(workspace, record)),
      (entries) => {
        console.warn("[opensteer:sync] Importing auth recipes batch, count:", entries.length);
        return client.importAuthRecipes(entries);
      },
    ),
  ]);
}

function toSelectorCacheImportEntry(
  workspace: string,
  record: DescriptorRecord,
): CloudSelectorCacheImportEntry | undefined {
  const descriptor = parseDomDescriptorRecord(record);
  if (descriptor === undefined) {
    return undefined;
  }

  return {
    workspace,
    method: descriptor.payload.method,
    descriptionHash: hashDomDescriptorDescription(descriptor.payload.description),
    description: descriptor.payload.description,
    path: descriptor.payload.path,
    createdAt: descriptor.createdAt,
    updatedAt: descriptor.updatedAt,
  };
}

function toRegistryImportEntry(
  workspace: string,
  record: RecipeRecord | AuthRecipeRecord,
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
