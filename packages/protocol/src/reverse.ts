import type { JsonSchema, JsonValue } from "./json.js";
import {
  arraySchema,
  defineSchema,
  enumSchema,
  integerSchema,
  numberSchema,
  objectSchema,
  recordSchema,
  stringSchema,
  oneOfSchema,
} from "./json.js";
import { pageRefSchema, type PageRef } from "./identity.js";
import { networkRecordKindSchema } from "./network.js";
import {
  opensteerRegistryProvenanceSchema,
  opensteerRequestPlanRecordSchema,
  transportKindSchema,
  type OpensteerRegistryProvenance,
  type OpensteerRequestPlanRecord,
  type TransportKind,
} from "./requests.js";
import { storageSnapshotSchema, type StorageSnapshot } from "./storage.js";
import type { OpensteerSemanticOperationName } from "./semantic.js";

export type OpensteerStateSourceKind =
  | "managed"
  | "attach-live"
  | "snapshot-session"
  | "snapshot-authenticated";

export type OpensteerReverseCaseStatus = "capturing" | "analyzing" | "ready" | "attention";

export type OpensteerReverseChannelKind = "http" | "event-stream" | "websocket";

export type OpensteerReverseManualCalibrationMode = "allow" | "avoid" | "require";

export type OpensteerReverseCandidateBoundary = "first-party" | "same-site" | "third-party";

export type OpensteerReverseCandidateRole =
  | "primary-data"
  | "facet-data"
  | "telemetry"
  | "subscription"
  | "navigation"
  | "unknown";

export type OpensteerReverseCandidateDependencyClass =
  | "portable"
  | "browser-state"
  | "script-signed"
  | "behavior-gated"
  | "anti-bot"
  | "blocked";

export type OpensteerRequestInputLocation = "path" | "query" | "header" | "cookie" | "body-field";

export type OpensteerRequestInputRequiredness = "required" | "optional" | "unknown";

export type OpensteerRequestInputClassification = "managed" | "static" | "contextual" | "volatile";

export type OpensteerRequestInputSource =
  | "literal"
  | "cookie"
  | "storage"
  | "prior-response"
  | "page"
  | "script"
  | "guard-output"
  | "runtime-managed"
  | "unknown";

export type OpensteerRequestInputMaterializationPolicy = "copy" | "omit" | "recompute" | "resolve";

export type OpensteerRequestInputExportPolicy = "portable" | "browser-bound" | "blocked";

export type OpensteerReplayStrategyExecution = "transport" | "page-observation";

export type OpensteerReversePackageKind = "portable-http" | "browser-workflow";

export type OpensteerReversePackageReadiness = "runnable" | "draft" | "unsupported";

export type OpensteerBodyCodecKind =
  | "json"
  | "form-urlencoded"
  | "multipart"
  | "graphql"
  | "persisted-graphql"
  | "text"
  | "opaque-binary"
  | "sse"
  | "websocket-json"
  | "websocket-text"
  | "unknown";

export type OpensteerExecutableResolverKind =
  | "literal"
  | "cookie"
  | "storage"
  | "prior-response"
  | "page-eval"
  | "script-sandbox"
  | "guard-output"
  | "manual"
  | "runtime-managed";

export type OpensteerValidationRuleKind =
  | "status"
  | "json-structure"
  | "text-includes"
  | "stream-first-chunk"
  | "websocket-open"
  | "message-count-at-least";

export type OpensteerReverseWorkflowStepKind = "operation" | "await-record" | "assert";

export type OpensteerReverseRequirementKind =
  | "resolver"
  | "guard"
  | "workflow-step"
  | "state"
  | "channel"
  | "unsupported";

export type OpensteerReverseRequirementStatus = "required" | "recommended";

export type OpensteerReverseSuggestedEditKind =
  | "set-resolver"
  | "attach-trace"
  | "replace-workflow"
  | "patch-step-input"
  | "switch-state-source"
  | "inspect-evidence"
  | "mark-unsupported";

export interface OpensteerReverseTargetHints {
  readonly hosts?: readonly string[];
  readonly paths?: readonly string[];
  readonly operationNames?: readonly string[];
  readonly channels?: readonly OpensteerReverseChannelKind[];
}

export interface OpensteerBodyCodecDescriptor {
  readonly kind: OpensteerBodyCodecKind;
  readonly contentType?: string;
  readonly operationName?: string;
  readonly fieldPaths: readonly string[];
}

export interface OpensteerObservationCluster {
  readonly id: string;
  readonly observationId: string;
  readonly label: string;
  readonly channel: OpensteerReverseChannelKind;
  readonly method?: string;
  readonly url: string;
  readonly primaryRecordId: string;
  readonly recordIds: readonly string[];
  readonly suppressedRecordIds: readonly string[];
  readonly suppressionReasons: readonly string[];
  readonly matchedTargetHints: readonly string[];
}

export interface OpensteerStateSnapshot {
  readonly id: string;
  readonly capturedAt: number;
  readonly pageRef?: PageRef;
  readonly url?: string;
  readonly cookies?: readonly {
    readonly name: string;
    readonly value: string;
    readonly domain: string;
    readonly path: string;
    readonly secure: boolean;
    readonly httpOnly: boolean;
    readonly sameSite?: "strict" | "lax" | "none";
    readonly priority?: "low" | "medium" | "high";
    readonly partitionKey?: string;
    readonly session: boolean;
    readonly expiresAt?: number | null;
  }[];
  readonly storage?: StorageSnapshot;
  readonly hiddenFields?: readonly {
    readonly path: string;
    readonly name: string;
    readonly value: string;
  }[];
  readonly globals?: Readonly<Record<string, unknown>>;
}

export interface OpensteerStateDelta {
  readonly beforeStateId?: string;
  readonly afterStateId?: string;
  readonly cookiesChanged: readonly string[];
  readonly storageChanged: readonly string[];
  readonly hiddenFieldsChanged: readonly string[];
  readonly globalsChanged: readonly string[];
}

export interface OpensteerRequestInputDescriptor {
  readonly name: string;
  readonly location: OpensteerRequestInputLocation;
  readonly path?: string;
  readonly wireName?: string;
  readonly requiredness: OpensteerRequestInputRequiredness;
  readonly classification: OpensteerRequestInputClassification;
  readonly source: OpensteerRequestInputSource;
  readonly materializationPolicy: OpensteerRequestInputMaterializationPolicy;
  readonly exportPolicy: OpensteerRequestInputExportPolicy;
  readonly originalValue?: string;
  readonly provenance?: {
    readonly recordId?: string;
    readonly observationId?: string;
    readonly sourcePointer?: string;
    readonly notes?: string;
  };
  readonly unlockedByGuardIds?: readonly string[];
}

export interface OpensteerExecutableResolver {
  readonly id: string;
  readonly kind: OpensteerExecutableResolverKind;
  readonly label: string;
  readonly status: "ready" | "missing";
  readonly requiresBrowser: boolean;
  readonly requiresLiveState: boolean;
  readonly description?: string;
  readonly inputNames?: readonly string[];
  readonly guardId?: string;
  readonly traceId?: string;
  readonly scriptArtifactId?: string;
  readonly artifactId?: string;
  readonly sourceRecordId?: string;
  readonly stateSnapshotId?: string;
  readonly binding?: string;
  readonly pointer?: string;
  readonly expression?: string;
  readonly value?: JsonValue;
}

