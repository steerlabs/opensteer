import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Opensteer } from '../../src/opensteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

interface ListAttributeProduct {
    name: string | null
    imageUrl: string | null
    retinaImageUrl: string | null
    pingUrl: string | null
}

interface ListAttributeProductsResult {
    products: ListAttributeProduct[]
}

describe('integration/extract-array-cache', () => {
    let context: BrowserContext
    let page: Page
    let storageRoot: string

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-array-cache-'))
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

        const opensteer = Opensteer.from(page, {
            name: 'extract-array-cache',
            storage: {
                rootDir: storageRoot,
            },
        })

        const seeded = await opensteer.extractFromPlan({
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
            '.opensteer',
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
                        variants?: Array<{
                            itemParentPath?: unknown
                            item?: Record<string, unknown>
                        }>
                    }
                }
            }
        }

        expect(stored.version).toBeUndefined()
        expect(stored.path?.root).toBeUndefined()

        const productsNode = stored.path?.products?.$array
        expect(productsNode?.variants?.length).toBe(1)
        const firstVariant = productsNode?.variants?.[0]
        expect(firstVariant?.itemParentPath).toBeTruthy()
        const fieldKeys = Object.keys(firstVariant?.item || {}).sort()
        expect(fieldKeys).toEqual(['pageUrl', 'price', 'title'])
        expect(firstVariant?.item?.pageUrl).toEqual({ $source: 'current_url' })

        await page.evaluate(() => {
            const list = document.querySelector('#products')
            if (!list) return
            const li = document.createElement('li')
            li.className = 'card'
            li.innerHTML = '<h3>Cherry</h3><span class="price">$3</span>'
            list.appendChild(li)
        })

        const replayed = await opensteer.extract<{
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

    it('keeps positional anchors for single-sample tag fields in cached array replay', async () => {
        await setFixture(
            page,
            `
            <section>
              <ul id="companies">
                <li class="company">
                  <h3 class="name">Airbnb</h3>
                  <p class="description">Book accommodations around the world.</p>
                  <div class="pill-wrapper">
                    <a class="tag-link"><span class="pill">Winter 2009</span></a>
                    <a class="tag-link"><span class="pill">Consumer</span></a>
                    <a class="tag-link"><span class="pill">Travel</span></a>
                  </div>
                </li>
                <li class="company">
                  <h3 class="name">Coinbase</h3>
                  <p class="description">Buy, sell, and manage cryptocurrencies.</p>
                  <div class="pill-wrapper">
                    <a class="tag-link"><span class="pill">Summer 2012</span></a>
                    <a class="tag-link"><span class="pill">Fintech</span></a>
                    <a class="tag-link"><span class="pill">Crypto</span></a>
                  </div>
                </li>
                <li class="company">
                  <h3 class="name">Oklo</h3>
                  <p class="description">Emission free, always on power from advanced fission power plants.</p>
                  <div class="pill-wrapper">
                    <a class="tag-link"><span class="pill">Summer 2014</span></a>
                    <a class="tag-link"><span class="pill">Industrials</span></a>
                    <a class="tag-link"><span class="pill">Energy</span></a>
                  </div>
                </li>
              </ul>
            </section>
            `
        )

        const description = 'array cache replay tag positions'
        const schema = {
            companies: [
                {
                    name: '',
                    description: '',
                    industry: '',
                },
            ],
        }

        const namespace = 'extract-array-cache-tag-positions'
        const opensteer = Opensteer.from(page, {
            name: namespace,
            storage: {
                rootDir: storageRoot,
            },
        })

        await opensteer.extractFromPlan({
            description,
            schema,
            plan: {
                fields: {
                    'companies[0].name': {
                        selector: '#companies > li:nth-child(1) .name',
                    },
                    'companies[0].description': {
                        selector: '#companies > li:nth-child(1) .description',
                    },
                    'companies[0].industry': {
                        selector:
                            '#companies > li:nth-child(1) .pill-wrapper > a:nth-child(2) > .pill',
                    },
                },
            },
        })

        const replayed = await opensteer.extract<{
            companies: Array<{
                name: string | null
                description: string | null
                industry: string | null
            }>
        }>({
            description,
            schema,
        })

        expect(replayed.companies).toEqual([
            {
                name: 'Airbnb',
                description: 'Book accommodations around the world.',
                industry: 'Consumer',
            },
            {
                name: 'Coinbase',
                description: 'Buy, sell, and manage cryptocurrencies.',
                industry: 'Fintech',
            },
            {
                name: 'Oklo',
                description:
                    'Emission free, always on power from advanced fission power plants.',
                industry: 'Industrials',
            },
        ])

        const storageKey = createHash('sha256')
            .update(description)
            .digest('hex')
            .slice(0, 16)
        const storedPath = path.join(
            storageRoot,
            '.opensteer',
            'selectors',
            namespace,
            `${storageKey}.json`
        )
        const stored = JSON.parse(fs.readFileSync(storedPath, 'utf8')) as {
            path?: {
                companies?: {
                    $array?: {
                        variants?: Array<{
                            item?: {
                                industry?: {
                                    $path?: {
                                        nodes?: Array<{
                                            match?: Array<{
                                                kind?: string
                                            }>
                                        }>
                                    }
                                }
                            }
                        }>
                    }
                }
            }
        }

        const industryNodes =
            stored.path?.companies?.$array?.variants?.[0]?.item?.industry?.$path
                ?.nodes || []
        const hasPositionClause = industryNodes.some((node) =>
            (node.match || []).some((clause) => clause.kind === 'position')
        )
        expect(hasPositionClause).toBe(true)
    })

    it('strips redundant positional anchors for single-sample unique class fields', async () => {
        await setFixture(
            page,
            `
            <section>
              <ul id="companies">
                <li class="company">
                  <h3 class="name">Airbnb</h3>
                  <p class="description">Book accommodations around the world.</p>
                </li>
                <li class="company">
                  <h3 class="name">Coinbase</h3>
                  <p class="description">Buy, sell, and manage cryptocurrencies.</p>
                </li>
                <li class="company">
                  <h3 class="name">Oklo</h3>
                  <p class="description">Emission free, always on power from advanced fission power plants.</p>
                </li>
              </ul>
            </section>
            `
        )

        const description = 'array cache replay strip redundant positions'
        const schema = {
            companies: [
                {
                    name: '',
                    description: '',
                },
            ],
        }

        const namespace = 'extract-array-cache-strip-positions'
        const opensteer = Opensteer.from(page, {
            name: namespace,
            storage: {
                rootDir: storageRoot,
            },
        })

        const seeded = await opensteer.extractFromPlan<{
            companies: Array<{
                name: string | null
                description: string | null
            }>
        }>({
            description,
            schema,
            plan: {
                fields: {
                    'companies[0].name': {
                        selector: '#companies > li:nth-child(1) .name',
                    },
                    'companies[0].description': {
                        selector: '#companies > li:nth-child(1) .description',
                    },
                },
            },
        })

        expect(seeded.data).toEqual({
            companies: [
                {
                    name: 'Airbnb',
                    description: 'Book accommodations around the world.',
                },
            ],
        })

        const replayed = await opensteer.extract<{
            companies: Array<{
                name: string | null
                description: string | null
            }>
        }>({
            description,
            schema,
        })

        expect(replayed).toEqual({
            companies: [
                {
                    name: 'Airbnb',
                    description: 'Book accommodations around the world.',
                },
                {
                    name: 'Coinbase',
                    description: 'Buy, sell, and manage cryptocurrencies.',
                },
                {
                    name: 'Oklo',
                    description:
                        'Emission free, always on power from advanced fission power plants.',
                },
            ],
        })

        const storageKey = createHash('sha256')
            .update(description)
            .digest('hex')
            .slice(0, 16)
        const storedPath = path.join(
            storageRoot,
            '.opensteer',
            'selectors',
            namespace,
            `${storageKey}.json`
        )
        const stored = JSON.parse(fs.readFileSync(storedPath, 'utf8')) as {
            path?: {
                companies?: {
                    $array?: {
                        variants?: Array<{
                            item?: {
                                name?: {
                                    $path?: {
                                        nodes?: Array<{
                                            match?: Array<{
                                                kind?: string
                                            }>
                                        }>
                                    }
                                }
                            }
                        }>
                    }
                }
            }
        }

        const nameNodes =
            stored.path?.companies?.$array?.variants?.[0]?.item?.name?.$path
                ?.nodes || []
        const hasPositionClause = nameNodes.some((node) =>
            (node.match || []).some((clause) => clause.kind === 'position')
        )
        expect(hasPositionClause).toBe(false)
    })

    it('normalizes list-valued attributes when replaying cached array extraction', async () => {
        await setFixture(
            page,
            `
            <section>
              <ul id="products">
                <li class="card">
                  <a
                    class="name"
                    href="/products/apple"
                    ping="https://tracker.example.com/apple https://backup.example.com/apple"
                  >
                    Apple
                  </a>
                  <img
                    class="responsive"
                    srcset="/images/apple-320.jpg 320w, /images/apple-1280.jpg 1280w"
                  />
                  <img
                    class="retina"
                    imagesrcset="/images/apple-1x.jpg 1x, /images/apple-3x.jpg 3x"
                  />
                </li>
                <li class="card">
                  <a
                    class="name"
                    href="/products/banana"
                    ping="https://tracker.example.com/banana https://backup.example.com/banana"
                  >
                    Banana
                  </a>
                  <img
                    class="responsive"
                    srcset="/images/banana-640.jpg 640w, /images/banana-1440.jpg 1440w"
                  />
                  <img
                    class="retina"
                    imagesrcset="/images/banana-1x.jpg 1x, /images/banana-2x.jpg 2x"
                  />
                </li>
              </ul>
            </section>
            `
        )

        const description = 'array cache replay list attributes'
        const schema = {
            products: [
                {
                    name: '',
                    imageUrl: '',
                    retinaImageUrl: '',
                    pingUrl: '',
                },
            ],
        }

        const opensteer = Opensteer.from(page, {
            name: 'extract-array-cache-list-attrs',
            storage: {
                rootDir: storageRoot,
            },
        })

        const seededExpectedProducts: ListAttributeProduct[] = [
            buildListAttributeProduct(
                'Apple',
                '/images/apple-1280.jpg',
                '/images/apple-3x.jpg',
                'https://tracker.example.com/apple'
            ),
            buildListAttributeProduct(
                'Banana',
                '/images/banana-1440.jpg',
                '/images/banana-2x.jpg',
                'https://tracker.example.com/banana'
            ),
        ]

        const seeded = await opensteer.extractFromPlan<ListAttributeProductsResult>({
            description,
            schema,
            plan: {
                fields: {
                    ...buildListAttributeFieldPlan(0),
                    ...buildListAttributeFieldPlan(1),
                },
            },
        })

        expect(seeded.data).toEqual({
            products: seededExpectedProducts,
        })

        await page.evaluate(() => {
            const list = document.querySelector('#products')
            if (!list) return

            const li = document.createElement('li')
            li.className = 'card'
            li.innerHTML = `
                <a class="name" href="/products/cherry" ping="https://tracker.example.com/cherry https://backup.example.com/cherry">Cherry</a>
                <img class="responsive" srcset="/images/cherry-800.jpg 800w, /images/cherry-1600.jpg 1600w" />
                <img class="retina" imagesrcset="/images/cherry-1x.jpg 1x, /images/cherry-4x.jpg 4x" />
            `
            list.appendChild(li)
        })

        const replayedExpectedProducts: ListAttributeProduct[] = [
            ...seededExpectedProducts,
            buildListAttributeProduct(
                'Cherry',
                '/images/cherry-1600.jpg',
                '/images/cherry-4x.jpg',
                'https://tracker.example.com/cherry'
            ),
        ]

        const replayed = await opensteer.extract<ListAttributeProductsResult>({
            description,
            schema,
        })

        expect(replayed).toEqual({
            products: replayedExpectedProducts,
        })
    })
})

function buildListAttributeFieldPlan(
    itemIndex: number
): Record<string, { selector: string; attribute?: string }> {
    const nth = itemIndex + 1
    return {
        [`products[${itemIndex}].name`]: {
            selector: `#products li:nth-child(${nth}) .name`,
        },
        [`products[${itemIndex}].imageUrl`]: {
            selector: `#products li:nth-child(${nth}) .responsive`,
            attribute: 'srcset',
        },
        [`products[${itemIndex}].retinaImageUrl`]: {
            selector: `#products li:nth-child(${nth}) .retina`,
            attribute: 'imagesrcset',
        },
        [`products[${itemIndex}].pingUrl`]: {
            selector: `#products li:nth-child(${nth}) .name`,
            attribute: 'ping',
        },
    }
}

function buildListAttributeProduct(
    name: string,
    imageUrl: string,
    retinaImageUrl: string,
    pingUrl: string
): ListAttributeProduct {
    return {
        name,
        imageUrl,
        retinaImageUrl,
        pingUrl,
    }
}
