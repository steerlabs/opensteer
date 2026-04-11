import type { HeaderEntry } from "./network.js";
import {
  bodyPayloadSchema,
  headerEntrySchema,
  networkResourceTypeSchema,
  type BodyPayload,
  type NetworkQueryRecord,
  type NetworkResourceType,
} from "./network.js";
import type { JsonSchema, JsonValue } from "./json.js";
import { pageRefSchema, type PageRef } from "./identity.js";
import { cookieRecordSchema, storageEntrySchema } from "./storage.js";
import type { CookieRecord, StorageEntry } from "./storage.js";
import {
  arraySchema,
  defineSchema,
  enumSchema,
  integerSchema,
  objectSchema,
  oneOfSchema,
  recordSchema,
  stringSchema,
} from "./json.js";

export type OpensteerRequestScalar = string | number | boolean;
export type TransportKind =
  | "direct-http"
  | "matched-tls"
  | "context-http"
  | "page-http"
  | "session-http";

export interface OpensteerRequestEntry {
  readonly name: string;
  readonly value: string;
}

export type OpensteerRequestParameterLocation = "path" | "query" | "header";

export interface OpensteerRequestPlanParameter {
  readonly name: string;
  readonly in: OpensteerRequestParameterLocation;
  readonly wireName?: string;
  readonly required?: boolean;
  readonly description?: string;
  readonly defaultValue?: string;
}

export interface OpensteerRequestPlanTransport {
  readonly kind: TransportKind;
  readonly requiresBrowser?: boolean;
  readonly requireSameOrigin?: boolean;
  readonly cookieJar?: string;
}

export interface OpensteerRequestPlanEndpoint {
  readonly method: string;
  readonly urlTemplate: string;
  readonly defaultQuery?: readonly OpensteerRequestEntry[];
  readonly defaultHeaders?: readonly OpensteerRequestEntry[];
}

export type OpensteerRequestPlanBodyKind = "json" | "form" | "text";

export interface OpensteerRequestPlanBody {
  readonly kind?: OpensteerRequestPlanBodyKind;
  readonly contentType?: string;
  readonly required?: boolean;
  readonly description?: string;
  readonly template?: JsonValue | string;
  readonly fields?: readonly OpensteerRequestEntry[];
}

export interface OpensteerRequestPlanResponseExpectation {
  readonly status: number | readonly number[];
  readonly contentType?: string;
}

export interface OpensteerRequestFailurePolicyHeaderMatch {
  readonly name: string;
  readonly valueIncludes: string;
}

export interface OpensteerRequestFailurePolicy {
  readonly statusCodes?: readonly number[];
  readonly finalUrlIncludes?: readonly string[];
  readonly responseHeaders?: readonly OpensteerRequestFailurePolicyHeaderMatch[];
  readonly responseBodyIncludes?: readonly string[];
}

export interface OpensteerRequestRetryBackoffPolicy {
  readonly strategy?: "fixed" | "exponential";
  readonly delayMs: number;
  readonly maxDelayMs?: number;
}

export interface OpensteerRequestRetryPolicy {
  readonly maxRetries: number;
  readonly backoff?: OpensteerRequestRetryBackoffPolicy;
  readonly respectRetryAfter?: boolean;
  readonly failurePolicy?: OpensteerRequestFailurePolicy;
}

export interface OpensteerRequestPlanAuth {
  readonly strategy: "session-cookie" | "bearer-token" | "api-key" | "custom";
  readonly failurePolicy?: OpensteerRequestFailurePolicy;
  readonly description?: string;
}

export interface OpensteerRequestPlanPayload {
  readonly transport: OpensteerRequestPlanTransport;
  readonly endpoint: OpensteerRequestPlanEndpoint;
  readonly parameters?: readonly OpensteerRequestPlanParameter[];
  readonly body?: OpensteerRequestPlanBody;
  readonly response?: OpensteerRequestPlanResponseExpectation;
  readonly retryPolicy?: OpensteerRequestRetryPolicy;
  readonly auth?: OpensteerRequestPlanAuth;
}

export interface OpensteerRegistryProvenance {
  readonly source: string;
  readonly sourceId?: string;
  readonly capturedAt?: number;
  readonly notes?: string;
}

export interface OpensteerRequestPlanFreshness {
  readonly lastValidatedAt?: number;
  readonly staleAt?: number;
  readonly expiresAt?: number;
}

export interface OpensteerRequestPlanRecord {
  readonly id: string;
  readonly key: string;
  readonly version: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly contentHash: string;
  readonly tags: readonly string[];
  readonly provenance?: OpensteerRegistryProvenance;
  readonly freshness?: OpensteerRequestPlanFreshness;
  readonly payload: OpensteerRequestPlanPayload;
}

export interface OpensteerNetworkQueryInput {
  readonly pageRef?: PageRef;
  readonly recordId?: string;
  readonly requestId?: string;
  readonly capture?: string;
  readonly tag?: string;
  readonly url?: string;
  readonly hostname?: string;
  readonly path?: string;
  readonly method?: string;
  readonly status?: string | number;
  readonly resourceType?: NetworkResourceType;
  readonly includeBodies?: boolean;
  readonly json?: boolean;
  readonly before?: string;
  readonly after?: string;
  readonly limit?: number;
}

