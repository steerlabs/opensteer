import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Opensteer } from '../../src/opensteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('post-action wait', () => {
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

    it('waits for delayed DOM updates by default', async () => {
        await setFixture(
            page,
            `
        <button id="trigger">Trigger update</button>
        <p id="status">idle</p>
        <script>
          const trigger = document.querySelector('#trigger');
          const status = document.querySelector('#status');
          trigger?.addEventListener('click', () => {
            window.setTimeout(() => {
              if (status) {
                status.textContent = 'done';
              }
            }, 320);
          });
        </script>
      `
        )

        const ov = Opensteer.from(page, { name: 'post-action-dom' })
        await ov.click({ selector: '#trigger' })

        expect((await page.textContent('#status'))?.trim()).toBe('done')
    })

    it('waits for delayed network-backed updates by default', async () => {
        await page.route('https://opensteer.local/post-action', async (route) => {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 250)
            })

            await route.fulfill({
                status: 200,
                contentType: 'text/plain',
                body: 'ok',
            })
        })

        await setFixture(
            page,
            `
        <button id="trigger">Trigger fetch</button>
        <p id="status">idle</p>
        <script>
          const trigger = document.querySelector('#trigger');
          const status = document.querySelector('#status');
          trigger?.addEventListener('click', async () => {
            const response = await fetch('https://opensteer.local/post-action');
            const body = await response.text();
            if (status) {
              status.textContent = 'network:' + body;
            }
          });
        </script>
      `
        )

        const ov = Opensteer.from(page, { name: 'post-action-network' })
        await ov.click({ selector: '#trigger' })

        expect((await page.textContent('#status'))?.trim()).toBe('network:ok')
        await page.unroute('https://opensteer.local/post-action')
    })

    it('skips post-action wait when wait is false', async () => {
        await setFixture(
            page,
            `
        <button id="trigger">No wait</button>
        <p id="status">idle</p>
        <script>
          const trigger = document.querySelector('#trigger');
          const status = document.querySelector('#status');
          trigger?.addEventListener('click', () => {
            window.setTimeout(() => {
              if (status) {
                status.textContent = 'done';
              }
            }, 450);
          });
        </script>
      `
        )

        const ov = Opensteer.from(page, { name: 'post-action-skip' })
        await ov.click({ selector: '#trigger', wait: false })

        expect((await page.textContent('#status'))?.trim()).toBe('idle')
        await page.waitForFunction(() => {
            return document.querySelector('#status')?.textContent === 'done'
        })
    })
})
