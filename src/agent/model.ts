import type {
    OpensteerAgentConfig,
    OpensteerAgentModelConfig,
    OpensteerAgentProvider,
} from '../types.js'
import type { RuntimeEnv } from '../config.js'
import { OpensteerAgentConfigError, OpensteerAgentProviderError } from './errors.js'

export interface ResolvedCuaModelConfig {
    provider: OpensteerAgentProvider
    fullModelName: string
    providerModelName: string
    apiKey: string
    baseUrl?: string
    organization?: string
    thinkingBudget?: number
    environment?: string
}

interface ModelSource {
    modelName: string
    options: Omit<OpensteerAgentModelConfig, 'modelName'>
}

const SUPPORTED_CUA_PROVIDERS = new Set<OpensteerAgentProvider>([
    'openai',
    'anthropic',
    'google',
])

export function resolveCuaModelConfig(args: {
    agentConfig: OpensteerAgentConfig
    fallbackModel?: string
    env?: RuntimeEnv
}): ResolvedCuaModelConfig {
    const env = args.env || process.env
    const source = resolveModelSource(args.agentConfig.model, args.fallbackModel)
    const parsed = parseProviderModel(source.modelName)

    if (!SUPPORTED_CUA_PROVIDERS.has(parsed.provider)) {
        throw new OpensteerAgentProviderError(
            `Unsupported CUA provider "${parsed.provider}". Supported providers: openai, anthropic, google.`
        )
    }

    const apiKey = resolveProviderApiKey(parsed.provider, source.options.apiKey, env)

    return {
        provider: parsed.provider,
        fullModelName: `${parsed.provider}/${parsed.modelName}`,
        providerModelName: parsed.modelName,
        apiKey,
        baseUrl: normalizeOptional(source.options.baseUrl),
        organization: normalizeOptional(source.options.organization),
        thinkingBudget:
            typeof source.options.thinkingBudget === 'number' &&
            Number.isFinite(source.options.thinkingBudget)
                ? source.options.thinkingBudget
                : undefined,
        environment: normalizeOptional(source.options.environment),
    }
}

function resolveModelSource(
    model: OpensteerAgentConfig['model'],
    fallbackModel?: string
): ModelSource {
    if (model && typeof model === 'object') {
        const modelName = normalizeRequired(model.modelName, 'agent.model.modelName')
        const { modelName: _, ...options } = model
        return {
            modelName,
            options,
        }
    }

    const modelName = normalizeOptional(model) || normalizeOptional(fallbackModel)
    if (!modelName) {
        throw new OpensteerAgentConfigError(
            'A CUA model is required. Pass agent.model (for example "openai/computer-use-preview").'
        )
    }

    return {
        modelName,
        options: {},
    }
}

function parseProviderModel(modelName: string): {
    provider: OpensteerAgentProvider
    modelName: string
} {
    const slash = modelName.indexOf('/')
    if (slash <= 0 || slash === modelName.length - 1) {
        throw new OpensteerAgentConfigError(
            `Invalid CUA model "${modelName}". Use "provider/model" format (for example "openai/computer-use-preview").`
        )
    }

    const providerRaw = modelName.slice(0, slash).trim().toLowerCase()
    const providerModelName = modelName.slice(slash + 1).trim()
    if (!providerModelName) {
        throw new OpensteerAgentConfigError(
            `Invalid CUA model "${modelName}". The model name segment after the provider cannot be empty.`
        )
    }

    if (
        providerRaw !== 'openai' &&
        providerRaw !== 'anthropic' &&
        providerRaw !== 'google'
    ) {
        throw new OpensteerAgentProviderError(
            `Unsupported CUA provider "${providerRaw}". Supported providers: openai, anthropic, google.`
        )
    }

    return {
        provider: providerRaw,
        modelName: providerModelName,
    }
}

function resolveProviderApiKey(
    provider: OpensteerAgentProvider,
    explicitApiKey: string | undefined,
    env: RuntimeEnv
): string {
    const explicit = normalizeOptional(explicitApiKey)
    if (explicit) return explicit

    if (provider === 'openai') {
        const value = normalizeOptional(env.OPENAI_API_KEY)
        if (value) return value
        throw new OpensteerAgentConfigError(
            'OpenAI CUA requires an API key via agent.model.apiKey or OPENAI_API_KEY.'
        )
    }

    if (provider === 'anthropic') {
        const value = normalizeOptional(env.ANTHROPIC_API_KEY)
        if (value) return value
        throw new OpensteerAgentConfigError(
            'Anthropic CUA requires an API key via agent.model.apiKey or ANTHROPIC_API_KEY.'
        )
    }

    const googleApiKey =
        normalizeOptional(env.GOOGLE_GENERATIVE_AI_API_KEY) ||
        normalizeOptional(env.GEMINI_API_KEY) ||
        normalizeOptional(env.GOOGLE_API_KEY)

    if (googleApiKey) return googleApiKey

    throw new OpensteerAgentConfigError(
        'Google CUA requires an API key via agent.model.apiKey, GOOGLE_GENERATIVE_AI_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY.'
    )
}

function normalizeOptional(value: string | undefined): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed.length ? trimmed : undefined
}

function normalizeRequired(value: string | undefined, field: string): string {
    const normalized = normalizeOptional(value)
    if (!normalized) {
        throw new OpensteerAgentConfigError(`${field} is required.`)
    }

    return normalized
}