export interface OpensteerGraphqlSummary {
  readonly operationType?: "query" | "mutation" | "subscription" | "unknown";
  readonly operationName?: string;
  readonly persisted?: boolean;
}

export interface OpensteerNetworkBodySummary {
  readonly bytes?: number;
  readonly contentType?: string;
  readonly streaming?: boolean;
}

export interface OpensteerNetworkSummaryRecord {
  readonly recordId: string;
  readonly capture?: string;
  readonly savedAt?: number;
  readonly kind: NetworkQueryRecord["record"]["kind"];
  readonly method: string;
  readonly status?: number;
  readonly resourceType: NetworkResourceType;
  readonly url: string;
  readonly request?: OpensteerNetworkBodySummary;
  readonly response?: OpensteerNetworkBodySummary;
  readonly graphql?: OpensteerGraphqlSummary;
  readonly websocket?: {
    readonly subprotocol?: string;
  };
}

export interface OpensteerNetworkQueryOutput {
  readonly records: readonly OpensteerNetworkSummaryRecord[];
}

export interface OpensteerParsedCookie {
  readonly name: string;
  readonly value: string;
}

export interface OpensteerStructuredBodyPreview {
  readonly contentType?: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly data?: JsonValue | string;
  readonly note?: string;
}

export interface OpensteerNetworkRedirectHop {
  readonly method: string;
  readonly status?: number;
  readonly url: string;
  readonly location?: string;
  readonly setCookie?: readonly string[];
}

export interface OpensteerNetworkDetailOutput {
  readonly recordId: string;
  readonly capture?: string;
  readonly savedAt?: number;
  readonly summary: OpensteerNetworkSummaryRecord;
  readonly requestHeaders: readonly HeaderEntry[];
  readonly responseHeaders: readonly HeaderEntry[];
  readonly cookiesSent?: readonly OpensteerParsedCookie[];
  readonly requestBody?: OpensteerStructuredBodyPreview;
  readonly responseBody?: OpensteerStructuredBodyPreview;
  readonly graphql?: OpensteerGraphqlSummary & {
    readonly variables?: JsonValue;
  };
  readonly redirectChain?: readonly OpensteerNetworkRedirectHop[];
  readonly notes?: readonly string[];
  readonly transportProbe?: {
    readonly recommended?: TransportKind;
    readonly attempts: readonly OpensteerReplayAttempt[];
  };
}

export interface OpensteerNetworkDetailInput {
  readonly recordId: string;
  readonly probe?: boolean;
}

export interface OpensteerReplayAttempt {
  readonly transport: TransportKind;
  readonly status?: number;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly note?: string;
  readonly error?: string;
}

export interface OpensteerNetworkReplayOverrides {
  readonly query?: OpensteerRequestScalarMap;
  readonly headers?: OpensteerRequestScalarMap;
  readonly body?: OpensteerRequestBodyInput;
  readonly variables?: JsonValue;
}

export interface OpensteerNetworkReplayInput extends OpensteerNetworkReplayOverrides {
  readonly recordId: string;
  readonly pageRef?: PageRef;
}

export interface OpensteerNetworkReplayOutput {
  readonly recordId: string;
  readonly transport?: TransportKind;
  readonly attempts: readonly OpensteerReplayAttempt[];
  readonly response?: OpensteerRequestResponseResult;
  readonly data?: JsonValue | string;
  readonly note?: string;
}

export type OpensteerSessionFetchTransport = "auto" | "direct" | "matched-tls" | "context" | "page";

export interface OpensteerSessionFetchInput {
  readonly pageRef?: PageRef;
  readonly url: string;
  readonly method?: string;
  readonly query?: OpensteerRequestScalarMap;
  readonly headers?: OpensteerRequestScalarMap;
  readonly body?: OpensteerRequestBodyInput;
  readonly transport?: OpensteerSessionFetchTransport;
  readonly cookies?: boolean;
  readonly followRedirects?: boolean;
}

export interface OpensteerSessionFetchOutput {
  readonly transport?: TransportKind;
  readonly attempts: readonly OpensteerReplayAttempt[];
  readonly response?: OpensteerRequestResponseResult;
  readonly data?: JsonValue | string;
  readonly note?: string;
}

export interface OpensteerCookieQueryInput {
  readonly domain?: string;
}

export interface OpensteerCookieQueryOutput {
  readonly domain?: string;
  readonly cookies: readonly CookieRecord[];
}

export type OpensteerStorageArea = "local" | "session";

export interface OpensteerStorageQueryInput {
  readonly domain?: string;
}

export interface OpensteerStorageDomainSnapshot {
  readonly domain: string;
  readonly localStorage: readonly StorageEntry[];
  readonly sessionStorage: readonly StorageEntry[];
}

export interface OpensteerStorageQueryOutput {
  readonly domains: readonly OpensteerStorageDomainSnapshot[];
}

