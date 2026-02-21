import type { ActionFailure, ActionFailureCode } from '../action-failure.js'

interface OpensteerActionErrorOptions {
    action: string
    failure: ActionFailure
    selectorUsed?: string | null
    message?: string
    cause?: unknown
}

export class OpensteerActionError extends Error {
    readonly action: string
    readonly code: ActionFailureCode
    readonly failure: ActionFailure
    readonly selectorUsed: string | null

    constructor(options: OpensteerActionErrorOptions) {
        super(options.message || options.failure.message, {
            cause: options.cause,
        })
        this.name = 'OpensteerActionError'
        this.action = options.action
        this.code = options.failure.code
        this.failure = options.failure
        this.selectorUsed = options.selectorUsed || null
    }
}
