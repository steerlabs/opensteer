import { beforeEach, describe, expect, it, vi } from 'vitest'

const openaiProvider = vi.fn((id: string) => ({ provider: 'openai', id }))
const anthropicProvider = vi.fn((id: string) => ({ provider: 'anthropic', id }))
const googleProvider = vi.fn((id: string) => ({ provider: 'google', id }))
const openaiFactory = vi.fn((options: unknown) => {
    return (id: string) => ({
        provider: 'openai',
        id,
        options,
    })
})
const anthropicFactory = vi.fn((options: unknown) => {
    return (id: string) => ({
        provider: 'anthropic',
        id,
        options,
    })
})
const googleFactory = vi.fn((options: unknown) => {
    return (id: string) => ({
        provider: 'google',
        id,
        options,
    })
})

vi.mock('@ai-sdk/openai', () => ({
    openai: openaiProvider,
    createOpenAI: openaiFactory,
}))

vi.mock('@ai-sdk/anthropic', () => ({
    anthropic: anthropicProvider,
    createAnthropic: anthropicFactory,
}))

vi.mock('@ai-sdk/google', () => ({
    google: googleProvider,
    createGoogleGenerativeAI: googleFactory,
}))

import { getModelProvider } from '../../src/ai/model.js'

describe('ai/model', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

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

    it('uses provider factory with injected env for OpenAI', async () => {
        const result = await getModelProvider('openai/computer-use-preview', {
            env: {
                OPENAI_API_KEY: 'sk-env',
                OPENAI_BASE_URL: 'https://openai.example',
            },
        })

        expect(openaiFactory).toHaveBeenCalledWith({
            apiKey: 'sk-env',
            baseURL: 'https://openai.example',
        })
        expect(result).toEqual({
            provider: 'openai',
            id: 'computer-use-preview',
            options: {
                apiKey: 'sk-env',
                baseURL: 'https://openai.example',
            },
        })
    })

    it('uses provider factory with injected env for Anthropic', async () => {
        const result = await getModelProvider(
            'anthropic/claude-sonnet-4-5-20250929',
            {
                env: {
                    ANTHROPIC_API_KEY: 'anthropic-env',
                    ANTHROPIC_BASE_URL: 'https://anthropic.example',
                },
            }
        )

        expect(anthropicFactory).toHaveBeenCalledWith({
            apiKey: 'anthropic-env',
            baseURL: 'https://anthropic.example',
        })
        expect(result).toEqual({
            provider: 'anthropic',
            id: 'claude-sonnet-4-5-20250929',
            options: {
                apiKey: 'anthropic-env',
                baseURL: 'https://anthropic.example',
            },
        })
    })

    it('uses strict GOOGLE_GENERATIVE_AI_API_KEY when env is injected', async () => {
        const result = await getModelProvider('google/gemini-2.5-flash', {
            env: {
                GOOGLE_GENERATIVE_AI_API_KEY: 'google-env',
            },
        })

        expect(googleFactory).toHaveBeenCalledWith({
            apiKey: 'google-env',
        })
        expect(result).toEqual({
            provider: 'google',
            id: 'gemini-2.5-flash',
            options: {
                apiKey: 'google-env',
            },
        })
    })

    it('throws explicit key error for injected env without OpenAI key', async () => {
        await expect(
            getModelProvider('openai/computer-use-preview', {
                env: {},
            })
        ).rejects.toThrow('OPENAI_API_KEY')
    })

    it('does not accept google key aliases for injected env', async () => {
        await expect(
            getModelProvider('google/gemini-2.5-flash', {
                env: {
                    GOOGLE_API_KEY: 'alias-only',
                    GEMINI_API_KEY: 'alias-only',
                },
            })
        ).rejects.toThrow('GOOGLE_GENERATIVE_AI_API_KEY')
    })

    it('throws for unsupported explicit provider prefixes', async () => {
        await expect(getModelProvider('unknown-provider/model-a')).rejects.toThrow(
            'Unsupported model provider prefix "unknown-provider"'
        )
    })
})
