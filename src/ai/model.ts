const PROVIDER_MAP: Record<string, { pkg: string; providerFn: string }> = {
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

export async function getModelProvider(modelStr: string) {
    const { pkg, providerFn } = resolveProviderInfo(modelStr)

    let mod: Record<string, unknown>
    try {
        mod = await import(pkg)
    } catch {
        throw new Error(
            `To use AI resolution with model '${modelStr}', install: npm install ai ${pkg}`
        )
    }

    const provider = mod[providerFn]
    if (typeof provider !== 'function') {
        throw new Error(
            `Provider '${providerFn}' not found in '${pkg}'. Ensure you have the latest version installed.`
        )
    }

    const modelId = modelStr.startsWith('groq/')
        ? modelStr.slice('groq/'.length)
        : modelStr

    return (provider as (id: string) => unknown)(modelId)
}
