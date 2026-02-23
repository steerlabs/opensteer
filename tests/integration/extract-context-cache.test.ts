import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'
import * as cheerio from 'cheerio'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { prepareSnapshot } from '../../src/html/pipeline.js'
import { Opensteer } from '../../src/opensteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('integration/extract-context-cache', () => {
    let context: BrowserContext
    let page: Page
    let storageRoot: string

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        storageRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), 'opensteer-context-cache-')
        )
    })

    afterEach(async () => {
        await context.close()
        fs.rmSync(storageRoot, { recursive: true, force: true })
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it('replays cached scalar extraction inside iframes', async () => {
        await setFixture(page, '<iframe id="frame-host"></iframe>')
        await page.evaluate(() => {
            const frame = document.querySelector('#frame-host')
            if (!(frame instanceof HTMLIFrameElement)) return
            frame.srcdoc = `<!doctype html><html><body><h2 id="headline">Frame Alpha</h2></body></html>`
        })
        await waitForIframeSelector(page, '#headline')

        const description = 'iframe scalar context cache'
        const schema = { title: 'string' }
        const titleCounter = await getCounterBySnapshotSelector(
            page,
            '#frame-host + os-iframe-root #headline'
        )

        const opensteer = Opensteer.from(page, {
            name: 'extract-context-iframe-scalar',
            storage: { rootDir: storageRoot },
        })

        const seeded = await opensteer.extractFromPlan<{ title: string }>({
            description,
            schema,
            plan: {
                fields: {
                    title: {
                        element: titleCounter,
                    },
                },
            },
        })

        expect(seeded.data).toEqual({ title: 'Frame Alpha' })

        const stored = readStoredSelector(
            storageRoot,
            'extract-context-iframe-scalar',
            description
        )
        expect(getValueNodeContextKind(stored, 'title')).toBe('iframe')

        await page.evaluate(() => {
            const frame = document.querySelector('#frame-host')
            if (!(frame instanceof HTMLIFrameElement)) return
            const title = frame.contentDocument?.querySelector('#headline')
            if (title) title.textContent = 'Frame Beta'
        })

        const replayed = await opensteer.extract<{ title: string }>({
            description,
            schema,
        })

        expect(replayed).toEqual({ title: 'Frame Beta' })
        await opensteer.close()
    })

    it('replays cached scalar extraction inside shadow roots', async () => {
        await setFixture(page, '<div id="shadow-host"></div>')
        await page.evaluate(() => {
            const host = document.querySelector('#shadow-host')
            if (!(host instanceof HTMLElement) || host.shadowRoot) return
            const root = host.attachShadow({ mode: 'open' })
            root.innerHTML = `<h2 id="shadow-title">Shadow Alpha</h2>`
        })

        const description = 'shadow scalar context cache'
        const schema = { title: 'string' }
        const titleCounter = await getCounterBySnapshotSelector(
            page,
            '#shadow-host os-shadow-root #shadow-title'
        )

        const opensteer = Opensteer.from(page, {
            name: 'extract-context-shadow-scalar',
            storage: { rootDir: storageRoot },
        })

        const seeded = await opensteer.extractFromPlan<{ title: string }>({
            description,
            schema,
            plan: {
                fields: {
                    title: {
                        element: titleCounter,
                    },
                },
            },
        })

        expect(seeded.data).toEqual({ title: 'Shadow Alpha' })

        const stored = readStoredSelector(
            storageRoot,
            'extract-context-shadow-scalar',
            description
        )
        expect(getValueNodeContextKind(stored, 'title')).toBe('shadow')

        await page.evaluate(() => {
            const host = document.querySelector('#shadow-host')
            if (!(host instanceof HTMLElement) || !host.shadowRoot) return
            const title = host.shadowRoot.querySelector('#shadow-title')
            if (title) title.textContent = 'Shadow Beta'
        })

        const replayed = await opensteer.extract<{ title: string }>({
            description,
            schema,
        })

        expect(replayed).toEqual({ title: 'Shadow Beta' })
        await opensteer.close()
    })

    it('replays cached array extraction inside iframes', async () => {
        await setFixture(page, '<iframe id="frame-host"></iframe>')
        await page.evaluate(() => {
            const frame = document.querySelector('#frame-host')
            if (!(frame instanceof HTMLIFrameElement)) return
            frame.srcdoc = `<!doctype html><html><body>
                <ul id="products">
                  <li class="card"><span class="title">Apple</span><span class="price">$1</span></li>
                  <li class="card"><span class="title">Banana</span><span class="price">$2</span></li>
                </ul>
              </body></html>`
        })
        await waitForIframeSelector(page, '#products li:nth-child(2) .price')

        const description = 'iframe array context cache'
        const schema = {
            products: [
                {
                    title: '',
                    price: '',
                },
            ],
        }

        const firstTitle = await getCounterBySnapshotSelector(
            page,
            '#frame-host + os-iframe-root #products > li:nth-child(1) .title'
        )
        const firstPrice = await getCounterBySnapshotSelector(
            page,
            '#frame-host + os-iframe-root #products > li:nth-child(1) .price'
        )
        const secondTitle = await getCounterBySnapshotSelector(
            page,
            '#frame-host + os-iframe-root #products > li:nth-child(2) .title'
        )
        const secondPrice = await getCounterBySnapshotSelector(
            page,
            '#frame-host + os-iframe-root #products > li:nth-child(2) .price'
        )

        const opensteer = Opensteer.from(page, {
            name: 'extract-context-iframe-array',
            storage: { rootDir: storageRoot },
        })

        const seeded = await opensteer.extractFromPlan<{
            products: Array<{ title: string; price: string }>
        }>({
            description,
            schema,
            plan: {
                fields: {
                    'products[0].title': { element: firstTitle },
                    'products[0].price': { element: firstPrice },
                    'products[1].title': { element: secondTitle },
                    'products[1].price': { element: secondPrice },
                },
            },
        })

        expect(seeded.data).toEqual({
            products: [
                { title: 'Apple', price: '$1' },
                { title: 'Banana', price: '$2' },
            ],
        })

        const stored = readStoredSelector(
            storageRoot,
            'extract-context-iframe-array',
            description
        )
        expect(getArrayItemParentContextKind(stored, 'products')).toBe('iframe')

        await page.evaluate(() => {
            const frame = document.querySelector('#frame-host')
            if (
                !(frame instanceof HTMLIFrameElement) ||
                !frame.contentDocument
            ) {
                return
            }
            const list = frame.contentDocument.querySelector('#products')
            if (!list) return
            const li = frame.contentDocument.createElement('li')
            li.className = 'card'
            li.innerHTML =
                '<span class="title">Cherry</span><span class="price">$3</span>'
            list.appendChild(li)
        })

        const replayed = await opensteer.extract<{
            products: Array<{ title: string | null; price: string | null }>
        }>({
            description,
            schema,
        })

        expect(replayed).toEqual({
            products: [
                { title: 'Apple', price: '$1' },
                { title: 'Banana', price: '$2' },
                { title: 'Cherry', price: '$3' },
            ],
        })

        await opensteer.close()
    })

    it('replays cached array extraction inside shadow roots', async () => {
        await setFixture(page, '<div id="shadow-host"></div>')
        await page.evaluate(() => {
            const host = document.querySelector('#shadow-host')
            if (!(host instanceof HTMLElement) || host.shadowRoot) return
            const root = host.attachShadow({ mode: 'open' })
            root.innerHTML = `
              <ul id="products">
                <li class="card"><span class="title">Alpha</span><span class="price">$10</span></li>
                <li class="card"><span class="title">Beta</span><span class="price">$20</span></li>
              </ul>
            `
        })

        const description = 'shadow array context cache'
        const schema = {
            products: [
                {
                    title: '',
                    price: '',
                },
            ],
        }

        const firstTitle = await getCounterBySnapshotSelector(
            page,
            '#shadow-host os-shadow-root #products > li:nth-child(1) .title'
        )
        const firstPrice = await getCounterBySnapshotSelector(
            page,
            '#shadow-host os-shadow-root #products > li:nth-child(1) .price'
        )
        const secondTitle = await getCounterBySnapshotSelector(
            page,
            '#shadow-host os-shadow-root #products > li:nth-child(2) .title'
        )
        const secondPrice = await getCounterBySnapshotSelector(
            page,
            '#shadow-host os-shadow-root #products > li:nth-child(2) .price'
        )

        const opensteer = Opensteer.from(page, {
            name: 'extract-context-shadow-array',
            storage: { rootDir: storageRoot },
        })

        const seeded = await opensteer.extractFromPlan<{
            products: Array<{ title: string; price: string }>
        }>({
            description,
            schema,
            plan: {
                fields: {
                    'products[0].title': { element: firstTitle },
                    'products[0].price': { element: firstPrice },
                    'products[1].title': { element: secondTitle },
                    'products[1].price': { element: secondPrice },
                },
            },
        })

        expect(seeded.data).toEqual({
            products: [
                { title: 'Alpha', price: '$10' },
                { title: 'Beta', price: '$20' },
            ],
        })

        const stored = readStoredSelector(
            storageRoot,
            'extract-context-shadow-array',
            description
        )
        expect(getArrayItemParentContextKind(stored, 'products')).toBe('shadow')

        await page.evaluate(() => {
            const host = document.querySelector('#shadow-host')
            if (!(host instanceof HTMLElement) || !host.shadowRoot) return
            const list = host.shadowRoot.querySelector('#products')
            if (!(list instanceof HTMLElement)) return
            const li = document.createElement('li')
            li.className = 'card'
            li.innerHTML =
                '<span class="title">Gamma</span><span class="price">$30</span>'
            list.appendChild(li)
        })

        const replayed = await opensteer.extract<{
            products: Array<{ title: string | null; price: string | null }>
        }>({
            description,
            schema,
        })

        expect(replayed).toEqual({
            products: [
                { title: 'Alpha', price: '$10' },
                { title: 'Beta', price: '$20' },
                { title: 'Gamma', price: '$30' },
            ],
        })

        await opensteer.close()
    })
})

