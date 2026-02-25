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

    it('maps counter stale errors to TARGET_STALE', () => {
        const failure = classifyActionFailure({
            action: 'click',
            error: new CounterResolutionError(
                'ERR_COUNTER_STALE_OR_NOT_FOUND',
                'Counter target is stale or missing. Run snapshot() again.'
            ),
            fallbackMessage: 'Click failed.',
        })

        expect(failure.code).toBe('TARGET_STALE')
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
})
