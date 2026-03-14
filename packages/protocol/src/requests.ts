import type { HeaderEntry } from "./network.js";
import {
  bodyPayloadSchema,
  headerEntrySchema,
  networkRecordSchema,
  networkResourceTypeSchema,
  type BodyPayload,
  type NetworkRecord,
  type NetworkResourceType,
} from "./network.js";
import type { JsonSchema, JsonValue } from "./json.js";
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
  readonly kind: "session-http" | "direct-http";
  readonly requiresBrowser?: boolean;
}

export interface OpensteerRequestPlanEndpoint {
  readonly method: string;
  readonly urlTemplate: string;
  readonly defaultQuery?: readonly OpensteerRequestEntry[];
  readonly defaultHeaders?: readonly OpensteerRequestEntry[];
}

export interface OpensteerRequestPlanBody {
  readonly contentType?: string;
  readonly required?: boolean;
  readonly description?: string;
}

export interface OpensteerRequestPlanResponseExpectation {
  readonly status: number | readonly number[];
  readonly contentType?: string;
}

export interface OpensteerRequestPlanAuth {
  readonly strategy: "session-cookie" | "bearer-token" | "api-key" | "custom";
  readonly recipeRef?: string;
  readonly description?: string;
}

export interface OpensteerRequestPlanPayload {
  readonly transport: OpensteerRequestPlanTransport;
  readonly endpoint: OpensteerRequestPlanEndpoint;
  readonly parameters?: readonly OpensteerRequestPlanParameter[];
  readonly body?: OpensteerRequestPlanBody;
  readonly response?: OpensteerRequestPlanResponseExpectation;
  readonly auth?: OpensteerRequestPlanAuth;
}

export interface OpensteerRegistryProvenance {
  readonly source: string;
  readonly sourceId?: string;
  readonly capturedAt?: number;
  readonly notes?: string;
}

export type OpensteerRequestPlanLifecycle = "draft" | "active" | "deprecated" | "retired";

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
  readonly lifecycle: OpensteerRequestPlanLifecycle;
  readonly freshness?: OpensteerRequestPlanFreshness;
  readonly payload: OpensteerRequestPlanPayload;
}

export type OpensteerRequestCaptureScope = "page" | "session";

export interface OpensteerRequestCaptureStartInput {
  readonly scope?: OpensteerRequestCaptureScope;
  readonly resourceTypes?: readonly NetworkResourceType[];
}

export interface OpensteerRequestCaptureStartOutput {
  readonly scope: OpensteerRequestCaptureScope;
  readonly startedAt: number;
  readonly baselineCount: number;
  readonly resourceTypes?: readonly NetworkResourceType[];
}

export interface OpensteerRequestCaptureStopOutput {
  readonly scope: OpensteerRequestCaptureScope;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly baselineCount: number;
  readonly recordCount: number;
  readonly artifactId: string;
  readonly records: readonly NetworkRecord[];
}

export interface OpensteerWriteRequestPlanInput {
  readonly id?: string;
  readonly key: string;
  readonly version: string;
  readonly tags?: readonly string[];
  readonly provenance?: OpensteerRegistryProvenance;
  readonly lifecycle?: OpensteerRequestPlanLifecycle;
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
  readonly params?: OpensteerRequestScalarMap;
  readonly query?: OpensteerRequestScalarMap;
  readonly headers?: OpensteerRequestScalarMap;
  readonly body?: OpensteerRequestBodyInput;
  readonly validateResponse?: boolean;
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
  readonly data?: unknown;
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
    kind: enumSchema(["session-http", "direct-http"] as const),
    requiresBrowser: { type: "boolean" },
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
    contentType: stringSchema({ minLength: 1 }),
    required: { type: "boolean" },
    description: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerRequestPlanBody",
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

export const opensteerRequestPlanAuthSchema: JsonSchema = objectSchema(
  {
    strategy: enumSchema(["session-cookie", "bearer-token", "api-key", "custom"] as const),
    recipeRef: stringSchema({ minLength: 1 }),
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

export const opensteerRequestPlanLifecycleSchema: JsonSchema = enumSchema(
  ["draft", "active", "deprecated", "retired"] as const,
  {
    title: "OpensteerRequestPlanLifecycle",
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
    lifecycle: opensteerRequestPlanLifecycleSchema,
    freshness: opensteerRequestPlanFreshnessSchema,
    payload: opensteerRequestPlanPayloadSchema,
  },
  {
    title: "OpensteerRequestPlanRecord",
    required: [
      "id",
      "key",
      "version",
      "createdAt",
      "updatedAt",
      "contentHash",
      "tags",
      "lifecycle",
      "payload",
    ],
  },
);

export const opensteerRequestCaptureScopeSchema: JsonSchema = enumSchema(
  ["page", "session"] as const,
  {
    title: "OpensteerRequestCaptureScope",
  },
);

export const opensteerRequestCaptureStartInputSchema: JsonSchema = objectSchema(
  {
    scope: opensteerRequestCaptureScopeSchema,
    resourceTypes: arraySchema(networkResourceTypeSchema, {
      uniqueItems: true,
    }),
  },
  {
    title: "OpensteerRequestCaptureStartInput",
  },
);

export const opensteerRequestCaptureStartOutputSchema: JsonSchema = objectSchema(
  {
    scope: opensteerRequestCaptureScopeSchema,
    startedAt: integerSchema({ minimum: 0 }),
    baselineCount: integerSchema({ minimum: 0 }),
    resourceTypes: arraySchema(networkResourceTypeSchema, {
      uniqueItems: true,
    }),
  },
  {
    title: "OpensteerRequestCaptureStartOutput",
    required: ["scope", "startedAt", "baselineCount"],
  },
);

export const opensteerRequestCaptureStopOutputSchema: JsonSchema = objectSchema(
  {
    scope: opensteerRequestCaptureScopeSchema,
    startedAt: integerSchema({ minimum: 0 }),
    completedAt: integerSchema({ minimum: 0 }),
    baselineCount: integerSchema({ minimum: 0 }),
    recordCount: integerSchema({ minimum: 0 }),
    artifactId: stringSchema({ minLength: 1 }),
    records: arraySchema(networkRecordSchema),
  },
  {
    title: "OpensteerRequestCaptureStopOutput",
    required: [
      "scope",
      "startedAt",
      "completedAt",
      "baselineCount",
      "recordCount",
      "artifactId",
      "records",
    ],
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
    lifecycle: opensteerRequestPlanLifecycleSchema,
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

export const opensteerRequestExecuteInputSchema: JsonSchema = objectSchema(
  {
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
    params: opensteerRequestScalarMapSchema,
    query: opensteerRequestScalarMapSchema,
    headers: opensteerRequestScalarMapSchema,
    body: opensteerRequestBodyInputSchema,
    validateResponse: { type: "boolean" },
  },
  {
    title: "OpensteerRequestExecuteInput",
    required: ["key"],
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
    data: jsonValueSchema,
  },
  {
    title: "OpensteerRequestExecuteOutput",
    required: ["plan", "request", "response"],
  },
);
