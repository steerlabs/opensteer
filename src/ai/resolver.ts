import type { AiResolveCallback } from '../types.js'
import type { RuntimeEnv } from '../config.js'
import { getModelProvider } from './model.js'
import { buildResolveSystemPrompt, buildResolveUserPrompt } from './prompts.js'

export function createResolveCallback(
    model: string,
    options?: {
        temperature?: number
        maxTokens?: number | null
        env?: RuntimeEnv
    }
): AiResolveCallback {
    const temperature = options?.temperature ?? 1
    const maxTokens = options?.maxTokens ?? null
    const env = options?.env

    return async (args) => {
        let generateObject: (typeof import('ai'))['generateObject']
        let z: typeof import('zod')
        try {
            const aiMod = await import('ai')
            generateObject = aiMod.generateObject
        } catch {
            throw new Error(
                `To use AI resolution with model '${model}', install 'ai' with your package manager.`
            )
        }
        try {
            z = await import('zod')
        } catch {
            throw new Error(
                `To use AI resolution with model '${model}', install 'zod' with your package manager.`
            )
        }

        const modelProvider = await getModelProvider(model, { env })

        const schema = z.object({
            element: z
                .number()
                .describe(
                    'Counter number of the matching element, or -1 if no match'
                ),
            confidence: z.number().describe('Confidence score from 0 to 1'),
            reasoning: z.string().describe('Brief explanation of the choice'),
        })

        const request = {
            model: modelProvider as Parameters<
                typeof generateObject
            >[0]['model'],
            schema,
            system: buildResolveSystemPrompt(),
            prompt: buildResolveUserPrompt(args),
            temperature,
            ...(maxTokens == null ? {} : { maxOutputTokens: maxTokens }),
        }

        const result = await generateObject(request)

        const { element, confidence } = result.object

        if (element < 0 || confidence < 0.1) {
            return null
        }

        return element
    }
}
