import type { Page } from 'playwright'
import type { ElementPath } from '../element-path/types.js'
import { resolveElementPath } from '../element-path/resolver.js'
import { probeActionabilityState } from './actionability-probe.js'
import {
    classifyActionFailure,
    defaultActionFailureMessage,
} from './failure-classifier.js'
import { classifyPathResolutionFailure } from './path-resolution.js'
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
        const failure = classifyPathResolutionFailure('uploadFile', err)
        return { ok: false, error: failure.message, failure }
    }

    try {
        await resolved.element.setInputFiles(filePaths)
        return {
            ok: true,
            path,
            usedSelector: resolved.usedSelector,
        }
    } catch (err) {
        const failure = classifyActionFailure({
            action: 'uploadFile',
            error: err,
            fallbackMessage: defaultActionFailureMessage('uploadFile'),
            probe: await probeActionabilityState(resolved.element),
        })
        return { ok: false, error: failure.message, failure }
    } finally {
        await resolved.element.dispose()
    }
}
