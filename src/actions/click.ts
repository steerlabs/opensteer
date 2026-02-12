import type { Page } from 'playwright'
import type { ClickOptions } from '../types.js'
import type { ElementPath } from '../element-path/types.js'
import { resolveElementPath } from '../element-path/resolver.js'
import { formatPathResolutionError } from './path-resolution.js'
import type { ActionExecutionResult } from './types.js'

export async function performClick(
    page: Page,
    path: ElementPath,
    options: ClickOptions
): Promise<ActionExecutionResult> {
    let resolved
    try {
        resolved = await resolveElementPath(page, path)
    } catch (err) {
        return { ok: false, error: formatPathResolutionError(err) }
    }

    try {
        await resolved.element.click({
            button: options.button,
            clickCount: options.clickCount,
            modifiers: options.modifiers,
        })
        return {
            ok: true,
            path,
            usedSelector: resolved.usedSelector,
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Click failed.'
        return { ok: false, error: message }
    } finally {
        await resolved.element.dispose()
    }
}
