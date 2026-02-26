import { describe, expect, it, vi } from 'vitest'
import type { BrowserContext, CDPSession, Page } from 'playwright'
import {
    StealthWaitUnavailableError,
    waitForVisualStability,
    waitForVisualStabilityAcrossFrames,
} from '../../src/navigation.js'

interface FakeCdpOptions {
    evaluate?: () => Promise<unknown>
}

function createFakePage(options: FakeCdpOptions = {}): {
    page: Page
    send: ReturnType<typeof vi.fn>
} {
    const send = vi.fn(async (method: string) => {
        if (method === 'Page.enable') return {}
        if (method === 'Runtime.enable') return {}
        if (method === 'DOM.enable') return {}

        if (method === 'Page.getFrameTree') {
            return {
                frameTree: {
                    frame: {
                        id: 'main-frame',
                    },
                },
            }
        }

        if (method === 'Page.createIsolatedWorld') {
            return {
                executionContextId: 1,
            }
        }

        if (method === 'Runtime.evaluate') {
            if (options.evaluate) {
                await options.evaluate()
            }

            return {
                result: {
                    value: true,
                },
            }
        }

        throw new Error(`Unhandled CDP method in test: ${method}`)
    })

    const session = {
        send,
        detach: vi.fn(async () => {}),
    } as unknown as CDPSession

    const context = {
        browser: () => ({
            browserType: () => ({
                name: () => 'chromium',
            }),
        }),
        newCDPSession: vi.fn(async () => session),
    } as unknown as BrowserContext

    const page = {
        context: () => context,
    } as unknown as Page

    return {
        page,
        send,
    }
}

function runtimeEvaluateCallCount(send: ReturnType<typeof vi.fn>): number {
    return send.mock.calls.filter(
        (call: unknown[]) => call[0] === 'Runtime.evaluate'
    ).length
}

describe('navigation/waitForVisualStability guards', () => {
    it('retries transient execution-context destruction and resolves', async () => {
        let attempts = 0
        const { page, send } = createFakePage({
            evaluate: async () => {
                attempts += 1
                if (attempts === 1) {
                    throw new Error('Execution context was destroyed')
                }
            },
        })

        await waitForVisualStability(page, {
            timeout: 1000,
            settleMs: 40,
        })

        expect(runtimeEvaluateCallCount(send)).toBe(2)
    })

    it('returns within timeout when transient context churn persists', async () => {
        const { page, send } = createFakePage({
            evaluate: async () => {
                throw new Error('Execution context was destroyed')
            },
        })

        const startedAt = Date.now()
        await waitForVisualStability(page, {
            timeout: 220,
            settleMs: 40,
        })
        const elapsed = Date.now() - startedAt

        expect(elapsed).toBeGreaterThanOrEqual(180)
        expect(elapsed).toBeLessThan(1400)
        expect(runtimeEvaluateCallCount(send)).toBeGreaterThan(1)
    })
})

describe('navigation/waitForVisualStabilityAcrossFrames guards', () => {
    it('returns within timeout when isolated-world evaluate never settles', async () => {
        const { page, send } = createFakePage({
            evaluate: () => new Promise(() => {}),
        })

        const startedAt = Date.now()
        await waitForVisualStabilityAcrossFrames(page, {
            timeout: 220,
            settleMs: 40,
        })
        const elapsed = Date.now() - startedAt

        expect(elapsed).toBeGreaterThanOrEqual(180)
        expect(elapsed).toBeLessThan(1400)
        expect(runtimeEvaluateCallCount(send)).toBe(1)
    })

    it('resolves quickly when isolated-world evaluate settles immediately', async () => {
        const { page, send } = createFakePage({
            evaluate: async () => undefined,
        })

        const startedAt = Date.now()
        await waitForVisualStabilityAcrossFrames(page, {
            timeout: 1000,
            settleMs: 40,
        })
        const elapsed = Date.now() - startedAt

        expect(elapsed).toBeLessThan(250)
        expect(runtimeEvaluateCallCount(send)).toBe(1)
    })

    it('ignores detached-context errors', async () => {
        const { page, send } = createFakePage({
            evaluate: async () => {
                throw new Error('Execution context was destroyed')
            },
        })

        await waitForVisualStabilityAcrossFrames(page, {
            timeout: 500,
            settleMs: 40,
        })

        expect(runtimeEvaluateCallCount(send)).toBe(1)
    })

    it('fails fast when Chromium CDP is unavailable', async () => {
        const context = {
            browser: () => ({
                browserType: () => ({
                    name: () => 'webkit',
                }),
            }),
            newCDPSession: vi.fn(async () => {
                throw new Error('CDP sessions are only supported in Chromium')
            }),
        } as unknown as BrowserContext

        const page = {
            context: () => context,
        } as unknown as Page

        await expect(
            waitForVisualStabilityAcrossFrames(page, {
                timeout: 500,
                settleMs: 40,
            })
        ).rejects.toBeInstanceOf(StealthWaitUnavailableError)
    })
})
