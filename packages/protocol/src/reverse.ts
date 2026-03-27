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

export type OpensteerStateSourceKind = "temporary" | "persistent" | "attach";

export type OpensteerReverseCaseStatus = "capturing" | "analyzing" | "ready" | "attention";

export type OpensteerReverseChannelKind = "http" | "event-stream" | "websocket";

export type OpensteerReverseManualCalibrationMode = "allow" | "avoid" | "require";

export type OpensteerReverseCandidateBoundary = "first-party" | "same-site" | "third-party";

export type OpensteerReverseAdvisoryTag =
  | "data"
  | "facet"
  | "telemetry"
  | "subscription"
  | "navigation"
  | "document"
  | "route-data"
  | "search"
  | "tracking"
  | "unknown";

export type OpensteerReverseConstraintKind =
  | "requires-browser"
  | "requires-cookie"
  | "requires-storage"
  | "requires-script"
  | "requires-guard"
  | "requires-live-state"
  | "opaque-body"
  | "unsupported";

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

export type OpensteerReverseQueryView = "records" | "clusters" | "candidates";

export type OpensteerReverseSortKey =
  | "observed-at"
  | "advisory-rank"
  | "target-hint-matches"
  | "response-richness"
  | "portability"
  | "boundary"
  | "success";

export type OpensteerReverseSortPreset =
  | "advisory-rank"
  | "observed-at"
  | "portability"
  | "first-party"
  | "hint-match"
  | "response-richness";

export type OpensteerReverseSortDirection = "asc" | "desc";

export type OpensteerObservationClusterRelationshipKind =
  | "seed"
  | "preflight"
  | "redirect"
  | "retry"
  | "duplicate"
  | "follow-on";

export type OpensteerReversePackageKind = "portable-http" | "browser-workflow";

export type OpensteerReversePackageReadiness = "runnable" | "draft" | "unsupported";

export type OpensteerReverseReportKind = "discovery" | "package";

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
  | "prior-record"
  | "binding"
  | "candidate"
  | "case"
  | "state-snapshot"
  | "artifact"
  | "manual"
  | "runtime-managed";

export type OpensteerValueReferenceKind =
  | "literal"
  | "resolver"
  | "binding"
  | "candidate"
  | "case"
  | "record"
  | "artifact"
  | "state-snapshot"
  | "runtime"
  | "manual";

export type OpensteerRuntimeValueKey =
  | "pageRef"
  | "packageId"
  | "caseId"
  | "candidateId"
  | "objective";

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

export interface OpensteerValueReference {
  readonly kind: OpensteerValueReferenceKind;
  readonly pointer?: string;
  readonly resolverId?: string;
  readonly binding?: string;
  readonly recordId?: string;
  readonly artifactId?: string;
  readonly stateSnapshotId?: string;
  readonly runtimeKey?: OpensteerRuntimeValueKey;
  readonly value?: JsonValue;
  readonly placeholder?: string;
}

export interface OpensteerValueReferenceEnvelope {
  readonly $ref: OpensteerValueReference;
}

export interface OpensteerValueTemplateObject {
  readonly [key: string]: OpensteerValueTemplate;
}

export type OpensteerValueTemplate =
  | JsonValue
  | OpensteerValueReferenceEnvelope
  | OpensteerValueTemplateObject
  | readonly OpensteerValueTemplate[];

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
  readonly matchedTargetHints: readonly string[];
  readonly members: readonly OpensteerObservationClusterMember[];
}

export interface OpensteerObservationClusterMember {
  readonly recordId: string;
  readonly observedAt?: number;
  readonly resourceType?: string;
  readonly status?: number;
  readonly relation: OpensteerObservationClusterRelationshipKind;
  readonly relatedRecordId?: string;
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
  readonly valueRef?: OpensteerValueReference;
}

export interface OpensteerReverseAdvisorySignals {
  readonly advisoryRank: number;
  readonly observedAt?: number;
  readonly targetHintMatches: number;
  readonly responseRichness: number;
  readonly portabilityWeight: number;
  readonly boundaryWeight: number;
  readonly successfulStatus: boolean;
  readonly fetchLike: boolean;
  readonly hasResponseBody: boolean;
  readonly dataPathMatch: boolean;
  readonly cookieInputCount: number;
  readonly storageInputCount: number;
  readonly volatileInputCount: number;
  readonly guardCount: number;
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
  readonly input: OpensteerValueTemplate;
  readonly bindAs?: string;
}

export interface OpensteerReverseAwaitRecordMatch {
  readonly recordId?: string;
  readonly host?: string;
  readonly path?: string;
  readonly method?: string;
  readonly channel?: OpensteerReverseChannelKind;
  readonly status?: number;
  readonly text?: string;
}

