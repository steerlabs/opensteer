import type { Page } from 'playwright'
import type { InputOptions } from '../types.js'
import type { ElementPath } from '../element-path/types.js'
import { resolveElementPath } from '../element-path/resolver.js'
import { probeActionabilityState } from './actionability-probe.js'
import {
    classifyActionFailure,
    defaultActionFailureMessage,
} from './failure-classifier.js'
import { classifyPathResolutionFailure } from './path-resolution.js'
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
        const failure = classifyPathResolutionFailure('input', err)
        return { ok: false, error: failure.message, failure }
    }

    try {
        if (options.clear !== false) {
            await resolved.element.fill(options.text)
        } else {
            await resolved.element.type(options.text)
        }
        if (options.pressEnter) {
            await resolved.element.press('Enter', { noWaitAfter: true })
        }
        return {
            ok: true,
            path,
            usedSelector: resolved.usedSelector,
        }
    } catch (err) {
        const failure = classifyActionFailure({
            action: 'input',
            error: err,
            fallbackMessage: defaultActionFailureMessage('input'),
            probe: await probeActionabilityState(resolved.element),
        })
        return { ok: false, error: failure.message, failure }
    } finally {
        await resolved.element.dispose()
    }
}
