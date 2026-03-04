import type { Page } from 'playwright'
import type { OpensteerCursorColor, OpensteerCursorStyle } from '../../types.js'
import type { CursorRenderer } from '../renderer.js'
import type { CursorCapabilityReason, CursorPoint, CursorStatus } from '../types.js'

const PULSE_DURATION_MS = 220
const HOST_ELEMENT_ID = '__os_cr'

/**
 * Injects a real SVG cursor into the page via a Shadow DOM host.
 *
 * Stealth considerations:
 * - Shadow DOM hides internal structure from page querySelectorAll
 * - pointer-events: none so it never intercepts page interactions
 * - No detectable side-effects on page behavior
 * - Anti-bot systems look for navigator.webdriver, fingerprints, and timing —
 *   not DOM overlays
 *
 * Performance:
 * - Single absolutely-positioned element moved via CSS transform (GPU-composited)
 * - No CDP round-trips per frame — just page.evaluate calls
 * - Much faster than Overlay.highlightQuad protocol calls
 */
export class SvgCursorRenderer implements CursorRenderer {
    private page: Page | null = null
    private active = false
    private reason: CursorCapabilityReason | undefined = 'disabled'
    private lastMessage: string | undefined

    async initialize(page: Page): Promise<void> {
        this.page = page

        if (page.isClosed()) {
            this.markInactive('page_closed')
            return
        }

        try {
            await page.evaluate(injectCursor, HOST_ELEMENT_ID)
            this.active = true
            this.reason = undefined
            this.lastMessage = undefined
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            this.markInactive('renderer_error', message)
        }
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
        if (!this.active || !this.page || this.page.isClosed()) return

        try {
            const ok = await this.page.evaluate(moveCursor, {
                id: HOST_ELEMENT_ID,
                x: point.x,
                y: point.y,
                size: style.size,
                fill: colorToRgba(style.fillColor),
                outline: colorToRgba(style.outlineColor),
            })
            if (!ok) {
                await this.reinject()
                await this.page.evaluate(moveCursor, {
                    id: HOST_ELEMENT_ID,
                    x: point.x,
                    y: point.y,
                    size: style.size,
                    fill: colorToRgba(style.fillColor),
                    outline: colorToRgba(style.outlineColor),
                })
            }
        } catch (error) {
            this.handleError(error)
        }
    }

    async pulse(
        point: CursorPoint,
        style: Required<OpensteerCursorStyle>
    ): Promise<void> {
        if (!this.active || !this.page || this.page.isClosed()) return

        try {
            const ok = await this.page.evaluate(pulseCursor, {
                id: HOST_ELEMENT_ID,
                x: point.x,
                y: point.y,
                size: style.size,
                fill: colorToRgba(style.fillColor),
                outline: colorToRgba(style.outlineColor),
                halo: colorToRgba(style.haloColor),
                pulseMs: PULSE_DURATION_MS,
            })
            if (!ok) {
                await this.reinject()
                await this.page.evaluate(pulseCursor, {
                    id: HOST_ELEMENT_ID,
                    x: point.x,
                    y: point.y,
                    size: style.size,
                    fill: colorToRgba(style.fillColor),
                    outline: colorToRgba(style.outlineColor),
                    halo: colorToRgba(style.haloColor),
                    pulseMs: PULSE_DURATION_MS,
                })
            }
        } catch (error) {
            this.handleError(error)
        }
    }

    async clear(): Promise<void> {
        if (!this.page || this.page.isClosed()) return
        try {
            await this.page.evaluate(removeCursor, HOST_ELEMENT_ID)
        } catch {}
    }

    async dispose(): Promise<void> {
        if (this.page && !this.page.isClosed()) {
            try {
                await this.page.evaluate(removeCursor, HOST_ELEMENT_ID)
            } catch {}
        }
        this.active = false
        this.reason = 'disabled'
        this.lastMessage = undefined
        this.page = null
    }

    private async reinject(): Promise<void> {
        if (!this.page || this.page.isClosed()) return
        try {
            await this.page.evaluate(injectCursor, HOST_ELEMENT_ID)
        } catch {}
    }

    private markInactive(reason: CursorCapabilityReason, message?: string): void {
        this.active = false
        this.reason = reason
        this.lastMessage = message
    }

