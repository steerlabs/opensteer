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
import type { CaptchaProvider, CaptchaType } from "./captcha.js";
import { captchaProviderSchema, captchaTypeSchema } from "./captcha.js";
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

export interface OpensteerRecipeRef {
  readonly key: string;
  readonly version?: string;
}

export type OpensteerAuthRecipeRef = OpensteerRecipeRef;

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

export type OpensteerRecipeCachePolicy = "none" | "untilFailure";

export interface OpensteerRequestPlanRecipeBinding {
  readonly recipe: OpensteerRecipeRef;
  readonly cachePolicy?: OpensteerRecipeCachePolicy;
}

export interface OpensteerRequestPlanRecoverBinding extends OpensteerRequestPlanRecipeBinding {
  readonly failurePolicy: OpensteerRequestFailurePolicy;
}

export interface OpensteerRequestPlanRecipes {
  readonly prepare?: OpensteerRequestPlanRecipeBinding;
  readonly recover?: OpensteerRequestPlanRecoverBinding;
}

export interface OpensteerRequestPlanAuth {
  readonly strategy: "session-cookie" | "bearer-token" | "api-key" | "custom";
  readonly recipe?: OpensteerRecipeRef;
  readonly failurePolicy?: OpensteerRequestFailurePolicy;
  readonly description?: string;
}

