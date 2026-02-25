import { ActionWsClient } from './action-ws-client.js'
import { RemoteCdpClient } from './cdp-client.js'
import { RemoteSessionClient } from './session-client.js'
import type { OpensteerAuthScheme } from '../types.js'

export interface RemoteRuntimeState {
    readonly sessionClient: RemoteSessionClient
    readonly cdpClient: RemoteCdpClient
    readonly appUrl: string | null
    actionClient: ActionWsClient | null
    sessionId: string | null
    localRunId: string | null
    cloudSessionUrl: string | null
}

export const DEFAULT_REMOTE_BASE_URL = 'https://remote.opensteer.com'
export const DEFAULT_REMOTE_APP_URL = 'https://opensteer.com'

export function createRemoteRuntimeState(
    key: string,
    baseUrl = resolveRemoteBaseUrl(),
    authScheme: OpensteerAuthScheme = 'api-key',
    appUrl = resolveRemoteAppUrl()
): RemoteRuntimeState {
    return {
        sessionClient: new RemoteSessionClient(baseUrl, key, authScheme),
        cdpClient: new RemoteCdpClient(),
        appUrl: normalizeRemoteAppUrl(appUrl),
        actionClient: null,
        sessionId: null,
        localRunId: null,
        cloudSessionUrl: null,
    }
}

export function resolveRemoteBaseUrl(): string {
    const value = process.env.OPENSTEER_BASE_URL?.trim()
    if (!value) return DEFAULT_REMOTE_BASE_URL
    return value.replace(/\/+$/, '')
}

export function resolveRemoteAppUrl(): string | null {
    const value = process.env.OPENSTEER_APP_URL?.trim()
    if (!value) return DEFAULT_REMOTE_APP_URL
    return normalizeRemoteAppUrl(value)
}

function normalizeRemoteAppUrl(value: string | null): string | null {
    if (!value) return null
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
