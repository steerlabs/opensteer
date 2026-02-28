import type {
    ActionFailure,
    ActionFailureBlocker,
    ActionFailureClassificationSource,
    ActionFailureCode,
    ActionFailureDetails,
} from '../action-failure.js'
import { ElementPathError } from '../element-path/errors.js'
import { CounterResolutionError } from '../html/counter-runtime.js'
import type { ActionabilityProbeResult } from './actionability-probe.js'

const ACTION_FAILURE_CODES: ActionFailureCode[] = [
    'TARGET_NOT_FOUND',
    'TARGET_UNAVAILABLE',
    'TARGET_STALE',
    'TARGET_AMBIGUOUS',
    'BLOCKED_BY_INTERCEPTOR',
    'NOT_VISIBLE',
    'NOT_ENABLED',
    'NOT_EDITABLE',
    'INVALID_TARGET',
    'INVALID_OPTIONS',
    'ACTION_TIMEOUT',
    'UNKNOWN',
]

const ACTION_FAILURE_CODE_SET = new Set<ActionFailureCode>(ACTION_FAILURE_CODES)

const ACTION_FAILURE_SOURCES: ActionFailureClassificationSource[] = [
    'typed_error',
    'playwright_call_log',
    'dom_probe',
    'message_heuristic',
    'unknown',
]

const ACTION_FAILURE_SOURCE_SET = new Set<ActionFailureClassificationSource>(
    ACTION_FAILURE_SOURCES
)

interface ClassifyActionFailureInput {
    action: string
    error: unknown
    fallbackMessage: string
    probe?: ActionabilityProbeResult | null
}

export function defaultActionFailureMessage(action: string): string {
    switch (action) {
        case 'click':
        case 'dblclick':
        case 'rightclick':
            return 'Click failed.'
        case 'hover':
            return 'Hover failed.'
        case 'input':
            return 'Input failed.'
        case 'select':
            return 'Select failed.'
        case 'scroll':
            return 'Scroll failed.'
        case 'uploadFile':
            return 'File upload failed.'
        default:
            return 'Action failed.'
    }
}

export function classifyActionFailure(
    input: ClassifyActionFailureInput
): ActionFailure {
    const typed = classifyTypedError(input.error)
    if (typed) return typed

    const message = extractErrorMessage(input.error, input.fallbackMessage)
    const fromCallLog = classifyFromPlaywrightMessage(message, input.probe)
    if (fromCallLog) return fromCallLog

    const fromProbe = classifyFromProbe(input.probe)
    if (fromProbe) return fromProbe

    const fromHeuristic = classifyFromMessageHeuristic(message)
    if (fromHeuristic) return fromHeuristic

    return buildFailure({
        code: 'UNKNOWN',
        message: ensureMessage(message, input.fallbackMessage),
        classificationSource: 'unknown',
    })
}

export function normalizeActionFailure(value: unknown): ActionFailure | null {
    if (!value || typeof value !== 'object') return null

    const record = value as Record<string, unknown>
    const code = normalizeFailureCode(record.code)
    if (!code) return null

    const message =
        typeof record.message === 'string' && record.message.trim()
            ? record.message.trim()
            : null
    if (!message) return null

    const classificationSource = normalizeFailureSource(
        record.classificationSource
    )
    const retryable =
        typeof record.retryable === 'boolean'
            ? record.retryable
            : defaultRetryableForCode(code)
    const details = normalizeFailureDetails(record.details)

    return {
        code,
        message,
        retryable,
        classificationSource,
        ...(details ? { details } : {}),
    }
}

function classifyTypedError(error: unknown): ActionFailure | null {
    if (error instanceof ElementPathError) {
        if (
            error.code === 'ERR_PATH_TARGET_NOT_FOUND' ||
            error.code === 'ERR_PATH_CONTEXT_HOST_NOT_FOUND'
        ) {
            return buildFailure({
                code: 'TARGET_NOT_FOUND',
                message: `No matching element found. ${error.message}`,
                classificationSource: 'typed_error',
            })
        }
        if (
            error.code === 'ERR_PATH_IFRAME_UNAVAILABLE' ||
            error.code === 'ERR_PATH_SHADOW_ROOT_UNAVAILABLE'
        ) {
            return buildFailure({
                code: 'TARGET_UNAVAILABLE',
                message: error.message,
                classificationSource: 'typed_error',
            })
        }
        if (error.code === 'ERR_PATH_TARGET_NOT_UNIQUE') {
            return buildFailure({
                code: 'TARGET_AMBIGUOUS',
                message: error.message,
                classificationSource: 'typed_error',
            })
        }
    }

    if (error instanceof CounterResolutionError) {
        if (error.code === 'ERR_COUNTER_NOT_FOUND') {
            return buildFailure({
                code: 'TARGET_NOT_FOUND',
                message: error.message,
                classificationSource: 'typed_error',
            })
        }
        if (error.code === 'ERR_COUNTER_FRAME_UNAVAILABLE') {
            return buildFailure({
                code: 'TARGET_UNAVAILABLE',
                message: error.message,
                classificationSource: 'typed_error',
            })
        }
        if (error.code === 'ERR_COUNTER_AMBIGUOUS') {
            return buildFailure({
                code: 'TARGET_AMBIGUOUS',
                message: error.message,
                classificationSource: 'typed_error',
            })
        }
        if (error.code === 'ERR_COUNTER_STALE_OR_NOT_FOUND') {
            return buildFailure({
                code: 'TARGET_STALE',
                message: error.message,
                classificationSource: 'typed_error',
            })
        }
    }

    return null
}

