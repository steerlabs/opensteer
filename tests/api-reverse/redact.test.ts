import { describe, expect, it } from 'vitest'
import { ApiValueRegistry, redactRecordStrings } from '../../src/api-reverse/redact.js'

describe('api-reverse redaction', () => {
    it('registers stable value handles and reuses them', () => {
        const registry = new ApiValueRegistry()
        const first = registry.register(
            'Bearer super-secret-token-value',
            {
                requestRef: '@request1',
                source: 'request.header',
                path: 'authorization',
            },
            {
                key: 'authorization',
                requestRef: '@request1',
            }
        )
        const second = registry.register(
            'Bearer super-secret-token-value',
            {
                requestRef: '@request2',
                source: 'response.body',
                path: 'token',
            },
            {
                key: 'token',
                requestRef: '@request2',
            }
        )

        expect(first?.ref).toBe('@value1')
        expect(second?.ref).toBe('@value1')
        expect(registry.list()).toHaveLength(1)
    })

    it('redacts known values inside nested objects', () => {
        const registry = new ApiValueRegistry()
        registry.register(
            'csrf-opaque-token-1234567890',
            {
                requestRef: '@request1',
                source: 'request.header',
                path: 'x-csrf-token',
            },
            {
                key: 'x-csrf-token',
                requestRef: '@request1',
            }
        )

        expect(
            redactRecordStrings(
                {
                    header: 'csrf-opaque-token-1234567890',
                    nested: {
                        body: 'before csrf-opaque-token-1234567890 after',
                    },
                },
                registry
            )
        ).toEqual({
            header: '@value1',
            nested: {
                body: 'before @value1 after',
            },
        })
    })
})
