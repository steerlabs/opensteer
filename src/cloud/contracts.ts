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
    | 'CLOUD_INTERNAL'

export interface CloudSessionCreateRequest {
    name?: string
    model?: string
    launchContext?: Record<string, unknown>
}

export interface CloudSessionCreateResponse {
    sessionId: string
    actionWsUrl: string
    cdpWsUrl: string
    actionToken: string
    cdpToken: string
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
}

export type CloudActionResponse = CloudActionSuccess | CloudActionFailure
