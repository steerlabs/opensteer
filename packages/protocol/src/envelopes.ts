import type { OpensteerArtifact } from "./artifacts.js";
import { opensteerArtifactSchema } from "./artifacts.js";
import type { OpensteerCapability } from "./capabilities.js";
import { opensteerCapabilitySetSchema } from "./capabilities.js";
import type { OpensteerError } from "./errors.js";
import { opensteerErrorSchema } from "./errors.js";
import {
  arraySchema,
  enumSchema,
  integerSchema,
  literalSchema,
  objectSchema,
  oneOfSchema,
  stringSchema,
  type JsonSchema,
} from "./json.js";
import type { TraceRecord } from "./traces.js";
import { traceRecordSchema } from "./traces.js";
import {
  OPENSTEER_PROTOCOL_NAME,
  OPENSTEER_PROTOCOL_VERSION,
  type OpensteerProtocolVersion,
} from "./version.js";

export interface OpensteerRequestEnvelope<TInput> {
  readonly protocol: typeof OPENSTEER_PROTOCOL_NAME;
  readonly version: OpensteerProtocolVersion;
  readonly requestId: string;
  readonly operation: string;
  readonly sentAt: number;
  readonly input: TInput;
}

export interface OpensteerSuccessEnvelope<TOutput> {
  readonly protocol: typeof OPENSTEER_PROTOCOL_NAME;
  readonly version: OpensteerProtocolVersion;
  readonly requestId: string;
  readonly operation: string;
  readonly status: "ok";
  readonly receivedAt: number;
  readonly data: TOutput;
  readonly trace?: TraceRecord<TOutput>;
  readonly artifacts?: readonly OpensteerArtifact[];
  readonly capabilities?: readonly OpensteerCapability[];
}

export interface OpensteerErrorEnvelope {
  readonly protocol: typeof OPENSTEER_PROTOCOL_NAME;
  readonly version: OpensteerProtocolVersion;
  readonly requestId: string;
  readonly operation: string;
  readonly status: "error";
  readonly receivedAt: number;
  readonly error: OpensteerError;
  readonly trace?: TraceRecord<unknown>;
  readonly artifacts?: readonly OpensteerArtifact[];
  readonly capabilities?: readonly OpensteerCapability[];
}

export type OpensteerResponseEnvelope<TOutput> =
  | OpensteerSuccessEnvelope<TOutput>
  | OpensteerErrorEnvelope;

export function createRequestEnvelope<TInput>(
  operation: string,
  input: TInput,
  options: {
    readonly requestId: string;
    readonly sentAt?: number;
    readonly version?: OpensteerProtocolVersion;
  },
): OpensteerRequestEnvelope<TInput> {
  return {
    protocol: OPENSTEER_PROTOCOL_NAME,
    version: options.version ?? OPENSTEER_PROTOCOL_VERSION,
    requestId: options.requestId,
    operation,
    sentAt: options.sentAt ?? Date.now(),
    input,
  };
}

export function createSuccessEnvelope<TOutput>(
  request: Pick<OpensteerRequestEnvelope<unknown>, "requestId" | "operation" | "version">,
  data: TOutput,
  options: {
    readonly receivedAt?: number;
    readonly trace?: TraceRecord<TOutput>;
    readonly artifacts?: readonly OpensteerArtifact[];
    readonly capabilities?: readonly OpensteerCapability[];
  } = {},
): OpensteerSuccessEnvelope<TOutput> {
  return {
    protocol: OPENSTEER_PROTOCOL_NAME,
    version: request.version,
    requestId: request.requestId,
    operation: request.operation,
    status: "ok",
    receivedAt: options.receivedAt ?? Date.now(),
    data,
    ...(options.trace === undefined ? {} : { trace: options.trace }),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
  };
}

export function createErrorEnvelope(
  request: Pick<OpensteerRequestEnvelope<unknown>, "requestId" | "operation" | "version">,
  error: OpensteerError,
  options: {
    readonly receivedAt?: number;
    readonly trace?: TraceRecord<unknown>;
    readonly artifacts?: readonly OpensteerArtifact[];
    readonly capabilities?: readonly OpensteerCapability[];
  } = {},
): OpensteerErrorEnvelope {
  return {
    protocol: OPENSTEER_PROTOCOL_NAME,
    version: request.version,
    requestId: request.requestId,
    operation: request.operation,
    status: "error",
    receivedAt: options.receivedAt ?? Date.now(),
    error,
    ...(options.trace === undefined ? {} : { trace: options.trace }),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
  };
}

export function isErrorEnvelope<TOutput>(
  envelope: OpensteerResponseEnvelope<TOutput>,
): envelope is OpensteerErrorEnvelope {
  return envelope.status === "error";
}

export function requestEnvelopeSchema(inputSchema: JsonSchema): JsonSchema {
  return objectSchema(
    {
      protocol: literalSchema(OPENSTEER_PROTOCOL_NAME),
      version: literalSchema(OPENSTEER_PROTOCOL_VERSION),
      requestId: stringSchema(),
      operation: stringSchema(),
      sentAt: integerSchema({ minimum: 0 }),
      input: inputSchema,
    },
    {
      title: "OpensteerRequestEnvelope",
      required: ["protocol", "version", "requestId", "operation", "sentAt", "input"],
    },
  );
}

export function successEnvelopeSchema(dataSchema: JsonSchema): JsonSchema {
  return objectSchema(
    {
      protocol: literalSchema(OPENSTEER_PROTOCOL_NAME),
      version: literalSchema(OPENSTEER_PROTOCOL_VERSION),
      requestId: stringSchema(),
      operation: stringSchema(),
      status: enumSchema(["ok"] as const),
      receivedAt: integerSchema({ minimum: 0 }),
      data: dataSchema,
      trace: traceRecordSchema(dataSchema),
      artifacts: arraySchema(opensteerArtifactSchema),
      capabilities: opensteerCapabilitySetSchema,
    },
    {
      title: "OpensteerSuccessEnvelope",
      required: ["protocol", "version", "requestId", "operation", "status", "receivedAt", "data"],
    },
  );
}

export const opensteerErrorEnvelopeSchema: JsonSchema = objectSchema(
  {
    protocol: literalSchema(OPENSTEER_PROTOCOL_NAME),
    version: literalSchema(OPENSTEER_PROTOCOL_VERSION),
    requestId: stringSchema(),
    operation: stringSchema(),
    status: enumSchema(["error"] as const),
    receivedAt: integerSchema({ minimum: 0 }),
    error: opensteerErrorSchema,
    trace: traceRecordSchema(),
    artifacts: arraySchema(opensteerArtifactSchema),
    capabilities: opensteerCapabilitySetSchema,
  },
  {
    title: "OpensteerErrorEnvelope",
    required: ["protocol", "version", "requestId", "operation", "status", "receivedAt", "error"],
  },
);

export function responseEnvelopeSchema(dataSchema: JsonSchema): JsonSchema {
  return oneOfSchema([successEnvelopeSchema(dataSchema), opensteerErrorEnvelopeSchema], {
    title: "OpensteerResponseEnvelope",
  });
}
