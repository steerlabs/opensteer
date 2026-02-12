import * as cheerio from 'cheerio'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { prepareSnapshot } from '../../src/html/pipeline.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { gotoRoute } from '../helpers/integration.js'

describe('integration/extraction-cleaning', () => {
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

    describe('data page', () => {
        beforeEach(async () => {
            await gotoRoute(page, '/data')
        })

        it('preserves table content text', async () => {
            const snapshot = await prepareSnapshot(page, {
                mode: 'extraction',
            })

            expect(snapshot.cleanedHtml).toContain('Aurora Lamp')
            expect(snapshot.cleanedHtml).toContain('Atlas Desk')
            expect(snapshot.cleanedHtml).toContain('Nimbus Chair')
            expect(snapshot.cleanedHtml).toContain('Quill Notebook')
            expect(snapshot.cleanedHtml).toContain('Echo Speaker')
        })

        it('preserves card region data', async () => {
            const snapshot = await prepareSnapshot(page, {
                mode: 'extraction',
            })

            expect(snapshot.cleanedHtml).toContain('North Region')
            expect(snapshot.cleanedHtml).toContain('$284,200')
            expect(snapshot.cleanedHtml).toContain('+14.2%')
            expect(snapshot.cleanedHtml).toContain('Healthy')
            expect(snapshot.cleanedHtml).toContain('Central Region')
            expect(snapshot.cleanedHtml).toContain('Coastal Region')
        })

        it('preserves nested department metrics', async () => {
            const snapshot = await prepareSnapshot(page, {
                mode: 'extraction',
            })

            expect(snapshot.cleanedHtml).toContain('Tickets resolved: 482')
            expect(snapshot.cleanedHtml).toContain('Median response: 2.3h')
            expect(snapshot.cleanedHtml).toContain(
                'Roadmap items shipped: 12'
            )
        })

        it('strips all non-essential attributes', async () => {
            const snapshot = await prepareSnapshot(page, {
                mode: 'extraction',
            })
            const html = snapshot.cleanedHtml

            expect(html).not.toContain('class=')
            expect(html).not.toContain('style=')
            expect(html).not.toContain('id=')
            expect(html).not.toContain('data-testid=')
        })

        it('produces significantly smaller output than raw html', async () => {
            const snapshot = await prepareSnapshot(page, {
                mode: 'extraction',
            })

            const reductionRatio =
                snapshot.cleanedHtml.length / snapshot.rawHtml.length
            expect(reductionRatio).toBeLessThan(0.5)
        })
    })

    describe('forms page', () => {
        beforeEach(async () => {
            await gotoRoute(page, '/forms')
        })

        it('preserves form labels and button text', async () => {
            const snapshot = await prepareSnapshot(page, {
                mode: 'extraction',
            })

            expect(snapshot.cleanedHtml).toContain('Full name')
            expect(snapshot.cleanedHtml).toContain('Email address')
            expect(snapshot.cleanedHtml).toContain('Password')
            expect(snapshot.cleanedHtml).toContain('Submit profile')
        })

        it('strips class, style, and data attributes', async () => {
            const snapshot = await prepareSnapshot(page, {
                mode: 'extraction',
            })
            const html = snapshot.cleanedHtml

            expect(html).not.toContain('class=')
            expect(html).not.toContain('style=')
            expect(html).not.toContain('data-opensteer-hidden=')
        })

        it('does not contain script or style tags', async () => {
            const snapshot = await prepareSnapshot(page, {
                mode: 'extraction',
            })

            expect(snapshot.cleanedHtml).not.toContain('<script')
            expect(snapshot.cleanedHtml).not.toContain('<style')
            expect(snapshot.cleanedHtml).not.toContain('<noscript')
        })

        it('omits html, head, and body wrapper tags', async () => {
            const snapshot = await prepareSnapshot(page, {
                mode: 'extraction',
            })

            expect(snapshot.cleanedHtml).not.toMatch(/<html[\s>]/)
            expect(snapshot.cleanedHtml).not.toMatch(/<head[\s>]/)
            expect(snapshot.cleanedHtml).not.toMatch(/<body[\s>]/)
        })
    })

    describe('navigation page', () => {
        beforeEach(async () => {
            await gotoRoute(page, '/navigation')
        })

        it('preserves link hrefs', async () => {
            const snapshot = await prepareSnapshot(page, {
                mode: 'extraction',
            })
            const $ = cheerio.load(snapshot.cleanedHtml)

            const anchors = $('a[href]')
            expect(anchors.length).toBeGreaterThan(0)

            anchors.each(function () {
                const href = $(this).attr('href')
                expect(href).toBeDefined()
                expect(href!.length).toBeGreaterThan(0)
            })
        })

        it('preserves breadcrumb and sidebar text', async () => {
            const snapshot = await prepareSnapshot(page, {
                mode: 'extraction',
            })

            expect(snapshot.cleanedHtml).toContain('Workflow Runner')
            expect(snapshot.cleanedHtml).toContain('Dashboard')
            expect(snapshot.cleanedHtml).toContain('Overview')
        })

        it('strips all non-essential attributes', async () => {
            const snapshot = await prepareSnapshot(page, {
                mode: 'extraction',
            })
            const html = snapshot.cleanedHtml

            expect(html).not.toContain('class=')
            expect(html).not.toContain('role=')
            expect(html).not.toContain('aria-label=')
            expect(html).not.toContain('aria-selected=')
        })
    })

    describe('index page', () => {
        beforeEach(async () => {
            await gotoRoute(page, '/')
        })

        it('preserves scenario titles and descriptions', async () => {
            const snapshot = await prepareSnapshot(page, {
                mode: 'extraction',
            })

            expect(snapshot.cleanedHtml).toContain('Forms')
            expect(snapshot.cleanedHtml).toContain('Data Extraction')
            expect(snapshot.cleanedHtml).toContain('Overlays')
            expect(snapshot.cleanedHtml).toContain(
                'Opensteer OSS Test Fixtures'
            )
        })

        it('preserves links with their hrefs', async () => {
            const snapshot = await prepareSnapshot(page, {
                mode: 'extraction',
            })
            const $ = cheerio.load(snapshot.cleanedHtml)

            const formLink = $('a[href="/forms"]')
            expect(formLink.length).toBeGreaterThan(0)
            expect(formLink.text()).toContain('Open scenario')

            const dataLink = $('a[href="/data"]')
            expect(dataLink.length).toBeGreaterThan(0)
        })

        it('assigns counter attributes to retained elements', async () => {
            const snapshot = await prepareSnapshot(page, {
                mode: 'extraction',
                withCounters: true,
            })
            const $ = cheerio.load(snapshot.cleanedHtml)

            const counters: number[] = []
            $('[c]').each(function () {
                const value = Number.parseInt($(this).attr('c') || '', 10)
                if (Number.isFinite(value)) counters.push(value)
            })

            expect(counters.length).toBeGreaterThan(0)

            const sorted = [...counters].sort((a, b) => a - b)
            sorted.forEach((value, index) => {
                if (index > 0) {
                    expect(value).toBe(sorted[index - 1] + 1)
                }
            })
        })

        it('counter bindings match c attrs in cleaned html', async () => {
            const snapshot = await prepareSnapshot(page, {
                mode: 'extraction',
                withCounters: true,
            })
            const $ = cheerio.load(snapshot.cleanedHtml)

            const htmlCounters = new Set<number>()
            $('[c]').each(function () {
                const value = Number.parseInt($(this).attr('c') || '', 10)
                if (Number.isFinite(value)) htmlCounters.add(value)
            })

            const bindingKeys = new Set(snapshot.counterBindings?.keys() || [])
            expect(htmlCounters).toEqual(bindingKeys)
        })
    })

    describe('output format', () => {
        it('uses indented lines instead of minified html', async () => {
            await gotoRoute(page, '/data')
            const snapshot = await prepareSnapshot(page, {
                mode: 'extraction',
            })
            const lines = snapshot.cleanedHtml.split('\n')

            expect(lines.length).toBeGreaterThan(5)

            const indentedLines = lines.filter((line) =>
                line.startsWith('  ')
            )
            expect(indentedLines.length).toBeGreaterThan(0)
        })

        it('does not contain html comments', async () => {
            await gotoRoute(page, '/forms')
            const snapshot = await prepareSnapshot(page, {
                mode: 'extraction',
            })

            expect(snapshot.cleanedHtml).not.toContain('<!--')
        })

        it('does not contain data-ov-node-id attributes', async () => {
            await gotoRoute(page, '/data')
            const snapshot = await prepareSnapshot(page, {
                mode: 'extraction',
            })

            expect(snapshot.cleanedHtml).not.toContain('data-ov-node-id')
        })

        it('extraction is smaller than full mode on same page', async () => {
            await gotoRoute(page, '/forms')
            const extraction = await prepareSnapshot(page, {
                mode: 'extraction',
            })
            const full = await prepareSnapshot(page, { mode: 'full' })

            expect(extraction.cleanedHtml.length).toBeLessThan(
                full.cleanedHtml.length
            )
        })
    })
})