export interface OpensteerHiddenField {
  readonly path: string;
  readonly name: string;
  readonly value: string;
}

export interface OpensteerStateDomainSnapshot {
  readonly domain: string;
  readonly cookies: readonly CookieRecord[];
  readonly hiddenFields: readonly OpensteerHiddenField[];
  readonly localStorage: readonly StorageEntry[];
  readonly sessionStorage: readonly StorageEntry[];
  readonly globals?: Readonly<Record<string, JsonValue>>;
}

export interface OpensteerStateQueryInput {
  readonly domain?: string;
}

export interface OpensteerStateQueryOutput {
  readonly domains: readonly OpensteerStateDomainSnapshot[];
}

export interface OpensteerNetworkTagInput {
  readonly pageRef?: PageRef;
  readonly recordId?: string;
  readonly requestId?: string;
  readonly capture?: string;
  readonly tag: string;
  readonly url?: string;
  readonly hostname?: string;
  readonly path?: string;
  readonly method?: string;
  readonly status?: string;
  readonly resourceType?: NetworkResourceType;
}

export interface OpensteerNetworkTagOutput {
  readonly taggedCount: number;
}

export interface OpensteerNetworkClearInput {
  readonly capture?: string;
  readonly tag?: string;
}

export interface OpensteerNetworkClearOutput {
  readonly clearedCount: number;
}

export interface OpensteerWriteRequestPlanInput {
  readonly id?: string;
  readonly key: string;
  readonly version: string;
  readonly tags?: readonly string[];
  readonly provenance?: OpensteerRegistryProvenance;
  readonly freshness?: OpensteerRequestPlanFreshness;
  readonly payload: OpensteerRequestPlanPayload;
}

export interface OpensteerGetRequestPlanInput {
  readonly key: string;
  readonly version?: string;
}

export interface OpensteerListRequestPlansInput {
  readonly key?: string;
}

export interface OpensteerListRequestPlansOutput {
  readonly plans: readonly OpensteerRequestPlanRecord[];
}

export type OpensteerRequestScalarMap = Readonly<Record<string, OpensteerRequestScalar>>;

export interface OpensteerJsonRequestBodyInput {
  readonly json: JsonValue;
  readonly contentType?: string;
}

export interface OpensteerTextRequestBodyInput {
  readonly text: string;
  readonly contentType?: string;
}

export interface OpensteerBase64RequestBodyInput {
  readonly base64: string;
  readonly contentType?: string;
}

export type OpensteerRequestBodyInput =
  | OpensteerJsonRequestBodyInput
  | OpensteerTextRequestBodyInput
  | OpensteerBase64RequestBodyInput;

export interface OpensteerRequestExecuteInput {
  readonly key: string;
  readonly version?: string;
  readonly pageRef?: PageRef;
  readonly cookieJar?: string;
  readonly params?: OpensteerRequestScalarMap;
  readonly query?: OpensteerRequestScalarMap;
  readonly headers?: OpensteerRequestScalarMap;
  readonly bodyVars?: OpensteerRequestScalarMap;
  readonly body?: OpensteerRequestBodyInput;
  readonly validateResponse?: boolean;
}

export interface OpensteerRawRequestInput {
  readonly transport?: TransportKind;
  readonly pageRef?: PageRef;
  readonly cookieJar?: string;
  readonly url: string;
  readonly method?: string;
  readonly headers?: readonly HeaderEntry[];
  readonly body?: OpensteerRequestBodyInput;
  readonly followRedirects?: boolean;
}

export interface OpensteerRequestTransportResult {
  readonly method: string;
  readonly url: string;
  readonly headers: readonly HeaderEntry[];
  readonly body?: BodyPayload;
}

export interface OpensteerRequestResponseResult {
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly HeaderEntry[];
  readonly body?: BodyPayload;
  readonly redirected: boolean;
}

export interface OpensteerRequestExecuteOutput {
  readonly plan: {
    readonly id: string;
    readonly key: string;
    readonly version: string;
  };
  readonly request: OpensteerRequestTransportResult;
  readonly response: OpensteerRequestResponseResult;
  readonly recovery?: {
    readonly attempted: boolean;
    readonly succeeded: boolean;
    readonly matchedFailurePolicy?: boolean;
  };
  readonly data?: unknown;
}

export interface OpensteerRawRequestOutput {
  readonly recordId: string;
  readonly request: OpensteerRequestTransportResult;
  readonly response: OpensteerRequestResponseResult;
  readonly data?: unknown;
}

export interface OpensteerInferRequestPlanInput {
  readonly recordId: string;
  readonly key: string;
  readonly version: string;
  readonly transport?: TransportKind;
}

export const opensteerRequestScalarSchema: JsonSchema = oneOfSchema(
  [stringSchema(), { type: "number" }, { type: "boolean" }],
  {
    title: "OpensteerRequestScalar",
  },
);

const opensteerRequestScalarMapSchema: JsonSchema = recordSchema(opensteerRequestScalarSchema, {
  title: "OpensteerRequestScalarMap",
});

