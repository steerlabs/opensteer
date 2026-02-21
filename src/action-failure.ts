export type ActionFailureCode =
    | 'TARGET_NOT_FOUND'
    | 'TARGET_UNAVAILABLE'
    | 'TARGET_STALE'
    | 'TARGET_AMBIGUOUS'
    | 'BLOCKED_BY_INTERCEPTOR'
    | 'NOT_VISIBLE'
    | 'NOT_ENABLED'
    | 'NOT_EDITABLE'
    | 'INVALID_TARGET'
    | 'INVALID_OPTIONS'
    | 'ACTION_TIMEOUT'
    | 'UNKNOWN'

export type ActionFailureClassificationSource =
    | 'typed_error'
    | 'playwright_call_log'
    | 'dom_probe'
    | 'message_heuristic'
    | 'unknown'

export interface ActionFailureBlocker {
    tag: string
    id: string | null
    classes: string[]
    role: string | null
    text: string | null
}

export interface ActionFailureDetails {
    blocker?: ActionFailureBlocker
    observation?: string
}

export interface ActionFailure {
    code: ActionFailureCode
    message: string
    retryable: boolean
    classificationSource: ActionFailureClassificationSource
    details?: ActionFailureDetails
}