    private handleError(error: unknown): void {
        const message = error instanceof Error ? error.message : String(error)
        if (isPageGone(message)) {
            this.markInactive('page_closed', message)
        }
    }
}

// ── Page-evaluated functions ──────────────────────────────────────────
// IMPORTANT: Each function passed to page.evaluate() is serialized and
// executed in isolation inside the browser. They CANNOT reference each
// other or any module-scope variables/functions. Each must be fully
// self-contained.

function injectCursor(hostId: string): void {
    const win = window as unknown as Record<string, unknown>
    if (win[hostId]) return

    const host = document.createElement('div')
    host.style.cssText =
        'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;'

    const shadow = host.attachShadow({ mode: 'closed' })

    const wrapper = document.createElement('div')
    wrapper.style.cssText =
        'position:fixed;top:0;left:0;pointer-events:none;will-change:transform;display:none;'

    wrapper.innerHTML = `
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,0.3));display:block;">
            <path d="M3 2L3 23L8.5 17.5L13 26L17 24L12.5 15.5L20 15.5L3 2Z"
                  fill="white" stroke="black" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>
        <div data-role="pulse" style="position:absolute;top:0;left:0;width:24px;height:24px;border-radius:50%;pointer-events:none;opacity:0;transform:translate(-8px,-8px);"></div>
    `

    shadow.appendChild(wrapper)
    document.documentElement.appendChild(host)

    Object.defineProperty(window, hostId, {
        value: {
            host,
            wrapper,
            path: wrapper.querySelector('path'),
            pulse: wrapper.querySelector('[data-role="pulse"]'),
        },
        configurable: true,
        enumerable: false,
    })
}

function moveCursor(args: {
    id: string
    x: number
    y: number
    size: number
    fill: string
    outline: string
}): boolean {
    const refs = (window as unknown as Record<string, unknown>)[args.id] as {
        wrapper: HTMLElement
        path: SVGPathElement | null
    } | null
    if (!refs) return false

    const scale = args.size / 20
    refs.wrapper.style.transform = `translate(${args.x}px, ${args.y}px) scale(${scale})`
    refs.wrapper.style.display = 'block'

    if (refs.path) {
        refs.path.setAttribute('fill', args.fill)
        refs.path.setAttribute('stroke', args.outline)
    }
    return true
}

function pulseCursor(args: {
    id: string
    x: number
    y: number
    size: number
    fill: string
    outline: string
    halo: string
    pulseMs: number
}): boolean {
    const refs = (window as unknown as Record<string, unknown>)[args.id] as {
        wrapper: HTMLElement
        path: SVGPathElement | null
        pulse: HTMLElement | null
    } | null
    if (!refs) return false

    // Move to position
    const scale = args.size / 20
    refs.wrapper.style.transform = `translate(${args.x}px, ${args.y}px) scale(${scale})`
    refs.wrapper.style.display = 'block'

    if (refs.path) {
        refs.path.setAttribute('fill', args.fill)
        refs.path.setAttribute('stroke', args.outline)
    }

    // Pulse animation
    const ring = refs.pulse
    if (!ring) return true

    ring.style.background = args.halo
    ring.style.opacity = '0.7'
    ring.style.width = '24px'
    ring.style.height = '24px'
    ring.style.transition = `all ${args.pulseMs}ms ease-out`

    // Trigger reflow then animate
    ring.offsetHeight
    ring.style.width = '48px'
    ring.style.height = '48px'
    ring.style.opacity = '0'
    ring.style.transform = 'translate(-20px, -20px)'

    setTimeout(() => {
        ring.style.transition = 'none'
        ring.style.width = '24px'
        ring.style.height = '24px'
        ring.style.transform = 'translate(-8px, -8px)'
        ring.style.opacity = '0'
    }, args.pulseMs)
    return true
}

function removeCursor(hostId: string): void {
    const refs = (window as unknown as Record<string, unknown>)[hostId] as {
        host: HTMLElement
    } | null
    if (refs) {
        refs.host.remove()
        delete (window as unknown as Record<string, unknown>)[hostId]
    }
}

// ── Helpers ───────────────────────────────────────────────────────────

function colorToRgba(c: OpensteerCursorColor): string {
    return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${c.a})`
}

function isPageGone(message: string): boolean {
    const m = message.toLowerCase()
    return (
        m.includes('closed') ||
        m.includes('detached') ||
        m.includes('destroyed') ||
        m.includes('target')
    )
}