export const opensteerRequestEntrySchema: JsonSchema = objectSchema(
  {
    name: stringSchema({ minLength: 1 }),
    value: stringSchema(),
  },
  {
    title: "OpensteerRequestEntry",
    required: ["name", "value"],
  },
);

export const opensteerRequestPlanParameterLocationSchema: JsonSchema = enumSchema(
  ["path", "query", "header"] as const,
  {
    title: "OpensteerRequestParameterLocation",
  },
);

export const opensteerRequestPlanParameterSchema: JsonSchema = objectSchema(
  {
    name: stringSchema({ minLength: 1 }),
    in: opensteerRequestPlanParameterLocationSchema,
    wireName: stringSchema({ minLength: 1 }),
    required: { type: "boolean" },
    description: stringSchema({ minLength: 1 }),
    defaultValue: stringSchema(),
  },
  {
    title: "OpensteerRequestPlanParameter",
    required: ["name", "in"],
  },
);

export const opensteerRequestPlanTransportSchema: JsonSchema = objectSchema(
  {
    kind: enumSchema([
      "direct-http",
      "matched-tls",
      "context-http",
      "page-http",
      "session-http",
    ] as const),
    requiresBrowser: { type: "boolean" },
    requireSameOrigin: { type: "boolean" },
    cookieJar: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerRequestPlanTransport",
    required: ["kind"],
  },
);

export const opensteerRequestPlanEndpointSchema: JsonSchema = objectSchema(
  {
    method: stringSchema({ minLength: 1 }),
    urlTemplate: stringSchema({ minLength: 1 }),
    defaultQuery: arraySchema(opensteerRequestEntrySchema),
    defaultHeaders: arraySchema(opensteerRequestEntrySchema),
  },
  {
    title: "OpensteerRequestPlanEndpoint",
    required: ["method", "urlTemplate"],
  },
);

export const opensteerRequestPlanBodySchema: JsonSchema = objectSchema(
  {
    kind: enumSchema(["json", "form", "text"] as const),
    contentType: stringSchema({ minLength: 1 }),
    required: { type: "boolean" },
    description: stringSchema({ minLength: 1 }),
    template: defineSchema({
      title: "JsonValue",
    }),
    fields: arraySchema(opensteerRequestEntrySchema),
  },
  {
    title: "OpensteerRequestPlanBody",
  },
);

export const transportKindSchema: JsonSchema = enumSchema(
  ["direct-http", "matched-tls", "context-http", "page-http", "session-http"] as const,
  {
    title: "TransportKind",
  },
);

const opensteerRequestPlanStatusSchema: JsonSchema = oneOfSchema(
  [
    integerSchema({ minimum: 100, maximum: 599 }),
    arraySchema(integerSchema({ minimum: 100, maximum: 599 }), {
      minItems: 1,
      uniqueItems: true,
    }),
  ],
  {
    title: "OpensteerRequestPlanResponseStatus",
  },
);

export const opensteerRequestPlanResponseExpectationSchema: JsonSchema = objectSchema(
  {
    status: opensteerRequestPlanStatusSchema,
    contentType: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerRequestPlanResponseExpectation",
    required: ["status"],
  },
);

export const opensteerRequestFailurePolicyHeaderMatchSchema: JsonSchema = objectSchema(
  {
    name: stringSchema({ minLength: 1 }),
    valueIncludes: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerRequestFailurePolicyHeaderMatch",
    required: ["name", "valueIncludes"],
  },
);

export const opensteerRequestFailurePolicySchema: JsonSchema = objectSchema(
  {
    statusCodes: arraySchema(integerSchema({ minimum: 100, maximum: 599 }), {
      minItems: 1,
      uniqueItems: true,
    }),
    finalUrlIncludes: arraySchema(stringSchema({ minLength: 1 }), {
      minItems: 1,
      uniqueItems: true,
    }),
    responseHeaders: arraySchema(opensteerRequestFailurePolicyHeaderMatchSchema, {
      minItems: 1,
    }),
    responseBodyIncludes: arraySchema(stringSchema({ minLength: 1 }), {
      minItems: 1,
      uniqueItems: true,
    }),
  },
  {
    title: "OpensteerRequestFailurePolicy",
  },
);

export const opensteerRequestRetryBackoffPolicySchema: JsonSchema = objectSchema(
  {
    strategy: enumSchema(["fixed", "exponential"] as const),
    delayMs: integerSchema({ minimum: 0 }),
    maxDelayMs: integerSchema({ minimum: 0 }),
  },
  {
    title: "OpensteerRequestRetryBackoffPolicy",
    required: ["delayMs"],
  },
);

export const opensteerRequestRetryPolicySchema: JsonSchema = objectSchema(
  {
    maxRetries: integerSchema({ minimum: 0 }),
    backoff: opensteerRequestRetryBackoffPolicySchema,
    respectRetryAfter: { type: "boolean" },
    failurePolicy: opensteerRequestFailurePolicySchema,
  },
  {
    title: "OpensteerRequestRetryPolicy",
    required: ["maxRetries"],
  },
);