export interface OpensteerValidationRule {
  readonly id: string;
  readonly kind: OpensteerValidationRuleKind;
  readonly label: string;
  readonly required: boolean;
  readonly expectedStatus?: number;
  readonly structureHash?: string;
  readonly textIncludes?: string;
  readonly minimumCount?: number;
}

export interface OpensteerReverseOperationWorkflowStep {
  readonly id: string;
  readonly kind: "operation";
  readonly label: string;
  readonly operation: OpensteerSemanticOperationName | string;
  readonly input: JsonValue;
  readonly bindAs?: string;
}

export interface OpensteerReverseAwaitRecordWorkflowStep {
  readonly id: string;
  readonly kind: "await-record";
  readonly label: string;
  readonly channel: OpensteerChannelDescriptor;
  readonly recordId?: string;
  readonly validationRuleIds?: readonly string[];
  readonly timeoutMs?: number;
  readonly bindAs?: string;
}

export interface OpensteerReverseAssertWorkflowStep {
  readonly id: string;
  readonly kind: "assert";
  readonly label: string;
  readonly validationRuleIds: readonly string[];
  readonly binding?: string;
}

export type OpensteerReverseWorkflowStep =
  | OpensteerReverseOperationWorkflowStep
  | OpensteerReverseAwaitRecordWorkflowStep
  | OpensteerReverseAssertWorkflowStep;

export interface OpensteerReversePackageRequirements {
  readonly requiresBrowser: boolean;
  readonly requiresLiveState: boolean;
  readonly manualCalibration: "not-needed" | "recommended" | "required";
  readonly stateSources: readonly OpensteerStateSourceKind[];
}

export interface OpensteerChannelDescriptor {
  readonly kind: OpensteerReverseChannelKind;
  readonly recordKind: "http" | "event-stream" | "websocket";
  readonly method?: string;
  readonly url: string;
  readonly subprotocol?: string;
}

export interface OpensteerReplayStrategy {
  readonly id: string;
  readonly label: string;
  readonly channel: OpensteerReverseChannelKind;
  readonly execution: OpensteerReplayStrategyExecution;
  readonly stateSource: OpensteerStateSourceKind;
  readonly observationId?: string;
  readonly transport?: TransportKind;
  readonly supported: boolean;
  readonly guardIds: readonly string[];
  readonly resolverIds: readonly string[];
  readonly requiresBrowser: boolean;
  readonly requiresLiveState: boolean;
  readonly observedSuccess?: boolean;
  readonly failureReason?: string;
}

export interface OpensteerReverseGuardRecord {
  readonly id: string;
  readonly kind: "interaction" | "state" | "script" | "manual";
  readonly label: string;
  readonly status: "required" | "satisfied" | "unresolved";
  readonly interactionTraceId?: string;
  readonly notes?: string;
}

export interface OpensteerReverseObservationRecord {
  readonly id: string;
  readonly capturedAt: number;
  readonly pageRef?: PageRef;
  readonly url?: string;
  readonly stateSource: OpensteerStateSourceKind;
  readonly networkRecordIds: readonly string[];
  readonly scriptArtifactIds: readonly string[];
  readonly interactionTraceIds: readonly string[];
  readonly stateSnapshotIds: readonly string[];
  readonly notes?: string;
}

export interface OpensteerReverseCandidateRecord {
  readonly id: string;
  readonly observationId: string;
  readonly clusterId: string;
  readonly recordId: string;
  readonly channel: OpensteerChannelDescriptor;
  readonly bodyCodec: OpensteerBodyCodecDescriptor;
  readonly boundary: OpensteerReverseCandidateBoundary;
  readonly role: OpensteerReverseCandidateRole;
  readonly dependencyClass: OpensteerReverseCandidateDependencyClass;
  readonly score: number;
  readonly summary: string;
  readonly matchedTargetHints: readonly string[];
  readonly inputs: readonly OpensteerRequestInputDescriptor[];
  readonly resolvers: readonly OpensteerExecutableResolver[];
  readonly guardIds: readonly string[];
  readonly scriptArtifactIds: readonly string[];
  readonly replayStrategies: readonly OpensteerReplayStrategy[];
}

export interface OpensteerReverseReplayValidation {
  readonly statusMatches?: boolean;
  readonly structureMatches?: boolean;
  readonly opened?: boolean;
  readonly firstChunkObserved?: boolean;
  readonly firstChunkMatches?: boolean;
  readonly messageObserved?: boolean;
  readonly messageCount?: number;
}

export interface OpensteerReverseReplayRunRecord {
  readonly id: string;
  readonly createdAt: number;
  readonly candidateId?: string;
  readonly strategyId?: string;
  readonly packageId: string;
  readonly success: boolean;
  readonly channel?: OpensteerReverseChannelKind;
  readonly kind: OpensteerReversePackageKind;
  readonly readiness: OpensteerReversePackageReadiness;
  readonly transport?: TransportKind;
  readonly stateSource?: OpensteerStateSourceKind;
  readonly recordId?: string;
  readonly status?: number;
  readonly validation: OpensteerReverseReplayValidation;
  readonly error?: string;
}

export interface OpensteerReverseExperimentRecord {
  readonly id: string;
  readonly createdAt: number;
  readonly candidateId?: string;
  readonly strategyId?: string;
  readonly kind: "replay-attempt" | "field-variation";
  readonly hypothesis: string;
  readonly success: boolean;
  readonly status?: number;
  readonly notes?: string;
  readonly validation?: OpensteerReverseReplayValidation;
}

export interface OpensteerReverseRequirement {
  readonly id: string;
  readonly kind: OpensteerReverseRequirementKind;
  readonly status: OpensteerReverseRequirementStatus;
  readonly label: string;
  readonly description?: string;
  readonly blocking: boolean;
  readonly resolverId?: string;
  readonly guardId?: string;
  readonly stepId?: string;
  readonly inputNames?: readonly string[];
  readonly traceId?: string;
  readonly artifactId?: string;
  readonly recordId?: string;
}

export interface OpensteerReverseSuggestedEdit {
  readonly id: string;
  readonly kind: OpensteerReverseSuggestedEditKind;
  readonly label: string;
  readonly description?: string;
  readonly resolverId?: string;
  readonly guardId?: string;
  readonly stepId?: string;
  readonly traceId?: string;
  readonly artifactId?: string;
  readonly recordId?: string;
  readonly payload?: JsonValue;
}

export interface OpensteerReverseExportRecord {
  readonly id: string;
  readonly createdAt: number;
  readonly candidateId?: string;
  readonly strategyId?: string;
  readonly packageId: string;
  readonly kind: OpensteerReversePackageKind;
  readonly readiness: OpensteerReversePackageReadiness;
  readonly requestPlanId?: string;
}

