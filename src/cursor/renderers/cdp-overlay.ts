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

export class CdpOverlayCursorRenderer implements CursorRenderer {
    private page: Page | null = null
    private session: CDPSession | null = null
    private active = false
    private reason: CursorCapabilityReason | undefined = 'disabled'
    private lastMessage: string | undefined
    private deviceScaleFactor = 1

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
                quad: this.buildQuad(point, style.size),
                color: toProtocolRgba(style.fillColor),
                outlineColor: toProtocolRgba(style.outlineColor),
            })
        })
    }

    async pulse(
        point: CursorPoint,
        style: Required<OpensteerCursorStyle>
    ): Promise<void> {
        const pulseSize = style.size * style.pulseScale
        const pulseFill = {
            ...style.fillColor,
            a: Math.min(1, style.fillColor.a * 0.65),
        }
        const pulseOutline = {
            ...style.haloColor,
            a: Math.min(1, style.haloColor.a * 0.85),
        }

        await this.sendWithRecovery(async (session) => {
            await session.send('Overlay.highlightQuad', {
                quad: this.buildQuad(point, pulseSize),
                color: toProtocolRgba(pulseFill),
                outlineColor: toProtocolRgba(pulseOutline),
            })
        })
        await sleep(24)
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
            this.deviceScaleFactor = await this.readDeviceScaleFactor(session)
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
        } catch {
            // no-op; session could already be detached
        }
    }

    private markInactive(
        reason: CursorCapabilityReason,
        message?: string
    ): void {
        this.active = false
        this.reason = reason
        this.lastMessage = message
    }

    private buildQuad(point: CursorPoint, size: number): number[] {
        const half = Math.max(2, size / 2) * this.deviceScaleFactor
        const x = point.x * this.deviceScaleFactor
        const y = point.y * this.deviceScaleFactor

        return [
            x - half,
            y - half,
            x + half,
            y - half,
            x + half,
            y + half,
            x - half,
            y + half,
        ]
    }

    private async readDeviceScaleFactor(session: CDPSession): Promise<number> {
        try {
            const screenInfo = await session.send('Emulation.getScreenInfos')
            const first = Array.isArray(screenInfo?.screenInfos)
                ? screenInfo.screenInfos[0]
                : null
            const parsed = Number(first?.devicePixelRatio)
            if (!Number.isFinite(parsed) || parsed <= 0) {
                return 1
            }
            return parsed
        } catch {
            return 1
        }
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

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
