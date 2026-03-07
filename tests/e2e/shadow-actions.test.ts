import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Opensteer } from '../../src/opensteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { gotoRoute } from '../helpers/integration.js'

const RUN_AI_E2E = process.env.RUN_AI_E2E === '1'

if (RUN_AI_E2E && !process.env.OPENAI_API_KEY?.trim()) {
    throw new Error(
        'RUN_AI_E2E=1 requires OPENAI_API_KEY for the AI e2e suite.'
    )
}

const describeAiE2E = RUN_AI_E2E ? describe : describe.skip

/**
 * AI-resolved actions targeting elements inside shadow DOM.
 * Every action uses `description` only -- no selectors, no counters.
 */
describeAiE2E('e2e/shadow-actions', () => {
    let context: BrowserContext
    let page: Page
    let rootDir: string

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-shadow-e2e-'))
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it(
        'clicks and types inside shadow roots',
        async () => {
            await gotoRoute(page, '/shadow')

            const opensteer = Opensteer.from(page, {
                name: 'shadow-basic',
                model: 'gpt-5-mini',
                storage: { rootDir },
            })

            await opensteer.click({
                description: 'The Shadow Action button',
            })

            expect(
                (await page.textContent('#shadow-click-output'))?.trim()
            ).toBe('clicked:shadow-button-host')

            await opensteer.input({
                description:
                    'The search input with placeholder Type inside shadow',
                text: 'dashboards',
            })

            expect(
                (await page.textContent('#shadow-input-output'))?.trim()
            ).toBe('dashboards')

            await opensteer.close()
        },
        { timeout: 120_000 }
    )

    it(
        'disambiguates between duplicate shadow hosts',
        async () => {
            await gotoRoute(page, '/shadow')

            const opensteer = Opensteer.from(page, {
                name: 'shadow-disambiguate',
                model: 'gpt-5-mini',
                storage: { rootDir },
            })

            await opensteer.click({
                description: 'The Open button on the Billing Console card',
            })

            expect(
                (await page.textContent('#shadow-card-output'))?.trim()
            ).toBe('card-2:Billing Console')

            await opensteer.close()
        },
        { timeout: 120_000 }
    )

    it(
        'extracts data from inside a shadow root',
        async () => {
            await gotoRoute(page, '/shadow')

            const opensteer = Opensteer.from(page, {
                name: 'shadow-extract',
                model: 'gpt-5-mini',
                storage: { rootDir },
            })

            const data = await opensteer.extract<{ title: string; status: string }>({
                description:
                    'The title and status of the Ops Dashboard shadow card',
                schema: { title: 'string', status: 'string' },
            })

            expect(data.title).toBe('Ops Dashboard')
            expect(data.status).toBe('Healthy')

            const namespaceDir = path.join(
                rootDir,
                '.opensteer',
                'selectors',
                'shadow-extract'
            )
            const registry = JSON.parse(
                fs.readFileSync(path.join(namespaceDir, 'index.json'), 'utf8')
            ) as { selectors: Record<string, { description?: string }> }
            const descriptions = Object.values(registry.selectors).map(
                (s) => s.description
            )
            expect(descriptions).toContain(
                'The title and status of the Ops Dashboard shadow card'
            )

            await opensteer.close()
        },
        { timeout: 120_000 }
    )
})
