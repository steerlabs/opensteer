import type { Page } from 'playwright'
import type {
    OpensteerAgentAction,
    OpensteerAgentExecuteOptions,
    OpensteerAgentResult,
} from '../types.js'
import { DEFAULT_CUA_VIEWPORT } from './coords.js'
import { CuaClient } from './client.js'
import {
    executeAgentAction,
    isMutatingAgentAction,
} from './action-executor.js'
import { OpensteerAgentExecutionError } from './errors.js'
import type { ResolvedAgentConfig } from './provider.js'
import type { CursorController } from '../cursor/controller.js'

interface CuaAgentHandlerOptions {
    page: Page
    config: ResolvedAgentConfig
    client: CuaClient
    cursorController: CursorController
    onMutatingAction?: (action: OpensteerAgentAction) => void
}

export class OpensteerCuaAgentHandler {
    private readonly page: Page
    private readonly config: ResolvedAgentConfig
    private readonly client: CuaClient
    private readonly cursorController: CursorController
    private readonly onMutatingAction?: (action: OpensteerAgentAction) => void

    constructor(options: CuaAgentHandlerOptions) {
        this.page = options.page
        this.config = options.config
        this.client = options.client
        this.cursorController = options.cursorController
        this.onMutatingAction = options.onMutatingAction
    }

    async execute(
        options: OpensteerAgentExecuteOptions
    ): Promise<OpensteerAgentResult> {
        const instruction = options.instruction
        const maxSteps = options.maxSteps ?? 20

        await this.initializeClient()

        this.client.setActionHandler(async (action) => {
            if (this.cursorController.isEnabled()) {
                await this.maybePreviewCursor(action)
            }

            await executeAgentAction(this.page, action)

            this.client.setCurrentUrl(this.page.url())

            if (isMutatingAgentAction(action)) {
                this.onMutatingAction?.(action)
            }

            await sleep(this.config.waitBetweenActionsMs)
        })

        try {
            const result = await this.client.execute({
                instruction,
                maxSteps,
                systemPrompt: this.config.systemPrompt,
            })

            return {
                ...result,
                provider: this.config.model.provider,
                model: this.config.model.fullModelName,
            }
        } catch (error) {
            throw new OpensteerAgentExecutionError(
                `CUA agent execution failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
                error
            )
        }
    }

    private async initializeClient(): Promise<void> {
        const viewport = await this.resolveViewport()
        this.client.setViewport(viewport.width, viewport.height)
        this.client.setCurrentUrl(this.page.url())
        await this.cursorController.attachPage(this.page)
        this.client.setScreenshotProvider(async () => {
            const buffer = await this.page.screenshot({
                fullPage: false,
                type: 'png',
            })
            return buffer.toString('base64')
        })
    }

    private async resolveViewport(): Promise<{ width: number; height: number }> {
        const directViewport = this.page.viewportSize()
        if (directViewport?.width && directViewport?.height) {
            return directViewport
        }

        try {
            const evaluated = await this.page.evaluate(() => ({
                width: window.innerWidth,
                height: window.innerHeight,
            }))

            if (
                evaluated &&
                typeof evaluated === 'object' &&
                typeof evaluated.width === 'number' &&
                typeof evaluated.height === 'number' &&
                evaluated.width > 0 &&
                evaluated.height > 0
            ) {
                return {
                    width: Math.floor(evaluated.width),
                    height: Math.floor(evaluated.height),
                }
            }
        } catch {}

        return DEFAULT_CUA_VIEWPORT
    }

    private async maybePreviewCursor(action: OpensteerAgentAction): Promise<void> {
        const x = typeof action.x === 'number' ? action.x : null
        const y = typeof action.y === 'number' ? action.y : null

        if (x == null || y == null) {
            return
        }

        await this.cursorController.preview({ x, y }, 'agent')
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}
