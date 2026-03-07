import type { ElementHandle } from 'playwright'
import {
    normalizeExtractedValue,
    resolveExtractedValueInContext,
} from './extract-value-normalization.js'

interface ExtractedValueReadPayload {
    raw: string | null
    baseURI: string | null
    insideIframe: boolean
}

export async function readExtractedValueFromHandle(
    element: ElementHandle<Element>,
    options: { attribute?: string }
): Promise<string | null> {
    const payload = await element.evaluate(
        (target, browserOptions): ExtractedValueReadPayload => {
            const ownerDocument = target.ownerDocument
            const view = ownerDocument?.defaultView
            const frameElement = view?.frameElement
            const frameTag = String(frameElement?.tagName || '').toLowerCase()

            return {
                raw: browserOptions.attribute
                    ? target.getAttribute(browserOptions.attribute)
                    : target.textContent,
                baseURI: ownerDocument?.baseURI || null,
                insideIframe: frameTag === 'iframe',
            }
        },
        {
            attribute: options.attribute,
        }
    )

    const normalizedValue = normalizeExtractedValue(
        payload.raw,
        options.attribute
    )

    return resolveExtractedValueInContext(normalizedValue, {
        attribute: options.attribute,
        baseURI: payload.baseURI,
        insideIframe: payload.insideIframe,
    })
}
