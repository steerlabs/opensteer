import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { performClick } from '../../src/actions/click.js'
import { buildElementPathFromSelector } from '../../src/element-path/build.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('performClick', () => {
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

    it('clicks a resolved element and returns selector metadata', async () => {
        await setFixture(
            page,
            `
        <button id="cta-btn">Run action</button>
        <p id="status">idle</p>
        <script>
          const btn = document.querySelector('#cta-btn')
          const status = document.querySelector('#status')
          btn?.addEventListener('click', () => {
            if (status) status.textContent = 'clicked'
          })
        </script>
      `
        )

        const path = await buildElementPathFromSelector(page, '#cta-btn')
        const result = await performClick(page, path!, {
            button: 'left',
            clickCount: 1,
        })

        expect(result.ok).toBe(true)
        expect(result.usedSelector).toBeTruthy()
        expect((await page.textContent('#status'))?.trim()).toBe('clicked')
    })

    it('supports right click options', async () => {
        await setFixture(
            page,
            `
        <button id="menu-btn">Open menu</button>
        <p id="status">closed</p>
        <script>
          const btn = document.querySelector('#menu-btn')
          const status = document.querySelector('#status')
          btn?.addEventListener('contextmenu', (event) => {
            event.preventDefault()
            if (status) status.textContent = 'open'
          })
        </script>
      `
        )

        const path = await buildElementPathFromSelector(page, '#menu-btn')
        const result = await performClick(page, path!, {
            button: 'right',
            clickCount: 1,
        })

        expect(result.ok).toBe(true)
        expect((await page.textContent('#status'))?.trim()).toBe('open')
    })

    it('returns error when descriptor cannot be resolved', async () => {
        await setFixture(page, '<div id="root">No target</div>')

        const path = await buildElementPathFromSelector(page, '#root')
        expect(path).toBeTruthy()
        if (!path) throw new Error('Expected path to exist.')
        path.nodes[path.nodes.length - 1].tag = 'button'
        path.nodes[path.nodes.length - 1].attrs = {
            id: 'missing',
        }

        const result = await performClick(page, path, {})

        expect(result.ok).toBe(false)
        expect(result.error).toContain('No matching element found')
    })
})
