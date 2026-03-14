import {
  bodyPayloadFromUtf8,
  createBodyPayload,
  createHeaderEntry,
  type BodyPayload as BrowserBodyPayload,
  type BrowserCoreEngine,
  type HeaderEntry,
  type SessionTransportRequest,
  type SessionTransportResponse,
  type SessionRef,
} from "@opensteer/browser-core";
import type {
  OpensteerRequestBodyInput,
  OpensteerRequestExecuteInput,
  OpensteerRequestExecuteOutput,
  OpensteerRequestPlanParameter,
  OpensteerRequestPlanPayload,
} from "@opensteer/protocol";

import type {
  RequestPlanRecord,
  RequestPlanRegistryStore,
  RequestPlanFreshness,
} from "../../../registry.js";
import {
  entriesFromScalarMap,
  headerValue,
  normalizeHeaderName,
  parseMimeType,
  parseStructuredResponseData,
  stringifyRequestScalar,
  toProtocolRequestResponseResult,
  toProtocolRequestTransportResult,
} from "../../shared.js";

export async function executeSessionHttpRequest(input: {
  readonly engine: BrowserCoreEngine;
  readonly registry: RequestPlanRegistryStore;
  readonly sessionRef: SessionRef;
  readonly request: OpensteerRequestExecuteInput;
}): Promise<OpensteerRequestExecuteOutput> {
  const plan = await resolveRequestPlan(input.registry, input.request.key, input.request.version);
  if (plan.payload.transport.kind !== "session-http") {
    throw new Error(
      `request plan ${plan.key}@${plan.version} uses unsupported transport ${plan.payload.transport.kind}`,
    );
  }

  const transportRequest = buildSessionTransportRequest(plan, input.request);
  const transportResponse = (
    await input.engine.executeRequest({
      sessionRef: input.sessionRef,
      request: transportRequest,
    })
  ).data;

  const validateResponse = input.request.validateResponse ?? true;
  if (validateResponse) {
    assertResponseMatchesPlan(plan, transportResponse);
    await input.registry.updateMetadata({
      id: plan.id,
      freshness: touchFreshness(plan.freshness),
    });
  }

  const data = parseStructuredResponseData(transportResponse);
  return {
    plan: {
      id: plan.id,
      key: plan.key,
      version: plan.version,
    },
    request: toProtocolRequestTransportResult(transportRequest),
    response: toProtocolRequestResponseResult(transportResponse),
    ...(data === undefined ? {} : { data }),
  };
}

async function resolveRequestPlan(
  registry: RequestPlanRegistryStore,
  key: string,
  version: string | undefined,
): Promise<RequestPlanRecord> {
  const plan = await registry.resolve({
    key,
    ...(version === undefined ? {} : { version }),
  });
  if (plan === undefined) {
    throw new Error(
      version === undefined
        ? `request plan ${key} was not found`
        : `request plan ${key}@${version} was not found`,
    );
  }
  return plan;
}

function buildSessionTransportRequest(
  plan: RequestPlanRecord,
  input: OpensteerRequestExecuteInput,
): SessionTransportRequest {
  const payload = plan.payload;
  const parameters = payload.parameters ?? [];

  const pathParameters = parameters.filter((parameter) => parameter.in === "path");
  const queryParameters = parameters.filter((parameter) => parameter.in === "query");
  const headerParameters = parameters.filter((parameter) => parameter.in === "header");

  const resolvedPathParameters = resolveParameterValues(pathParameters, input.params, "params");
  const resolvedQueryParameters = resolveParameterValues(queryParameters, input.query, "query");
  const resolvedHeaderParameters = resolveParameterValues(headerParameters, input.headers, "headers");

  let url = payload.endpoint.urlTemplate;
  for (const [name, value] of resolvedPathParameters.entries()) {
    url = url.replaceAll(`{${name}}`, encodeURIComponent(value));
  }

  const targetUrl = new URL(url);
  for (const entry of payload.endpoint.defaultQuery ?? []) {
    targetUrl.searchParams.set(entry.name, entry.value);
  }
  for (const parameter of queryParameters) {
    const value = resolvedQueryParameters.get(parameter.name);
    if (value !== undefined) {
      targetUrl.searchParams.set(parameter.wireName ?? parameter.name, value);
    }
  }

  const headers: HeaderEntry[] = (payload.endpoint.defaultHeaders ?? []).map((header) =>
    createHeaderEntry(header.name, header.value),
  );
  for (const parameter of headerParameters) {
    const value = resolvedHeaderParameters.get(parameter.name);
    if (value !== undefined) {
      setHeader(headers, parameter.wireName ?? parameter.name, value);
    }
  }

  const requestBody = buildRequestBody(input.body, payload);
  if (requestBody.contentType !== undefined && headerValue(headers, "content-type") === undefined) {
    headers.push(createHeaderEntry("content-type", requestBody.contentType));
  }

  return {
    method: payload.endpoint.method,
    url: targetUrl.toString(),
    ...(headers.length === 0 ? {} : { headers }),
    ...(requestBody.body === undefined ? {} : { body: requestBody.body }),
  };
}

