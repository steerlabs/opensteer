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

interface CuaAgentHandlerOptions {
    page: Page
    config: ResolvedAgentConfig
    client: CuaClient
    debug: boolean
    onMutatingAction?: (action: OpensteerAgentAction) => void
}

export class OpensteerCuaAgentHandler {
    private readonly page: Page
    private readonly config: ResolvedAgentConfig
    private readonly client: CuaClient
    private readonly debug: boolean
    private readonly onMutatingAction?: (action: OpensteerAgentAction) => void
    private cursorOverlayInjected = false

    constructor(options: CuaAgentHandlerOptions) {
        this.page = options.page
        this.config = options.config
        this.client = options.client
        this.debug = options.debug
        this.onMutatingAction = options.onMutatingAction
    }

    async execute(
        options: OpensteerAgentExecuteOptions
    ): Promise<OpensteerAgentResult> {
        const instruction = options.instruction
        const maxSteps = options.maxSteps ?? 20

        await this.initializeClient()

        const highlightCursor = options.highlightCursor === true

        this.client.setActionHandler(async (action) => {
            if (highlightCursor) {
                await this.maybeRenderCursor(action)
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

    private async maybeRenderCursor(action: OpensteerAgentAction): Promise<void> {
        const x = typeof action.x === 'number' ? action.x : null
        const y = typeof action.y === 'number' ? action.y : null

        if (x == null || y == null) {
            return
        }

        try {
            if (!this.cursorOverlayInjected) {
                await this.page.evaluate(() => {
                    if (document.getElementById('__opensteer_cua_cursor')) return

                    const cursor = document.createElement('div')
                    cursor.id = '__opensteer_cua_cursor'
                    cursor.style.position = 'fixed'
                    cursor.style.width = '14px'
                    cursor.style.height = '14px'
                    cursor.style.borderRadius = '999px'
                    cursor.style.background = 'rgba(255, 51, 51, 0.85)'
                    cursor.style.border = '2px solid rgba(255, 255, 255, 0.95)'
                    cursor.style.boxShadow = '0 0 0 3px rgba(255, 51, 51, 0.25)'
                    cursor.style.pointerEvents = 'none'
                    cursor.style.zIndex = '2147483647'
                    cursor.style.transform = 'translate(-9999px, -9999px)'
                    cursor.style.transition = 'transform 80ms linear'
                    document.documentElement.appendChild(cursor)
                })
                this.cursorOverlayInjected = true
            }

            await this.page.evaluate(
                ({ px, py }) => {
                    const cursor = document.getElementById('__opensteer_cua_cursor')
                    if (!cursor) return
                    cursor.style.transform = `translate(${Math.round(px - 7)}px, ${Math.round(py - 7)}px)`
                },
                { px: x, py: y }
            )
        } catch (error) {
            if (this.debug) {
                const message =
                    error instanceof Error ? error.message : String(error)
                console.warn(`[opensteer] cursor overlay failed: ${message}`)
            }
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}
