import { ActionWsClient } from './action-ws-client.js'
import { CloudCdpClient } from './cdp-client.js'
import { CloudSessionClient } from './session-client.js'
import type { OpensteerAuthScheme } from '../types.js'

export interface CloudRuntimeState {
    readonly sessionClient: CloudSessionClient
    readonly cdpClient: CloudCdpClient
    readonly appUrl: string | null
    actionClient: ActionWsClient | null
    sessionId: string | null
    localRunId: string | null
    cloudSessionUrl: string | null
}

export const DEFAULT_CLOUD_BASE_URL = 'https://remote.opensteer.com'
export const DEFAULT_CLOUD_APP_URL = 'https://opensteer.com'

export function createCloudRuntimeState(
    key: string,
    baseUrl = resolveCloudBaseUrl(),
    authScheme: OpensteerAuthScheme = 'api-key',
    appUrl = resolveCloudAppUrl()
): CloudRuntimeState {
    return {
        sessionClient: new CloudSessionClient(baseUrl, key, authScheme),
        cdpClient: new CloudCdpClient(),
        appUrl: normalizeCloudAppUrl(appUrl),
        actionClient: null,
        sessionId: null,
        localRunId: null,
        cloudSessionUrl: null,
    }
}

export function resolveCloudBaseUrl(): string {
    const value = process.env.OPENSTEER_BASE_URL?.trim()
    if (!value) return DEFAULT_CLOUD_BASE_URL
    return value.replace(/\/+$/, '')
}

export function resolveCloudAppUrl(): string | null {
    const value = process.env.OPENSTEER_APP_URL?.trim()
    if (!value) return DEFAULT_CLOUD_APP_URL
    return normalizeCloudAppUrl(value)
}

function normalizeCloudAppUrl(value: string | null): string | null {
    if (!value) return null
    return value.replace(/\/+$/, '')
}

export function readCloudActionDescription(
    payload: Record<string, unknown>
): string | undefined {
    const description = payload.description
    if (typeof description !== 'string') return undefined
    const normalized = description.trim()
    return normalized.length ? normalized : undefined
}
