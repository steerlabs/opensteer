import { randomUUID } from "node:crypto";

import type { NetworkRecord as BrowserNetworkRecord, PageRef } from "@opensteer/browser-core";
import type { NetworkQueryRecord } from "@opensteer/protocol";

import type { SavedNetworkBodyWriteMode, SavedNetworkStore } from "./saved-store.js";
import { toProtocolNetworkRecord } from "../requests/shared.js";

interface NetworkRecordMetadata {
  readonly recordId: string;
  readonly observedAt: number;
  savedAt?: number;
  capture?: string;
  pageRef?: PageRef;
  readonly tags: Set<string>;
}

export class NetworkHistory {
  private readonly metadataByRequestId = new Map<string, NetworkRecordMetadata>();
  private readonly requestIdByRecordId = new Map<string, string>();
  private readonly requestIdsByCapture = new Map<string, Set<string>>();
  private readonly requestIdsByTag = new Map<string, Set<string>>();
  private readonly tombstonedRequestIds = new Set<string>();

  materialize(
    records: readonly BrowserNetworkRecord[],
    options: {
      readonly redactSecretHeaders?: boolean;
    } = {},
  ): readonly NetworkQueryRecord[] {
    const observedAt = Date.now();
    const materialized: NetworkQueryRecord[] = [];
    for (const record of records) {
      const entry = this.materializeRecord(record, observedAt, options);
      if (entry !== undefined) {
        materialized.push(entry);
      }
    }
    return materialized;
  }

  async persist(
    records: readonly BrowserNetworkRecord[],
    store: SavedNetworkStore,
    options: {
      readonly bodyWriteMode: SavedNetworkBodyWriteMode;
      readonly observedAt?: number;
      readonly redactSecretHeaders?: boolean;
    },
  ): Promise<readonly NetworkQueryRecord[]> {
    const observedAt = options.observedAt ?? Date.now();
    const metadataToSave = new Set<NetworkRecordMetadata>();
    const persisted: NetworkQueryRecord[] = [];
    for (const record of records) {
      const entry = this.materializeRecord(record, observedAt, {
        ...(options.redactSecretHeaders === undefined
          ? {}
          : { redactSecretHeaders: options.redactSecretHeaders }),
      });
      if (entry === undefined) {
        continue;
      }

      const requestId = entry.record.requestId;
      const metadata = this.metadataByRequestId.get(requestId);
      if (metadata === undefined) {
        continue;
      }
      const savedAt = metadata.savedAt ?? observedAt;
      metadataToSave.add(metadata);
      persisted.push({
        ...entry,
        savedAt,
      });
    }

    if (persisted.length > 0) {
      await store.save(persisted, {
        bodyWriteMode: options.bodyWriteMode,
      });
      for (const metadata of metadataToSave) {
        metadata.savedAt ??= observedAt;
      }
    }
    return persisted;
  }

  assignCapture(records: readonly NetworkQueryRecord[], capture: string): void {
    for (const record of records) {
      const metadata = this.metadataByRequestId.get(record.record.requestId);
      if (!metadata || metadata.capture === capture) {
        continue;
      }

      if (metadata.capture !== undefined) {
        this.requestIdsByCapture.get(metadata.capture)?.delete(record.record.requestId);
      }
      metadata.capture = capture;
      this.addIndexedRequestId(this.requestIdsByCapture, capture, record.record.requestId);
    }
  }

  addTag(records: readonly NetworkQueryRecord[], tag: string): void {
    for (const record of records) {
      const metadata = this.metadataByRequestId.get(record.record.requestId);
      if (!metadata || metadata.tags.has(tag)) {
        continue;
      }

      metadata.tags.add(tag);
      this.addIndexedRequestId(this.requestIdsByTag, tag, record.record.requestId);
    }
  }

  getObservedAt(recordId: string): number | undefined {
    const requestId = this.requestIdByRecordId.get(recordId);
    return requestId === undefined
      ? undefined
      : this.metadataByRequestId.get(requestId)?.observedAt;
  }

  getRequestId(recordId: string): string | undefined {
    return this.requestIdByRecordId.get(recordId);
  }

  getRequestIdsForCapture(capture: string): ReadonlySet<string> {
    return new Set(this.requestIdsByCapture.get(capture) ?? []);
  }

  getRequestIdsForTag(tag: string): ReadonlySet<string> {
    return new Set(this.requestIdsByTag.get(tag) ?? []);
  }

  getPageRefForRequestId(requestId: string): PageRef | undefined {
    return this.metadataByRequestId.get(requestId)?.pageRef;
  }

  getKnownRequestIds(): ReadonlySet<string> {
    return new Set(this.metadataByRequestId.keys());
  }

  tombstoneRequestIds(requestIds: Iterable<string>): void {
    for (const requestId of requestIds) {
      this.tombstonedRequestIds.add(requestId);
      const metadata = this.metadataByRequestId.get(requestId);
      if (!metadata) {
        continue;
      }

      this.metadataByRequestId.delete(requestId);
      this.requestIdByRecordId.delete(metadata.recordId);
      if (metadata.capture !== undefined) {
        this.requestIdsByCapture.get(metadata.capture)?.delete(requestId);
      }
      for (const tag of metadata.tags) {
        this.requestIdsByTag.get(tag)?.delete(requestId);
      }
    }
  }

  clear(): void {
    this.metadataByRequestId.clear();
    this.requestIdByRecordId.clear();
    this.requestIdsByCapture.clear();
    this.requestIdsByTag.clear();
    this.tombstonedRequestIds.clear();
  }

  private materializeRecord(
    record: BrowserNetworkRecord,
    observedAt: number,
    options: {
      readonly redactSecretHeaders?: boolean;
    },
  ): NetworkQueryRecord | undefined {
    if (this.tombstonedRequestIds.has(record.requestId)) {
      return undefined;
    }

    let metadata = this.metadataByRequestId.get(record.requestId);
    if (!metadata) {
      metadata = {
        recordId: `record:${randomUUID()}`,
        observedAt,
        ...(record.pageRef === undefined ? {} : { pageRef: record.pageRef }),
        tags: new Set<string>(),
      };
      this.metadataByRequestId.set(record.requestId, metadata);
      this.requestIdByRecordId.set(metadata.recordId, record.requestId);
    } else if (metadata.pageRef === undefined && record.pageRef !== undefined) {
      metadata.pageRef = record.pageRef;
    }

    return {
      recordId: metadata.recordId,
      ...(metadata.capture === undefined ? {} : { capture: metadata.capture }),
      ...(metadata.tags.size === 0 ? {} : { tags: [...metadata.tags].sort() }),
      ...(metadata.savedAt === undefined ? {} : { savedAt: metadata.savedAt }),
      record: toProtocolNetworkRecord(record, {
        redactSecretHeaders: options.redactSecretHeaders ?? true,
      }),
    };
  }

  private addIndexedRequestId(
    index: Map<string, Set<string>>,
    key: string,
    requestId: string,
  ): void {
    const requestIds = index.get(key) ?? new Set<string>();
    requestIds.add(requestId);
    index.set(key, requestIds);
  }
}
