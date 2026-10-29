// Derived from github.com/UsefulSoftwareCo/executor packages/plugins/openapi/src/sdk/invoke.ts (MIT).
import {
  renderAuthPlacements,
  type AdapterToolResult,
  type AuthPlacement,
} from "@opensteer/integration-core";
import { decodeResponseBody, errorResult, isAbortError, MAX_RESPONSE_BYTES } from "../shared.js";
import type { OpenApiAdapterConfig } from "./config.js";
import { openApiArgumentNames, selectsBodyMediaType } from "./extract.js";
import type { OpenApiMediaBinding, OpenApiOperation, OpenApiParameter } from "./types.js";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";

/** Arguments the operation cannot be sent with; the message says what to change. */
class InvalidArguments extends Error {}

// The upstream service validates argument values. These checks keep a call to
// the operation it names: no undeclared argument, request shape or path.
function checkArguments(operation: OpenApiOperation, args: Readonly<Record<string, unknown>>) {
  const accepted = openApiArgumentNames(operation);
  const unknown = Object.keys(args).filter((name) => !accepted.includes(name));
  if (unknown.length) {
    const named = unknown.map((name) => JSON.stringify(name)).join(", ");
    throw new InvalidArguments(
      accepted.length
        ? `${operation.name} does not take ${named}; its arguments are ${accepted.join(", ")}`
        : `${operation.name} takes no arguments; remove ${named}`,
    );
  }
  if (selectsBodyMediaType(operation) && args.contentType !== undefined) {
    const types = operation.requestBody?.contents.map(({ contentType }) => contentType) ?? [];
    if (typeof args.contentType !== "string" || !types.includes(args.contentType)) {
      throw new InvalidArguments(`contentType must be one of ${types.join(", ")}`);
    }
  }
}

// A URL parser removes `.` and `..` segments, including `%2e` spellings of the dot.
const dotSegment = /^(?:\.|%2e){1,2}$/iu;

function operationPath(operation: OpenApiOperation, args: Readonly<Record<string, unknown>>) {
  const parameters = new Map(
    operation.parameters.flatMap((parameter) =>
      parameter.location === "path" ? [[parameter.name, parameter] as const] : [],
    ),
  );
  for (const name of parameters.keys()) {
    if (args[name] === undefined) throw new InvalidArguments(`Missing path parameter ${name}`);
  }
  // One pass over the template, so a substituted value is never searched for another placeholder.
  const path = operation.path.replace(/\{([^{}]*)\}/gu, (placeholder, name: string) => {
    const parameter = parameters.get(name);
    if (!parameter) return placeholder;
    const value = pathValue(parameter, args[name]);
    if (!value) throw new InvalidArguments(`Path parameter ${name} must not be empty`);
    return value;
  });
  if (path.split(/[/\\]/u).some((segment) => dotSegment.test(segment))) {
    throw new InvalidArguments(
      `Path arguments of ${operation.name} must not form a "." or ".." segment, which would address a different path`,
    );
  }
  return path;
}

function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (["boolean", "bigint", "number"].includes(typeof value)) return String(value);
  return JSON.stringify(value);
}

function objectEntries(value: unknown): readonly [string, unknown][] {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.entries(value)
    : [];
}

function simpleValue(value: unknown, explode: boolean): string {
  if (Array.isArray(value)) return value.map(scalar).join(",");
  const entries = objectEntries(value);
  if (entries.length) {
    return entries
      .flatMap(([key, entry]) => (explode ? [`${key}=${scalar(entry)}`] : [key, scalar(entry)]))
      .join(",");
  }
  return scalar(value);
}

function pathValue(parameter: OpenApiParameter, value: unknown): string {
  const style = parameter.style ?? "simple";
  const explode = parameter.explode ?? false;
  const encoded = simpleValue(value, explode)
    .split(",")
    .map((part) => encodeURIComponent(part))
    .join(",");
  if (style === "label") return `.${encoded}`;
  if (style === "matrix") {
    if (Array.isArray(value) && explode)
      return value
        .map((entry) => `;${parameter.name}=${encodeURIComponent(scalar(entry))}`)
        .join("");
    const entries = objectEntries(value);
    if (entries.length && explode)
      return entries
        .map(([key, entry]) => `;${encodeURIComponent(key)}=${encodeURIComponent(scalar(entry))}`)
        .join("");
    return `;${parameter.name}=${encoded}`;
  }
  return encoded;
}

function encodeQueryPart(value: string, allowReserved: boolean): string {
  const encoded = encodeURIComponent(value);
  if (!allowReserved) return encoded;
  return encoded.replaceAll(
    /%(?:3A|2F|3F|23|5B|5D|40|21|24|26|27|28|29|2A|2B|2C|3B|3D)/giu,
    (part) => decodeURIComponent(part),
  );
}