export interface OpensteerReverseCasePayload {
  readonly objective: string;
  readonly notes?: string;
  readonly status: OpensteerReverseCaseStatus;
  readonly stateSource: OpensteerStateSourceKind;
  readonly observations: readonly OpensteerReverseObservationRecord[];
  readonly observationClusters: readonly OpensteerObservationCluster[];
  readonly candidates: readonly OpensteerReverseCandidateRecord[];
  readonly guards: readonly OpensteerReverseGuardRecord[];
  readonly stateSnapshots: readonly OpensteerStateSnapshot[];
  readonly stateDeltas: readonly OpensteerStateDelta[];
  readonly experiments: readonly OpensteerReverseExperimentRecord[];
  readonly replayRuns: readonly OpensteerReverseReplayRunRecord[];
  readonly exports: readonly OpensteerReverseExportRecord[];
}

export interface OpensteerReverseCaseRecord {
  readonly id: string;
  readonly key: string;
  readonly version: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly contentHash: string;
  readonly tags: readonly string[];
  readonly provenance?: OpensteerRegistryProvenance;
  readonly payload: OpensteerReverseCasePayload;
}

export interface OpensteerReversePackagePayload {
  readonly kind: OpensteerReversePackageKind;
  readonly readiness: OpensteerReversePackageReadiness;
  readonly caseId: string;
  readonly objective: string;
  readonly candidateId?: string;
  readonly candidate?: OpensteerReverseCandidateRecord;
  readonly strategyId?: string;
  readonly strategy?: OpensteerReplayStrategy;
  readonly channel?: OpensteerChannelDescriptor;
  readonly stateSource?: OpensteerStateSourceKind;
  readonly observationId?: string;
  readonly transport?: TransportKind;
  readonly guardIds: readonly string[];
  readonly workflow: readonly OpensteerReverseWorkflowStep[];
  readonly resolvers: readonly OpensteerExecutableResolver[];
  readonly validators: readonly OpensteerValidationRule[];
  readonly stateSnapshots: readonly OpensteerStateSnapshot[];
  readonly requirements: OpensteerReversePackageRequirements;
  readonly requestPlanId?: string;
  readonly unresolvedRequirements: readonly OpensteerReverseRequirement[];
  readonly suggestedEdits: readonly OpensteerReverseSuggestedEdit[];
  readonly attachedTraceIds: readonly string[];
  readonly attachedArtifactIds: readonly string[];
  readonly attachedRecordIds: readonly string[];
  readonly notes?: string;
  readonly parentPackageId?: string;
}

export interface OpensteerReversePackageRecord {
  readonly id: string;
  readonly key: string;
  readonly version: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly contentHash: string;
  readonly tags: readonly string[];
  readonly provenance?: OpensteerRegistryProvenance;
  readonly payload: OpensteerReversePackagePayload;
}

export interface OpensteerReverseCandidateReportItem {
  readonly candidateId: string;
  readonly clusterId: string;
  readonly score: number;
  readonly role: OpensteerReverseCandidateRole;
  readonly dependencyClass: OpensteerReverseCandidateDependencyClass;
  readonly bodyCodec: OpensteerBodyCodecDescriptor;
  readonly summary: string;
  readonly reasons: readonly string[];
}

export interface OpensteerReverseReportPayload {
  readonly caseId: string;
  readonly objective: string;
  readonly packageId: string;
  readonly packageKind: OpensteerReversePackageKind;
  readonly packageReadiness: OpensteerReversePackageReadiness;
  readonly chosenCandidateId?: string;
  readonly chosenStrategyId?: string;
  readonly observations: readonly OpensteerReverseObservationRecord[];
  readonly observationClusters: readonly OpensteerObservationCluster[];
  readonly guards: readonly OpensteerReverseGuardRecord[];
  readonly stateDeltas: readonly OpensteerStateDelta[];
  readonly candidateRankings: readonly OpensteerReverseCandidateReportItem[];
  readonly experiments: readonly OpensteerReverseExperimentRecord[];
  readonly replayRuns: readonly OpensteerReverseReplayRunRecord[];
  readonly unresolvedRequirements: readonly OpensteerReverseRequirement[];
  readonly suggestedEdits: readonly OpensteerReverseSuggestedEdit[];
  readonly linkedNetworkRecordIds: readonly string[];
  readonly linkedInteractionTraceIds: readonly string[];
  readonly linkedArtifactIds: readonly string[];
  readonly linkedStateSnapshotIds: readonly string[];
  readonly package: OpensteerReversePackageRecord;
}

export interface OpensteerReverseReportRecord {
  readonly id: string;
  readonly key: string;
  readonly version: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly contentHash: string;
  readonly tags: readonly string[];
  readonly provenance?: OpensteerRegistryProvenance;
  readonly payload: OpensteerReverseReportPayload;
}

export interface OpensteerReverseSolveInput {
  readonly caseId?: string;
  readonly key?: string;
  readonly objective?: string;
  readonly notes?: string;
  readonly tags?: readonly string[];
  readonly pageRef?: PageRef;
  readonly stateSource?: OpensteerStateSourceKind;
  readonly network?: {
    readonly url?: string;
    readonly hostname?: string;
    readonly path?: string;
    readonly method?: string;
    readonly resourceType?: string;
    readonly includeBodies?: boolean;
  };
  readonly includeScripts?: boolean;
  readonly includeStorage?: boolean;
  readonly includeSessionStorage?: boolean;
  readonly includeIndexedDb?: boolean;
  readonly interactionTraceIds?: readonly string[];
  readonly targetHints?: OpensteerReverseTargetHints;
  readonly captureWindowMs?: number;
  readonly manualCalibration?: OpensteerReverseManualCalibrationMode;
  readonly candidateLimit?: number;
  readonly maxReplayAttempts?: number;
}

export interface OpensteerReverseSolveOutput {
  readonly caseId: string;
  readonly package: OpensteerReversePackageRecord;
  readonly report: OpensteerReverseReportRecord;
}

export interface OpensteerReverseReplayInput {
  readonly packageId: string;
  readonly pageRef?: PageRef;
}

export interface OpensteerReverseReplayOutput {
  readonly packageId: string;
  readonly caseId?: string;
  readonly candidateId?: string;
  readonly strategyId?: string;
  readonly success: boolean;
  readonly kind: OpensteerReversePackageKind;
  readonly readiness: OpensteerReversePackageReadiness;
  readonly channel?: OpensteerReverseChannelKind;
  readonly transport?: TransportKind;
  readonly stateSource?: OpensteerStateSourceKind;
  readonly recordId?: string;
  readonly status?: number;
  readonly validation: OpensteerReverseReplayValidation;
  readonly unresolvedRequirements: readonly OpensteerReverseRequirement[];
  readonly suggestedEdits: readonly OpensteerReverseSuggestedEdit[];
  readonly error?: string;
}

export interface OpensteerReverseExportInput {
  readonly packageId: string;
  readonly key?: string;
  readonly version?: string;
}

export interface OpensteerReverseExportOutput {
  readonly package: OpensteerReversePackageRecord;
  readonly requestPlan?: OpensteerRequestPlanRecord;
}

export interface OpensteerReverseReportInput {
  readonly packageId?: string;
  readonly reportId?: string;
}

export interface OpensteerReverseReportOutput {
  readonly report: OpensteerReverseReportRecord;
}

export interface OpensteerReversePackageGetInput {
  readonly packageId: string;
}

export interface OpensteerReversePackageGetOutput {
  readonly package: OpensteerReversePackageRecord;
}

export interface OpensteerReversePackageListInput {
  readonly caseId?: string;
  readonly key?: string;
  readonly kind?: OpensteerReversePackageKind;
  readonly readiness?: OpensteerReversePackageReadiness;
}

