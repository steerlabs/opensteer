export type ApiSpanKind = 'automatic' | 'manual'
export type ApiPlanValidationMode = 'execute' | 'dry-run'
export type ApiRenderFormat = 'ir' | 'exec' | 'curl-trace'
export type ApiCodegenLanguage = 'ts' | 'py'
export type ApiPlanStatus =
    | 'draft'
    | 'validated'
    | 'healthy'
    | 'needs_session_refresh'
    | 'stale'
    | 'archived'
export type ApiPlanLifecycle = 'draft' | 'validated' | 'stale' | 'archived'
export type ApiPlanSchemaVersion = 'deterministic-plan.v1' | 'deterministic-plan.v2'
export type ApiPlanExecutionMode =
    | 'direct_http'
    | 'browser_session'
    | 'browser_dom'
export type ApiRuntimeCapability =
    | 'http'
    | 'browser_fetch'
    | 'browser_page'
export type ApiPlanRuntimeMode = 'required' | 'http_only'
export type ApiStepTransport =
    | 'node_http'
    | 'browser_fetch'
    | 'browser_page'
export type ApiRequestMatchType =
    | 'exact'
    | 'url_decoded'
    | 'base64_decoded'
    | 'base64_encoded'
    | 'string_coercion'
    | 'concat_contains'
    | 'prefix_suffix'
export type ApiValueKind =
    | 'auth'
    | 'cookie'
    | 'csrf'
    | 'opaque'
    | 'identifier'
    | 'text'
    | 'number'
    | 'boolean'
    | 'unknown'
export type ApiSlotSource = 'path' | 'query' | 'body' | 'header' | 'cookie'
export type ApiSlotRole =
    | 'user_input'
    | 'derived'
    | 'constant'
    | 'session'
    | 'unknown'
export type ApiEvidenceKind =
    | 'action_argument'
    | 'action_choice'
    | 'action_target'
    | 'dom_field'
    | 'hidden_input'
    | 'inline_json'
    | 'response_value'
    | 'response_header'
    | 'request_value'
    | 'request_header'
    | 'cookie'
    | 'storage'
    | 'storage_event'
    | 'signature_constant'
    | 'probe_changed'
    | 'probe_constant'
    | 'default_inference'
    | 'upstream_slot'
export type ApiBodyFormat = 'json' | 'form' | 'text'
export type ApiBindingTransformKind = 'trim' | 'lowercase' | 'url_decode'
export type ApiValidationFailureKind =
    | 'session_missing'
    | 'session_expired'
    | 'auth_redirect'
    | 'schema_drift'
    | 'runtime_unavailable'
    | 'oracle_failed'
    | 'unsupported_plan'
export type ApiOracleCheckKind =
    | 'status'
    | 'mime'
    | 'json_path'
    | 'text_contains'
    | 'text_not_contains'
    | 'redirect_absent'
    | 'redirect_contains'
    | 'download'

export interface ApiGraphqlMetadata {
    operationName: string | null
    persistedQueryHash: string | null
}

export interface ApiRequestBodyRecord {
    raw: string | null
    truncated: boolean
    size: number
    contentType: string | null
    parsedJson?: unknown
    parsedForm?: Record<string, string | string[]>
    format?: ApiBodyFormat
}

export interface ApiResponseBodyRecord {
    raw: string | null
    truncated: boolean
    size: number
    contentType: string | null
    parsedJson?: unknown
    parsedForm?: Record<string, string | string[]>
    base64Encoded?: boolean
    format?: ApiBodyFormat
}

export interface ApiStorageSnapshot {
    origin: string | null
    localStorage: Record<string, string>
    sessionStorage: Record<string, string>
}

export interface ApiPageSnapshotSummary {
    url: string
    title: string
    domHash: string
    domLength: number
    cookies: Record<string, string>
    storage: ApiStorageSnapshot
}

export interface ApiDomFieldFact {
    tagName: string
    type: string | null
    name: string | null
    id: string | null
    formName: string | null
    formId: string | null
    formAction: string | null
    formMethod: string | null
    placeholder: string | null
    ariaLabel: string | null
    title: string | null
    value: string | null
    hidden: boolean
    checked: boolean | null
}

export interface ApiInlineValueFact {
    path: string
    value: string
    source: string
}

export interface ApiDomSnapshotFact {
    url: string
    fields: ApiDomFieldFact[]
    inlineValues: ApiInlineValueFact[]
}