function classifyFromPlaywrightMessage(
    message: string,
    probe?: ActionabilityProbeResult | null
): ActionFailure | null {
    const lowered = message.toLowerCase()
    if (!containsPlaywrightSignal(lowered)) return null

    if (lowered.includes('intercepts pointer events')) {
        return buildFailure({
            code: 'BLOCKED_BY_INTERCEPTOR',
            message: 'Interaction was blocked by another element intercepting pointer events.',
            classificationSource: 'playwright_call_log',
            details: mergeDetails(
                probe?.blocker ? { blocker: probe.blocker } : undefined,
                extractInterceptObservation(message)
            ),
        })
    }

    if (lowered.includes('element is not visible')) {
        return buildFailure({
            code: 'NOT_VISIBLE',
            message: 'Target element is not visible.',
            classificationSource: 'playwright_call_log',
        })
    }

    if (lowered.includes('element is not enabled')) {
        return buildFailure({
            code: 'NOT_ENABLED',
            message: 'Target element is not enabled.',
            classificationSource: 'playwright_call_log',
        })
    }

    if (lowered.includes('element is not editable')) {
        return buildFailure({
            code: 'NOT_EDITABLE',
            message: 'Target element is not editable.',
            classificationSource: 'playwright_call_log',
        })
    }

    if (
        lowered.includes('element is not attached to the dom') ||
        lowered.includes('element is detached')
    ) {
        return buildFailure({
            code: 'TARGET_STALE',
            message: 'Target element became stale before the interaction could complete.',
            classificationSource: 'playwright_call_log',
        })
    }

    if (
        lowered.includes('element is not a <select> element') ||
        lowered.includes('element is not an <input>, <textarea>, <select> or [contenteditable]') ||
        lowered.includes('does not have a role allowing [aria-readonly]') ||
        lowered.includes('node is not an htmlinputelement')
    ) {
        return buildFailure({
            code: 'INVALID_TARGET',
            message: 'Target element does not support this interaction type.',
            classificationSource: 'playwright_call_log',
        })
    }

    if (isTimeoutMessage(lowered)) {
        return buildFailure({
            code: 'ACTION_TIMEOUT',
            message: 'Interaction timed out before the target became actionable.',
            classificationSource: 'playwright_call_log',
        })
    }

    return null
}

function classifyFromProbe(
    probe: ActionabilityProbeResult | null | undefined
): ActionFailure | null {
    if (!probe) return null

    if (!probe.connected) {
        return buildFailure({
            code: 'TARGET_STALE',
            message: 'Target element became stale before the interaction could complete.',
            classificationSource: 'dom_probe',
        })
    }

    if (probe.blocker) {
        return buildFailure({
            code: 'BLOCKED_BY_INTERCEPTOR',
            message: 'Interaction was blocked by another element intercepting pointer events.',
            classificationSource: 'dom_probe',
            details: {
                blocker: probe.blocker,
            },
        })
    }

    if (probe.visible === false) {
        return buildFailure({
            code: 'NOT_VISIBLE',
            message: 'Target element is not visible.',
            classificationSource: 'dom_probe',
        })
    }

    if (probe.enabled === false) {
        return buildFailure({
            code: 'NOT_ENABLED',
            message: 'Target element is not enabled.',
            classificationSource: 'dom_probe',
        })
    }

    if (probe.editable === false) {
        return buildFailure({
            code: 'NOT_EDITABLE',
            message: 'Target element is not editable.',
            classificationSource: 'dom_probe',
        })
    }

    return null
}

function classifyFromMessageHeuristic(message: string): ActionFailure | null {
    const lowered = message.toLowerCase()

    if (lowered.includes('requires value, label, or index')) {
        return buildFailure({
            code: 'INVALID_OPTIONS',
            message: 'Select requires value, label, or index.',
            classificationSource: 'message_heuristic',
        })
    }

    if (
        lowered.includes('not attached to the dom') ||
        lowered.includes('became stale')
    ) {
        return buildFailure({
            code: 'TARGET_STALE',
            message: 'Target element became stale before the interaction could complete.',
            classificationSource: 'message_heuristic',
        })
    }

    if (lowered.includes('intercepts pointer events')) {
        return buildFailure({
            code: 'BLOCKED_BY_INTERCEPTOR',
            message: 'Interaction was blocked by another element intercepting pointer events.',
            classificationSource: 'message_heuristic',
            details: extractInterceptObservation(message),
        })
    }

    if (lowered.includes('not visible')) {
        return buildFailure({
            code: 'NOT_VISIBLE',
            message: 'Target element is not visible.',
            classificationSource: 'message_heuristic',
        })
    }

    if (lowered.includes('not enabled') || lowered.includes('disabled')) {
        return buildFailure({
            code: 'NOT_ENABLED',
            message: 'Target element is not enabled.',
            classificationSource: 'message_heuristic',
        })
    }

    if (lowered.includes('not editable')) {
        return buildFailure({
            code: 'NOT_EDITABLE',
            message: 'Target element is not editable.',
            classificationSource: 'message_heuristic',
        })
    }

    if (
        lowered.includes('not a <select>') ||
        lowered.includes('not an <input>') ||
        lowered.includes('invalid target')
    ) {
        return buildFailure({
            code: 'INVALID_TARGET',
            message: 'Target element does not support this interaction type.',
            classificationSource: 'message_heuristic',
        })
    }

    if (isTimeoutMessage(lowered)) {
        return buildFailure({
            code: 'ACTION_TIMEOUT',
            message: 'Interaction timed out before the target became actionable.',
            classificationSource: 'message_heuristic',
        })
    }

    return null
}

