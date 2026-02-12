import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { markInteractiveElements } from '../../src/html/interactivity.js'
import { performClick } from '../../src/actions/click.js'
import { performInput } from '../../src/actions/input.js'
import { buildElementPathFromSelector } from '../../src/element-path/build.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { getInteractiveIds, gotoRoute } from '../helpers/integration.js'

describe('integration/custom-widgets', () => {
    let context: BrowserContext
    let page: Page

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        await gotoRoute(page, '/widgets')
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it('marks custom widget entry points as interactive', async () => {
        await markInteractiveElements(page)
        const interactive = await getInteractiveIds(page)

        expect(interactive).toContain('custom-dropdown')
        expect(interactive).toContain('role-button-div')
        expect(interactive).toContain('anchor-no-href')
        expect(interactive).toContain('range-slider')
    })

    it('interacts with role-button and search widget', async () => {
        const roleButton = await buildElementPathFromSelector(
            page,
            '#role-button-div'
        )
        const searchInput = await buildElementPathFromSelector(
            page,
            '#custom-search-input'
        )

        expect(
            (
                await performClick(page, roleButton!, {
                    button: 'left',
                    clickCount: 1,
                })
            ).ok
        ).toBe(true)
        expect(
            (await performInput(page, searchInput!, { text: 'dashboards' })).ok
        ).toBe(true)

        expect((await page.textContent('#role-button-count'))?.trim()).toBe('1')
        expect(await page.inputValue('#custom-search-input')).toBe('dashboards')
    })

    it('opens custom dropdown and selects an option', async () => {
        const trigger = await buildElementPathFromSelector(
            page,
            '#custom-dropdown'
        )
        expect(
            (
                await performClick(page, trigger!, {
                    button: 'left',
                    clickCount: 1,
                })
            ).ok
        ).toBe(true)

        const option = await buildElementPathFromSelector(
            page,
            '#custom-dropdown-option-beta'
        )
        expect(
            (
                await performClick(page, option!, {
                    button: 'left',
                    clickCount: 1,
                })
            ).ok
        ).toBe(true)

        expect(
            (await page.textContent('#custom-dropdown'))?.includes(
                'Beta Workspace'
            )
        ).toBe(true)
    })
})
