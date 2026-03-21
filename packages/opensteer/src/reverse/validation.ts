import type {
  NetworkQueryRecord,
  OpensteerChannelDescriptor,
  OpensteerRequestResponseResult,
  OpensteerReverseReplayValidation,
  OpensteerValidationRule,
} from "@opensteer/protocol";

import { sha256Hex } from "../internal/filesystem.js";
import { canonicalJsonString } from "../json.js";

export function buildReverseValidationRules(input: {
  readonly record: NetworkQueryRecord;
  readonly channel: OpensteerChannelDescriptor;
}): readonly OpensteerValidationRule[] {
  switch (input.channel.kind) {
    case "http":
      return buildHttpValidationRules(input.record);
    case "event-stream":
      return buildEventStreamValidationRules(input.record);
    case "websocket":
      return buildWebSocketValidationRules(input.record);
  }
}

export function evaluateValidationRulesForHttpResponse(
  response: OpensteerRequestResponseResult,
  rules: readonly OpensteerValidationRule[],
): {
  readonly success: boolean;
  readonly validation: OpensteerReverseReplayValidation;
  readonly error?: string;
} {
  const statusRule = rules.find((rule) => rule.kind === "status");
  const structureRule = rules.find((rule) => rule.kind === "json-structure");
  const textRule = rules.find((rule) => rule.kind === "text-includes");
  const bodyText = decodeProtocolBody(response.body);

  const statusMatches =
    statusRule?.expectedStatus === undefined ? undefined : response.status === statusRule.expectedStatus;
  const structureMatches =
    structureRule?.structureHash === undefined
      ? undefined
      : jsonStructureHash(bodyText) === structureRule.structureHash;
  const textMatches =
    textRule?.textIncludes === undefined ? undefined : bodyText?.includes(textRule.textIncludes) === true;

  const success = rules.every((rule) => {
    if (!rule.required) {
      return true;
    }
    switch (rule.kind) {
      case "status":
        return statusMatches === true;
      case "json-structure":
        return structureMatches === true;
      case "text-includes":
        return textMatches === true;
      default:
        return true;
    }
  });

  return {
    success,
    validation: {
      ...(statusMatches === undefined ? {} : { statusMatches }),
      ...(structureMatches === undefined ? {} : { structureMatches }),
    },
    ...(success ? {} : { error: firstFailedValidationMessage(rules, { statusMatches, structureMatches, textMatches }) }),
  };
}

export function evaluateValidationRulesForObservedRecord(
  record: NetworkQueryRecord,
  rules: readonly OpensteerValidationRule[],
): {
  readonly success: boolean;
  readonly validation: OpensteerReverseReplayValidation;
  readonly error?: string;
} {
  const statusRule = rules.find((rule) => rule.kind === "status");
  const structureRule = rules.find((rule) => rule.kind === "json-structure");
  const textRule = rules.find((rule) => rule.kind === "text-includes");
  const bodyText = decodeProtocolBody(record.record.responseBody);

  const statusMatches =
    statusRule?.expectedStatus === undefined
      ? undefined
      : (record.record.status ?? 0) === statusRule.expectedStatus;
  const structureMatches =
    structureRule?.structureHash === undefined
      ? undefined
      : bodyText === undefined && canAssumeObservedJsonStructureMatch(record, statusMatches)
        ? true
        : jsonStructureHash(bodyText) === structureRule.structureHash;
  const textMatches =
    textRule?.textIncludes === undefined ? undefined : bodyText?.includes(textRule.textIncludes) === true;

  const success = rules.every((rule) => {
    if (!rule.required) {
      return true;
    }
    switch (rule.kind) {
      case "status":
        return statusMatches === true;
      case "json-structure":
        return structureMatches === true;
      case "text-includes":
        return textMatches === true;
      default:
        return true;
    }
  });

  return {
    success,
    validation: {
      ...(statusMatches === undefined ? {} : { statusMatches }),
      ...(structureMatches === undefined ? {} : { structureMatches }),
    },
    ...(success ? {} : { error: firstFailedValidationMessage(rules, { statusMatches, structureMatches, textMatches }) }),
  };
}

function canAssumeObservedJsonStructureMatch(
  record: NetworkQueryRecord,
  statusMatches: boolean | undefined,
): boolean {
  if (statusMatches !== true) {
    return false;
  }
  if (record.record.responseBodyState !== "failed") {
    return false;
  }
  return record.record.responseHeaders.some(
    (header) =>
      header.name.toLowerCase() === "content-type" &&
      header.value.toLowerCase().includes("application/json"),
  );
}

export function evaluateValidationRulesForEventStreamReplay(
  replay: {
    readonly status: number;
    readonly firstChunkPreview?: string;
  },
  rules: readonly OpensteerValidationRule[],
): {
  readonly success: boolean;
  readonly validation: OpensteerReverseReplayValidation;
  readonly error?: string;
} {
  const statusRule = rules.find((rule) => rule.kind === "status");
  const firstChunkRule = rules.find((rule) => rule.kind === "stream-first-chunk");
  const statusMatches =
    statusRule?.expectedStatus === undefined ? undefined : replay.status === statusRule.expectedStatus;
  const firstChunkMatches =
    firstChunkRule?.textIncludes === undefined
      ? undefined
      : replay.firstChunkPreview === firstChunkRule.textIncludes;
  const success = rules.every((rule) => {
    if (!rule.required) {
      return true;
    }
    if (rule.kind === "status") {
      return statusMatches === true;
    }
    if (rule.kind === "stream-first-chunk") {
      return firstChunkMatches === true;
    }
    return true;
  });

  return {
    success,
    validation: {
      ...(statusMatches === undefined ? {} : { statusMatches }),
      firstChunkObserved: replay.firstChunkPreview !== undefined,
      ...(firstChunkMatches === undefined ? {} : { firstChunkMatches }),
    },
    ...(success ? {} : { error: firstFailedValidationMessage(rules, { statusMatches, firstChunkMatches }) }),
  };
}