export interface ApiActionTargetFact {
    description: string | null
    selector: string | null
    element: number | null
    beforeValue: string | null
    afterValue: string | null
    beforeText: string | null
    afterText: string | null
    attributes: Record<string, string>
}

export interface ApiActionFact {
    ref: string
    spanRef: string
    command: string
    startedAt: number
    completedAt: number | null
    args: Record<string, unknown>
    target: ApiActionTargetFact | null
    beforeDom: ApiDomSnapshotFact | null
    afterDom: ApiDomSnapshotFact | null
    error: string | null
}

export interface ApiStorageEvent {
    ref: string
    at: number
    kind: 'added' | 'updated' | 'removed' | 'cleared'
    storageType: 'local' | 'session'
    origin: string | null
    key: string | null
    value: string | null
}

export interface ApiValueLocation {
    requestRef?: string
    responseRef?: string
    spanRef?: string
    actionRef?: string
    source:
        | 'request.url'
        | 'request.path'
        | 'request.query'
        | 'request.header'
        | 'request.cookie'
        | 'request.body'
        | 'response.header'
        | 'response.body'
        | 'storage.local'
        | 'storage.session'
        | 'cookie.jar'
        | 'inline.html'
        | 'action.arg'
        | 'dom.field'
    path?: string
}

export interface ApiValueRecord {
    ref: string
    raw: string
    kind: ApiValueKind
    shape: string
    firstSeenAt: number
    location: ApiValueLocation
    producerRef?: string
    redactionReason: string
}

export interface ApiRequestRecord {
    ref: string
    requestId: string
    startedAt: number
    finishedAt: number | null
    method: string
    url: string
    urlTemplate: string
    resourceType: string | null
    status: number | null
    ok: boolean | null
    failed: boolean
    failureText: string | null
    requestHeaders: Record<string, string>
    responseHeaders: Record<string, string>
    requestExtraHeaders: Record<string, string>
    responseExtraHeaders: Record<string, string>
    requestBody: ApiRequestBodyRecord | null
    responseBody: ApiResponseBodyRecord | null
    responseMime: string | null
    responseSize: number | null
    hasUserGesture: boolean
    initiatorType: string | null
    initiatorUrl: string | null
    initiatorRequestRef: string | null
    redirectFromRef: string | null
    fromServiceWorker: boolean | null
    graphql: ApiGraphqlMetadata
    signature: string
    spanRef: string | null
    matchedDownloadRef: string | null
    matchedNavigation: boolean
    associatedCookies: string[]
    blockedCookies: string[]
}

export interface ApiDownloadRecord {
    ref: string
    url: string
    suggestedFilename: string | null
    createdAt: number
}

export interface ApiActionSpan {
    ref: string
    label: string
    kind: ApiSpanKind
    command: string | null
    startedAt: number
    endedAt: number | null
    before: ApiPageSnapshotSummary | null
    after: ApiPageSnapshotSummary | null
    requestRefs: string[]
    downloadRefs: string[]
    actionFactRefs: string[]
    effects: string[]
}

export interface ApiCandidateReason {
    label: string
    score: number
}

export interface ApiCandidateRow {
    ref: string
    method: string
    urlTemplate: string
    status: number | null
    resourceType: string | null
    mime: string | null
    spanRef: string | null
    candidateScore: number
    effects: string[]
    initiatorRef: string | null
    slotCount: number
    actionFactRefs: string[]
    redactionSummary: {
        requestValues: string[]
        responseValues: string[]
    }
    reasons: ApiCandidateReason[]
}

export interface ApiRequestSlot {
    ref: string
    requestRef: string
    name: string
    slotPath: string
    source: ApiSlotSource
    rawValue: string
    shape: string
    role: ApiSlotRole
    confidence: number
    required: boolean
    evidenceRefs: string[]
}

export interface ApiSlotEvidence {
    ref: string
    slotRef: string
    requestRef: string
    role: ApiSlotRole
    kind: ApiEvidenceKind
    score: number
    sourceRef: string | null
    sourceLabel: string
    sourceLocation: string | null
    observedValue: string
    transformChain: string[]
    rationale: string
}

export interface ApiValueTraceCandidate {
    ref: string
    role: ApiSlotRole
    kind: ApiEvidenceKind
    sourceRef: string | null
    location: string | null
    matchType: ApiRequestMatchType
    transformChain: string[]
    confidence: number
    whyNotOthers: string
}

export interface ApiPlanInput {
    ref: string
    name: string
    slotRef: string
    slotPath: string
    role: ApiSlotRole
    required: boolean
    defaultValue: string | null
    evidenceRefs: string[]
    sourceLocation?: string
}

