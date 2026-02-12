import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Oversteer } from '../../src/oversteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('integration/extract-array-cache', () => {
    let context: BrowserContext
    let page: Page
    let storageRoot: string

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-array-cache-'))
    })

    afterEach(async () => {
        await context.close()
        fs.rmSync(storageRoot, { recursive: true, force: true })
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it('persists consolidated array selectors and replays against added items', async () => {
        await setFixture(
            page,
            `
            <section>
              <ul id="products">
                <li class="card"><h3>Apple</h3><span class="price">$1</span></li>
                <li class="card"><h3>Banana</h3><span class="price">$2</span></li>
              </ul>
            </section>
            `
        )

        const description = 'array cache replay'
        const schema = {
            products: [
                {
                    title: '',
                    price: '',
                    pageUrl: '',
                },
            ],
        }

        const ov = Oversteer.from(page, {
            name: 'extract-array-cache',
            storage: {
                rootDir: storageRoot,
            },
        })

        const seeded = await ov.extractFromPlan({
            description,
            schema,
            plan: {
                fields: {
                    'products[0].title': {
                        selector: '#products li:nth-child(1) h3',
                    },
                    'products[0].price': {
                        selector: '#products li:nth-child(1) .price',
                    },
                    'products[0].pageUrl': {
                        source: 'current_url',
                    },
                    'products[1].title': {
                        selector: '#products li:nth-child(2) h3',
                    },
                    'products[1].price': {
                        selector: '#products li:nth-child(2) .price',
                    },
                    'products[1].pageUrl': {
                        source: 'current_url',
                    },
                },
            },
        })

        const currentUrl = page.url()

        expect(seeded.pathFile).toBeTruthy()
        expect(seeded.data).toEqual({
            products: [
                { title: 'Apple', price: '$1', pageUrl: currentUrl },
                { title: 'Banana', price: '$2', pageUrl: currentUrl },
            ],
        })

        const storageKey = createHash('sha256')
            .update(description)
            .digest('hex')
            .slice(0, 16)
        const storedPath = path.join(
            storageRoot,
            '.oversteer',
            'selectors',
            'extract-array-cache',
            `${storageKey}.json`
        )
        const stored = JSON.parse(fs.readFileSync(storedPath, 'utf8')) as {
            version?: unknown
            path?: {
                root?: unknown
                products?: {
                    $array?: {
                        itemParentPath?: unknown
                        item?: Record<string, unknown>
                    }
                }
            }
        }

        expect(stored.version).toBeUndefined()
        expect(stored.path?.root).toBeUndefined()

        const productsNode = stored.path?.products?.$array
        expect(productsNode?.itemParentPath).toBeTruthy()
        const fieldKeys = Object.keys(productsNode?.item || {}).sort()
        expect(fieldKeys).toEqual(['pageUrl', 'price', 'title'])
        expect(productsNode?.item?.pageUrl).toEqual({ $source: 'current_url' })

        await page.evaluate(() => {
            const list = document.querySelector('#products')
            if (!list) return
            const li = document.createElement('li')
            li.className = 'card'
            li.innerHTML = '<h3>Cherry</h3><span class="price">$3</span>'
            list.appendChild(li)
        })

        const replayed = await ov.extract<{
            products: Array<{
                title: string | null
                price: string | null
                pageUrl: string | null
            }>
        }>({
            description,
            schema,
        })

        expect(replayed).toEqual({
            products: [
                { title: 'Apple', price: '$1', pageUrl: currentUrl },
                { title: 'Banana', price: '$2', pageUrl: currentUrl },
                { title: 'Cherry', price: '$3', pageUrl: currentUrl },
            ],
        })
    })
})
