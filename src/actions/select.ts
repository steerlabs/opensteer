import type { Page } from 'playwright'
import type { SelectOptions } from '../types.js'
import type { ElementPath } from '../element-path/types.js'
import { resolveElementPath } from '../element-path/resolver.js'
import { probeActionabilityState } from './actionability-probe.js'
import {
    classifyActionFailure,
    defaultActionFailureMessage,
} from './failure-classifier.js'
import { classifyPathResolutionFailure } from './path-resolution.js'
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
        const failure = classifyPathResolutionFailure('select', err)
        return { ok: false, error: failure.message, failure }
    }

    try {
        if (options.value != null) {
            await resolved.element.selectOption(options.value)
        } else if (options.label != null) {
            await resolved.element.selectOption({ label: options.label })
        } else if (options.index != null) {
            await resolved.element.selectOption({ index: options.index })
        } else {
            const failure = classifyActionFailure({
                action: 'select',
                error: new Error('Select requires value, label, or index.'),
                fallbackMessage: defaultActionFailureMessage('select'),
            })
            return {
                ok: false,
                error: failure.message,
                failure,
            }
        }

        return {
            ok: true,
            path,
            usedSelector: resolved.usedSelector,
        }
    } catch (err) {
        const failure = classifyActionFailure({
            action: 'select',
            error: err,
            fallbackMessage: defaultActionFailureMessage('select'),
            probe: await probeActionabilityState(resolved.element),
        })
        return { ok: false, error: failure.message, failure }
    } finally {
        await resolved.element.dispose()
    }
}
