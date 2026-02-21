import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { performSelect } from '../../src/actions/select.js'
import { buildElementPathFromSelector } from '../../src/element-path/build.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('performSelect', () => {
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

    it('selects option by value and label', async () => {
        await setFixture(
            page,
            `
        <select id="plan-select">
          <option value="starter">Starter</option>
          <option value="pro">Pro</option>
          <option value="enterprise">Enterprise</option>
        </select>
      `
        )

        const path = await buildElementPathFromSelector(page, '#plan-select')

        const byValue = await performSelect(page, path!, { value: 'pro' })
        expect(byValue.ok).toBe(true)
        expect(await page.inputValue('#plan-select')).toBe('pro')

        const byLabel = await performSelect(page, path!, {
            label: 'Enterprise',
        })
        expect(byLabel.ok).toBe(true)
        expect(await page.inputValue('#plan-select')).toBe('enterprise')
    })

    it('selects by index and validates required option payload', async () => {
        await setFixture(
            page,
            `
        <select id="priority-select">
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      `
        )

        const path = await buildElementPathFromSelector(
            page,
            '#priority-select'
        )

        const byIndex = await performSelect(page, path!, { index: 2 })
        expect(byIndex.ok).toBe(true)
        expect(await page.inputValue('#priority-select')).toBe('high')

        const invalid = await performSelect(page, path!, {})
        expect(invalid.ok).toBe(false)
        expect(invalid.error).toContain(
            'Select requires value, label, or index'
        )
        expect(invalid.failure?.code).toBe('INVALID_OPTIONS')
    })

    it('classifies non-select targets as INVALID_TARGET', async () => {
        await setFixture(page, '<input id="wrong-target" />')

        const path = await buildElementPathFromSelector(page, '#wrong-target')
        const result = await performSelect(page, path!, { value: 'x' })

        expect(result.ok).toBe(false)
        expect(result.failure?.code).toBe('INVALID_TARGET')
    })
})
