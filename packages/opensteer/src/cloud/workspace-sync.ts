import {
  iterateSavedNetworkRecordBatches,
  type DescriptorRecord,
  type FilesystemOpensteerWorkspace,
} from "@opensteer/runtime-core";
import type { CloudRegistryImportEntry, NetworkQueryRecord } from "@opensteer/protocol";

import type { OpensteerCloudClient } from "./client.js";

export const WORKSPACE_SYNC_MAX_PAYLOAD_BYTES = 1_500_000;
export const WORKSPACE_SYNC_MAX_ENTRIES_PER_BATCH = 100;
export const WORKSPACE_SYNC_SOURCE_BATCH_SIZE = 500;

type WorkspaceSyncClient = Pick<
  OpensteerCloudClient,
  "importDescriptors" | "importSavedNetwork"
>;

export async function syncLocalWorkspaceToCloud(
  client: WorkspaceSyncClient,
  workspace: string,
  store: FilesystemOpensteerWorkspace,
): Promise<void> {
  await syncDescriptorRegistryToCloud(client, workspace, store);
  await syncSavedNetworkToCloud(client, workspace, store);
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

async function syncSavedNetworkToCloud(
  client: WorkspaceSyncClient,
  workspace: string,
  store: FilesystemOpensteerWorkspace,
): Promise<void> {
  for await (const batch of iterateSavedNetworkRecordBatches(store.rootPath, {
    batchSize: WORKSPACE_SYNC_SOURCE_BATCH_SIZE,
    includeBodies: true,
  })) {
    const prepared = batch
      .map((record) => prepareSavedNetworkImportEntry(workspace, record))
      .filter((record): record is NetworkQueryRecord => record !== undefined);

    await importInBatches(prepared, {
      getPayloadByteLength: (entries) => payloadByteLength({ workspace, entries }),
      importBatch: (entries) => client.importSavedNetwork({ workspace, entries }),
    });
  }
}

function prepareSavedNetworkImportEntry(
  workspace: string,
  record: NetworkQueryRecord,
): NetworkQueryRecord | undefined {
  if (payloadByteLength({ workspace, entries: [record] }) <= WORKSPACE_SYNC_MAX_PAYLOAD_BYTES) {
    return record;
  }

  const stripped = stripSavedNetworkBodies(record);
  return payloadByteLength({ workspace, entries: [stripped] }) <=
    WORKSPACE_SYNC_MAX_PAYLOAD_BYTES
    ? stripped
    : undefined;
}

function stripSavedNetworkBodies(record: NetworkQueryRecord): NetworkQueryRecord {
  const { requestBody: _requestBody, responseBody: _responseBody, ...nextRecord } = record.record;
  return {
    ...record,
    record: nextRecord,
  };
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
