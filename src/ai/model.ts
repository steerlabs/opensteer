import type { RuntimeEnv } from '../config.js'

interface ProviderInfo {
    pkg: string
    providerFn: string
    factoryFn: string
    apiKeyEnvVar: string
    baseUrlEnvVar?: string
}

const OPENAI_PROVIDER_INFO: ProviderInfo = {
    pkg: '@ai-sdk/openai',
    providerFn: 'openai',
    factoryFn: 'createOpenAI',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    baseUrlEnvVar: 'OPENAI_BASE_URL',
}

const ANTHROPIC_PROVIDER_INFO: ProviderInfo = {
    pkg: '@ai-sdk/anthropic',
    providerFn: 'anthropic',
    factoryFn: 'createAnthropic',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    baseUrlEnvVar: 'ANTHROPIC_BASE_URL',
}

const GOOGLE_PROVIDER_INFO: ProviderInfo = {
    pkg: '@ai-sdk/google',
    providerFn: 'google',
    factoryFn: 'createGoogleGenerativeAI',
    apiKeyEnvVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
}

const XAI_PROVIDER_INFO: ProviderInfo = {
    pkg: '@ai-sdk/xai',
    providerFn: 'xai',
    factoryFn: 'createXai',
    apiKeyEnvVar: 'XAI_API_KEY',
}

const GROQ_PROVIDER_INFO: ProviderInfo = {
    pkg: '@ai-sdk/groq',
    providerFn: 'groq',
    factoryFn: 'createGroq',
    apiKeyEnvVar: 'GROQ_API_KEY',
}

const PROVIDER_MAP: Record<string, ProviderInfo> = {
    'openai/': OPENAI_PROVIDER_INFO,
    'anthropic/': ANTHROPIC_PROVIDER_INFO,
    'google/': GOOGLE_PROVIDER_INFO,
    'xai/': XAI_PROVIDER_INFO,
    'gpt-': OPENAI_PROVIDER_INFO,
    'o1-': OPENAI_PROVIDER_INFO,
    'o3-': OPENAI_PROVIDER_INFO,
    'o4-': OPENAI_PROVIDER_INFO,
    'claude-': ANTHROPIC_PROVIDER_INFO,
    'gemini-': GOOGLE_PROVIDER_INFO,
    'grok-': XAI_PROVIDER_INFO,
    'groq/': GROQ_PROVIDER_INFO,
}

function resolveProviderInfo(modelStr: string): ProviderInfo {
    for (const [prefix, info] of Object.entries(PROVIDER_MAP)) {
        if (modelStr.startsWith(prefix)) {
            return info
        }
    }

    const slash = modelStr.indexOf('/')
    if (slash > 0) {
        const provider = modelStr.slice(0, slash).trim().toLowerCase()
        if (provider) {
            throw new Error(
                `Unsupported model provider prefix "${provider}" in model "${modelStr}". Use one of: openai, anthropic, google, xai, groq.`
            )
        }
    }

    return OPENAI_PROVIDER_INFO
}

function stripProviderPrefix(modelStr: string): string {
    const slash = modelStr.indexOf('/')
    if (slash <= 0) return modelStr

    const provider = modelStr.slice(0, slash).toLowerCase()
    if (
        provider === 'openai' ||
        provider === 'anthropic' ||
        provider === 'google' ||
        provider === 'xai' ||
        provider === 'groq'
    ) {
        return modelStr.slice(slash + 1)
    }

    return modelStr
}

function normalizeEnvValue(value: string | undefined): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed.length ? trimmed : undefined
}

function buildFactoryOptions(provider: ProviderInfo, env: RuntimeEnv): {
    apiKey: string
    baseURL?: string
} {
    const apiKey = normalizeEnvValue(env[provider.apiKeyEnvVar])
    if (!apiKey) {
        throw new Error(
            `API key is missing in the resolved Opensteer environment. Set ${provider.apiKeyEnvVar} in your runtime environment or .env file under storage.rootDir.`
        )
    }

    const baseURL = provider.baseUrlEnvVar
        ? normalizeEnvValue(env[provider.baseUrlEnvVar])
        : undefined

    return {
        apiKey,
        ...(baseURL ? { baseURL } : {}),
    }
}

export async function getModelProvider(
    modelStr: string,
    options: { env?: RuntimeEnv } = {}
) {
    const info = resolveProviderInfo(modelStr)

    let mod: Record<string, unknown>
    try {
        mod = await import(info.pkg)
    } catch {
        throw new Error(
            `To use AI resolution with model '${modelStr}', install 'ai' and '${info.pkg}' with your package manager.`
        )
    }

    const providerExportName = options.env ? info.factoryFn : info.providerFn
    const providerExport = mod[providerExportName]
    if (typeof providerExport !== 'function') {
        throw new Error(
            `Provider '${providerExportName}' not found in '${info.pkg}'. Ensure you have the latest version installed.`
        )
    }

    const modelId = stripProviderPrefix(modelStr)
    const provider =
        options.env != null
            ? (providerExport as (args: { apiKey: string; baseURL?: string }) => unknown)(
                  buildFactoryOptions(info, options.env)
              )
            : providerExport

    if (typeof provider !== 'function') {
        throw new Error(
            `Provider '${providerExportName}' from '${info.pkg}' did not return a model factory function.`
        )
    }

    return (provider as (id: string) => unknown)(modelId)
}
