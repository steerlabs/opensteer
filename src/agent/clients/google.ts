import {
    Environment,
    GoogleGenAI,
    type GenerateContentParameters,
    type GenerateContentResponse,
} from '@google/genai'
import { CuaClient, type CuaClientExecutionInput, type CuaClientExecutionResult } from '../client.js'
import type { ResolvedCuaModelConfig } from '../model.js'
import type { OpensteerAgentAction } from '../../types.js'
import { maybeNormalizeCoordinates } from '../coords.js'
import { mapKeyToPlaywright } from '../key-mapping.js'
import { OpensteerAgentApiError } from '../errors.js'

type GoogleHistoryItem = {
    role: 'user' | 'model'
    parts: Array<Record<string, unknown>>
}

export class GoogleCuaClient extends CuaClient {
    private readonly modelConfig: ResolvedCuaModelConfig
    private readonly client: GoogleGenAI
    private history: GoogleHistoryItem[] = []

    constructor(modelConfig: ResolvedCuaModelConfig) {
        super()
        this.modelConfig = modelConfig
        this.client = new GoogleGenAI({
            apiKey: modelConfig.apiKey,
            ...(modelConfig.baseUrl
                ? { httpOptions: { baseUrl: modelConfig.baseUrl } }
                : {}),
        })
    }

    async execute(
        input: CuaClientExecutionInput
    ): Promise<CuaClientExecutionResult> {
        this.history = [
            {
                role: 'user',
                parts: [
                    {
                        text: `System prompt: ${input.systemPrompt}`,
                    },
                ],
            },
            {
                role: 'user',
                parts: [
                    {
                        text: input.instruction,
                    },
                ],
            },
        ]

        const actions: OpensteerAgentAction[] = []
        let finalMessage = ''
        let completed = false
        let step = 0
        let totalInputTokens = 0
        let totalOutputTokens = 0
        let totalInferenceTimeMs = 0

        while (!completed && step < input.maxSteps) {
            const startedAt = Date.now()
            const response = await this.generateContent()
            totalInferenceTimeMs += Date.now() - startedAt

            const usageMetadata = (response.usageMetadata || {}) as Record<
                string,
                unknown
            >
            totalInputTokens += toNumber(usageMetadata.promptTokenCount)
            totalOutputTokens += toNumber(usageMetadata.candidatesTokenCount)

            const candidate = Array.isArray(response.candidates)
                ? response.candidates[0]
                : null
            const content =
                candidate &&
                typeof candidate === 'object' &&
                candidate.content &&
                typeof candidate.content === 'object'
                    ? (candidate.content as Record<string, unknown>)
                    : null

            const parts =
                content && Array.isArray(content.parts)
                    ? (content.parts as Array<Record<string, unknown>>)
                    : []

            if (content) {
                this.history.push({
                    role: 'model',
                    parts,
                })
            }

            const messageParts: string[] = []
            const functionCalls: Array<Record<string, unknown>> = []

            for (const part of parts) {
                if (typeof part.text === 'string') {
                    messageParts.push(part.text)
                }

                if (part.functionCall && typeof part.functionCall === 'object') {
                    functionCalls.push(part.functionCall as Record<string, unknown>)
                }
            }

            if (messageParts.length) {
                finalMessage = messageParts.join('\n').trim()
            }

            if (!functionCalls.length) {
                completed = true
            } else {
                const functionResponses: Array<Record<string, unknown>> = []

                for (const functionCall of functionCalls) {
                    const mappedActions = mapGoogleFunctionCallToActions(
                        functionCall,
                        this.viewport
                    )

                    if (!mappedActions.length) {
                        continue
                    }

                    actions.push(...mappedActions)

                    let executionError: string | undefined
                    for (const mappedAction of mappedActions) {
                        try {
                            await this.getActionHandler()(mappedAction)
                        } catch (error) {
                            executionError =
                                error instanceof Error
                                    ? error.message
                                    : String(error)
                        }
                    }

                    const screenshotBase64 = await this.getScreenshotProvider()()
                    const responsePayload: Record<string, unknown> = {
                        url: this.currentUrl || '',
                    }

                    const args =
                        functionCall.args && typeof functionCall.args === 'object'
                            ? (functionCall.args as Record<string, unknown>)
                            : null

                    if (args && args.safety_decision !== undefined) {
                        responsePayload.safety_acknowledgement = 'true'
                    }
                    if (executionError) {
                        responsePayload.error = executionError
                    }

                    functionResponses.push({
                        functionResponse: {
                            name:
                                (typeof functionCall.name === 'string' &&
                                    functionCall.name) ||
                                'computer_use',
                            response: responsePayload,
                            parts: [
                                {
                                    inlineData: {
                                        mimeType: 'image/png',
                                        data: screenshotBase64,
                                    },
                                },
                            ],
                        },
                    })
                }

                if (functionResponses.length) {
                    this.history.push({
                        role: 'user',
                        parts: functionResponses,
                    })
                }

                const finishReason =
                    candidate && typeof candidate === 'object'
                        ? normalizeString(candidate.finishReason)
                        : undefined

                completed =
                    functionCalls.length === 0 ||
                    (typeof finishReason === 'string' && finishReason !== 'STOP')
            }

            step += 1
        }

        return {
            success: completed,
            completed,
            message: finalMessage,
            actions,
            usage: {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
                inferenceTimeMs: totalInferenceTimeMs,
            },
        }
    }

