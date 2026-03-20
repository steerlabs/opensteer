import type { JsonSchema } from "./json.js";
import { arraySchema, enumSchema, integerSchema, objectSchema, stringSchema } from "./json.js";
import type { TransportKind, OpensteerWriteRequestPlanInput } from "./requests.js";
import { transportKindSchema, opensteerWriteRequestPlanInputSchema } from "./requests.js";

export type MinimizationFieldClassification = "required" | "optional" | "untested";

export interface MinimizationFieldResult {
  readonly name: string;
  readonly location: "header" | "cookie" | "query" | "body-field";
  readonly classification: MinimizationFieldClassification;
  readonly originalValue?: string;
}

export interface OpensteerNetworkMinimizeSuccessPolicy {
  readonly statusCodes?: readonly number[];
  readonly responseBodyIncludes?: readonly string[];
  readonly responseStructureMatch?: boolean;
}

export interface OpensteerNetworkMinimizeInput {
  readonly recordId: string;
  readonly transport?: TransportKind;
  readonly successPolicy?: OpensteerNetworkMinimizeSuccessPolicy;
  readonly maxTrials?: number;
  readonly preserve?: readonly string[];
}

export interface OpensteerNetworkMinimizeOutput {
  readonly recordId: string;
  readonly totalTrials: number;
  readonly fields: readonly MinimizationFieldResult[];
  readonly minimizedPlan?: OpensteerWriteRequestPlanInput;
}

export const minimizationFieldClassificationSchema: JsonSchema = enumSchema(
  ["required", "optional", "untested"] as const,
  {
    title: "MinimizationFieldClassification",
  },
);

export const minimizationFieldResultSchema: JsonSchema = objectSchema(
  {
    name: stringSchema({ minLength: 1 }),
    location: enumSchema(["header", "cookie", "query", "body-field"] as const),
    classification: minimizationFieldClassificationSchema,
    originalValue: stringSchema(),
  },
  {
    title: "MinimizationFieldResult",
    required: ["name", "location", "classification"],
  },
);

export const opensteerNetworkMinimizeSuccessPolicySchema: JsonSchema = objectSchema(
  {
    statusCodes: arraySchema(integerSchema({ minimum: 100, maximum: 599 }), {
      minItems: 1,
      uniqueItems: true,
    }),
    responseBodyIncludes: arraySchema(stringSchema({ minLength: 1 }), {
      minItems: 1,
      uniqueItems: true,
    }),
    responseStructureMatch: { type: "boolean" },
  },
  {
    title: "OpensteerNetworkMinimizeSuccessPolicy",
  },
);

export const opensteerNetworkMinimizeInputSchema: JsonSchema = objectSchema(
  {
    recordId: stringSchema({ minLength: 1 }),
    transport: transportKindSchema,
    successPolicy: opensteerNetworkMinimizeSuccessPolicySchema,
    maxTrials: integerSchema({ minimum: 1 }),
    preserve: arraySchema(stringSchema({ minLength: 1 }), {
      minItems: 1,
      uniqueItems: true,
    }),
  },
  {
    title: "OpensteerNetworkMinimizeInput",
    required: ["recordId"],
  },
);

export const opensteerNetworkMinimizeOutputSchema: JsonSchema = objectSchema(
  {
    recordId: stringSchema({ minLength: 1 }),
    totalTrials: integerSchema({ minimum: 0 }),
    fields: arraySchema(minimizationFieldResultSchema),
    minimizedPlan: opensteerWriteRequestPlanInputSchema,
  },
  {
    title: "OpensteerNetworkMinimizeOutput",
    required: ["recordId", "totalTrials", "fields"],
  },
);
