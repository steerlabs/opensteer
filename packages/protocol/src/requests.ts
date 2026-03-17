import type { HeaderEntry } from "./network.js";
import {
  bodyPayloadSchema,
  headerEntrySchema,
  networkQueryRecordSchema,
  networkResourceTypeSchema,
  type BodyPayload,
  type NetworkQueryRecord,
  type NetworkResourceType,
} from "./network.js";
import type { JsonSchema, JsonValue } from "./json.js";
import { pageRefSchema, type PageRef } from "./identity.js";
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

export interface OpensteerAuthRecipeRef {
  readonly key: string;
  readonly version?: string;
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

export interface OpensteerRequestPlanAuth {
  readonly strategy: "session-cookie" | "bearer-token" | "api-key" | "custom";
  readonly recipe?: OpensteerAuthRecipeRef;
  readonly failurePolicy?: OpensteerRequestFailurePolicy;
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

export interface OpensteerAuthRecipeStepHeaderCapture {
  readonly name: string;
  readonly saveAs: string;
}

export interface OpensteerAuthRecipeStepBodyJsonPointerCapture {
  readonly pointer: string;
  readonly saveAs: string;
}

export interface OpensteerAuthRecipeStepBodyTextCapture {
  readonly saveAs: string;
}

export interface OpensteerAuthRecipeStepResponseCapture {
  readonly header?: OpensteerAuthRecipeStepHeaderCapture;
  readonly bodyJsonPointer?: OpensteerAuthRecipeStepBodyJsonPointerCapture;
  readonly bodyText?: OpensteerAuthRecipeStepBodyTextCapture;
}

export interface OpensteerAuthRecipeRequestStepInput {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: OpensteerRequestBodyInput;
  readonly followRedirects?: boolean;
}

export interface OpensteerAuthRecipeGotoStep {
  readonly kind: "goto";
  readonly url: string;
  readonly networkTag?: string;
}

export interface OpensteerAuthRecipeReloadStep {
  readonly kind: "reload";
  readonly networkTag?: string;
}

export interface OpensteerAuthRecipeWaitForUrlStep {
  readonly kind: "waitForUrl";
  readonly includes: string;
  readonly timeoutMs?: number;
}

export interface OpensteerAuthRecipeWaitForNetworkStep {
  readonly kind: "waitForNetwork";
  readonly url?: string;
  readonly hostname?: string;
  readonly path?: string;
  readonly method?: string;
  readonly status?: string;
  readonly includeBodies?: boolean;
  readonly timeoutMs?: number;
  readonly saveAs?: string;
}

export interface OpensteerAuthRecipeWaitForCookieStep {
  readonly kind: "waitForCookie";
  readonly name: string;
  readonly url?: string;
  readonly timeoutMs?: number;
  readonly saveAs?: string;
}

export interface OpensteerAuthRecipeWaitForStorageStep {
  readonly kind: "waitForStorage";
  readonly area: "local" | "session";
  readonly origin: string;
  readonly key: string;
  readonly timeoutMs?: number;
  readonly saveAs?: string;
}

export interface OpensteerAuthRecipeReadCookieStep {
  readonly kind: "readCookie";
  readonly name: string;
  readonly url?: string;
  readonly saveAs: string;
}

export interface OpensteerAuthRecipeReadStorageStep {
  readonly kind: "readStorage";
  readonly area: "local" | "session";
  readonly origin: string;
  readonly key: string;
  readonly pageUrl?: string;
  readonly saveAs: string;
}

export interface OpensteerAuthRecipeSessionRequestStep {
  readonly kind: "sessionRequest";
  readonly request: OpensteerAuthRecipeRequestStepInput;
  readonly capture?: OpensteerAuthRecipeStepResponseCapture;
}

export interface OpensteerAuthRecipeDirectRequestStep {
  readonly kind: "directRequest";
  readonly request: OpensteerAuthRecipeRequestStepInput;
  readonly capture?: OpensteerAuthRecipeStepResponseCapture;
}

export interface OpensteerAuthRecipeHookRef {
  readonly specifier: string;
  readonly export: string;
}

export interface OpensteerAuthRecipeHookStep {
  readonly kind: "hook";
  readonly hook: OpensteerAuthRecipeHookRef;
}

export type OpensteerAuthRecipeStep =
  | OpensteerAuthRecipeGotoStep
  | OpensteerAuthRecipeReloadStep
  | OpensteerAuthRecipeWaitForUrlStep
  | OpensteerAuthRecipeWaitForNetworkStep
  | OpensteerAuthRecipeWaitForCookieStep
  | OpensteerAuthRecipeWaitForStorageStep
  | OpensteerAuthRecipeReadCookieStep
  | OpensteerAuthRecipeReadStorageStep
  | OpensteerAuthRecipeSessionRequestStep
  | OpensteerAuthRecipeDirectRequestStep
  | OpensteerAuthRecipeHookStep;

export interface OpensteerAuthRecipeRetryOverrides {
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
}

export interface OpensteerAuthRecipePayload {
  readonly description?: string;
  readonly steps: readonly OpensteerAuthRecipeStep[];
  readonly outputs?: OpensteerAuthRecipeRetryOverrides;
}

export interface OpensteerAuthRecipeRecord {
  readonly id: string;
  readonly key: string;
  readonly version: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly contentHash: string;
  readonly tags: readonly string[];
  readonly provenance?: OpensteerRegistryProvenance;
  readonly payload: OpensteerAuthRecipePayload;
}

export interface OpensteerNetworkQueryInput {
  readonly source?: "live" | "saved";
  readonly pageRef?: PageRef;
  readonly recordId?: string;
  readonly requestId?: string;
  readonly actionId?: string;
  readonly tag?: string;
  readonly url?: string;
  readonly hostname?: string;
  readonly path?: string;
  readonly method?: string;
  readonly status?: string;
  readonly resourceType?: NetworkResourceType;
  readonly includeBodies?: boolean;
  readonly limit?: number;
}

export interface OpensteerNetworkQueryOutput {
  readonly records: readonly NetworkQueryRecord[];
}

export interface OpensteerNetworkSaveInput {
  readonly pageRef?: PageRef;
  readonly recordId?: string;
  readonly requestId?: string;
  readonly actionId?: string;
  readonly tag: string;
  readonly url?: string;
  readonly hostname?: string;
  readonly path?: string;
  readonly method?: string;
  readonly status?: string;
  readonly resourceType?: NetworkResourceType;
}

export interface OpensteerNetworkSaveOutput {
  readonly savedCount: number;
}

export interface OpensteerNetworkClearInput {
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

export interface OpensteerWriteAuthRecipeInput {
  readonly id?: string;
  readonly key: string;
  readonly version: string;
  readonly tags?: readonly string[];
  readonly provenance?: OpensteerRegistryProvenance;
  readonly payload: OpensteerAuthRecipePayload;
}

export interface OpensteerGetAuthRecipeInput {
  readonly key: string;
  readonly version?: string;
}

export interface OpensteerListAuthRecipesInput {
  readonly key?: string;
}

export interface OpensteerListAuthRecipesOutput {
  readonly recipes: readonly OpensteerAuthRecipeRecord[];
}

export interface OpensteerRunAuthRecipeInput {
  readonly key: string;
  readonly version?: string;
  readonly variables?: Readonly<Record<string, string>>;
}

export interface OpensteerRunAuthRecipeOutput {
  readonly recipe: {
    readonly id: string;
    readonly key: string;
    readonly version: string;
  };
  readonly variables: Readonly<Record<string, string>>;
  readonly overrides?: OpensteerAuthRecipeRetryOverrides;
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

export interface OpensteerRawRequestInput {
  readonly transport?: "session-http" | "direct-http";
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
    readonly recipe?: {
      readonly key: string;
      readonly version: string;
    };
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
  readonly lifecycle?: OpensteerRequestPlanLifecycle;
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

export const opensteerAuthRecipeRefSchema: JsonSchema = objectSchema(
  {
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerAuthRecipeRef",
    required: ["key"],
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

export const opensteerRequestPlanAuthSchema: JsonSchema = objectSchema(
  {
    strategy: enumSchema(["session-cookie", "bearer-token", "api-key", "custom"] as const),
    recipe: opensteerAuthRecipeRefSchema,
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

const opensteerAuthRecipeRetryOverridesSchema: JsonSchema = objectSchema(
  {
    headers: recordSchema(stringSchema(), {
      title: "OpensteerAuthRecipeHeaders",
    }),
    query: recordSchema(stringSchema(), {
      title: "OpensteerAuthRecipeQuery",
    }),
  },
  {
    title: "OpensteerAuthRecipeRetryOverrides",
  },
);

const opensteerAuthRecipeStepResponseCaptureSchema: JsonSchema = objectSchema(
  {
    header: objectSchema(
      {
        name: stringSchema({ minLength: 1 }),
        saveAs: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerAuthRecipeHeaderCapture",
        required: ["name", "saveAs"],
      },
    ),
    bodyJsonPointer: objectSchema(
      {
        pointer: stringSchema({ minLength: 1 }),
        saveAs: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerAuthRecipeBodyJsonPointerCapture",
        required: ["pointer", "saveAs"],
      },
    ),
    bodyText: objectSchema(
      {
        saveAs: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerAuthRecipeBodyTextCapture",
        required: ["saveAs"],
      },
    ),
  },
  {
    title: "OpensteerAuthRecipeStepResponseCapture",
  },
);

const opensteerAuthRecipeRequestStepInputSchema: JsonSchema = objectSchema(
  {
    url: stringSchema({ minLength: 1 }),
    method: stringSchema({ minLength: 1 }),
    headers: recordSchema(stringSchema(), {
      title: "OpensteerAuthRecipeRequestHeaders",
    }),
    query: recordSchema(stringSchema(), {
      title: "OpensteerAuthRecipeRequestQuery",
    }),
    body: opensteerRequestBodyInputSchema,
    followRedirects: { type: "boolean" },
  },
  {
    title: "OpensteerAuthRecipeRequestStepInput",
    required: ["url"],
  },
);

export const opensteerAuthRecipeHookRefSchema: JsonSchema = objectSchema(
  {
    specifier: stringSchema({ minLength: 1 }),
    export: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerAuthRecipeHookRef",
    required: ["specifier", "export"],
  },
);

export const opensteerAuthRecipeStepSchema: JsonSchema = oneOfSchema(
  [
    objectSchema(
      {
        kind: enumSchema(["goto"] as const),
        url: stringSchema({ minLength: 1 }),
        networkTag: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerAuthRecipeGotoStep",
        required: ["kind", "url"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["reload"] as const),
        networkTag: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerAuthRecipeReloadStep",
        required: ["kind"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["waitForUrl"] as const),
        includes: stringSchema({ minLength: 1 }),
        timeoutMs: integerSchema({ minimum: 0 }),
      },
      {
        title: "OpensteerAuthRecipeWaitForUrlStep",
        required: ["kind", "includes"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["waitForNetwork"] as const),
        url: stringSchema({ minLength: 1 }),
        hostname: stringSchema({ minLength: 1 }),
        path: stringSchema({ minLength: 1 }),
        method: stringSchema({ minLength: 1 }),
        status: stringSchema({ minLength: 1 }),
        includeBodies: { type: "boolean" },
        timeoutMs: integerSchema({ minimum: 0 }),
        saveAs: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerAuthRecipeWaitForNetworkStep",
        required: ["kind"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["waitForCookie"] as const),
        name: stringSchema({ minLength: 1 }),
        url: stringSchema({ minLength: 1 }),
        timeoutMs: integerSchema({ minimum: 0 }),
        saveAs: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerAuthRecipeWaitForCookieStep",
        required: ["kind", "name"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["waitForStorage"] as const),
        area: enumSchema(["local", "session"] as const),
        origin: stringSchema({ minLength: 1 }),
        key: stringSchema({ minLength: 1 }),
        timeoutMs: integerSchema({ minimum: 0 }),
        saveAs: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerAuthRecipeWaitForStorageStep",
        required: ["kind", "area", "origin", "key"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["readCookie"] as const),
        name: stringSchema({ minLength: 1 }),
        url: stringSchema({ minLength: 1 }),
        saveAs: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerAuthRecipeReadCookieStep",
        required: ["kind", "name", "saveAs"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["readStorage"] as const),
        area: enumSchema(["local", "session"] as const),
        origin: stringSchema({ minLength: 1 }),
        key: stringSchema({ minLength: 1 }),
        pageUrl: stringSchema({ minLength: 1 }),
        saveAs: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerAuthRecipeReadStorageStep",
        required: ["kind", "area", "origin", "key", "saveAs"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["sessionRequest"] as const),
        request: opensteerAuthRecipeRequestStepInputSchema,
        capture: opensteerAuthRecipeStepResponseCaptureSchema,
      },
      {
        title: "OpensteerAuthRecipeSessionRequestStep",
        required: ["kind", "request"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["directRequest"] as const),
        request: opensteerAuthRecipeRequestStepInputSchema,
        capture: opensteerAuthRecipeStepResponseCaptureSchema,
      },
      {
        title: "OpensteerAuthRecipeDirectRequestStep",
        required: ["kind", "request"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["hook"] as const),
        hook: opensteerAuthRecipeHookRefSchema,
      },
      {
        title: "OpensteerAuthRecipeHookStep",
        required: ["kind", "hook"],
      },
    ),
  ],
  {
    title: "OpensteerAuthRecipeStep",
  },
);

export const opensteerAuthRecipePayloadSchema: JsonSchema = objectSchema(
  {
    description: stringSchema({ minLength: 1 }),
    steps: arraySchema(opensteerAuthRecipeStepSchema, {
      minItems: 1,
    }),
    outputs: opensteerAuthRecipeRetryOverridesSchema,
  },
  {
    title: "OpensteerAuthRecipePayload",
    required: ["steps"],
  },
);

export const opensteerAuthRecipeRecordSchema: JsonSchema = objectSchema(
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
    payload: opensteerAuthRecipePayloadSchema,
  },
  {
    title: "OpensteerAuthRecipeRecord",
    required: ["id", "key", "version", "createdAt", "updatedAt", "contentHash", "tags", "payload"],
  },
);

export const opensteerNetworkQueryInputSchema: JsonSchema = objectSchema(
  {
    source: enumSchema(["live", "saved"] as const, {
      title: "OpensteerNetworkQuerySource",
    }),
    pageRef: pageRefSchema,
    recordId: stringSchema({ minLength: 1 }),
    requestId: stringSchema({ minLength: 1 }),
    actionId: stringSchema({ minLength: 1 }),
    tag: stringSchema({ minLength: 1 }),
    url: stringSchema({ minLength: 1 }),
    hostname: stringSchema({ minLength: 1 }),
    path: stringSchema({ minLength: 1 }),
    method: stringSchema({ minLength: 1 }),
    status: stringSchema({ minLength: 1 }),
    resourceType: networkResourceTypeSchema,
    includeBodies: { type: "boolean" },
    limit: integerSchema({ minimum: 1, maximum: 200 }),
  },
  {
    title: "OpensteerNetworkQueryInput",
  },
);

export const opensteerNetworkQueryOutputSchema: JsonSchema = objectSchema(
  {
    records: arraySchema(networkQueryRecordSchema),
  },
  {
    title: "OpensteerNetworkQueryOutput",
    required: ["records"],
  },
);

export const opensteerNetworkSaveInputSchema: JsonSchema = objectSchema(
  {
    pageRef: pageRefSchema,
    recordId: stringSchema({ minLength: 1 }),
    requestId: stringSchema({ minLength: 1 }),
    actionId: stringSchema({ minLength: 1 }),
    tag: stringSchema({ minLength: 1 }),
    url: stringSchema({ minLength: 1 }),
    hostname: stringSchema({ minLength: 1 }),
    path: stringSchema({ minLength: 1 }),
    method: stringSchema({ minLength: 1 }),
    status: stringSchema({ minLength: 1 }),
    resourceType: networkResourceTypeSchema,
  },
  {
    title: "OpensteerNetworkSaveInput",
    required: ["tag"],
  },
);

export const opensteerNetworkSaveOutputSchema: JsonSchema = objectSchema(
  {
    savedCount: integerSchema({ minimum: 0 }),
  },
  {
    title: "OpensteerNetworkSaveOutput",
    required: ["savedCount"],
  },
);

export const opensteerNetworkClearInputSchema: JsonSchema = objectSchema(
  {
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

export const opensteerWriteAuthRecipeInputSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
    tags: arraySchema(stringSchema({ minLength: 1 }), {
      uniqueItems: true,
    }),
    provenance: opensteerRegistryProvenanceSchema,
    payload: opensteerAuthRecipePayloadSchema,
  },
  {
    title: "OpensteerWriteAuthRecipeInput",
    required: ["key", "version", "payload"],
  },
);

export const opensteerGetAuthRecipeInputSchema: JsonSchema = objectSchema(
  {
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerGetAuthRecipeInput",
    required: ["key"],
  },
);

export const opensteerListAuthRecipesInputSchema: JsonSchema = objectSchema(
  {
    key: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerListAuthRecipesInput",
  },
);

export const opensteerListAuthRecipesOutputSchema: JsonSchema = objectSchema(
  {
    recipes: arraySchema(opensteerAuthRecipeRecordSchema),
  },
  {
    title: "OpensteerListAuthRecipesOutput",
    required: ["recipes"],
  },
);

export const opensteerRunAuthRecipeInputSchema: JsonSchema = objectSchema(
  {
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
    variables: recordSchema(stringSchema(), {
      title: "OpensteerAuthRecipeVariables",
    }),
  },
  {
    title: "OpensteerRunAuthRecipeInput",
    required: ["key"],
  },
);

export const opensteerRunAuthRecipeOutputSchema: JsonSchema = objectSchema(
  {
    recipe: objectSchema(
      {
        id: stringSchema({ minLength: 1 }),
        key: stringSchema({ minLength: 1 }),
        version: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerResolvedAuthRecipeRef",
        required: ["id", "key", "version"],
      },
    ),
    variables: recordSchema(stringSchema(), {
      title: "OpensteerResolvedAuthRecipeVariables",
    }),
    overrides: opensteerAuthRecipeRetryOverridesSchema,
  },
  {
    title: "OpensteerRunAuthRecipeOutput",
    required: ["recipe", "variables"],
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

export const opensteerRawRequestInputSchema: JsonSchema = objectSchema(
  {
    transport: enumSchema(["session-http", "direct-http"] as const),
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
        recipe: objectSchema(
          {
            key: stringSchema({ minLength: 1 }),
            version: stringSchema({ minLength: 1 }),
          },
          {
            title: "OpensteerResolvedRecoveryRecipeRef",
            required: ["key", "version"],
          },
        ),
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
    lifecycle: opensteerRequestPlanLifecycleSchema,
  },
  {
    title: "OpensteerInferRequestPlanInput",
    required: ["recordId", "key", "version"],
  },
);
