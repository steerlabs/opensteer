import type { Page } from 'playwright'
import type { HoverOptions } from '../types.js'
import type { ElementPath } from '../element-path/types.js'
import { resolveElementPath } from '../element-path/resolver.js'
import { formatPathResolutionError } from './path-resolution.js'
import type { ActionExecutionResult } from './types.js'

export async function performHover(
    page: Page,
    path: ElementPath,
    options: HoverOptions
): Promise<ActionExecutionResult> {
    let resolved
    try {
        resolved = await resolveElementPath(page, path)
    } catch (err) {
        return { ok: false, error: formatPathResolutionError(err) }
    }

    try {
        await resolved.element.hover({
            force: options.force,
            position: options.position,
        })

        return {
            ok: true,
            path,
            usedSelector: resolved.usedSelector,
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Hover failed.'
        return { ok: false, error: message }
    } finally {
        await resolved.element.dispose()
    }
}
