import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { performHover } from '../../src/actions/hover.js'
import { buildElementPathFromSelector } from '../../src/element-path/build.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('performHover', () => {
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

    it('hovers over a target and triggers hover side effects', async () => {
        await setFixture(
            page,
            `
        <button id="hover-target">Hover me</button>
        <p id="hover-status">idle</p>
        <script>
          const target = document.querySelector('#hover-target')
          const status = document.querySelector('#hover-status')
          target?.addEventListener('mouseenter', () => {
            if (status) status.textContent = 'hovered'
          })
        </script>
      `
        )

        const path = await buildElementPathFromSelector(page, '#hover-target')
        const result = await performHover(page, path!, {})

        expect(result.ok).toBe(true)
        expect((await page.textContent('#hover-status'))?.trim()).toBe(
            'hovered'
        )
    })

    it('returns error when target is unresolved', async () => {
        await setFixture(page, '<div>empty</div>')

        const path = await buildElementPathFromSelector(page, 'div')
        expect(path).toBeTruthy()
        if (!path) throw new Error('Expected path to exist.')
        path.nodes[path.nodes.length - 1].tag = 'button'
        path.nodes[path.nodes.length - 1].attrs = { id: 'x' }

        const result = await performHover(page, path, {})
        expect(result.ok).toBe(false)
        expect(result.error).toContain('No matching element found')
        expect(result.failure?.code).toBe('TARGET_NOT_FOUND')
    })

    it('classifies blocked hover interactions when an overlay is on top', async () => {
        await setFixture(
            page,
            `
        <style>
          #hover-target {
            position: absolute;
            top: 20px;
            left: 20px;
            width: 120px;
            height: 36px;
          }
          #overlay {
            position: absolute;
            inset: 0;
            pointer-events: auto;
          }
        </style>
        <button id="hover-target">Hover me</button>
        <div id="overlay"></div>
      `
        )

        page.setDefaultTimeout(1200)
        const path = await buildElementPathFromSelector(page, '#hover-target')
        const result = await performHover(page, path!, {})

        expect(result.ok).toBe(false)
        expect(result.failure?.code).toBe('BLOCKED_BY_INTERCEPTOR')
    })
})
