import { describe, expect, it, vi } from 'vitest'

vi.mock('ai', () => ({
    generateText: vi.fn(),
}))

vi.mock('../../src/ai/model.js', () => ({
    getModelProvider: vi.fn().mockResolvedValue('mock-model'),
}))

import { generateText } from 'ai'
import { createExtractCallback } from '../../src/ai/extractor.js'

const mockedGenerateText = vi.mocked(generateText)

describe('ai/extractor', () => {
    it('returns ExtractionPlan with flattened fields when contains_data is true', async () => {
        mockedGenerateText.mockResolvedValueOnce({
            text: JSON.stringify({
                contains_data: true,
                data: { name: 3, email: 7 },
            }),
        } as never)

        const extract = createExtractCallback('gpt-5-mini')
        const result = await extract({
            html: '<div c="3">Alice</div><div c="7">alice@example.com</div>',
            schema: { name: 'string', email: 'string' },
            url: null,
        })

        expect(result).toEqual({
            fields: {
                name: { element: 3 },
                email: { element: 7 },
            },
        })
    })

    it('maps $c/$a leaf descriptors to element + attribute field plans', async () => {
        mockedGenerateText.mockResolvedValueOnce({
            text: JSON.stringify({
                contains_data: true,
                data: {
                    name: 3,
                    url: { $c: 3, $a: 'href' },
                    image: { $c: 9, $a: 'src' },
                },
            }),
        } as never)

        const extract = createExtractCallback('gpt-5-mini')
        const result = await extract({
            html: '<a c="3" href="/products/switches-70">Switches x 70</a><img c="9" src="/hero.png" />',
            schema: {
                name: 'string',
                url: 'string',
                image: 'string',
            },
            url: null,
        })

        expect(result).toEqual({
            fields: {
                name: { element: 3 },
                url: { element: 3, attribute: 'href' },
                image: { element: 9, attribute: 'src' },
            },
        })
    })

    it('returns empty fields when contains_data is false', async () => {
        mockedGenerateText.mockResolvedValueOnce({
            text: JSON.stringify({
                contains_data: false,
                data: {},
            }),
        } as never)

        const extract = createExtractCallback('gpt-5-mini')
        const result = await extract({
            html: '<div>No relevant data</div>',
            schema: { name: 'string' },
            url: null,
        })

        expect(result).toEqual({ fields: {} })
    })

    it('flattens nested data objects to dot-notation paths', async () => {
        mockedGenerateText.mockResolvedValueOnce({
            text: JSON.stringify({
                contains_data: true,
                data: {
                    metrics: {
                        revenue: 10,
                        growth: 11,
                    },
                    region: 5,
                },
            }),
        } as never)

        const extract = createExtractCallback('gpt-5-mini')
        const result = await extract({
            html: '<div c="5">North</div><span c="10">$100</span><span c="11">+5%</span>',
            schema: {
                metrics: { revenue: 'number', growth: 'string' },
                region: 'string',
            },
            url: null,
        })

        expect(result).toEqual({
            fields: {
                'metrics.revenue': { element: 10 },
                'metrics.growth': { element: 11 },
                region: { element: 5 },
            },
        })
    })

    it('maps CURRENT_URL leaf values to current_url source fields', async () => {
        mockedGenerateText.mockResolvedValueOnce({
            text: JSON.stringify({
                contains_data: true,
                data: {
                    pageUrl: 'CURRENT_URL',
                    items: [
                        {
                            title: 10,
                            pageUrl: 'CURRENT_URL',
                        },
                    ],
                },
            }),
        } as never)

        const extract = createExtractCallback('gpt-5-mini')
        const result = await extract({
            html: '<div c="10">Title</div>',
            schema: {
                pageUrl: '',
                items: [{ title: '', pageUrl: '' }],
            },
            url: 'https://example.com/products',
        })

        expect(result).toEqual({
            fields: {
                pageUrl: { source: 'current_url' },
                'items[0].title': { element: 10 },
                'items[0].pageUrl': { source: 'current_url' },
            },
        })
    })

    it('handles array data with indexed paths', async () => {
        mockedGenerateText.mockResolvedValueOnce({
            text: JSON.stringify({
                contains_data: true,
                data: {
                    items: [3, 7, 11],
                },
            }),
        } as never)

        const extract = createExtractCallback('gpt-5-mini')
        const result = await extract({
            html: '<li c="3">A</li><li c="7">B</li><li c="11">C</li>',
            schema: { items: 'string[]' },
            url: null,
        })

        expect(result).toEqual({
            fields: {
                'items[0]': { element: 3 },
                'items[1]': { element: 7 },
                'items[2]': { element: 11 },
            },
        })
    })

    it('handles response wrapped in code fences', async () => {
        mockedGenerateText.mockResolvedValueOnce({
            text:
                '```json\n' +
                JSON.stringify({
                    contains_data: true,
                    data: { region: 5 },
                }) +
                '\n```',
        } as never)

        const extract = createExtractCallback('gpt-5-mini')
        const result = await extract({
            html: '<div c="5">North</div>',
            schema: { region: 'string' },
            url: null,
        })

        expect(result).toEqual({
            fields: {
                region: { element: 5 },
            },
        })
    })

    it('defaults temperature to 1 and omits maxOutputTokens when maxTokens is unset', async () => {
        mockedGenerateText.mockResolvedValueOnce({
            text: JSON.stringify({
                contains_data: true,
                data: { region: 5 },
            }),
        } as never)

        const extract = createExtractCallback('gpt-5-mini')
        await extract({
            html: '<div c="5">North</div>',
            schema: { region: 'string' },
            url: null,
        })

        const callArg = mockedGenerateText.mock.calls.at(-1)?.[0] as
            | Record<string, unknown>
            | undefined
        expect(callArg).toBeTruthy()
        expect(callArg?.temperature).toBe(1)
        expect(callArg).not.toHaveProperty('maxOutputTokens')
    })

    it('passes maxOutputTokens only when maxTokens is explicitly provided', async () => {
        mockedGenerateText.mockResolvedValueOnce({
            text: JSON.stringify({
                contains_data: true,
                data: { region: 5 },
            }),
        } as never)

        const extract = createExtractCallback('gpt-5-mini', {
            maxTokens: 512,
        })
        await extract({
            html: '<div c="5">North</div>',
            schema: { region: 'string' },
            url: null,
        })

        const callArg = mockedGenerateText.mock.calls.at(-1)?.[0] as
            | Record<string, unknown>
            | undefined
        expect(callArg).toBeTruthy()
        expect(callArg?.maxOutputTokens).toBe(512)
    })
})
