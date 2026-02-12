import type { Page } from 'playwright'
import type { ScrollOptions } from '../types.js'
import type { ElementPath } from '../element-path/types.js'
import { resolveElementPath } from '../element-path/resolver.js'
import { formatPathResolutionError } from './path-resolution.js'
import type { ActionExecutionResult } from './types.js'

function getScrollDelta(options: ScrollOptions): { x: number; y: number } {
    const amount = typeof options.amount === 'number' ? options.amount : 600
    const absoluteAmount = Math.abs(amount)

    switch (options.direction) {
        case 'up':
            return { x: 0, y: -absoluteAmount }
        case 'left':
            return { x: -absoluteAmount, y: 0 }
        case 'right':
            return { x: absoluteAmount, y: 0 }
        case 'down':
        default:
            return { x: 0, y: absoluteAmount }
    }
}

export async function performScroll(
    page: Page,
    path: ElementPath | null,
    options: ScrollOptions
): Promise<ActionExecutionResult> {
    const { x, y } = getScrollDelta(options)

    if (!path) {
        await page.evaluate(
            ({ deltaX, deltaY }) => {
                window.scrollBy(deltaX, deltaY)
            },
            { deltaX: x, deltaY: y }
        )
        return { ok: true }
    }

    let resolved
    try {
        resolved = await resolveElementPath(page, path)
    } catch (err) {
        return { ok: false, error: formatPathResolutionError(err) }
    }

    try {
        await resolved.element.evaluate(
            (el, delta) => {
                if (el instanceof HTMLElement) {
                    el.scrollBy(delta.deltaX, delta.deltaY)
                }
            },
            { deltaX: x, deltaY: y }
        )

        return {
            ok: true,
            path,
            usedSelector: resolved.usedSelector,
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Scroll failed.'
        return { ok: false, error: message }
    } finally {
        await resolved.element.dispose()
    }
}
