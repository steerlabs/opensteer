import type { RemoteActionFailureDetails, RemoteErrorCode } from './contracts.js'

export class OpensteerRemoteError extends Error {
    readonly code: RemoteErrorCode | 'REMOTE_TRANSPORT_ERROR'
    readonly status?: number
    readonly details?: RemoteActionFailureDetails | Record<string, unknown>

    constructor(
        code: RemoteErrorCode | 'REMOTE_TRANSPORT_ERROR',
        message: string,
        status?: number,
        details?: RemoteActionFailureDetails | Record<string, unknown>
    ) {
        super(message)
        this.name = 'OpensteerRemoteError'
        this.code = code
        this.status = status
        this.details = details
    }
}

export function remoteUnsupportedMethodError(
    method: string,
    message?: string
): OpensteerRemoteError {
    return new OpensteerRemoteError(
        'REMOTE_UNSUPPORTED_METHOD',
        message || `${method} is not supported in remote mode.`
    )
}

export function remoteNotLaunchedError(): OpensteerRemoteError {
    return new OpensteerRemoteError(
        'REMOTE_SESSION_NOT_FOUND',
        'Remote session is not connected. Call launch() first.'
    )
}
