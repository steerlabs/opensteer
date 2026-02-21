import type { Page } from 'playwright'
import type { ClickOptions } from '../types.js'
import type { ElementPath } from '../element-path/types.js'
import { resolveElementPath } from '../element-path/resolver.js'
import { probeActionabilityState } from './actionability-probe.js'
import {
    classifyActionFailure,
    defaultActionFailureMessage,
} from './failure-classifier.js'
import { classifyPathResolutionFailure } from './path-resolution.js'
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
        const failure = classifyPathResolutionFailure('click', err)
        return { ok: false, error: failure.message, failure }
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
        const failure = classifyActionFailure({
            action: 'click',
            error: err,
            fallbackMessage: defaultActionFailureMessage('click'),
            probe: await probeActionabilityState(resolved.element),
        })
        return { ok: false, error: failure.message, failure }
    } finally {
        await resolved.element.dispose()
    }
}
