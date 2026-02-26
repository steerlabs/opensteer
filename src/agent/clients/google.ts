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
import { OpensteerAgentActionError, OpensteerAgentApiError } from '../errors.js'

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
            totalInputTokens += toFiniteNumberOrZero(usageMetadata.promptTokenCount)
            totalOutputTokens += toFiniteNumberOrZero(
                usageMetadata.candidatesTokenCount
            )

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
            const finishReason = extractFinishReason(candidate)

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
                completed = isSuccessfulGoogleFinishReason(finishReason)
                if (!completed && !finalMessage) {
                    finalMessage = `Google CUA stopped with finish reason: ${finishReason || 'unknown'}.`
                }
            } else {
                const functionResponses: Array<Record<string, unknown>> = []

                for (const functionCall of functionCalls) {
                    const mappedActions = mapGoogleFunctionCallToActions(
                        functionCall,
                        this.viewport
                    )
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

                if (finishReason && finishReason !== 'STOP') {
                    throw new OpensteerAgentActionError(
                        `Google CUA returned function calls with terminal finish reason "${finishReason}".`
                    )
                }

                completed = false
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

    if (!name) {
        throw new OpensteerAgentActionError(
            'Google CUA function call is missing a "name" value.'
        )
    }

    switch (name) {
        case 'click_at': {
            const coordinates = normalizeCoordinates(args, viewport, name)
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
            const coordinates = normalizeCoordinates(args, viewport, name)
            const clearBeforeTyping =
                typeof args.clear_before_typing === 'boolean'
                    ? args.clear_before_typing
                    : true
            const pressEnter =
                typeof args.press_enter === 'boolean' ? args.press_enter : false
            const text = normalizeRequiredString(
                args.text,
                'Google action "type_text_at" requires a non-empty "text" value.'
            )

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
                text,
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
            const keysRaw = normalizeRequiredString(
                args.keys,
                'Google action "key_combination" requires a non-empty "keys" value.'
            )
            const keys = keysRaw
                .split('+')
                .map((part) => part.trim())
                .filter(Boolean)
                .map((part) => mapKeyToPlaywright(part))
            if (!keys.length) {
                throw new OpensteerAgentActionError(
                    'Google action "key_combination" did not produce any key tokens.'
                )
            }

            return [
                {
                    type: 'keypress',
                    keys,
                },
            ]
        }

        case 'scroll_document': {
            const direction = normalizeVerticalDirection(
                args.direction,
                'scroll_document'
            )
            return [
                {
                    type: 'keypress',
                    keys: [direction === 'up' ? 'PageUp' : 'PageDown'],
                },
            ]
        }

        case 'scroll_at': {
            const coordinates = normalizeCoordinates(args, viewport, name)
            const direction = normalizeScrollDirection(args.direction, 'scroll_at')
            const magnitude = parsePositiveNumber(
                args.magnitude,
                'scroll_at',
                'magnitude'
            )

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
            const coordinates = normalizeCoordinates(args, viewport, name)
            return [
                {
                    type: 'move',
                    x: coordinates.x,
                    y: coordinates.y,
                },
            ]
        }

        case 'drag_and_drop': {
            const startX = parseRequiredNumber(args.x, 'drag_and_drop', 'x')
            const startY = parseRequiredNumber(args.y, 'drag_and_drop', 'y')
            const endX = parseRequiredNumber(
                args.destination_x,
                'drag_and_drop',
                'destination_x'
            )
            const endY = parseRequiredNumber(
                args.destination_y,
                'drag_and_drop',
                'destination_y'
            )
            const start = maybeNormalizeCoordinates(
                'google',
                startX,
                startY,
                viewport
            )
            const end = maybeNormalizeCoordinates(
                'google',
                endX,
                endY,
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
                    url: normalizeRequiredString(
                        args.url,
                        'Google action "navigate" requires a non-empty "url" value.'
                    ),
                },
            ]

        case 'go_back':
            return [{ type: 'back' }]

        case 'go_forward':
            return [{ type: 'forward' }]

        case 'wait_5_seconds':
            return [{ type: 'wait', timeMs: 5000 }]

        case 'search':
            return [
                {
                    type: 'goto',
                    url: buildGoogleSearchUrl(args),
                },
            ]

        case 'open_web_browser':
            return [{ type: 'open_web_browser' }]

        default:
            throw new OpensteerAgentActionError(
                `Unsupported Google CUA function call "${name}".`
            )
    }
}

function normalizeCoordinates(
    args: Record<string, unknown>,
    viewport: { width: number; height: number },
    actionName: string
): { x: number; y: number } {
    const x = parseRequiredNumber(args.x, actionName, 'x')
    const y = parseRequiredNumber(args.y, actionName, 'y')

    return maybeNormalizeCoordinates(
        'google',
        x,
        y,
        viewport
    )
}

function parseRequiredNumber(
    value: unknown,
    actionName: string,
    field: string
): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value
    }

    throw new OpensteerAgentActionError(
        `Google action "${actionName}" requires numeric "${field}" coordinates.`
    )
}

function parsePositiveNumber(
    value: unknown,
    actionName: string,
    field: string
): number {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return value
    }

    throw new OpensteerAgentActionError(
        `Google action "${actionName}" requires a positive numeric "${field}" value.`
    )
}

function toFiniteNumberOrZero(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized.length ? normalized : undefined
}

function normalizeRequiredString(value: unknown, errorMessage: string): string {
    const normalized = normalizeString(value)
    if (!normalized) {
        throw new OpensteerAgentActionError(errorMessage)
    }

    return normalized
}

function normalizeScrollDirection(
    value: unknown,
    actionName: string
): 'up' | 'down' | 'left' | 'right' {
    const direction = normalizeString(value)
    if (
        direction === 'up' ||
        direction === 'down' ||
        direction === 'left' ||
        direction === 'right'
    ) {
        return direction
    }

    throw new OpensteerAgentActionError(
        `Google action "${actionName}" requires "direction" to be one of: up, down, left, right.`
    )
}

function normalizeVerticalDirection(
    value: unknown,
    actionName: string
): 'up' | 'down' {
    const direction = normalizeString(value)
    if (direction === 'up' || direction === 'down') {
        return direction
    }

    throw new OpensteerAgentActionError(
        `Google action "${actionName}" requires "direction" to be "up" or "down".`
    )
}

function buildGoogleSearchUrl(args: Record<string, unknown>): string {
    const query = normalizeRequiredString(
        args.query ?? args.text,
        'Google action "search" requires a non-empty "query" value.'
    )
    return `https://www.google.com/search?q=${encodeURIComponent(query)}`
}

function extractFinishReason(candidate: unknown): string | undefined {
    if (!candidate || typeof candidate !== 'object') {
        return undefined
    }

    return normalizeString((candidate as Record<string, unknown>).finishReason)
}

function isSuccessfulGoogleFinishReason(finishReason: string | undefined): boolean {
    return !finishReason || finishReason === 'STOP'
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
