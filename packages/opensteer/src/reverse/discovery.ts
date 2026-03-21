import type {
  NetworkQueryRecord,
  OpensteerBodyCodecDescriptor,
  OpensteerChannelDescriptor,
  OpensteerObservationCluster,
} from "@opensteer/protocol";

interface ClusterableReverseRecord {
  readonly record: NetworkQueryRecord;
  readonly observedAt?: number;
  readonly channel: OpensteerChannelDescriptor;
  readonly bodyCodec: OpensteerBodyCodecDescriptor;
  readonly matchedTargetHints: readonly string[];
}

interface MutableCluster {
  readonly id: string;
  readonly observationId: string;
  readonly label: string;
  readonly channel: OpensteerChannelDescriptor["kind"];
  readonly method?: string;
  readonly url: string;
  primaryRecordId: string;
  readonly recordIds: string[];
  readonly suppressedRecordIds: string[];
  readonly suppressionReasons: Set<string>;
  readonly matchedTargetHints: Set<string>;
  readonly records: ClusterableReverseRecord[];
}

export function clusterReverseObservationRecords(input: {
  readonly observationId: string;
  readonly records: readonly ClusterableReverseRecord[];
}): readonly OpensteerObservationCluster[] {
  const groups = new Map<string, MutableCluster>();
  for (const item of sortClusterableRecords(input.records)) {
    const key = buildClusterKey(item);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        id: `cluster:${input.observationId}:${groups.size + 1}`,
        observationId: input.observationId,
        label: buildClusterLabel(item),
        channel: item.channel.kind,
        ...(item.channel.method === undefined ? {} : { method: item.channel.method }),
        url: item.channel.url,
        primaryRecordId: item.record.recordId,
        recordIds: [item.record.recordId],
        suppressedRecordIds: [],
        suppressionReasons: new Set<string>(),
        matchedTargetHints: new Set(item.matchedTargetHints),
        records: [item],
      });
      continue;
    }

    existing.records.push(item);
    existing.recordIds.push(item.record.recordId);
    for (const hint of item.matchedTargetHints) {
      existing.matchedTargetHints.add(hint);
    }
    const currentPrimary =
      existing.records.find((entry) => entry.record.recordId === existing.primaryRecordId) ??
      existing.records[0]!;
    if (comparePrimaryCandidate(item, currentPrimary) > 0) {
      existing.suppressedRecordIds.push(existing.primaryRecordId);
      existing.suppressionReasons.add(inferSuppressionReason(currentPrimary.record, item.record));
      existing.primaryRecordId = item.record.recordId;
      continue;
    }
    existing.suppressedRecordIds.push(item.record.recordId);
    existing.suppressionReasons.add(inferSuppressionReason(item.record, currentPrimary.record));
  }

  return [...groups.values()]
    .map(
      (cluster): OpensteerObservationCluster => ({
        id: cluster.id,
        observationId: cluster.observationId,
        label: cluster.label,
        channel: cluster.channel,
        ...(cluster.method === undefined ? {} : { method: cluster.method }),
        url: cluster.url,
        primaryRecordId: cluster.primaryRecordId,
        recordIds: cluster.recordIds,
        suppressedRecordIds: cluster.suppressedRecordIds,
        suppressionReasons: [...cluster.suppressionReasons].sort((left, right) =>
          left.localeCompare(right),
        ),
        matchedTargetHints: [...cluster.matchedTargetHints].sort((left, right) =>
          left.localeCompare(right),
        ),
      }),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

function sortClusterableRecords(
  records: readonly ClusterableReverseRecord[],
): ClusterableReverseRecord[] {
  return [...records].sort((left, right) => {
    const leftObservedAt = left.observedAt ?? 0;
    const rightObservedAt = right.observedAt ?? 0;
    if (leftObservedAt !== rightObservedAt) {
      return leftObservedAt - rightObservedAt;
    }
    return left.record.recordId.localeCompare(right.record.recordId);
  });
}

function buildClusterKey(record: ClusterableReverseRecord): string {
  const url = new URL(record.channel.url);
  const searchParams = [...url.searchParams.entries()]
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      if (leftName !== rightName) {
        return leftName.localeCompare(rightName);
      }
      return leftValue.localeCompare(rightValue);
    })
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const fieldSignature = record.bodyCodec.fieldPaths.join(",");
  return [
    record.channel.kind,
    record.channel.method ?? "",
    `${url.origin}${url.pathname}`,
    searchParams,
    record.bodyCodec.kind,
    record.bodyCodec.operationName ?? "",
    fieldSignature,
  ].join("|");
}

function buildClusterLabel(record: ClusterableReverseRecord): string {
  const url = new URL(record.channel.url);
  const method = record.channel.method ?? record.record.record.method;
  return `${method} ${url.pathname}`;
}

function comparePrimaryCandidate(
  left: ClusterableReverseRecord,
  right: ClusterableReverseRecord,
): number {
  const leftScore = rankClusterPrimary(left.record);
  const rightScore = rankClusterPrimary(right.record);
  if (leftScore !== rightScore) {
    return leftScore - rightScore;
  }
  return (left.observedAt ?? 0) - (right.observedAt ?? 0);
}

function rankClusterPrimary(record: NetworkQueryRecord): number {
  let score = 0;
  if (
    record.record.status !== undefined &&
    record.record.status >= 200 &&
    record.record.status < 400
  ) {
    score += 5;
  }
  if (record.record.responseBody !== undefined) {
    score += 3;
  }
  if (
    record.record.redirectToRequestId !== undefined ||
    record.record.redirectFromRequestId !== undefined
  ) {
    score -= 2;
  }
  if (record.record.resourceType === "preflight" || record.record.method === "OPTIONS") {
    score -= 10;
  }
  return score;
}

function inferSuppressionReason(
  suppressed: NetworkQueryRecord,
  primary: NetworkQueryRecord,
): string {
  if (suppressed.record.resourceType === "preflight" || suppressed.record.method === "OPTIONS") {
    return "preflight";
  }
  if (
    suppressed.record.redirectFromRequestId !== undefined ||
    suppressed.record.redirectToRequestId !== undefined
  ) {
    return "redirect-chain";
  }
  if ((suppressed.record.status ?? 0) >= 500 && (primary.record.status ?? 0) < 500) {
    return "retry";
  }
  return "duplicate";
}
