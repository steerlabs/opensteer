import {
  type DescriptorRecord,
  type FilesystemOpensteerWorkspace,
  type RequestPlanRecord,
} from "@opensteer/runtime-core";
import type { CloudRegistryImportEntry, CloudRequestPlanImportEntry } from "@opensteer/protocol";

import type { OpensteerCloudClient } from "./client.js";

export const WORKSPACE_SYNC_MAX_PAYLOAD_BYTES = 1_500_000;
export const WORKSPACE_SYNC_MAX_ENTRIES_PER_BATCH = 100;

type WorkspaceSyncClient = Pick<
  OpensteerCloudClient,
  "importDescriptors" | "importRequestPlans"
>;

export async function syncLocalWorkspaceToCloud(
  client: WorkspaceSyncClient,
  workspace: string,
  store: FilesystemOpensteerWorkspace,
): Promise<void> {
  await syncDescriptorRegistryToCloud(client, workspace, store);
  await syncRequestPlansToCloud(client, workspace, store);
}

async function syncDescriptorRegistryToCloud(
  client: WorkspaceSyncClient,
  workspace: string,
  store: FilesystemOpensteerWorkspace,
): Promise<void> {
  const descriptors = await store.registry.descriptors.list();
  const entries = descriptors.map((record) => toDescriptorImportEntry(workspace, record));

  await importInBatches(entries, {
    getPayloadByteLength: (batch) => payloadByteLength({ entries: batch }),
    importBatch: (batch) => client.importDescriptors(batch),
  });
}

async function syncRequestPlansToCloud(
  client: WorkspaceSyncClient,
  workspace: string,
  store: FilesystemOpensteerWorkspace,
): Promise<void> {
  const requestPlans = await store.registry.requestPlans.list();
  const entries = requestPlans
    .map((record) => toRequestPlanImportEntry(workspace, record))
    .filter((entry): entry is CloudRequestPlanImportEntry => entry !== undefined);

  await importInBatches(entries, {
    getPayloadByteLength: (batch) => payloadByteLength({ entries: batch }),
    importBatch: (batch) => client.importRequestPlans({ entries: batch }),
  });
}

function toRequestPlanImportEntry(
  workspace: string,
  record: RequestPlanRecord,
): CloudRequestPlanImportEntry | undefined {
  const entry: CloudRequestPlanImportEntry = {
    workspace,
    recordId: record.id,
    key: record.key,
    version: record.version,
    contentHash: record.contentHash,
    tags: [...record.tags],
    ...(record.provenance === undefined ? {} : { provenance: record.provenance }),
    ...(record.freshness === undefined ? {} : { freshness: record.freshness }),
    payload: record.payload,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  return payloadByteLength({ entries: [entry] }) <= WORKSPACE_SYNC_MAX_PAYLOAD_BYTES
    ? entry
    : undefined;
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

async function importInBatches<T>(
  entries: readonly T[],
  options: {
    getPayloadByteLength(entries: readonly T[]): number;
    importBatch(entries: readonly T[]): Promise<unknown>;
  },
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  for (const batch of chunkEntries(entries, options.getPayloadByteLength)) {
    await options.importBatch(batch);
  }
}

function chunkEntries<T>(
  entries: readonly T[],
  getPayloadByteLength: (entries: readonly T[]) => number,
): readonly (readonly T[])[] {
  const batches: T[][] = [];
  let currentBatch: T[] = [];

  for (const entry of entries) {
    if (getPayloadByteLength([entry]) > WORKSPACE_SYNC_MAX_PAYLOAD_BYTES) {
      continue;
    }

    if (currentBatch.length === 0) {
      currentBatch = [entry];
      continue;
    }

    const nextBatch = [...currentBatch, entry];
    if (
      nextBatch.length > WORKSPACE_SYNC_MAX_ENTRIES_PER_BATCH ||
      getPayloadByteLength(nextBatch) > WORKSPACE_SYNC_MAX_PAYLOAD_BYTES
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

function payloadByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