export interface ApiPlanRequestTemplate {
    url: string
    headers: Record<string, string>
    bodyFormat: ApiBodyFormat
    bodyJson?: unknown
    bodyForm?: Record<string, string | string[]>
    bodyRaw?: string | null
}

export interface ApiBindingTransform {
    kind: ApiBindingTransformKind
}

export interface ApiBindingResolverBase {
    transforms?: ApiBindingTransform[]
}

export type ApiBindingResolver =
    | ({
          kind: 'input'
          inputName: string
      } & ApiBindingResolverBase)
    | ({
          kind: 'constant'
          value: string
      } & ApiBindingResolverBase)
    | ({
          kind: 'response_json'
          producerStepId: string
          producerRef: string
          responsePath: string
      } & ApiBindingResolverBase)
    | ({
          kind: 'response_header'
          producerStepId: string
          producerRef: string
          headerName: string
      } & ApiBindingResolverBase)
    | ({
          kind: 'cookie_live'
          cookieName: string
      } & ApiBindingResolverBase)
    | ({
          kind: 'cookie_captured'
          cookieName: string
          capturedValue: string
      } & ApiBindingResolverBase)
    | ({
          kind: 'storage_live'
          storageType: 'local' | 'session'
          key: string
      } & ApiBindingResolverBase)
    | ({
          kind: 'dom_field'
          fieldName: string | null
          fieldId: string | null
          fieldType: string | null
          hidden: boolean
      } & ApiBindingResolverBase)
    | ({
          kind: 'script_json'
          source: string
          dataPath: string
      } & ApiBindingResolverBase)
    | ({
          kind: 'computed'
          source:
              | Exclude<ApiBindingResolver, { kind: 'computed' }>
              | {
                    kind: 'input'
                    inputName: string
                }
          transforms: ApiBindingTransform[]
      })
    | ({
          kind: 'unsupported'
          reason: string
      } & ApiBindingResolverBase)

export interface ApiExecutionBindingBase {
    slotRef: string
    stepId: string
    resolver?: ApiBindingResolver
    resolverCandidates?: ApiBindingResolver[]
    transforms?: ApiBindingTransform[]
}

export type ApiExecutionBinding =
    | (ApiExecutionBindingBase & {
          kind: 'caller'
          inputName: string
      })
    | (ApiExecutionBindingBase & {
          kind: 'constant'
          value: string
      })
    | (ApiExecutionBindingBase & {
          kind: 'derived_response'
          producerStepId: string
          producerRef: string
          responsePath: string
      })
    | (ApiExecutionBindingBase & {
          kind: 'derived_response_header'
          producerStepId: string
          producerRef: string
          headerName: string
      })
    | (ApiExecutionBindingBase & {
          kind: 'ambient_cookie'
          cookieName: string
      })
    | (ApiExecutionBindingBase & {
          kind: 'session_cookie'
          cookieName: string
      })
    | (ApiExecutionBindingBase & {
          kind: 'session_storage'
          storageType: 'local' | 'session'
          key: string
      })
    | (ApiExecutionBindingBase & {
          kind: 'dom_field'
          fieldName: string | null
          fieldId: string | null
          fieldType: string | null
          hidden: boolean
      })
    | (ApiExecutionBindingBase & {
          kind: 'inline_json'
          source: string
          dataPath: string
      })
    | (ApiExecutionBindingBase & {
          kind: 'unknown'
          reason: string
      })

export interface ApiPlanStep {
    id: string
    requestRef: string
    method: string
    urlTemplate: string
    requestTemplate?: ApiPlanRequestTemplate
    httpExecutable: boolean
    prerequisiteStepIds: string[]
    slotRefs: string[]
    transport?: ApiStepTransport
    sessionRequirementRefs?: string[]
}

export interface ApiSuccessOracleJsonPathCheck {
    path: string
    exists?: boolean
    equals?: string
}

export interface ApiSuccessOracleDownloadCheck {
    expectedFilename?: string | null
}

export interface ApiPlanSuccessOracle {
    status: number | null
    mime: string | null
    expectsDownload: boolean
    jsonPathChecks?: ApiSuccessOracleJsonPathCheck[]
    textMustContain?: string[]
    textMustNotContain?: string[]
    redirectContains?: string[]
    requireNoAuthRedirect?: boolean
    download?: ApiSuccessOracleDownloadCheck | null
}

