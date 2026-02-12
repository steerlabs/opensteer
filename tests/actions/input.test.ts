import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { performInput } from '../../src/actions/input.js'
import { buildElementPathFromSelector } from '../../src/element-path/build.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('performInput', () => {
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

    it('fills text and optionally presses enter', async () => {
        await setFixture(
            page,
            `
        <input id="message" value="" />
        <p id="enter-count">0</p>
        <script>
          const input = document.querySelector('#message')
          const count = document.querySelector('#enter-count')
          let enters = 0
          input?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
              enters += 1
              if (count) count.textContent = String(enters)
            }
          })
        </script>
      `
        )

        const path = await buildElementPathFromSelector(page, '#message')
        const result = await performInput(page, path!, {
            text: 'hello world',
            pressEnter: true,
        })

        expect(result.ok).toBe(true)
        expect(await page.inputValue('#message')).toBe('hello world')
        expect((await page.textContent('#enter-count'))?.trim()).toBe('1')
    })

    it('types without clearing when clear is false', async () => {
        await setFixture(page, '<input id="name" value="Ada" />')

        const path = await buildElementPathFromSelector(page, '#name')
        const result = await performInput(page, path!, {
            text: ' Lovelace',
            clear: false,
        })

        expect(result.ok).toBe(true)
        // Current behavior relies on locator.type(), which types at the current caret position.
        expect(await page.inputValue('#name')).toBe(' LovelaceAda')
    })

    it('returns error when target is unresolved', async () => {
        await setFixture(page, '<div id="root"></div>')

        const path = await buildElementPathFromSelector(page, '#root')
        expect(path).toBeTruthy()
        if (!path) throw new Error('Expected path to exist.')
        path.nodes[path.nodes.length - 1].tag = 'input'
        path.nodes[path.nodes.length - 1].attrs = {
            id: 'missing',
        }

        const result = await performInput(page, path, { text: 'x' })

        expect(result.ok).toBe(false)
        expect(result.error).toContain('No matching element found')
    })
})
