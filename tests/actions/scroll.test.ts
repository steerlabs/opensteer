import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { performScroll } from '../../src/actions/scroll.js'
import { buildElementPathFromSelector } from '../../src/element-path/build.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('performScroll', () => {
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

    it('scrolls the window when path is not provided', async () => {
        await setFixture(
            page,
            `
        <div style="height: 2400px; background: linear-gradient(#fff, #ddd)">Tall content</div>
      `
        )

        const result = await performScroll(page, null, {
            direction: 'down',
            amount: 450,
        })
        expect(result.ok).toBe(true)

        const scrollY = await page.evaluate(() => window.scrollY)
        expect(scrollY).toBeGreaterThan(0)
    })

    it('scrolls a targeted container when path resolves', async () => {
        await setFixture(
            page,
            `
        <div id="container" style="height: 120px; overflow: auto; border: 1px solid #ddd;">
          <div style="height: 900px;">Content block</div>
        </div>
      `
        )

        const path = await buildElementPathFromSelector(page, '#container')
        const result = await performScroll(page, path, {
            direction: 'down',
            amount: 300,
        })
        expect(result.ok).toBe(true)

        const scrollTop = await page
            .locator('#container')
            .evaluate((el) => (el as HTMLElement).scrollTop)
        expect(scrollTop).toBeGreaterThan(0)
    })

    it('returns an error for missing scroll target', async () => {
        await setFixture(page, '<div>no scroll target</div>')

        const path = await buildElementPathFromSelector(page, 'div')
        expect(path).toBeTruthy()
        if (!path) throw new Error('Expected path to exist.')
        path.nodes[path.nodes.length - 1].match = [
            { kind: 'attr', key: 'id', op: 'exact', value: 'missing' },
        ]

        const result = await performScroll(page, path, { direction: 'down' })

        expect(result.ok).toBe(false)
        expect(result.error).toContain('No matching element found')
        expect(result.failure?.code).toBe('TARGET_NOT_FOUND')
    })
})
