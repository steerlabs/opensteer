import { ActionWsClient } from './action-ws-client.js'
import { CloudCdpClient } from './cdp-client.js'
import { CloudSessionClient } from './session-client.js'

export interface CloudRuntimeState {
    readonly sessionClient: CloudSessionClient
    readonly cdpClient: CloudCdpClient
    actionClient: ActionWsClient | null
    sessionId: string | null
}

export const DEFAULT_CLOUD_BASE_URL = 'https://cloud.opensteer.com'

export function createCloudRuntimeState(
    key: string,
    baseUrl = resolveCloudBaseUrl()
): CloudRuntimeState {
    return {
        sessionClient: new CloudSessionClient(baseUrl, key),
        cdpClient: new CloudCdpClient(),
        actionClient: null,
        sessionId: null,
    }
}

export function resolveCloudBaseUrl(): string {
    const value = process.env.OPENSTEER_CLOUD_BASE_URL?.trim()
    if (!value) return DEFAULT_CLOUD_BASE_URL
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
