import { generateObject } from 'ai'
import { z } from 'zod'
import { getModelProvider } from '../../src/ai/model.js'
import type { JudgeInput, JudgeVerdict, LiveWebRunConfig } from './types.js'

const verdictSchema = z.object({
    verdict: z.enum(['pass', 'fail', 'uncertain']),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
    missing: z.array(z.string()).default([]),
})

function buildJudgePrompt(input: JudgeInput): string {
    const payload = {
        scenario: input.scenario,
        checks: input.checks,
        evidence: input.evidence,
        traces: input.traces.map((trace) => ({
            step: trace.step,
            action: trace.action,
            description: trace.description,
            outcome: trace.outcome ?? null,
        })),
    }

    return JSON.stringify(payload, null, 2)
}

export async function runLiveWebJudge(
    input: JudgeInput,
    config: LiveWebRunConfig
): Promise<JudgeVerdict | null> {
    if (!config.judge.enabled) {
        return null
    }

    try {
        const modelProvider = await getModelProvider(config.judge.model)
        const response = await generateObject({
            model: modelProvider as Parameters<
                typeof generateObject
            >[0]['model'],
            schema: verdictSchema,
            temperature: 0,
            system:
                'You verify whether a browser automation task fully completed on a live website. ' +
                'Use deterministic checks as the strongest signal: if any deterministic check failed, verdict should be fail. ' +
                'If deterministic checks passed but evidence is incomplete, return uncertain. ' +
                'Return concise reasoning and list missing evidence labels in missing.',
            prompt: buildJudgePrompt(input),
        })

        return response.object
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        if (config.judge.mode === 'strict') {
            throw new Error(`Live Web judge failed: ${message}`)
        }

        return {
            verdict: 'uncertain',
            confidence: 0,
            reasoning: `Judge unavailable in advisory mode: ${message}`,
            missing: ['judge_unavailable'],
        }
    }
}
