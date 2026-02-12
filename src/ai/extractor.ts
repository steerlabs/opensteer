import type { AiExtractCallback, ExtractionPlan } from '../types.js'
import { flattenExtractionDataToFieldPlan } from '../extract-field-plan.js'
import { getModelProvider } from './model.js'
import { buildExtractSystemPrompt, buildExtractUserPrompt } from './prompts.js'

export function createExtractCallback(
    model: string,
    options?: { temperature?: number; maxTokens?: number | null }
): AiExtractCallback {
    const temperature = options?.temperature ?? 1
    const maxTokens = options?.maxTokens ?? null

    return async (args) => {
        let generateText: (typeof import('ai'))['generateText']
        try {
            const aiMod = await import('ai')
            generateText = aiMod.generateText
        } catch {
            throw new Error(
                `To use AI extraction with model '${model}', install: npm install ai`
            )
        }

        const modelProvider = await getModelProvider(model)

        const request = {
            model: modelProvider as Parameters<typeof generateText>[0]['model'],
            system: buildExtractSystemPrompt(),
            prompt: buildExtractUserPrompt(args),
            temperature,
            ...(maxTokens == null ? {} : { maxOutputTokens: maxTokens }),
        }

        const result = await generateText(request)

        const parsed = parseExtractResponse(result.text)

        if (!parsed.contains_data) {
            return { fields: {} } as ExtractionPlan
        }

        const fields = flattenExtractionDataToFieldPlan(parsed.data)

        return { fields } as ExtractionPlan
    }
}

function parseExtractResponse(text: string): {
    contains_data: boolean
    data: Record<string, unknown>
} {
    const trimmed = text.trim()
    const jsonStr = trimmed.startsWith('```')
        ? stripCodeFence(trimmed)
        : trimmed

    const parsed = JSON.parse(jsonStr)

    return {
        contains_data: Boolean(parsed.contains_data),
        data: parsed.data ?? {},
    }
}

function stripCodeFence(input: string): string {
    const firstBreak = input.indexOf('\n')
    if (firstBreak === -1) return input.replace(/```/g, '').trim()

    const body = input.slice(firstBreak + 1)
    const lastFence = body.lastIndexOf('```')
    if (lastFence === -1) return body.trim()

    return body.slice(0, lastFence).trim()
}
