import { describe, expect, it } from 'vitest'
import { resolveAgentConfig } from '../../src/agent/provider.js'

describe('agent/model resolution', () => {
    it('requires mode: cua', () => {
        expect(() =>
            resolveAgentConfig({
                // @ts-expect-error validating runtime error for unsupported mode
                agentConfig: { mode: 'dom' },
                fallbackModel: 'openai/computer-use-preview',
                env: {},
            })
        ).toThrow('OpenSteer currently supports only mode: "cua"')
    })

    it('uses fallback model when agent model is omitted', () => {
        const resolved = resolveAgentConfig({
            agentConfig: {
                mode: 'cua',
            },
            fallbackModel: 'openai/computer-use-preview',
            env: {
                OPENAI_API_KEY: 'sk-test',
            },
        })

        expect(resolved.model.fullModelName).toBe('openai/computer-use-preview')
        expect(resolved.model.provider).toBe('openai')
        expect(resolved.model.apiKey).toBe('sk-test')
    })

    it('requires provider/model format', () => {
        expect(() =>
            resolveAgentConfig({
                agentConfig: {
                    mode: 'cua',
                    model: 'computer-use-preview',
                },
                env: {
                    OPENAI_API_KEY: 'sk-test',
                },
            })
        ).toThrow('Use "provider/model" format')
    })

    it('resolves object model config fields', () => {
        const resolved = resolveAgentConfig({
            agentConfig: {
                mode: 'cua',
                model: {
                    modelName: 'anthropic/claude-sonnet-4-5-20250929',
                    apiKey: 'anthropic-key',
                    baseUrl: 'https://anthropic.example.com',
                    thinkingBudget: 1024,
                },
            },
            env: {},
        })

        expect(resolved.model.provider).toBe('anthropic')
        expect(resolved.model.providerModelName).toBe('claude-sonnet-4-5-20250929')
        expect(resolved.model.apiKey).toBe('anthropic-key')
        expect(resolved.model.baseUrl).toBe('https://anthropic.example.com')
        expect(resolved.model.thinkingBudget).toBe(1024)
    })

    it('reads google keys from supported env vars', () => {
        const resolved = resolveAgentConfig({
            agentConfig: {
                mode: 'cua',
                model: 'google/gemini-2.5-computer-use-preview-10-2025',
            },
            env: {
                GEMINI_API_KEY: 'google-key',
            },
        })

        expect(resolved.model.provider).toBe('google')
        expect(resolved.model.apiKey).toBe('google-key')
    })

    it('throws when provider key is missing', () => {
        expect(() =>
            resolveAgentConfig({
                agentConfig: {
                    mode: 'cua',
                    model: 'openai/computer-use-preview',
                },
                env: {},
            })
        ).toThrow('OPENAI_API_KEY')
    })
})
