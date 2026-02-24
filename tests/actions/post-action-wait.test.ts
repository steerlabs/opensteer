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

        const opensteer = Opensteer.from(page, { name: 'post-action-dom' })
        await opensteer.click({ selector: '#trigger' })

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

        const opensteer = Opensteer.from(page, { name: 'post-action-network' })
        await opensteer.click({ selector: '#trigger' })

        expect((await page.textContent('#status'))?.trim()).toBe('network:ok')
        await page.unroute('https://opensteer.local/post-action')
    })

    it('settles quickly after navigation when the destination keeps polling', async () => {
        const homeUrl = 'https://opensteer.local/home'
        const searchUrlPattern = /^https:\/\/opensteer\.local\/search\?q=.*/
        const analyticsUrlPattern = /^https:\/\/opensteer\.local\/analytics\?i=\d+/
        let analyticsHits = 0

        await page.route(homeUrl, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: `
            <form action="https://opensteer.local/search" method="get">
              <input id="search-box" name="q" />
            </form>
          `,
            })
        })

        await page.route(searchUrlPattern, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: `
            <p id="status">loading</p>
            <p id="result"></p>
            <script>
              const query = new URLSearchParams(location.search).get('q') || '';
              window.setTimeout(() => {
                const status = document.querySelector('#status');
                const result = document.querySelector('#result');
                if (status) status.textContent = 'ready';
                if (result) result.textContent = 'results:' + query;
              }, 180);

              let count = 0;
              window.__polling = window.setInterval(() => {
                count += 1;
                fetch('https://opensteer.local/analytics?i=' + count).catch(() => {});
                if (count >= 50) window.clearInterval(window.__polling);
              }, 100);
            </script>
          `,
            })
        })

        await page.route(analyticsUrlPattern, async (route) => {
            analyticsHits += 1
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 30)
            })

            await route.fulfill({
                status: 204,
                contentType: 'text/plain',
                body: '',
            })
        })

        await page.goto(homeUrl, { waitUntil: 'domcontentloaded' })
        const opensteer = Opensteer.from(page, { name: 'post-action-nav-polling' })

        const startedAt = Date.now()
        await opensteer.input({
            selector: '#search-box',
            text: 'airpods',
            pressEnter: true,
            description: 'Search input',
        })
        const elapsed = Date.now() - startedAt

        expect(page.url()).toContain('/search?q=airpods')
        expect((await page.textContent('#status'))?.trim()).toBe('ready')
        expect((await page.textContent('#result'))?.trim()).toBe('results:airpods')
        expect(analyticsHits).toBeGreaterThan(2)
        expect(elapsed).toBeLessThan(4500)

        await page.unroute(homeUrl)
        await page.unroute(searchUrlPattern)
        await page.unroute(analyticsUrlPattern)
    })

    it('does not wait for the full timeout when visible regions keep mutating', async () => {
        const homeUrl = 'https://opensteer.local/home'
        const searchUrlPattern = /^https:\/\/opensteer\.local\/search\?q=.*/

        await page.route(homeUrl, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: `
            <form action="https://opensteer.local/search" method="get">
              <input id="search-box" name="q" />
            </form>
          `,
            })
        })

        await page.route(searchUrlPattern, async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'text/html',
                body: `
            <p id="status">loading</p>
            <p id="result"></p>
            <p id="ticker">0</p>
            <script>
              const query = new URLSearchParams(location.search).get('q') || '';
              const status = document.querySelector('#status');
              const result = document.querySelector('#result');
              const ticker = document.querySelector('#ticker');

              window.setTimeout(() => {
                if (status) status.textContent = 'ready';
                if (result) result.textContent = 'results:' + query;
              }, 220);

              let count = 0;
              window.__visualNoise = window.setInterval(() => {
                count += 1;
                if (ticker) ticker.textContent = String(count);
                if (count >= 200) window.clearInterval(window.__visualNoise);
              }, 40);
            </script>
          `,
            })
        })

        await page.goto(homeUrl, { waitUntil: 'domcontentloaded' })
        const opensteer = Opensteer.from(page, {
            name: 'post-action-visual-noise',
        })

        const startedAt = Date.now()
        await opensteer.input({
            selector: '#search-box',
            text: 'airpods',
            pressEnter: true,
            description: 'Search input',
        })
        const elapsed = Date.now() - startedAt

        expect(page.url()).toContain('/search?q=airpods')
        expect((await page.textContent('#status'))?.trim()).toBe('ready')
        expect((await page.textContent('#result'))?.trim()).toBe('results:airpods')
        expect(elapsed).toBeGreaterThanOrEqual(200)
        expect(elapsed).toBeLessThan(3600)

        await page.unroute(homeUrl)
        await page.unroute(searchUrlPattern)
    })

    it('bounds post-action wait duration when tracked network remains pending', async () => {
        await page.route('https://opensteer.local/slow-request', async (route) => {
            await new Promise<void>((resolve) => {
                setTimeout(resolve, 2400)
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
        <button id="trigger">Trigger slow fetch</button>
        <p id="status">idle</p>
        <script>
          const trigger = document.querySelector('#trigger');
          const status = document.querySelector('#status');
          trigger?.addEventListener('click', () => {
            fetch('https://opensteer.local/slow-request').catch(() => {});
            window.setTimeout(() => {
              if (status) status.textContent = 'done';
            }, 120);
          });
        </script>
      `
        )

        const opensteer = Opensteer.from(page, { name: 'post-action-time-bounds' })
        const startedAt = Date.now()
        await opensteer.click({
            selector: '#trigger',
            wait: {
                timeout: 1200,
                settleMs: 120,
                includeNetwork: true,
                networkQuietMs: 200,
            },
        })
        const elapsed = Date.now() - startedAt

        expect((await page.textContent('#status'))?.trim()).toBe('done')
        expect(elapsed).toBeGreaterThanOrEqual(1000)
        expect(elapsed).toBeLessThan(2500)
        await page.unroute('https://opensteer.local/slow-request')
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

        const opensteer = Opensteer.from(page, { name: 'post-action-skip' })
        await opensteer.click({ selector: '#trigger', wait: false })

        expect((await page.textContent('#status'))?.trim()).toBe('idle')
        await page.waitForFunction(() => {
            return document.querySelector('#status')?.textContent === 'done'
        })
    })
})
