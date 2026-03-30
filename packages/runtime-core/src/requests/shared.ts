import type {
  BodyPayload as BrowserBodyPayload,
  HeaderEntry as BrowserHeaderEntry,
  NetworkRecord as BrowserNetworkRecord,
  SessionTransportRequest,
  SessionTransportResponse,
} from "@opensteer/browser-core";
import {
  createBodyPayload,
  createHeaderEntry,
  type BodyPayload as ProtocolBodyPayload,
  type HeaderEntry as ProtocolHeaderEntry,
  type NetworkRecord as ProtocolNetworkRecord,
  type OpensteerRequestScalar,
  type OpensteerRequestScalarMap,
  type OpensteerRequestTransportResult,
  type OpensteerRequestResponseResult,
} from "@opensteer/protocol";

const REDACTED_HEADER_VALUE = "[redacted]";
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const SECRET_HEADER_NAMES = new Set([
  "api-key",
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-authorization",
]);

const NON_REPLAYABLE_INFERRED_HEADER_NAMES = new Set([
  "accept-encoding",
  "accept-language",
  "connection",
  "content-length",
  "host",
  "origin",
  "priority",
  "referer",
  "user-agent",
  "csrf-token",
  "x-csrf-token",
  "x-csrftoken",
  "x-xsrf-token",
]);

const HOP_BY_HOP_HEADER_NAMES = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function normalizeHeaderName(name: string): string {
  return name.trim().toLowerCase();
}

export function isValidHttpHeaderName(name: string): boolean {
  const normalized = name.trim();
  return (
    normalized.length > 0 &&
    !normalized.startsWith(":") &&
    HTTP_HEADER_NAME_PATTERN.test(normalized)
  );
}

export function isSecretHeaderName(name: string): boolean {
  return SECRET_HEADER_NAMES.has(normalizeHeaderName(name));
}

export function isReplayableInferredHeaderName(name: string): boolean {
  const normalized = normalizeHeaderName(name);
  if (!isValidHttpHeaderName(name)) {
    return false;
  }
  if (isSecretHeaderName(normalized)) {
    return false;
  }
  if (HOP_BY_HOP_HEADER_NAMES.has(normalized)) {
    return false;
  }
  if (NON_REPLAYABLE_INFERRED_HEADER_NAMES.has(normalized)) {
    return false;
  }
  if (normalized.startsWith("sec-") || normalized.startsWith("proxy-")) {
    return false;
  }
  return true;
}

export function redactHeaderEntries(
  entries: readonly BrowserHeaderEntry[] | readonly ProtocolHeaderEntry[],
): ProtocolHeaderEntry[] {
  return entries.map((entry) =>
    isSecretHeaderName(entry.name)
      ? createHeaderEntry(entry.name, REDACTED_HEADER_VALUE)
      : createHeaderEntry(entry.name, entry.value),
  );
}

export function toProtocolBodyPayload(body: BrowserBodyPayload): ProtocolBodyPayload {
  return createBodyPayload(Buffer.from(body.bytes).toString("base64"), {
    encoding: body.encoding,
    ...(body.mimeType === undefined ? {} : { mimeType: body.mimeType }),
    ...(body.charset === undefined ? {} : { charset: body.charset }),
    truncated: body.truncated,
    ...(body.originalByteLength === undefined
      ? {}
      : { originalByteLength: body.originalByteLength }),
  });
}

export function toProtocolNetworkRecord(
  record: BrowserNetworkRecord,
  options: {
    readonly redactSecretHeaders?: boolean;
  } = {},
): ProtocolNetworkRecord {
  const headers = (options.redactSecretHeaders ?? false) ? redactHeaderEntries : cloneHeaders;
  const requestBody =
    record.requestBody === undefined ? undefined : toProtocolBodyPayload(record.requestBody);
  const responseBody =
    record.responseBody === undefined ? undefined : toProtocolBodyPayload(record.responseBody);

  return {
    kind: record.kind,
    requestId: record.requestId,
    sessionRef: record.sessionRef,
    ...(record.pageRef === undefined ? {} : { pageRef: record.pageRef }),
    ...(record.frameRef === undefined ? {} : { frameRef: record.frameRef }),
    ...(record.documentRef === undefined ? {} : { documentRef: record.documentRef }),
    method: record.method,
    url: record.url,
    requestHeaders: headers(record.requestHeaders),
    responseHeaders: headers(record.responseHeaders),
    ...(record.status === undefined ? {} : { status: record.status }),
    ...(record.statusText === undefined ? {} : { statusText: record.statusText }),
    resourceType: record.resourceType,
    ...(record.redirectFromRequestId === undefined
      ? {}
      : { redirectFromRequestId: record.redirectFromRequestId }),
    ...(record.redirectToRequestId === undefined
      ? {}
      : { redirectToRequestId: record.redirectToRequestId }),
    navigationRequest: record.navigationRequest,
    ...(record.initiator === undefined ? {} : { initiator: record.initiator }),
    ...(record.timing === undefined ? {} : { timing: record.timing }),
    ...(record.transfer === undefined ? {} : { transfer: record.transfer }),
    ...(record.source === undefined ? {} : { source: record.source }),
    captureState: record.captureState,
    requestBodyState: record.requestBodyState,
    responseBodyState: record.responseBodyState,
    ...(record.requestBodySkipReason === undefined
      ? {}
      : { requestBodySkipReason: record.requestBodySkipReason }),
    ...(record.responseBodySkipReason === undefined
      ? {}
      : { responseBodySkipReason: record.responseBodySkipReason }),
    ...(record.requestBodyError === undefined ? {} : { requestBodyError: record.requestBodyError }),
    ...(record.responseBodyError === undefined
      ? {}
      : { responseBodyError: record.responseBodyError }),
    ...(requestBody === undefined ? {} : { requestBody }),
    ...(responseBody === undefined ? {} : { responseBody }),
  };
}