export interface OpensteerRequestPlanPayload {
  readonly transport: OpensteerRequestPlanTransport;
  readonly endpoint: OpensteerRequestPlanEndpoint;
  readonly parameters?: readonly OpensteerRequestPlanParameter[];
  readonly body?: OpensteerRequestPlanBody;
  readonly response?: OpensteerRequestPlanResponseExpectation;
  readonly recipes?: OpensteerRequestPlanRecipes;
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

export interface OpensteerRecipeStepHeaderCapture {
  readonly name: string;
  readonly saveAs: string;
}

export interface OpensteerRecipeStepBodyJsonPointerCapture {
  readonly pointer: string;
  readonly saveAs: string;
}

export interface OpensteerRecipeStepBodyTextCapture {
  readonly saveAs: string;
}

export interface OpensteerRecipeStepResponseCapture {
  readonly header?: OpensteerRecipeStepHeaderCapture;
  readonly bodyJsonPointer?: OpensteerRecipeStepBodyJsonPointerCapture;
  readonly bodyText?: OpensteerRecipeStepBodyTextCapture;
}

export interface OpensteerRecipeRequestStepInput {
  readonly url: string;
  readonly transport?: TransportKind;
  readonly pageRef?: PageRef;
  readonly cookieJar?: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: OpensteerRequestBodyInput;
  readonly followRedirects?: boolean;
}

export interface OpensteerRecipeGotoStep {
  readonly kind: "goto";
  readonly url: string;
  readonly networkTag?: string;
}

export interface OpensteerRecipeReloadStep {
  readonly kind: "reload";
  readonly networkTag?: string;
}

export interface OpensteerRecipeWaitForUrlStep {
  readonly kind: "waitForUrl";
  readonly includes: string;
  readonly timeoutMs?: number;
}

export interface OpensteerRecipeWaitForNetworkStep {
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

export interface OpensteerRecipeWaitForCookieStep {
  readonly kind: "waitForCookie";
  readonly name: string;
  readonly url?: string;
  readonly timeoutMs?: number;
  readonly saveAs?: string;
}

export interface OpensteerRecipeWaitForStorageStep {
  readonly kind: "waitForStorage";
  readonly area: "local" | "session";
  readonly origin: string;
  readonly key: string;
  readonly timeoutMs?: number;
  readonly saveAs?: string;
}

export interface OpensteerRecipeReadCookieStep {
  readonly kind: "readCookie";
  readonly name: string;
  readonly url?: string;
  readonly saveAs: string;
}

export interface OpensteerRecipeReadStorageStep {
  readonly kind: "readStorage";
  readonly area: "local" | "session";
  readonly origin: string;
  readonly key: string;
  readonly pageUrl?: string;
  readonly saveAs: string;
}

export interface OpensteerRecipeEvaluateStep {
  readonly kind: "evaluate";
  readonly script: string;
  readonly args?: readonly JsonValue[];
  readonly pageRef?: PageRef;
  readonly saveAs?: string;
}

export interface OpensteerRecipeSyncCookiesToJarStep {
  readonly kind: "syncCookiesToJar";
  readonly jar: string;
  readonly urls?: readonly string[];
}

export interface OpensteerRecipeRequestStep {
  readonly kind: "request";
  readonly request: OpensteerRecipeRequestStepInput;
  readonly capture?: OpensteerRecipeStepResponseCapture;
}

export interface OpensteerAuthRecipeSessionRequestStep {
  readonly kind: "sessionRequest";
  readonly request: OpensteerRecipeRequestStepInput;
  readonly capture?: OpensteerRecipeStepResponseCapture;
}

export interface OpensteerAuthRecipeDirectRequestStep {
  readonly kind: "directRequest";
  readonly request: OpensteerRecipeRequestStepInput;
  readonly capture?: OpensteerRecipeStepResponseCapture;
}

export interface OpensteerRecipeSolveCaptchaStep {
  readonly kind: "solveCaptcha";
  readonly provider: CaptchaProvider;
  readonly apiKey: string;
  readonly pageRef?: PageRef;
  readonly timeoutMs?: number;
  readonly type?: CaptchaType;
  readonly siteKey?: string;
  readonly pageUrl?: string;
  readonly saveAs?: string;
}

export interface OpensteerRecipeHookRef {
  readonly specifier: string;
  readonly export: string;
}

export type OpensteerAuthRecipeHookRef = OpensteerRecipeHookRef;

export interface OpensteerRecipeHookStep {
  readonly kind: "hook";
  readonly hook: OpensteerRecipeHookRef;
}

export type OpensteerRecipeStep =
  | OpensteerRecipeGotoStep
  | OpensteerRecipeReloadStep
  | OpensteerRecipeWaitForUrlStep
  | OpensteerRecipeWaitForNetworkStep
  | OpensteerRecipeWaitForCookieStep
  | OpensteerRecipeWaitForStorageStep
  | OpensteerRecipeReadCookieStep
  | OpensteerRecipeReadStorageStep
  | OpensteerRecipeEvaluateStep
  | OpensteerRecipeSyncCookiesToJarStep
  | OpensteerRecipeRequestStep
  | OpensteerAuthRecipeSessionRequestStep
  | OpensteerAuthRecipeDirectRequestStep
  | OpensteerRecipeSolveCaptchaStep
  | OpensteerRecipeHookStep;

export type OpensteerAuthRecipeStep = OpensteerRecipeStep;

export interface OpensteerRecipeRetryOverrides {
  readonly params?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: Readonly<Record<string, string>>;
}

export type OpensteerAuthRecipeRetryOverrides = OpensteerRecipeRetryOverrides;

export interface OpensteerRecipePayload {
  readonly description?: string;
  readonly steps: readonly OpensteerRecipeStep[];
  readonly outputs?: OpensteerRecipeRetryOverrides;
}

export type OpensteerAuthRecipePayload = OpensteerRecipePayload;

export interface OpensteerRecipeRecord {
  readonly id: string;
  readonly key: string;
  readonly version: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly contentHash: string;
  readonly tags: readonly string[];
  readonly provenance?: OpensteerRegistryProvenance;
  readonly payload: OpensteerRecipePayload;
}

export type OpensteerAuthRecipeRecord = OpensteerRecipeRecord;

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

export interface OpensteerWriteRecipeInput {
  readonly id?: string;
  readonly key: string;
  readonly version: string;
  readonly tags?: readonly string[];
  readonly provenance?: OpensteerRegistryProvenance;
  readonly payload: OpensteerRecipePayload;
}

export type OpensteerWriteAuthRecipeInput = OpensteerWriteRecipeInput;

export interface OpensteerGetRecipeInput {
  readonly key: string;
  readonly version?: string;
}

export type OpensteerGetAuthRecipeInput = OpensteerGetRecipeInput;

export interface OpensteerListRecipesInput {
  readonly key?: string;
}

export type OpensteerListAuthRecipesInput = OpensteerListRecipesInput;

export interface OpensteerListRecipesOutput {
  readonly recipes: readonly OpensteerRecipeRecord[];
}

export type OpensteerListAuthRecipesOutput = OpensteerListRecipesOutput;

export interface OpensteerRunRecipeInput {
  readonly key: string;
  readonly version?: string;
  readonly variables?: Readonly<Record<string, string>>;
}

export type OpensteerRunAuthRecipeInput = OpensteerRunRecipeInput;

export interface OpensteerRunRecipeOutput {
  readonly recipe: {
    readonly id: string;
    readonly key: string;
    readonly version: string;
  };
  readonly variables: Readonly<Record<string, string>>;
  readonly overrides?: OpensteerRecipeRetryOverrides;
}

export type OpensteerRunAuthRecipeOutput = OpensteerRunRecipeOutput;

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

export const opensteerRecipeRefSchema: JsonSchema = objectSchema(
  {
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerRecipeRef",
    required: ["key"],
  },
);

export const opensteerAuthRecipeRefSchema: JsonSchema = opensteerRecipeRefSchema;

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

export const opensteerRecipeCachePolicySchema: JsonSchema = enumSchema(
  ["none", "untilFailure"] as const,
  {
    title: "OpensteerRecipeCachePolicy",
  },
);

export const opensteerRequestPlanRecipeBindingSchema: JsonSchema = objectSchema(
  {
    recipe: opensteerRecipeRefSchema,
    cachePolicy: opensteerRecipeCachePolicySchema,
  },
  {
    title: "OpensteerRequestPlanRecipeBinding",
    required: ["recipe"],
  },
);

export const opensteerRequestPlanRecoverBindingSchema: JsonSchema = objectSchema(
  {
    recipe: opensteerRecipeRefSchema,
    cachePolicy: opensteerRecipeCachePolicySchema,
    failurePolicy: opensteerRequestFailurePolicySchema,
  },
  {
    title: "OpensteerRequestPlanRecoverBinding",
    required: ["recipe", "failurePolicy"],
  },
);

export const opensteerRequestPlanRecipesSchema: JsonSchema = objectSchema(
  {
    prepare: opensteerRequestPlanRecipeBindingSchema,
    recover: opensteerRequestPlanRecoverBindingSchema,
  },
  {
    title: "OpensteerRequestPlanRecipes",
  },
);

export const opensteerRequestPlanAuthSchema: JsonSchema = objectSchema(
  {
    strategy: enumSchema(["session-cookie", "bearer-token", "api-key", "custom"] as const),
    recipe: opensteerRecipeRefSchema,
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
    recipes: opensteerRequestPlanRecipesSchema,
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

const opensteerRecipeRetryOverridesSchema: JsonSchema = objectSchema(
  {
    params: recordSchema(stringSchema(), {
      title: "OpensteerRecipeParams",
    }),
    headers: recordSchema(stringSchema(), {
      title: "OpensteerRecipeHeaders",
    }),
    query: recordSchema(stringSchema(), {
      title: "OpensteerRecipeQuery",
    }),
    body: recordSchema(stringSchema(), {
      title: "OpensteerRecipeBodyVariables",
    }),
  },
  {
    title: "OpensteerRecipeRetryOverrides",
  },
);

const opensteerAuthRecipeRetryOverridesSchema: JsonSchema = opensteerRecipeRetryOverridesSchema;

const opensteerRecipeStepResponseCaptureSchema: JsonSchema = objectSchema(
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
    title: "OpensteerRecipeStepResponseCapture",
  },
);

const opensteerRecipeRequestStepInputSchema: JsonSchema = objectSchema(
  {
    url: stringSchema({ minLength: 1 }),
    transport: transportKindSchema,
    pageRef: pageRefSchema,
    cookieJar: stringSchema({ minLength: 1 }),
    method: stringSchema({ minLength: 1 }),
    headers: recordSchema(stringSchema(), {
      title: "OpensteerRecipeRequestHeaders",
    }),
    query: recordSchema(stringSchema(), {
      title: "OpensteerRecipeRequestQuery",
    }),
    body: opensteerRequestBodyInputSchema,
    followRedirects: { type: "boolean" },
  },
  {
    title: "OpensteerRecipeRequestStepInput",
    required: ["url"],
  },
);

export const opensteerRecipeHookRefSchema: JsonSchema = objectSchema(
  {
    specifier: stringSchema({ minLength: 1 }),
    export: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerRecipeHookRef",
    required: ["specifier", "export"],
  },
);

export const opensteerAuthRecipeHookRefSchema: JsonSchema = opensteerRecipeHookRefSchema;

export const opensteerRecipeStepSchema: JsonSchema = oneOfSchema(
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
        title: "OpensteerRecipeWaitForNetworkStep",
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
        title: "OpensteerRecipeReadStorageStep",
        required: ["kind", "area", "origin", "key", "saveAs"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["evaluate"] as const),
        script: stringSchema({ minLength: 1 }),
        args: arraySchema(jsonValueSchema),
        pageRef: pageRefSchema,
        saveAs: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerRecipeEvaluateStep",
        required: ["kind", "script"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["syncCookiesToJar"] as const),
        jar: stringSchema({ minLength: 1 }),
        urls: arraySchema(stringSchema({ minLength: 1 }), {
          minItems: 1,
        }),
      },
      {
        title: "OpensteerRecipeSyncCookiesToJarStep",
        required: ["kind", "jar"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["request"] as const),
        request: opensteerRecipeRequestStepInputSchema,
        capture: opensteerRecipeStepResponseCaptureSchema,
      },
      {
        title: "OpensteerRecipeRequestStep",
        required: ["kind", "request"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["sessionRequest"] as const),
        request: opensteerRecipeRequestStepInputSchema,
        capture: opensteerRecipeStepResponseCaptureSchema,
      },
      {
        title: "OpensteerAuthRecipeSessionRequestStep",
        required: ["kind", "request"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["directRequest"] as const),
        request: opensteerRecipeRequestStepInputSchema,
        capture: opensteerRecipeStepResponseCaptureSchema,
      },
      {
        title: "OpensteerAuthRecipeDirectRequestStep",
        required: ["kind", "request"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["solveCaptcha"] as const),
        provider: captchaProviderSchema,
        apiKey: stringSchema({ minLength: 1 }),
        pageRef: pageRefSchema,
        timeoutMs: integerSchema({ minimum: 1 }),
        type: captchaTypeSchema,
        siteKey: stringSchema({ minLength: 1 }),
        pageUrl: stringSchema({ minLength: 1 }),
        saveAs: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerRecipeSolveCaptchaStep",
        required: ["kind", "provider", "apiKey"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["hook"] as const),
        hook: opensteerRecipeHookRefSchema,
      },
      {
        title: "OpensteerRecipeHookStep",
        required: ["kind", "hook"],
      },
    ),
  ],
  {
    title: "OpensteerRecipeStep",
  },
);

