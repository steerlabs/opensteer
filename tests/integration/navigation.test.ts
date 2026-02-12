import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { markInteractiveElements } from '../../src/html/interactivity.js'
import { performClick } from '../../src/actions/click.js'
import { buildElementPathFromSelector } from '../../src/element-path/build.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { getInteractiveIds, gotoRoute } from '../helpers/integration.js'

describe('integration/navigation', () => {
    let context: BrowserContext
    let page: Page

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        await gotoRoute(page, '/navigation')
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it('marks navigation affordances as interactive', async () => {
        await markInteractiveElements(page)
        const interactive = await getInteractiveIds(page)

        expect(interactive).toContain('tab-overview')
        expect(interactive).toContain('tab-alerts')
        expect(interactive).toContain('accordion-trigger')
        expect(interactive).toContain('pagination-next')
    })

    it('switches tabs, expands accordion, and paginates', async () => {
        const alertsTab = await buildElementPathFromSelector(
            page,
            '#tab-alerts'
        )
        const accordion = await buildElementPathFromSelector(
            page,
            '#accordion-trigger'
        )
        const nextPage = await buildElementPathFromSelector(
            page,
            '#pagination-next'
        )

        expect(
            (
                await performClick(page, alertsTab!, {
                    button: 'left',
                    clickCount: 1,
                })
            ).ok
        ).toBe(true)
        expect(
            (await page.textContent('#tab-panel'))?.includes('Alert feed')
        ).toBe(true)

        expect(
            (
                await performClick(page, accordion!, {
                    button: 'left',
                    clickCount: 1,
                })
            ).ok
        ).toBe(true)
        await page.waitForSelector('#accordion-panel', { state: 'visible' })

        expect(
            (
                await performClick(page, nextPage!, {
                    button: 'left',
                    clickCount: 1,
                })
            ).ok
        ).toBe(true)
        expect((await page.textContent('#pagination-current'))?.trim()).toBe(
            'Page 3'
        )
    })
})