export function toProtocolRequestTransportResult(
  request: SessionTransportRequest,
): OpensteerRequestTransportResult {
  const body = request.body === undefined ? undefined : toProtocolBodyPayload(request.body);

  return {
    method: request.method,
    url: request.url,
    headers: cloneHeaders(request.headers ?? []),
    ...(body === undefined ? {} : { body }),
  };
}

export function toProtocolRequestResponseResult(
  response: SessionTransportResponse,
): OpensteerRequestResponseResult {
  const body = response.body === undefined ? undefined : toProtocolBodyPayload(response.body);

  return {
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    headers: cloneHeaders(response.headers),
    ...(body === undefined ? {} : { body }),
    redirected: response.redirected,
  };
}

export function cloneHeaders(
  headers: readonly BrowserHeaderEntry[] | readonly ProtocolHeaderEntry[],
): ProtocolHeaderEntry[] {
  return headers.map((header) => createHeaderEntry(header.name, header.value));
}

export function filterValidHttpHeaders(
  headers: readonly BrowserHeaderEntry[] | readonly ProtocolHeaderEntry[],
): ProtocolHeaderEntry[] {
  return cloneHeaders(headers).filter((header) => isValidHttpHeaderName(header.name));
}

export function stringifyRequestScalar(value: OpensteerRequestScalar): string {
  return typeof value === "string" ? value : String(value);
}

export function entriesFromScalarMap(
  values: OpensteerRequestScalarMap | undefined,
): readonly { readonly name: string; readonly value: string }[] {
  if (values === undefined) {
    return [];
  }

  return Object.entries(values).map(([name, value]) => ({
    name,
    value: stringifyRequestScalar(value),
  }));
}

export function parseMimeType(value: string | undefined): {
  readonly mimeType?: string;
  readonly charset?: string;
} {
  if (value === undefined) {
    return {};
  }

  const [mimeTypePart, ...parts] = value.split(";");
  const mimeType = mimeTypePart?.trim();
  let charset: string | undefined;
  for (const part of parts) {
    const [name, rawValue] = part.split("=");
    if (name?.trim().toLowerCase() === "charset" && rawValue) {
      charset = rawValue.trim();
    }
  }

  return {
    ...(mimeType === undefined || mimeType.length === 0 ? {} : { mimeType }),
    ...(charset === undefined || charset.length === 0 ? {} : { charset }),
  };
}

export function headerValue(
  headers: readonly BrowserHeaderEntry[] | readonly ProtocolHeaderEntry[],
  name: string,
): string | undefined {
  const normalized = normalizeHeaderName(name);
  for (const header of headers) {
    if (normalizeHeaderName(header.name) === normalized) {
      return header.value;
    }
  }
  return undefined;
}

export function decodeBodyText(body: BrowserBodyPayload | undefined): string | undefined {
  if (body === undefined) {
    return undefined;
  }

  return Buffer.from(body.bytes).toString(resolveTextEncoding(body.charset));
}

export function parseStructuredResponseData(response: SessionTransportResponse): unknown {
  const contentType = headerValue(response.headers, "content-type") ?? response.body?.mimeType;
  if (response.body === undefined || contentType === undefined) {
    return undefined;
  }

  const { mimeType } = parseMimeType(contentType);
  const normalizedMimeType = mimeType?.toLowerCase();
  const text = decodeBodyText(response.body);
  if (text === undefined) {
    return undefined;
  }

  if (normalizedMimeType === undefined) {
    return undefined;
  }

  if (normalizedMimeType === "application/json" || normalizedMimeType.endsWith("+json")) {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  if (normalizedMimeType.startsWith("text/")) {
    return text;
  }

  return undefined;
}

function resolveTextEncoding(charset: string | undefined): BufferEncoding {
  switch (charset?.trim().toLowerCase()) {
    case "ascii":
    case "latin1":
    case "utf16le":
    case "utf-16le":
      return charset.replace("-", "").toLowerCase() as BufferEncoding;
    case "utf8":
    case "utf-8":
    default:
      return "utf8";
  }
}
