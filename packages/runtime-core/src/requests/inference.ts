import type {
  JsonValue,
  NetworkQueryRecord,
  OpensteerInferRequestPlanInput,
  OpensteerRequestEntry,
  OpensteerRequestPlanAuth,
  OpensteerWriteRequestPlanInput,
} from "@opensteer/protocol";

import {
  headerValue,
  isReplayableInferredHeaderName,
  isSecretHeaderName,
  normalizeHeaderName,
} from "./shared.js";
import { normalizeRequestPlanPayload } from "./plans/index.js";

export function inferRequestPlanFromNetworkRecord(
  record: NetworkQueryRecord,
  input: OpensteerInferRequestPlanInput,
  options: {
    readonly observedAt?: number;
  } = {},
): OpensteerWriteRequestPlanInput {
  const url = new URL(record.record.url);
  const defaultQuery = Array.from(url.searchParams.entries()).map(
    ([name, value]) =>
      ({
        name,
        value,
      }) satisfies OpensteerRequestEntry,
  );
  const requestContentType =
    headerValue(record.record.requestHeaders, "content-type") ??
    record.record.requestBody?.mimeType;
  const responseContentType =
    headerValue(record.record.responseHeaders, "content-type") ??
    record.record.responseBody?.mimeType;
  const defaultHeaders = inferDefaultHeaders(record);
  const auth = inferAuth(record.record.requestHeaders);
  const body = inferRequestPlanBody(record.record.requestBody, requestContentType);

  const payload = normalizeRequestPlanPayload({
    transport: {
      kind: input.transport ?? "context-http",
    },
    endpoint: {
      method: record.record.method,
      urlTemplate: `${url.origin}${url.pathname}`,
      ...(defaultQuery.length === 0 ? {} : { defaultQuery }),
      ...(defaultHeaders.length === 0 ? {} : { defaultHeaders }),
    },
    ...(body === undefined ? {} : { body }),
    ...(record.record.status === undefined
      ? {}
      : {
          response: {
            status: record.record.status,
            ...(responseContentType === undefined ? {} : { contentType: responseContentType }),
          },
        }),
    ...(auth === undefined ? {} : { auth }),
  });

  return {
    key: input.key,
    version: input.version,
    provenance: {
      source: record.savedAt === undefined ? "network-record" : "saved-network-record",
      sourceId: record.recordId,
      ...(record.savedAt === undefined
        ? options.observedAt === undefined
          ? {}
          : { capturedAt: options.observedAt }
        : { capturedAt: record.savedAt }),
    },
    payload,
    ...(record.tags === undefined || record.tags.length === 0 ? {} : { tags: record.tags }),
  };
}

function inferDefaultHeaders(record: NetworkQueryRecord): readonly OpensteerRequestEntry[] {
  return record.record.requestHeaders
    .filter((header) => isReplayableInferredHeaderName(header.name))
    .map((header) => ({
      name: header.name,
      value: header.value,
    }));
}

function inferAuth(
  headers: readonly {
    readonly name: string;
    readonly value: string;
  }[],
): OpensteerRequestPlanAuth | undefined {
  const names = new Set(headers.map((header) => normalizeHeaderName(header.name)));
  if (names.has("authorization")) {
    return {
      strategy: "bearer-token",
      description: "Inferred from an Authorization header on the captured request.",
    };
  }
  if (names.has("api-key") || names.has("x-api-key") || names.has("x-auth-token")) {
    return {
      strategy: "api-key",
      description: "Inferred from an API key style header on the captured request.",
    };
  }
  if (names.has("cookie")) {
    return {
      strategy: "session-cookie",
      description: "Inferred from a Cookie header on the captured request.",
    };
  }
  if (Array.from(names).some((name) => isSecretHeaderName(name))) {
    return {
      strategy: "custom",
      description: "Inferred from redacted secret headers on the captured request.",
    };
  }
  return undefined;
}

function inferRequestPlanBody(
  body: NetworkQueryRecord["record"]["requestBody"] | undefined,
  contentType: string | undefined,
): OpensteerWriteRequestPlanInput["payload"]["body"] | undefined {
  if (body === undefined) {
    return undefined;
  }

  const text = Buffer.from(body.data, "base64").toString("utf8");
  const normalizedContentType = contentType?.toLowerCase();
  const trimmedText = text.trim();
  const parsedJson = parseJsonBody(trimmedText);

  if (
    normalizedContentType?.includes("application/json") === true ||
    normalizedContentType?.includes("+json") === true ||
    parsedJson !== undefined
  ) {
    return {
      kind: "json",
      required: true,
      ...(contentType === undefined ? {} : { contentType }),
      template: parsedJson ?? text,
    };
  }

  if (normalizedContentType?.includes("application/x-www-form-urlencoded") === true) {
    return {
      kind: "form",
      required: true,
      ...(contentType === undefined ? {} : { contentType }),
      fields: Array.from(new URLSearchParams(text).entries()).map(([name, value]) => ({
        name,
        value,
      })),
    };
  }

  return {
    kind: "text",
    required: true,
    ...(contentType === undefined ? {} : { contentType }),
    template: text,
  };
}

function parseJsonBody(value: string): JsonValue | undefined {
  if (value.length === 0 || (!value.startsWith("{") && !value.startsWith("["))) {
    return undefined;
  }

  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return undefined;
  }
}
