import * as cheerio from 'cheerio'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { extractWithPaths } from '../../src/actions/extract.js'
import { cloneElementPath } from '../../src/element-path/build.js'
import type { ElementPath } from '../../src/element-path/types.js'
import { prepareSnapshot } from '../../src/html/pipeline.js'
import { Opensteer } from '../../src/opensteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('integration/iframe-url-extraction', () => {
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

    it('resolves representative iframe href values through path extraction', async () => {
        await setIframeFixture(page)
        const paths = await buildPathsFromSnapshotSelectors(page, {
            href: innerSelector('#link'),
        })

        const data = await extractWithPaths(page, [
            {
                key: 'href',
                path: paths.href,
                attribute: 'href',
            },
        ])

        expect(data).toEqual({
            href: 'https://fixtures.opensteer.dev/deep/path/products/item?ref=1#specs',
        })
    })

    it('resolves iframe url-like attributes for shadow descendants inside iframes', async () => {
        await setIframeFixture(page)
        const paths = await buildPathsFromSnapshotSelectors(page, {
            shadowHref: innerSelector('#shadow-host os-shadow-root #shadow-link'),
        })

        const data = await extractWithPaths(page, [
            {
                key: 'shadowHref',
                path: paths.shadowHref,
                attribute: 'href',
            },
        ])

        expect(data).toEqual({
            shadowHref: 'https://fixtures.opensteer.dev/deep/path/inside/shadow',
        })
    })

    it('matches the same iframe url resolution behavior for counter extraction across the allowlist and stable edge cases', async () => {
        await setIframeFixture(page)

        const opensteer = Opensteer.from(page)
        const html = await opensteer.snapshot({ mode: 'full', withCounters: true })
        const $$ = cheerio.load(html)

        const data = await opensteer.extract<{
            href: string | null
            src: string | null
            action: string | null
            formaction: string | null
            poster: string | null
            srcset: string | null
            imagesrcset: string | null
            ping: string | null
            shadowHref: string | null
            absoluteHref: string | null
            protocolSrc: string | null
            emptyHref: string | null
            emptyAction: string | null
        }>({
            schema: {
                href: {
                    element: requireCounter($$, innerSelector('#link')),
                    attribute: 'href',
                },
                src: {
                    element: requireCounter($$, innerSelector('#image')),
                    attribute: 'src',
                },
                action: {
                    element: requireCounter($$, innerSelector('#checkout-form')),
                    attribute: 'action',
                },
                formaction: {
                    element: requireCounter($$, innerSelector('#buy-now')),
                    attribute: 'formaction',
                },
                poster: {
                    element: requireCounter($$, innerSelector('#preview')),
                    attribute: 'poster',
                },
                srcset: {
                    element: requireCounter($$, innerSelector('#responsive')),
                    attribute: 'srcset',
                },
                imagesrcset: {
                    element: requireCounter($$, innerSelector('#retina')),
                    attribute: 'imagesrcset',
                },
                ping: {
                    element: requireCounter($$, innerSelector('#tracker')),
                    attribute: 'ping',
                },
                shadowHref: {
                    element: requireCounter(
                        $$,
                        innerSelector('#shadow-host os-shadow-root #shadow-link')
                    ),
                    attribute: 'href',
                },
                absoluteHref: {
                    element: requireCounter($$, innerSelector('#absolute-link')),
                    attribute: 'href',
                },
                protocolSrc: {
                    element: requireCounter($$, innerSelector('#protocol-image')),
                    attribute: 'src',
                },
                emptyHref: {
                    element: requireCounter($$, innerSelector('#empty-link')),
                    attribute: 'href',
                },
                emptyAction: {
                    element: requireCounter($$, innerSelector('#empty-form')),
                    attribute: 'action',
                },
            },
        })

        expect(data).toEqual({
            href: 'https://fixtures.opensteer.dev/deep/path/products/item?ref=1#specs',
            src: 'https://fixtures.opensteer.dev/assets/item.png',
            action: 'https://fixtures.opensteer.dev/deep/path/?submit=1',
            formaction: 'https://fixtures.opensteer.dev/deep/path/#confirm',
            poster: 'https://fixtures.opensteer.dev/deep/path/media/poster.jpg',
            srcset: 'https://fixtures.opensteer.dev/deep/path/images/item-1280.png',
            imagesrcset:
                'https://fixtures.opensteer.dev/deep/path/images/item-3x.png',
            ping: 'https://fixtures.opensteer.dev/deep/track/ping',
            shadowHref: 'https://fixtures.opensteer.dev/deep/path/inside/shadow',
            absoluteHref: 'https://example.com/absolute',
            protocolSrc: 'https://cdn.example.com/media/item.png',
            emptyHref: null,
            emptyAction: null,
        })
    })
})