function buildFailure(input: {
    code: ActionFailureCode
    message: string
    classificationSource: ActionFailureClassificationSource
    details?: ActionFailureDetails
}): ActionFailure {
    return {
        code: input.code,
        message: ensureMessage(input.message, 'Action failed.'),
        retryable: defaultRetryableForCode(input.code),
        classificationSource: input.classificationSource,
        ...(input.details ? { details: input.details } : {}),
    }
}

function defaultRetryableForCode(code: ActionFailureCode): boolean {
    switch (code) {
        case 'INVALID_TARGET':
        case 'INVALID_OPTIONS':
        case 'UNKNOWN':
            return false
        default:
            return true
    }
}

function extractErrorMessage(error: unknown, fallbackMessage: string): string {
    if (error instanceof Error && error.message.trim()) {
        return error.message
    }
    if (typeof error === 'string' && error.trim()) {
        return error.trim()
    }
    if (error && typeof error === 'object' && !Array.isArray(error)) {
        const record = error as Record<string, unknown>
        if (typeof record.message === 'string' && record.message.trim()) {
            return record.message.trim()
        }
        if (typeof record.error === 'string' && record.error.trim()) {
            return record.error.trim()
        }
    }
    return ensureMessage(fallbackMessage, 'Action failed.')
}

function ensureMessage(value: string, fallback: string): string {
    const normalized = String(value || '').trim()
    return normalized || fallback
}

function isTimeoutMessage(loweredMessage: string): boolean {
    return (
        loweredMessage.includes('timeouterror:') ||
        loweredMessage.includes('timed out') ||
        loweredMessage.includes('timeout')
    )
}

function containsPlaywrightSignal(loweredMessage: string): boolean {
    return (
        loweredMessage.includes('call log:') ||
        loweredMessage.includes('attempting click action') ||
        loweredMessage.includes('attempting hover action') ||
        loweredMessage.includes('attempting fill action') ||
        loweredMessage.includes('attempting select option action')
    )
}

function mergeDetails(
    first?: ActionFailureDetails,
    second?: ActionFailureDetails
): ActionFailureDetails | undefined {
    if (!first && !second) return undefined
    return {
        ...(first || {}),
        ...(second || {}),
    }
}

function extractInterceptObservation(message: string): ActionFailureDetails | undefined {
    const match = message.match(
        /-\s*(.+?)\s+intercepts pointer events/iu
    )
    if (!match?.[1]) return undefined
    return {
        observation: match[1].trim(),
    }
}

function normalizeFailureCode(value: unknown): ActionFailureCode | null {
    if (typeof value !== 'string') return null
    const candidate = value.trim() as ActionFailureCode
    return ACTION_FAILURE_CODE_SET.has(candidate) ? candidate : null
}

function normalizeFailureSource(
    value: unknown
): ActionFailureClassificationSource {
    if (typeof value !== 'string') return 'unknown'
    const candidate = value.trim() as ActionFailureClassificationSource
    return ACTION_FAILURE_SOURCE_SET.has(candidate) ? candidate : 'unknown'
}

function normalizeFailureDetails(value: unknown): ActionFailureDetails | undefined {
    if (!value || typeof value !== 'object') return undefined
    const record = value as Record<string, unknown>

    const blocker = normalizeBlocker(record.blocker)
    const observation =
        typeof record.observation === 'string' && record.observation.trim()
            ? record.observation.trim()
            : undefined

    if (!blocker && !observation) return undefined
    return {
        ...(blocker ? { blocker } : {}),
        ...(observation ? { observation } : {}),
    }
}

function normalizeBlocker(value: unknown): ActionFailureBlocker | null {
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    if (typeof record.tag !== 'string' || !record.tag.trim()) return null

    const classes = Array.isArray(record.classes)
        ? record.classes
              .filter((entry) => typeof entry === 'string')
              .map((entry) => entry.trim())
              .filter(Boolean)
        : []

    return {
        tag: record.tag.trim().toLowerCase(),
        id: typeof record.id === 'string' ? record.id : null,
        classes,
        role: typeof record.role === 'string' ? record.role : null,
        text: typeof record.text === 'string' ? record.text : null,
    }
}
