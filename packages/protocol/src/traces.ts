import {
  artifactReferenceSchema,
  opensteerArtifactSchema,
  type ArtifactReference,
  type OpensteerArtifact,
} from "./artifacts.js";
import { opensteerEventSchema, type OpensteerEvent } from "./events.js";
import type { DocumentEpoch, DocumentRef, FrameRef, PageRef, SessionRef } from "./identity.js";
import {
  documentEpochSchema,
  documentRefSchema,
  frameRefSchema,
  pageRefSchema,
  sessionRefSchema,
} from "./identity.js";
import {
  arraySchema,
  enumSchema,
  integerSchema,
  objectSchema,
  stringSchema,
  type JsonSchema,
} from "./json.js";
import { opensteerErrorSchema, type OpensteerError } from "./errors.js";

export type TraceOutcome = "ok" | "error";

export interface TraceContext {
  readonly sessionRef?: SessionRef;
  readonly pageRef?: PageRef;
  readonly frameRef?: FrameRef;
  readonly documentRef?: DocumentRef;
  readonly documentEpoch?: DocumentEpoch;
}

export interface TraceRecord<TData = unknown> {
  readonly traceId: string;
  readonly stepId: string;
  readonly operation: string;
  readonly outcome: TraceOutcome;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly durationMs: number;
  readonly context: TraceContext;
  readonly events: readonly OpensteerEvent[];
  readonly artifacts?: readonly ArtifactReference[];
  readonly data?: TData;
  readonly error?: OpensteerError;
}

export interface TraceBundle<TData = unknown> {
  readonly trace: TraceRecord<TData>;
  readonly artifacts?: readonly OpensteerArtifact[];
}

export const traceContextSchema: JsonSchema = objectSchema(
  {
    sessionRef: sessionRefSchema,
    pageRef: pageRefSchema,
    frameRef: frameRefSchema,
    documentRef: documentRefSchema,
    documentEpoch: documentEpochSchema,
  },
  {
    title: "TraceContext",
  },
);

export function traceRecordSchema(dataSchema: JsonSchema = {}): JsonSchema {
  return objectSchema(
    {
      traceId: stringSchema(),
      stepId: stringSchema(),
      operation: stringSchema(),
      outcome: enumSchema(["ok", "error"] as const),
      startedAt: integerSchema({ minimum: 0 }),
      completedAt: integerSchema({ minimum: 0 }),
      durationMs: integerSchema({ minimum: 0 }),
      context: traceContextSchema,
      events: arraySchema(opensteerEventSchema),
      artifacts: arraySchema(artifactReferenceSchema),
      data: dataSchema,
      error: opensteerErrorSchema,
    },
    {
      title: "TraceRecord",
      required: [
        "traceId",
        "stepId",
        "operation",
        "outcome",
        "startedAt",
        "completedAt",
        "durationMs",
        "context",
        "events",
      ],
    },
  );
}

export function traceBundleSchema(dataSchema: JsonSchema = {}): JsonSchema {
  return objectSchema(
    {
      trace: traceRecordSchema(dataSchema),
      artifacts: arraySchema(opensteerArtifactSchema),
    },
    {
      title: "TraceBundle",
      required: ["trace"],
    },
  );
}
