import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { prepareSnapshot } from '../../src/html/pipeline.js'
import { performClick } from '../../src/actions/click.js'
import { buildElementPathFromSelector } from '../../src/element-path/build.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { gotoRoute } from '../helpers/integration.js'

describe('integration/dynamic-content', () => {
    let context: BrowserContext
    let page: Page

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        await gotoRoute(page, '/dynamic')
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it('transitions from skeleton to loaded content', async () => {
        await page.waitForSelector('#loading-skeleton', { state: 'visible' })
        await page.waitForSelector('#loaded-content', {
            state: 'visible',
            timeout: 5000,
        })
    })

    it('triggers animation and delayed content via click actions', async () => {
        const revealDescriptor = await buildElementPathFromSelector(
            page,
            '#animate-panel-btn'
        )
        const delayedDescriptor = await buildElementPathFromSelector(
            page,
            '#queue-update-btn'
        )

        expect(
            (
                await performClick(page, revealDescriptor!, {
                    button: 'left',
                    clickCount: 1,
                })
            ).ok
        ).toBe(true)
        expect(
            (
                await performClick(page, delayedDescriptor!, {
                    button: 'left',
                    clickCount: 1,
                })
            ).ok
        ).toBe(true)

        const animatedClass = await page.getAttribute(
            '#animated-panel',
            'class'
        )
        expect(animatedClass).toMatch(/fade-slide-enter-active/)
        await page.waitForSelector('#delayed-message', {
            state: 'visible',
            timeout: 5000,
        })
    })

    it('captures suspense output in action snapshot', async () => {
        await page.waitForSelector('#lazy-stats-panel', {
            state: 'visible',
            timeout: 5000,
        })

        const snapshot = await prepareSnapshot(page, { mode: 'action' })
        expect(snapshot.cleanedHtml).toContain('Pipeline recovered')
        expect(snapshot.cleanedHtml).toContain('Delayed')
    })
})
