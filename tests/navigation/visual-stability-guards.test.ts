import { describe, expect, it, vi } from 'vitest'
import type { Frame, Page } from 'playwright'
import { waitForVisualStabilityAcrossFrames } from '../../src/navigation.js'

function createPageWithFrames(frames: Frame[]): Page {
    const main = frames[0]
    return {
        frames: () => frames,
        mainFrame: () => main,
    } as unknown as Page
}

describe('navigation/waitForVisualStabilityAcrossFrames guards', () => {
    it('returns within timeout when a frame evaluate call never settles', async () => {
        const frame = {
            evaluate: vi.fn(() => new Promise(() => {})),
        } as unknown as Frame
        const page = createPageWithFrames([frame])

        const startedAt = Date.now()
        await waitForVisualStabilityAcrossFrames(page, {
            timeout: 220,
            settleMs: 40,
        })
        const elapsed = Date.now() - startedAt

        expect(elapsed).toBeGreaterThanOrEqual(180)
        expect(elapsed).toBeLessThan(1400)
        expect(frame.evaluate).toHaveBeenCalledTimes(1)
    })

    it('resolves quickly when frame evaluate settles immediately', async () => {
        const frame = {
            evaluate: vi.fn(async () => undefined),
        } as unknown as Frame
        const page = createPageWithFrames([frame])

        const startedAt = Date.now()
        await waitForVisualStabilityAcrossFrames(page, {
            timeout: 1000,
            settleMs: 40,
        })
        const elapsed = Date.now() - startedAt

        expect(elapsed).toBeLessThan(250)
        expect(frame.evaluate).toHaveBeenCalledTimes(1)
    })

    it('ignores detached-frame errors', async () => {
        const frame = {
            evaluate: vi.fn(async () => {
                throw new Error('Frame was detached')
            }),
        } as unknown as Frame
        const page = createPageWithFrames([frame])

        await waitForVisualStabilityAcrossFrames(page, {
            timeout: 500,
            settleMs: 40,
        })

        expect(frame.evaluate).toHaveBeenCalledTimes(1)
    })
})