export const opensteerRequestPlanAuthSchema: JsonSchema = objectSchema(
  {
    strategy: enumSchema(["session-cookie", "bearer-token", "api-key", "custom"] as const),
    failurePolicy: opensteerRequestFailurePolicySchema,
    description: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerRequestPlanAuth",
    required: ["strategy"],
  },
);

export const opensteerRequestPlanPayloadSchema: JsonSchema = objectSchema(
  {
    transport: opensteerRequestPlanTransportSchema,
    endpoint: opensteerRequestPlanEndpointSchema,
    parameters: arraySchema(opensteerRequestPlanParameterSchema),
    body: opensteerRequestPlanBodySchema,
    response: opensteerRequestPlanResponseExpectationSchema,
    retryPolicy: opensteerRequestRetryPolicySchema,
    auth: opensteerRequestPlanAuthSchema,
  },
  {
    title: "OpensteerRequestPlanPayload",
    required: ["transport", "endpoint"],
  },
);

export const opensteerRegistryProvenanceSchema: JsonSchema = objectSchema(
  {
    source: stringSchema({ minLength: 1 }),
    sourceId: stringSchema({ minLength: 1 }),
    capturedAt: integerSchema({ minimum: 0 }),
    notes: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerRegistryProvenance",
    required: ["source"],
  },
);

export const opensteerRequestPlanFreshnessSchema: JsonSchema = objectSchema(
  {
    lastValidatedAt: integerSchema({ minimum: 0 }),
    staleAt: integerSchema({ minimum: 0 }),
    expiresAt: integerSchema({ minimum: 0 }),
  },
  {
    title: "OpensteerRequestPlanFreshness",
  },
);

export const opensteerRequestPlanRecordSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
    createdAt: integerSchema({ minimum: 0 }),
    updatedAt: integerSchema({ minimum: 0 }),
    contentHash: stringSchema({ minLength: 1 }),
    tags: arraySchema(stringSchema({ minLength: 1 }), {
      uniqueItems: true,
    }),
    provenance: opensteerRegistryProvenanceSchema,
    freshness: opensteerRequestPlanFreshnessSchema,
    payload: opensteerRequestPlanPayloadSchema,
  },
  {
    title: "OpensteerRequestPlanRecord",
    required: ["id", "key", "version", "createdAt", "updatedAt", "contentHash", "tags", "payload"],
  },
);

const jsonValueSchema: JsonSchema = defineSchema({
  title: "JsonValue",
});

export const opensteerRequestBodyInputSchema: JsonSchema = oneOfSchema(
  [
    objectSchema(
      {
        json: jsonValueSchema,
        contentType: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerJsonRequestBodyInput",
        required: ["json"],
      },
    ),
    objectSchema(
      {
        text: stringSchema(),
        contentType: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerTextRequestBodyInput",
        required: ["text"],
      },
    ),
    objectSchema(
      {
        base64: stringSchema(),
        contentType: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerBase64RequestBodyInput",
        required: ["base64"],
      },
    ),
  ],
  {
    title: "OpensteerRequestBodyInput",
  },
);

export const opensteerNetworkQueryInputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    recordId: stringSchema({ minLength: 1 }),
    requestId: stringSchema({ minLength: 1 }),
    capture: stringSchema({ minLength: 1 }),
    tag: stringSchema({ minLength: 1 }),
    url: stringSchema({ minLength: 1 }),
    hostname: stringSchema({ minLength: 1 }),
    path: stringSchema({ minLength: 1 }),
    method: stringSchema({ minLength: 1 }),
    status: oneOfSchema([
      integerSchema({ minimum: 100, maximum: 599 }),
      stringSchema({ minLength: 1 }),
    ]),
    resourceType: networkResourceTypeSchema,
    includeBodies: { type: "boolean" },
    json: { type: "boolean" },
    before: stringSchema({ minLength: 1 }),
    after: stringSchema({ minLength: 1 }),
    limit: integerSchema({ minimum: 1, maximum: 1000 }),
  },
  {
    title: "OpensteerNetworkQueryInput",
  },
);

const opensteerGraphqlSummarySchema: JsonSchema = objectSchema(
  {
    operationType: enumSchema(["query", "mutation", "subscription", "unknown"] as const),
    operationName: stringSchema({ minLength: 1 }),
    persisted: { type: "boolean" },
  },
  {
    title: "OpensteerGraphqlSummary",
  },
);

const opensteerNetworkBodySummarySchema: JsonSchema = objectSchema(
  {
    bytes: integerSchema({ minimum: 0 }),
    contentType: stringSchema({ minLength: 1 }),
    streaming: { type: "boolean" },
  },
  {
    title: "OpensteerNetworkBodySummary",
  },
);