async function setIframeFixture(page: Page): Promise<void> {
    await setFixture(page, '<iframe id="frame-host"></iframe>')

    await page.evaluate(() => {
        const frame = document.querySelector('#frame-host')
        if (!(frame instanceof HTMLIFrameElement)) return

        frame.srcdoc = `<!doctype html><html><head><base href="https://fixtures.opensteer.dev/deep/path/" /></head><body>
            <a id="link" href="products/item?ref=1#specs">Item</a>
            <img id="image" src="/assets/item.png" />
            <form id="checkout-form" action="?submit=1">
                <button type="submit">Checkout</button>
            </form>
            <button id="buy-now" formaction="#confirm">Buy now</button>
            <video id="preview" poster="media/poster.jpg"></video>
            <img id="responsive" src="images/item-fallback.png" srcset="images/item-320.png 320w, images/item-1280.png 1280w" />
            <img id="retina" src="images/item-retina-fallback.png" imagesrcset="images/item-1x.png 1x, images/item-3x.png 3x" />
            <a id="tracker" ping="../track/ping https://backup.example/ping">Track</a>
            <a id="absolute-link" href="https://example.com/absolute">Absolute</a>
            <img id="protocol-image" src="//cdn.example.com/media/item.png" />
            <a id="empty-link" href="">Empty link</a>
            <form id="empty-form" action="">
                <button type="submit">Empty action</button>
            </form>
            <div id="shadow-host"></div>
        </body></html>`
    })

    await page.waitForFunction(() => {
        const frame = document.querySelector('#frame-host')
        if (!(frame instanceof HTMLIFrameElement)) return false
        return !!frame.contentDocument?.querySelector('#tracker')
    })

    await page.evaluate(() => {
        const frame = document.querySelector('#frame-host')
        if (!(frame instanceof HTMLIFrameElement)) return

        const host = frame.contentDocument?.querySelector('#shadow-host')
        if (!host || host.shadowRoot) return

        const root = host.attachShadow({ mode: 'open' })
        root.innerHTML = "<a id='shadow-link' href='inside/shadow'>Shadow item</a>"
    })

    await page.waitForFunction(() => {
        const frame = document.querySelector('#frame-host')
        if (!(frame instanceof HTMLIFrameElement)) return false

        const host = frame.contentDocument?.querySelector('#shadow-host')
        if (!host?.shadowRoot) return false

        return !!host.shadowRoot.querySelector('#shadow-link')
    })
}

async function buildPathsFromSnapshotSelectors<T extends Record<string, string>>(
    page: Page,
    selectors: T
): Promise<{ [K in keyof T]: ElementPath }> {
    const snapshot = await prepareSnapshot(page, {
        mode: 'full',
        withCounters: true,
        markInteractive: true,
    })

    const $$ = cheerio.load(snapshot.cleanedHtml)
    const paths = {} as { [K in keyof T]: ElementPath }

    for (const [key, selector] of Object.entries(selectors)) {
        const counter = requireCounter($$, selector)
        const path = snapshot.counterIndex?.get(counter)
        if (!path) {
            throw new Error(`No ElementPath found for selector: ${selector}`)
        }
        paths[key as keyof T] = cloneElementPath(path)
    }

    return paths
}

function requireCounter(
    $: cheerio.CheerioAPI,
    selector: string
): number {
    const value = $(selector).first().attr('c')
    const counter = Number.parseInt(value || '', 10)
    if (!Number.isFinite(counter)) {
        throw new Error(`Expected counter for selector: ${selector}`)
    }
    return counter
}

function innerSelector(selector: string): string {
    return `#frame-host + os-iframe-root ${selector}`
}
