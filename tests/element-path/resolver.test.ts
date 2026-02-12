import * as cheerio from 'cheerio'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import {
    buildElementPathFromSelector,
    cloneElementPath,
} from '../../src/element-path/build.js'
import { ElementPathError } from '../../src/element-path/errors.js'
import { resolveElementPath } from '../../src/element-path/resolver.js'
import type { ElementPath } from '../../src/element-path/types.js'
import { prepareSnapshot } from '../../src/html/pipeline.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('element-path/resolver', () => {
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

    it('resolves strict paths in the main DOM', async () => {
        await setFixture(
            page,
            `
            <button id="save-btn">Save</button>
            <p id="status">idle</p>
            <script>
              document.querySelector('#save-btn')?.addEventListener('click', () => {
                const status = document.querySelector('#status')
                if (status) status.textContent = 'clicked'
              })
            </script>
            `
        )

        const path = await buildElementPathFromSelector(page, '#save-btn')
        expect(path).toBeTruthy()

        const resolved = await resolveElementPath(page, path!)
        await resolved.element.click()
        await resolved.element.dispose()

        expect((await page.textContent('#status'))?.trim()).toBe('clicked')
    })

    it('resolves when ancestor positions shift but stable attrs still match', async () => {
        await setFixture(
            page,
            `
            <main>
              <section class="shell">
                <form action="/submit" target="_blank">
                  <label for="fname">First name</label>
                  <input id="fname" name="fname" type="text" />
                </form>
              </section>
            </main>
            `
        )

        const path = await buildElementPathFromSelector(page, '#fname')
        expect(path).toBeTruthy()
        if (!path) throw new Error('Expected path to exist.')

        await page.evaluate(() => {
            const style = document.createElement('style')
            style.textContent = '/* shifts nth-child ancestry */'
            document.body.prepend(style)
        })

        const resolved = await resolveElementPath(page, path)
        await resolved.element.fill('Ada')
        await resolved.element.dispose()

        expect(await page.inputValue('#fname')).toBe('Ada')
    })

    it('resolves using remaining match candidates when stored attrs are missing', async () => {
        await setFixture(
            page,
            `
            <main>
              <button id="save-btn" class="primary">Save</button>
              <button id="cancel-btn" class="primary">Cancel</button>
              <p id="status">idle</p>
            </main>
            <script>
              document.querySelector('#save-btn')?.addEventListener('click', () => {
                const status = document.querySelector('#status')
                if (status) status.textContent = 'clicked'
              })
            </script>
            `
        )

        const path = await buildElementPathFromSelector(page, '#save-btn')
        expect(path).toBeTruthy()
        if (!path) throw new Error('Expected path to exist.')

        const loosePath = cloneElementPath(path)
        for (const node of loosePath.nodes) {
            node.attrs = {}
        }

        const resolved = await resolveElementPath(page, loosePath)
        await resolved.element.click()
        await resolved.element.dispose()

        expect((await page.textContent('#status'))?.trim()).toBe('clicked')
    })

    it('resolves iframe context hops from snapshot-derived paths', async () => {
        await setFixture(
            page,
            `
            <iframe
              id="frame-host"
              srcdoc="<html><body><input id='inside-frame' value='' /></body></html>"
            ></iframe>
            `
        )

        await page
            .frameLocator('#frame-host')
            .locator('#inside-frame')
            .waitFor({ state: 'visible' })

        const path = await buildPathFromSnapshotSelector(
            page,
            '#frame-host + ov-iframe-root #inside-frame'
        )

        const resolved = await resolveElementPath(page, path)
        await resolved.element.fill('from-path')
        await resolved.element.dispose()

        const frame = page
            .frames()
            .find((candidate) => candidate !== page.mainFrame())
        expect(frame).toBeTruthy()
        expect(await frame!.inputValue('#inside-frame')).toBe('from-path')
    })

    it('does not perform global fallback when iframe context is missing', async () => {
        await setFixture(
            page,
            `
            <iframe
              id="frame-host"
              srcdoc="<html><body><button id='inside-frame'>Frame Button</button></body></html>"
            ></iframe>
            `
        )

        await page
            .frameLocator('#frame-host')
            .locator('#inside-frame')
            .waitFor({ state: 'visible' })

        const path = await buildPathFromSnapshotSelector(
            page,
            '#frame-host + ov-iframe-root #inside-frame'
        )

        const withoutContext: ElementPath = {
            ...path,
            context: [],
        }

        await expect(
            resolveElementPath(page, withoutContext)
        ).rejects.toMatchObject({
            code: 'ERR_PATH_TARGET_NOT_FOUND',
        })
    })

    it('returns explicit shadow-root unavailable error when host no longer has an open root', async () => {
        await setFixture(
            page,
            `
            <div id="shadow-host"></div>
            <script>
              const host = document.querySelector('#shadow-host')
              const root = host?.attachShadow({ mode: 'open' })
              if (root) {
                root.innerHTML = '<button id="inside-shadow">Inside</button>'
              }
            </script>
            `
        )

        const path = await buildElementPathFromSelector(
            page,
            '#shadow-host #inside-shadow'
        )
        expect(path).toBeTruthy()
        if (!path) throw new Error('Expected path to exist.')

        await page.evaluate(() => {
            const original = document.querySelector('#shadow-host')
            if (!original) return

            const replacement = document.createElement('div')
            replacement.id = 'shadow-host'
            original.replaceWith(replacement)
        })

        await expect(resolveElementPath(page, path)).rejects.toMatchObject({
            code: 'ERR_PATH_SHADOW_ROOT_UNAVAILABLE',
        })
    })

    it('returns context host not found when context host path no longer resolves', async () => {
        await setFixture(
            page,
            `
            <div id="shadow-host"></div>
            <script>
              const host = document.querySelector('#shadow-host')
              const root = host?.attachShadow({ mode: 'open' })
              if (root) {
                root.innerHTML = '<button id="inside-shadow">Inside</button>'
              }
            </script>
            `
        )

        const path = await buildElementPathFromSelector(
            page,
            '#shadow-host #inside-shadow'
        )
        expect(path).toBeTruthy()
        if (!path) throw new Error('Expected path to exist.')

        const brokenPath = cloneElementPath(path)
        const hostTail =
            brokenPath.context[brokenPath.context.length - 1]?.host.at(-1)
        if (!hostTail) throw new Error('Expected shadow context host node.')
        hostTail.attrs.id = 'missing-shadow-host'

        await expect(
            resolveElementPath(page, brokenPath)
        ).rejects.toMatchObject({
            code: 'ERR_PATH_CONTEXT_HOST_NOT_FOUND',
        })
    })

    it('returns iframe unavailable when iframe hop resolves to a non-iframe host', async () => {
        await setFixture(
            page,
            `
            <div id="non-frame-host"></div>
            <iframe
              id="frame-host"
              srcdoc="<html><body><button id='inside-frame'>Frame Button</button></body></html>"
            ></iframe>
            `
        )

        await page
            .frameLocator('#frame-host')
            .locator('#inside-frame')
            .waitFor({ state: 'visible' })

        const framePath = await buildPathFromSnapshotSelector(
            page,
            '#frame-host + ov-iframe-root #inside-frame'
        )
        const nonFrameHost = await buildElementPathFromSelector(
            page,
            '#non-frame-host'
        )
        expect(nonFrameHost).toBeTruthy()
        if (!nonFrameHost) throw new Error('Expected non-frame host path.')

        const brokenPath = cloneElementPath(framePath)
        brokenPath.context[0] = {
            kind: 'iframe',
            host: nonFrameHost.nodes,
        }

        await expect(
            resolveElementPath(page, brokenPath)
        ).rejects.toMatchObject({
            code: 'ERR_PATH_IFRAME_UNAVAILABLE',
        })
    })
})

async function buildPathFromSnapshotSelector(
    page: Page,
    selector: string
): Promise<ElementPath> {
    const snapshot = await prepareSnapshot(page, {
        mode: 'full',
        withCounters: true,
        markInteractive: true,
    })

    const $$ = cheerio.load(snapshot.cleanedHtml)
    const counterAttr = $$(selector).first().attr('c')
    const counter = Number.parseInt(counterAttr || '', 10)

    if (!Number.isFinite(counter)) {
        throw new Error(`No counter found for selector: ${selector}`)
    }

    const path = snapshot.counterIndex?.get(counter)
    if (!path) {
        throw new Error(`No ElementPath found for selector: ${selector}`)
    }

    return cloneElementPath(path)
}