export const opensteerNetworkSummaryRecordSchema: JsonSchema = objectSchema(
  {
    recordId: stringSchema({ minLength: 1 }),
    capture: stringSchema({ minLength: 1 }),
    savedAt: integerSchema({ minimum: 0 }),
    kind: enumSchema(["http", "websocket", "event-stream"] as const),
    method: stringSchema({ minLength: 1 }),
    status: integerSchema({ minimum: 100, maximum: 599 }),
    resourceType: networkResourceTypeSchema,
    url: stringSchema({ minLength: 1 }),
    request: opensteerNetworkBodySummarySchema,
    response: opensteerNetworkBodySummarySchema,
    graphql: opensteerGraphqlSummarySchema,
    websocket: objectSchema(
      {
        subprotocol: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerWebsocketSummary",
      },
    ),
  },
  {
    title: "OpensteerNetworkSummaryRecord",
    required: ["recordId", "kind", "method", "resourceType", "url"],
  },
);

export const opensteerNetworkQueryOutputSchema: JsonSchema = objectSchema(
  {
    records: arraySchema(opensteerNetworkSummaryRecordSchema),
  },
  {
    title: "OpensteerNetworkQueryOutput",
    required: ["records"],
  },
);

export const opensteerNetworkDetailInputSchema: JsonSchema = objectSchema(
  {
    recordId: stringSchema({ minLength: 1 }),
    probe: { type: "boolean" },
  },
  {
    title: "OpensteerNetworkDetailInput",
    required: ["recordId"],
  },
);

const opensteerParsedCookieSchema: JsonSchema = objectSchema(
  {
    name: stringSchema({ minLength: 1 }),
    value: stringSchema(),
  },
  {
    title: "OpensteerParsedCookie",
    required: ["name", "value"],
  },
);

const opensteerStructuredBodyPreviewSchema: JsonSchema = objectSchema(
  {
    contentType: stringSchema({ minLength: 1 }),
    bytes: integerSchema({ minimum: 0 }),
    truncated: { type: "boolean" },
    data: oneOfSchema([jsonValueSchema, stringSchema()]),
    note: stringSchema(),
  },
  {
    title: "OpensteerStructuredBodyPreview",
    required: ["bytes", "truncated"],
  },
);

const opensteerNetworkRedirectHopSchema: JsonSchema = objectSchema(
  {
    method: stringSchema({ minLength: 1 }),
    status: integerSchema({ minimum: 100, maximum: 599 }),
    url: stringSchema({ minLength: 1 }),
    location: stringSchema({ minLength: 1 }),
    setCookie: arraySchema(stringSchema()),
  },
  {
    title: "OpensteerNetworkRedirectHop",
    required: ["method", "url"],
  },
);

const opensteerReplayAttemptSchema: JsonSchema = objectSchema(
  {
    transport: transportKindSchema,
    status: integerSchema({ minimum: 100, maximum: 599 }),
    ok: { type: "boolean" },
    durationMs: integerSchema({ minimum: 0 }),
    note: stringSchema(),
    error: stringSchema(),
  },
  {
    title: "OpensteerReplayAttempt",
    required: ["transport", "ok", "durationMs"],
  },
);

export const opensteerNetworkDetailOutputSchema: JsonSchema = objectSchema(
  {
    recordId: stringSchema({ minLength: 1 }),
    capture: stringSchema({ minLength: 1 }),
    savedAt: integerSchema({ minimum: 0 }),
    summary: opensteerNetworkSummaryRecordSchema,
    requestHeaders: arraySchema(headerEntrySchema),
    responseHeaders: arraySchema(headerEntrySchema),
    cookiesSent: arraySchema(opensteerParsedCookieSchema),
    requestBody: opensteerStructuredBodyPreviewSchema,
    responseBody: opensteerStructuredBodyPreviewSchema,
    graphql: objectSchema(
      {
        operationType: enumSchema(["query", "mutation", "subscription", "unknown"] as const),
        operationName: stringSchema({ minLength: 1 }),
        persisted: { type: "boolean" },
        variables: jsonValueSchema,
      },
      {
        title: "OpensteerGraphqlDetail",
      },
    ),
    redirectChain: arraySchema(opensteerNetworkRedirectHopSchema),
    notes: arraySchema(stringSchema()),
    transportProbe: objectSchema(
      {
        recommended: transportKindSchema,
        attempts: arraySchema(opensteerReplayAttemptSchema),
      },
      {
        title: "OpensteerTransportProbeResult",
        required: ["attempts"],
      },
    ),
  },
  {
    title: "OpensteerNetworkDetailOutput",
    required: ["recordId", "summary", "requestHeaders", "responseHeaders"],
  },
);

export const opensteerNetworkReplayInputSchema: JsonSchema = objectSchema(
  {
    recordId: stringSchema({ minLength: 1 }),
    pageRef: pageRefSchema,
    query: opensteerRequestScalarMapSchema,
    headers: opensteerRequestScalarMapSchema,
    body: opensteerRequestBodyInputSchema,
    variables: jsonValueSchema,
  },
  {
    title: "OpensteerNetworkReplayInput",
    required: ["recordId"],
  },
);

export let opensteerNetworkReplayOutputSchema: JsonSchema;

const opensteerSessionFetchTransportSchema: JsonSchema = enumSchema(
  ["auto", "direct", "matched-tls", "context", "page"] as const,
  {
    title: "OpensteerSessionFetchTransport",
  },
);

