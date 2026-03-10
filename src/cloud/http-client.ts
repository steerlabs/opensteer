import type { OpensteerAuthScheme } from '../types.js'
import type { CloudErrorCode } from './contracts.js'
import { isCloudErrorCode } from './contracts.js'
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
    return isCloudErrorCode(code) ? code : 'CLOUD_TRANSPORT_ERROR'
}
