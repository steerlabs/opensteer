import { describe, expect, it, vi } from 'vitest'
import { SvgCursorRenderer } from '../../src/cursor/renderers/svg-overlay.js'
import type { OpensteerCursorStyle } from '../../src/types.js'

type PageEvaluateFn = ((...args: unknown[]) => unknown) & { name: string }

const DEFAULT_STYLE: Required<OpensteerCursorStyle> = {
    size: 20,
    pulseScale: 2.15,
    fillColor: { r: 255, g: 255, b: 255, a: 0.96 },
    outlineColor: { r: 0, g: 0, b: 0, a: 1 },
    haloColor: { r: 35, g: 162, b: 255, a: 0.38 },
}

function createMockPage(
    evaluateImpl?: (
        pageFn: PageEvaluateFn,
        ...args: unknown[]
    ) => unknown | Promise<unknown>
) {
    return {
        isClosed: vi.fn(() => false),
        evaluate: vi.fn(
            async (pageFn: PageEvaluateFn, ...args: unknown[]) =>
                evaluateImpl ? await evaluateImpl(pageFn, ...args) : undefined
        ),
    }
}

describe('cursor/svg-overlay-renderer', () => {
    it('removes injected host from the page on clear', async () => {
        const page = createMockPage()
        const renderer = new SvgCursorRenderer()

        await renderer.initialize(page as never)
        await renderer.clear()

        expect(page.evaluate).toHaveBeenCalledTimes(2)
        const [injectCall, clearCall] = page.evaluate.mock.calls
        expect(injectCall[0].name).toBe('injectCursor')
        expect(clearCall[0].name).toBe('removeCursor')
        expect(clearCall[1]).toBe(injectCall[1])
    })

    it('reinjects cursor host on the next move after clear', async () => {
        let hostExists = false
        const page = createMockPage((pageFn) => {
            switch (pageFn.name) {
                case 'injectCursor':
                    hostExists = true
                    return undefined
                case 'removeCursor':
                    hostExists = false
                    return undefined
                case 'moveCursor':
                    return hostExists
                default:
                    return undefined
            }
        })
        const renderer = new SvgCursorRenderer()

        await renderer.initialize(page as never)
        await renderer.clear()
        await renderer.move({ x: 120, y: 80 }, DEFAULT_STYLE)

        const calls = page.evaluate.mock.calls.map(([pageFn]) => pageFn.name)
        expect(calls).toEqual([
            'injectCursor',
            'removeCursor',
            'moveCursor',
            'injectCursor',
            'moveCursor',
        ])
    })
})
