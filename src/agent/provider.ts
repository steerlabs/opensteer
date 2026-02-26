import type { OpensteerAgentConfig } from '../types.js'
import {
    OpensteerAgentConfigError,
    OpensteerAgentProviderError,
} from './errors.js'
import { resolveCuaModelConfig, type ResolvedCuaModelConfig } from './model.js'
import { CuaClient } from './client.js'
import { OpenAICuaClient } from './clients/openai.js'
import { AnthropicCuaClient } from './clients/anthropic.js'
import { GoogleCuaClient } from './clients/google.js'

const DEFAULT_SYSTEM_PROMPT =
    'You are a browser automation agent. Complete the user instruction safely and efficiently. Do not ask follow-up questions. Finish as soon as the task is complete.'

export interface ResolvedAgentConfig {
    mode: 'cua'
    systemPrompt: string
    waitBetweenActionsMs: number
    model: ResolvedCuaModelConfig
}

export function resolveAgentConfig(args: {
    agentConfig: OpensteerAgentConfig
    fallbackModel?: string
    env?: NodeJS.ProcessEnv
}): ResolvedAgentConfig {
    const { agentConfig } = args

    if (!agentConfig || typeof agentConfig !== 'object') {
        throw new OpensteerAgentConfigError(
            'agent() requires a configuration object with mode: "cua".'
        )
    }

    if (agentConfig.mode !== 'cua') {
        throw new OpensteerAgentConfigError(
            `Unsupported agent mode "${String(agentConfig.mode)}". OpenSteer currently supports only mode: "cua".`
        )
    }

    const model = resolveCuaModelConfig({
        agentConfig,
        fallbackModel: args.fallbackModel,
        env: args.env,
    })

    return {
        mode: 'cua',
        systemPrompt:
            normalizeNonEmptyString(agentConfig.systemPrompt) ||
            DEFAULT_SYSTEM_PROMPT,
        waitBetweenActionsMs: normalizeWaitBetween(agentConfig.waitBetweenActionsMs),
        model,
    }
}

export function createCuaClient(config: ResolvedAgentConfig): CuaClient {
    switch (config.model.provider) {
        case 'openai':
            return new OpenAICuaClient(config.model)
        case 'anthropic':
            return new AnthropicCuaClient(config.model)
        case 'google':
            return new GoogleCuaClient(config.model)
        default:
            throw new OpensteerAgentProviderError(
                `Unsupported CUA provider "${String(config.model.provider)}".`
            )
    }
}

function normalizeNonEmptyString(value: string | undefined): string | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized.length ? normalized : undefined
}

function normalizeWaitBetween(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return 500
    }

    return Math.floor(value)
}
