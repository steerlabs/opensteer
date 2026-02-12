import type { Page } from 'playwright'
import type { BoundingBox } from '../types.js'
import type { ElementPath } from '../element-path/types.js'
import { resolveElementPath } from '../element-path/resolver.js'

export async function getElementText(page: Page, path: ElementPath): Promise<string> {
    const resolved = await resolveElementPath(page, path)
    try {
        const text = await resolved.element.textContent()
        return text ?? ''
    } finally {
        await resolved.element.dispose()
    }
}

export async function getElementValue(page: Page, path: ElementPath): Promise<string> {
    const resolved = await resolveElementPath(page, path)
    try {
        return await resolved.element.inputValue()
    } finally {
        await resolved.element.dispose()
    }
}

export async function getElementAttributes(page: Page, path: ElementPath): Promise<Record<string, string>> {
    const resolved = await resolveElementPath(page, path)
    try {
        return await resolved.element.evaluate((el) => {
            const attrs: Record<string, string> = {}
            for (const attr of el.attributes) {
                attrs[attr.name] = attr.value
            }
            return attrs
        })
    } finally {
        await resolved.element.dispose()
    }
}

export async function getElementBoundingBox(page: Page, path: ElementPath): Promise<BoundingBox | null> {
    const resolved = await resolveElementPath(page, path)
    try {
        return await resolved.element.boundingBox()
    } finally {
        await resolved.element.dispose()
    }
}

export async function getPageHtml(page: Page, selector?: string): Promise<string> {
    if (selector) {
        const element = await page.$(selector)
        if (!element) {
            throw new Error(`No element found for selector: ${selector}`)
        }
        try {
            return await element.evaluate((el) => el.outerHTML)
        } finally {
            await element.dispose()
        }
    }

    return await page.content()
}

export async function getPageTitle(page: Page): Promise<string> {
    return await page.title()
}
