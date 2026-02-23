import * as cheerio from 'cheerio'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { performClick } from '../../src/actions/click.js'
import { performHover } from '../../src/actions/hover.js'
import { performInput } from '../../src/actions/input.js'
import { performSelect } from '../../src/actions/select.js'
import { cloneElementPath } from '../../src/element-path/build.js'
import type { ElementPath } from '../../src/element-path/types.js'
import { prepareSnapshot } from '../../src/html/pipeline.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('integration/context-action-functions', () => {
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

    it('runs click/input/select/hover inside iframe context', async () => {
        await setupIframeActionFixture(page)

        const inputPath = await buildPathFromSnapshotSelector(
            page,
            '#frame-host + os-iframe-root #frame-input'
        )
        const selectPath = await buildPathFromSnapshotSelector(
            page,
            '#frame-host + os-iframe-root #frame-select'
        )
        const hoverPath = await buildPathFromSnapshotSelector(
            page,
            '#frame-host + os-iframe-root #frame-hover'
        )
        const clickPath = await buildPathFromSnapshotSelector(
            page,
            '#frame-host + os-iframe-root #frame-button'
        )

        expect(
            (await performInput(page, inputPath, { text: 'gamma' })).ok
        ).toBe(true)
        expect(
            (await performSelect(page, selectPath, { value: 'two' })).ok
        ).toBe(true)
        expect((await performHover(page, hoverPath, {})).ok).toBe(true)
        expect(
            (
                await performClick(page, clickPath, {
                    button: 'left',
                    clickCount: 1,
                })
            ).ok
        ).toBe(true)

        const frame = page.frame({ name: 'actions-frame' })
        expect(frame).toBeTruthy()
        if (!frame) throw new Error('Expected actions iframe to exist.')
        const state = await frame.evaluate(() => ({
            input: document.body.getAttribute('data-input'),
            select: document.body.getAttribute('data-select'),
            hover: document.body.getAttribute('data-hover'),
            click: document.body.getAttribute('data-click'),
        }))
        expect(state).toEqual({
            input: 'gamma',
            select: 'two',
            hover: '1',
            click: 'gamma:two',
        })
    })

    it('runs click/input/select/hover inside shadow-root context', async () => {
        await setupShadowActionFixture(page)

        const inputPath = await buildPathFromSnapshotSelector(
            page,
            '#shadow-host os-shadow-root #shadow-input'
        )
        const selectPath = await buildPathFromSnapshotSelector(
            page,
            '#shadow-host os-shadow-root #shadow-select'
        )
        const hoverPath = await buildPathFromSnapshotSelector(
            page,
            '#shadow-host os-shadow-root #shadow-hover'
        )
        const clickPath = await buildPathFromSnapshotSelector(
            page,
            '#shadow-host os-shadow-root #shadow-button'
        )

        expect(
            (await performInput(page, inputPath, { text: 'delta' })).ok
        ).toBe(true)
        expect(
            (await performSelect(page, selectPath, { value: 'beta' })).ok
        ).toBe(true)
        expect((await performHover(page, hoverPath, {})).ok).toBe(true)
        expect(
            (
                await performClick(page, clickPath, {
                    button: 'left',
                    clickCount: 1,
                })
            ).ok
        ).toBe(true)

        const result = await page.evaluate(() => {
            const host = document.querySelector('#shadow-host')
            if (!(host instanceof HTMLElement) || !host.shadowRoot) {
                return {
                    input: null,
                    select: null,
                    hover: null,
                    click: null,
                }
            }

            return {
                input: host.shadowRoot.querySelector('#result-input')
                    ?.textContent,
                select: host.shadowRoot.querySelector('#result-select')
                    ?.textContent,
                hover: host.shadowRoot.querySelector('#result-hover')
                    ?.textContent,
                click: host.shadowRoot.querySelector('#result-click')
                    ?.textContent,
            }
        })

        expect(result.input?.trim()).toBe('delta')
        expect(result.select?.trim()).toBe('beta')
        expect(result.hover?.trim()).toBe('hovered')
        expect(result.click?.trim()).toBe('clicked:delta:beta')
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
    const value = $$(selector).first().attr('c')
    const counter = Number.parseInt(value || '', 10)
    if (!Number.isFinite(counter)) {
        throw new Error(`No counter found for selector: ${selector}`)
    }

    const path = snapshot.counterIndex?.get(counter)
    if (!path) {
        throw new Error(`No ElementPath found for selector: ${selector}`)
    }

    return cloneElementPath(path)
}

async function setupIframeActionFixture(page: Page): Promise<void> {
    await setFixture(
        page,
        '<iframe id="frame-host" name="actions-frame"></iframe>'
    )

    await page.evaluate(() => {
        const frame = document.querySelector('#frame-host')
        if (!(frame instanceof HTMLIFrameElement)) return
        frame.srcdoc = `<!doctype html><html><body>
            <input id="frame-input" oninput="document.body.setAttribute('data-input', this.value)" />
            <select id="frame-select" onchange="document.body.setAttribute('data-select', this.value)">
                <option value="one">One</option>
                <option value="two">Two</option>
            </select>
            <div id="frame-hover" onmouseenter="document.body.setAttribute('data-hover', '1')">Hover</div>
            <button id="frame-button" onclick="document.body.setAttribute('data-click', document.getElementById('frame-input').value + ':' + document.getElementById('frame-select').value)">Submit</button>
        </body></html>`
    })

    await page.waitForFunction(() => {
        const frame = document.querySelector('#frame-host')
        if (!(frame instanceof HTMLIFrameElement)) return false
        return !!frame.contentDocument?.querySelector('#frame-button')
    })
}

async function setupShadowActionFixture(page: Page): Promise<void> {
    await setFixture(page, '<div id="shadow-host"></div>')

    await page.evaluate(() => {
        const host = document.querySelector('#shadow-host')
        if (!(host instanceof HTMLElement) || host.shadowRoot) return

        const root = host.attachShadow({ mode: 'open' })
        root.innerHTML = `
            <input id="shadow-input" />
            <select id="shadow-select">
                <option value="alpha">Alpha</option>
                <option value="beta">Beta</option>
            </select>
            <div id="shadow-hover">Hover</div>
            <button id="shadow-button">Submit</button>
            <p id="result-input"></p>
            <p id="result-select"></p>
            <p id="result-hover"></p>
            <p id="result-click"></p>
        `

        const input = root.querySelector('#shadow-input')
        const select = root.querySelector('#shadow-select')
        const hover = root.querySelector('#shadow-hover')
        const button = root.querySelector('#shadow-button')
        const outputInput = root.querySelector('#result-input')
        const outputSelect = root.querySelector('#result-select')
        const outputHover = root.querySelector('#result-hover')
        const outputClick = root.querySelector('#result-click')

        if (input instanceof HTMLInputElement && outputInput) {
            input.addEventListener('input', () => {
                outputInput.textContent = input.value
            })
        }
        if (select instanceof HTMLSelectElement && outputSelect) {
            select.addEventListener('change', () => {
                outputSelect.textContent = select.value
            })
        }
        if (hover instanceof HTMLElement && outputHover) {
            hover.addEventListener('mouseenter', () => {
                outputHover.textContent = 'hovered'
            })
        }
        if (
            button instanceof HTMLElement &&
            outputClick &&
            input instanceof HTMLInputElement &&
            select instanceof HTMLSelectElement
        ) {
            button.addEventListener('click', () => {
                outputClick.textContent = `clicked:${input.value}:${select.value}`
            })
        }
    })
}
