import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Opensteer } from '../../src/opensteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('integration/extract-array-variants', () => {
    let context: BrowserContext
    let page: Page
    let storageRoot: string

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-array-variants-'))
    })

    afterEach(async () => {
        await context.close()
        fs.rmSync(storageRoot, { recursive: true, force: true })
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it('replays mixed sale and regular templates without dropping minority rows', async () => {
        await setFixture(
            page,
            `
            <section>
              <ul id="products">
                <li class="card sale"><a class="title" href="/p/a">Sale A</a><span class="price sale-price">$10</span></li>
                <li class="card sale"><a class="title" href="/p/b">Sale B</a><span class="price sale-price">$20</span></li>
                <li class="card sale"><a class="title" href="/p/c">Sale C</a><span class="price sale-price">$30</span></li>
                <li class="card regular"><div class="meta"><a class="title" href="/p/d">Regular D</a></div><div class="pricing"><span class="price">$40</span></div></li>
              </ul>
            </section>
            `
        )

        const description = 'array variants sale regular'
        const schema = {
            products: [{ title: '', price: '' }],
        }

        const ov = Opensteer.from(page, {
            name: 'extract-array-variants-sale-regular',
            storage: { rootDir: storageRoot },
        })

        await ov.extractFromPlan({
            description,
            schema,
            plan: {
                fields: {
                    'products[0].title': { selector: '#products > li:nth-child(1) .title' },
                    'products[0].price': { selector: '#products > li:nth-child(1) .price' },
                    'products[1].title': { selector: '#products > li:nth-child(2) .title' },
                    'products[1].price': { selector: '#products > li:nth-child(2) .price' },
                    'products[2].title': { selector: '#products > li:nth-child(3) .title' },
                    'products[2].price': { selector: '#products > li:nth-child(3) .price' },
                    'products[3].title': { selector: '#products > li:nth-child(4) .title' },
                    'products[3].price': { selector: '#products > li:nth-child(4) .price' },
                },
            },
        })

        const replayed = await ov.extract<{
            products: Array<{ title: string | null; price: string | null }>
        }>({
            description,
            schema,
        })

        expect(replayed.products).toEqual([
            { title: 'Sale A', price: '$10' },
            { title: 'Sale B', price: '$20' },
            { title: 'Sale C', price: '$30' },
            { title: 'Regular D', price: '$40' },
        ])

        const stored = readStoredSelector(
            storageRoot,
            'extract-array-variants-sale-regular',
            description
        )
        const variants = stored.path?.products?.$array?.variants || []
        expect(variants.length).toBe(2)
    })

    it('handles mixed root tags without descendant over-match', async () => {
        await setFixture(
            page,
            `
            <section>
              <div id="products">
                <article class="card sale"><a class="title" href="/p/a">Sale A</a><span class="price sale-price">$10</span></article>
                <div class="card regular"><div class="meta"><a class="title" href="/p/b">Regular B</a></div><div class="pricing"><span class="price">$20</span></div></div>
                <article class="card sale"><a class="title" href="/p/c">Sale C</a><span class="price sale-price">$30</span></article>
                <div class="card regular"><div class="meta"><a class="title" href="/p/d">Regular D</a></div><div class="pricing"><span class="price">$40</span></div></div>
              </div>
            </section>
            `
        )

        const description = 'array variants mixed root tags'
        const schema = {
            products: [{ title: '', price: '' }],
        }

        const ov = Opensteer.from(page, {
            name: 'extract-array-variants-mixed-roots',
            storage: { rootDir: storageRoot },
        })

        await ov.extractFromPlan({
            description,
            schema,
            plan: {
                fields: {
                    'products[0].title': {
                        selector: '#products > article:nth-child(1) .title',
                    },
                    'products[0].price': {
                        selector: '#products > article:nth-child(1) .price',
                    },
                    'products[1].title': {
                        selector: '#products > div:nth-child(2) .title',
                    },
                    'products[1].price': {
                        selector: '#products > div:nth-child(2) .price',
                    },
                    'products[2].title': {
                        selector: '#products > article:nth-child(3) .title',
                    },
                    'products[2].price': {
                        selector: '#products > article:nth-child(3) .price',
                    },
                    'products[3].title': {
                        selector: '#products > div:nth-child(4) .title',
                    },
                    'products[3].price': {
                        selector: '#products > div:nth-child(4) .price',
                    },
                },
            },
        })

        const replayed = await ov.extract<{
            products: Array<{ title: string | null; price: string | null }>
        }>({
            description,
            schema,
        })

        expect(replayed.products).toEqual([
            { title: 'Sale A', price: '$10' },
            { title: 'Regular B', price: '$20' },
            { title: 'Sale C', price: '$30' },
            { title: 'Regular D', price: '$40' },
        ])
    })

    it('preserves DOM order for interleaved template variants', async () => {
        await setFixture(
            page,
            `
            <section>
              <ul id="products">
                <li class="card sale"><a class="title" href="/p/a">A</a><span class="price sale-price">$10</span></li>
                <li class="card regular"><div class="meta"><a class="title" href="/p/b">B</a></div><div class="pricing"><span class="price">$20</span></div></li>
                <li class="card sale"><a class="title" href="/p/c">C</a><span class="price sale-price">$30</span></li>
                <li class="card regular"><div class="meta"><a class="title" href="/p/d">D</a></div><div class="pricing"><span class="price">$40</span></div></li>
                <li class="card sale"><a class="title" href="/p/e">E</a><span class="price sale-price">$50</span></li>
                <li class="card regular"><div class="meta"><a class="title" href="/p/f">F</a></div><div class="pricing"><span class="price">$60</span></div></li>
              </ul>
            </section>
            `
        )

        const description = 'array variants interleaved order'
        const schema = {
            products: [{ title: '', price: '' }],
        }

        const ov = Opensteer.from(page, {
            name: 'extract-array-variants-order',
            storage: { rootDir: storageRoot },
        })

        await ov.extractFromPlan({
            description,
            schema,
            plan: {
                fields: {
                    ...buildFieldPlanForUlIndex('#products', 0),
                    ...buildFieldPlanForUlIndex('#products', 1),
                    ...buildFieldPlanForUlIndex('#products', 2),
                    ...buildFieldPlanForUlIndex('#products', 3),
                    ...buildFieldPlanForUlIndex('#products', 4),
                    ...buildFieldPlanForUlIndex('#products', 5),
                },
            },
        })

        const replayed = await ov.extract<{
            products: Array<{ title: string | null; price: string | null }>
        }>({ description, schema })

        expect(replayed.products.map((item) => item.title)).toEqual([
            'A',
            'B',
            'C',
            'D',
            'E',
            'F',
        ])
    })

    it('deduplicates rows when multiple variants overlap', async () => {
        await setFixture(
            page,
            `
            <section>
              <ul id="products">
                <li class="card"><a class="title" href="/p/a">A</a><span class="price">$10</span></li>
                <li class="card"><a class="title" href="/p/b">B</a><span class="price">$20</span></li>
              </ul>
            </section>
            `
        )

        const description = 'array variants overlap dedupe'
        const schema = {
            products: [{ title: '', price: '' }],
        }

        const namespace = 'extract-array-variants-overlap'
        const ov = Opensteer.from(page, {
            name: namespace,
            storage: { rootDir: storageRoot },
        })

        await ov.extractFromPlan({
            description,
            schema,
            plan: {
                fields: {
                    ...buildFieldPlanForUlIndex('#products', 0),
                    ...buildFieldPlanForUlIndex('#products', 1),
                },
            },
        })

        const selectorPath = buildSelectorPath(storageRoot, namespace, description)
        const stored = JSON.parse(fs.readFileSync(selectorPath, 'utf8')) as {
            path?: {
                products?: {
                    $array?: {
                        variants?: Array<unknown>
                    }
                }
            }
        }

        const variants =
            stored.path?.products?.$array?.variants?.map((variant) =>
                JSON.parse(JSON.stringify(variant))
            ) || []
        expect(variants.length).toBeGreaterThan(0)

        stored.path = stored.path || {}
        stored.path.products = stored.path.products || {}
        stored.path.products.$array = {
            variants: [...variants, ...variants],
        }
        fs.writeFileSync(selectorPath, JSON.stringify(stored, null, 2), 'utf8')

        const replayed = await ov.extract<{
            products: Array<{ title: string | null; price: string | null }>
        }>({ description, schema })

        expect(replayed.products).toEqual([
            { title: 'A', price: '$10' },
            { title: 'B', price: '$20' },
        ])
    })

    it('replays current_url fields across variants', async () => {
        await setFixture(
            page,
            `
            <section>
              <ul id="products">
                <li class="card sale"><a class="title" href="/p/a">Sale A</a><span class="price sale-price">$10</span></li>
                <li class="card regular"><div class="meta"><a class="title" href="/p/b">Regular B</a></div><div class="pricing"><span class="price">$20</span></div></li>
                <li class="card sale"><a class="title" href="/p/c">Sale C</a><span class="price sale-price">$30</span></li>
                <li class="card regular"><div class="meta"><a class="title" href="/p/d">Regular D</a></div><div class="pricing"><span class="price">$40</span></div></li>
              </ul>
            </section>
            `
        )

        const description = 'array variants current url'
        const schema = {
            products: [{ title: '', price: '', pageUrl: '' }],
        }

        const ov = Opensteer.from(page, {
            name: 'extract-array-variants-current-url',
            storage: { rootDir: storageRoot },
        })

        await ov.extractFromPlan({
            description,
            schema,
            plan: {
                fields: {
                    ...buildFieldPlanForUlIndex('#products', 0),
                    ...buildFieldPlanForUlIndex('#products', 1),
                    ...buildFieldPlanForUlIndex('#products', 2),
                    ...buildFieldPlanForUlIndex('#products', 3),
                    'products[0].pageUrl': { source: 'current_url' },
                    'products[1].pageUrl': { source: 'current_url' },
                    'products[2].pageUrl': { source: 'current_url' },
                    'products[3].pageUrl': { source: 'current_url' },
                },
            },
        })

        const replayed = await ov.extract<{
            products: Array<{
                title: string | null
                price: string | null
                pageUrl: string | null
            }>
        }>({ description, schema })

        expect(replayed.products).toEqual([
            { title: 'Sale A', price: '$10', pageUrl: page.url() },
            { title: 'Regular B', price: '$20', pageUrl: page.url() },
            { title: 'Sale C', price: '$30', pageUrl: page.url() },
            { title: 'Regular D', price: '$40', pageUrl: page.url() },
        ])
    })
})

function buildFieldPlanForUlIndex(
    containerSelector: string,
    itemIndex: number
): Record<string, { selector: string }> {
    const nth = itemIndex + 1
    return {
        [`products[${itemIndex}].title`]: {
            selector: `${containerSelector} > li:nth-child(${nth}) .title`,
        },
        [`products[${itemIndex}].price`]: {
            selector: `${containerSelector} > li:nth-child(${nth}) .price`,
        },
    }
}

function readStoredSelector(
    rootDir: string,
    namespace: string,
    description: string
): {
    path?: {
        products?: {
            $array?: {
                variants?: Array<unknown>
            }
        }
    }
} {
    const selectorPath = buildSelectorPath(rootDir, namespace, description)
    return JSON.parse(fs.readFileSync(selectorPath, 'utf8')) as {
        path?: {
            products?: {
                $array?: {
                    variants?: Array<unknown>
                }
            }
        }
    }
}

function buildSelectorPath(
    rootDir: string,
    namespace: string,
    description: string
): string {
    const key = createHash('sha256').update(description).digest('hex').slice(0, 16)
    return path.join(
        rootDir,
        '.opensteer',
        'selectors',
        namespace,
        `${key}.json`
    )
}
