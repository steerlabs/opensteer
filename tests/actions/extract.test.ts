import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { buildElementPathFromSelector } from '../../src/element-path/build.js'
import { extractWithPaths } from '../../src/actions/extract.js'
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
})
