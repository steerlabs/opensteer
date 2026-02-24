import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Opensteer } from '../../src/opensteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { gotoRoute } from '../helpers/integration.js'

const ONE_PIXEL_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBgQf4tpsAAAAASUVORK5CYII=',
    'base64'
)

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms)
    })
}

describe('integration/complex-loading-wait', () => {
    let context: BrowserContext
    let page: Page

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        await gotoRoute(page, '/complex-loading')
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it('waits through complex result readiness without stalling on ongoing polling', async () => {
        let pollHits = 0

        await page.route(/\/__test__\/wait\/poll\?i=\d+/, async (route) => {
            pollHits += 1
            await sleep(40)
            await route.fulfill({
                status: 204,
                contentType: 'text/plain',
                body: '',
            })
        })

        await page.route(/\/__test__\/wait\/slow-search\?q=.*/, async (route) => {
            await sleep(1200)
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: '{"ok":true}',
            })
        })

        await page.route(/\/__test__\/wait\/image\?q=.*/, async (route) => {
            await sleep(220)
            await route.fulfill({
                status: 200,
                contentType: 'image/png',
                body: ONE_PIXEL_PNG,
            })
        })

        const opensteer = Opensteer.from(page, {
            name: 'integration-complex-loading',
        })

        const startedAt = Date.now()
        await opensteer.input({
            selector: '#complex-search-box',
            text: 'airpods',
            pressEnter: true,
            description: 'Complex loading search box',
        })
        const elapsed = Date.now() - startedAt
        const pollHitsAtReturn = pollHits

        expect(page.url()).toContain('/complex-loading/results?q=airpods')
        expect((await page.textContent('#complex-search-status'))?.trim()).toBe(
            'ready'
        )
        expect((await page.textContent('#complex-search-summary'))?.trim()).toBe(
            'results-for-airpods'
        )
        expect((await page.textContent('#complex-image-state'))?.trim()).toBe(
            'image-loaded:yes'
        )
        expect(
            (
                await page
                    .frameLocator('#complex-results-frame')
                    .locator('#frame-status')
                    .textContent()
            )?.trim()
        ).toBe('frame-ready')

        expect(pollHitsAtReturn).toBeGreaterThan(2)
        expect(elapsed).toBeGreaterThanOrEqual(1000)
        expect(elapsed).toBeLessThan(4500)

        await page.waitForTimeout(350)
        expect(pollHits).toBeGreaterThan(pollHitsAtReturn)
    })
})
