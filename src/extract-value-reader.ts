import type { ElementHandle } from 'playwright'
import {
    normalizeExtractedValue,
    resolveExtractedValueInContext,
} from './extract-value-normalization.js'

interface ExtractedValueReadPayload {
    raw: string | null
    baseURI: string | null
}

export async function readExtractedValueFromHandle(
    element: ElementHandle<Element>,
    options: { attribute?: string }
): Promise<string | null> {
    const insideIframe = await isElementInsideIframe(element)
    const payload = await element.evaluate(
        (target, browserOptions): ExtractedValueReadPayload => {
            const ownerDocument = target.ownerDocument

            return {
                raw: browserOptions.attribute
                    ? target.getAttribute(browserOptions.attribute)
                    : target.textContent,
                baseURI: ownerDocument?.baseURI || null,
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
        insideIframe,
    })
}

async function isElementInsideIframe(
    element: ElementHandle<Element>
): Promise<boolean> {
    const ownerFrame = await element.ownerFrame()
    return !!ownerFrame?.parentFrame()
}
