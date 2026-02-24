import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Opensteer } from '../../src/opensteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'

const runExternalWaitSmoke = process.env.RUN_EXTERNAL_WAIT_SMOKE === '1'
const describeExternalWaitSmoke = runExternalWaitSmoke ? describe : describe.skip

interface ExternalWaitScenario {
    id: string
    url: string
    selector: string
    query: string
    expectedUrlContains: string
}

const scenarios: ExternalWaitScenario[] = [
    {
        id: 'amazon',
        url: 'https://www.amazon.com',
        selector: '#twotabsearchtextbox',
        query: 'airpods',
        expectedUrlContains: '/s?k=airpods',
    },
    {
        id: 'wikipedia',
        url: 'https://en.wikipedia.org/wiki/Main_Page',
        selector: '#searchInput',
        query: 'airpods',
        expectedUrlContains: '/wiki/AirPods',
    },
    {
        id: 'ebay',
        url: 'https://www.ebay.com',
        selector: '#gh-ac',
        query: 'airpods',
        expectedUrlContains: '/sch/i.html?_nkw=airpods',
    },
]

describeExternalWaitSmoke('integration/external-wait-smoke', () => {
    let context: BrowserContext
    let page: Page

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    for (const scenario of scenarios) {
        it(
            `keeps ${scenario.id} search submission responsive`,
            async () => {
                await page.goto(scenario.url, { waitUntil: 'domcontentloaded' })
                await page.waitForSelector(scenario.selector, { timeout: 25000 })

                const opensteer = Opensteer.from(page, {
                    name: `external-wait-${scenario.id}`,
                })

                const startedAt = Date.now()
                await opensteer.input({
                    selector: scenario.selector,
                    text: scenario.query,
                    pressEnter: true,
                    description: `${scenario.id} search box`,
                })
                const elapsed = Date.now() - startedAt

                expect(page.url()).toContain(scenario.expectedUrlContains)
                expect(elapsed).toBeLessThan(6000)
            },
            { timeout: 45000 }
        )
    }
})
