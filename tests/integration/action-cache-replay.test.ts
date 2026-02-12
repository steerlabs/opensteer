import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Oversteer } from '../../src/oversteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { gotoRoute } from '../helpers/integration.js'

describe('integration/action-cache-replay', () => {
    let context: BrowserContext
    let page: Page
    let rootDir: string

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-int-action-cache-'))
    })

    afterEach(async () => {
        await context.close()
        fs.rmSync(rootDir, { recursive: true, force: true })
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it('replays cached input/select/hover/click paths without AI', async () => {
        await gotoRoute(page, '/forms')

        const first = Oversteer.from(page, {
            name: 'action-cache-replay',
            storage: { rootDir },
        })

        const firstInput = await first.input({
            selector: '#full-name',
            text: 'Alice Cache',
            description: 'cached full name input',
        })
        expect(firstInput.persisted).toBe(true)

        const firstSelect = await first.select({
            selector: '#plan-select',
            value: 'pro',
            description: 'cached plan select',
        })
        expect(firstSelect.persisted).toBe(true)

        const firstHover = await first.hover({
            selector: '#submit-btn',
            description: 'cached submit hover',
        })
        expect(firstHover.persisted).toBe(true)

        const firstClick = await first.click({
            selector: '#submit-btn',
            description: 'cached submit click',
        })
        expect(firstClick.persisted).toBe(true)

        await gotoRoute(page, '/forms')

        const second = Oversteer.from(page, {
            name: 'action-cache-replay',
            storage: { rootDir },
        })

        const secondInput = await second.input({
            text: 'Bob Cache',
            description: 'cached full name input',
        })
        expect(secondInput.persisted).toBe(false)

        const secondSelect = await second.select({
            value: 'enterprise',
            description: 'cached plan select',
        })
        expect(secondSelect.persisted).toBe(false)

        const secondHover = await second.hover({
            description: 'cached submit hover',
        })
        expect(secondHover.persisted).toBe(false)

        const secondClick = await second.click({
            description: 'cached submit click',
        })
        expect(secondClick.persisted).toBe(false)

        const nameValue = await page
            .locator('#full-name')
            .evaluate((el) => (el as HTMLInputElement).value)
        expect(nameValue).toBe('Bob Cache')

        const planValue = await page
            .locator('#plan-select')
            .evaluate((el) => (el as HTMLSelectElement).value)
        expect(planValue).toBe('enterprise')
    })

    it('replays cached scroll target path without AI', async () => {
        await gotoRoute(page, '/scroll')

        const first = Oversteer.from(page, {
            name: 'action-cache-replay-scroll',
            storage: { rootDir },
        })

        const firstScroll = await first.scroll({
            selector: '#inner-vertical',
            direction: 'down',
            amount: 200,
            description: 'cached inner vertical scroll',
        })
        expect(firstScroll.persisted).toBe(true)

        await page.locator('#inner-vertical').evaluate((el) => {
            ;(el as HTMLElement).scrollTop = 0
        })

        const second = Oversteer.from(page, {
            name: 'action-cache-replay-scroll',
            storage: { rootDir },
        })

        const secondScroll = await second.scroll({
            direction: 'down',
            amount: 200,
            description: 'cached inner vertical scroll',
        })
        expect(secondScroll.persisted).toBe(false)

        const scrollTop = await page
            .locator('#inner-vertical')
            .evaluate((el) => (el as HTMLElement).scrollTop)
        expect(scrollTop).toBeGreaterThan(0)
    })
})
