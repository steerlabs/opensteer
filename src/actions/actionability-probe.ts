import type { ElementHandle } from 'playwright'
import type { ActionFailureBlocker } from '../action-failure.js'

export interface ActionabilityProbeResult {
    connected: boolean
    visible: boolean | null
    enabled: boolean | null
    editable: boolean | null
    blocker: ActionFailureBlocker | null
}

export async function probeActionabilityState(
    element: ElementHandle<Element>
): Promise<ActionabilityProbeResult | null> {
    try {
        return await element.evaluate((target) => {
            if (!(target instanceof Element)) {
                return {
                    connected: false,
                    visible: null,
                    enabled: null,
                    editable: null,
                    blocker: null,
                } satisfies ActionabilityProbeResult
            }

            const connected = target.isConnected
            if (!connected) {
                return {
                    connected: false,
                    visible: null,
                    enabled: null,
                    editable: null,
                    blocker: null,
                } satisfies ActionabilityProbeResult
            }

            const style = window.getComputedStyle(target)
            const rect = target.getBoundingClientRect()
            const hasBox = rect.width > 0 && rect.height > 0
            const opacity = Number.parseFloat(style.opacity || '1')
            const isVisible =
                hasBox &&
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.visibility !== 'collapse' &&
                (!Number.isFinite(opacity) || opacity > 0)

            let enabled: boolean | null = null
            if (
                target instanceof HTMLButtonElement ||
                target instanceof HTMLInputElement ||
                target instanceof HTMLSelectElement ||
                target instanceof HTMLTextAreaElement ||
                target instanceof HTMLOptionElement ||
                target instanceof HTMLOptGroupElement ||
                target instanceof HTMLFieldSetElement
            ) {
                enabled = !target.disabled
            }

            let editable: boolean | null = null
            if (target instanceof HTMLInputElement) {
                editable = !target.readOnly && !target.disabled
            } else if (target instanceof HTMLTextAreaElement) {
                editable = !target.readOnly && !target.disabled
            } else if (target instanceof HTMLSelectElement) {
                editable = !target.disabled
            } else if (target instanceof HTMLElement && target.isContentEditable) {
                editable = true
            }

            let blocker: ActionFailureBlocker | null = null
            if (hasBox && window.innerWidth > 0 && window.innerHeight > 0) {
                const x = Math.min(
                    Math.max(rect.left + rect.width / 2, 0),
                    window.innerWidth - 1
                )
                const y = Math.min(
                    Math.max(rect.top + rect.height / 2, 0),
                    window.innerHeight - 1
                )
                const top = document.elementFromPoint(x, y)

                if (top && top !== target && !target.contains(top)) {
                    const classes = String(top.className || '')
                        .split(/\s+/)
                        .map((value) => value.trim())
                        .filter(Boolean)
                        .slice(0, 5)

                    blocker = {
                        tag: top.tagName.toLowerCase(),
                        id: top.id || null,
                        classes,
                        role: top.getAttribute('role'),
                        text: (top.textContent || '').trim().slice(0, 80) || null,
                    }
                }
            }

            return {
                connected,
                visible: isVisible,
                enabled,
                editable,
                blocker,
            } satisfies ActionabilityProbeResult
        })
    } catch {
        return null
    }
}
