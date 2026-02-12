import * as cheerio from 'cheerio'
import type { Page } from 'playwright'
import { cloneElementPath } from '../../src/element-path/build.js'
import type { ElementPath } from '../../src/element-path/types.js'
import { prepareSnapshot } from '../../src/html/pipeline.js'

export function wrapFixtureHtml(body: string): string {
    return `<!doctype html><html><head><meta charset="utf-8" /></head><body>${body}</body></html>`
}

export async function setFixture(page: Page, body: string): Promise<void> {
    await page.setContent(wrapFixtureHtml(body))
}

export async function findCounterById(
    page: Page,
    id: string
): Promise<number | null> {
    const snapshot = await prepareSnapshot(page, {
        mode: 'full',
        withCounters: true,
        markInteractive: true,
    })

    const $$ = cheerio.load(snapshot.cleanedHtml)
    const counter = $$(`#${id}`).attr('c')
    if (!counter) return null

    const parsed = Number.parseInt(counter, 10)
    return Number.isFinite(parsed) ? parsed : null
}

export async function buildPathFromCounter(
    page: Page,
    counter: number
): Promise<ElementPath | null> {
    const snapshot = await prepareSnapshot(page, {
        mode: 'full',
        withCounters: true,
        markInteractive: true,
    })

    const path = snapshot.counterIndex?.get(counter)
    return path ? cloneElementPath(path) : null
}

export async function buildPathFromId(
    page: Page,
    id: string
): Promise<ElementPath | null> {
    const counter = await findCounterById(page, id)
    if (!counter) return null
    return buildPathFromCounter(page, counter)
}
