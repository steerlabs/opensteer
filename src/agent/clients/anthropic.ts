import Anthropic from '@anthropic-ai/sdk'
import type {
    BetaMessage,
    MessageCreateParamsNonStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.js'
import { CuaClient, type CuaClientExecutionInput, type CuaClientExecutionResult } from '../client.js'
import type { ResolvedCuaModelConfig } from '../model.js'
import type { OpensteerAgentAction } from '../../types.js'
import { OpensteerAgentApiError } from '../errors.js'

type ConversationMessage = {
    role: 'user' | 'assistant'
    content: unknown
}

export class AnthropicCuaClient extends CuaClient {
    private readonly modelConfig: ResolvedCuaModelConfig
    private readonly client: Anthropic

    constructor(modelConfig: ResolvedCuaModelConfig) {
        super()
        this.modelConfig = modelConfig
        this.client = new Anthropic({
            apiKey: modelConfig.apiKey,
            baseURL: modelConfig.baseUrl,
        })
    }

    async execute(
        input: CuaClientExecutionInput
    ): Promise<CuaClientExecutionResult> {
        const actions: OpensteerAgentAction[] = []
        let finalMessage = ''
        let completed = false
        let step = 0

        const messages: ConversationMessage[] = [
            {
                role: 'user',
                content: input.instruction,
            },
        ]

        let totalInputTokens = 0
        let totalOutputTokens = 0
        let totalReasoningTokens = 0
        let totalInferenceTimeMs = 0

        while (!completed && step < input.maxSteps) {
            const startedAt = Date.now()
            const response = await this.getAction(messages, input.systemPrompt)
            totalInferenceTimeMs += Date.now() - startedAt

            totalInputTokens += toNumber(response?.usage?.input_tokens)
            totalOutputTokens += toNumber(response?.usage?.output_tokens)
            totalReasoningTokens +=
                toNumber(toRecord(response.usage).reasoning_tokens)

            const content = response.content.map((item) => toRecord(item))

            const toolUseItems = content.filter(
                (item) => item.type === 'tool_use' && item.name === 'computer'
            )

            const message = extractTextMessage(content)
            if (message) {
                finalMessage = message
            }

            messages.push({
                role: 'assistant',
                content,
            })

            if (!toolUseItems.length) {
                completed = true
            } else {
                const stepResult = await this.processToolUseItems(toolUseItems)
                actions.push(...stepResult.actions)

                messages.push({
                    role: 'user',
                    content: stepResult.toolResults,
                })
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
                reasoningTokens:
                    totalReasoningTokens > 0 ? totalReasoningTokens : undefined,
                inferenceTimeMs: totalInferenceTimeMs,
            },
        }
    }

    private async processToolUseItems(
        items: Array<Record<string, unknown>>
    ): Promise<{
        actions: OpensteerAgentAction[]
        toolResults: Array<Record<string, unknown>>
    }> {
        const actions: OpensteerAgentAction[] = []
        const toolResults: Array<Record<string, unknown>> = []

        for (const item of items) {
            const toolUseId = normalizeString(item.id)
            const input =
                item.input && typeof item.input === 'object'
                    ? (item.input as Record<string, unknown>)
                    : {}

            const action = convertAnthropicAction(input)
            actions.push(action)

            let errorMessage: string | undefined
            try {
                await this.getActionHandler()(action)
            } catch (error) {
                errorMessage =
                    error instanceof Error ? error.message : String(error)
            }

            let imageBlock: Record<string, unknown> | null = null
            try {
                const screenshot = await this.getScreenshotProvider()()
                imageBlock = {
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: 'image/png',
                        data: screenshot,
                    },
                }
            } catch (error) {
                errorMessage =
                    errorMessage ||
                    (error instanceof Error ? error.message : String(error))
            }

            const resultContent: Array<Record<string, unknown>> = []
            if (imageBlock) {
                resultContent.push(imageBlock)
            }

            if (this.currentUrl) {
                resultContent.push({
                    type: 'text',
                    text: `Current URL: ${this.currentUrl}`,
                })
            }

            if (errorMessage) {
                resultContent.push({
                    type: 'text',
                    text: `Error: ${errorMessage}`,
                })
            }

            toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUseId || 'unknown_tool_use_id',
                content:
                    resultContent.length > 0
                        ? resultContent
                        : [
                              {
                                  type: 'text',
                                  text: 'Action completed.',
                              },
                          ],
            })
        }

        return {
            actions,
            toolResults,
        }
    }

    private async getAction(
        messages: ConversationMessage[],
        systemPrompt: string
    ): Promise<BetaMessage> {
        const toolVersion = requiresNewestAnthropicToolVersion(
            this.modelConfig.providerModelName
        )
            ? 'computer_20251124'
            : 'computer_20250124'
        const betaFlag =
            toolVersion === 'computer_20251124'
                ? 'computer-use-2025-11-24'
                : 'computer-use-2025-01-24'

        const request: Record<string, unknown> = {
            model: this.modelConfig.providerModelName,
            max_tokens: 4096,
            system: systemPrompt,
            messages,
            tools: [
                {
                    type: toolVersion,
                    name: 'computer',
                    display_width_px: this.viewport.width,
                    display_height_px: this.viewport.height,
                    display_number: 1,
                },
            ],
            betas: [betaFlag],
        }

        if (typeof this.modelConfig.thinkingBudget === 'number') {
            request.thinking = {
                type: 'enabled',
                budget_tokens: this.modelConfig.thinkingBudget,
            }
        }

        try {
            return await this.client.beta.messages.create(
                request as unknown as MessageCreateParamsNonStreaming
            )
        } catch (error) {
            throw mapAnthropicApiError(error)
        }
    }
}