export interface OpensteerReverseAwaitRecordWorkflowStep {
  readonly id: string;
  readonly kind: "await-record";
  readonly label: string;
  readonly channel: OpensteerChannelDescriptor;
  readonly recordId?: string;
  readonly match?: OpensteerReverseAwaitRecordMatch;
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

export interface OpensteerReverseAdvisoryTemplate {
  readonly id: string;
  readonly label: string;
  readonly channel: OpensteerReverseChannelKind;
  readonly execution: "transport" | "page-observation";
  readonly stateSource: OpensteerStateSourceKind;
  readonly observationId?: string;
  readonly transport?: TransportKind;
  readonly guardIds: readonly string[];
  readonly resolverIds: readonly string[];
  readonly requiresBrowser: boolean;
  readonly requiresLiveState: boolean;
  readonly viability: "ready" | "draft" | "unsupported";
  readonly notes?: string;
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
  readonly summary: string;
  readonly matchedTargetHints: readonly string[];
  readonly advisoryTags: readonly OpensteerReverseAdvisoryTag[];
  readonly constraints: readonly OpensteerReverseConstraintKind[];
  readonly signals: OpensteerReverseAdvisorySignals;
  readonly inputs: readonly OpensteerRequestInputDescriptor[];
  readonly resolvers: readonly OpensteerExecutableResolver[];
  readonly guardIds: readonly string[];
  readonly scriptArtifactIds: readonly string[];
  readonly advisoryTemplates: readonly OpensteerReverseAdvisoryTemplate[];
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
  readonly templateId?: string;
  readonly packageId: string;
  readonly success: boolean;
  readonly channel?: OpensteerReverseChannelKind;
  readonly kind: OpensteerReversePackageKind;
  readonly readiness: OpensteerReversePackageReadiness;
  readonly transport?: TransportKind;
  readonly stateSource?: OpensteerStateSourceKind;
  readonly executedStepIds: readonly string[];
  readonly failedStepId?: string;
  readonly bindings?: Readonly<Record<string, JsonValue>>;
  readonly recordId?: string;
  readonly status?: number;
  readonly validation: OpensteerReverseReplayValidation;
  readonly error?: string;
}

export interface OpensteerReverseExperimentRecord {
  readonly id: string;
  readonly createdAt: number;
  readonly candidateId?: string;
  readonly templateId?: string;
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
  readonly templateId?: string;
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
  readonly observedRecords: readonly OpensteerReverseObservedRecord[];
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
  readonly source: {
    readonly kind: "record" | "candidate";
    readonly id: string;
  };
  readonly sourceRecordId: string;
  readonly candidateId?: string;
  readonly candidate?: OpensteerReverseCandidateRecord;
  readonly templateId?: string;
  readonly template?: OpensteerReverseAdvisoryTemplate;
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

export interface OpensteerReverseCandidateAdvisoryItem {
  readonly candidateId: string;
  readonly clusterId: string;
  readonly advisoryRank: number;
  readonly bodyCodec: OpensteerBodyCodecDescriptor;
  readonly summary: string;
  readonly advisoryTags: readonly OpensteerReverseAdvisoryTag[];
  readonly constraints: readonly OpensteerReverseConstraintKind[];
  readonly signals: OpensteerReverseAdvisorySignals;
  readonly reasons: readonly string[];
}

export interface OpensteerReverseDiscoverySummaryCounts {
  readonly hosts: Readonly<Record<string, number>>;
  readonly channels: Readonly<Record<string, number>>;
  readonly resourceTypes: Readonly<Record<string, number>>;
  readonly advisoryTags: Readonly<Record<string, number>>;
  readonly constraints: Readonly<Record<string, number>>;
  readonly relationKinds: Readonly<Record<string, number>>;
}

export interface OpensteerReverseReportPayload {
  readonly kind: OpensteerReverseReportKind;
  readonly caseId: string;
  readonly objective: string;
  readonly observations: readonly OpensteerReverseObservationRecord[];
  readonly observationClusters: readonly OpensteerObservationCluster[];
  readonly observedRecords: readonly OpensteerReverseObservedRecord[];
  readonly guards: readonly OpensteerReverseGuardRecord[];
  readonly stateDeltas: readonly OpensteerStateDelta[];
  readonly summaryCounts: OpensteerReverseDiscoverySummaryCounts;
  readonly candidateAdvisories: readonly OpensteerReverseCandidateAdvisoryItem[];
  readonly query?: OpensteerReverseQuerySnapshot;
  readonly experiments: readonly OpensteerReverseExperimentRecord[];
  readonly replayRuns: readonly OpensteerReverseReplayRunRecord[];
  readonly linkedNetworkRecordIds: readonly string[];
  readonly linkedInteractionTraceIds: readonly string[];
  readonly linkedArtifactIds: readonly string[];
  readonly linkedStateSnapshotIds: readonly string[];
  readonly packageId?: string;
  readonly packageKind?: OpensteerReversePackageKind;
  readonly packageReadiness?: OpensteerReversePackageReadiness;
  readonly unresolvedRequirements?: readonly OpensteerReverseRequirement[];
  readonly suggestedEdits?: readonly OpensteerReverseSuggestedEdit[];
  readonly package?: OpensteerReversePackageRecord;
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

export interface OpensteerReverseObservedRecord {
  readonly recordId: string;
  readonly observationId: string;
  readonly clusterId: string;
  readonly observedAt?: number;
  readonly channel: OpensteerChannelDescriptor;
  readonly bodyCodec: OpensteerBodyCodecDescriptor;
  readonly resourceType?: string;
  readonly status?: number;
  readonly matchedTargetHints: readonly string[];
  readonly relationKinds: readonly OpensteerObservationClusterRelationshipKind[];
}

export interface OpensteerReverseQueryFilters {
  readonly recordId?: string;
  readonly clusterId?: string;
  readonly candidateId?: string;
  readonly host?: string;
  readonly path?: string;
  readonly method?: string;
  readonly status?: string;
  readonly resourceType?: string;
  readonly channel?: OpensteerReverseChannelKind;
  readonly boundary?: OpensteerReverseCandidateBoundary;
  readonly advisoryTag?: OpensteerReverseAdvisoryTag;
  readonly constraint?: OpensteerReverseConstraintKind;
  readonly bodyCodec?: OpensteerBodyCodecKind;
  readonly relationKind?: OpensteerObservationClusterRelationshipKind;
  readonly hasGuards?: boolean;
  readonly hasResolvers?: boolean;
  readonly artifactId?: string;
  readonly stateSnapshotId?: string;
  readonly traceId?: string;
  readonly evidenceRef?: string;
  readonly text?: string;
}

export interface OpensteerReverseSortTerm {
  readonly key: OpensteerReverseSortKey;
  readonly direction?: OpensteerReverseSortDirection;
}

export interface OpensteerReverseQuerySort {
  readonly preset?: OpensteerReverseSortPreset;
  readonly keys?: readonly OpensteerReverseSortTerm[];
}

export interface OpensteerReverseQuerySnapshot {
  readonly view: OpensteerReverseQueryView;
  readonly filters?: OpensteerReverseQueryFilters;
  readonly sort: OpensteerReverseQuerySort;
  readonly limit: number;
  readonly totalCount: number;
  readonly nextCursor?: string;
  readonly resultIds: readonly string[];
}

export interface OpensteerReverseQueryRecordItem {
  readonly record: OpensteerReverseObservedRecord;
  readonly candidateIds: readonly string[];
}

export interface OpensteerReverseQueryClusterItem {
  readonly cluster: OpensteerObservationCluster;
  readonly candidateIds: readonly string[];
}

export interface OpensteerReverseQueryCandidateItem {
  readonly candidate: OpensteerReverseCandidateRecord;
  readonly reasons: readonly string[];
}

export interface OpensteerReverseDiscoverInput {
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
}

export interface OpensteerReverseDiscoverOutput {
  readonly caseId: string;
  readonly reportId: string;
  readonly summary: {
    readonly observationIds: readonly string[];
    readonly recordCount: number;
    readonly clusterCount: number;
    readonly candidateCount: number;
  };
  readonly index: {
    readonly views: readonly OpensteerReverseQueryView[];
    readonly sortableKeys: readonly OpensteerReverseSortKey[];
    readonly channels: readonly OpensteerReverseChannelKind[];
    readonly hosts: readonly string[];
    readonly relationKinds: readonly OpensteerObservationClusterRelationshipKind[];
  };
}

export interface OpensteerReverseQueryInput {
  readonly caseId: string;
  readonly view?: OpensteerReverseQueryView;
  readonly filters?: OpensteerReverseQueryFilters;
  readonly sort?: OpensteerReverseQuerySort;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface OpensteerReverseQueryOutput {
  readonly caseId: string;
  readonly view: OpensteerReverseQueryView;
  readonly query: OpensteerReverseQuerySnapshot;
  readonly totalCount: number;
  readonly nextCursor?: string;
  readonly records?: readonly OpensteerReverseQueryRecordItem[];
  readonly clusters?: readonly OpensteerReverseQueryClusterItem[];
  readonly candidates?: readonly OpensteerReverseQueryCandidateItem[];
}

export interface OpensteerReversePackageCreateInput {
  readonly caseId: string;
  readonly source: {
    readonly kind: "record" | "candidate";
    readonly id: string;
  };
  readonly templateId?: string;
  readonly key?: string;
  readonly version?: string;
  readonly notes?: string;
}

export interface OpensteerReversePackageCreateOutput {
  readonly package: OpensteerReversePackageRecord;
  readonly report: OpensteerReverseReportRecord;
}

export interface OpensteerReversePackageRunInput {
  readonly packageId: string;
  readonly pageRef?: PageRef;
}

export interface OpensteerReversePackageRunOutput {
  readonly packageId: string;
  readonly caseId?: string;
  readonly source: {
    readonly kind: "record" | "candidate";
    readonly id: string;
  };
  readonly candidateId?: string;
  readonly templateId?: string;
  readonly success: boolean;
  readonly kind: OpensteerReversePackageKind;
  readonly readiness: OpensteerReversePackageReadiness;
  readonly channel?: OpensteerReverseChannelKind;
  readonly transport?: TransportKind;
  readonly stateSource?: OpensteerStateSourceKind;
  readonly recordId?: string;
  readonly status?: number;
  readonly validation: OpensteerReverseReplayValidation;
  readonly executedStepIds: readonly string[];
  readonly failedStepId?: string;
  readonly bindings: Readonly<Record<string, JsonValue>>;
  readonly replayRunId?: string;
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
  readonly caseId?: string;
  readonly packageId?: string;
  readonly reportId?: string;
  readonly kind?: OpensteerReverseReportKind;
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
  ["temporary", "persistent", "attach"] as const,
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

export const opensteerReverseAdvisoryTagSchema: JsonSchema = enumSchema(
  [
    "data",
    "facet",
    "telemetry",
    "subscription",
    "navigation",
    "document",
    "route-data",
    "search",
    "tracking",
    "unknown",
  ] as const,
  { title: "OpensteerReverseAdvisoryTag" },
);

export const opensteerReverseConstraintKindSchema: JsonSchema = enumSchema(
  [
    "requires-browser",
    "requires-cookie",
    "requires-storage",
    "requires-script",
    "requires-guard",
    "requires-live-state",
    "opaque-body",
    "unsupported",
  ] as const,
  { title: "OpensteerReverseConstraintKind" },
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

export const opensteerReverseQueryViewSchema: JsonSchema = enumSchema(
  ["records", "clusters", "candidates"] as const,
  { title: "OpensteerReverseQueryView" },
);

export const opensteerReverseSortKeySchema: JsonSchema = enumSchema(
  [
    "observed-at",
    "advisory-rank",
    "target-hint-matches",
    "response-richness",
    "portability",
    "boundary",
    "success",
  ] as const,
  { title: "OpensteerReverseSortKey" },
);

export const opensteerReverseSortPresetSchema: JsonSchema = enumSchema(
  [
    "advisory-rank",
    "observed-at",
    "portability",
    "first-party",
    "hint-match",
    "response-richness",
  ] as const,
  { title: "OpensteerReverseSortPreset" },
);

export const opensteerReverseSortDirectionSchema: JsonSchema = enumSchema(
  ["asc", "desc"] as const,
  {
    title: "OpensteerReverseSortDirection",
  },
);

export const opensteerObservationClusterRelationshipKindSchema: JsonSchema = enumSchema(
  ["seed", "preflight", "redirect", "retry", "duplicate", "follow-on"] as const,
  { title: "OpensteerObservationClusterRelationshipKind" },
);

export const opensteerReverseReportKindSchema: JsonSchema = enumSchema(
  ["discovery", "package"] as const,
  { title: "OpensteerReverseReportKind" },
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
    "prior-record",
    "binding",
    "candidate",
    "case",
    "state-snapshot",
    "artifact",
    "manual",
    "runtime-managed",
  ] as const,
  { title: "OpensteerExecutableResolverKind" },
);

export const opensteerValueReferenceKindSchema: JsonSchema = enumSchema(
  [
    "literal",
    "resolver",
    "binding",
    "candidate",
    "case",
    "record",
    "artifact",
    "state-snapshot",
    "runtime",
    "manual",
  ] as const,
  { title: "OpensteerValueReferenceKind" },
);

export const opensteerRuntimeValueKeySchema: JsonSchema = enumSchema(
  ["pageRef", "packageId", "caseId", "candidateId", "objective"] as const,
  { title: "OpensteerRuntimeValueKey" },
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

export const opensteerValueReferenceSchema: JsonSchema = objectSchema(
  {
    kind: opensteerValueReferenceKindSchema,
    pointer: stringSchema({ minLength: 1 }),
    resolverId: stringSchema({ minLength: 1 }),
    binding: stringSchema({ minLength: 1 }),
    recordId: stringSchema({ minLength: 1 }),
    artifactId: stringSchema({ minLength: 1 }),
    stateSnapshotId: stringSchema({ minLength: 1 }),
    runtimeKey: opensteerRuntimeValueKeySchema,
    value: jsonValueSchema,
    placeholder: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerValueReference",
    required: ["kind"],
  },
);

export const opensteerValueTemplateSchema: JsonSchema = defineSchema({
  title: "OpensteerValueTemplate",
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
    matchedTargetHints: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    members: arraySchema(
      objectSchema(
        {
          recordId: stringSchema({ minLength: 1 }),
          observedAt: integerSchema({ minimum: 0 }),
          resourceType: stringSchema({ minLength: 1 }),
          status: integerSchema({ minimum: 0 }),
          relation: opensteerObservationClusterRelationshipKindSchema,
          relatedRecordId: stringSchema({ minLength: 1 }),
          matchedTargetHints: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
        },
        {
          title: "OpensteerObservationClusterMember",
          required: ["recordId", "relation", "matchedTargetHints"],
        },
      ),
    ),
  },
  {
    title: "OpensteerObservationCluster",
    required: ["id", "observationId", "label", "channel", "url", "matchedTargetHints", "members"],
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
    valueRef: opensteerValueReferenceSchema,
  },
  {
    title: "OpensteerExecutableResolver",
    required: ["id", "kind", "label", "status", "requiresBrowser", "requiresLiveState"],
  },
);

export const opensteerReverseAdvisorySignalsSchema: JsonSchema = objectSchema(
  {
    advisoryRank: numberSchema(),
    observedAt: integerSchema({ minimum: 0 }),
    targetHintMatches: integerSchema({ minimum: 0 }),
    responseRichness: integerSchema({ minimum: 0 }),
    portabilityWeight: integerSchema({ minimum: 0 }),
    boundaryWeight: integerSchema({ minimum: 0 }),
    successfulStatus: { type: "boolean" },
    fetchLike: { type: "boolean" },
    hasResponseBody: { type: "boolean" },
    dataPathMatch: { type: "boolean" },
    cookieInputCount: integerSchema({ minimum: 0 }),
    storageInputCount: integerSchema({ minimum: 0 }),
    volatileInputCount: integerSchema({ minimum: 0 }),
    guardCount: integerSchema({ minimum: 0 }),
  },
  {
    title: "OpensteerReverseAdvisorySignals",
    required: [
      "advisoryRank",
      "targetHintMatches",
      "responseRichness",
      "portabilityWeight",
      "boundaryWeight",
      "successfulStatus",
      "fetchLike",
      "hasResponseBody",
      "dataPathMatch",
      "cookieInputCount",
      "storageInputCount",
      "volatileInputCount",
      "guardCount",
    ],
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
    input: opensteerValueTemplateSchema,
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
    match: objectSchema(
      {
        recordId: stringSchema({ minLength: 1 }),
        host: stringSchema({ minLength: 1 }),
        path: stringSchema({ minLength: 1 }),
        method: stringSchema({ minLength: 1 }),
        channel: opensteerReverseChannelKindSchema,
        status: integerSchema({ minimum: 0 }),
        text: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerReverseAwaitRecordMatch",
      },
    ),
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

export const opensteerReverseAdvisoryTemplateSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    label: stringSchema({ minLength: 1 }),
    channel: opensteerReverseChannelKindSchema,
    execution: enumSchema(["transport", "page-observation"] as const),
    stateSource: opensteerStateSourceKindSchema,
    observationId: stringSchema({ minLength: 1 }),
    transport: transportKindSchema,
    guardIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    resolverIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    requiresBrowser: { type: "boolean" },
    requiresLiveState: { type: "boolean" },
    viability: enumSchema(["ready", "draft", "unsupported"] as const),
    notes: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReverseAdvisoryTemplate",
    required: [
      "id",
      "label",
      "channel",
      "execution",
      "stateSource",
      "guardIds",
      "resolverIds",
      "requiresBrowser",
      "requiresLiveState",
      "viability",
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

export const opensteerReverseObservedRecordSchema: JsonSchema = objectSchema(
  {
    recordId: stringSchema({ minLength: 1 }),
    observationId: stringSchema({ minLength: 1 }),
    clusterId: stringSchema({ minLength: 1 }),
    observedAt: integerSchema({ minimum: 0 }),
    channel: opensteerChannelDescriptorSchema,
    bodyCodec: opensteerBodyCodecDescriptorSchema,
    resourceType: stringSchema({ minLength: 1 }),
    status: integerSchema({ minimum: 0 }),
    matchedTargetHints: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    relationKinds: arraySchema(opensteerObservationClusterRelationshipKindSchema, {
      uniqueItems: true,
    }),
  },
  {
    title: "OpensteerReverseObservedRecord",
    required: [
      "recordId",
      "observationId",
      "clusterId",
      "channel",
      "bodyCodec",
      "matchedTargetHints",
      "relationKinds",
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
    summary: stringSchema({ minLength: 1 }),
    matchedTargetHints: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    advisoryTags: arraySchema(opensteerReverseAdvisoryTagSchema, { uniqueItems: true }),
    constraints: arraySchema(opensteerReverseConstraintKindSchema, { uniqueItems: true }),
    signals: opensteerReverseAdvisorySignalsSchema,
    inputs: arraySchema(opensteerRequestInputDescriptorSchema),
    resolvers: arraySchema(opensteerExecutableResolverSchema),
    guardIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    scriptArtifactIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    advisoryTemplates: arraySchema(opensteerReverseAdvisoryTemplateSchema),
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
      "summary",
      "matchedTargetHints",
      "advisoryTags",
      "constraints",
      "signals",
      "inputs",
      "resolvers",
      "guardIds",
      "scriptArtifactIds",
      "advisoryTemplates",
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
    templateId: stringSchema({ minLength: 1 }),
    packageId: stringSchema({ minLength: 1 }),
    success: { type: "boolean" },
    channel: opensteerReverseChannelKindSchema,
    kind: opensteerReversePackageKindSchema,
    readiness: opensteerReversePackageReadinessSchema,
    transport: transportKindSchema,
    stateSource: opensteerStateSourceKindSchema,
    executedStepIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    failedStepId: stringSchema({ minLength: 1 }),
    bindings: recordSchema({}, { title: "OpensteerReverseReplayRunBindings" }),
    recordId: stringSchema({ minLength: 1 }),
    status: integerSchema({ minimum: 0 }),
    validation: opensteerReverseReplayValidationSchema,
    error: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReverseReplayRunRecord",
    required: [
      "id",
      "createdAt",
      "packageId",
      "success",
      "kind",
      "readiness",
      "executedStepIds",
      "validation",
    ],
  },
);

export const opensteerReverseExperimentRecordSchema: JsonSchema = objectSchema(
  {
    id: stringSchema({ minLength: 1 }),
    createdAt: integerSchema({ minimum: 0 }),
    candidateId: stringSchema({ minLength: 1 }),
    templateId: stringSchema({ minLength: 1 }),
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
    templateId: stringSchema({ minLength: 1 }),
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
    observedRecords: arraySchema(opensteerReverseObservedRecordSchema),
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
      "observedRecords",
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
    source: objectSchema(
      {
        kind: enumSchema(["record", "candidate"] as const),
        id: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerReversePackageSource",
        required: ["kind", "id"],
      },
    ),
    sourceRecordId: stringSchema({ minLength: 1 }),
    candidateId: stringSchema({ minLength: 1 }),
    candidate: opensteerReverseCandidateRecordSchema,
    templateId: stringSchema({ minLength: 1 }),
    template: opensteerReverseAdvisoryTemplateSchema,
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
      "source",
      "sourceRecordId",
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
    advisoryRank: numberSchema(),
    bodyCodec: opensteerBodyCodecDescriptorSchema,
    summary: stringSchema({ minLength: 1 }),
    advisoryTags: arraySchema(opensteerReverseAdvisoryTagSchema, { uniqueItems: true }),
    constraints: arraySchema(opensteerReverseConstraintKindSchema, { uniqueItems: true }),
    signals: opensteerReverseAdvisorySignalsSchema,
    reasons: arraySchema(stringSchema({ minLength: 1 })),
  },
  {
    title: "OpensteerReverseCandidateAdvisoryItem",
    required: [
      "candidateId",
      "clusterId",
      "advisoryRank",
      "bodyCodec",
      "summary",
      "advisoryTags",
      "constraints",
      "signals",
      "reasons",
    ],
  },
);

const opensteerReverseDiscoverySummaryCountsSchema: JsonSchema = objectSchema(
  {
    hosts: recordSchema(integerSchema({ minimum: 0 }), { title: "OpensteerReverseSummaryHosts" }),
    channels: recordSchema(integerSchema({ minimum: 0 }), {
      title: "OpensteerReverseSummaryChannels",
    }),
    resourceTypes: recordSchema(integerSchema({ minimum: 0 }), {
      title: "OpensteerReverseSummaryResourceTypes",
    }),
    advisoryTags: recordSchema(integerSchema({ minimum: 0 }), {
      title: "OpensteerReverseSummaryAdvisoryTags",
    }),
    constraints: recordSchema(integerSchema({ minimum: 0 }), {
      title: "OpensteerReverseSummaryConstraints",
    }),
    relationKinds: recordSchema(integerSchema({ minimum: 0 }), {
      title: "OpensteerReverseSummaryRelationKinds",
    }),
  },
  {
    title: "OpensteerReverseDiscoverySummaryCounts",
    required: [
      "hosts",
      "channels",
      "resourceTypes",
      "advisoryTags",
      "constraints",
      "relationKinds",
    ],
  },
);

export const opensteerReverseReportPayloadSchema: JsonSchema = objectSchema(
  {
    kind: opensteerReverseReportKindSchema,
    caseId: stringSchema({ minLength: 1 }),
    objective: stringSchema({ minLength: 1 }),
    packageId: stringSchema({ minLength: 1 }),
    packageKind: opensteerReversePackageKindSchema,
    packageReadiness: opensteerReversePackageReadinessSchema,
    observations: arraySchema(opensteerReverseObservationRecordSchema),
    observationClusters: arraySchema(opensteerObservationClusterSchema),
    observedRecords: arraySchema(opensteerReverseObservedRecordSchema),
    guards: arraySchema(opensteerReverseGuardRecordSchema),
    stateDeltas: arraySchema(opensteerStateDeltaSchema),
    summaryCounts: opensteerReverseDiscoverySummaryCountsSchema,
    candidateAdvisories: arraySchema(opensteerReverseCandidateReportItemSchema),
    query: objectSchema(
      {
        view: opensteerReverseQueryViewSchema,
        filters: objectSchema(
          {
            recordId: stringSchema({ minLength: 1 }),
            clusterId: stringSchema({ minLength: 1 }),
            candidateId: stringSchema({ minLength: 1 }),
            host: stringSchema({ minLength: 1 }),
            path: stringSchema({ minLength: 1 }),
            method: stringSchema({ minLength: 1 }),
            status: stringSchema({ minLength: 1 }),
            resourceType: stringSchema({ minLength: 1 }),
            channel: opensteerReverseChannelKindSchema,
            boundary: opensteerReverseCandidateBoundarySchema,
            advisoryTag: opensteerReverseAdvisoryTagSchema,
            constraint: opensteerReverseConstraintKindSchema,
            bodyCodec: opensteerBodyCodecKindSchema,
            relationKind: opensteerObservationClusterRelationshipKindSchema,
            hasGuards: { type: "boolean" },
            hasResolvers: { type: "boolean" },
            artifactId: stringSchema({ minLength: 1 }),
            stateSnapshotId: stringSchema({ minLength: 1 }),
            traceId: stringSchema({ minLength: 1 }),
            evidenceRef: stringSchema({ minLength: 1 }),
            text: stringSchema({ minLength: 1 }),
          },
          {
            title: "OpensteerReverseReportQueryFilters",
          },
        ),
        sort: objectSchema(
          {
            preset: opensteerReverseSortPresetSchema,
            keys: arraySchema(
              objectSchema(
                {
                  key: opensteerReverseSortKeySchema,
                  direction: opensteerReverseSortDirectionSchema,
                },
                {
                  title: "OpensteerReverseReportQuerySortTerm",
                  required: ["key"],
                },
              ),
              { minItems: 1 },
            ),
          },
          {
            title: "OpensteerReverseReportQuerySort",
          },
        ),
        limit: integerSchema({ minimum: 1 }),
        totalCount: integerSchema({ minimum: 0 }),
        nextCursor: stringSchema({ minLength: 1 }),
        resultIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
      },
      {
        title: "OpensteerReverseQuerySnapshot",
        required: ["view", "sort", "limit", "totalCount", "resultIds"],
      },
    ),
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
      "kind",
      "caseId",
      "objective",
      "observations",
      "observationClusters",
      "observedRecords",
      "guards",
      "stateDeltas",
      "summaryCounts",
      "candidateAdvisories",
      "experiments",
      "replayRuns",
      "linkedNetworkRecordIds",
      "linkedInteractionTraceIds",
      "linkedArtifactIds",
      "linkedStateSnapshotIds",
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

const opensteerReverseQueryFiltersSchema: JsonSchema = objectSchema(
  {
    recordId: stringSchema({ minLength: 1 }),
    clusterId: stringSchema({ minLength: 1 }),
    candidateId: stringSchema({ minLength: 1 }),
    host: stringSchema({ minLength: 1 }),
    path: stringSchema({ minLength: 1 }),
    method: stringSchema({ minLength: 1 }),
    status: stringSchema({ minLength: 1 }),
    resourceType: stringSchema({ minLength: 1 }),
    channel: opensteerReverseChannelKindSchema,
    boundary: opensteerReverseCandidateBoundarySchema,
    advisoryTag: opensteerReverseAdvisoryTagSchema,
    constraint: opensteerReverseConstraintKindSchema,
    bodyCodec: opensteerBodyCodecKindSchema,
    relationKind: opensteerObservationClusterRelationshipKindSchema,
    hasGuards: { type: "boolean" },
    hasResolvers: { type: "boolean" },
    artifactId: stringSchema({ minLength: 1 }),
    stateSnapshotId: stringSchema({ minLength: 1 }),
    traceId: stringSchema({ minLength: 1 }),
    evidenceRef: stringSchema({ minLength: 1 }),
    text: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReverseQueryFilters",
  },
);

const opensteerReverseQuerySortSchema: JsonSchema = objectSchema(
  {
    preset: opensteerReverseSortPresetSchema,
    keys: arraySchema(
      objectSchema(
        {
          key: opensteerReverseSortKeySchema,
          direction: opensteerReverseSortDirectionSchema,
        },
        {
          title: "OpensteerReverseSortTerm",
          required: ["key"],
        },
      ),
      { minItems: 1 },
    ),
  },
  {
    title: "OpensteerReverseQuerySort",
  },
);

const opensteerReverseQuerySnapshotSchema: JsonSchema = objectSchema(
  {
    view: opensteerReverseQueryViewSchema,
    filters: opensteerReverseQueryFiltersSchema,
    sort: opensteerReverseQuerySortSchema,
    limit: integerSchema({ minimum: 1, maximum: 200 }),
    totalCount: integerSchema({ minimum: 0 }),
    nextCursor: stringSchema({ minLength: 1 }),
    resultIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
  },
  {
    title: "OpensteerReverseQuerySnapshot",
    required: ["view", "sort", "limit", "totalCount", "resultIds"],
  },
);

const opensteerReverseQueryRecordItemSchema: JsonSchema = objectSchema(
  {
    record: opensteerReverseObservedRecordSchema,
    candidateIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
  },
  {
    title: "OpensteerReverseQueryRecordItem",
    required: ["record", "candidateIds"],
  },
);

const opensteerReverseQueryClusterItemSchema: JsonSchema = objectSchema(
  {
    cluster: opensteerObservationClusterSchema,
    candidateIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
  },
  {
    title: "OpensteerReverseQueryClusterItem",
    required: ["cluster", "candidateIds"],
  },
);

const opensteerReverseQueryCandidateItemSchema: JsonSchema = objectSchema(
  {
    candidate: opensteerReverseCandidateRecordSchema,
    reasons: arraySchema(stringSchema({ minLength: 1 })),
  },
  {
    title: "OpensteerReverseQueryCandidateItem",
    required: ["candidate", "reasons"],
  },
);

export const opensteerReverseDiscoverInputSchema: JsonSchema = objectSchema(
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
  },
  {
    title: "OpensteerReverseDiscoverInput",
  },
);

export const opensteerReverseDiscoverOutputSchema: JsonSchema = objectSchema(
  {
    caseId: stringSchema({ minLength: 1 }),
    reportId: stringSchema({ minLength: 1 }),
    summary: objectSchema(
      {
        observationIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
        recordCount: integerSchema({ minimum: 0 }),
        clusterCount: integerSchema({ minimum: 0 }),
        candidateCount: integerSchema({ minimum: 0 }),
      },
      {
        title: "OpensteerReverseDiscoverSummary",
        required: ["observationIds", "recordCount", "clusterCount", "candidateCount"],
      },
    ),
    index: objectSchema(
      {
        views: arraySchema(opensteerReverseQueryViewSchema, { uniqueItems: true }),
        sortableKeys: arraySchema(opensteerReverseSortKeySchema, { uniqueItems: true }),
        channels: arraySchema(opensteerReverseChannelKindSchema, { uniqueItems: true }),
        hosts: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
        relationKinds: arraySchema(opensteerObservationClusterRelationshipKindSchema, {
          uniqueItems: true,
        }),
      },
      {
        title: "OpensteerReverseDiscoverIndex",
        required: ["views", "sortableKeys", "channels", "hosts", "relationKinds"],
      },
    ),
  },
  {
    title: "OpensteerReverseDiscoverOutput",
    required: ["caseId", "reportId", "summary", "index"],
  },
);

export const opensteerReverseQueryInputSchema: JsonSchema = objectSchema(
  {
    caseId: stringSchema({ minLength: 1 }),
    view: opensteerReverseQueryViewSchema,
    filters: opensteerReverseQueryFiltersSchema,
    sort: opensteerReverseQuerySortSchema,
    limit: integerSchema({ minimum: 1, maximum: 200 }),
    cursor: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReverseQueryInput",
    required: ["caseId"],
  },
);

export const opensteerReverseQueryOutputSchema: JsonSchema = objectSchema(
  {
    caseId: stringSchema({ minLength: 1 }),
    view: opensteerReverseQueryViewSchema,
    query: opensteerReverseQuerySnapshotSchema,
    totalCount: integerSchema({ minimum: 0 }),
    nextCursor: stringSchema({ minLength: 1 }),
    records: arraySchema(opensteerReverseQueryRecordItemSchema),
    clusters: arraySchema(opensteerReverseQueryClusterItemSchema),
    candidates: arraySchema(opensteerReverseQueryCandidateItemSchema),
  },
  {
    title: "OpensteerReverseQueryOutput",
    required: ["caseId", "view", "query", "totalCount"],
  },
);

export const opensteerReversePackageCreateInputSchema: JsonSchema = objectSchema(
  {
    caseId: stringSchema({ minLength: 1 }),
    source: objectSchema(
      {
        kind: enumSchema(["record", "candidate"] as const),
        id: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerReversePackageCreateSource",
        required: ["kind", "id"],
      },
    ),
    templateId: stringSchema({ minLength: 1 }),
    key: stringSchema({ minLength: 1 }),
    version: stringSchema({ minLength: 1 }),
    notes: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReversePackageCreateInput",
    required: ["caseId", "source"],
  },
);

export const opensteerReversePackageCreateOutputSchema: JsonSchema = objectSchema(
  {
    package: opensteerReversePackageRecordSchema,
    report: opensteerReverseReportRecordSchema,
  },
  {
    title: "OpensteerReversePackageCreateOutput",
    required: ["package", "report"],
  },
);

export const opensteerReversePackageRunInputSchema: JsonSchema = objectSchema(
  {
    packageId: stringSchema({ minLength: 1 }),
    pageRef: pageRefSchema,
  },
  {
    title: "OpensteerReversePackageRunInput",
    required: ["packageId"],
  },
);

export const opensteerReversePackageRunOutputSchema: JsonSchema = objectSchema(
  {
    packageId: stringSchema({ minLength: 1 }),
    caseId: stringSchema({ minLength: 1 }),
    source: objectSchema(
      {
        kind: enumSchema(["record", "candidate"] as const),
        id: stringSchema({ minLength: 1 }),
      },
      {
        title: "OpensteerReversePackageRunSource",
        required: ["kind", "id"],
      },
    ),
    candidateId: stringSchema({ minLength: 1 }),
    templateId: stringSchema({ minLength: 1 }),
    success: { type: "boolean" },
    kind: opensteerReversePackageKindSchema,
    readiness: opensteerReversePackageReadinessSchema,
    channel: opensteerReverseChannelKindSchema,
    transport: transportKindSchema,
    stateSource: opensteerStateSourceKindSchema,
    recordId: stringSchema({ minLength: 1 }),
    status: integerSchema({ minimum: 0 }),
    validation: opensteerReverseReplayValidationSchema,
    executedStepIds: arraySchema(stringSchema({ minLength: 1 }), { uniqueItems: true }),
    failedStepId: stringSchema({ minLength: 1 }),
    bindings: recordSchema({}, { title: "OpensteerReversePackageRunBindings" }),
    replayRunId: stringSchema({ minLength: 1 }),
    unresolvedRequirements: arraySchema(opensteerReverseRequirementSchema),
    suggestedEdits: arraySchema(opensteerReverseSuggestedEditSchema),
    error: stringSchema({ minLength: 1 }),
  },
  {
    title: "OpensteerReversePackageRunOutput",
    required: [
      "packageId",
      "source",
      "success",
      "kind",
      "readiness",
      "validation",
      "executedStepIds",
      "bindings",
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
    caseId: stringSchema({ minLength: 1 }),
    packageId: stringSchema({ minLength: 1 }),
    reportId: stringSchema({ minLength: 1 }),
    kind: opensteerReverseReportKindSchema,
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
