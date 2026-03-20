import type { JsonSchema } from "./json.js";
import { arraySchema, enumSchema, integerSchema, objectSchema, stringSchema } from "./json.js";

export type TransportProbeLevel =
  | "direct-http"
  | "matched-tls"
  | "context-http"
  | "page-eval-http"
  | "session-http";

export interface OpensteerTransportProbeInput {
  readonly recordId: string;
}

export interface TransportProbeResult {
  readonly transport: TransportProbeLevel;
  readonly status: number | null;
  readonly success: boolean;
  readonly durationMs: number;
  readonly error?: string;
}

export interface OpensteerTransportProbeOutput {
  readonly results: readonly TransportProbeResult[];
  readonly recommendation: TransportProbeLevel;
}

export const transportProbeLevelSchema: JsonSchema = enumSchema(
  ["direct-http", "matched-tls", "context-http", "page-eval-http", "session-http"] as const,
  {
    title: "TransportProbeLevel",
  },
);

export const opensteerTransportProbeInputSchema: JsonSchema = objectSchema(
  {
    recordId: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerTransportProbeInput",
    required: ["recordId"],
  },
);

export const transportProbeResultSchema: JsonSchema = objectSchema(
  {
    transport: transportProbeLevelSchema,
    status: {
      type: ["integer", "null"],
      minimum: 100,
      maximum: 599,
    },
    success: { type: "boolean" },
    durationMs: integerSchema({ minimum: 0 }),
    error: stringSchema({ minLength: 1 }),
  },
  {
    title: "TransportProbeResult",
    required: ["transport", "status", "success", "durationMs"],
  },
);

export const opensteerTransportProbeOutputSchema: JsonSchema = objectSchema(
  {
    results: arraySchema(transportProbeResultSchema),
    recommendation: transportProbeLevelSchema,
  },
  {
    title: "OpensteerTransportProbeOutput",
    required: ["results", "recommendation"],
  },
);