export function evaluateValidationRulesForWebSocketReplay(
  replay: {
    readonly opened: boolean;
    readonly messageCount: number;
  },
  rules: readonly OpensteerValidationRule[],
): {
  readonly success: boolean;
  readonly validation: OpensteerReverseReplayValidation;
  readonly error?: string;
} {
  const openRule = rules.find((rule) => rule.kind === "websocket-open");
  const messageRule = rules.find((rule) => rule.kind === "message-count-at-least");
  const openMatches = openRule === undefined ? undefined : replay.opened === true;
  const messageMatches =
    messageRule?.minimumCount === undefined ? undefined : replay.messageCount >= messageRule.minimumCount;
  const success = rules.every((rule) => {
    if (!rule.required) {
      return true;
    }
    if (rule.kind === "websocket-open") {
      return openMatches === true;
    }
    if (rule.kind === "message-count-at-least") {
      return messageMatches === true;
    }
    return true;
  });

  return {
    success,
    validation: {
      ...(openMatches === undefined ? {} : { opened: openMatches }),
      messageObserved: replay.messageCount > 0,
      messageCount: replay.messageCount,
    },
    ...(success ? {} : { error: firstFailedValidationMessage(rules, { openMatches, messageMatches }) }),
  };
}

function buildHttpValidationRules(record: NetworkQueryRecord): readonly OpensteerValidationRule[] {
  const rules: OpensteerValidationRule[] = [];
  if (record.record.status !== undefined) {
    rules.push({
      id: "validator:status",
      kind: "status",
      label: "Status matches captured success",
      required: true,
      expectedStatus: record.record.status,
    });
  }
  const structureHash = jsonStructureHash(decodeProtocolBody(record.record.responseBody));
  if (structureHash !== undefined) {
    rules.push({
      id: "validator:json-structure",
      kind: "json-structure",
      label: "JSON structure matches captured response",
      required: true,
      structureHash,
    });
  }
  return rules;
}

function buildEventStreamValidationRules(record: NetworkQueryRecord): readonly OpensteerValidationRule[] {
  const rules: OpensteerValidationRule[] = [];
  if (record.record.status !== undefined) {
    rules.push({
      id: "validator:status",
      kind: "status",
      label: "Event stream status matches captured success",
      required: true,
      expectedStatus: record.record.status,
    });
  }
  const firstChunk = firstTextPreview(decodeProtocolBody(record.record.responseBody));
  if (firstChunk !== undefined) {
    rules.push({
      id: "validator:stream-first-chunk",
      kind: "stream-first-chunk",
      label: "First stream chunk matches captured replay",
      required: true,
      textIncludes: firstChunk,
    });
  }
  return rules;
}

function buildWebSocketValidationRules(_record: NetworkQueryRecord): readonly OpensteerValidationRule[] {
  return [
    {
      id: "validator:websocket-open",
      kind: "websocket-open",
      label: "WebSocket opens successfully",
      required: true,
    },
    {
      id: "validator:websocket-message-count",
      kind: "message-count-at-least",
      label: "WebSocket emits at least one message",
      required: true,
      minimumCount: 1,
    },
  ];
}

function firstFailedValidationMessage(
  rules: readonly OpensteerValidationRule[],
  results: Record<string, boolean | undefined>,
): string {
  const failedRule = rules.find((rule) => {
    if (!rule.required) {
      return false;
    }
    switch (rule.kind) {
      case "status":
        return results.statusMatches !== true;
      case "json-structure":
        return results.structureMatches !== true;
      case "text-includes":
        return results.textMatches !== true;
      case "stream-first-chunk":
        return results.firstChunkMatches !== true;
      case "websocket-open":
        return results.openMatches !== true;
      case "message-count-at-least":
        return results.messageMatches !== true;
    }
  });
  return failedRule === undefined
    ? "captured validation rules were not reproduced"
    : `${failedRule.label} was not reproduced`;
}

function firstTextPreview(value: string | undefined, limit = 256): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.slice(0, limit);
}

function decodeProtocolBody(
  body:
    | OpensteerRequestResponseResult["body"]
    | NetworkQueryRecord["record"]["responseBody"]
    | undefined,
): string | undefined {
  if (body === undefined) {
    return undefined;
  }
  try {
    return Buffer.from(body.data, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function jsonStructureHash(bodyText: string | undefined): string | undefined {
  if (bodyText === undefined) {
    return undefined;
  }
  try {
    return sha256Hex(
      Buffer.from(canonicalJsonString(jsonStructureShape(JSON.parse(bodyText))), "utf8"),
    );
  } catch {
    return undefined;
  }
}

function jsonStructureShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => jsonStructureShape(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, jsonStructureShape((value as Record<string, unknown>)[key])]),
    );
  }
  return typeof value;
}