    private async generateContent(): Promise<GenerateContentResponse> {
        const params: GenerateContentParameters = {
            model: this.modelConfig.providerModelName,
            contents:
                this.history as GenerateContentParameters['contents'],
            config: {
                temperature: 1,
                topP: 0.95,
                topK: 40,
                maxOutputTokens: 8192,
                tools: [
                    {
                        computerUse: {
                            environment: resolveGoogleEnvironment(
                                this.modelConfig.environment
                            ),
                        },
                    },
                ],
            },
        }

        try {
            return await this.client.models.generateContent(params)
        } catch (error) {
            throw mapGoogleApiError(error)
        }
    }
}

function mapGoogleFunctionCallToActions(
    functionCall: Record<string, unknown>,
    viewport: { width: number; height: number }
): OpensteerAgentAction[] {
    const name = normalizeString(functionCall.name)
    const args =
        functionCall.args && typeof functionCall.args === 'object'
            ? (functionCall.args as Record<string, unknown>)
            : {}

    if (!name) return []

    switch (name) {
        case 'click_at': {
            const coordinates = normalizeCoordinates(args, viewport)
            return [
                {
                    type: 'click',
                    x: coordinates.x,
                    y: coordinates.y,
                    button: normalizeString(args.button) || 'left',
                },
            ]
        }

        case 'type_text_at': {
            const coordinates = normalizeCoordinates(args, viewport)
            const clearBeforeTyping =
                typeof args.clear_before_typing === 'boolean'
                    ? args.clear_before_typing
                    : true
            const pressEnter =
                typeof args.press_enter === 'boolean' ? args.press_enter : false

            const actions: OpensteerAgentAction[] = [
                {
                    type: 'click',
                    x: coordinates.x,
                    y: coordinates.y,
                    button: 'left',
                },
            ]

            if (clearBeforeTyping) {
                actions.push({
                    type: 'keypress',
                    keys: ['ControlOrMeta+A'],
                })
                actions.push({
                    type: 'keypress',
                    keys: ['Backspace'],
                })
            }

            actions.push({
                type: 'type',
                text: normalizeString(args.text) || '',
                x: coordinates.x,
                y: coordinates.y,
            })

            if (pressEnter) {
                actions.push({
                    type: 'keypress',
                    keys: ['Enter'],
                })
            }

            return actions
        }

        case 'key_combination': {
            const keysRaw = normalizeString(args.keys) || ''
            const keys = keysRaw
                .split('+')
                .map((part) => part.trim())
                .filter(Boolean)
                .map((part) => mapKeyToPlaywright(part))

            return [
                {
                    type: 'keypress',
                    keys,
                },
            ]
        }

        case 'scroll_document': {
            const direction = normalizeString(args.direction) || 'down'
            return [
                {
                    type: 'keypress',
                    keys: [direction === 'up' ? 'PageUp' : 'PageDown'],
                },
            ]
        }

        case 'scroll_at': {
            const coordinates = normalizeCoordinates(args, viewport)
            const direction = normalizeString(args.direction) || 'down'
            const magnitude =
                typeof args.magnitude === 'number' && Number.isFinite(args.magnitude)
                    ? Math.max(1, args.magnitude)
                    : 800

            let scrollX = 0
            let scrollY = 0
            if (direction === 'up') scrollY = -magnitude
            if (direction === 'down') scrollY = magnitude
            if (direction === 'left') scrollX = -magnitude
            if (direction === 'right') scrollX = magnitude

            return [
                {
                    type: 'scroll',
                    x: coordinates.x,
                    y: coordinates.y,
                    scrollX,
                    scrollY,
                },
            ]
        }

        case 'hover_at': {
            const coordinates = normalizeCoordinates(args, viewport)
            return [
                {
                    type: 'move',
                    x: coordinates.x,
                    y: coordinates.y,
                },
            ]
        }

        case 'drag_and_drop': {
            const start = maybeNormalizeCoordinates(
                'google',
                toNumber(args.x),
                toNumber(args.y),
                viewport
            )
            const end = maybeNormalizeCoordinates(
                'google',
                toNumber(args.destination_x),
                toNumber(args.destination_y),
                viewport
            )
            return [
                {
                    type: 'drag',
                    path: [start, end],
                },
            ]
        }

        case 'navigate':
            return [
                {
                    type: 'goto',
                    url: normalizeString(args.url) || '',
                },
            ]

        case 'go_back':
            return [{ type: 'back' }]

        case 'go_forward':
            return [{ type: 'forward' }]

        case 'wait_5_seconds':
            return [{ type: 'wait', timeMs: 5000 }]

        case 'search':
            return [{ type: 'goto', url: 'https://www.google.com' }]

        case 'open_web_browser':
            return [{ type: 'open_web_browser' }]

        default:
            return []
    }
}

function normalizeCoordinates(
    args: Record<string, unknown>,
    viewport: { width: number; height: number }
): { x: number; y: number } {
    return maybeNormalizeCoordinates(
        'google',
        toNumber(args.x),
        toNumber(args.y),
        viewport
    )
}

function toNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized.length ? normalized : undefined
}

function resolveGoogleEnvironment(value: unknown): Environment {
    const environment = normalizeString(value)
    if (environment === Environment.ENVIRONMENT_UNSPECIFIED) {
        return Environment.ENVIRONMENT_UNSPECIFIED
    }

    return Environment.ENVIRONMENT_BROWSER
}

function mapGoogleApiError(error: unknown): OpensteerAgentApiError {
    const errorRecord = toRecord(error)
    const status =
        typeof errorRecord.status === 'number'
            ? errorRecord.status
            : undefined
    const message =
        normalizeString(errorRecord.message) ||
        (error instanceof Error ? error.message : String(error))

    return new OpensteerAgentApiError('google', message, status, error)
}

function toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {}
}
