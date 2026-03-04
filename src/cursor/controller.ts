import type { Page } from 'playwright'
import type {
    OpensteerCursorColor,
    OpensteerCursorConfig,
    OpensteerCursorStyle,
} from '../types.js'
import { planSnappyCursorMotion } from './motion.js'
import type { CursorRenderer } from './renderer.js'
import { SvgCursorRenderer } from './renderers/svg-overlay.js'
import type {
    CursorIntent,
    CursorMotionPlan,
    CursorPoint,
    CursorStatus,
} from './types.js'

interface CursorControllerOptions {
    config?: OpensteerCursorConfig
    debug?: boolean
    renderer?: CursorRenderer
}

const DEFAULT_STYLE: Required<OpensteerCursorStyle> = {
    size: 20,
    fillColor: {
        r: 255,
        g: 255,
        b: 255,
        a: 0.96,
    },
    outlineColor: {
        r: 0,
        g: 0,
        b: 0,
        a: 1,
    },
    haloColor: {
        r: 35,
        g: 162,
        b: 255,
        a: 0.38,
    },
    pulseScale: 2.15,
}
const REINITIALIZE_BACKOFF_MS = 1000
const FIRST_MOVE_CENTER_DISTANCE_THRESHOLD = 16
const FIRST_MOVE_MAX_TRAVEL = 220
const FIRST_MOVE_NEAR_TARGET_X_OFFSET = 28
const FIRST_MOVE_NEAR_TARGET_Y_OFFSET = 18
const MOTION_PLANNERS: Record<
    NonNullable<OpensteerCursorConfig['profile']>,
    (from: CursorPoint, to: CursorPoint) => CursorMotionPlan
> = {
    snappy: planSnappyCursorMotion,
}

export class CursorController {
    private readonly debug: boolean
    private readonly renderer: CursorRenderer
    private page: Page | null = null
    private listenerPage: Page | null = null
    private lastPoint: CursorPoint | null = null
    private initializedForPage = false
    private lastInitializeAttemptAt = 0
    private enabled: boolean
    private readonly profile: NonNullable<OpensteerCursorConfig['profile']>
    private readonly style: Required<OpensteerCursorStyle>
    private readonly onDomContentLoaded = (): void => {
        void this.restoreCursorAfterNavigation()
    }

    constructor(options: CursorControllerOptions = {}) {
        const config = options.config || {}
        this.debug = Boolean(options.debug)
        this.enabled = config.enabled === true
        this.profile = config.profile ?? 'snappy'
        this.style = mergeStyle(config.style)
        this.renderer = options.renderer ?? new SvgCursorRenderer()
    }

    setEnabled(enabled: boolean): void {
        if (this.enabled && !enabled) {
            this.lastPoint = null
            void this.clear()
        }
        this.enabled = enabled
    }

    isEnabled(): boolean {
        return this.enabled
    }

    getStatus(): CursorStatus {
        if (!this.enabled) {
            return {
                enabled: false,
                active: false,
                reason: 'disabled',
            }
        }

        const status = this.renderer.status()
        if (!this.initializedForPage && !status.active) {
            return {
                enabled: true,
                active: false,
                reason: 'not_initialized',
            }
        }

        return status
    }

    async attachPage(page: Page): Promise<void> {
        if (this.page !== page) {
            this.detachPageListeners()
            this.page = page
            this.lastPoint = null
            this.initializedForPage = false
            this.lastInitializeAttemptAt = 0
        }
        this.attachPageListeners(page)
    }

    async preview(point: CursorPoint | null, intent: CursorIntent): Promise<void> {
        if (!this.enabled || !point) return
        if (!this.page || this.page.isClosed()) return

        try {
            await this.ensureInitialized()
            if (!this.renderer.isActive()) {
                await this.reinitializeIfEligible()
            }
            if (!this.renderer.isActive()) return

            const start = this.resolveMotionStart(point)
            const motion = this.planMotion(start, point)

            for (const step of motion.points) {
                await this.renderer.move(step, this.style)
                if (motion.stepDelayMs > 0) {
                    await sleep(motion.stepDelayMs)
                }
            }

            if (shouldPulse(intent)) {
                await this.renderer.pulse(point, this.style)
            }

            this.lastPoint = point
        } catch (error) {
            if (this.debug) {
                const message =
                    error instanceof Error ? error.message : String(error)
                console.warn(`[opensteer] cursor preview failed: ${message}`)
            }
        }
    }

    async clear(): Promise<void> {
        try {
            await this.renderer.clear()
        } catch (error) {
            if (this.debug) {
                const message =
                    error instanceof Error ? error.message : String(error)
                console.warn(`[opensteer] cursor clear failed: ${message}`)
            }
        }
    }

    async dispose(): Promise<void> {
        this.detachPageListeners()
        this.lastPoint = null
        this.initializedForPage = false
        this.lastInitializeAttemptAt = 0
        this.page = null
        await this.renderer.dispose()
    }

