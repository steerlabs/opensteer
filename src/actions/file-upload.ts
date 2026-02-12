import type { Page } from 'playwright'
import type { ElementPath } from '../element-path/types.js'
import { resolveElementPath } from '../element-path/resolver.js'
import { formatPathResolutionError } from './path-resolution.js'
import type { ActionExecutionResult } from './types.js'

export async function performFileUpload(
    page: Page,
    path: ElementPath,
    filePaths: string[]
): Promise<ActionExecutionResult> {
    let resolved
    try {
        resolved = await resolveElementPath(page, path)
    } catch (err) {
        return { ok: false, error: formatPathResolutionError(err) }
    }

    try {
        await resolved.element.setInputFiles(filePaths)
        return {
            ok: true,
            path,
            usedSelector: resolved.usedSelector,
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : 'File upload failed.'
        return { ok: false, error: message }
    } finally {
        await resolved.element.dispose()
    }
}
