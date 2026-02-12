import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { markInteractiveElements } from '../../src/html/interactivity.js'
import { prepareSnapshot } from '../../src/html/pipeline.js'
import { performScroll } from '../../src/actions/scroll.js'
import { buildElementPathFromSelector } from '../../src/element-path/build.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { getScrollableIds, gotoRoute } from '../helpers/integration.js'

describe('integration/scroll-containers', () => {
    let context: BrowserContext
    let page: Page

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        await gotoRoute(page, '/scroll')
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it('marks nested scroll regions with scrollable metadata', async () => {
        await markInteractiveElements(page)

        const scrollable = await getScrollableIds(page)
        expect(scrollable).toContain('outer-scroll')
        expect(scrollable).toContain('inner-vertical')
        expect(scrollable).toContain('inner-horizontal')
        expect(scrollable).toContain('nested-outer')
        expect(scrollable).toContain('nested-inner')
    })

    it('scrolls a nested container by descriptor', async () => {
        const descriptor = await buildElementPathFromSelector(
            page,
            '#inner-vertical'
        )
        const result = await performScroll(page, descriptor, {
            direction: 'down',
            amount: 200,
        })

        expect(result.ok).toBe(true)

        const scrollTop = await page
            .locator('#inner-vertical')
            .evaluate((el) => (el as HTMLElement).scrollTop)
        expect(scrollTop).toBeGreaterThan(0)
    })

    it('creates scrollable mode snapshots with marker attributes', async () => {
        const snapshot = await prepareSnapshot(page, { mode: 'scrollable' })

        expect(snapshot.cleanedHtml).toContain('data-opensteer-scrollable')
        expect(snapshot.cleanedHtml).toContain('c="')
    })
})
