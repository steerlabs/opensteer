import type {
  OpensteerInteractionDiffOutput,
  OpensteerInteractionTraceRecord,
} from "@opensteer/protocol";

export function diffInteractionTraces(
  left: OpensteerInteractionTraceRecord,
  right: OpensteerInteractionTraceRecord,
): OpensteerInteractionDiffOutput {
  const eventSequenceMismatches: string[] = [];
  const eventPropertyMismatches: string[] = [];
  const stateMismatches: string[] = [];
  const downstreamRequestMismatches: string[] = [];

  const maxEvents = Math.max(left.payload.events.length, right.payload.events.length);
  for (let index = 0; index < maxEvents; index += 1) {
    const leftEvent = left.payload.events[index];
    const rightEvent = right.payload.events[index];
    if (leftEvent === undefined || rightEvent === undefined) {
      eventSequenceMismatches.push(
        `event[${String(index)}] exists only on ${leftEvent === undefined ? "right" : "left"}`,
      );
      continue;
    }

    if (leftEvent.type !== rightEvent.type || leftEvent.targetPath !== rightEvent.targetPath) {
      eventSequenceMismatches.push(
        `event[${String(index)}] ${leftEvent.type}@${leftEvent.targetPath ?? "<unknown>"} != ${rightEvent.type}@${rightEvent.targetPath ?? "<unknown>"}`,
      );
    }

    for (const propertyName of new Set([
      ...Object.keys(leftEvent.properties),
      ...Object.keys(rightEvent.properties),
    ])) {
      const leftValue = leftEvent.properties[propertyName];
      const rightValue = rightEvent.properties[propertyName];
      if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) {
        eventPropertyMismatches.push(
          `event[${String(index)}].${propertyName}: ${JSON.stringify(leftValue)} != ${JSON.stringify(rightValue)}`,
        );
      }
    }
  }

  for (const field of ["cookiesChanged", "storageChanged", "hiddenFieldsChanged", "globalsChanged"] as const) {
    const leftValues = new Set(left.payload.stateDelta?.[field] ?? []);
    const rightValues = new Set(right.payload.stateDelta?.[field] ?? []);
    for (const value of new Set([...leftValues, ...rightValues])) {
      if (!leftValues.has(value) || !rightValues.has(value)) {
        stateMismatches.push(`${field}.${value} differs`);
      }
    }
  }

  const leftRequests = new Set(left.payload.networkRecordIds);
  const rightRequests = new Set(right.payload.networkRecordIds);
  for (const value of new Set([...leftRequests, ...rightRequests])) {
    if (!leftRequests.has(value) || !rightRequests.has(value)) {
      downstreamRequestMismatches.push(`network.${value} differs`);
    }
  }

  return {
    summary: {
      eventCountDelta: Math.abs(left.payload.events.length - right.payload.events.length),
      propertyMismatchCount: eventPropertyMismatches.length,
      stateMismatchCount: stateMismatches.length,
      downstreamRequestMismatchCount: downstreamRequestMismatches.length,
    },
    eventSequenceMismatches,
    eventPropertyMismatches,
    stateMismatches,
    downstreamRequestMismatches,
  };
}
