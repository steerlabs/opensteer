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

export class CdpOverlayCursorRenderer implements CursorRenderer {
    private page: Page | null = null
    private session: CDPSession | null = null
    private active = false
    private reason: CursorCapabilityReason | undefined = 'disabled'
    private lastMessage: string | undefined
    private lastPoint: CursorPoint | null = null

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
        await this.sendWithRecovery(async (session) => {
            await session.send('Overlay.highlightQuad', {
                quad: buildCursorQuad(point, style.size),
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
                quad: buildCursorQuad(point, pulseSize),
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

}

/**
 * Build a 4-point quad shaped like a standard arrow cursor.
 * The tip is at (x, y) and the body extends down and to the right,
 * matching the classic pointer orientation. No rotation — a real
 * cursor always points the same direction regardless of travel.
 */
function buildCursorQuad(point: CursorPoint, size: number): number[] {
    const x = point.x
    const y = point.y

    // Tip is point 0 (top-left, the click hotspot)
    // Body extends down-right like a standard arrow cursor
    return [
        // Point 0: Tip (the hotspot)
        roundPointValue(x),
        roundPointValue(y),
        // Point 1: Right shoulder — extends right and down
        roundPointValue(x + size * 0.45),
        roundPointValue(y + size * 0.78),
        // Point 2: Tail — bottom of the cursor shaft
        roundPointValue(x + size * 0.12),
        roundPointValue(y + size * 1.3),
        // Point 3: Left edge — stays close to the shaft
        roundPointValue(x - size * 0.04),
        roundPointValue(y + size * 0.62),
    ]
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
