import type { JsonSchema } from "./json.js";
import {
  arraySchema,
  defineSchema,
  integerSchema,
  objectSchema,
  recordSchema,
  stringSchema,
  enumSchema,
  oneOfSchema,
} from "./json.js";
import { pageRefSchema, type PageRef } from "./identity.js";
import { opensteerRegistryProvenanceSchema, type OpensteerRegistryProvenance } from "./requests.js";
import {
  opensteerStateDeltaSchema,
  opensteerStateSnapshotSchema,
  type OpensteerStateDelta,
  type OpensteerStateSnapshot,
} from "./reverse.js";
import type { JsonValue } from "./json.js";
import type { OpensteerTargetInput } from "./semantic.js";

export type OpensteerInteractionCaptureStep =
  | {
      readonly kind: "goto";
      readonly url: string;
    }
  | {
      readonly kind: "click";
      readonly target: OpensteerTargetInput;
    }
  | {
      readonly kind: "hover";
      readonly target: OpensteerTargetInput;
    }
  | {
      readonly kind: "input";
      readonly target: OpensteerTargetInput;
      readonly text: string;
      readonly pressEnter?: boolean;
    }
  | {
      readonly kind: "scroll";
      readonly target: OpensteerTargetInput;
      readonly direction: "up" | "down" | "left" | "right";
      readonly amount: number;
    }
  | {
      readonly kind: "wait";
      readonly durationMs: number;
    };

export interface OpensteerInteractionEventRecord {
  readonly type: string;
  readonly timestamp: number;
  readonly targetPath?: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

export interface OpensteerInteractionTracePayload {
  readonly mode: "manual" | "automated";
  readonly pageRef?: PageRef;
  readonly url?: string;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly beforeState?: OpensteerStateSnapshot;
  readonly afterState?: OpensteerStateSnapshot;
  readonly stateDelta?: OpensteerStateDelta;
  readonly events: readonly OpensteerInteractionEventRecord[];
  readonly networkRecordIds: readonly string[];
  readonly caseId?: string;
  readonly notes?: string;
}

export interface OpensteerInteractionTraceRecord {
  readonly id: string;
  readonly key: string;
  readonly version: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly contentHash: string;
  readonly tags: readonly string[];
  readonly provenance?: OpensteerRegistryProvenance;
  readonly payload: OpensteerInteractionTracePayload;
}

export interface OpensteerInteractionCaptureInput {
  readonly key?: string;
  readonly pageRef?: PageRef;
  readonly durationMs?: number;
  readonly script?: string;
  readonly args?: readonly JsonValue[];
  readonly steps?: readonly OpensteerInteractionCaptureStep[];
  readonly includeStorage?: boolean;
  readonly includeSessionStorage?: boolean;
  readonly includeIndexedDb?: boolean;
  readonly globalNames?: readonly string[];
  readonly caseId?: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
}

export interface OpensteerInteractionCaptureOutput {
  readonly trace: OpensteerInteractionTraceRecord;
}

export interface OpensteerInteractionGetInput {
  readonly traceId: string;
}

export interface OpensteerInteractionGetOutput {
  readonly trace: OpensteerInteractionTraceRecord;
}

export interface OpensteerInteractionDiffInput {
  readonly leftTraceId: string;
  readonly rightTraceId: string;
}

export interface OpensteerInteractionDiffOutput {
  readonly summary: {
    readonly eventCountDelta: number;
    readonly propertyMismatchCount: number;
    readonly stateMismatchCount: number;
    readonly downstreamRequestMismatchCount: number;
  };
  readonly eventSequenceMismatches: readonly string[];
  readonly eventPropertyMismatches: readonly string[];
  readonly stateMismatches: readonly string[];
  readonly downstreamRequestMismatches: readonly string[];
}

export interface OpensteerInteractionReplayInput {
  readonly traceId: string;
  readonly pageRef?: PageRef;
}

export interface OpensteerInteractionReplayOutput {
  readonly traceId: string;
  readonly replayedEventCount: number;
  readonly success: boolean;
  readonly error?: string;
}

export const opensteerInteractionEventRecordSchema: JsonSchema = objectSchema(
  {
    type: stringSchema({ minLength: 1 }),
    timestamp: integerSchema({ minimum: 0 }),
    targetPath: stringSchema({ minLength: 1 }),
    properties: objectSchema(
      {},
      {
        title: "OpensteerInteractionEventProperties",
        additionalProperties: true,
      },
    ),
  },
  {
    title: "OpensteerInteractionEventRecord",
    required: ["type", "timestamp", "properties"],
  },
);

export const opensteerInteractionTracePayloadSchema: JsonSchema = objectSchema(
  {
    mode: stringSchema({ minLength: 1 }),
    pageRef: pageRefSchema,
    url: stringSchema({ minLength: 1 }),
    startedAt: integerSchema({ minimum: 0 }),
    completedAt: integerSchema({ minimum: 0 }),
    beforeState: opensteerStateSnapshotSchema,
    afterState: opensteerStateSnapshotSchema,
    stateDelta: opensteerStateDeltaSchema,
    events: arraySchema(opensteerInteractionEventRecordSchema),
    networkRecordIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    caseId: stringSchema({ minLength: 1 }),
    notes: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerInteractionTracePayload",
    required: ["mode", "startedAt", "completedAt", "events", "networkRecordIds"],
  },
);

export const opensteerInteractionTraceRecordSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
    createdAt: integerSchema({ minimum: 0 }),
    updatedAt: integerSchema({ minimum: 0 }),
    contentHash: stringSchema({ minLength: 1 }),
    tags: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    provenance: opensteerRegistryProvenanceSchema,
    payload: opensteerInteractionTracePayloadSchema,
  },
  {
    title: "OpensteerInteractionTraceRecord",
    required: ["id", "key", "version", "createdAt", "updatedAt", "contentHash", "tags", "payload"],
  },
);

