import * as cheerio from 'cheerio'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { markInteractiveElements } from '../../src/html/interactivity.js'
import { prepareSnapshot } from '../../src/html/pipeline.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('integration/shadow-slot-snapshot', () => {
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

    describe('display: contents visibility handling', () => {
        it('does not mark slot wrappers hidden when their fallback input is visibly rendered', async () => {
            await mountShadowSlotFallbackFixture(page)
            await markInteractiveElements(page)

            const state = await page.evaluate(() => {
                const host = document.querySelector('#search-host')
                if (!(host instanceof HTMLElement) || !host.shadowRoot) {
                    throw new Error('Expected the search host shadow root.')
                }

                const slot = host.shadowRoot.querySelector('slot')
                const input = host.shadowRoot.querySelector(
                    '#slotted-search-input'
                )

                if (
                    !(slot instanceof HTMLSlotElement) ||
                    !(input instanceof HTMLInputElement)
                ) {
                    throw new Error(
                        'Expected the slot and fallback input inside the shadow root.'
                    )
                }

                const slotRect = slot.getBoundingClientRect()
                const inputRect = input.getBoundingClientRect()

                return {
                    slotDisplay: getComputedStyle(slot).display,
                    slotWidth: slotRect.width,
                    slotHeight: slotRect.height,
                    slotHidden: slot.getAttribute('data-opensteer-hidden'),
                    inputWidth: inputRect.width,
                    inputHeight: inputRect.height,
                    inputHidden: input.getAttribute('data-opensteer-hidden'),
                    inputInteractive: input.getAttribute(
                        'data-opensteer-interactive'
                    ),
                }
            })

            expect(state.slotDisplay).toBe('contents')
            expect(state.slotWidth).toBe(0)
            expect(state.slotHeight).toBe(0)
            expect(state.slotHidden).toBeNull()
            expect(state.inputWidth).toBeGreaterThan(0)
            expect(state.inputHeight).toBeGreaterThan(0)
            expect(state.inputHidden).toBeNull()
            expect(state.inputInteractive).toBe('1')
        })

        it('keeps the visible fallback input in action snapshots', async () => {
            await mountShadowSlotFallbackFixture(page)

            const snapshot = await prepareSnapshot(page, {
                mode: 'action',
                withCounters: true,
                markInteractive: true,
            })

            const raw = cheerio.load(snapshot.rawHtml)
            const reduced = cheerio.load(snapshot.reducedHtml)
            const cleaned = cheerio.load(snapshot.cleanedHtml)
            const hasInputCounter = [
                ...(snapshot.counterIndex?.values() || []),
            ].some((path) => path.nodes[path.nodes.length - 1]?.tag === 'input')

            expect(raw('slot[data-opensteer-hidden="1"]').length).toBe(0)
            expect(raw('slot #slotted-search-input').length).toBe(1)

            expect(reduced('input[placeholder="Search"]').length).toBe(1)
            expect(cleaned('input[placeholder="Search"]').length).toBe(1)
            expect(hasInputCounter).toBe(true)

            expect(cleaned('os-shadow-root').text()).toContain('Search catalog')
            expect(snapshot.cleanedHtml).toContain('placeholder="Search"')
        })
    })
})

async function mountShadowSlotFallbackFixture(page: Page): Promise<void> {
    await setFixture(
        page,
        `
        <style>
            custom-search {
                display: block;
                width: 320px;
            }
        </style>
        <custom-search id="search-host"></custom-search>
        <script>
            customElements.define('custom-search', class extends HTMLElement {
                connectedCallback() {
                    if (this.shadowRoot) return

                    const root = this.attachShadow({ mode: 'open' })
                    root.innerHTML = \`
                        <style>
                            .field {
                                display: block;
                                border: 1px solid #cbd5e1;
                                padding: 12px;
                            }

                            label {
                                display: block;
                                margin-bottom: 6px;
                                font: 600 14px/1.3 sans-serif;
                            }

                            input {
                                width: 240px;
                                height: 36px;
                            }
                        </style>
                        <div class="field">
                            <label for="slotted-search-input">Search catalog</label>
                            <slot name="input">
                                <input
                                    id="slotted-search-input"
                                    placeholder="Search"
                                />
                            </slot>
                        </div>
                    \`
                }
            })
        </script>
        `
    )

    await page.waitForFunction(() => {
        const host = document.querySelector('#search-host')
        return Boolean(
            host instanceof HTMLElement &&
                host.shadowRoot?.querySelector('#slotted-search-input')
        )
    })
}
