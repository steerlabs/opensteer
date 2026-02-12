import fs from 'fs'
import os from 'os'
import path from 'path'
import {
    afterAll,
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { prepareSnapshot } from '../../src/html/pipeline.js'
import { performClick } from '../../src/actions/click.js'
import { buildElementPathFromSelector } from '../../src/element-path/build.js'
import { Oversteer } from '../../src/oversteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { gotoRoute } from '../helpers/integration.js'

describe('integration/data-extraction', () => {
    let context: BrowserContext
    let page: Page

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        await gotoRoute(page, '/data')
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it('captures rich extraction snapshot content', async () => {
        const snapshot = await prepareSnapshot(page, { mode: 'extraction' })

        expect(snapshot.cleanedHtml).toContain('Aurora Lamp')
        expect(snapshot.cleanedHtml).toContain('Inventory Table')
        expect(snapshot.cleanedHtml).toContain('Nested Department Metrics')
    })

    it('allows sorting interactions before extraction', async () => {
        const sortByPrice = await buildElementPathFromSelector(
            page,
            '#sort-price'
        )
        const clickResult = await performClick(page, sortByPrice!, {
            button: 'left',
            clickCount: 1,
        })
        expect(clickResult.ok).toBe(true)

        await page.waitForSelector('[data-testid="name-p-4"]', {
            state: 'visible',
        })
    })

    it('extracts string values through Oversteer schema selectors', async () => {
        const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-int-data-'))
        const ov = Oversteer.from(page, {
            name: 'integration-data',
            storage: { rootDir },
        })

        const data = await ov.extract<{
            region: string
            revenue: string
            health: string
            itemName: string
        }>({
            schema: {
                region: { selector: '#card-a h3' },
                revenue: {
                    selector: '#card-a p:nth-of-type(1)',
                },
                health: { selector: '#card-a p:last-of-type' },
                itemName: {
                    selector: '[data-testid="name-p-1"]',
                },
            },
        })

        expect(data.region).toBe('North Region')
        expect(data.revenue).toBe('$284,200')
        expect(data.health).toBe('Healthy')
        expect(data.itemName).toBe('Aurora Lamp')
    })

    it('resolves CURRENT_URL from AI extraction data and replays from cache', async () => {
        const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-int-data-'))
        const extract = vi.fn(async () => ({
            data: {
                pageUrl: 'CURRENT_URL',
            },
        }))

        const ov = Oversteer.from(page, {
            name: 'integration-data-current-url',
            storage: { rootDir },
            ai: {
                extract,
            },
        })

        const description = 'extract current page url'
        const schema = {
            pageUrl: '',
        }

        const first = await ov.extract<{ pageUrl: string }>({
            description,
            schema,
        })
        const second = await ov.extract<{ pageUrl: string }>({
            description,
            schema,
        })

        expect(first).toEqual({ pageUrl: page.url() })
        expect(second).toEqual({ pageUrl: page.url() })
        expect(extract).toHaveBeenCalledTimes(1)
    })
})