export interface OpensteerReversePackageListOutput {
  readonly packages: readonly OpensteerReversePackageRecord[];
}

export interface OpensteerReversePackagePatchInput {
  readonly packageId: string;
  readonly key?: string;
  readonly version?: string;
  readonly notes?: string;
  readonly candidateId?: string;
  readonly strategyId?: string;
  readonly workflow?: readonly OpensteerReverseWorkflowStep[];
  readonly resolvers?: readonly OpensteerExecutableResolver[];
  readonly validators?: readonly OpensteerValidationRule[];
  readonly attachedTraceIds?: readonly string[];
  readonly attachedArtifactIds?: readonly string[];
  readonly attachedRecordIds?: readonly string[];
  readonly stateSnapshotIds?: readonly string[];
}

export interface OpensteerReversePackagePatchOutput {
  readonly package: OpensteerReversePackageRecord;
  readonly report: OpensteerReverseReportRecord;
}

export const opensteerStateSourceKindSchema: JsonSchema = enumSchema(
  ["managed", "attach-live", "snapshot-session", "snapshot-authenticated"] as const,
  { title: "OpensteerStateSourceKind" },
);

export const opensteerReverseCaseStatusSchema: JsonSchema = enumSchema(
  ["capturing", "analyzing", "ready", "attention"] as const,
  { title: "OpensteerReverseCaseStatus" },
);

export const opensteerReverseChannelKindSchema: JsonSchema = enumSchema(
  ["http", "event-stream", "websocket"] as const,
  { title: "OpensteerReverseChannelKind" },
);

export const opensteerReverseManualCalibrationModeSchema: JsonSchema = enumSchema(
  ["allow", "avoid", "require"] as const,
  { title: "OpensteerReverseManualCalibrationMode" },
);

export const opensteerReverseCandidateBoundarySchema: JsonSchema = enumSchema(
  ["first-party", "same-site", "third-party"] as const,
  { title: "OpensteerReverseCandidateBoundary" },
);

export const opensteerReverseCandidateRoleSchema: JsonSchema = enumSchema(
  ["primary-data", "facet-data", "telemetry", "subscription", "navigation", "unknown"] as const,
  { title: "OpensteerReverseCandidateRole" },
);

export const opensteerReverseCandidateDependencyClassSchema: JsonSchema = enumSchema(
  ["portable", "browser-state", "script-signed", "behavior-gated", "anti-bot", "blocked"] as const,
  { title: "OpensteerReverseCandidateDependencyClass" },
);

export const opensteerRequestInputLocationSchema: JsonSchema = enumSchema(
  ["path", "query", "header", "cookie", "body-field"] as const,
  { title: "OpensteerRequestInputLocation" },
);

export const opensteerRequestInputRequirednessSchema: JsonSchema = enumSchema(
  ["required", "optional", "unknown"] as const,
  { title: "OpensteerRequestInputRequiredness" },
);

export const opensteerRequestInputClassificationSchema: JsonSchema = enumSchema(
  ["managed", "static", "contextual", "volatile"] as const,
  { title: "OpensteerRequestInputClassification" },
);

export const opensteerRequestInputSourceSchema: JsonSchema = enumSchema(
  [
    "literal",
    "cookie",
    "storage",
    "prior-response",
    "page",
    "script",
    "guard-output",
    "runtime-managed",
    "unknown",
  ] as const,
  { title: "OpensteerRequestInputSource" },
);

export const opensteerRequestInputMaterializationPolicySchema: JsonSchema = enumSchema(
  ["copy", "omit", "recompute", "resolve"] as const,
  { title: "OpensteerRequestInputMaterializationPolicy" },
);

export const opensteerRequestInputExportPolicySchema: JsonSchema = enumSchema(
  ["portable", "browser-bound", "blocked"] as const,
  { title: "OpensteerRequestInputExportPolicy" },
);

export const opensteerReplayStrategyExecutionSchema: JsonSchema = enumSchema(
  ["transport", "page-observation"] as const,
  { title: "OpensteerReplayStrategyExecution" },
);

export const opensteerReversePackageKindSchema: JsonSchema = enumSchema(
  ["portable-http", "browser-workflow"] as const,
  { title: "OpensteerReversePackageKind" },
);

export const opensteerReversePackageReadinessSchema: JsonSchema = enumSchema(
  ["runnable", "draft", "unsupported"] as const,
  { title: "OpensteerReversePackageReadiness" },
);

export const opensteerBodyCodecKindSchema: JsonSchema = enumSchema(
  [
    "json",
    "form-urlencoded",
    "multipart",
    "graphql",
    "persisted-graphql",
    "text",
    "opaque-binary",
    "sse",
    "websocket-json",
    "websocket-text",
    "unknown",
  ] as const,
  { title: "OpensteerBodyCodecKind" },
);

export const opensteerExecutableResolverKindSchema: JsonSchema = enumSchema(
  [
    "literal",
    "cookie",
    "storage",
    "prior-response",
    "page-eval",
    "script-sandbox",
    "guard-output",
    "manual",
    "runtime-managed",
  ] as const,
  { title: "OpensteerExecutableResolverKind" },
);

export const opensteerValidationRuleKindSchema: JsonSchema = enumSchema(
  [
    "status",
    "json-structure",
    "text-includes",
    "stream-first-chunk",
    "websocket-open",
    "message-count-at-least",
  ] as const,
  { title: "OpensteerValidationRuleKind" },
);

export const opensteerReverseWorkflowStepKindSchema: JsonSchema = enumSchema(
  ["operation", "await-record", "assert"] as const,
  { title: "OpensteerReverseWorkflowStepKind" },
);

export const opensteerReverseRequirementKindSchema: JsonSchema = enumSchema(
  ["resolver", "guard", "workflow-step", "state", "channel", "unsupported"] as const,
  { title: "OpensteerReverseRequirementKind" },
);

export const opensteerReverseRequirementStatusSchema: JsonSchema = enumSchema(
  ["required", "recommended"] as const,
  { title: "OpensteerReverseRequirementStatus" },
);

export const opensteerReverseSuggestedEditKindSchema: JsonSchema = enumSchema(
  [
    "set-resolver",
    "attach-trace",
    "replace-workflow",
    "patch-step-input",
    "switch-state-source",
    "inspect-evidence",
    "mark-unsupported",
  ] as const,
  { title: "OpensteerReverseSuggestedEditKind" },
);

const jsonValueSchema: JsonSchema = defineSchema({
  title: "JsonValue",
});

export const opensteerReverseTargetHintsSchema: JsonSchema = objectSchema(
  {
    hosts: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    paths: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    operationNames: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    channels: arraySchema(opensteerReverseChannelKindSchema, { uniqueItems: true }),
  },
  {
    title: "OpensteerReverseTargetHints",
  },
);

export const opensteerBodyCodecDescriptorSchema: JsonSchema = objectSchema(
  {
    kind: opensteerBodyCodecKindSchema,
    contentType: stringSchema({ minLength: 1 }),
    operationName: stringSchema({ minLength: 1 }),
    fieldPaths: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
  },
  {
    title: "OpensteerBodyCodecDescriptor",
    required: ["kind", "fieldPaths"],
  },
);

