import type { OpensteerAuthScheme } from '../types.js'
import type { CloudErrorCode } from './contracts.js'
import { OpensteerCloudError } from './errors.js'
import { stripTrailingSlashes } from '../utils/strip-trailing-slashes.js'

interface CloudHttpErrorBody {
    error?: string
    code?: string
    details?: Record<string, unknown>
}

export function normalizeCloudBaseUrl(baseUrl: string): string {
    return stripTrailingSlashes(baseUrl)
}

export function cloudAuthHeaders(
    key: string,
    authScheme: OpensteerAuthScheme
): Record<string, string> {
    if (authScheme === 'bearer') {
        return {
            authorization: `Bearer ${key}`,
        }
    }

    return {
        'x-api-key': key,
    }
}

export async function parseCloudHttpError(
    response: Response
): Promise<OpensteerCloudError> {
    let body: CloudHttpErrorBody | null = null

    try {
        body = (await response.json()) as CloudHttpErrorBody
    } catch {
        body = null
    }

    const code =
        typeof body?.code === 'string'
            ? toCloudErrorCode(body.code)
            : ('CLOUD_TRANSPORT_ERROR' as const)
    const message =
        typeof body?.error === 'string'
            ? body.error
            : `Cloud request failed with status ${response.status}.`

    return new OpensteerCloudError(code, message, response.status, body?.details)
}

export function toCloudErrorCode(
    code: string
): CloudErrorCode | 'CLOUD_TRANSPORT_ERROR' {
    if (
        code === 'CLOUD_AUTH_FAILED' ||
        code === 'CLOUD_SESSION_NOT_FOUND' ||
        code === 'CLOUD_SESSION_CLOSED' ||
        code === 'CLOUD_UNSUPPORTED_METHOD' ||
        code === 'CLOUD_INVALID_REQUEST' ||
        code === 'CLOUD_MODEL_NOT_ALLOWED' ||
        code === 'CLOUD_ACTION_FAILED' ||
        code === 'CLOUD_INTERNAL' ||
        code === 'CLOUD_CAPACITY_EXHAUSTED' ||
        code === 'CLOUD_RUNTIME_UNAVAILABLE' ||
        code === 'CLOUD_RUNTIME_MISMATCH' ||
        code === 'CLOUD_SESSION_STALE' ||
        code === 'CLOUD_CONTRACT_MISMATCH' ||
        code === 'CLOUD_CONTROL_PLANE_ERROR' ||
        code === 'CLOUD_PROXY_UNAVAILABLE' ||
        code === 'CLOUD_PROXY_REQUIRED' ||
        code === 'CLOUD_BILLING_LIMIT_REACHED' ||
        code === 'CLOUD_RATE_LIMITED' ||
        code === 'CLOUD_BROWSER_PROFILE_NOT_FOUND' ||
        code === 'CLOUD_BROWSER_PROFILE_BUSY' ||
        code === 'CLOUD_BROWSER_PROFILE_DISABLED' ||
        code === 'CLOUD_BROWSER_PROFILE_PROXY_UNAVAILABLE' ||
        code === 'CLOUD_BROWSER_PROFILE_SYNC_FAILED'
    ) {
        return code
    }

    return 'CLOUD_TRANSPORT_ERROR'
}