    private async ensureInitialized(): Promise<void> {
        if (!this.page || this.page.isClosed()) return
        if (this.initializedForPage) return

        await this.initializeRenderer()
    }

    private attachPageListeners(page: Page): void {
        if (this.listenerPage === page) {
            return
        }

        this.detachPageListeners()
        page.on('domcontentloaded', this.onDomContentLoaded)
        this.listenerPage = page
    }

    private detachPageListeners(): void {
        if (!this.listenerPage) {
            return
        }

        this.listenerPage.off('domcontentloaded', this.onDomContentLoaded)
        this.listenerPage = null
    }

    private planMotion(from: CursorPoint, to: CursorPoint) {
        return MOTION_PLANNERS[this.profile](from, to)
    }

    private async reinitializeIfEligible(): Promise<void> {
        if (!this.page || this.page.isClosed()) return
        const elapsed = Date.now() - this.lastInitializeAttemptAt
        if (elapsed < REINITIALIZE_BACKOFF_MS) return

        await this.initializeRenderer()
    }

    private async initializeRenderer(): Promise<void> {
        if (!this.page || this.page.isClosed()) return

        this.lastInitializeAttemptAt = Date.now()
        await this.renderer.initialize(this.page)
        this.initializedForPage = true
    }

    private async restoreCursorAfterNavigation(): Promise<void> {
        if (!this.enabled || !this.lastPoint) return
        if (!this.page || this.page.isClosed()) return

        try {
            if (!this.renderer.isActive()) {
                await this.reinitializeIfEligible()
            }
            if (!this.renderer.isActive()) {
                return
            }

            await this.renderer.move(this.lastPoint, this.style)
        } catch (error) {
            if (this.debug) {
                const message =
                    error instanceof Error ? error.message : String(error)
                console.warn(
                    `[opensteer] cursor restore after navigation failed: ${message}`
                )
            }
        }
    }

    private resolveMotionStart(target: CursorPoint): CursorPoint {
        if (this.lastPoint) {
            return this.lastPoint
        }

        const viewport = this.page?.viewportSize()
        if (!viewport?.width || !viewport?.height) {
            return target
        }

        const centerPoint = {
            x: viewport.width / 2,
            y: viewport.height / 2,
        }

        if (
            distanceBetween(centerPoint, target) >
            FIRST_MOVE_CENTER_DISTANCE_THRESHOLD
        ) {
            const dx = target.x - centerPoint.x
            const dy = target.y - centerPoint.y
            const distance = Math.hypot(dx, dy)
            if (distance > FIRST_MOVE_MAX_TRAVEL) {
                const ux = dx / distance
                const uy = dy / distance
                return {
                    x: target.x - ux * FIRST_MOVE_MAX_TRAVEL,
                    y: target.y - uy * FIRST_MOVE_MAX_TRAVEL,
                }
            }
            return centerPoint
        }

        return {
            x: clamp(target.x - FIRST_MOVE_NEAR_TARGET_X_OFFSET, 0, viewport.width),
            y: clamp(target.y - FIRST_MOVE_NEAR_TARGET_Y_OFFSET, 0, viewport.height),
        }
    }
}

function mergeStyle(style?: OpensteerCursorStyle): Required<OpensteerCursorStyle> {
    return {
        size: normalizeFinite(style?.size, DEFAULT_STYLE.size, 4, 48),
        pulseScale: normalizeFinite(
            style?.pulseScale,
            DEFAULT_STYLE.pulseScale,
            1,
            3
        ),
        fillColor: normalizeColor(style?.fillColor, DEFAULT_STYLE.fillColor),
        outlineColor: normalizeColor(
            style?.outlineColor,
            DEFAULT_STYLE.outlineColor
        ),
        haloColor: normalizeColor(style?.haloColor, DEFAULT_STYLE.haloColor),
    }
}

function normalizeColor(
    color: OpensteerCursorColor | undefined,
    fallback: OpensteerCursorColor
): OpensteerCursorColor {
    if (!color) return { ...fallback }
    return {
        r: normalizeFinite(color.r, fallback.r, 0, 255),
        g: normalizeFinite(color.g, fallback.g, 0, 255),
        b: normalizeFinite(color.b, fallback.b, 0, 255),
        a: normalizeFinite(color.a, fallback.a, 0, 1),
    }
}

function normalizeFinite(
    value: number | undefined,
    fallback: number,
    min: number,
    max: number
): number {
    const numeric =
        typeof value === 'number' && Number.isFinite(value) ? value : fallback
    return Math.min(max, Math.max(min, numeric))
}

function distanceBetween(a: CursorPoint, b: CursorPoint): number {
    return Math.hypot(a.x - b.x, a.y - b.y)
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value))
}

function shouldPulse(intent: CursorIntent): boolean {
    return (
        intent === 'click' ||
        intent === 'dblclick' ||
        intent === 'rightclick' ||
        intent === 'agent'
    )
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