export const opensteerObservationClusterSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    observationId: stringSchema({ minLength: 1 }),
    label: stringSchema({ minLength: 1 }),
    channel: opensteerReverseChannelKindSchema,
    method: stringSchema({ minLength: 1 }),
    url: stringSchema({ minLength: 1 }),
    primaryRecordId: stringSchema({ minLength: 1 }),
    recordIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    suppressedRecordIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    suppressionReasons: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    matchedTargetHints: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
  },
  {
    title: "OpensteerObservationCluster",
    required: [
      "id",
      "observationId",
      "label",
      "channel",
      "url",
      "primaryRecordId",
      "recordIds",
      "suppressedRecordIds",
      "suppressionReasons",
      "matchedTargetHints",
    ],
  },
);

const opensteerStateSnapshotCookieSchema: JsonSchema = objectSchema(
  {
    name: stringSchema({ minLength: 1 }),
    value: stringSchema(),
    domain: stringSchema({ minLength: 1 }),
    path: stringSchema({ minLength: 1 }),
    secure: { type: "boolean" },
    httpOnly: { type: "boolean" },
    sameSite: enumSchema(["strict", "lax", "none"] as const),
    priority: enumSchema(["low", "medium", "high"] as const),
    partitionKey: stringSchema({ minLength: 1 }),
    session: { type: "boolean" },
    expiresAt: oneOfSchema([integerSchema({ minimum: 0 }), { type: "null" }]),
  },
  {
    title: "OpensteerStateSnapshotCookie",
    required: ["name", "value", "domain", "path", "secure", "httpOnly", "session"],
  },
);

export const opensteerStateSnapshotSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    capturedAt: integerSchema({ minimum: 0 }),
    pageRef: pageRefSchema,
    url: stringSchema({ minLength: 1 }),
    cookies: arraySchema(opensteerStateSnapshotCookieSchema),
    storage: storageSnapshotSchema,
    hiddenFields: arraySchema(
      objectSchema(
        {
          path: stringSchema({ minLength: 1 }),
          name: stringSchema({ minLength: 1 }),
          value: stringSchema(),
        },
        {
          title: "OpensteerStateSnapshotHiddenField",
          required: ["path", "name", "value"],
        },
      ),
    ),
    globals: recordSchema({}, { title: "OpensteerStateSnapshotGlobals" }),
  },
  {
    title: "OpensteerStateSnapshot",
    required: ["id", "capturedAt"],
  },
);

export const opensteerStateDeltaSchema: JsonSchema = objectSchema(
  {
    beforeStateId: stringSchema({ minLength: 1 }),
    afterStateId: stringSchema({ minLength: 1 }),
    cookiesChanged: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    storageChanged: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    hiddenFieldsChanged: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    globalsChanged: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
  },
  {
    title: "OpensteerStateDelta",
    required: ["cookiesChanged", "storageChanged", "hiddenFieldsChanged", "globalsChanged"],
  },
);

export const opensteerRequestInputDescriptorSchema: JsonSchema = objectSchema(
  {
    name: stringSchema({ minLength: 1 }),
    location: opensteerRequestInputLocationSchema,
    path: stringSchema({ minLength: 1 }),
    wireName: stringSchema({ minLength: 1 }),
    requiredness: opensteerRequestInputRequirednessSchema,
    classification: opensteerRequestInputClassificationSchema,
    source: opensteerRequestInputSourceSchema,
    materializationPolicy: opensteerRequestInputMaterializationPolicySchema,
    exportPolicy: opensteerRequestInputExportPolicySchema,
    originalValue: stringSchema(),
    provenance: objectSchema(
      {
        recordId: stringSchema({ minLength: 1 }),
        observationId: stringSchema({ minLength: 1 }),
        sourcePointer: stringSchema({ minLength: 1 }),
        notes: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerRequestInputDescriptorProvenance",
      },
    ),
    unlockedByGuardIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
  },
  {
    title: "OpensteerRequestInputDescriptor",
    required: [
      "name",
      "location",
      "requiredness",
      "classification",
      "source",
      "materializationPolicy",
      "exportPolicy",
    ],
  },
);

export const opensteerExecutableResolverSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    kind: opensteerExecutableResolverKindSchema,
    label: stringSchema({ minLength: 1 }),
    status: enumSchema(["ready", "missing"] as const),
    requiresBrowser: { type: "boolean" },
    requiresLiveState: { type: "boolean" },
    description: stringSchema({ minLength: 1 }),
    inputNames: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    guardId: stringSchema({ minLength: 1 }),
    traceId: stringSchema({ minLength: 1 }),
    scriptArtifactId: stringSchema({ minLength: 1 }),
    artifactId: stringSchema({ minLength: 1 }),
    sourceRecordId: stringSchema({ minLength: 1 }),
    stateSnapshotId: stringSchema({ minLength: 1 }),
    binding: stringSchema({ minLength: 1 }),
    pointer: stringSchema({ minLength: 1 }),
    expression: stringSchema({ minLength: 1 }),
    value: jsonValueSchema,
  },
  {
    title: "OpensteerExecutableResolver",
    required: ["id", "kind", "label", "status", "requiresBrowser", "requiresLiveState"],
  },
);

export const opensteerValidationRuleSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    kind: opensteerValidationRuleKindSchema,
    label: stringSchema({ minLength: 1 }),
    required: { type: "boolean" },
    expectedStatus: integerSchema({ minimum: 0 }),
    structureHash: stringSchema({ minLength: 1 }),
    textIncludes: stringSchema({ minLength: 1 }),
    minimumCount: integerSchema({ minimum: 0 }),
  },
  {
    title: "OpensteerValidationRule",
    required: ["id", "kind", "label", "required"],
  },
);

const opensteerChannelDescriptorSchema: JsonSchema = objectSchema(
  {
    kind: opensteerReverseChannelKindSchema,
    recordKind: networkRecordKindSchema,
    method: stringSchema({ minLength: 1 }),
    url: stringSchema({ minLength: 1 }),
    subprotocol: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerChannelDescriptor",
    required: ["kind", "recordKind", "url"],
  },
);

const opensteerReverseOperationWorkflowStepSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    kind: enumSchema(["operation"] as const),
    label: stringSchema({ minLength: 1 }),
    operation: stringSchema({ minLength: 1 }),
    input: jsonValueSchema,
    bindAs: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReverseOperationWorkflowStep",
    required: ["id", "kind", "label", "operation", "input"],
  },
);

const opensteerReverseAwaitRecordWorkflowStepSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    kind: enumSchema(["await-record"] as const),
    label: stringSchema({ minLength: 1 }),
    channel: opensteerChannelDescriptorSchema,
    recordId: stringSchema({ minLength: 1 }),
    validationRuleIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    timeoutMs: integerSchema({ minimum: 0 }),
    bindAs: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReverseAwaitRecordWorkflowStep",
    required: ["id", "kind", "label", "channel"],
  },
);

const opensteerReverseAssertWorkflowStepSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    kind: enumSchema(["assert"] as const),
    label: stringSchema({ minLength: 1 }),
    validationRuleIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    binding: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReverseAssertWorkflowStep",
    required: ["id", "kind", "label", "validationRuleIds"],
  },
);

