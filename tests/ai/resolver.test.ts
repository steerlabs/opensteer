import { describe, expect, it, vi } from 'vitest'

vi.mock('ai', () => ({
    generateObject: vi.fn(),
}))

vi.mock('../../src/ai/model.js', () => ({
    getModelProvider: vi.fn().mockResolvedValue('mock-model'),
}))

import { generateObject } from 'ai'
import { createResolveCallback } from '../../src/ai/resolver.js'

const mockedGenerateObject = vi.mocked(generateObject)

describe('ai/resolver', () => {
    it('returns counter number on high confidence', async () => {
        mockedGenerateObject.mockResolvedValueOnce({
            object: {
                element: 5,
                confidence: 0.95,
                reasoning: 'Matched submit button',
            },
        } as never)

        const resolve = createResolveCallback('gpt-5-mini')
        const result = await resolve({
            html: '<button c="5">Submit</button>',
            action: 'click',
            description: 'Submit button',
            url: 'http://localhost:3000',
        })

        expect(result).toBe(5)
    })

    it('returns null on low confidence (< 0.1)', async () => {
        mockedGenerateObject.mockResolvedValueOnce({
            object: {
                element: 3,
                confidence: 0.05,
                reasoning: 'Uncertain match',
            },
        } as never)

        const resolve = createResolveCallback('gpt-5-mini')
        const result = await resolve({
            html: '<div c="3">Some text</div>',
            action: 'click',
            description: 'Non-existent button',
            url: null,
        })

        expect(result).toBeNull()
    })

    it('returns null when element is -1', async () => {
        mockedGenerateObject.mockResolvedValueOnce({
            object: {
                element: -1,
                confidence: 0.9,
                reasoning: 'No match found',
            },
        } as never)

        const resolve = createResolveCallback('gpt-5-mini')
        const result = await resolve({
            html: '<div c="1">Hello</div>',
            action: 'click',
            description: 'Missing element',
            url: null,
        })

        expect(result).toBeNull()
    })

    it('calls generateObject with correct prompt structure', async () => {
        mockedGenerateObject.mockResolvedValueOnce({
            object: { element: 1, confidence: 0.8, reasoning: 'Found it' },
        } as never)

        const resolve = createResolveCallback('gpt-5-mini', {
            temperature: 0.5,
        })
        await resolve({
            html: '<button c="1">Go</button>',
            action: 'click',
            description: 'Go button',
            url: 'http://example.com',
        })

        expect(mockedGenerateObject).toHaveBeenCalledWith(
            expect.objectContaining({
                model: 'mock-model',
                temperature: 0.5,
                system: expect.stringContaining('c="N"'),
                prompt: expect.stringContaining('Action: click'),
            })
        )
    })

    it('defaults temperature to 1 and omits maxOutputTokens when maxTokens is unset', async () => {
        mockedGenerateObject.mockResolvedValueOnce({
            object: { element: 2, confidence: 0.8, reasoning: 'Found it' },
        } as never)

        const resolve = createResolveCallback('gpt-5-mini')
        await resolve({
            html: '<button c="2">Save</button>',
            action: 'click',
            description: 'Save button',
            url: 'http://example.com',
        })

        const callArg = mockedGenerateObject.mock.calls.at(-1)?.[0] as
            | Record<string, unknown>
            | undefined
        expect(callArg).toBeTruthy()
        expect(callArg?.temperature).toBe(1)
        expect(callArg).not.toHaveProperty('maxOutputTokens')
    })

    it('passes maxOutputTokens only when maxTokens is explicitly provided', async () => {
        mockedGenerateObject.mockResolvedValueOnce({
            object: { element: 3, confidence: 0.8, reasoning: 'Found it' },
        } as never)

        const resolve = createResolveCallback('gpt-5-mini', {
            maxTokens: 512,
        })
        await resolve({
            html: '<button c="3">Submit</button>',
            action: 'click',
            description: 'Submit button',
            url: 'http://example.com',
        })

        const callArg = mockedGenerateObject.mock.calls.at(-1)?.[0] as
            | Record<string, unknown>
            | undefined
        expect(callArg).toBeTruthy()
        expect(callArg?.maxOutputTokens).toBe(512)
    })
})