function appendQueryPair(url: URL, name: string, value: string, allowReserved: boolean): void {
  const pair = `${encodeURIComponent(name)}=${encodeQueryPart(value, allowReserved)}`;
  url.search = url.search ? `${url.search}&${pair}` : `?${pair}`;
}

function setQueryPair(url: URL, name: string, value: string): void {
  const encodedName = encodeURIComponent(name);
  const retained = url.search
    .slice(1)
    .split("&")
    .filter((pair) => pair && pair.split("=", 1)[0] !== encodedName);
  retained.push(`${encodedName}=${encodeQueryPart(value, false)}`);
  url.search = `?${retained.join("&")}`;
}

function appendQuery(url: URL, parameter: OpenApiParameter, value: unknown): void {
  const style = parameter.style ?? "form";
  const explode = parameter.explode ?? style === "form";
  const append = (name: string, entry: unknown) =>
    appendQueryPair(url, name, scalar(entry), parameter.allowReserved ?? false);
  if (style === "deepObject") {
    for (const [key, entry] of objectEntries(value)) append(`${parameter.name}[${key}]`, entry);
    return;
  }
  if (Array.isArray(value)) {
    if (style === "spaceDelimited" || style === "pipeDelimited") {
      append(parameter.name, value.map(scalar).join(style === "spaceDelimited" ? " " : "|"));
    } else if (explode) {
      for (const entry of value) append(parameter.name, entry);
    } else append(parameter.name, value.map(scalar).join(","));
    return;
  }
  const entries = objectEntries(value);
  if (entries.length) {
    if (explode) for (const [key, entry] of entries) append(key, entry);
    else append(parameter.name, entries.flatMap(([key, entry]) => [key, scalar(entry)]).join(","));
    return;
  }
  append(parameter.name, value);
}

function formPairs(
  name: string,
  value: unknown,
  encoding: Readonly<Record<string, unknown>> | undefined,
): readonly [string, string][] {
  const explode = typeof encoding?.explode === "boolean" ? encoding.explode : true;
  if (Array.isArray(value)) {
    return explode
      ? value.map((entry) => [name, scalar(entry)])
      : [[name, value.map(scalar).join(",")]];
  }
  const entries = objectEntries(value);
  if (entries.length) {
    return explode
      ? entries.map(([key, entry]) => [key, scalar(entry)])
      : [[name, entries.flatMap(([key, entry]) => [key, scalar(entry)]).join(",")]];
  }
  return [[name, scalar(value)]];
}

function serializeFormUrlEncoded(body: unknown, media: OpenApiMediaBinding): string {
  return objectEntries(body)
    .flatMap(([name, value]) =>
      formPairs(name, value, media.encoding?.[name]).map(([key, entry]) => {
        const allowReserved = media.encoding?.[name]?.allowReserved === true;
        return `${encodeURIComponent(key)}=${encodeQueryPart(entry, allowReserved)}`;
      }),
    )
    .join("&");
}

function toFormData(body: unknown, media: OpenApiMediaBinding): FormData {
  const form = new FormData();
  for (const [name, value] of objectEntries(body)) {
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      const file = objectEntries(entry).length ? (entry as Record<string, unknown>) : undefined;
      if (file && typeof file.dataBase64 === "string") {
        const bytes = Buffer.from(file.dataBase64, "base64");
        const contentType =
          (typeof file.contentType === "string" && file.contentType) ||
          (typeof media.encoding?.[name]?.contentType === "string"
            ? media.encoding[name].contentType
            : "application/octet-stream");
        form.append(
          name,
          new Blob([bytes], { type: contentType }),
          typeof file.filename === "string" ? file.filename : "upload",
        );
      } else if (typeof entry === "object" && entry !== null)
        form.append(name, JSON.stringify(entry));
      else form.append(name, scalar(entry));
    }
  }
  return form;
}

function requestBody(
  operation: OpenApiOperation,
  args: Readonly<Record<string, unknown>>,
  headers: Headers,
): RequestInit["body"] | undefined {
  if (!operation.requestBody || args.body === undefined) return undefined;
  const requestedType =
    selectsBodyMediaType(operation) && typeof args.contentType === "string"
      ? args.contentType
      : undefined;
  const media =
    operation.requestBody.contents.find((candidate) => candidate.contentType === requestedType) ??
    operation.requestBody.contents[0];
  if (!media) return undefined;
  const contentType = media.contentType.toLowerCase();
  if (contentType.startsWith("multipart/form-data")) return toFormData(args.body, media);
  headers.set("content-type", media.contentType);
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    return serializeFormUrlEncoded(args.body, media);
  }
  if (contentType.includes("json")) return JSON.stringify(args.body);
  if (contentType === "application/octet-stream" && typeof args.body === "string") {
    return Buffer.from(args.body, "base64");
  }
  return typeof args.body === "string" ? args.body : JSON.stringify(args.body);
}

