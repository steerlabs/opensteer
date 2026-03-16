import { randomUUID } from "node:crypto";

import type { NetworkRecord as BrowserNetworkRecord, PageRef } from "@opensteer/browser-core";
import type { NetworkQueryRecord } from "@opensteer/protocol";

import { toProtocolNetworkRecord } from "../requests/shared.js";

interface LiveNetworkMetadata {
  readonly recordId: string;
  readonly observedAt: number;
  actionId?: string;
  pageRef?: PageRef;
  readonly tags: Set<string>;
}

export interface LiveNetworkRecordDelta {
  readonly recordId: string;
  readonly requestId: string;
}

export class NetworkJournal {
  private readonly metadataByRequestId = new Map<string, LiveNetworkMetadata>();
  private readonly requestIdByRecordId = new Map<string, string>();
  private readonly requestIdsByActionId = new Map<string, Set<string>>();
  private readonly requestIdsByTag = new Map<string, Set<string>>();

  sync(
    records: readonly BrowserNetworkRecord[],
    options: {
      readonly redactSecretHeaders?: boolean;
    } = {},
  ): readonly NetworkQueryRecord[] {
    const observedAt = Date.now();
    return records.map((record) => this.materializeLiveRecord(record, observedAt, options));
  }

  materializeLiveRecord(
    record: BrowserNetworkRecord,
    observedAt: number,
    options: {
      readonly redactSecretHeaders?: boolean;
    } = {},
  ): NetworkQueryRecord {
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
      source: "live",
      ...(metadata.actionId === undefined ? {} : { actionId: metadata.actionId }),
      ...(metadata.tags.size === 0 ? {} : { tags: [...metadata.tags].sort() }),
      record: toProtocolNetworkRecord(record, {
        redactSecretHeaders: options.redactSecretHeaders ?? true,
      }),
    };
  }

  diffNewRequestIds(records: readonly BrowserNetworkRecord[], baselineRequestIds: ReadonlySet<string>): {
    readonly all: readonly NetworkQueryRecord[];
    readonly delta: readonly NetworkQueryRecord[];
  } {
    const observedAt = Date.now();
    const all = records.map((record) =>
      this.materializeLiveRecord(record, observedAt, {
        redactSecretHeaders: true,
      }),
    );
    const delta = all.filter((entry) => !baselineRequestIds.has(entry.record.requestId));
    return {
      all,
      delta,
    };
  }

  assignActionId(records: readonly NetworkQueryRecord[], actionId: string): void {
    for (const record of records) {
      const metadata = this.metadataByRequestId.get(record.record.requestId);
      if (!metadata || metadata.actionId === actionId) {
        continue;
      }

      if (metadata.actionId !== undefined) {
        this.requestIdsByActionId.get(metadata.actionId)?.delete(record.record.requestId);
      }
      metadata.actionId = actionId;
      this.addIndexedRequestId(this.requestIdsByActionId, actionId, record.record.requestId);
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
    return requestId === undefined ? undefined : this.metadataByRequestId.get(requestId)?.observedAt;
  }

  getRequestId(recordId: string): string | undefined {
    return this.requestIdByRecordId.get(recordId);
  }

  getRequestIdsForActionId(actionId: string): ReadonlySet<string> {
    return new Set(this.requestIdsByActionId.get(actionId) ?? []);
  }

  getRequestIdsForTag(tag: string): ReadonlySet<string> {
    return new Set(this.requestIdsByTag.get(tag) ?? []);
  }

  getPageRefForRequestId(requestId: string): PageRef | undefined {
    return this.metadataByRequestId.get(requestId)?.pageRef;
  }

  clear(): void {
    this.metadataByRequestId.clear();
    this.requestIdByRecordId.clear();
    this.requestIdsByActionId.clear();
    this.requestIdsByTag.clear();
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
