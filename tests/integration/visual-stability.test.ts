import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { waitForVisualStabilityAcrossFrames } from '../../src/navigation.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('integration/visual-stability', () => {
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

    it('waits for delayed iframe mutations', async () => {
        await setFixture(
            page,
            `
        <iframe
          id="frame"
          srcdoc="<html><body><p id='frame-status'>idle</p></body></html>"
        ></iframe>
      `
        )

        await page.waitForFunction(() => {
            const frame = document.querySelector('#frame') as
                | HTMLIFrameElement
                | null
            return !!frame?.contentDocument
        })

        await page.evaluate(() => {
            const frame = document.querySelector('#frame') as HTMLIFrameElement
            const frameDocument = frame.contentDocument
            const status = frameDocument?.querySelector('#frame-status')

            window.setTimeout(() => {
                if (status) {
                    status.textContent = 'updated'
                }
            }, 80)
        })

        const startedAt = Date.now()
        await waitForVisualStabilityAcrossFrames(page, {
            timeout: 3000,
            settleMs: 120,
        })
        const elapsed = Date.now() - startedAt

        const text = await page.evaluate(() => {
            const frame = document.querySelector('#frame') as HTMLIFrameElement
            return (
                frame.contentDocument?.querySelector('#frame-status')
                    ?.textContent || ''
            )
        })

        expect(text).toBe('updated')
        expect(elapsed).toBeGreaterThanOrEqual(70)
    })

    it('waits for delayed mutations inside open shadow roots', async () => {
        await setFixture(
            page,
            `
        <div id="host"></div>
        <script>
          const host = document.querySelector('#host');
          const root = host?.attachShadow({ mode: 'open' });
          if (root) {
            root.innerHTML = '<span id="shadow-status">idle</span>';
            const status = root.querySelector('#shadow-status');
            window.setTimeout(() => {
              if (status) status.textContent = 'done';
            }, 80);
          }
        </script>
      `
        )

        const startedAt = Date.now()
        await waitForVisualStabilityAcrossFrames(page, {
            timeout: 3000,
            settleMs: 120,
        })
        const elapsed = Date.now() - startedAt

        const text = await page.evaluate(() => {
            const host = document.querySelector('#host')
            const shadowRoot = host?.shadowRoot
            return shadowRoot?.querySelector('#shadow-status')?.textContent || ''
        })

        expect(text).toBe('done')
        expect(elapsed).toBeGreaterThanOrEqual(70)
    })

    it('ignores long-running offscreen finite animations', async () => {
        await setFixture(
            page,
            `
        <p id="status">idle</p>
        <div id="offscreen-target"></div>
        <script>
          const status = document.querySelector('#status');
          const target = document.querySelector('#offscreen-target');

          if (target instanceof HTMLElement) {
            target.style.position = 'absolute';
            target.style.top = '5000px';
            target.style.width = '24px';
            target.style.height = '24px';
            target.animate(
              [{ transform: 'translateX(0px)' }, { transform: 'translateX(10px)' }],
              { duration: 5000, fill: 'forwards' }
            );
          }

          window.setTimeout(() => {
            if (status) status.textContent = 'updated';
          }, 80);
        </script>
      `
        )

        const startedAt = Date.now()
        await waitForVisualStabilityAcrossFrames(page, {
            timeout: 2000,
            settleMs: 120,
        })
        const elapsed = Date.now() - startedAt

        expect((await page.textContent('#status'))?.trim()).toBe('updated')
        expect(elapsed).toBeLessThan(900)
    })

    it('returns on timeout without throwing when DOM never settles', async () => {
        await setFixture(
            page,
            `
        <p id="status">0</p>
        <script>
          let counter = 0;
          window.__testIntervalId = window.setInterval(() => {
            counter += 1;
            const status = document.querySelector('#status');
            if (status) status.textContent = String(counter);
          }, 25);
        </script>
      `
        )

        const startedAt = Date.now()
        await waitForVisualStabilityAcrossFrames(page, {
            timeout: 300,
            settleMs: 60,
        })
        const elapsed = Date.now() - startedAt

        await page.evaluate(() => {
            const intervalId = (window as Window & { __testIntervalId?: number })
                .__testIntervalId
            if (typeof intervalId === 'number') {
                window.clearInterval(intervalId)
            }
        })

        expect(elapsed).toBeGreaterThanOrEqual(250)
        expect(elapsed).toBeLessThan(1500)
    })
})