const targetByElementSchema: JsonSchema = objectSchema(
  {
    kind: enumSchema(["element"] as const),
    element: integerSchema({ minimum: 1 }),
  },
  {
    title: "OpensteerInteractionTargetByElement",
    required: ["kind", "element"],
  },
);

const targetByPersistSchema: JsonSchema = objectSchema(
  {
    kind: enumSchema(["persist"] as const),
    name: stringSchema(),
  },
  {
    title: "OpensteerInteractionTargetByPersist",
    required: ["kind", "name"],
  },
);

const targetBySelectorSchema: JsonSchema = objectSchema(
  {
    kind: enumSchema(["selector"] as const),
    selector: stringSchema(),
  },
  {
    title: "OpensteerInteractionTargetBySelector",
    required: ["kind", "selector"],
  },
);

const opensteerInteractionTargetInputSchema: JsonSchema = oneOfSchema(
  [targetByElementSchema, targetByPersistSchema, targetBySelectorSchema],
  {
    title: "OpensteerInteractionTargetInput",
  },
);

const opensteerInteractionCaptureStepSchema: JsonSchema = oneOfSchema(
  [
    objectSchema(
      {
        kind: enumSchema(["goto"] as const),
        url: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerInteractionCaptureGotoStep",
        required: ["kind", "url"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["click"] as const),
        target: opensteerInteractionTargetInputSchema,
      },
      {
        title: "OpensteerInteractionCaptureClickStep",
        required: ["kind", "target"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["hover"] as const),
        target: opensteerInteractionTargetInputSchema,
      },
      {
        title: "OpensteerInteractionCaptureHoverStep",
        required: ["kind", "target"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["input"] as const),
        target: opensteerInteractionTargetInputSchema,
        text: stringSchema(),
        pressEnter: { type: "boolean" },
      },
      {
        title: "OpensteerInteractionCaptureInputStep",
        required: ["kind", "target", "text"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["scroll"] as const),
        target: opensteerInteractionTargetInputSchema,
        direction: enumSchema(["up", "down", "left", "right"] as const),
        amount: integerSchema({ minimum: 1 }),
      },
      {
        title: "OpensteerInteractionCaptureScrollStep",
        required: ["kind", "target", "direction", "amount"],
      },
    ),
    objectSchema(
      {
        kind: enumSchema(["wait"] as const),
        durationMs: integerSchema({ minimum: 1 }),
      },
      {
        title: "OpensteerInteractionCaptureWaitStep",
        required: ["kind", "durationMs"],
      },
    ),
  ],
  {
    title: "OpensteerInteractionCaptureStep",
  },
);