function resolveParameterValues(
  parameters: readonly OpensteerRequestPlanParameter[],
  values: Readonly<Record<string, string | number | boolean>> | undefined,
  fieldName: "params" | "query" | "headers",
): ReadonlyMap<string, string> {
  const normalizedValues = new Map(entriesFromScalarMap(values).map((entry) => [entry.name, entry.value]));
  const knownParameters = new Set(parameters.map((parameter) => parameter.name));
  for (const name of normalizedValues.keys()) {
    if (!knownParameters.has(name)) {
      throw new Error(`unknown ${fieldName} input "${name}" for request plan`);
    }
  }

  const resolved = new Map<string, string>();
  for (const parameter of parameters) {
    const value = normalizedValues.get(parameter.name) ?? parameter.defaultValue;
    if (value === undefined) {
      if (parameter.required ?? parameter.in === "path") {
        throw new Error(`missing required ${parameter.in} parameter "${parameter.name}"`);
      }
      continue;
    }
    resolved.set(parameter.name, value);
  }

  return resolved;
}

function buildRequestBody(
  body: OpensteerRequestBodyInput | undefined,
  plan: OpensteerRequestPlanPayload,
): {
  readonly body?: BrowserBodyPayload;
  readonly contentType?: string;
} {
  if (body === undefined) {
    if (plan.body?.required) {
      throw new Error(`request plan ${plan.endpoint.method} ${plan.endpoint.urlTemplate} requires a request body`);
    }
    return {};
  }

  if ("json" in body) {
    const contentType = body.contentType ?? plan.body?.contentType ?? "application/json; charset=utf-8";
    return {
      body: bodyPayloadFromUtf8(JSON.stringify(body.json), parseMimeType(contentType)),
      contentType,
    };
  }

  if ("text" in body) {
    const contentType = body.contentType ?? plan.body?.contentType ?? "text/plain; charset=utf-8";
    return {
      body: bodyPayloadFromUtf8(body.text, parseMimeType(contentType)),
      contentType,
    };
  }

  const contentType = body.contentType ?? plan.body?.contentType;
  return {
    body: createBodyPayload(new Uint8Array(Buffer.from(body.base64, "base64")), parseMimeType(contentType)),
    ...(contentType === undefined ? {} : { contentType }),
  };
}

function assertResponseMatchesPlan(
  plan: RequestPlanRecord,
  response: SessionTransportResponse,
): void {
  const expectation = plan.payload.response;
  if (expectation === undefined) {
    return;
  }

  const expectedStatuses = Array.isArray(expectation.status)
    ? expectation.status
    : [expectation.status];
  if (!expectedStatuses.includes(response.status)) {
    throw new Error(
      `request plan ${plan.key}@${plan.version} expected status ${expectedStatuses.join(", ")} but received ${String(response.status)}`,
    );
  }

  if (expectation.contentType !== undefined) {
    const actualContentType =
      parseMimeType(headerValue(response.headers, "content-type") ?? response.body?.mimeType).mimeType?.toLowerCase();
    const expectedContentType =
      parseMimeType(expectation.contentType).mimeType?.toLowerCase() ??
      expectation.contentType.toLowerCase();
    if (actualContentType !== expectedContentType) {
      throw new Error(
        `request plan ${plan.key}@${plan.version} expected content-type ${expectedContentType} but received ${actualContentType ?? "none"}`,
      );
    }
  }
}

function setHeader(headers: HeaderEntry[], name: string, value: string): void {
  const normalized = normalizeHeaderName(name);
  const existingIndex = headers.findIndex((header) => normalizeHeaderName(header.name) === normalized);
  if (existingIndex === -1) {
    headers.push(createHeaderEntry(name, value));
    return;
  }

  headers.splice(existingIndex, 1, createHeaderEntry(headers[existingIndex]!.name, value));
}

function touchFreshness(freshness: RequestPlanFreshness | undefined): RequestPlanFreshness {
  return {
    ...(freshness?.staleAt === undefined ? {} : { staleAt: freshness.staleAt }),
    ...(freshness?.expiresAt === undefined ? {} : { expiresAt: freshness.expiresAt }),
    lastValidatedAt: Date.now(),
  };
}
