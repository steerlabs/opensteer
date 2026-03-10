import type { ActionFailure } from '../action-failure.js'

export const cloudActionMethods = [
    'goto',
    'snapshot',
    'screenshot',
    'state',
    'click',
    'dblclick',
    'rightclick',
    'hover',
    'input',
    'select',
    'scroll',
    'tabs',
    'newTab',
    'switchTab',
    'closeTab',
    'getCookies',
    'setCookie',
    'clearCookies',
    'pressKey',
    'type',
    'getElementText',
    'getElementValue',
    'getElementAttributes',
    'getElementBoundingBox',
    'getHtml',
    'getTitle',
    'uploadFile',
    'exportCookies',
    'importCookies',
    'waitForText',
    'extract',
    'extractFromPlan',
    'clearCache',
] as const

export type CloudActionMethod = (typeof cloudActionMethods)[number]

export const cloudErrorCodes = [
    'CLOUD_AUTH_FAILED',
    'CLOUD_SESSION_NOT_FOUND',
    'CLOUD_SESSION_CLOSED',
    'CLOUD_UNSUPPORTED_METHOD',
    'CLOUD_INVALID_REQUEST',
    'CLOUD_MODEL_NOT_ALLOWED',
    'CLOUD_ACTION_FAILED',
    'CLOUD_CAPACITY_EXHAUSTED',
    'CLOUD_RUNTIME_UNAVAILABLE',
    'CLOUD_RUNTIME_MISMATCH',
    'CLOUD_SESSION_STALE',
    'CLOUD_CONTROL_PLANE_ERROR',
    'CLOUD_CONTRACT_MISMATCH',
    'CLOUD_PROXY_UNAVAILABLE',
    'CLOUD_PROXY_REQUIRED',
    'CLOUD_BILLING_LIMIT_REACHED',
    'CLOUD_RATE_LIMITED',
    'CLOUD_BROWSER_PROFILE_NOT_FOUND',
    'CLOUD_BROWSER_PROFILE_BUSY',
    'CLOUD_BROWSER_PROFILE_DISABLED',
    'CLOUD_BROWSER_PROFILE_PROXY_UNAVAILABLE',
    'CLOUD_BROWSER_PROFILE_SYNC_FAILED',
    'CLOUD_INTERNAL',
] as const

export type CloudErrorCode = (typeof cloudErrorCodes)[number]

export const cloudSessionStatuses = [
    'provisioning',
    'active',
    'closing',
    'closed',
    'failed',
] as const

export type CloudSessionStatus = (typeof cloudSessionStatuses)[number]

export const cloudSessionContractVersion = 'v3' as const
export type CloudSessionContractVersion = typeof cloudSessionContractVersion

export const cloudSessionSourceTypes = [
    'agent-thread',
    'agent-run',
    'project-agent-run',
    'local-cloud',
    'manual',
] as const

export type CloudSessionSourceType = (typeof cloudSessionSourceTypes)[number]

export type CloudSessionVisibilityScope = 'team' | 'owner'
export type CloudProxyMode = 'disabled' | 'optional' | 'required'
export type CloudProxyProtocol = 'http' | 'https' | 'socks5'
export type CloudFingerprintMode = 'off' | 'auto'
export type BrowserProfileStatus = 'active' | 'archived' | 'error'
export type BrowserProfileProxyPolicy = 'strict_sticky'
export type BrowserProfileArchiveFormat = 'tar.gz'

export interface CloudViewport {
    width: number
    height: number
}

export interface CloudGeolocation {
    latitude: number
    longitude: number
    accuracy?: number
}

export interface CloudBrowserContextConfig {
    viewport?: CloudViewport
    locale?: string
    timezoneId?: string
    geolocation?: CloudGeolocation
    colorScheme?: 'light' | 'dark' | 'no-preference'
    userAgent?: string
    javaScriptEnabled?: boolean
    ignoreHTTPSErrors?: boolean
}

export interface CloudBrowserExtensionConfig {
    includeDefaults?: boolean
    extensionKeys?: string[]
}

export interface CloudBrowserLaunchConfig {
    headless?: boolean
    context?: CloudBrowserContextConfig
    chromeArgs?: string[]
    extensions?: CloudBrowserExtensionConfig
}

export interface CloudProxyPreference {
    mode?: CloudProxyMode
    countryCode?: string
    region?: string
    city?: string
    proxyId?: string
}

export interface CloudFingerprintPreference {
    mode?: CloudFingerprintMode
    locales?: string[]
    minWidth?: number
    maxWidth?: number
    minHeight?: number
    maxHeight?: number
    slim?: boolean
}

export interface CloudBrowserProfileLaunchPreference {
    profileId: string
    reuseIfActive?: boolean
}

export interface CloudSessionLaunchConfig {
    browser?: CloudBrowserLaunchConfig
    proxy?: CloudProxyPreference
    fingerprint?: CloudFingerprintPreference
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
    state: CloudSessionStatus
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
    latestStorageId?: string
    latestSizeBytes?: number
    latestArchiveSha256?: string
    latestArchiveFormat?: BrowserProfileArchiveFormat
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

const cloudActionMethodSet = new Set<CloudActionMethod>(cloudActionMethods)
const cloudErrorCodeSet = new Set<CloudErrorCode>(cloudErrorCodes)
const cloudSessionSourceTypeSet = new Set<CloudSessionSourceType>(
    cloudSessionSourceTypes
)
const cloudSessionStatusSet = new Set<CloudSessionStatus>(cloudSessionStatuses)

export function isCloudActionMethod(value: unknown): value is CloudActionMethod {
    return (
        typeof value === 'string' &&
        cloudActionMethodSet.has(value as CloudActionMethod)
    )
}

export function isCloudErrorCode(value: unknown): value is CloudErrorCode {
    return (
        typeof value === 'string' &&
        cloudErrorCodeSet.has(value as CloudErrorCode)
    )
}

export function isCloudSessionSourceType(
    value: unknown
): value is CloudSessionSourceType {
    return (
        typeof value === 'string' &&
        cloudSessionSourceTypeSet.has(value as CloudSessionSourceType)
    )
}

export function isCloudSessionStatus(value: unknown): value is CloudSessionStatus {
    return (
        typeof value === 'string' &&
        cloudSessionStatusSet.has(value as CloudSessionStatus)
    )
}