export type ApiPlanSessionRequirement =
    | {
          ref: string
          kind: 'cookie_live'
          label: string
          cookieName: string
          required: boolean
      }
    | {
          ref: string
          kind: 'storage_live'
          label: string
          storageType: 'local' | 'session'
          key: string
          required: boolean
      }
    | {
          ref: string
          kind: 'dom_field'
          label: string
          fieldName: string | null
          fieldId: string | null
          fieldType: string | null
          hidden: boolean
          required: boolean
      }
    | {
          ref: string
          kind: 'script_json'
          label: string
          source: string
          dataPath: string
          required: boolean
      }

export interface ApiPlanRuntimeProfile {
    capability: ApiRuntimeCapability
    requirements: ApiPlanSessionRequirement[]
    browserlessReplayable: boolean
}

export interface ApiPlanIr {
    ref: string
    operation: string
    task: string
    createdAt: number
    schemaVersion?: ApiPlanSchemaVersion
    version?: number
    status?: ApiPlanStatus
    lifecycle?: ApiPlanLifecycle
    fingerprint?: string
    targetRequestRef: string
    targetStepId: string
    confidence: number
    transport: 'http'
    executionMode: ApiPlanExecutionMode
    runtimeProfile?: ApiPlanRuntimeProfile
    callerInputs: ApiPlanInput[]
    steps: ApiPlanStep[]
    slots: ApiRequestSlot[]
    bindings: ApiExecutionBinding[]
    sessionRequirements: string[]
    sessionRequirementDetails?: ApiPlanSessionRequirement[]
    ambiguousSlotRefs: string[]
    successOracle: ApiPlanSuccessOracle
    sourceRunRef?: string | null
    sourceRunId?: string | null
    targetOrigin?: string | null
}

export interface ApiProbeSlotComparison {
    slotPath: string
    values: string[]
    changed: boolean
}

export interface ApiProbeVariantResult {
    label: string
    requestRef: string | null
    matchedSignature: string | null
    slots: ApiProbeSlotComparison[]
}

export interface ApiProbeRun {
    ref: string
    spanRef: string
    createdAt: number
    mode: 'read_only'
    values: string[]
    variants: ApiProbeVariantResult[]
}

export interface ApiValidationStepResult {
    stepId: string
    requestRef: string
    ok: boolean
    status: number | null
    mime: string | null
    url: string | null
    error: string | null
}

export interface ApiValidationReport {
    ref: string
    planRef: string
    createdAt: number
    mode: ApiPlanValidationMode
    inputs: Record<string, string>
    steps: ApiValidationStepResult[]
    oracle: {
        statusMatches: boolean
        mimeMatches: boolean
    }
    notes: string[]
    failureKind?: ApiValidationFailureKind | null
}

export interface ApiRuntimeStatus {
    active: boolean
    runRef: string | null
    runDir: string | null
    requestCount: number
    spanCount: number
    actionFactCount: number
    planCount: number
    validationCount: number
    probeCount: number
    activeManualSpanRef: string | null
}

export interface ApiPlanAttemptMeta {
    at: number
    ok: boolean
    failureKind: ApiValidationFailureKind | null
    runtimeMode: ApiPlanRuntimeMode
    capability: ApiRuntimeCapability
}

export interface ApiPlanMeta {
    operation: string
    version: number
    schemaVersion: ApiPlanSchemaVersion
    lifecycle: ApiPlanLifecycle
    fingerprint: string
    createdAt: number
    updatedAt: number
    createdFromRunRef: string | null
    createdFromRunId: string | null
    targetOrigin: string | null
    lastValidation: ApiPlanAttemptMeta | null
    lastExecution: ApiPlanAttemptMeta | null
}

export interface ApiPlanFixture {
    name: string
    createdAt: number
    inputs: Record<string, string>
}

export interface ApiExecutionStepReport {
    stepId: string
    requestRef: string
    transport: ApiStepTransport
    ok: boolean
    status: number | null
    mime: string | null
    url: string | null
    error: string | null
}

export interface ApiOracleCheckResult {
    kind: ApiOracleCheckKind
    ok: boolean
    detail: string
}

export interface ApiPlanExecutionReport {
    planRef: string
    operation: string
    version: number
    executedAt: number
    inputs: Record<string, string>
    ok: boolean
    failureKind: ApiValidationFailureKind | null
    steps: ApiExecutionStepReport[]
    oracleChecks: ApiOracleCheckResult[]
}

export interface ApiPlanSummary {
    operation: string
    version: number
    lifecycle: ApiPlanLifecycle
    dir: string
    ref: string
    fingerprint: string
    updatedAt: number
}
