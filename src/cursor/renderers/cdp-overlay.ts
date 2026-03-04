import type { CDPSession, Page } from 'playwright'
import type { OpensteerCursorColor, OpensteerCursorStyle } from '../../types.js'
import type { CursorRenderer } from '../renderer.js'
import type { CursorCapabilityReason, CursorPoint, CursorStatus } from '../types.js'

type ProtocolRgba = {
    r: number
    g: number
    b: number
    a: number
}

const PULSE_DELAY_MS = 30
const HEADING_EPSILON = 0.35
const CURSOR_GEOMETRY = {
    shoulderForward: 0.9,
    shoulderSide: 0.55,
    tail: 1.45,
    tailSkew: 0.18,
    leftForwardScale: 0.52,
    leftSideScale: 0.58,
} as const

export class CdpOverlayCursorRenderer implements CursorRenderer {
    private page: Page | null = null
    private session: CDPSession | null = null
    private active = false
    private reason: CursorCapabilityReason | undefined = 'disabled'
    private lastMessage: string | undefined
    private lastPoint: CursorPoint | null = null
    private lastHeadingRad = 0

    async initialize(page: Page): Promise<void> {
        this.page = page

        if (page.isClosed()) {
            this.markInactive('page_closed')
            return
        }

        await this.createSession()
    }

    isActive(): boolean {
        return this.active
    }

    status(): CursorStatus {
        return {
            enabled: true,
            active: this.active,
            reason: this.reason
                ? this.lastMessage
                    ? `${this.reason}: ${this.lastMessage}`
                    : this.reason
                : undefined,
        }
    }

    async move(
        point: CursorPoint,
        style: Required<OpensteerCursorStyle>
    ): Promise<void> {
        const heading = this.resolveHeading(point)
        await this.sendWithRecovery(async (session) => {
            await session.send('Overlay.highlightQuad', {
                quad: this.buildCursorQuad(point, style.size, heading),
                color: toProtocolRgba(style.fillColor),
                outlineColor: toProtocolRgba(style.outlineColor),
            })
        })
        this.lastPoint = point
    }

    async pulse(
        point: CursorPoint,
        style: Required<OpensteerCursorStyle>
    ): Promise<void> {
        const heading = this.resolveHeading(point)
        const pulseSize = style.size * style.pulseScale
        const pulseFill = {
            ...style.fillColor,
            a: Math.min(1, style.fillColor.a * 0.14),
        }
        const pulseOutline = {
            ...style.haloColor,
            a: Math.min(1, style.haloColor.a * 0.9),
        }

        await this.sendWithRecovery(async (session) => {
            await session.send('Overlay.highlightQuad', {
                quad: this.buildCursorQuad(point, pulseSize, heading),
                color: toProtocolRgba(pulseFill),
                outlineColor: toProtocolRgba(pulseOutline),
            })
        })
        await sleep(PULSE_DELAY_MS)
        await this.move(point, style)
    }

    async clear(): Promise<void> {
        if (!this.session) return
        try {
            await this.session.send('Overlay.hideHighlight')
        } catch {
            this.markInactive('cdp_detached')
        }
    }

    async dispose(): Promise<void> {
        await this.cleanupSession()
        this.active = false
        this.reason = 'disabled'
        this.lastMessage = undefined
        this.lastPoint = null
        this.lastHeadingRad = 0
        this.page = null
    }

    private async sendWithRecovery(
        operation: (session: CDPSession) => Promise<void>
    ): Promise<void> {
        if (!this.active || !this.session) return

        try {
            await operation(this.session)
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.lastMessage = message

            if (!isRecoverableProtocolError(message) || !this.page) {
                this.markInactive('renderer_error', message)
                return
            }

            await this.createSession()
            if (!this.active || !this.session) {
                return
            }

            try {
                await operation(this.session)
            } catch (retryError) {
                const retryMessage =
                    retryError instanceof Error
                        ? retryError.message
                        : String(retryError)
                this.markInactive('renderer_error', retryMessage)
            }
        }
    }

