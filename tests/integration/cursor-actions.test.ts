import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Opensteer } from '../../src/opensteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { findCounterById, setFixture } from '../helpers/fixture.js'

describe('integration/cursor-actions', () => {
    let context: BrowserContext
    let page: Page
    let opensteer: Opensteer

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        opensteer = Opensteer.from(page, {
            cursor: {
                enabled: true,
            },
        })

        await setFixture(
            page,
            `
            <button id="target">Click me</button>
            <div id="status">idle</div>
            <script>
              document.getElementById('target')?.addEventListener('click', () => {
                document.getElementById('status').textContent = 'clicked'
              })
            </script>
            `
        )
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it('executes actions with cursor enabled without injecting page-visible cursor DOM', async () => {
        await opensteer.snapshot({ mode: 'full', withCounters: true })
        const counter = await findCounterById(page, 'target')
        expect(counter).not.toBeNull()

        await opensteer.click({ element: counter! })

        const status = (await page.textContent('#status'))?.trim()
        expect(status).toBe('clicked')
        expect(await page.$('#__opensteer_cua_cursor')).toBeNull()

        const html = await opensteer.getHtml()
        expect(html).not.toContain('__opensteer')
    })
})
