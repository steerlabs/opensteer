import type { ActionFailure } from '../action-failure.js'

export type RemoteActionMethod =
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

export type RemoteErrorCode =
    | 'REMOTE_AUTH_FAILED'
    | 'REMOTE_SESSION_NOT_FOUND'
    | 'REMOTE_SESSION_CLOSED'
    | 'REMOTE_UNSUPPORTED_METHOD'
    | 'REMOTE_INVALID_REQUEST'
    | 'REMOTE_MODEL_NOT_ALLOWED'
    | 'REMOTE_ACTION_FAILED'
    | 'REMOTE_CAPACITY_EXHAUSTED'
    | 'REMOTE_RUNTIME_UNAVAILABLE'
    | 'REMOTE_RUNTIME_MISMATCH'
    | 'REMOTE_SESSION_STALE'
    | 'REMOTE_CONTROL_PLANE_ERROR'
    | 'REMOTE_CONTRACT_MISMATCH'
    | 'REMOTE_INTERNAL'

export const remoteSessionContractVersion = 'v3' as const
export type RemoteSessionContractVersion = typeof remoteSessionContractVersion

export type RemoteSessionSourceType =
    | 'agent-thread'
    | 'agent-run'
    | 'local-cloud'
    | 'manual'

export interface RemoteSessionCreateRequest {
    remoteSessionContractVersion: RemoteSessionContractVersion
    sourceType: 'local-cloud'
    clientSessionHint: string
    localRunId: string
    name?: string
    model?: string
    launchContext?: Record<string, unknown>
}

export interface RemoteCloudSessionSummary {
    sessionId: string
    workspaceId: string
    state: string
    createdAt: number
    sourceType: RemoteSessionSourceType
    sourceRef?: string
    label?: string
}

export interface RemoteSessionCreateResponse {
    sessionId: string
    actionWsUrl: string
    cdpWsUrl: string
    actionToken: string
    cdpToken: string
    expiresAt?: number
    cloudSessionUrl: string
    cloudSession: RemoteCloudSessionSummary
}

export interface RemoteSelectorCacheImportEntry {
    namespace: string
    siteOrigin: string
    method: string
    descriptionHash: string
    path: unknown
    schemaHash?: string
    createdAt: number
    updatedAt: number
}

export interface RemoteSelectorCacheImportRequest {
    entries: RemoteSelectorCacheImportEntry[]
}

export interface RemoteSelectorCacheImportResponse {
    imported: number
    inserted: number
    updated: number
    skipped: number
}

export interface RemoteActionRequest {
    id: number
    method: RemoteActionMethod
    args: Record<string, unknown>
    sessionId: string
    token: string
}

export interface RemoteActionSuccess {
    id: number
    ok: true
    result: unknown
}

export interface RemoteActionFailure {
    id: number
    ok: false
    error: string
    code: RemoteErrorCode
    details?: RemoteActionFailureDetails
}

export type RemoteActionResponse = RemoteActionSuccess | RemoteActionFailure

export interface RemoteActionFailureDetails {
    actionFailure?: ActionFailure
}