    private async createSession(): Promise<void> {
        if (!this.page || this.page.isClosed()) {
            this.markInactive('page_closed')
            return
        }

        await this.cleanupSession()

        try {
            const session = await this.page.context().newCDPSession(this.page)
            await session.send('DOM.enable')
            await session.send('Overlay.enable')
            this.session = session
            this.active = true
            this.reason = undefined
            this.lastMessage = undefined
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.markInactive(inferSetupReason(message), message)
            await this.cleanupSession()
        }
    }

    private async cleanupSession(): Promise<void> {
        const session = this.session
        this.session = null
        if (!session) return

        try {
            await session.detach()
        } catch {}
    }

    private markInactive(
        reason: CursorCapabilityReason,
        message?: string
    ): void {
        this.active = false
        this.reason = reason
        this.lastMessage = message
    }

    private resolveHeading(point: CursorPoint): number {
        if (!this.lastPoint) {
            return this.lastHeadingRad
        }

        const dx = point.x - this.lastPoint.x
        const dy = point.y - this.lastPoint.y
        if (Math.hypot(dx, dy) < HEADING_EPSILON) {
            return this.lastHeadingRad
        }

        this.lastHeadingRad = Math.atan2(dy, dx)
        return this.lastHeadingRad
    }

    private buildCursorQuad(
        point: CursorPoint,
        size: number,
        headingRad: number
    ): number[] {
        const shoulderForward = size * CURSOR_GEOMETRY.shoulderForward
        const shoulderSide = size * CURSOR_GEOMETRY.shoulderSide
        const tail = size * CURSOR_GEOMETRY.tail
        const tailSkew = size * CURSOR_GEOMETRY.tailSkew

        const ux = Math.cos(headingRad)
        const uy = Math.sin(headingRad)
        const vx = -uy
        const vy = ux

        const right = {
            x: point.x - ux * shoulderForward + vx * shoulderSide,
            y: point.y - uy * shoulderForward + vy * shoulderSide,
        }
        const tailPoint = {
            x: point.x - ux * tail - vx * tailSkew,
            y: point.y - uy * tail - vy * tailSkew,
        }
        const left = {
            x:
                point.x -
                ux * shoulderForward * CURSOR_GEOMETRY.leftForwardScale -
                vx * shoulderSide * CURSOR_GEOMETRY.leftSideScale,
            y:
                point.y -
                uy * shoulderForward * CURSOR_GEOMETRY.leftForwardScale -
                vy * shoulderSide * CURSOR_GEOMETRY.leftSideScale,
        }

        return [
            roundPointValue(point.x),
            roundPointValue(point.y),
            roundPointValue(right.x),
            roundPointValue(right.y),
            roundPointValue(tailPoint.x),
            roundPointValue(tailPoint.y),
            roundPointValue(left.x),
            roundPointValue(left.y),
        ]
    }
}

function inferSetupReason(message: string): CursorCapabilityReason {
    const lowered = message.toLowerCase()
    if (
        lowered.includes('not supported') ||
        lowered.includes('only supported') ||
        lowered.includes('unknown command')
    ) {
        return 'unsupported'
    }
    return 'cdp_unavailable'
}

function isRecoverableProtocolError(message: string): boolean {
    const lowered = message.toLowerCase()
    return (
        lowered.includes('session closed') ||
        lowered.includes('target closed') ||
        lowered.includes('has been closed') ||
        lowered.includes('detached')
    )
}

function toProtocolRgba(color: OpensteerCursorColor): ProtocolRgba {
    return {
        r: clampColor(color.r),
        g: clampColor(color.g),
        b: clampColor(color.b),
        a: clampAlpha(color.a),
    }
}

function clampColor(value: number): number {
    return Math.min(255, Math.max(0, Math.round(value)))
}

function clampAlpha(value: number): number {
    const normalized = Number.isFinite(value) ? value : 1
    return Math.min(1, Math.max(0, normalized))
}

function roundPointValue(value: number): number {
    return Math.round(value * 100) / 100
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
