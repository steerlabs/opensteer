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

    it('prefers semantic attributes for links, images, and controls by default', async () => {
        await setFixture(
            page,
            `
        <article>
          <a id="doc-link" href="https://example.com/docs/get-started">
            <span id="doc-link-label">Read docs</span>
          </a>
          <img id="hero-image" src="https://cdn.example.com/assets/hero.png" alt="Hero" />
          <input id="sku-input" value="SKU-4242" />
        </article>
      `
        )

        const linkPath = await buildElementPathFromSelector(page, '#doc-link')
        const nestedLinkPath = await buildElementPathFromSelector(
            page,
            '#doc-link-label'
        )
        const imagePath = await buildElementPathFromSelector(
            page,
            '#hero-image'
        )
        const inputPath = await buildElementPathFromSelector(page, '#sku-input')

        const data = await extractWithPaths(page, [
            { key: 'link', path: linkPath! },
            { key: 'productUrl', path: nestedLinkPath! },
            { key: 'image', path: imagePath! },
            { key: 'sku', path: inputPath! },
        ])

        expect(data).toEqual({
            link: 'https://example.com/docs/get-started',
            productUrl: 'https://example.com/docs/get-started',
            image: 'https://cdn.example.com/assets/hero.png',
            sku: 'SKU-4242',
        })
    })
})
