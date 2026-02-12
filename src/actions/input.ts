import type { Page } from 'playwright'
import type { InputOptions } from '../types.js'
import type { ElementPath } from '../element-path/types.js'
import { resolveElementPath } from '../element-path/resolver.js'
import { formatPathResolutionError } from './path-resolution.js'
import type { ActionExecutionResult } from './types.js'

export async function performInput(
    page: Page,
    path: ElementPath,
    options: InputOptions
): Promise<ActionExecutionResult> {
    let resolved
    try {
        resolved = await resolveElementPath(page, path)
    } catch (err) {
        return { ok: false, error: formatPathResolutionError(err) }
    }

    try {
        if (options.clear !== false) {
            await resolved.element.fill(options.text)
        } else {
            await resolved.element.type(options.text)
        }
        if (options.pressEnter) {
            await resolved.element.press('Enter')
        }
        return {
            ok: true,
            path,
            usedSelector: resolved.usedSelector,
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Input failed.'
        return { ok: false, error: message }
    } finally {
        await resolved.element.dispose()
    }
}
