import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'events'
import { CursorController } from '../../src/cursor/controller.js'
import type { CursorRenderer } from '../../src/cursor/renderer.js'
import type { CursorPoint } from '../../src/cursor/types.js'

class MockCursorRenderer implements CursorRenderer {
    active = false
    moves: CursorPoint[] = []

    async initialize(): Promise<void> {
        this.active = true
    }

    async move(point: CursorPoint): Promise<void> {
        this.moves.push(point)
    }

    async pulse(): Promise<void> {}

    async clear(): Promise<void> {}

    async dispose(): Promise<void> {
        this.active = false
    }

    isActive(): boolean {
        return this.active
    }

    status() {
        return {
            enabled: true,
            active: this.active,
        }
    }
}

class MockPage extends EventEmitter {
    constructor(
        private readonly viewport?: {
            width: number
            height: number
        }
    ) {
        super()
    }

    isClosed(): boolean {
        return false
    }

    viewportSize(): { width: number; height: number } | null {
        return this.viewport ?? null
    }
}

function createMockPage(viewport?: { width: number; height: number }): MockPage {
    return new MockPage(viewport)
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
}

describe('cursor/controller', () => {
    it('animates first movement from viewport center when no prior point exists', async () => {
        const renderer = new MockCursorRenderer()
        const controller = new CursorController({
            config: {
                enabled: true,
            },
            renderer,
        })

        await controller.attachPage(
            createMockPage({ width: 1200, height: 800 }) as never
        )
        await controller.preview({ x: 1080, y: 120 }, 'hover')

        expect(renderer.moves.length).toBeGreaterThan(1)
        expect(renderer.moves[0]).not.toEqual({ x: 1080, y: 120 })
    })

    it('falls back to target point when viewport is unavailable', async () => {
        const renderer = new MockCursorRenderer()
        const controller = new CursorController({
            config: {
                enabled: true,
            },
            renderer,
        })

        await controller.attachPage(createMockPage() as never)
        await controller.preview({ x: 320, y: 160 }, 'hover')

        expect(renderer.moves[renderer.moves.length - 1]).toEqual({
            x: 320,
            y: 160,
        })
    })

    it('restores the last cursor point after page navigation events', async () => {
        const renderer = new MockCursorRenderer()
        const controller = new CursorController({
            config: {
                enabled: true,
            },
            renderer,
        })
        const page = createMockPage({ width: 1200, height: 800 })

        await controller.attachPage(page as never)
        await controller.preview({ x: 640, y: 360 }, 'hover')

        const movesBeforeNavigation = renderer.moves.length
        page.emit('domcontentloaded')
        await flushMicrotasks()

        expect(renderer.moves.length).toBeGreaterThan(movesBeforeNavigation)
        expect(renderer.moves[renderer.moves.length - 1]).toEqual({
            x: 640,
            y: 360,
        })
    })

    it('does not restore cursor after navigation when disabled at runtime', async () => {
        const renderer = new MockCursorRenderer()
        const controller = new CursorController({
            config: {
                enabled: true,
            },
            renderer,
        })
        const page = createMockPage({ width: 1200, height: 800 })

        await controller.attachPage(page as never)
        await controller.preview({ x: 700, y: 420 }, 'hover')
        const movesBeforeDisable = renderer.moves.length

        controller.setEnabled(false)
        page.emit('domcontentloaded')
        await flushMicrotasks()

        expect(renderer.moves.length).toBe(movesBeforeDisable)
    })
})