export const opensteerInteractionCaptureInputSchema: JsonSchema = objectSchema(
  {
    key: stringSchema({ minLength: 1 }),
    pageRef: pageRefSchema,
    durationMs: integerSchema({ minimum: 1 }),
    script: stringSchema({ minLength: 1 }),
    args: arraySchema(defineSchema({ title: "OpensteerInteractionCaptureArg" })),
    steps: arraySchema(opensteerInteractionCaptureStepSchema, { minItems: 1 }),
    includeStorage: { type: "boolean" },
    includeSessionStorage: { type: "boolean" },
    includeIndexedDb: { type: "boolean" },
    globalNames: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    caseId: stringSchema({ minLength: 1 }),
    notes: stringSchema({ minLength: 1 }),
    tags: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
  },
  {
    title: "OpensteerInteractionCaptureInput",
  },
);

export const opensteerInteractionCaptureOutputSchema: JsonSchema = objectSchema(
  {
    trace: opensteerInteractionTraceRecordSchema,
  },
  {
    title: "OpensteerInteractionCaptureOutput",
    required: ["trace"],
  },
);

export const opensteerInteractionGetInputSchema: JsonSchema = objectSchema(
  {
    traceId: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerInteractionGetInput",
    required: ["traceId"],
  },
);

export const opensteerInteractionGetOutputSchema: JsonSchema = objectSchema(
  {
    trace: opensteerInteractionTraceRecordSchema,
  },
  {
    title: "OpensteerInteractionGetOutput",
    required: ["trace"],
  },
);

export const opensteerInteractionDiffInputSchema: JsonSchema = objectSchema(
  {
    leftTraceId: stringSchema({ minLength: 1 }),
    rightTraceId: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerInteractionDiffInput",
    required: ["leftTraceId", "rightTraceId"],
  },
);

export const opensteerInteractionDiffOutputSchema: JsonSchema = objectSchema(
  {
    summary: objectSchema(
      {
        eventCountDelta: integerSchema({ minimum: 0 }),
        propertyMismatchCount: integerSchema({ minimum: 0 }),
        stateMismatchCount: integerSchema({ minimum: 0 }),
        downstreamRequestMismatchCount: integerSchema({ minimum: 0 }),
      },
      {
        title: "OpensteerInteractionDiffSummary",
        required: [
          "eventCountDelta",
          "propertyMismatchCount",
          "stateMismatchCount",
          "downstreamRequestMismatchCount",
        ],
      },
    ),
    eventSequenceMismatches: arraySchema(stringSchema({ minLength: 1 })),
    eventPropertyMismatches: arraySchema(stringSchema({ minLength: 1 })),
    stateMismatches: arraySchema(stringSchema({ minLength: 1 })),
    downstreamRequestMismatches: arraySchema(stringSchema({ minLength: 1 })),
  },
  {
    title: "OpensteerInteractionDiffOutput",
    required: [
      "summary",
      "eventSequenceMismatches",
      "eventPropertyMismatches",
      "stateMismatches",
      "downstreamRequestMismatches",
    ],
  },
);

export const opensteerInteractionReplayInputSchema: JsonSchema = objectSchema(
  {
    traceId: stringSchema({ minLength: 1 }),
    pageRef: pageRefSchema,
  },
  {
    title: "OpensteerInteractionReplayInput",
    required: ["traceId"],
  },
);

export const opensteerInteractionReplayOutputSchema: JsonSchema = objectSchema(
  {
    traceId: stringSchema({ minLength: 1 }),
    replayedEventCount: integerSchema({ minimum: 0 }),
    success: { type: "boolean" },
    error: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerInteractionReplayOutput",
    required: ["traceId", "replayedEventCount", "success"],
  },
);
