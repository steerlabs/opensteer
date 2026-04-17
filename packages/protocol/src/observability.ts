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
  recordSchema,
  stringSchema,
  type JsonSchema,
  type JsonValue,
} from "./json.js";

export const observabilityProfiles = ["off", "baseline", "diagnostic"] as const;
export type ObservabilityProfile = (typeof observabilityProfiles)[number];

export interface ObservabilityTraceContext {
  readonly traceparent?: string;
  readonly baggage?: string;
}

export interface ObservabilityRedactionConfig {
  readonly sensitiveKeys?: readonly string[];
  readonly sensitiveValues?: readonly string[];
}

export interface ObservabilityConfig {
  readonly profile: ObservabilityProfile;
  readonly labels?: Readonly<Record<string, string>>;
  readonly traceContext?: ObservabilityTraceContext;
  readonly redaction?: ObservabilityRedactionConfig;
}

export interface ObservationContext {
  readonly sessionRef?: SessionRef;
  readonly pageRef?: PageRef;
  readonly frameRef?: FrameRef;
  readonly documentRef?: DocumentRef;
  readonly documentEpoch?: DocumentEpoch;
}

export const observationEventPhases = [
  "started",
  "updated",
  "completed",
  "failed",
  "occurred",
] as const;
export type ObservationEventPhase = (typeof observationEventPhases)[number];

export const observationEventKinds = [
  "session",
  "operation",
  "page",
  "console",
  "error",
  "network",
  "artifact",
  "annotation",
  "runtime",
  "observability",
] as const;
export type ObservationEventKind = (typeof observationEventKinds)[number];

export interface ObservationEventError {
  readonly code?: string;
  readonly message: string;
  readonly retriable?: boolean;
  readonly details?: JsonValue;
}

export interface ObservationEvent {
  readonly eventId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly kind: ObservationEventKind;
  readonly phase: ObservationEventPhase;
  readonly createdAt: number;
  readonly correlationId: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly context?: ObservationContext;
  readonly data?: JsonValue;
  readonly error?: ObservationEventError;
  readonly artifactIds?: readonly string[];
}

export const observationArtifactKinds = [
  "screenshot",
  "dom-snapshot",
  "html-snapshot",
  "trace-bundle",
  "frame-buffer",
  "request-body",
  "response-body",
  "log",
  "other",
] as const;
export type ObservationArtifactKind = (typeof observationArtifactKinds)[number];

export interface ObservationArtifact {
  readonly artifactId: string;
  readonly sessionId: string;
  readonly kind: ObservationArtifactKind;
  readonly createdAt: number;
  readonly context?: ObservationContext;
  readonly mediaType?: string;
  readonly byteLength?: number;
  readonly sha256?: string;
  readonly opensteerArtifactId?: string;
  readonly storageKey?: string;
  readonly metadata?: JsonValue;
}

export interface ObservationSession {
  readonly sessionId: string;
  readonly profile: ObservabilityProfile;
  readonly labels?: Readonly<Record<string, string>>;
  readonly traceContext?: ObservabilityTraceContext;
  readonly openedAt: number;
  readonly updatedAt: number;
  readonly closedAt?: number;
  readonly currentSequence: number;
  readonly eventCount: number;
  readonly artifactCount: number;
}

export interface OpenObservationSessionInput {
  readonly sessionId: string;
  readonly openedAt?: number;
  readonly config?: Partial<ObservabilityConfig>;
}

export interface ConfigureObservationSessionInput {
  readonly updatedAt?: number;
  readonly config?: Partial<ObservabilityConfig>;
}

export interface AppendObservationEventInput {
  readonly eventId?: string;
  readonly kind: ObservationEventKind;
  readonly phase: ObservationEventPhase;
  readonly createdAt: number;
  readonly correlationId: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly context?: ObservationContext;
  readonly data?: JsonValue;
  readonly error?: ObservationEventError;
  readonly artifactIds?: readonly string[];
}

export interface WriteObservationArtifactInput {
  readonly artifactId: string;
  readonly kind: ObservationArtifactKind;
  readonly createdAt: number;
  readonly context?: ObservationContext;
  readonly mediaType?: string;
  readonly byteLength?: number;
  readonly sha256?: string;
  readonly opensteerArtifactId?: string;
  readonly storageKey?: string;
  readonly metadata?: JsonValue;
}

export interface SessionObservationSink {
  readonly sessionId: string;

