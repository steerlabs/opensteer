import * as cheerio from 'cheerio'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import {
    buildElementPathFromSelector,
    cloneElementPath,
} from '../../src/element-path/build.js'
import { extractWithPaths } from '../../src/actions/extract.js'
import { prepareSnapshot } from '../../src/html/pipeline.js'
import type { ElementPath } from '../../src/element-path/types.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('extractWithPaths', () => {
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

    it('extracts string values from elements', async () => {
        await setFixture(
            page,
            `
        <article>
          <h1 id="title">Aurora Lamp</h1>
          <p id="price">$129.50</p>
          <p id="available">Yes</p>
          <a id="buy-link" href="/products/aurora-lamp">View</a>
        </article>
      `
        )

        const titlePath = await buildElementPathFromSelector(page, '#title')
        const pricePath = await buildElementPathFromSelector(page, '#price')
        const availablePath = await buildElementPathFromSelector(
            page,
            '#available'
        )
        const linkPath = await buildElementPathFromSelector(page, '#buy-link')
        const articlePath = await buildElementPathFromSelector(page, 'article')
        expect(articlePath).toBeTruthy()
        if (!articlePath) throw new Error('Expected path to exist.')
        articlePath.nodes[articlePath.nodes.length - 1].tag = 'span'
        articlePath.nodes[articlePath.nodes.length - 1].attrs = {
            id: 'none',
        }

        const data = await extractWithPaths(page, [
            { key: 'title', path: titlePath! },
            { key: 'price', path: pricePath! },
            {
                key: 'available',
                path: availablePath!,
            },
            {
                key: 'link',
                path: linkPath!,
                attribute: 'href',
            },
            {
                key: 'missing',
                path: articlePath,
            },
        ])

        expect(data).toEqual({
            title: 'Aurora Lamp',
            price: '$129.50',
            available: 'Yes',
            link: '/products/aurora-lamp',
            missing: null,
        })
    })

    it('uses text content by default and attributes only when requested', async () => {
        await setFixture(
            page,
            `
        <article>
          <a id="doc-link" href="https://example.com/docs/get-started">Read docs</a>
          <img id="hero-image" src="https://cdn.example.com/assets/hero.png" alt="Hero" />
          <img id="responsive-image" srcset="https://cdn.example.com/assets/hero-480.png 480w, https://cdn.example.com/assets/hero-1280.png 1280w, https://cdn.example.com/assets/hero-960.png 960w" />
          <img id="retina-image" imagesrcset="https://cdn.example.com/assets/hero-1x.png 1x, https://cdn.example.com/assets/hero-3x.png 3x" />
          <a id="tracked-link" href="https://example.com/checkout" ping="https://tracker.example.com/ping https://backup.example.com/ping">Checkout</a>
          <input id="sku-input" value="SKU-4242" />
          <meta id="page-meta" content="Product details" />
        </article>
      `
        )

        const linkPath = await buildElementPathFromSelector(page, '#doc-link')
        const imagePath = await buildElementPathFromSelector(
            page,
            '#hero-image'
        )
        const responsiveImagePath = await buildElementPathFromSelector(
            page,
            '#responsive-image'
        )
        const retinaImagePath = await buildElementPathFromSelector(
            page,
            '#retina-image'
        )
        const trackedLinkPath = await buildElementPathFromSelector(
            page,
            '#tracked-link'
        )
        const inputPath = await buildElementPathFromSelector(page, '#sku-input')
        const metaPath = await buildElementPathFromSelector(page, '#page-meta')

        const data = await extractWithPaths(page, [
            { key: 'name', path: linkPath! },
            { key: 'url', path: linkPath!, attribute: 'href' },
            { key: 'imageText', path: imagePath! },
            { key: 'imageSrc', path: imagePath!, attribute: 'src' },
            {
                key: 'responsiveImageSrc',
                path: responsiveImagePath!,
                attribute: 'srcset',
            },
            {
                key: 'retinaImageSrc',
                path: retinaImagePath!,
                attribute: 'imagesrcset',
            },
            {
                key: 'trackingPing',
                path: trackedLinkPath!,
                attribute: 'ping',
            },
            { key: 'skuText', path: inputPath! },
            { key: 'skuValue', path: inputPath!, attribute: 'value' },
            { key: 'metaText', path: metaPath! },
            { key: 'metaContent', path: metaPath!, attribute: 'content' },
        ])

        expect(data).toEqual({
            name: 'Read docs',
            url: 'https://example.com/docs/get-started',
            imageText: null,
            imageSrc: 'https://cdn.example.com/assets/hero.png',
            responsiveImageSrc: 'https://cdn.example.com/assets/hero-1280.png',
            retinaImageSrc: 'https://cdn.example.com/assets/hero-3x.png',
            trackingPing: 'https://tracker.example.com/ping',
            skuText: null,
            skuValue: 'SKU-4242',
            metaText: null,
            metaContent: 'Product details',
        })
    })

    it('resolves url-like attributes inside iframes against the iframe base url', async () => {
        await setFixture(
            page,
            `
        <iframe
          id="frame-host"
          srcdoc="<!doctype html><html><head><base href='https://fixtures.opensteer.dev/frame/' /></head><body>
            <a id='frame-link' href='products/widget'>Widget</a>
            <img id='frame-image' src='images/widget-fallback.jpg' srcset='images/widget-320.jpg 320w, images/widget-1280.jpg 1280w' />
            <a id='frame-ping' ping='../track/ping https://backup.example/ping'>Track</a>
          </body></html>"
        ></iframe>
      `
        )

        await waitForIframeSelector(page, '#frame-link')

        const linkPath = await buildPathFromSnapshotSelector(
            page,
            '#frame-host + os-iframe-root #frame-link'
        )
        const imagePath = await buildPathFromSnapshotSelector(
            page,
            '#frame-host + os-iframe-root #frame-image'
        )
        const pingPath = await buildPathFromSnapshotSelector(
            page,
            '#frame-host + os-iframe-root #frame-ping'
        )

        const data = await extractWithPaths(page, [
            { key: 'href', path: linkPath, attribute: 'href' },
            { key: 'srcset', path: imagePath, attribute: 'srcset' },
            { key: 'ping', path: pingPath, attribute: 'ping' },
        ])

        expect(data).toEqual({
            href: 'https://fixtures.opensteer.dev/frame/products/widget',
            srcset: 'https://fixtures.opensteer.dev/frame/images/widget-1280.jpg',
            ping: 'https://fixtures.opensteer.dev/track/ping',
        })
    })

    it('keeps relative urls unchanged outside iframe contexts', async () => {
        await setFixture(
            page,
            `
        <div id="shadow-host"></div>
        <script>
          const host = document.querySelector('#shadow-host')
          const root = host?.attachShadow({ mode: 'open' })
          if (root) {
            root.innerHTML = "<a id='shadow-link' href='/shadow/widget'>Shadow widget</a>"
          }
        </script>
      `
        )

        const shadowLinkPath = await buildPathFromSnapshotSelector(
            page,
            '#shadow-host os-shadow-root #shadow-link'
        )

        const data = await extractWithPaths(page, [
            { key: 'shadowHref', path: shadowLinkPath, attribute: 'href' },
        ])

        expect(data).toEqual({
            shadowHref: '/shadow/widget',
        })
    })
})

async function buildPathFromSnapshotSelector(
    page: Page,
    selector: string
): Promise<ElementPath> {
    const snapshot = await prepareSnapshot(page, {
        mode: 'full',
        withCounters: true,
        markInteractive: true,
    })

    const $$ = cheerio.load(snapshot.cleanedHtml)
    const value = $$(selector).first().attr('c')
    const counter = Number.parseInt(value || '', 10)
    if (!Number.isFinite(counter)) {
        throw new Error(`No counter found for selector: ${selector}`)
    }

    const path = snapshot.counterIndex?.get(counter)
    if (!path) {
        throw new Error(`No ElementPath found for selector: ${selector}`)
    }

    return cloneElementPath(path)
}

async function waitForIframeSelector(
    page: Page,
    selector: string
): Promise<void> {
    await page.waitForFunction((targetSelector) => {
        const frame = document.querySelector('#frame-host')
        if (!(frame instanceof HTMLIFrameElement)) return false
        const doc = frame.contentDocument
        if (!doc) return false
        return !!doc.querySelector(targetSelector)
    }, selector)
}
