import { ActionWsClient } from './action-ws-client.js'
import { CloudCdpClient } from './cdp-client.js'
import { CloudSessionClient } from './session-client.js'
import type { OpensteerAuthScheme } from '../types.js'
import { normalizeCloudBaseUrl } from './http-client.js'

export interface CloudRuntimeState {
    readonly sessionClient: CloudSessionClient
    readonly cdpClient: CloudCdpClient
    readonly baseUrl: string
    actionClient: ActionWsClient | null
    sessionId: string | null
    localRunId: string | null
    cloudSessionUrl: string | null
}

export const DEFAULT_CLOUD_BASE_URL = 'https://api.opensteer.com'

export function createCloudRuntimeState(
    key: string,
    baseUrl = resolveCloudBaseUrl(),
    authScheme: OpensteerAuthScheme = 'api-key'
): CloudRuntimeState {
    const normalizedBaseUrl = normalizeCloudBaseUrl(baseUrl)
    return {
        sessionClient: new CloudSessionClient(
            normalizedBaseUrl,
            key,
            authScheme
        ),
        cdpClient: new CloudCdpClient(),
        baseUrl: normalizedBaseUrl,
        actionClient: null,
        sessionId: null,
        localRunId: null,
        cloudSessionUrl: null,
    }
}

export function resolveCloudBaseUrl(): string {
    const value = process.env.OPENSTEER_BASE_URL?.trim()
    if (!value) return DEFAULT_CLOUD_BASE_URL
    return normalizeCloudBaseUrl(value)
}

export function readCloudActionDescription(
    payload: Record<string, unknown>
): string | undefined {
    const description = payload.description
    if (typeof description !== 'string') return undefined
    const normalized = description.trim()
    return normalized.length ? normalized : undefined
}
