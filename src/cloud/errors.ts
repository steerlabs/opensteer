import type { CloudActionFailureDetails, CloudErrorCode } from './contracts.js'

export class OpensteerCloudError extends Error {
    readonly code: CloudErrorCode | 'CLOUD_TRANSPORT_ERROR'
    readonly status?: number
    readonly details?: CloudActionFailureDetails | Record<string, unknown>

    constructor(
        code: CloudErrorCode | 'CLOUD_TRANSPORT_ERROR',
        message: string,
        status?: number,
        details?: CloudActionFailureDetails | Record<string, unknown>
    ) {
        super(message)
        this.name = 'OpensteerCloudError'
        this.code = code
        this.status = status
        this.details = details
    }
}

export function cloudUnsupportedMethodError(
    method: string,
    message?: string
): OpensteerCloudError {
    return new OpensteerCloudError(
        'CLOUD_UNSUPPORTED_METHOD',
        message || `${method} is not supported in cloud mode v1.`
    )
}

export function cloudNotLaunchedError(): OpensteerCloudError {
    return new OpensteerCloudError(
        'CLOUD_SESSION_NOT_FOUND',
        'Cloud session is not connected. Call launch() first.'
    )
}