export const opensteerAuthRecipeStepSchema: JsonSchema = opensteerRecipeStepSchema;

export const opensteerRecipePayloadSchema: JsonSchema = objectSchema(
  {
    description: stringSchema({ minLength: 1 }),
    steps: arraySchema(opensteerRecipeStepSchema, {
      minItems: 1,
    }),
    outputs: opensteerRecipeRetryOverridesSchema,
  },
  {
    title: "OpensteerRecipePayload",
    required: ["steps"],
  },
);

export const opensteerAuthRecipePayloadSchema: JsonSchema = opensteerRecipePayloadSchema;

export const opensteerRecipeRecordSchema: JsonSchema = objectSchema(
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
    payload: opensteerRecipePayloadSchema,
  },
  {
    title: "OpensteerRecipeRecord",
    required: ["id", "key", "version", "createdAt", "updatedAt", "contentHash", "tags", "payload"],
  },
);

export const opensteerAuthRecipeRecordSchema: JsonSchema = opensteerRecipeRecordSchema;

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

export const opensteerWriteRecipeInputSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
    tags: arraySchema(stringSchema({ minLength: 1 }), {
      uniqueItems: true,
    }),
    provenance: opensteerRegistryProvenanceSchema,
    payload: opensteerRecipePayloadSchema,
  },
  {
    title: "OpensteerWriteRecipeInput",
    required: ["key", "version", "payload"],
  },
);

