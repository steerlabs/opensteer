import type { Page } from 'playwright'
import {
    OVERSTEER_HIDDEN_ATTR,
    OVERSTEER_INTERACTIVE_ATTR,
    OVERSTEER_SCROLLABLE_ATTR,
} from '../../src/html/interactivity.js'
import { getTestAppRoute } from './testApp.js'

export async function gotoRoute(page: Page, route: string): Promise<void> {
    await page.goto(getTestAppRoute(route), { waitUntil: 'networkidle' })
}

export async function getMarkedIds(
    page: Page,
    attribute: string
): Promise<string[]> {
    return page.$$eval(`[${attribute}]`, (elements) =>
        elements
            .map((element) => element.id)
            .filter(
                (id): id is string => typeof id === 'string' && id.length > 0
            )
    )
}

export async function getInteractiveIds(page: Page): Promise<string[]> {
    return getMarkedIds(page, OVERSTEER_INTERACTIVE_ATTR)
}

export async function getHiddenIds(page: Page): Promise<string[]> {
    return getMarkedIds(page, OVERSTEER_HIDDEN_ATTR)
}

export async function getScrollableIds(page: Page): Promise<string[]> {
    return getMarkedIds(page, OVERSTEER_SCROLLABLE_ATTR)
}