async function getCounterBySnapshotSelector(
    page: Page,
    selector: string
): Promise<number> {
    const snapshot = await prepareSnapshot(page, {
        mode: 'full',
        withCounters: true,
        markInteractive: true,
    })

    const $$ = cheerio.load(snapshot.cleanedHtml)
    const rawCounter = $$(selector).first().attr('c')
    const counter = Number.parseInt(rawCounter || '', 10)
    if (!Number.isFinite(counter)) {
        throw new Error(`Expected counter for selector: ${selector}`)
    }

    return counter
}

function readStoredSelector(
    rootDir: string,
    namespace: string,
    description: string
): StoredSelectorFile {
    const key = createHash('sha256')
        .update(description)
        .digest('hex')
        .slice(0, 16)
    const selectorPath = path.join(
        rootDir,
        '.opensteer',
        'selectors',
        namespace,
        `${key}.json`
    )
    return JSON.parse(
        fs.readFileSync(selectorPath, 'utf8')
    ) as StoredSelectorFile
}

function getValueNodeContextKind(
    stored: StoredSelectorFile,
    key: string
): string | undefined {
    const node = readPathNode(stored, key)
    if (!node) return undefined
    const candidate = node as StoredValuePathNode
    return candidate.$path?.context?.[0]?.kind
}

function getArrayItemParentContextKind(
    stored: StoredSelectorFile,
    key: string
): string | undefined {
    const node = readPathNode(stored, key)
    if (!node) return undefined
    const candidate = node as StoredArrayPathNode
    return candidate.$array?.variants?.[0]?.itemParentPath?.context?.[0]?.kind
}

function readPathNode(stored: StoredSelectorFile, key: string): unknown {
    if (!stored.path) return undefined
    return stored.path[key]
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

interface StoredSelectorFile {
    path?: Record<string, unknown>
}

interface StoredValuePathNode {
    $path?: {
        context?: Array<{ kind?: string }>
    }
}

interface StoredArrayPathNode {
    $array?: {
        variants?: Array<{
            itemParentPath?: {
                context?: Array<{ kind?: string }>
            }
        }>
    }
}
