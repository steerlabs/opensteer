import type { ActionFailure } from '../action-failure.js'

export type CloudActionMethod =
    | 'goto'
    | 'snapshot'
    | 'state'
    | 'click'
    | 'dblclick'
    | 'rightclick'
    | 'hover'
    | 'input'
    | 'select'
    | 'scroll'
    | 'tabs'
    | 'newTab'
    | 'switchTab'
    | 'closeTab'
    | 'getCookies'
    | 'setCookie'
    | 'clearCookies'
    | 'pressKey'
    | 'type'
    | 'getElementText'
    | 'getElementValue'
    | 'getElementAttributes'
    | 'getElementBoundingBox'
    | 'getHtml'
    | 'getTitle'
    | 'waitForText'
    | 'extract'
    | 'extractFromPlan'
    | 'clearCache'
    | 'uploadFile'
    | 'exportCookies'
    | 'importCookies'
    | 'screenshot'

export type CloudErrorCode =
    | 'CLOUD_AUTH_FAILED'
    | 'CLOUD_SESSION_NOT_FOUND'
    | 'CLOUD_SESSION_CLOSED'
    | 'CLOUD_UNSUPPORTED_METHOD'
    | 'CLOUD_INVALID_REQUEST'
    | 'CLOUD_MODEL_NOT_ALLOWED'
    | 'CLOUD_ACTION_FAILED'
    | 'CLOUD_CAPACITY_EXHAUSTED'
    | 'CLOUD_RUNTIME_UNAVAILABLE'
    | 'CLOUD_RUNTIME_MISMATCH'
    | 'CLOUD_SESSION_STALE'
    | 'CLOUD_CONTROL_PLANE_ERROR'
    | 'CLOUD_CONTRACT_MISMATCH'
    | 'CLOUD_PROXY_UNAVAILABLE'
    | 'CLOUD_PROXY_REQUIRED'
    | 'CLOUD_BILLING_LIMIT_REACHED'
    | 'CLOUD_RATE_LIMITED'
    | 'CLOUD_BROWSER_PROFILE_NOT_FOUND'
    | 'CLOUD_BROWSER_PROFILE_BUSY'
    | 'CLOUD_BROWSER_PROFILE_DISABLED'
    | 'CLOUD_BROWSER_PROFILE_PROXY_UNAVAILABLE'
    | 'CLOUD_BROWSER_PROFILE_SYNC_FAILED'
    | 'CLOUD_INTERNAL'

export const cloudSessionContractVersion = 'v3' as const
export type CloudSessionContractVersion = typeof cloudSessionContractVersion

export type CloudSessionSourceType =
    | 'agent-thread'
    | 'agent-run'
    | 'local-cloud'
    | 'manual'

export interface CloudBrowserProfileLaunchPreference {
    profileId: string
    reuseIfActive?: boolean
}

export interface CloudSessionLaunchConfig {
    browserProfile?: CloudBrowserProfileLaunchPreference
}

export interface CloudSessionCreateRequest {
    cloudSessionContractVersion: CloudSessionContractVersion
    sourceType: 'local-cloud'
    clientSessionHint: string
    localRunId: string
    name?: string
    model?: string
    launchContext?: Record<string, unknown>
    launchConfig?: CloudSessionLaunchConfig
}

export interface CloudSessionSummary {
    sessionId: string
    workspaceId: string
    state: string
    createdAt: number
    sourceType: CloudSessionSourceType
    sourceRef?: string
    label?: string
}

export interface CloudSessionCreateResponse {
    sessionId: string
    actionWsUrl: string
    cdpWsUrl: string
    actionToken: string
    cdpToken: string
    expiresAt?: number
    cloudSessionUrl: string
    cloudSession: CloudSessionSummary
}

export interface CloudSelectorCacheImportEntry {
    namespace: string
    siteOrigin: string
    method: string
    descriptionHash: string
    path: unknown
    schemaHash?: string
    createdAt: number
    updatedAt: number
}

export interface CloudSelectorCacheImportRequest {
    entries: CloudSelectorCacheImportEntry[]
}

export interface CloudSelectorCacheImportResponse {
    imported: number
    inserted: number
    updated: number
    skipped: number
}

export interface CloudActionRequest {
    id: number
    method: CloudActionMethod
    args: Record<string, unknown>
    sessionId: string
    token: string
}

export interface CloudActionSuccess {
    id: number
    ok: true
    result: unknown
}

export interface CloudActionFailure {
    id: number
    ok: false
    error: string
    code: CloudErrorCode
    details?: CloudActionFailureDetails
}

export type CloudActionResponse = CloudActionSuccess | CloudActionFailure

export interface CloudActionFailureDetails {
    actionFailure?: ActionFailure
}

export type BrowserProfileStatus = 'active' | 'archived' | 'error'
export type BrowserProfileProxyPolicy = 'strict_sticky'
export type CloudFingerprintMode = 'off' | 'auto'

export interface BrowserProfileDescriptor {
    profileId: string
    teamId: string
    ownerUserId: string
    name: string
    status: BrowserProfileStatus
    proxyPolicy: BrowserProfileProxyPolicy
    stickyProxyId?: string
    proxyCountryCode?: string
    proxyRegion?: string
    proxyCity?: string
    fingerprintMode: CloudFingerprintMode
    fingerprintHash?: string
    activeSessionId?: string
    lastSessionId?: string
    lastLaunchedAt?: number
    latestRevision?: number
    latestObjectKey?: string
    latestSizeBytes?: number
    latestArchiveSha256?: string
    latestArchiveFormat?: string
    createdAt: number
    updatedAt: number
    lastError?: string
}

export interface BrowserProfileListResponse {
    profiles: BrowserProfileDescriptor[]
    nextCursor?: string
}

export interface BrowserProfileCreateRequest {
    name: string
    proxy?: {
        proxyId?: string
        countryCode?: string
        region?: string
        city?: string
    }
    fingerprint?: {
        mode?: CloudFingerprintMode
    }
}
