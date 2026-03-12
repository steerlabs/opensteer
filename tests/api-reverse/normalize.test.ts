import { describe, expect, it } from 'vitest'
import {
    buildUrlTemplate,
    canonicalizeBodyShape,
    inferGraphqlMetadata,
    normalizeRequestSignature,
} from '../../src/api-reverse/normalize.js'

describe('api-reverse normalize', () => {
    it('buildUrlTemplate lifts common dynamic segments and query values', () => {
        expect(
            buildUrlTemplate(
                'https://example.com/users/123/orders/550e8400-e29b-41d4-a716-446655440000?token=abcdefabcdefabcdef&limit=25'
            )
        ).toBe(
            'https://example.com/users/:int/orders/:uuid?limit=<int>&token=<hex>'
        )
    })

    it('canonicalizeBodyShape normalizes nested primitives', () => {
        expect(
            canonicalizeBodyShape({
                amount: 15,
                nested: {
                    sessionId: 'abcdefabcdefabcdef',
                    active: true,
                },
            })
        ).toEqual({
            amount: '<int>',
            nested: {
                active: '<boolean>',
                sessionId: '<hex>',
            },
        })
    })

    it('inferGraphqlMetadata extracts operation names and persisted-query hashes', () => {
        expect(
            inferGraphqlMetadata({
                operationName: 'DownloadInvoice',
                variables: { id: '123' },
                extensions: {
                    persistedQuery: {
                        sha256Hash: 'deadbeefdeadbeefdeadbeefdeadbeef',
                    },
                },
            })
        ).toEqual({
            operationName: 'DownloadInvoice',
            persistedQueryHash: 'deadbeefdeadbeefdeadbeefdeadbeef',
        })
    })

    it('normalizeRequestSignature distinguishes method, template, graphql metadata, and body shape', () => {
        const left = normalizeRequestSignature({
            method: 'POST',
            url: 'https://example.com/graphql',
            resourceType: 'xhr',
            body: {
                operationName: 'DownloadInvoice',
                variables: { id: '123' },
            },
            graphql: {
                operationName: 'DownloadInvoice',
                persistedQueryHash: null,
            },
        })

        const right = normalizeRequestSignature({
            method: 'POST',
            url: 'https://example.com/graphql',
            resourceType: 'xhr',
            body: {
                operationName: 'ListInvoices',
                variables: { page: 2 },
            },
            graphql: {
                operationName: 'ListInvoices',
                persistedQueryHash: null,
            },
        })

        expect(left).not.toBe(right)
    })
})
