import * as cheerio from 'cheerio'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Opensteer } from '../../src/opensteer.js'
import { resolveElementPath } from '../../src/element-path/resolver.js'
import { prepareSnapshot } from '../../src/html/pipeline.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('integration/counter-bindings', () => {
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

    it('keeps sticky counters for unchanged nodes across snapshots', async () => {
        await setFixture(
            page,
            `
            <button id="save" onclick="document.querySelector('#status').textContent='clicked'">Save</button>
            <p id="status">idle</p>
            `
        )

        const opensteer = Opensteer.from(page)

        const first = await opensteer.snapshot({ mode: 'full', withCounters: true })
        const first$ = cheerio.load(first)
        const firstCounter = Number.parseInt(
            first$('#save').attr('c') || '',
            10
        )
        expect(Number.isFinite(firstCounter)).toBe(true)

        await page.evaluate(() => {
            const badge = document.createElement('span')
            badge.id = 'minor-change'
            badge.textContent = 'new sibling'
            document.body.appendChild(badge)
        })

        const second = await opensteer.snapshot({ mode: 'full', withCounters: true })
        const second$ = cheerio.load(second)
        const secondCounter = Number.parseInt(
            second$('#save').attr('c') || '',
            10
        )

        expect(secondCounter).toBe(firstCounter)
    })

    it('fails hard on stale counters after node replacement and succeeds after a new snapshot', async () => {
        await setFixture(
            page,
            `
            <button id="save" onclick="document.querySelector('#status').textContent='clicked'">Save</button>
            <p id="status">idle</p>
            `
        )

        const opensteer = Opensteer.from(page)

        const first = await opensteer.snapshot({ mode: 'full', withCounters: true })
        const first$ = cheerio.load(first)
        const staleCounter = Number.parseInt(
            first$('#save').attr('c') || '',
            10
        )
        expect(Number.isFinite(staleCounter)).toBe(true)

        await page.evaluate(() => {
            const oldNode = document.querySelector('#save')
            if (!oldNode) return
            const replacement = document.createElement('button')
            replacement.id = 'save'
            replacement.textContent = 'Save'
            replacement.setAttribute(
                'onclick',
                "document.querySelector('#status').textContent='clicked'"
            )
            oldNode.replaceWith(replacement)
            const status = document.querySelector('#status')
            if (status) status.textContent = 'idle'
        })

        await expect(
            opensteer.click({ element: staleCounter, button: 'left', clickCount: 1 })
        ).rejects.toThrow(/snapshot\(\) again/i)

        const second = await opensteer.snapshot({ mode: 'full', withCounters: true })
        const second$ = cheerio.load(second)
        const freshCounter = Number.parseInt(
            second$('#save').attr('c') || '',
            10
        )
        expect(Number.isFinite(freshCounter)).toBe(true)
        expect(freshCounter).not.toBe(staleCounter)

        await opensteer.click({ element: freshCounter, button: 'left', clickCount: 1 })
        expect((await page.textContent('#status'))?.trim()).toBe('clicked')
    })

    it('overwrites conflicting page node ids and preserves correct counter mapping', async () => {
        await setFixture(
            page,
            `
            <button id="a" data-os-node-id="collision">A</button>
            <button id="b" data-os-node-id="collision">B</button>
            `
        )

        const snapshot = await prepareSnapshot(page, {
            mode: 'full',
            withCounters: true,
            markInteractive: true,
        })

        const $$ = cheerio.load(snapshot.cleanedHtml)
        const counterA = Number.parseInt($$('#a').attr('c') || '', 10)
        const counterB = Number.parseInt($$('#b').attr('c') || '', 10)

        expect(Number.isFinite(counterA)).toBe(true)
        expect(Number.isFinite(counterB)).toBe(true)
        expect(counterA).not.toBe(counterB)

        const pathA = snapshot.counterIndex?.get(counterA)
        const pathB = snapshot.counterIndex?.get(counterB)
        expect(pathA).toBeTruthy()
        expect(pathB).toBeTruthy()
        if (!pathA || !pathB) {
            throw new Error('Expected paths for both counters.')
        }

        const resolvedA = await resolveElementPath(page, pathA)
        const resolvedB = await resolveElementPath(page, pathB)
        try {
            const idA = await resolvedA.element.getAttribute('id')
            const idB = await resolvedB.element.getAttribute('id')
            expect(idA).toBe('a')
            expect(idB).toBe('b')
        } finally {
            await resolvedA.element.dispose()
            await resolvedB.element.dispose()
        }
    })

    it('resolves counter actions inside same-origin iframes', async () => {
        await setFixture(
            page,
            `
            <iframe
              id="frame-host"
              srcdoc="<html><body><input id='inside-input' value='' /></body></html>"
            ></iframe>
            `
        )

        await page
            .frameLocator('#frame-host')
            .locator('#inside-input')
            .waitFor({ state: 'visible' })

        const opensteer = Opensteer.from(page)
        const html = await opensteer.snapshot({ mode: 'full', withCounters: true })
        const $$ = cheerio.load(html)
        const counter = Number.parseInt(
            $$('#frame-host + os-iframe-root #inside-input').attr('c') || '',
            10
        )
        expect(Number.isFinite(counter)).toBe(true)

        await opensteer.input({ element: counter, text: 'from-counter' })

        const childFrame = page
            .frames()
            .find((candidate) => candidate !== page.mainFrame())
        expect(childFrame).toBeTruthy()
        expect(await childFrame!.inputValue('#inside-input')).toBe(
            'from-counter'
        )
    })

    it('resolves counter actions inside open shadow roots', async () => {
        await setFixture(
            page,
            `
            <div id="host"></div>
            <p id="status">idle</p>
            <script>
              const host = document.querySelector('#host')
              const root = host?.attachShadow({ mode: 'open' })
              if (root) {
                root.innerHTML = '<button id="inside-btn" onclick="document.querySelector(\\'#status\\').textContent=\\'clicked\\'">Do it</button>'
              }
            </script>
            `
        )

        const opensteer = Opensteer.from(page)
        const html = await opensteer.snapshot({ mode: 'full', withCounters: true })
        const $$ = cheerio.load(html)
        const counter = Number.parseInt(
            $$('#host os-shadow-root #inside-btn').attr('c') || '',
            10
        )
        expect(Number.isFinite(counter)).toBe(true)

        await opensteer.click({ element: counter, button: 'left', clickCount: 1 })
        expect((await page.textContent('#status'))?.trim()).toBe('clicked')
    })

    it('extracts counter fields in batch and fails when a bound node is replaced', async () => {
        await setFixture(
            page,
            `
            <h1 id="title">Main title</h1>
            <iframe
              id="frame-host"
              srcdoc="<html><body><p id='inside' data-kind='child'>Inside text</p></body></html>"
            ></iframe>
            `
        )

        await page
            .frameLocator('#frame-host')
            .locator('#inside')
            .waitFor({ state: 'visible' })

        const opensteer = Opensteer.from(page)
        const html = await opensteer.snapshot({
            mode: 'full',
            withCounters: true,
        })
        const $$ = cheerio.load(html)

        const titleCounter = Number.parseInt($$('#title').attr('c') || '', 10)
        const insideCounter = Number.parseInt(
            $$('#frame-host + os-iframe-root #inside').attr('c') || '',
            10
        )

        expect(Number.isFinite(titleCounter)).toBe(true)
        expect(Number.isFinite(insideCounter)).toBe(true)

        const data = await opensteer.extract<{
            title: string | null
            titleBySelector: string | null
            inside: string | null
            kind: string | null
        }>({
            schema: {
                title: { element: titleCounter },
                titleBySelector: { selector: '#title' },
                inside: { element: insideCounter },
                kind: { element: insideCounter, attribute: 'data-kind' },
            },
        })

        expect(data).toEqual({
            title: 'Main title',
            titleBySelector: 'Main title',
            inside: 'Inside text',
            kind: 'child',
        })

        await page.evaluate(() => {
            const frame =
                document.querySelector<HTMLIFrameElement>('#frame-host')
            if (!frame?.contentDocument) return

            const oldNode = frame.contentDocument.querySelector('#inside')
            if (!oldNode) return

            const replacement = frame.contentDocument.createElement('p')
            replacement.id = 'inside'
            replacement.textContent = 'Inside text'
            replacement.setAttribute('data-kind', 'child')
            oldNode.replaceWith(replacement)
        })

        await expect(
            opensteer.extract({
                schema: {
                    inside: { element: insideCounter },
                },
            })
        ).rejects.toThrow(/snapshot\(\) again/i)
    })

    it('uses text content by default and attributes only when requested for counter fields', async () => {
        await setFixture(
            page,
            `
            <a id="doc-link" href="https://example.com/guides/intro">Intro guide</a>
            <img id="hero-image" src="https://cdn.example.com/hero.png" alt="Hero" />
            <img id="responsive-image" src="https://cdn.example.com/hero-480.png" srcset="https://cdn.example.com/hero-480.png 480w, https://cdn.example.com/hero-1200.png 1200w, https://cdn.example.com/hero-960.png 960w" />
            <img id="retina-image" src="https://cdn.example.com/hero-1x.png" imagesrcset="https://cdn.example.com/hero-1x.png 1x, https://cdn.example.com/hero-3x.png 3x" />
            <a id="tracked-link" href="https://example.com/checkout" ping="https://tracker.example.com/ping https://backup.example.com/ping">Checkout</a>
            <input id="sku-input" value="SKU-9000" />
            <p id="details" data-content="Product details">Visible details</p>
            `
        )

        const opensteer = Opensteer.from(page)
        const html = await opensteer.snapshot({ mode: 'full', withCounters: true })
        const $$ = cheerio.load(html)

        const linkCounter = Number.parseInt($$('#doc-link').attr('c') || '', 10)
        const imageCounter = Number.parseInt(
            $$('#hero-image').attr('c') || '',
            10
        )
        const responsiveImageCounter = Number.parseInt(
            $$('#responsive-image').attr('c') || '',
            10
        )
        const retinaImageCounter = Number.parseInt(
            $$('#retina-image').attr('c') || '',
            10
        )
        const trackedLinkCounter = Number.parseInt(
            $$('#tracked-link').attr('c') || '',
            10
        )
        const inputCounter = Number.parseInt(
            $$('#sku-input').attr('c') || '',
            10
        )
        const detailsCounter = Number.parseInt(
            $$('#details').attr('c') || '',
            10
        )

        expect(Number.isFinite(linkCounter)).toBe(true)
        expect(Number.isFinite(imageCounter)).toBe(true)
        expect(Number.isFinite(responsiveImageCounter)).toBe(true)
        expect(Number.isFinite(retinaImageCounter)).toBe(true)
        expect(Number.isFinite(trackedLinkCounter)).toBe(true)
        expect(Number.isFinite(inputCounter)).toBe(true)
        expect(Number.isFinite(detailsCounter)).toBe(true)

        const data = await opensteer.extract<{
            name: string | null
            url: string | null
            imageText: string | null
            imageSrc: string | null
            responsiveImageSrc: string | null
            retinaImageSrc: string | null
            trackingPing: string | null
            skuText: string | null
            skuValue: string | null
            detailsText: string | null
            detailsContent: string | null
        }>({
            schema: {
                name: { element: linkCounter },
                url: { element: linkCounter, attribute: 'href' },
                imageText: { element: imageCounter },
                imageSrc: { element: imageCounter, attribute: 'src' },
                responsiveImageSrc: {
                    element: responsiveImageCounter,
                    attribute: 'srcset',
                },
                retinaImageSrc: {
                    element: retinaImageCounter,
                    attribute: 'imagesrcset',
                },
                trackingPing: {
                    element: trackedLinkCounter,
                    attribute: 'ping',
                },
                skuText: { element: inputCounter },
                skuValue: { element: inputCounter, attribute: 'value' },
                detailsText: { element: detailsCounter },
                detailsContent: {
                    element: detailsCounter,
                    attribute: 'data-content',
                },
            },
        })

        expect(data).toEqual({
            name: 'Intro guide',
            url: 'https://example.com/guides/intro',
            imageText: null,
            imageSrc: 'https://cdn.example.com/hero.png',
            responsiveImageSrc: 'https://cdn.example.com/hero-1200.png',
            retinaImageSrc: 'https://cdn.example.com/hero-3x.png',
            trackingPing: 'https://tracker.example.com/ping',
            skuText: null,
            skuValue: 'SKU-9000',
            detailsText: 'Visible details',
            detailsContent: 'Product details',
        })
    })

    it('fails with an explicit ambiguity error when duplicate node ids appear', async () => {
        await setFixture(
            page,
            `
            <button id="target">Target</button>
            <button id="duplicate">Duplicate</button>
            `
        )

        const opensteer = Opensteer.from(page)
        const html = await opensteer.snapshot({ mode: 'full', withCounters: true })
        const $$ = cheerio.load(html)
        const targetCounter = Number.parseInt($$('#target').attr('c') || '', 10)
        expect(Number.isFinite(targetCounter)).toBe(true)

        await page.evaluate(() => {
            const target = document.querySelector('#target')
            const duplicate = document.querySelector('#duplicate')
            if (
                !(target instanceof Element) ||
                !(duplicate instanceof Element)
            ) {
                return
            }

            const nodeId = target.getAttribute('data-os-node-id')
            if (!nodeId) return
            duplicate.setAttribute('data-os-node-id', nodeId)
        })

        await expect(
            opensteer.click({ element: targetCounter, button: 'left', clickCount: 1 })
        ).rejects.toThrow(/ambiguous|snapshot\(\) again/i)
    })

    it('fails with frame unavailable when an iframe target is removed', async () => {
        await setFixture(
            page,
            `
            <iframe
              id="frame-host"
              srcdoc="<html><body><input id='inside-input' value='' /></body></html>"
            ></iframe>
            `
        )

        await page
            .frameLocator('#frame-host')
            .locator('#inside-input')
            .waitFor({ state: 'visible' })

        const opensteer = Opensteer.from(page)
        const html = await opensteer.snapshot({ mode: 'full', withCounters: true })
        const $$ = cheerio.load(html)
        const counter = Number.parseInt(
            $$('#frame-host + os-iframe-root #inside-input').attr('c') || '',
            10
        )
        expect(Number.isFinite(counter)).toBe(true)

        await page.evaluate(() => {
            document.querySelector('#frame-host')?.remove()
        })

        await expect(
            opensteer.input({ element: counter, text: 'should-fail' })
        ).rejects.toThrow(/frame.*unavailable|snapshot\(\) again/i)
    })

    it('ignores page-authored c attributes when assigning runtime counters', async () => {
        await setFixture(
            page,
            `
            <button id="a" c="999">A</button>
            <button id="b" c="1000">B</button>
            `
        )

        const opensteer = Opensteer.from(page)
        const html = await opensteer.snapshot({ mode: 'full', withCounters: true })
        const $$ = cheerio.load(html)

        const counterA = Number.parseInt($$('#a').attr('c') || '', 10)
        const counterB = Number.parseInt($$('#b').attr('c') || '', 10)

        expect(Number.isFinite(counterA)).toBe(true)
        expect(Number.isFinite(counterB)).toBe(true)
        expect(counterA).not.toBe(counterB)
        expect(counterA).not.toBe(999)
        expect(counterA).not.toBe(1000)
        expect(counterB).not.toBe(999)
        expect(counterB).not.toBe(1000)
    })

    it('keeps runtime-owned counters stable when page code mutates c attributes', async () => {
        await setFixture(
            page,
            `
            <button id="stable">Stable</button>
            `
        )

        const opensteer = Opensteer.from(page)

        const first = await opensteer.snapshot({ mode: 'full', withCounters: true })
        const first$ = cheerio.load(first)
        const firstCounter = Number.parseInt(
            first$('#stable').attr('c') || '',
            10
        )
        expect(Number.isFinite(firstCounter)).toBe(true)

        await page.evaluate(() => {
            document.querySelector('#stable')?.setAttribute('c', '999999')
        })

        const second = await opensteer.snapshot({ mode: 'full', withCounters: true })
        const second$ = cheerio.load(second)
        const secondCounter = Number.parseInt(
            second$('#stable').attr('c') || '',
            10
        )

        expect(secondCounter).toBe(firstCounter)
        expect(secondCounter).not.toBe(999999)
    })

    it('fails snapshot when multiple nodes claim the same runtime-owned counter', async () => {
        await setFixture(
            page,
            `
            <button id="a">A</button>
            <button id="b">B</button>
            `
        )

        const opensteer = Opensteer.from(page)
        await opensteer.snapshot({ mode: 'full', withCounters: true })

        await page.evaluate(() => {
            const a = document.querySelector('#a') as
                | (Element & Record<string, unknown>)
                | null
            const b = document.querySelector('#b') as
                | (Element & Record<string, unknown>)
                | null
            if (!a || !b) return

            const value = Number(a['__opensteerCounterValue'])
            if (!Number.isFinite(value) || value <= 0) return

            b['__opensteerCounterOwner'] = true
            b['__opensteerCounterValue'] = value
            b.setAttribute('c', String(value))
        })

        await expect(
            opensteer.snapshot({ mode: 'full', withCounters: true })
        ).rejects.toThrow(/multiple nodes|snapshot\(\) again|ambiguous/i)
    })

    it('treats counters as stale after an action replaces the original element node', async () => {
        await setFixture(
            page,
            `
            <button
              id="replace-btn"
              onclick="
                const oldNode = this;
                const replacement = document.createElement('button');
                replacement.id = 'replace-btn';
                replacement.textContent = 'Replace me';
                replacement.setAttribute('onclick', oldNode.getAttribute('onclick') || '');
                oldNode.replaceWith(replacement);
                document.querySelector('#status').textContent = 'replaced';
              "
            >
              Replace me
            </button>
            <p id="status">idle</p>
            `
        )

        const opensteer = Opensteer.from(page)
        const html = await opensteer.snapshot({ mode: 'full', withCounters: true })
        const $$ = cheerio.load(html)
        const counter = Number.parseInt($$('#replace-btn').attr('c') || '', 10)
        expect(Number.isFinite(counter)).toBe(true)

        await opensteer.click({ element: counter, button: 'left', clickCount: 1 })
        expect((await page.textContent('#status'))?.trim()).toBe('replaced')

        await expect(
            opensteer.click({ element: counter, button: 'left', clickCount: 1 })
        ).rejects.toThrow(/snapshot\(\) again/i)
    })

    it('does not expose closed shadow-root elements as counter-addressable', async () => {
        await setFixture(
            page,
            `
            <div id="closed-host"></div>
            <script>
              const host = document.querySelector('#closed-host')
              const root = host?.attachShadow({ mode: 'closed' })
              if (root) {
                root.innerHTML = '<button id="closed-btn">Closed action</button>'
              }
            </script>
            `
        )

        const opensteer = Opensteer.from(page)
        const html = await opensteer.snapshot({ mode: 'full', withCounters: true })
        const $$ = cheerio.load(html)

        expect(html).not.toContain('closed-btn')
        expect($$('#closed-host os-shadow-root').length).toBe(0)
    })
})
