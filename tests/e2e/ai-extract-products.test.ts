import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Opensteer } from '../../src/opensteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { gotoRoute } from '../helpers/integration.js'

interface ProductWithPrice {
    name: string
    url: string
    price: string
}

interface ProductLink {
    name: string
    url: string
}

const EXPECTED_STANDARD_PRODUCTS: ProductWithPrice[] = [
    {
        name: 'Switches x 70',
        url: 'https://fixtures.opensteer.dev/products/switches-70',
        price: '$39.00',
    },
    {
        name: 'PBT Keycaps Set',
        url: 'https://fixtures.opensteer.dev/products/pbt-keycaps-set',
        price: '$79.00',
    },
    {
        name: 'Walnut Wrist Rest',
        url: 'https://fixtures.opensteer.dev/products/walnut-wrist-rest',
        price: '$45.00',
    },
    {
        name: 'Aviator Cable',
        url: 'https://fixtures.opensteer.dev/products/aviator-cable',
        price: '$24.00',
    },
]

const EXPECTED_IFRAME_PRODUCTS: ProductLink[] = [
    {
        name: 'Frame Dock Mini',
        url: 'https://fixtures.opensteer.dev/products/frame-dock-mini',
    },
    {
        name: 'Frame Cable Kit',
        url: 'https://fixtures.opensteer.dev/products/frame-cable-kit',
    },
    {
        name: 'Frame Plate Polycarbonate',
        url: 'https://fixtures.opensteer.dev/products/frame-plate-polycarbonate',
    },
]

const EXPECTED_SHADOW_PRODUCTS: ProductLink[] = [
    {
        name: 'Shadow Null60',
        url: 'https://fixtures.opensteer.dev/products/shadow-null60',
    },
    {
        name: 'Shadow Artisan Set',
        url: 'https://fixtures.opensteer.dev/products/shadow-artisan-set',
    },
    {
        name: 'Shadow Silicone Pad',
        url: 'https://fixtures.opensteer.dev/products/shadow-silicone-pad',
    },
]

describe('e2e/ai-extract-products', () => {
    let context: BrowserContext
    let page: Page
    let rootDir: string

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-ai-products-e2e-'))
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it(
        'extracts complete product info from standard DOM cards',
        async () => {
            await gotoRoute(page, '/products')

            const opensteer = Opensteer.from(page, {
                name: 'ai-products-standard',
                model: 'gpt-5-mini',
                storage: { rootDir },
            })

            const description =
                'Extract every product from the Standard Product Rail. Return name, url, and price for each product.'
            const data = await opensteer.extract<{ products: ProductWithPrice[] }>({
                description,
                schema: {
                    products: [{ name: 'string', url: 'string', price: 'string' }],
                },
            })

            expect(normalizeProductsWithPrice(data.products)).toEqual(
                normalizeProductsWithPrice(EXPECTED_STANDARD_PRODUCTS)
            )
            assertDescriptionPersisted(
                rootDir,
                'ai-products-standard',
                description
            )

            await opensteer.close()
        },
        { timeout: 120_000 }
    )

    it(
        'extracts product links from iframe shelf via AI extract',
        async () => {
            await gotoRoute(page, '/products-contexts')
            await page.waitForSelector('#products-iframe', { state: 'visible' })

            const opensteer = Opensteer.from(page, {
                name: 'ai-products-iframe',
                model: 'gpt-5-mini',
                storage: { rootDir },
            })

            const description =
                'Extract every product from the Iframe Product Shelf inside the iframe. Return name and url for each product.'
            const data = await opensteer.extract<{ products: ProductLink[] }>({
                description,
                schema: {
                    products: [{ name: 'string', url: 'string' }],
                },
            })

            expect(normalizeProductLinks(data.products)).toEqual(
                normalizeProductLinks(EXPECTED_IFRAME_PRODUCTS)
            )
            assertDescriptionPersisted(
                rootDir,
                'ai-products-iframe',
                description
            )

            await opensteer.close()
        },
        { timeout: 120_000 }
    )

    it(
        'extracts product links from shadow shelf via AI extract',
        async () => {
            await gotoRoute(page, '/products-contexts')
            await page.waitForSelector('#shadow-product-host', {
                state: 'visible',
            })

            const opensteer = Opensteer.from(page, {
                name: 'ai-products-shadow',
                model: 'gpt-5-mini',
                storage: { rootDir },
            })

            const description =
                'Extract every product from the Shadow Product Shelf in the open shadow root. Return name and url for each product.'
            const data = await opensteer.extract<{ products: ProductLink[] }>({
                description,
                schema: {
                    products: [{ name: 'string', url: 'string' }],
                },
            })

            expect(normalizeProductLinks(data.products)).toEqual(
                normalizeProductLinks(EXPECTED_SHADOW_PRODUCTS)
            )
            assertDescriptionPersisted(
                rootDir,
                'ai-products-shadow',
                description
            )

            await opensteer.close()
        },
        { timeout: 120_000 }
    )
})

function normalizeProductsWithPrice(
    products: ProductWithPrice[] | undefined
): ProductWithPrice[] {
    return (products || [])
        .map((product) => ({
            name: product.name.trim(),
            url: product.url.trim(),
            price: product.price.trim(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
}

function normalizeProductLinks(
    products: ProductLink[] | undefined
): ProductLink[] {
    return (products || [])
        .map((product) => ({
            name: product.name.trim(),
            url: product.url.trim(),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
}

function assertDescriptionPersisted(
    rootDir: string,
    namespace: string,
    description: string
): void {
    const namespaceDir = path.join(
        rootDir,
        '.opensteer',
        'selectors',
        namespace
    )
    const registry = JSON.parse(
        fs.readFileSync(path.join(namespaceDir, 'index.json'), 'utf8')
    ) as { selectors: Record<string, { description?: string }> }
    const descriptions = Object.values(registry.selectors).map(
        (entry) => entry.description
    )
    expect(descriptions).toContain(description)
}
