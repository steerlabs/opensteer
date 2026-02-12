import type { JudgeMode, LiveWebRunConfig } from './types.js'

const DEFAULT_MODEL = 'gpt-5.1'
const DEFAULT_JUDGE_FAIL_CONFIDENCE = 0.8

function parseBoolEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name]
    if (raw == null || raw.trim() === '') {
        return fallback
    }

    const normalized = raw.trim().toLowerCase()
    if (
        normalized === '1' ||
        normalized === 'true' ||
        normalized === 'yes' ||
        normalized === 'on'
    ) {
        return true
    }
    if (
        normalized === '0' ||
        normalized === 'false' ||
        normalized === 'no' ||
        normalized === 'off'
    ) {
        return false
    }

    throw new Error(
        `${name} must be one of: 1,0,true,false,yes,no,on,off. Received: ${raw}`
    )
}

function parseJudgeMode(raw: string | undefined): JudgeMode {
    const value = (raw || 'advisory').trim().toLowerCase()
    if (value === 'advisory' || value === 'strict') {
        return value
    }

    throw new Error(
        `LIVE_WEB_JUDGE_MODE must be "advisory" or "strict". Received: ${raw || ''}`
    )
}

function parseScenarioFilter(raw: string | undefined): Set<string> | null {
    if (!raw || raw.trim() === '') {
        return null
    }

    const ids = raw
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0)

    if (!ids.length) {
        return null
    }

    return new Set(ids)
}

function getRequiredApiKeyName(model: string): string {
    if (
        model.startsWith('gpt-') ||
        model.startsWith('o1-') ||
        model.startsWith('o3-') ||
        model.startsWith('o4-')
    ) {
        return 'OPENAI_API_KEY'
    }
    if (model.startsWith('claude-')) {
        return 'ANTHROPIC_API_KEY'
    }
    if (model.startsWith('gemini-')) {
        return 'GOOGLE_GENERATIVE_AI_API_KEY'
    }
    if (model.startsWith('grok-')) {
        return 'XAI_API_KEY'
    }
    if (model.startsWith('groq/')) {
        return 'GROQ_API_KEY'
    }

    return 'OPENAI_API_KEY'
}

function assertProviderKeyPresent(model: string, label: string): void {
    const keyName = getRequiredApiKeyName(model)
    const value = process.env[keyName]

    if (!value || value.trim() === '') {
        throw new Error(
            `LIVE_WEB is enabled and ${label} is "${model}", but ${keyName} is not set.`
        )
    }
}

export function loadLiveWebRunConfig(): LiveWebRunConfig {
    const enabled = parseBoolEnv('RUN_LIVE_WEB', false)

    const model = (
        process.env.LIVE_WEB_MODEL ||
        process.env.OPENSTEER_MODEL ||
        DEFAULT_MODEL
    ).trim()

    if (!model) {
        throw new Error('LIVE_WEB_MODEL must not be empty when RUN_LIVE_WEB=1.')
    }

    const scenarioFilter = parseScenarioFilter(process.env.LIVE_WEB_SCENARIOS)
    const judgeEnabled = parseBoolEnv('LIVE_WEB_JUDGE', true)
    const judgeMode = parseJudgeMode(process.env.LIVE_WEB_JUDGE_MODE)
    const judgeModel = (process.env.LIVE_WEB_JUDGE_MODEL || model).trim()

    if (!judgeModel) {
        throw new Error('LIVE_WEB_JUDGE_MODEL must not be empty.')
    }

    if (enabled) {
        assertProviderKeyPresent(model, 'LIVE_WEB_MODEL')
        if (judgeEnabled) {
            assertProviderKeyPresent(judgeModel, 'LIVE_WEB_JUDGE_MODEL')
        }
    }

    return {
        enabled,
        model,
        scenarioFilter,
        judge: {
            enabled: judgeEnabled,
            mode: judgeMode,
            model: judgeModel,
            failConfidence: DEFAULT_JUDGE_FAIL_CONFIDENCE,
        },
    }
}