export function openApiOperationServer(
  config: OpenApiAdapterConfig,
  operation: OpenApiOperation,
): string {
  const server = config.baseUrl ?? operation.servers[0];
  if (!server) throw new TypeError(`Operation ${operation.operationId} has no server URL`);
  return server;
}

function baseUrlForPath(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/u, "");
  base.pathname = `${basePath}/${path.replace(/^\/+/, "")}`;
  return base;
}

export interface BuiltOpenApiRequest {
  readonly init: RequestInit;
  readonly url: string;
}

function buildOpenApiRequest(input: {
  readonly args: Readonly<Record<string, unknown>>;
  readonly config: OpenApiAdapterConfig;
  readonly credentialValues: Readonly<Record<string, string>>;
  readonly operation: OpenApiOperation;
  readonly placements: readonly AuthPlacement[];
}): BuiltOpenApiRequest {
  checkArguments(input.operation, input.args);
  const path = operationPath(input.operation, input.args);
  const rendered = renderAuthPlacements(input.placements, input.credentialValues);
  const baseUrl = openApiOperationServer(input.config, input.operation);
  const url = baseUrlForPath(baseUrl, path);
  const headers = new Headers();
  const cookies: string[] = [];
  for (const parameter of input.operation.parameters) {
    const value = input.args[parameter.name];
    if (value === undefined || parameter.location === "path") continue;
    if (parameter.location === "query") appendQuery(url, parameter, value);
    else if (parameter.location === "header")
      headers.set(parameter.name, simpleValue(value, parameter.explode ?? false));
    else cookies.push(`${parameter.name}=${encodeURIComponent(scalar(value))}`);
  }
  if (cookies.length) headers.set("cookie", cookies.join("; "));
  // Avoid URLSearchParams here: mutating it reserializes every existing pair and
  // defeats OpenAPI's allowReserved=true behavior on operation parameters.
  for (const [name, value] of Object.entries(rendered.query)) {
    setQueryPair(url, name, value);
  }
  // Last, so a credential header (a cookie included) replaces any argument of that name.
  for (const [name, value] of Object.entries(rendered.headers)) headers.set(name, value);
  const body = requestBody(input.operation, input.args, headers);
  return {
    url: url.toString(),
    init: {
      method: input.operation.method.toUpperCase(),
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(input.config.timeoutMs),
    },
  };
}

export async function invokeOpenApiOperation(input: {
  readonly args: Readonly<Record<string, unknown>>;
  readonly config: OpenApiAdapterConfig;
  readonly credentialValues: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
  readonly operation: OpenApiOperation;
  readonly placements: readonly AuthPlacement[];
}): Promise<AdapterToolResult> {
  let request: BuiltOpenApiRequest;
  try {
    request = buildOpenApiRequest(input);
  } catch (cause) {
    if (cause instanceof InvalidArguments) return errorResult("invalid_arguments", cause.message);
    return errorResult(
      "connection_rejected",
      cause instanceof Error ? cause.message : "Credential rendering failed",
    );
  }
  try {
    const response = await (input.fetch ?? globalThis.fetch)(request.url, request.init);
    const bytes = await readBoundedResponse(response, {
      maximumBytes: MAX_RESPONSE_BYTES,
      sizeError: () =>
        new RangeError(`Upstream response exceeded the ${MAX_RESPONSE_BYTES}-byte limit`),
    });
    const value = decodeResponseBody(response, bytes);
    if (response.status === 401) {
      return errorResult("connection_rejected", "The upstream service rejected the connection", {
        status: response.status,
        body: value,
      });
    }
    if (response.status === 403) {
      const challenge = response.headers.get("www-authenticate") ?? "";
      if (/insufficient_scope/iu.test(challenge)) {
        return errorResult("oauth_scope_insufficient", "The OAuth grant lacks a required scope", {
          status: response.status,
        });
      }
    }
    if (!response.ok) {
      return errorResult("upstream_http_error", `Upstream returned HTTP ${response.status}`, {
        body: value,
        status: response.status,
      });
    }
    if (input.config.responseProfile === "slack") {
      const envelope =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
      if (typeof envelope?.ok !== "boolean")
        return errorResult(
          "upstream_http_error",
          "The service did not return a valid Slack response",
          { status: response.status, outcomeUnknown: true },
        );
      if (!envelope.ok)
        return errorResult(
          "upstream_http_error",
          typeof envelope.error === "string"
            ? `Slack rejected the operation: ${envelope.error}`
            : "Slack rejected the operation",
          { status: response.status, body: value },
        );
    }
    return { kind: "ok", value };
  } catch (cause) {
    if (isAbortError(cause))
      return errorResult("upstream_timeout", "The upstream request timed out", {
        outcomeUnknown: true,
      });
    return errorResult(
      "upstream_http_error",
      cause instanceof Error ? cause.message : "Upstream request failed",
      { outcomeUnknown: true },
    );
  }
}