export const opensteerReverseWorkflowStepSchema: JsonSchema = oneOfSchema(
  [
    opensteerReverseOperationWorkflowStepSchema,
    opensteerReverseAwaitRecordWorkflowStepSchema,
    opensteerReverseAssertWorkflowStepSchema,
  ],
  {
    title: "OpensteerReverseWorkflowStep",
  },
);

export const opensteerReversePackageRequirementsSchema: JsonSchema = objectSchema(
  {
    requiresBrowser: { type: "boolean" },
    requiresLiveState: { type: "boolean" },
    manualCalibration: enumSchema(["not-needed", "recommended", "required"] as const),
    stateSources: arraySchema(opensteerStateSourceKindSchema, { uniqueItems: true }),
  },
  {
    title: "OpensteerReversePackageRequirements",
    required: ["requiresBrowser", "requiresLiveState", "manualCalibration", "stateSources"],
  },
);

export const opensteerReplayStrategySchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    label: stringSchema({ minLength: 1 }),
    channel: opensteerReverseChannelKindSchema,
    execution: opensteerReplayStrategyExecutionSchema,
    stateSource: opensteerStateSourceKindSchema,
    observationId: stringSchema({ minLength: 1 }),
    transport: transportKindSchema,
    supported: { type: "boolean" },
    guardIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    resolverIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    requiresBrowser: { type: "boolean" },
    requiresLiveState: { type: "boolean" },
    observedSuccess: { type: "boolean" },
    failureReason: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReplayStrategy",
    required: [
      "id",
      "label",
      "channel",
      "execution",
      "stateSource",
      "supported",
      "guardIds",
      "resolverIds",
      "requiresBrowser",
      "requiresLiveState",
    ],
  },
);

export const opensteerReverseGuardRecordSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    kind: enumSchema(["interaction", "state", "script", "manual"] as const),
    label: stringSchema({ minLength: 1 }),
    status: enumSchema(["required", "satisfied", "unresolved"] as const),
    interactionTraceId: stringSchema({ minLength: 1 }),
    notes: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReverseGuardRecord",
    required: ["id", "kind", "label", "status"],
  },
);

export const opensteerReverseObservationRecordSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    capturedAt: integerSchema({ minimum: 0 }),
    pageRef: pageRefSchema,
    url: stringSchema({ minLength: 1 }),
    stateSource: opensteerStateSourceKindSchema,
    networkRecordIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    scriptArtifactIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    interactionTraceIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    stateSnapshotIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    notes: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReverseObservationRecord",
    required: [
      "id",
      "capturedAt",
      "stateSource",
      "networkRecordIds",
      "scriptArtifactIds",
      "interactionTraceIds",
      "stateSnapshotIds",
    ],
  },
);

export const opensteerReverseCandidateRecordSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    observationId: stringSchema({ minLength: 1 }),
    clusterId: stringSchema({ minLength: 1 }),
    recordId: stringSchema({ minLength: 1 }),
    channel: opensteerChannelDescriptorSchema,
    bodyCodec: opensteerBodyCodecDescriptorSchema,
    boundary: opensteerReverseCandidateBoundarySchema,
    role: opensteerReverseCandidateRoleSchema,
    dependencyClass: opensteerReverseCandidateDependencyClassSchema,
    score: numberSchema(),
    summary: stringSchema({ minLength: 1 }),
    matchedTargetHints: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    inputs: arraySchema(opensteerRequestInputDescriptorSchema),
    resolvers: arraySchema(opensteerExecutableResolverSchema),
    guardIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    scriptArtifactIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    replayStrategies: arraySchema(opensteerReplayStrategySchema),
  },
  {
    title: "OpensteerReverseCandidateRecord",
    required: [
      "id",
      "observationId",
      "clusterId",
      "recordId",
      "channel",
      "bodyCodec",
      "boundary",
      "role",
      "dependencyClass",
      "score",
      "summary",
      "matchedTargetHints",
      "inputs",
      "resolvers",
      "guardIds",
      "scriptArtifactIds",
      "replayStrategies",
    ],
  },
);

export const opensteerReverseReplayValidationSchema: JsonSchema = objectSchema(
  {
    statusMatches: { type: "boolean" },
    structureMatches: { type: "boolean" },
    opened: { type: "boolean" },
    firstChunkObserved: { type: "boolean" },
    firstChunkMatches: { type: "boolean" },
    messageObserved: { type: "boolean" },
    messageCount: integerSchema({ minimum: 0 }),
  },
  {
    title: "OpensteerReverseReplayValidation",
  },
);

export const opensteerReverseReplayRunRecordSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    createdAt: integerSchema({ minimum: 0 }),
    candidateId: stringSchema({ minLength: 1 }),
    strategyId: stringSchema({ minLength: 1 }),
    packageId: stringSchema({ minLength: 1 }),
    success: { type: "boolean" },
    channel: opensteerReverseChannelKindSchema,
    kind: opensteerReversePackageKindSchema,
    readiness: opensteerReversePackageReadinessSchema,
    transport: transportKindSchema,
    stateSource: opensteerStateSourceKindSchema,
    recordId: stringSchema({ minLength: 1 }),
    status: integerSchema({ minimum: 0 }),
    validation: opensteerReverseReplayValidationSchema,
    error: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReverseReplayRunRecord",
    required: ["id", "createdAt", "packageId", "success", "kind", "readiness", "validation"],
  },
);

export const opensteerReverseExperimentRecordSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    createdAt: integerSchema({ minimum: 0 }),
    candidateId: stringSchema({ minLength: 1 }),
    strategyId: stringSchema({ minLength: 1 }),
    kind: enumSchema(["replay-attempt", "field-variation"] as const),
    hypothesis: stringSchema({ minLength: 1 }),
    success: { type: "boolean" },
    status: integerSchema({ minimum: 0 }),
    notes: stringSchema({ minLength: 1 }),
    validation: opensteerReverseReplayValidationSchema,
  },
  {
    title: "OpensteerReverseExperimentRecord",
    required: ["id", "createdAt", "kind", "hypothesis", "success"],
  },
);

export const opensteerReverseRequirementSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    kind: opensteerReverseRequirementKindSchema,
    status: opensteerReverseRequirementStatusSchema,
    label: stringSchema({ minLength: 1 }),
    description: stringSchema({ minLength: 1 }),
    blocking: { type: "boolean" },
    resolverId: stringSchema({ minLength: 1 }),
    guardId: stringSchema({ minLength: 1 }),
    stepId: stringSchema({ minLength: 1 }),
    inputNames: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    traceId: stringSchema({ minLength: 1 }),
    artifactId: stringSchema({ minLength: 1 }),
    recordId: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReverseRequirement",
    required: ["id", "kind", "status", "label", "blocking"],
  },
);

export const opensteerReverseSuggestedEditSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    kind: opensteerReverseSuggestedEditKindSchema,
    label: stringSchema({ minLength: 1 }),
    description: stringSchema({ minLength: 1 }),
    resolverId: stringSchema({ minLength: 1 }),
    guardId: stringSchema({ minLength: 1 }),
    stepId: stringSchema({ minLength: 1 }),
    traceId: stringSchema({ minLength: 1 }),
    artifactId: stringSchema({ minLength: 1 }),
    recordId: stringSchema({ minLength: 1 }),
    payload: jsonValueSchema,
  },
  {
    title: "OpensteerReverseSuggestedEdit",
    required: ["id", "kind", "label"],
  },
);

export const opensteerReverseExportRecordSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    createdAt: integerSchema({ minimum: 0 }),
    candidateId: stringSchema({ minLength: 1 }),
    strategyId: stringSchema({ minLength: 1 }),
    packageId: stringSchema({ minLength: 1 }),
    kind: opensteerReversePackageKindSchema,
    readiness: opensteerReversePackageReadinessSchema,
    requestPlanId: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReverseExportRecord",
    required: ["id", "createdAt", "packageId", "kind", "readiness"],
  },
);

export const opensteerReverseCasePayloadSchema: JsonSchema = objectSchema(
  {
    objective: stringSchema({ minLength: 1 }),
    notes: stringSchema({ minLength: 1 }),
    status: opensteerReverseCaseStatusSchema,
    stateSource: opensteerStateSourceKindSchema,
    observations: arraySchema(opensteerReverseObservationRecordSchema),
    observationClusters: arraySchema(opensteerObservationClusterSchema),
    candidates: arraySchema(opensteerReverseCandidateRecordSchema),
    guards: arraySchema(opensteerReverseGuardRecordSchema),
    stateSnapshots: arraySchema(opensteerStateSnapshotSchema),
    stateDeltas: arraySchema(opensteerStateDeltaSchema),
    experiments: arraySchema(opensteerReverseExperimentRecordSchema),
    replayRuns: arraySchema(opensteerReverseReplayRunRecordSchema),
    exports: arraySchema(opensteerReverseExportRecordSchema),
  },
  {
    title: "OpensteerReverseCasePayload",
    required: [
      "objective",
      "status",
      "stateSource",
      "observations",
      "observationClusters",
      "candidates",
      "guards",
      "stateSnapshots",
      "stateDeltas",
      "experiments",
      "replayRuns",
      "exports",
    ],
  },
);

export const opensteerReverseCaseRecordSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
    createdAt: integerSchema({ minimum: 0 }),
    updatedAt: integerSchema({ minimum: 0 }),
    contentHash: stringSchema({ minLength: 1 }),
    tags: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    provenance: opensteerRegistryProvenanceSchema,
    payload: opensteerReverseCasePayloadSchema,
  },
  {
    title: "OpensteerReverseCaseRecord",
    required: ["id", "key", "version", "createdAt", "updatedAt", "contentHash", "tags", "payload"],
  },
);

export const opensteerReversePackagePayloadSchema: JsonSchema = objectSchema(
  {
    kind: opensteerReversePackageKindSchema,
    readiness: opensteerReversePackageReadinessSchema,
    caseId: stringSchema({ minLength: 1 }),
    objective: stringSchema({ minLength: 1 }),
    candidateId: stringSchema({ minLength: 1 }),
    candidate: opensteerReverseCandidateRecordSchema,
    strategyId: stringSchema({ minLength: 1 }),
    strategy: opensteerReplayStrategySchema,
    channel: opensteerChannelDescriptorSchema,
    stateSource: opensteerStateSourceKindSchema,
    observationId: stringSchema({ minLength: 1 }),
    transport: transportKindSchema,
    guardIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    workflow: arraySchema(opensteerReverseWorkflowStepSchema),
    resolvers: arraySchema(opensteerExecutableResolverSchema),
    validators: arraySchema(opensteerValidationRuleSchema),
    stateSnapshots: arraySchema(opensteerStateSnapshotSchema),
    requirements: opensteerReversePackageRequirementsSchema,
    requestPlanId: stringSchema({ minLength: 1 }),
    unresolvedRequirements: arraySchema(opensteerReverseRequirementSchema),
    suggestedEdits: arraySchema(opensteerReverseSuggestedEditSchema),
    attachedTraceIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    attachedArtifactIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    attachedRecordIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    notes: stringSchema({ minLength: 1 }),
    parentPackageId: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReversePackagePayload",
    required: [
      "kind",
      "readiness",
      "caseId",
      "objective",
      "guardIds",
      "workflow",
      "resolvers",
      "validators",
      "stateSnapshots",
      "requirements",
      "unresolvedRequirements",
      "suggestedEdits",
      "attachedTraceIds",
      "attachedArtifactIds",
      "attachedRecordIds",
    ],
  },
);

export const opensteerReversePackageRecordSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
    createdAt: integerSchema({ minimum: 0 }),
    updatedAt: integerSchema({ minimum: 0 }),
    contentHash: stringSchema({ minLength: 1 }),
    tags: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    provenance: opensteerRegistryProvenanceSchema,
    payload: opensteerReversePackagePayloadSchema,
  },
  {
    title: "OpensteerReversePackageRecord",
    required: ["id", "key", "version", "createdAt", "updatedAt", "contentHash", "tags", "payload"],
  },
);

export const opensteerReverseCandidateReportItemSchema: JsonSchema = objectSchema(
  {
    candidateId: stringSchema({ minLength: 1 }),
    clusterId: stringSchema({ minLength: 1 }),
    score: numberSchema(),
    role: opensteerReverseCandidateRoleSchema,
    dependencyClass: opensteerReverseCandidateDependencyClassSchema,
    bodyCodec: opensteerBodyCodecDescriptorSchema,
    summary: stringSchema({ minLength: 1 }),
    reasons: arraySchema(stringSchema({ minLength: 1 })),
  },
  {
    title: "OpensteerReverseCandidateReportItem",
    required: [
      "candidateId",
      "clusterId",
      "score",
      "role",
      "dependencyClass",
      "bodyCodec",
      "summary",
      "reasons",
    ],
  },
);

export const opensteerReverseReportPayloadSchema: JsonSchema = objectSchema(
  {
    caseId: stringSchema({ minLength: 1 }),
    objective: stringSchema({ minLength: 1 }),
    packageId: stringSchema({ minLength: 1 }),
    packageKind: opensteerReversePackageKindSchema,
    packageReadiness: opensteerReversePackageReadinessSchema,
    chosenCandidateId: stringSchema({ minLength: 1 }),
    chosenStrategyId: stringSchema({ minLength: 1 }),
    observations: arraySchema(opensteerReverseObservationRecordSchema),
    observationClusters: arraySchema(opensteerObservationClusterSchema),
    guards: arraySchema(opensteerReverseGuardRecordSchema),
    stateDeltas: arraySchema(opensteerStateDeltaSchema),
    candidateRankings: arraySchema(opensteerReverseCandidateReportItemSchema),
    experiments: arraySchema(opensteerReverseExperimentRecordSchema),
    replayRuns: arraySchema(opensteerReverseReplayRunRecordSchema),
    unresolvedRequirements: arraySchema(opensteerReverseRequirementSchema),
    suggestedEdits: arraySchema(opensteerReverseSuggestedEditSchema),
    linkedNetworkRecordIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    linkedInteractionTraceIds: arraySchema(stringSchema({ minLength: 1 }), {
      uniqueItems: true,
    }),
    linkedArtifactIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    linkedStateSnapshotIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    package: opensteerReversePackageRecordSchema,
  },
  {
    title: "OpensteerReverseReportPayload",
    required: [
      "caseId",
      "objective",
      "packageId",
      "packageKind",
      "packageReadiness",
      "observations",
      "observationClusters",
      "guards",
      "stateDeltas",
      "candidateRankings",
      "experiments",
      "replayRuns",
      "unresolvedRequirements",
      "suggestedEdits",
      "linkedNetworkRecordIds",
      "linkedInteractionTraceIds",
      "linkedArtifactIds",
      "linkedStateSnapshotIds",
      "package",
    ],
  },
);

export const opensteerReverseReportRecordSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
    createdAt: integerSchema({ minimum: 0 }),
    updatedAt: integerSchema({ minimum: 0 }),
    contentHash: stringSchema({ minLength: 1 }),
    tags: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    provenance: opensteerRegistryProvenanceSchema,
    payload: opensteerReverseReportPayloadSchema,
  },
  {
    title: "OpensteerReverseReportRecord",
    required: ["id", "key", "version", "createdAt", "updatedAt", "contentHash", "tags", "payload"],
  },
);

const opensteerReverseNetworkFilterSchema: JsonSchema = objectSchema(
  {
    url: stringSchema({ minLength: 1 }),
    hostname: stringSchema({ minLength: 1 }),
    path: stringSchema({ minLength: 1 }),
    method: stringSchema({ minLength: 1 }),
    resourceType: stringSchema({ minLength: 1 }),
    includeBodies: { type: "boolean" },
  },
  {
    title: "OpensteerReverseCaptureNetworkFilter",
  },
);

export const opensteerReverseSolveInputSchema: JsonSchema = objectSchema(
  {
    caseId: stringSchema({ minLength: 1 }),
    key: stringSchema({ minLength: 1 }),
    objective: stringSchema({ minLength: 1 }),
    notes: stringSchema({ minLength: 1 }),
    tags: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    pageRef: pageRefSchema,
    stateSource: opensteerStateSourceKindSchema,
    network: opensteerReverseNetworkFilterSchema,
    includeScripts: { type: "boolean" },
    includeStorage: { type: "boolean" },
    includeSessionStorage: { type: "boolean" },
    includeIndexedDb: { type: "boolean" },
    interactionTraceIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    targetHints: opensteerReverseTargetHintsSchema,
    captureWindowMs: integerSchema({ minimum: 0 }),
    manualCalibration: opensteerReverseManualCalibrationModeSchema,
    candidateLimit: integerSchema({ minimum: 1 }),
    maxReplayAttempts: integerSchema({ minimum: 0 }),
  },
  {
    title: "OpensteerReverseSolveInput",
  },
);

export const opensteerReverseSolveOutputSchema: JsonSchema = objectSchema(
  {
    caseId: stringSchema({ minLength: 1 }),
    package: opensteerReversePackageRecordSchema,
    report: opensteerReverseReportRecordSchema,
  },
  {
    title: "OpensteerReverseSolveOutput",
    required: ["caseId", "package", "report"],
  },
);

export const opensteerReverseReplayInputSchema: JsonSchema = objectSchema(
  {
    packageId: stringSchema({ minLength: 1 }),
    pageRef: pageRefSchema,
  },
  {
    title: "OpensteerReverseReplayInput",
    required: ["packageId"],
  },
);

export const opensteerReverseReplayOutputSchema: JsonSchema = objectSchema(
  {
    packageId: stringSchema({ minLength: 1 }),
    caseId: stringSchema({ minLength: 1 }),
    candidateId: stringSchema({ minLength: 1 }),
    strategyId: stringSchema({ minLength: 1 }),
    success: { type: "boolean" },
    kind: opensteerReversePackageKindSchema,
    readiness: opensteerReversePackageReadinessSchema,
    channel: opensteerReverseChannelKindSchema,
    transport: transportKindSchema,
    stateSource: opensteerStateSourceKindSchema,
    recordId: stringSchema({ minLength: 1 }),
    status: integerSchema({ minimum: 0 }),
    validation: opensteerReverseReplayValidationSchema,
    unresolvedRequirements: arraySchema(opensteerReverseRequirementSchema),
    suggestedEdits: arraySchema(opensteerReverseSuggestedEditSchema),
    error: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReverseReplayOutput",
    required: [
      "packageId",
      "success",
      "kind",
      "readiness",
      "validation",
      "unresolvedRequirements",
      "suggestedEdits",
    ],
  },
);

export const opensteerReverseExportInputSchema: JsonSchema = objectSchema(
  {
    packageId: stringSchema({ minLength: 1 }),
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReverseExportInput",
    required: ["packageId"],
  },
);

export const opensteerReverseExportOutputSchema: JsonSchema = objectSchema(
  {
    package: opensteerReversePackageRecordSchema,
    requestPlan: opensteerRequestPlanRecordSchema,
  },
  {
    title: "OpensteerReverseExportOutput",
    required: ["package"],
  },
);

export const opensteerReverseReportInputSchema: JsonSchema = objectSchema(
  {
    packageId: stringSchema({ minLength: 1 }),
    reportId: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReverseReportInput",
  },
);

export const opensteerReverseReportOutputSchema: JsonSchema = objectSchema(
  {
    report: opensteerReverseReportRecordSchema,
  },
  {
    title: "OpensteerReverseReportOutput",
    required: ["report"],
  },
);

export const opensteerReversePackageGetInputSchema: JsonSchema = objectSchema(
  {
    packageId: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReversePackageGetInput",
    required: ["packageId"],
  },
);

export const opensteerReversePackageGetOutputSchema: JsonSchema = objectSchema(
  {
    package: opensteerReversePackageRecordSchema,
  },
  {
    title: "OpensteerReversePackageGetOutput",
    required: ["package"],
  },
);

export const opensteerReversePackageListInputSchema: JsonSchema = objectSchema(
  {
    caseId: stringSchema({ minLength: 1 }),
    key: stringSchema({ minLength: 1 }),
    kind: opensteerReversePackageKindSchema,
    readiness: opensteerReversePackageReadinessSchema,
  },
  {
    title: "OpensteerReversePackageListInput",
  },
);

export const opensteerReversePackageListOutputSchema: JsonSchema = objectSchema(
  {
    packages: arraySchema(opensteerReversePackageRecordSchema),
  },
  {
    title: "OpensteerReversePackageListOutput",
    required: ["packages"],
  },
);

export const opensteerReversePackagePatchInputSchema: JsonSchema = objectSchema(
  {
    packageId: stringSchema({ minLength: 1 }),
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
    notes: stringSchema({ minLength: 1 }),
    candidateId: stringSchema({ minLength: 1 }),
    strategyId: stringSchema({ minLength: 1 }),
    workflow: arraySchema(opensteerReverseWorkflowStepSchema),
    resolvers: arraySchema(opensteerExecutableResolverSchema),
    validators: arraySchema(opensteerValidationRuleSchema),
    attachedTraceIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    attachedArtifactIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    attachedRecordIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    stateSnapshotIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
  },
  {
    title: "OpensteerReversePackagePatchInput",
    required: ["packageId"],
  },
);

export const opensteerReversePackagePatchOutputSchema: JsonSchema = objectSchema(
  {
    package: opensteerReversePackageRecordSchema,
    report: opensteerReverseReportRecordSchema,
  },
  {
    title: "OpensteerReversePackagePatchOutput",
    required: ["package", "report"],
  },
);
