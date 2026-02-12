import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { markInteractiveElements } from '../../src/html/interactivity.js'
import { prepareSnapshot } from '../../src/html/pipeline.js'
import { performClick } from '../../src/actions/click.js'
import { performInput } from '../../src/actions/input.js'
import { performSelect } from '../../src/actions/select.js'
import { buildElementPathFromSelector } from '../../src/element-path/build.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import {
    getHiddenIds,
    getInteractiveIds,
    gotoRoute,
} from '../helpers/integration.js'

describe('integration/forms', () => {
    let context: BrowserContext
    let page: Page

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        await gotoRoute(page, '/forms')
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it('marks expected controls as interactive', async () => {
        await markInteractiveElements(page)

        const interactive = await getInteractiveIds(page)
        expect(interactive).toContain('full-name')
        expect(interactive).toContain('email-input')
        expect(interactive).toContain('plan-select')
        expect(interactive).toContain('submit-btn')
        expect(interactive).toContain('editable-note')

        const hidden = await getHiddenIds(page)
        expect(hidden).not.toContain('submit-btn')
    })

    it('produces action snapshots suitable for planning', async () => {
        const snapshot = await prepareSnapshot(page, { mode: 'action' })

        expect(snapshot.cleanedHtml).toContain('Submit profile')
        expect(snapshot.cleanedHtml).toContain('c="')
        expect(snapshot.cleanedHtml).not.toContain('<script')
    })

    it('executes input/select/click actions against realistic form controls', async () => {
        const fullNameDescriptor = await buildElementPathFromSelector(
            page,
            '#full-name'
        )
        const emailDescriptor = await buildElementPathFromSelector(
            page,
            '#email-input'
        )
        const planDescriptor = await buildElementPathFromSelector(
            page,
            '#plan-select'
        )
        const submitDescriptor = await buildElementPathFromSelector(
            page,
            '#submit-btn'
        )

        const inputResult = await performInput(page, fullNameDescriptor!, {
            text: 'Ada Lovelace',
        })
        const emailResult = await performInput(page, emailDescriptor!, {
            text: 'ada@example.com',
        })
        const selectResult = await performSelect(page, planDescriptor!, {
            value: 'enterprise',
        })

        expect(inputResult.ok).toBe(true)
        expect(emailResult.ok).toBe(true)
        expect(selectResult.ok).toBe(true)

        const clickResult = await performClick(page, submitDescriptor!, {
            button: 'left',
            clickCount: 1,
        })
        expect(clickResult.ok).toBe(true)

        expect((await page.textContent('#preview-name'))?.trim()).toBe(
            'Ada Lovelace'
        )
        expect((await page.textContent('#preview-email'))?.trim()).toBe(
            'ada@example.com'
        )
        expect(await page.inputValue('#plan-select')).toBe('enterprise')
    })
})
