import type {
    OpensteerAgentAction,
    OpensteerAgentExecuteOptions,
    OpensteerAgentResult,
    OpensteerAgentUsage,
} from '../types.js'

export interface CuaClientExecutionInput {
    instruction: string
    maxSteps: number
    systemPrompt: string
}

export interface CuaClientExecutionResult
    extends Omit<OpensteerAgentResult, 'provider' | 'model'> {
    usage?: OpensteerAgentUsage
}

export abstract class CuaClient {
    private screenshotProvider: (() => Promise<string>) | null = null
    private actionHandler: ((action: OpensteerAgentAction) => Promise<void>) | null =
        null

    protected viewport = {
        width: 1288,
        height: 711,
    }

    protected currentUrl: string | null = null

    setViewport(width: number, height: number): void {
        this.viewport = {
            width,
            height,
        }
    }

    setCurrentUrl(url: string | null): void {
        this.currentUrl = url
    }

    setScreenshotProvider(provider: () => Promise<string>): void {
        this.screenshotProvider = provider
    }

    setActionHandler(handler: (action: OpensteerAgentAction) => Promise<void>): void {
        this.actionHandler = handler
    }

    protected getScreenshotProvider(): () => Promise<string> {
        if (!this.screenshotProvider) {
            throw new Error('CUA screenshot provider is not initialized.')
        }

        return this.screenshotProvider
    }

    protected getActionHandler(): (action: OpensteerAgentAction) => Promise<void> {
        if (!this.actionHandler) {
            throw new Error('CUA action handler is not initialized.')
        }

        return this.actionHandler
    }

    abstract execute(input: CuaClientExecutionInput): Promise<CuaClientExecutionResult>
}

export function normalizeExecuteOptions(
    instructionOrOptions: string | OpensteerAgentExecuteOptions
): OpensteerAgentExecuteOptions {
    if (typeof instructionOrOptions === 'string') {
        return {
            instruction: instructionOrOptions,
        }
    }

    return instructionOrOptions
}
