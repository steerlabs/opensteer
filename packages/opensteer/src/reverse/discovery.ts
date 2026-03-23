import type {
  NetworkQueryRecord,
  OpensteerBodyCodecDescriptor,
  OpensteerChannelDescriptor,
  OpensteerObservationCluster,
  OpensteerObservationClusterRelationshipKind,
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
    if (existing !== undefined) {
      existing.records.push(item);
      for (const hint of item.matchedTargetHints) {
        existing.matchedTargetHints.add(hint);
      }
      continue;
    }

    groups.set(key, {
      id: `cluster:${input.observationId}:${groups.size + 1}`,
      observationId: input.observationId,
      label: buildClusterLabel(item),
      channel: item.channel.kind,
      ...(item.channel.method === undefined ? {} : { method: item.channel.method }),
      url: item.channel.url,
      matchedTargetHints: new Set(item.matchedTargetHints),
      records: [item],
    });
  }

  return [...groups.values()]
    .map((cluster) => {
      const orderedRecords = sortClusterableRecords(cluster.records);
      const seedRecord = orderedRecords[0];
      if (seedRecord === undefined) {
        throw new Error(`reverse cluster ${cluster.id} does not contain any records`);
      }
      return {
        id: cluster.id,
        observationId: cluster.observationId,
        label: cluster.label,
        channel: cluster.channel,
        ...(cluster.method === undefined ? {} : { method: cluster.method }),
        url: cluster.url,
        matchedTargetHints: [...cluster.matchedTargetHints].sort((left, right) =>
          left.localeCompare(right),
        ),
        members: orderedRecords.map((record, index) => {
          const relation =
            index === 0 ? "seed" : inferClusterRelationship(seedRecord.record, record.record);
          return {
            recordId: record.record.recordId,
            ...(record.observedAt === undefined ? {} : { observedAt: record.observedAt }),
            ...(record.record.record.resourceType === undefined
              ? {}
              : { resourceType: record.record.record.resourceType }),
            ...(record.record.record.status === undefined
              ? {}
              : { status: record.record.record.status }),
            relation,
            ...(index === 0 ? {} : { relatedRecordId: seedRecord.record.recordId }),
            matchedTargetHints: [...record.matchedTargetHints].sort((left, right) =>
              left.localeCompare(right),
            ),
          };
        }),
      } satisfies OpensteerObservationCluster;
    })
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

function inferClusterRelationship(
  seed: NetworkQueryRecord,
  record: NetworkQueryRecord,
): OpensteerObservationClusterRelationshipKind {
  if (record.record.resourceType === "preflight" || record.record.method === "OPTIONS") {
    return "preflight";
  }
  if (
    record.record.redirectFromRequestId !== undefined ||
    record.record.redirectToRequestId !== undefined
  ) {
    return "redirect";
  }
  if (
    (seed.record.status ?? 0) >= 500 &&
    record.record.status !== undefined &&
    record.record.status < 500
  ) {
    return "retry";
  }
  if (
    seed.record.requestId !== record.record.requestId &&
    seed.record.url === record.record.url &&
    seed.record.method === record.record.method
  ) {
    return "duplicate";
  }
  return "follow-on";
}
