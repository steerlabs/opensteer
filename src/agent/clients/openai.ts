import OpenAI from 'openai'
import type {
    Response,
    ResponseCreateParamsNonStreaming,
    ResponseOutputItem,
} from 'openai/resources/responses/responses.js'
import { CuaClient, type CuaClientExecutionInput, type CuaClientExecutionResult } from '../client.js'
import type { ResolvedCuaModelConfig } from '../model.js'
import type { OpensteerAgentAction } from '../../types.js'
import { OpensteerAgentApiError } from '../errors.js'

export class OpenAICuaClient extends CuaClient {
    private readonly client: OpenAI
    private readonly modelConfig: ResolvedCuaModelConfig

    constructor(modelConfig: ResolvedCuaModelConfig) {
        super()
        this.modelConfig = modelConfig
        this.client = new OpenAI({
            apiKey: modelConfig.apiKey,
            baseURL: modelConfig.baseUrl,
            organization: modelConfig.organization,
        })
    }

    async execute(
        input: CuaClientExecutionInput
    ): Promise<CuaClientExecutionResult> {
        const actions: OpensteerAgentAction[] = []
        let finalMessage = ''
        let completed = false
        let step = 0
        let previousResponseId: string | undefined
        let nextInputItems: Array<Record<string, unknown>> = [
            {
                role: 'system',
                content: input.systemPrompt,
            },
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
            const response = await this.getAction(nextInputItems, previousResponseId)
            totalInferenceTimeMs += Date.now() - startedAt

            totalInputTokens += toNumber(response.usage?.input_tokens)
            totalOutputTokens += toNumber(response.usage?.output_tokens)
            totalReasoningTokens +=
                toNumber(response.usage?.output_tokens_details?.reasoning_tokens) ||
                toNumber(toRecord(response.usage).reasoning_tokens)

            previousResponseId = normalizeString(response.id) || previousResponseId

            const stepResult = await this.processResponse(response.output)

            actions.push(...stepResult.actions)
            nextInputItems = stepResult.nextInputItems
            completed = stepResult.completed

            if (stepResult.message) {
                finalMessage = stepResult.message
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

    private async getAction(
        inputItems: Array<Record<string, unknown>>,
        previousResponseId?: string
    ): Promise<Response> {
        const request: ResponseCreateParamsNonStreaming = {
            model: this.modelConfig.providerModelName,
            tools: [
                {
                    type: 'computer_use_preview',
                    display_width: this.viewport.width,
                    display_height: this.viewport.height,
                    environment: 'browser',
                },
            ],
            input: inputItems as unknown as ResponseCreateParamsNonStreaming['input'],
            truncation: 'auto',
            ...(previousResponseId
                ? { previous_response_id: previousResponseId }
                : {}),
        }

        try {
            return await this.client.responses.create(request)
        } catch (error) {
            throw mapOpenAiApiError(error)
        }
    }

    private async processResponse(
        output: ResponseOutputItem[]
    ): Promise<{
        actions: OpensteerAgentAction[]
        nextInputItems: Array<Record<string, unknown>>
        completed: boolean
        message: string
    }> {
        const actions: OpensteerAgentAction[] = []
        const nextInputItems: Array<Record<string, unknown>> = []
        const messageParts: string[] = []

        let hasComputerAction = false

        for (const item of output) {
            if (item.type === 'computer_call') {
                hasComputerAction = true

                const action = toAgentAction(item.action)
                actions.push(action)

                let actionError: string | undefined
                try {
                    await this.getActionHandler()(action)
                } catch (error) {
                    actionError =
                        error instanceof Error ? error.message : String(error)
                }

                const outputItem: Record<string, unknown> = {
                    type: 'computer_call_output',
                    call_id: item.call_id,
                }

                const safetyChecks = item.pending_safety_checks.length
                    ? item.pending_safety_checks
                    : undefined

                const screenshotDataUrl = await this.captureScreenshotDataUrl()
                const outputPayload: Record<string, unknown> = {
                    type: 'input_image',
                    image_url: screenshotDataUrl,
                }

                if (this.currentUrl) {
                    outputPayload.current_url = this.currentUrl
                }
                if (actionError) {
                    outputPayload.error = actionError
                }

                outputItem.output = outputPayload

                if (safetyChecks) {
                    outputItem.acknowledged_safety_checks = safetyChecks
                }

                nextInputItems.push(outputItem)
            }

            if (item.type === 'message') {
                for (const content of item.content) {
                    if (content.type === 'output_text') {
                        messageParts.push(content.text)
                    }
                }
            }
        }

        return {
            actions,
            nextInputItems,
            completed: !hasComputerAction,
            message: messageParts.join('\n').trim(),
        }
    }

    private async captureScreenshotDataUrl(): Promise<string> {
        const base64 = await this.getScreenshotProvider()()
        return `data:image/png;base64,${base64}`
    }
}

function toAgentAction(action: unknown): OpensteerAgentAction {
    const actionRecord = toRecord(action)
    return {
        type: normalizeString(actionRecord.type) || 'unknown',
        ...actionRecord,
    }
}

function mapOpenAiApiError(error: unknown): OpensteerAgentApiError {
    const errorRecord = toRecord(error)
    const nestedError = toRecord(errorRecord.error)
    const status = toNumber(errorRecord.status)
    const message =
        normalizeString(nestedError.message) ||
        (error instanceof Error ? error.message : String(error))

    return new OpensteerAgentApiError('openai', message, status, error)
}

function toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {}
}

function toNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const normalized = value.trim()
    return normalized.length ? normalized : undefined
}
