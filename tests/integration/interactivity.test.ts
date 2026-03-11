import * as cheerio from 'cheerio'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { markInteractiveElements } from '../../src/html/interactivity.js'
import { prepareSnapshot } from '../../src/html/pipeline.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('integration/interactivity', () => {
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

    it('does not mark negative-tabindex shadow wrappers as interactive', async () => {
        await setupShadowInputWrapperFixture(page, '-1')

        await markInteractiveElements(page)

        const state = await getShadowInputWrapperState(page)

        expect(state.wrapperInteractive).toBe(false)
        expect(state.inputInteractive).toBe(true)
    })

    it('marks non-negative-tabindex shadow wrappers as interactive', async () => {
        await setupShadowInputWrapperFixture(page, '0')

        await markInteractiveElements(page)

        const state = await getShadowInputWrapperState(page)

        expect(state.wrapperInteractive).toBe(true)
        expect(state.inputInteractive).toBe(true)
    })

    it('collapses negative-tabindex shadow wrappers out of action snapshots', async () => {
        await setupShadowInputWrapperFixture(page, '-1')

        const snapshot = await prepareSnapshot(page, {
            mode: 'action',
            withCounters: true,
            markInteractive: true,
        })

        const $$ = cheerio.load(snapshot.cleanedHtml)

        expect(
            $$('os-shadow-root input[placeholder="Tracking number"]').length
        ).toBe(1)
        expect($$('os-shadow-root div').length).toBe(0)
    })

    it('preserves non-negative-tabindex shadow wrappers in action snapshots', async () => {
        await setupShadowInputWrapperFixture(page, '0')

        const snapshot = await prepareSnapshot(page, {
            mode: 'action',
            withCounters: true,
            markInteractive: true,
        })

        const $$ = cheerio.load(snapshot.cleanedHtml)

        expect(
            $$('os-shadow-root input[placeholder="Tracking number"]').length
        ).toBe(1)
        expect($$('os-shadow-root div').length).toBe(1)
    })
})

async function setupShadowInputWrapperFixture(
    page: Page,
    tabIndex: string
): Promise<void> {
    await setFixture(page, '<div id="shadow-host"></div>')

    await page.evaluate(
        ({ tabIndex }) => {
            const host = document.querySelector('#shadow-host')
            if (!(host instanceof HTMLElement)) return

            const root = host.attachShadow({ mode: 'open' })
            root.innerHTML = `
                <div id="field-wrapper" tabindex="${tabIndex}">
                    <div class="input-container">
                        <input
                            id="tracking-input"
                            type="text"
                            placeholder="Tracking number"
                        />
                    </div>
                </div>
            `
        },
        { tabIndex }
    )
}

async function getShadowInputWrapperState(page: Page): Promise<{
    wrapperInteractive: boolean | null
    inputInteractive: boolean | null
}> {
    return page.evaluate(() => {
        const host = document.querySelector('#shadow-host')
        if (!(host instanceof HTMLElement) || !host.shadowRoot) {
            return {
                wrapperInteractive: null,
                inputInteractive: null,
            }
        }

        return {
            wrapperInteractive:
                host.shadowRoot
                    .querySelector('#field-wrapper')
                    ?.hasAttribute('data-opensteer-interactive') ?? null,
            inputInteractive:
                host.shadowRoot
                    .querySelector('#tracking-input')
                    ?.hasAttribute('data-opensteer-interactive') ?? null,
        }
    })
}
