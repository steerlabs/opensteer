import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Opensteer } from '../../src/opensteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { getTestAppRoute } from '../helpers/testApp.js'

describe('integration/goto-navigation-churn', () => {
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

    it('keeps goto resilient through transient main-frame context churn', async () => {
        const opensteer = Opensteer.from(page, {
            name: 'integration-goto-navigation-churn',
        })

        await opensteer.goto(getTestAppRoute('/navigation-churn?stage=1'), {
            timeout: 3000,
            settleMs: 120,
        })

        await opensteer.page.waitForSelector('#navigation-churn-input', {
            state: 'visible',
            timeout: 5000,
        })

        const stageText = await opensteer.page.textContent(
            '#navigation-churn-stage'
        )
        expect(stageText?.trim()).toBe('Stage 2')
    })
})
