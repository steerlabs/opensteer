import { ActionWsClient } from './action-ws-client.js'
import { RemoteCdpClient } from './cdp-client.js'
import { RemoteSessionClient } from './session-client.js'
import type { OpensteerAuthScheme } from '../types.js'

export interface RemoteRuntimeState {
    readonly sessionClient: RemoteSessionClient
    readonly cdpClient: RemoteCdpClient
    actionClient: ActionWsClient | null
    sessionId: string | null
}

export const DEFAULT_REMOTE_BASE_URL = 'https://remote.opensteer.com'

export function createRemoteRuntimeState(
    key: string,
    baseUrl = resolveRemoteBaseUrl(),
    authScheme: OpensteerAuthScheme = 'api-key'
): RemoteRuntimeState {
    return {
        sessionClient: new RemoteSessionClient(baseUrl, key, authScheme),
        cdpClient: new RemoteCdpClient(),
        actionClient: null,
        sessionId: null,
    }
}

export function resolveRemoteBaseUrl(): string {
    const value = process.env.OPENSTEER_BASE_URL?.trim()
    if (!value) return DEFAULT_REMOTE_BASE_URL
    return value.replace(/\/+$/, '')
}

export function readRemoteActionDescription(
    payload: Record<string, unknown>
): string | undefined {
    const description = payload.description
    if (typeof description !== 'string') return undefined
    const normalized = description.trim()
    return normalized.length ? normalized : undefined
}