export const opensteerSessionFetchInputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    url: stringSchema({ minLength: 1 }),
    method: stringSchema({ minLength: 1 }),
    query: opensteerRequestScalarMapSchema,
    headers: opensteerRequestScalarMapSchema,
    body: opensteerRequestBodyInputSchema,
    transport: opensteerSessionFetchTransportSchema,
    cookies: { type: "boolean" },
    followRedirects: { type: "boolean" },
  },
  {
    title: "OpensteerSessionFetchInput",
    required: ["url"],
  },
);

export let opensteerSessionFetchOutputSchema: JsonSchema;

export const opensteerCookieQueryInputSchema: JsonSchema = objectSchema(
  {
    domain: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerCookieQueryInput",
  },
);

export const opensteerCookieQueryOutputSchema: JsonSchema = objectSchema(
  {
    domain: stringSchema({ minLength: 1 }),
    cookies: arraySchema(cookieRecordSchema),
  },
  {
    title: "OpensteerCookieQueryOutput",
    required: ["cookies"],
  },
);

const opensteerStorageDomainSnapshotSchema: JsonSchema = objectSchema(
  {
    domain: stringSchema({ minLength: 1 }),
    localStorage: arraySchema(storageEntrySchema),
    sessionStorage: arraySchema(storageEntrySchema),
  },
  {
    title: "OpensteerStorageDomainSnapshot",
    required: ["domain", "localStorage", "sessionStorage"],
  },
);

export const opensteerStorageQueryInputSchema: JsonSchema = objectSchema(
  {
    domain: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerStorageQueryInput",
  },
);

export const opensteerStorageQueryOutputSchema: JsonSchema = objectSchema(
  {
    domains: arraySchema(opensteerStorageDomainSnapshotSchema),
  },
  {
    title: "OpensteerStorageQueryOutput",
    required: ["domains"],
  },
);

const opensteerHiddenFieldSchema: JsonSchema = objectSchema(
  {
    path: stringSchema({ minLength: 1 }),
    name: stringSchema({ minLength: 1 }),
    value: stringSchema(),
  },
  {
    title: "OpensteerHiddenField",
    required: ["path", "name", "value"],
  },
);

const opensteerStateDomainSnapshotSchema: JsonSchema = objectSchema(
  {
    domain: stringSchema({ minLength: 1 }),
    cookies: arraySchema(cookieRecordSchema),
    hiddenFields: arraySchema(opensteerHiddenFieldSchema),
    localStorage: arraySchema(storageEntrySchema),
    sessionStorage: arraySchema(storageEntrySchema),
    globals: recordSchema(jsonValueSchema),
  },
  {
    title: "OpensteerStateDomainSnapshot",
    required: ["domain", "cookies", "hiddenFields", "localStorage", "sessionStorage"],
  },
);

export const opensteerStateQueryInputSchema: JsonSchema = objectSchema(
  {
    domain: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerStateQueryInput",
  },
);

export const opensteerStateQueryOutputSchema: JsonSchema = objectSchema(
  {
    domains: arraySchema(opensteerStateDomainSnapshotSchema),
  },
  {
    title: "OpensteerStateQueryOutput",
    required: ["domains"],
  },
);

export const opensteerNetworkTagInputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    recordId: stringSchema({ minLength: 1 }),
    requestId: stringSchema({ minLength: 1 }),
    capture: stringSchema({ minLength: 1 }),
    tag: stringSchema({ minLength: 1 }),
    url: stringSchema({ minLength: 1 }),
    hostname: stringSchema({ minLength: 1 }),
    path: stringSchema({ minLength: 1 }),
    method: stringSchema({ minLength: 1 }),
    status: stringSchema({ minLength: 1 }),
    resourceType: networkResourceTypeSchema,
  },
  {
    title: "OpensteerNetworkTagInput",
    required: ["tag"],
  },
);

export const opensteerNetworkTagOutputSchema: JsonSchema = objectSchema(
  {
    taggedCount: integerSchema({ minimum: 0 }),
  },
  {
    title: "OpensteerNetworkTagOutput",
    required: ["taggedCount"],
  },
);

export const opensteerNetworkClearInputSchema: JsonSchema = objectSchema(
  {
    capture: stringSchema({ minLength: 1 }),
    tag: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerNetworkClearInput",
  },
);

export const opensteerNetworkClearOutputSchema: JsonSchema = objectSchema(
  {
    clearedCount: integerSchema({ minimum: 0 }),
  },
  {
    title: "OpensteerNetworkClearOutput",
    required: ["clearedCount"],
  },
);

export const opensteerWriteRequestPlanInputSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
    tags: arraySchema(stringSchema({ minLength: 1 }), {
      uniqueItems: true,
    }),
    provenance: opensteerRegistryProvenanceSchema,
    freshness: opensteerRequestPlanFreshnessSchema,
    payload: opensteerRequestPlanPayloadSchema,
  },
  {
    title: "OpensteerWriteRequestPlanInput",
    required: ["key", "version", "payload"],
  },
);

