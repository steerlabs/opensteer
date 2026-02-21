import type { ActionFailure } from '../action-failure.js'
import {
    classifyActionFailure,
    defaultActionFailureMessage,
} from './failure-classifier.js'

export function classifyPathResolutionFailure(
    action: string,
    err: unknown
): ActionFailure {
    return classifyActionFailure({
        action,
        error: err,
        fallbackMessage: defaultActionFailureMessage(action),
    })
}

export function formatPathResolutionError(err: unknown): string {
    return classifyPathResolutionFailure('resolvePath', err).message
}
