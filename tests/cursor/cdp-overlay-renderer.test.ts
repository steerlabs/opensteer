import { describe, expect, it, vi } from 'vitest'
import { CdpOverlayCursorRenderer } from '../../src/cursor/renderers/cdp-overlay.js'
import type { OpensteerCursorStyle } from '../../src/types.js'

const DEFAULT_STYLE: Required<OpensteerCursorStyle> = {
    size: 12,
    pulseScale: 1.6,
    fillColor: { r: 255, g: 90, b: 90, a: 0.82 },
    outlineColor: { r: 255, g: 255, b: 255, a: 0.95 },
    haloColor: { r: 255, g: 90, b: 90, a: 0.35 },
}

function createMockSession(
    sendImpl?: (method: string, params?: unknown) => Promise<unknown>
) {
    return {
        send: vi.fn(async (method: string, params?: unknown) => {
            if (sendImpl) {
                return await sendImpl(method, params)
            }
            return undefined
        }),
        detach: vi.fn().mockResolvedValue(undefined),
    }
}

function createMockPage(newCDPSession: ReturnType<typeof vi.fn>) {
    const context = {
        newCDPSession,
    }

    return {
        isClosed: vi.fn(() => false),
        context: vi.fn(() => context),
    }
}

describe('cursor/cdp-overlay-renderer', () => {
    it('initializes CDP overlay and draws cursor quads', async () => {
        const session = createMockSession()
        const newCDPSession = vi.fn().mockResolvedValue(session)
        const page = createMockPage(newCDPSession)
        const renderer = new CdpOverlayCursorRenderer()

        await renderer.initialize(page as never)
        await renderer.move({ x: 100, y: 120 }, DEFAULT_STYLE)

        expect(newCDPSession).toHaveBeenCalledTimes(1)
        expect(session.send).toHaveBeenCalledWith('DOM.enable')
        expect(session.send).toHaveBeenCalledWith('Overlay.enable')
        expect(session.send).toHaveBeenCalledWith(
            'Overlay.highlightQuad',
            expect.objectContaining({
                quad: expect.any(Array),
                color: expect.any(Object),
                outlineColor: expect.any(Object),
            })
        )
    })

    it('reinitializes once when overlay session gets detached', async () => {
        const firstSession = createMockSession(async (method) => {
            if (method === 'Overlay.highlightQuad') {
                throw new Error('Session closed.')
            }
            return undefined
        })
        const secondSession = createMockSession()
        const newCDPSession = vi
            .fn()
            .mockResolvedValueOnce(firstSession)
            .mockResolvedValueOnce(secondSession)
        const page = createMockPage(newCDPSession)

        const renderer = new CdpOverlayCursorRenderer()
        await renderer.initialize(page as never)
        await renderer.move({ x: 40, y: 50 }, DEFAULT_STYLE)

        expect(newCDPSession).toHaveBeenCalledTimes(2)
        expect(firstSession.detach).toHaveBeenCalledTimes(1)
        expect(secondSession.send).toHaveBeenCalledWith(
            'Overlay.highlightQuad',
            expect.any(Object)
        )
    })

    it('renders a directional cursor quad in viewport coordinates', async () => {
        const session = createMockSession()
        const newCDPSession = vi.fn().mockResolvedValue(session)
        const page = createMockPage(newCDPSession)
        const renderer = new CdpOverlayCursorRenderer()

        await renderer.initialize(page as never)
        await renderer.move({ x: 10, y: 20 }, DEFAULT_STYLE)

        expect(session.send).toHaveBeenCalledWith('Overlay.highlightQuad', {
            quad: [21.04, 20, 8.08, 25.04, 1.36, 20, 8.08, 14.96],
            color: expect.any(Object),
            outlineColor: expect.any(Object),
        })

        expect(
            session.send.mock.calls.some(([method]) => method === 'Emulation.getScreenInfos')
        ).toBe(false)
    })
})