export const opensteerGetRequestPlanInputSchema: JsonSchema = objectSchema(
  {
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerGetRequestPlanInput",
    required: ["key"],
  },
);

export const opensteerListRequestPlansInputSchema: JsonSchema = objectSchema(
  {
    key: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerListRequestPlansInput",
  },
);

export const opensteerListRequestPlansOutputSchema: JsonSchema = objectSchema(
  {
    plans: arraySchema(opensteerRequestPlanRecordSchema),
  },
  {
    title: "OpensteerListRequestPlansOutput",
    required: ["plans"],
  },
);

export const opensteerRequestExecuteInputSchema: JsonSchema = objectSchema(
  {
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
    pageRef: pageRefSchema,
    cookieJar: stringSchema({ minLength: 1 }),
    params: opensteerRequestScalarMapSchema,
    query: opensteerRequestScalarMapSchema,
    headers: opensteerRequestScalarMapSchema,
    bodyVars: opensteerRequestScalarMapSchema,
    body: opensteerRequestBodyInputSchema,
    validateResponse: { type: "boolean" },
  },
  {
    title: "OpensteerRequestExecuteInput",
    required: ["key"],
  },
);

export const opensteerRawRequestInputSchema: JsonSchema = objectSchema(
  {
    transport: transportKindSchema,
    pageRef: pageRefSchema,
    cookieJar: stringSchema({ minLength: 1 }),
    url: stringSchema({ minLength: 1 }),
    method: stringSchema({ minLength: 1 }),
    headers: arraySchema(headerEntrySchema),
    body: opensteerRequestBodyInputSchema,
    followRedirects: { type: "boolean" },
  },
  {
    title: "OpensteerRawRequestInput",
    required: ["url"],
  },
);

export const opensteerRequestTransportResultSchema: JsonSchema = objectSchema(
  {
    method: stringSchema({ minLength: 1 }),
    url: stringSchema({ minLength: 1 }),
    headers: arraySchema(headerEntrySchema),
    body: bodyPayloadSchema,
  },
  {
    title: "OpensteerRequestTransportResult",
    required: ["method", "url", "headers"],
  },
);

export const opensteerRequestResponseResultSchema: JsonSchema = objectSchema(
  {
    url: stringSchema({ minLength: 1 }),
    status: integerSchema({ minimum: 100, maximum: 599 }),
    statusText: stringSchema(),
    headers: arraySchema(headerEntrySchema),
    body: bodyPayloadSchema,
    redirected: { type: "boolean" },
  },
  {
    title: "OpensteerRequestResponseResult",
    required: ["url", "status", "statusText", "headers", "redirected"],
  },
);

opensteerNetworkReplayOutputSchema = objectSchema(
  {
    recordId: stringSchema({ minLength: 1 }),
    transport: transportKindSchema,
    attempts: arraySchema(opensteerReplayAttemptSchema),
    response: opensteerRequestResponseResultSchema,
    data: oneOfSchema([jsonValueSchema, stringSchema()]),
    note: stringSchema(),
  },
  {
    title: "OpensteerNetworkReplayOutput",
    required: ["recordId", "attempts"],
  },
);

opensteerSessionFetchOutputSchema = objectSchema(
  {
    transport: transportKindSchema,
    attempts: arraySchema(opensteerReplayAttemptSchema),
    response: opensteerRequestResponseResultSchema,
    data: oneOfSchema([jsonValueSchema, stringSchema()]),
    note: stringSchema(),
  },
  {
    title: "OpensteerSessionFetchOutput",
    required: ["attempts"],
  },
);

export const opensteerRequestExecuteOutputSchema: JsonSchema = objectSchema(
  {
    plan: objectSchema(
      {
        id: stringSchema({ minLength: 1 }),
        key: stringSchema({ minLength: 1 }),
        version: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerResolvedRequestPlanRef",
        required: ["id", "key", "version"],
      },
    ),
    request: opensteerRequestTransportResultSchema,
    response: opensteerRequestResponseResultSchema,
    recovery: objectSchema(
      {
        attempted: { type: "boolean" },
        succeeded: { type: "boolean" },
        matchedFailurePolicy: { type: "boolean" },
      },
      {
        title: "OpensteerRequestRecoveryMetadata",
        required: ["attempted", "succeeded"],
      },
    ),
    data: jsonValueSchema,
  },
  {
    title: "OpensteerRequestExecuteOutput",
    required: ["plan", "request", "response"],
  },
);

export const opensteerRawRequestOutputSchema: JsonSchema = objectSchema(
  {
    recordId: stringSchema({ minLength: 1 }),
    request: opensteerRequestTransportResultSchema,
    response: opensteerRequestResponseResultSchema,
    data: jsonValueSchema,
  },
  {
    title: "OpensteerRawRequestOutput",
    required: ["recordId", "request", "response"],
  },
);

export const opensteerInferRequestPlanInputSchema: JsonSchema = objectSchema(
  {
    recordId: stringSchema({ minLength: 1 }),
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
    transport: transportKindSchema,
  },
  {
    title: "OpensteerInferRequestPlanInput",
    required: ["recordId", "key", "version"],
  },
);
