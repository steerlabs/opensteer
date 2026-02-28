import { describe, expect, it } from 'vitest'
import { normalizeError, extractErrorMessage } from '../src/error-normalization.js'

describe('error-normalization', () => {
    it('extracts message from unknown inputs with fallback', () => {
        expect(extractErrorMessage('boom')).toBe('boom')
        expect(extractErrorMessage({ message: 'bad request' })).toBe('bad request')
        expect(extractErrorMessage(null, 'fallback')).toBe('fallback')
    })

    it('normalizes code, details, and causes', () => {
        const cause = new Error('Root cause')
        const error = Object.assign(new Error('Top failure', { cause }), {
            code: 'TOP_CODE',
            details: {
                module: 'cli',
            },
        })

        const normalized = normalizeError(error)

        expect(normalized.message).toBe('Top failure')
        expect(normalized.code).toBe('TOP_CODE')
        expect(normalized.details).toEqual({ module: 'cli' })
        expect(normalized.cause?.message).toBe('Root cause')
    })

    it('normalizes details into JSON-safe values', () => {
        const circular: Record<string, unknown> = {}
        circular.self = circular
        const error = Object.assign(new Error('Top failure'), {
            details: {
                big: 123n,
                loop: circular,
                list: [1n, undefined, Number.POSITIVE_INFINITY],
            },
        })

        const normalized = normalizeError(error)

        expect(normalized.details).toEqual({
            big: '123',
            loop: { self: '[Circular]' },
            list: ['1', null, null],
        })
        expect(() => JSON.stringify(normalized)).not.toThrow()
    })
})