  configure?(input: ConfigureObservationSessionInput): Promise<void>;
  append(input: AppendObservationEventInput): Promise<ObservationEvent>;
  appendBatch(input: readonly AppendObservationEventInput[]): Promise<readonly ObservationEvent[]>;
  writeArtifact(input: WriteObservationArtifactInput): Promise<ObservationArtifact>;
  flush(reason?: string): Promise<void>;
  close(reason?: string): Promise<void>;
}

export interface ObservationSink {
  openSession(input: OpenObservationSessionInput): Promise<SessionObservationSink>;
}

export const observabilityProfileSchema: JsonSchema = enumSchema(observabilityProfiles, {
  title: "ObservabilityProfile",
});

export const observabilityTraceContextSchema: JsonSchema = objectSchema(
  {
    traceparent: stringSchema(),
    baggage: stringSchema(),
  },
  {
    title: "ObservabilityTraceContext",
  },
);

export const observabilityRedactionConfigSchema: JsonSchema = objectSchema(
  {
    sensitiveKeys: arraySchema(stringSchema()),
    sensitiveValues: arraySchema(stringSchema()),
  },
  {
    title: "ObservabilityRedactionConfig",
  },
);

export const observabilityConfigSchema: JsonSchema = objectSchema(
  {
    profile: observabilityProfileSchema,
    labels: recordSchema(stringSchema()),
    traceContext: observabilityTraceContextSchema,
    redaction: observabilityRedactionConfigSchema,
  },
  {
    title: "ObservabilityConfig",
    required: ["profile"],
  },
);

export const observationContextSchema: JsonSchema = objectSchema(
  {
    sessionRef: sessionRefSchema,
    pageRef: pageRefSchema,
    frameRef: frameRefSchema,
    documentRef: documentRefSchema,
    documentEpoch: documentEpochSchema,
  },
  {
    title: "ObservationContext",
  },
);

export const observationEventErrorSchema: JsonSchema = objectSchema(
  {
    code: stringSchema(),
    message: stringSchema(),
    retriable: {
      type: "boolean",
    },
    details: {},
  },
  {
    title: "ObservationEventError",
    required: ["message"],
  },
);

export const observationEventSchema: JsonSchema = objectSchema(
  {
    eventId: stringSchema(),
    sessionId: stringSchema(),
    sequence: integerSchema({ minimum: 1 }),
    kind: enumSchema(observationEventKinds),
    phase: enumSchema(observationEventPhases),
    createdAt: integerSchema({ minimum: 0 }),
    correlationId: stringSchema(),
    spanId: stringSchema(),
    parentSpanId: stringSchema(),
    context: observationContextSchema,
    data: {},
    error: observationEventErrorSchema,
    artifactIds: arraySchema(stringSchema()),
  },
  {
    title: "ObservationEvent",
    required: ["eventId", "sessionId", "sequence", "kind", "phase", "createdAt", "correlationId"],
  },
);

export const observationArtifactSchema: JsonSchema = objectSchema(
  {
    artifactId: stringSchema(),
    sessionId: stringSchema(),
    kind: enumSchema(observationArtifactKinds),
    createdAt: integerSchema({ minimum: 0 }),
    context: observationContextSchema,
    mediaType: stringSchema(),
    byteLength: integerSchema({ minimum: 0 }),
    sha256: stringSchema(),
    opensteerArtifactId: stringSchema(),
    storageKey: stringSchema(),
    metadata: {},
  },
  {
    title: "ObservationArtifact",
    required: ["artifactId", "sessionId", "kind", "createdAt"],
  },
);

export const observationSessionSchema: JsonSchema = objectSchema(
  {
    sessionId: stringSchema(),
    profile: observabilityProfileSchema,
    labels: recordSchema(stringSchema()),
    traceContext: observabilityTraceContextSchema,
    openedAt: integerSchema({ minimum: 0 }),
    updatedAt: integerSchema({ minimum: 0 }),
    closedAt: integerSchema({ minimum: 0 }),
    currentSequence: integerSchema({ minimum: 0 }),
    eventCount: integerSchema({ minimum: 0 }),
    artifactCount: integerSchema({ minimum: 0 }),
  },
  {
    title: "ObservationSession",
    required: [
      "sessionId",
      "profile",
      "openedAt",
      "updatedAt",
      "currentSequence",
      "eventCount",
      "artifactCount",
    ],
  },
);
