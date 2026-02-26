import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpensteerAgentAction, OpensteerAgentResult } from '../../src/types.js'

let capturedActionHandler:
    | ((action: OpensteerAgentAction) => Promise<void>)
    | null = null

const fakeExecute = vi.fn<
    (
        input: {
            instruction: string
            maxSteps: number
            systemPrompt: string
        }
    ) => Promise<Omit<OpensteerAgentResult, 'provider' | 'model'>>
>()

vi.mock('../../src/agent/provider.js', () => ({
    resolveAgentConfig: vi.fn(() => ({
        mode: 'cua',
        systemPrompt: 'test system',
        waitBetweenActionsMs: 0,
        model: {
            provider: 'openai',
            fullModelName: 'openai/computer-use-preview',
            providerModelName: 'computer-use-preview',
            apiKey: 'sk-test',
        },
    })),
    createCuaClient: vi.fn(() => ({
        setViewport: vi.fn(),
        setCurrentUrl: vi.fn(),
        setScreenshotProvider: vi.fn(),
        setActionHandler: vi.fn((handler: (action: OpensteerAgentAction) => Promise<void>) => {
            capturedActionHandler = handler
        }),
        execute: fakeExecute,
    })),
}))

import { Opensteer } from '../../src/opensteer.js'

function createMockPage() {
    return {
        context: vi.fn(() => ({})),
        viewportSize: vi.fn(() => ({ width: 1200, height: 800 })),
        url: vi.fn(() => 'https://example.com'),
        screenshot: vi.fn().mockResolvedValue(Buffer.from('img')),
        evaluate: vi.fn().mockResolvedValue({ width: 1200, height: 800 }),
        mouse: {
            click: vi.fn().mockResolvedValue(undefined),
            move: vi.fn().mockResolvedValue(undefined),
            down: vi.fn().mockResolvedValue(undefined),
            up: vi.fn().mockResolvedValue(undefined),
            wheel: vi.fn().mockResolvedValue(undefined),
        },
        keyboard: {
            press: vi.fn().mockResolvedValue(undefined),
            type: vi.fn().mockResolvedValue(undefined),
            down: vi.fn().mockResolvedValue(undefined),
            up: vi.fn().mockResolvedValue(undefined),
        },
        goto: vi.fn().mockResolvedValue(undefined),
        goBack: vi.fn().mockResolvedValue(undefined),
        goForward: vi.fn().mockResolvedValue(undefined),
    }
}

describe('opensteer.agent', () => {
    beforeEach(() => {
        capturedActionHandler = null
        fakeExecute.mockReset()
    })

    it('executes cua agent actions through playwright page', async () => {
        const page = createMockPage()
        const opensteer = Opensteer.from(page as never)

        fakeExecute.mockImplementationOnce(async () => {
            if (!capturedActionHandler) {
                throw new Error('expected captured action handler')
            }

            await capturedActionHandler({
                type: 'click',
                x: 33,
                y: 44,
                button: 'left',
            })

            return {
                success: true,
                completed: true,
                message: 'done',
                actions: [{ type: 'click', x: 33, y: 44, button: 'left' }],
                usage: {
                    inputTokens: 1,
                    outputTokens: 1,
                    inferenceTimeMs: 1,
                },
            }
        })

        const agent = opensteer.agent({ mode: 'cua' })
        const result = await agent.execute('Click once')

        expect(result.success).toBe(true)
        expect(result.provider).toBe('openai')
        expect(page.mouse.click).toHaveBeenCalledWith(33, 44, {
            button: 'left',
            clickCount: 1,
        })
    })

    it('prevents concurrent executions on the same instance', async () => {
        const page = createMockPage()
        const opensteer = Opensteer.from(page as never)

        fakeExecute.mockImplementationOnce(
            async () =>
                new Promise((resolve) => {
                    setTimeout(() => {
                        resolve({
                            success: true,
                            completed: true,
                            message: 'done',
                            actions: [],
                        })
                    }, 50)
                })
        )

        const agent = opensteer.agent({ mode: 'cua' })
        const firstRun = agent.execute('long task')

        await expect(agent.execute('second task')).rejects.toThrow(
            'already in progress'
        )

        await expect(firstRun).resolves.toMatchObject({ success: true })
    })
})
