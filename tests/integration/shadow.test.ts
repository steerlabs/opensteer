import * as cheerio from 'cheerio'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { performClick } from '../../src/actions/click.js'
import { performInput } from '../../src/actions/input.js'
import { buildElementPathFromSelector } from '../../src/element-path/build.js'
import { prepareSnapshot } from '../../src/html/pipeline.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { gotoRoute } from '../helpers/integration.js'

describe('integration/shadow', () => {
    let context: BrowserContext
    let page: Page

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        await gotoRoute(page, '/shadow')
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it('keeps explicit shadow boundary wrappers in snapshots', async () => {
        const snapshot = await prepareSnapshot(page, {
            mode: 'action',
            withCounters: true,
        })

        expect(snapshot.cleanedHtml).toContain('os-shadow-root')

        const $$ = cheerio.load(snapshot.cleanedHtml)
        const shadowButtonCounter = $$('os-shadow-root button')
            .first()
            .attr('c')

        expect(shadowButtonCounter).toBeTruthy()
    })

    it('resolves and executes actions inside shadow roots', async () => {
        const buttonPath = await buildElementPathFromSelector(
            page,
            '#shadow-button-host #shadow-action-btn'
        )
        const inputPath = await buildElementPathFromSelector(
            page,
            '#shadow-input-host #shadow-input'
        )
        const cardActionPath = await buildElementPathFromSelector(
            page,
            '#card-2 #shadow-card-action'
        )

        expect(buttonPath).toBeTruthy()
        expect(inputPath).toBeTruthy()
        expect(cardActionPath).toBeTruthy()

        expect(
            (
                await performClick(page, buttonPath!, {
                    button: 'left',
                    clickCount: 1,
                })
            ).ok
        ).toBe(true)

        expect(
            (await performInput(page, inputPath!, { text: 'dashboards' })).ok
        ).toBe(true)

        expect(
            (
                await performClick(page, cardActionPath!, {
                    button: 'left',
                    clickCount: 1,
                })
            ).ok
        ).toBe(true)

        expect((await page.textContent('#shadow-click-output'))?.trim()).toBe(
            'clicked:shadow-button-host'
        )
        expect((await page.textContent('#shadow-input-output'))?.trim()).toBe(
            'dashboards'
        )
        expect((await page.textContent('#shadow-card-output'))?.trim()).toBe(
            'card-2:Billing Console'
        )
    })
})
