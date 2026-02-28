import { describe, expect, it, vi } from 'vitest'

const openaiProvider = vi.fn((id: string) => ({ provider: 'openai', id }))
const anthropicProvider = vi.fn((id: string) => ({ provider: 'anthropic', id }))

vi.mock('@ai-sdk/openai', () => ({
    openai: openaiProvider,
}))

vi.mock('@ai-sdk/anthropic', () => ({
    anthropic: anthropicProvider,
}))

import { getModelProvider } from '../../src/ai/model.js'

describe('ai/model', () => {
    it('strips provider prefix for openai models', async () => {
        const result = await getModelProvider('openai/computer-use-preview')

        expect(openaiProvider).toHaveBeenCalledWith('computer-use-preview')
        expect(result).toEqual({ provider: 'openai', id: 'computer-use-preview' })
    })

    it('strips provider prefix for anthropic models', async () => {
        const result = await getModelProvider(
            'anthropic/claude-sonnet-4-5-20250929'
        )

        expect(anthropicProvider).toHaveBeenCalledWith(
            'claude-sonnet-4-5-20250929'
        )
        expect(result).toEqual({
            provider: 'anthropic',
            id: 'claude-sonnet-4-5-20250929',
        })
    })

    it('throws for unsupported explicit provider prefixes', async () => {
        await expect(getModelProvider('unknown-provider/model-a')).rejects.toThrow(
            'Unsupported model provider prefix "unknown-provider"'
        )
    })
})
