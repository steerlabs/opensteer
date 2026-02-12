import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { markInteractiveElements } from '../../src/html/interactivity.js'
import { performClick } from '../../src/actions/click.js'
import { performHover } from '../../src/actions/hover.js'
import { buildElementPathFromSelector } from '../../src/element-path/build.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { getInteractiveIds, gotoRoute } from '../helpers/integration.js'

describe('integration/overlays', () => {
    let context: BrowserContext
    let page: Page

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        await gotoRoute(page, '/overlays')
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it('marks key overlay controls as interactive', async () => {
        await markInteractiveElements(page)

        const interactive = await getInteractiveIds(page)
        expect(interactive).toContain('open-modal-btn')
        expect(interactive).toContain('open-drawer-btn')
        expect(interactive).toContain('show-toast-btn')
        expect(interactive).toContain('tooltip-target')
    })

    it('opens modal/drawer and dismisses cookie banner via action performers', async () => {
        const drawerButton = await buildElementPathFromSelector(
            page,
            '#open-drawer-btn'
        )

        expect(
            (
                await performClick(page, drawerButton!, {
                    button: 'left',
                    clickCount: 1,
                })
            ).ok
        ).toBe(true)
        await page.waitForSelector('#settings-drawer', { state: 'visible' })

        const acceptCookies = await buildElementPathFromSelector(
            page,
            '#accept-cookies-btn'
        )
        expect(
            (
                await performClick(page, acceptCookies!, {
                    button: 'left',
                    clickCount: 1,
                })
            ).ok
        ).toBe(true)
        expect(await page.locator('#cookie-banner').count()).toBe(0)

        const modalButton = await buildElementPathFromSelector(
            page,
            '#open-modal-btn'
        )
        expect(
            (
                await performClick(page, modalButton!, {
                    button: 'left',
                    clickCount: 1,
                })
            ).ok
        ).toBe(true)
        await page.waitForSelector('#portal-modal', { state: 'visible' })
    })

    it('shows tooltip through hover action', async () => {
        const descriptor = await buildElementPathFromSelector(
            page,
            '#tooltip-target'
        )
        const result = await performHover(page, descriptor!, {})

        expect(result.ok).toBe(true)
        await page.waitForSelector('#hover-tooltip', { state: 'visible' })
    })
})
