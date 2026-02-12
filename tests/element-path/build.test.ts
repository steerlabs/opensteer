import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { buildElementPathFromSelector } from '../../src/element-path/build.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('element-path/build', () => {
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

    it('builds a normalized path for standard DOM elements', async () => {
        await setFixture(
            page,
            `
            <main>
              <button id="save-btn" name="save">Save</button>
            </main>
            `
        )

        const path = await buildElementPathFromSelector(page, '#save-btn')

        expect(path).toBeTruthy()
        expect(path?.context).toEqual([])
        const lastNode = path?.nodes[path.nodes.length - 1]
        expect(lastNode?.tag).toBe('button')
        expect(lastNode?.attrs.id).toBe('save-btn')
        expect(lastNode?.attrs.name).toBe('save')
    })

    it('captures shadow hops when selector resolves inside open shadow root', async () => {
        await setFixture(
            page,
            `
            <ov-shadow-host id="shadow-host"></ov-shadow-host>
            <script>
              class OvShadowHost extends HTMLElement {
                connectedCallback() {
                  if (this.shadowRoot) return
                  const root = this.attachShadow({ mode: 'open' })
                  root.innerHTML = '<button id="inside-shadow">Inside</button>'
                }
              }
              customElements.define('ov-shadow-host', OvShadowHost)
            </script>
            `
        )

        const path = await buildElementPathFromSelector(
            page,
            '#shadow-host #inside-shadow'
        )

        expect(path).toBeTruthy()
        expect(path?.context.length).toBe(1)
        expect(path?.context[0]?.kind).toBe('shadow')
        expect(path?.context[0]?.host.at(-1)?.attrs.id).toBe('shadow-host')
        expect(path?.nodes.at(-1)?.attrs.id).toBe('inside-shadow')
    })

    it('keeps top-page selector semantics and does not traverse iframe documents', async () => {
        await setFixture(
            page,
            `
            <iframe id="inner" srcdoc="<button id='inside-frame'>Frame</button>"></iframe>
            `
        )

        await page.waitForSelector('#inner', { state: 'attached' })

        const path = await buildElementPathFromSelector(page, '#inside-frame')
        expect(path).toBeNull()
    })
})