export const opensteerWriteAuthRecipeInputSchema: JsonSchema = opensteerWriteRecipeInputSchema;

export const opensteerGetRecipeInputSchema: JsonSchema = objectSchema(
  {
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerGetRecipeInput",
    required: ["key"],
  },
);

export const opensteerGetAuthRecipeInputSchema: JsonSchema = opensteerGetRecipeInputSchema;

export const opensteerListRecipesInputSchema: JsonSchema = objectSchema(
  {
    key: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerListRecipesInput",
  },
);

export const opensteerListAuthRecipesInputSchema: JsonSchema = opensteerListRecipesInputSchema;

export const opensteerListRecipesOutputSchema: JsonSchema = objectSchema(
  {
    recipes: arraySchema(opensteerRecipeRecordSchema),
  },
  {
    title: "OpensteerListRecipesOutput",
    required: ["recipes"],
  },
);

export const opensteerListAuthRecipesOutputSchema: JsonSchema = opensteerListRecipesOutputSchema;

export const opensteerRunRecipeInputSchema: JsonSchema = objectSchema(
  {
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
    variables: recordSchema(stringSchema(), {
      title: "OpensteerRecipeVariables",
    }),
  },
  {
    title: "OpensteerRunRecipeInput",
    required: ["key"],
  },
);

export const opensteerRunAuthRecipeInputSchema: JsonSchema = opensteerRunRecipeInputSchema;

export const opensteerRunRecipeOutputSchema: JsonSchema = objectSchema(
  {
    recipe: objectSchema(
      {
        id: stringSchema({ minLength: 1 }),
        key: stringSchema({ minLength: 1 }),
        version: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerResolvedRecipeRef",
        required: ["id", "key", "version"],
      },
    ),
    variables: recordSchema(stringSchema(), {
      title: "OpensteerResolvedRecipeVariables",
    }),
    overrides: opensteerRecipeRetryOverridesSchema,
  },
  {
    title: "OpensteerRunRecipeOutput",
    required: ["recipe", "variables"],
  },
);

export const opensteerRunAuthRecipeOutputSchema: JsonSchema = opensteerRunRecipeOutputSchema;

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
    transport: transportKindSchema,
  },
  {
    title: "OpensteerInferRequestPlanInput",
    required: ["recordId", "key", "version"],
  },
);
