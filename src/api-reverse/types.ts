export type ApiSpanKind = 'automatic' | 'manual'
export type ApiPlanFallbackMode =
    | 'http_only'
    | 'browser_assisted'
    | 'browser_fallback_required'
export type ApiPlanValidationMode = 'execute' | 'dry-run'
export type ApiExportFormat = 'ir' | 'openapi' | 'curl'
export type ApiCodegenLanguage = 'ts' | 'py'
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
}

export interface ApiResponseBodyRecord {
    raw: string | null
    truncated: boolean
    size: number
    contentType: string | null
    parsedJson?: unknown
    base64Encoded?: boolean
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

export interface ApiValueLocation {
    requestRef?: string
    responseRef?: string
    spanRef?: string
    source:
        | 'request.url'
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
    redactionSummary: {
        requestValues: string[]
        responseValues: string[]
    }
    reasons: ApiCandidateReason[]
}

export interface ApiValueTraceCandidate {
    producerRef: string
    location: string
    matchType: ApiRequestMatchType
    transformChain: string[]
    confidence: number
    whyNotOthers: string
}

export interface ApiPlanInput {
    name: string
    slotPath: string
    valueRef: string | null
    source:
        | 'request'
        | 'response'
        | 'cookie'
        | 'storage'
        | 'user_input'
        | 'unresolved'
    producerRef?: string
    sourceLocation?: string
    transformChain: string[]
}

export interface ApiPlanStep {
    id: string
    requestRef: string
    method: string
    urlTemplate: string
    extracts: string[]
    httpExecutable: boolean
}

export interface ApiPlanSuccessOracle {
    status: number | null
    mime: string | null
    expectsDownload: boolean
}

export interface ApiPlanIr {
    ref: string
    operation: string
    task: string
    createdAt: number
    targetRequestRef: string
    confidence: number
    transport: 'http'
    fallbackMode: ApiPlanFallbackMode
    inputs: ApiPlanInput[]
    steps: ApiPlanStep[]
    extracts: string[]
    successOracle: ApiPlanSuccessOracle
    unresolvedSlots: string[]
}

export interface ApiValidationStepResult {
    stepId: string
    requestRef: string
    ok: boolean
    status: number | null
    mime: string | null
    error: string | null
}

export interface ApiValidationReport {
    ref: string
    planRef: string
    createdAt: number
    mode: ApiPlanValidationMode
    steps: ApiValidationStepResult[]
    oracle: {
        statusMatches: boolean
        mimeMatches: boolean
    }
    notes: string[]
}

export interface ApiRuntimeStatus {
    active: boolean
    runRef: string | null
    runDir: string | null
    requestCount: number
    spanCount: number
    planCount: number
    validationCount: number
    activeManualSpanRef: string | null
}