function convertAnthropicAction(
    input: Record<string, unknown>
): OpensteerAgentAction {
    const type = normalizeString(input.action) || 'unknown'

    if (type === 'left_click') {
        return {
            type: 'click',
            x: numberFromCoordinate(input.coordinate, input.x, 0),
            y: numberFromCoordinate(input.coordinate, input.y, 1),
            button: 'left',
        }
    }

    if (type === 'double_click' || type === 'doubleClick') {
        return {
            type: 'double_click',
            x: numberFromCoordinate(input.coordinate, input.x, 0),
            y: numberFromCoordinate(input.coordinate, input.y, 1),
        }
    }

    if (type === 'drag' || type === 'left_click_drag') {
        const start = arrayNumber(input.start_coordinate)
        const end = arrayNumber(input.coordinate)
        return {
            type: 'drag',
            path: [
                {
                    x: Number.isFinite(start[0]) ? start[0] : 0,
                    y: Number.isFinite(start[1]) ? start[1] : 0,
                },
                {
                    x: Number.isFinite(end[0]) ? end[0] : 0,
                    y: Number.isFinite(end[1]) ? end[1] : 0,
                },
            ],
        }
    }

    if (type === 'scroll') {
        const direction = normalizeString(input.scroll_direction) || 'down'
        const amount =
            typeof input.scroll_amount === 'number' &&
            Number.isFinite(input.scroll_amount)
                ? input.scroll_amount
                : 5
        const magnitude = Math.max(1, amount) * 100

        let scrollX = 0
        let scrollY = 0

        if (direction === 'up') scrollY = -magnitude
        if (direction === 'down') scrollY = magnitude
        if (direction === 'left') scrollX = -magnitude
        if (direction === 'right') scrollX = magnitude

        return {
            type: 'scroll',
            x: numberFromCoordinate(input.coordinate, input.x, 0),
            y: numberFromCoordinate(input.coordinate, input.y, 1),
            scrollX,
            scrollY,
        }
    }

    if (type === 'keypress' || type === 'key') {
        const keyText = normalizeString(input.text) || 'Enter'
        return {
            type: 'keypress',
            keys: [keyText],
        }
    }

    if (type === 'move') {
        return {
            type: 'move',
            x: numberFromCoordinate(input.coordinate, input.x, 0),
            y: numberFromCoordinate(input.coordinate, input.y, 1),
        }
    }

    if (type === 'click') {
        return {
            type: 'click',
            x: numberFromCoordinate(input.coordinate, input.x, 0),
            y: numberFromCoordinate(input.coordinate, input.y, 1),
            button: normalizeString(input.button) || 'left',
        }
    }

    if (type === 'type') {
        return {
            type: 'type',
            text: normalizeString(input.text) || '',
            x: numberFromCoordinate(input.coordinate, input.x, 0),
            y: numberFromCoordinate(input.coordinate, input.y, 1),
        }
    }

    return {
        type,
        ...input,
    }
}

function extractTextMessage(content: Array<Record<string, unknown>>): string {
    const texts = content
        .filter((item) => item.type === 'text' && typeof item.text === 'string')
        .map((item) => String(item.text))

    return texts.join('\n').trim()
}

function requiresNewestAnthropicToolVersion(modelName: string): boolean {
    return (
        modelName === 'claude-opus-4-6' ||
        modelName === 'claude-sonnet-4-6' ||
        modelName === 'claude-opus-4-5-20251101'
    )
}

function normalizeString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized.length ? normalized : undefined
}

function toNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function arrayNumber(value: unknown): [number, number] {
    if (!Array.isArray(value)) return [NaN, NaN]
    return [
        typeof value[0] === 'number' ? value[0] : NaN,
        typeof value[1] === 'number' ? value[1] : NaN,
    ]
}

function numberFromCoordinate(
    coordinate: unknown,
    fallback: unknown,
    index: 0 | 1
): number {
    const [x, y] = arrayNumber(coordinate)
    if (index === 0 && Number.isFinite(x)) return x
    if (index === 1 && Number.isFinite(y)) return y
    if (typeof fallback === 'number' && Number.isFinite(fallback)) return fallback
    return 0
}

function mapAnthropicApiError(error: unknown): OpensteerAgentApiError {
    const errorRecord = toRecord(error)
    const nestedError = toRecord(errorRecord.error)
    const status =
        typeof errorRecord.status === 'number'
            ? errorRecord.status
            : undefined
    const message =
        normalizeString(nestedError.message) ||
        (error instanceof Error ? error.message : String(error))

    return new OpensteerAgentApiError('anthropic', message, status, error)
}

function toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {}
}
