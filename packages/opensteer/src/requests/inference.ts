import type {
  NetworkQueryRecord,
  OpensteerInferRequestPlanInput,
  OpensteerRequestEntry,
  OpensteerRequestPlanAuth,
  OpensteerWriteRequestPlanInput,
} from "@opensteer/protocol";

import { headerValue, isSecretHeaderName, normalizeHeaderName } from "./shared.js";
import { normalizeRequestPlanPayload } from "./plans/index.js";

const IGNORED_DEFAULT_HEADER_NAMES = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "cookie",
  "host",
  "origin",
  "referer",
  "set-cookie",
]);

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
    headerValue(record.record.requestHeaders, "content-type") ?? record.record.requestBody?.mimeType;
  const responseContentType =
    headerValue(record.record.responseHeaders, "content-type") ?? record.record.responseBody?.mimeType;
  const defaultHeaders = inferDefaultHeaders(record);
  const auth = inferAuth(record.record.requestHeaders);

  const payload = normalizeRequestPlanPayload({
    transport: {
      kind: "session-http",
    },
    endpoint: {
      method: record.record.method,
      urlTemplate: `${url.origin}${url.pathname}`,
      ...(defaultQuery.length === 0 ? {} : { defaultQuery }),
      ...(defaultHeaders.length === 0 ? {} : { defaultHeaders }),
    },
    ...(requestContentType === undefined && record.record.requestBody === undefined
      ? {}
      : {
          body: {
            ...(requestContentType === undefined ? {} : { contentType: requestContentType }),
            required: true,
          },
        }),
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
    lifecycle: input.lifecycle ?? "draft",
    provenance: {
      source: record.source === "saved" ? "saved-network-record" : "live-network-record",
      sourceId: record.recordId,
      ...(record.source === "saved"
        ? record.savedAt === undefined
          ? {}
          : { capturedAt: record.savedAt }
        : options.observedAt === undefined
          ? {}
          : { capturedAt: options.observedAt }),
    },
    payload,
    ...(record.tags === undefined || record.tags.length === 0 ? {} : { tags: record.tags }),
  };
}

function inferDefaultHeaders(record: NetworkQueryRecord): readonly OpensteerRequestEntry[] {
  return record.record.requestHeaders
    .filter((header) => {
      const normalized = normalizeHeaderName(header.name);
      if (IGNORED_DEFAULT_HEADER_NAMES.has(normalized)) {
        return false;
      }
      if (isSecretHeaderName(normalized)) {
        return false;
      }
      return true;
    })
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
