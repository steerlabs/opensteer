import type { Page } from 'playwright'
import type { SelectOptions } from '../types.js'
import type { ElementPath } from '../element-path/types.js'
import { resolveElementPath } from '../element-path/resolver.js'
import { formatPathResolutionError } from './path-resolution.js'
import type { ActionExecutionResult } from './types.js'

export async function performSelect(
    page: Page,
    path: ElementPath,
    options: SelectOptions
): Promise<ActionExecutionResult> {
    let resolved
    try {
        resolved = await resolveElementPath(page, path)
    } catch (err) {
        return { ok: false, error: formatPathResolutionError(err) }
    }

    try {
        if (options.value != null) {
            await resolved.element.selectOption(options.value)
        } else if (options.label != null) {
            await resolved.element.selectOption({ label: options.label })
        } else if (options.index != null) {
            await resolved.element.selectOption({ index: options.index })
        } else {
            return {
                ok: false,
                error: 'Select requires value, label, or index.',
            }
        }

        return {
            ok: true,
            path,
            usedSelector: resolved.usedSelector,
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Select failed.'
        return { ok: false, error: message }
    } finally {
        await resolved.element.dispose()
    }
}
