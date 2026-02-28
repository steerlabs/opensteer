import { describe, expect, it } from 'vitest'
import { CounterResolutionError } from '../../src/html/counter-runtime.js'
import { ElementPathError } from '../../src/element-path/errors.js'
import {
    classifyActionFailure,
    normalizeActionFailure,
} from '../../src/actions/failure-classifier.js'

describe('failure-classifier', () => {
    it('maps element path not-found errors to TARGET_NOT_FOUND', () => {
        const failure = classifyActionFailure({
            action: 'click',
            error: new ElementPathError(
                'ERR_PATH_TARGET_NOT_FOUND',
                'Element path resolution failed.'
            ),
            fallbackMessage: 'Click failed.',
        })

        expect(failure.code).toBe('TARGET_NOT_FOUND')
        expect(failure.classificationSource).toBe('typed_error')
        expect(failure.message).toContain('No matching element found')
    })

    it('maps counter missing errors to TARGET_NOT_FOUND', () => {
        const failure = classifyActionFailure({
            action: 'click',
            error: new CounterResolutionError(
                'ERR_COUNTER_NOT_FOUND',
                'Counter 42 was not found in the live DOM.'
            ),
            fallbackMessage: 'Click failed.',
        })

        expect(failure.code).toBe('TARGET_NOT_FOUND')
        expect(failure.classificationSource).toBe('typed_error')
    })

    it('maps counter ambiguous errors to TARGET_AMBIGUOUS', () => {
        const failure = classifyActionFailure({
            action: 'click',
            error: new CounterResolutionError(
                'ERR_COUNTER_AMBIGUOUS',
                'Counter 42 matches multiple live elements.'
            ),
            fallbackMessage: 'Click failed.',
        })

        expect(failure.code).toBe('TARGET_AMBIGUOUS')
        expect(failure.classificationSource).toBe('typed_error')
    })

    it('maps Playwright interception logs to BLOCKED_BY_INTERCEPTOR', () => {
        const failure = classifyActionFailure({
            action: 'click',
            error: new Error(`TimeoutError: elementHandle.click: Timeout 900ms exceeded.
Call log:
  - attempting click action
    - <div id="overlay"></div> intercepts pointer events`),
            fallbackMessage: 'Click failed.',
        })

        expect(failure.code).toBe('BLOCKED_BY_INTERCEPTOR')
        expect(failure.classificationSource).toBe('playwright_call_log')
        expect(failure.details?.observation).toContain('overlay')
    })

    it('uses probe blocker details when available', () => {
        const failure = classifyActionFailure({
            action: 'click',
            error: new Error('unknown interaction failure'),
            fallbackMessage: 'Click failed.',
            probe: {
                connected: true,
                visible: true,
                enabled: true,
                editable: null,
                blocker: {
                    tag: 'div',
                    id: 'modal',
                    classes: ['backdrop'],
                    role: 'presentation',
                    text: null,
                },
            },
        })

        expect(failure.code).toBe('BLOCKED_BY_INTERCEPTOR')
        expect(failure.classificationSource).toBe('dom_probe')
        expect(failure.details?.blocker?.id).toBe('modal')
    })

    it('normalizes cloud-provided action failures', () => {
        const failure = normalizeActionFailure({
            code: 'NOT_VISIBLE',
            message: 'Target hidden',
            retryable: true,
            classificationSource: 'typed_error',
            details: {
                observation: 'hidden',
            },
        })

        expect(failure).toEqual({
            code: 'NOT_VISIBLE',
            message: 'Target hidden',
            retryable: true,
            classificationSource: 'typed_error',
            details: { observation: 'hidden' },
        })
    })

    it('preserves original message for unknown failures', () => {
        const failure = classifyActionFailure({
            action: 'click',
            error: new Error('Browser target closed unexpectedly.'),
            fallbackMessage: 'Click failed.',
        })

        expect(failure.code).toBe('UNKNOWN')
        expect(failure.classificationSource).toBe('unknown')
        expect(failure.message).toBe('Browser target closed unexpectedly.')
    })
})
