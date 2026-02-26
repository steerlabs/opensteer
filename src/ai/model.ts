const PROVIDER_MAP: Record<string, { pkg: string; providerFn: string }> = {
    'openai/': { pkg: '@ai-sdk/openai', providerFn: 'openai' },
    'anthropic/': { pkg: '@ai-sdk/anthropic', providerFn: 'anthropic' },
    'google/': { pkg: '@ai-sdk/google', providerFn: 'google' },
    'xai/': { pkg: '@ai-sdk/xai', providerFn: 'xai' },
    'gpt-': { pkg: '@ai-sdk/openai', providerFn: 'openai' },
    'o1-': { pkg: '@ai-sdk/openai', providerFn: 'openai' },
    'o3-': { pkg: '@ai-sdk/openai', providerFn: 'openai' },
    'o4-': { pkg: '@ai-sdk/openai', providerFn: 'openai' },
    'claude-': { pkg: '@ai-sdk/anthropic', providerFn: 'anthropic' },
    'gemini-': { pkg: '@ai-sdk/google', providerFn: 'google' },
    'grok-': { pkg: '@ai-sdk/xai', providerFn: 'xai' },
    'groq/': { pkg: '@ai-sdk/groq', providerFn: 'groq' },
}

function resolveProviderInfo(modelStr: string): {
    pkg: string
    providerFn: string
} {
    for (const [prefix, info] of Object.entries(PROVIDER_MAP)) {
        if (modelStr.startsWith(prefix)) {
            return info
        }
    }
    return { pkg: '@ai-sdk/openai', providerFn: 'openai' }
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

export async function getModelProvider(modelStr: string) {
    const { pkg, providerFn } = resolveProviderInfo(modelStr)

    let mod: Record<string, unknown>
    try {
        mod = await import(pkg)
    } catch {
        throw new Error(
            `To use AI resolution with model '${modelStr}', install 'ai' and '${pkg}' with your package manager.`
        )
    }

    const provider = mod[providerFn]
    if (typeof provider !== 'function') {
        throw new Error(
            `Provider '${providerFn}' not found in '${pkg}'. Ensure you have the latest version installed.`
        )
    }

    const modelId = stripProviderPrefix(modelStr)

    return (provider as (id: string) => unknown)(modelId)
}
