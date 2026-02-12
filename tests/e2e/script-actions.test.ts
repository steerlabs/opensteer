import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Oversteer } from '../../src/oversteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { gotoRoute } from '../helpers/integration.js'

/**
 * Runs sequential, script-like actions through the Oversteer class
 * where every action is resolved by an LLM via `description` only.
 *
 * No `selector`, no `element` counter -- the AI sees the page HTML
 * and picks the right element for each step.
 */
describe('e2e/script-actions', () => {
    let context: BrowserContext
    let page: Page
    let rootDir: string

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-script-e2e-'))
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it(
        'fills and submits a form using only AI-resolved descriptions',
        async () => {
            await gotoRoute(page, '/forms')

            const ov = Oversteer.from(page, {
                name: 'script-form',
                model: 'gpt-5-mini',
                storage: { rootDir },
            })

            await ov.input({
                description: 'The full name text input',
                text: 'Grace Hopper',
            })

            await ov.input({
                description: 'The email address input field',
                text: 'grace@example.com',
            })

            await ov.select({
                description: 'The plan selection dropdown',
                value: 'pro',
            })

            await ov.click({
                description: 'The submit profile button',
            })

            // Verify the form state reflected in the live preview
            expect((await page.textContent('#preview-name'))?.trim()).toBe(
                'Grace Hopper'
            )
            expect((await page.textContent('#preview-email'))?.trim()).toBe(
                'grace@example.com'
            )
            expect(await page.inputValue('#plan-select')).toBe('pro')

            // Extract via AI
            const data = await ov.extract<{ name: string; email: string }>({
                description:
                    'The preview section showing submitted name and email',
                schema: { name: 'string', email: 'string' },
            })

            expect(data.name).toContain('Grace Hopper')
            expect(data.email).toContain('grace@example.com')

            // All descriptors should have been persisted
            const namespaceDir = path.join(
                rootDir,
                '.oversteer',
                'selectors',
                'script-form'
            )
            const registry = JSON.parse(
                fs.readFileSync(path.join(namespaceDir, 'index.json'), 'utf8')
            ) as { selectors: Record<string, { description?: string }> }

            const descriptions = Object.values(registry.selectors).map(
                (s) => s.description
            )
            expect(descriptions).toEqual(
                expect.arrayContaining([
                    'The full name text input',
                    'The email address input field',
                    'The plan selection dropdown',
                    'The submit profile button',
                    'The preview section showing submitted name and email',
                ])
            )

            await ov.close()
        },
        { timeout: 120_000 }
    )

    it(
        'navigates across pages performing AI-resolved actions on each',
        async () => {
            await gotoRoute(page, '/navigation')

            const ov = Oversteer.from(page, {
                name: 'script-nav',
                model: 'gpt-5-mini',
                storage: { rootDir },
            })

            // Switch to Alerts tab
            await ov.click({
                description: 'The Alerts tab button',
            })
            expect(await page.textContent('#tab-panel')).toContain('Alert feed')

            // Expand accordion
            await ov.click({
                description:
                    'The accordion trigger for incident response playbook',
            })
            await page.waitForSelector('#accordion-panel', {
                state: 'visible',
            })
            expect(await page.textContent('#accordion-panel')).toContain(
                'Notify commander'
            )

            // Paginate forward
            await ov.click({
                description: 'The Next pagination button',
            })
            expect(
                (await page.textContent('#pagination-current'))?.trim()
            ).toBe('Page 3')

            // Cross-page: navigate to forms and fill via AI
            await gotoRoute(page, '/forms')

            await ov.input({
                description: 'The full name text input',
                text: 'Alan Turing',
            })
            await ov.input({
                description: 'The email address input field',
                text: 'alan@example.com',
            })
            await ov.click({
                description: 'The submit profile button',
            })

            expect((await page.textContent('#preview-name'))?.trim()).toBe(
                'Alan Turing'
            )
            expect((await page.textContent('#preview-email'))?.trim()).toBe(
                'alan@example.com'
            )

            await ov.close()
        },
        { timeout: 120_000 }
    )

    it(
        'dismisses overlays and triggers dynamic content via AI',
        async () => {
            await gotoRoute(page, '/overlays')

            const ov = Oversteer.from(page, {
                name: 'script-dynamic',
                model: 'gpt-5-mini',
                storage: { rootDir },
            })

            // Dismiss cookie banner
            await ov.click({
                description: 'The Accept button on the cookie banner',
            })
            await page.waitForSelector('#cookie-banner', {
                state: 'detached',
            })

            // Open modal
            await ov.click({
                description: 'The Open modal button',
            })
            await page.waitForSelector('#portal-modal', { state: 'visible' })

            // Confirm modal
            await ov.click({
                description: 'The Confirm button inside the modal dialog',
            })
            await page.waitForSelector('#portal-modal', {
                state: 'detached',
            })

            // Toggle dropdown menu
            await ov.click({
                description: 'The Toggle menu button',
            })
            await page.waitForSelector('#dropdown-menu', { state: 'visible' })
            expect(await page.textContent('#menu-edit')).toContain(
                'Edit profile'
            )

            // Navigate to dynamic page
            await gotoRoute(page, '/dynamic')

            // Wait for skeleton-to-content transition
            await page.waitForSelector('#loaded-content', {
                state: 'visible',
                timeout: 5_000,
            })

            // Trigger animated reveal
            await ov.click({
                description: 'The Reveal Panel button',
            })

            // Queue delayed update and wait for async content
            await ov.click({
                description: 'The Queue delayed update button',
            })
            await page.waitForSelector('#delayed-message', {
                state: 'visible',
                timeout: 5_000,
            })

            const timeline = await page.textContent('#timeline-summary')
            expect(timeline).toContain('Retry scheduled')
            expect(timeline).toContain('Worker resumed')

            await ov.close()
        },
        { timeout: 120_000 }
    )
})
