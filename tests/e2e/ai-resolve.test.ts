import fs from 'fs'
import os from 'os'
import path from 'path'
import {
    afterAll,
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Opensteer } from '../../src/opensteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { gotoRoute } from '../helpers/integration.js'

describe('e2e/ai-resolve', () => {
    let context: BrowserContext
    let page: Page
    let rootDir: string

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opensteer-ai-e2e-'))
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it(
        'resolves uncached actions via AI and persists descriptors',
        async () => {
            await gotoRoute(page, '/forms')

            const opensteer = Opensteer.from(page, {
                name: 'ai-e2e',
                model: 'gpt-5-mini',
                storage: { rootDir },
            })

            // Fill in form fields with selectors (cached normally)
            await opensteer.input({
                selector: '#full-name',
                text: 'Ada Lovelace',
                description: 'The full name text input',
            })
            await opensteer.input({
                selector: '#email-input',
                text: 'ada@example.com',
                description: 'The email address input field',
            })

            // AI resolve: no selector, no element, only description
            const result = await opensteer.click({
                description: 'The submit profile button',
            })

            expect(result.persisted).toBe(true)

            // Verify descriptor file exists on disk
            const namespaceDir = path.join(
                rootDir,
                '.opensteer',
                'selectors',
                'ai-e2e'
            )
            const registry = JSON.parse(
                fs.readFileSync(path.join(namespaceDir, 'index.json'), 'utf8')
            ) as { selectors: Record<string, { description?: string }> }
            const descriptions = Object.values(registry.selectors).map(
                (s) => s.description
            )
            expect(descriptions).toContain('The submit profile button')

            // Verify the click worked by checking preview text appeared
            const previewName = await page.$eval(
                '#preview-name',
                (el) => el.textContent
            )
            expect(previewName).toContain('Ada Lovelace')

            await opensteer.close()
        },
        { timeout: 60_000 }
    )

    it(
        'replays cached descriptors without AI calls on second run',
        async () => {
            await gotoRoute(page, '/forms')

            // First run: populate the cache
            const opensteer1 = Opensteer.from(page, {
                name: 'ai-e2e-replay',
                model: 'gpt-5-mini',
                storage: { rootDir },
            })

            await opensteer1.input({
                selector: '#full-name',
                text: 'Alan Turing',
                description: 'The full name text input',
            })
            await opensteer1.input({
                selector: '#email-input',
                text: 'alan@example.com',
                description: 'The email address input field',
            })

            const firstResult = await opensteer1.click({
                description: 'The submit profile button',
            })
            expect(firstResult.persisted).toBe(true)
            await opensteer1.close()

            // Reload the page for a fresh second run
            await gotoRoute(page, '/forms')

            // Second run: reuse the same rootDir, descriptors should be cached
            const opensteer2 = Opensteer.from(page, {
                name: 'ai-e2e-replay',
                model: 'gpt-5-mini',
                storage: { rootDir },
            })
            const snapshotSpy = vi.spyOn(opensteer2, 'snapshot')

            // Fill form fields again
            await opensteer2.input({
                text: 'Alan Turing',
                description: 'The full name text input',
            })
            await opensteer2.input({
                text: 'alan@example.com',
                description: 'The email address input field',
            })

            const secondResult = await opensteer2.click({
                description: 'The submit profile button',
            })

            // AI resolve should not be needed when replaying from cached paths.
            expect(snapshotSpy).toHaveBeenCalledTimes(0)
            // Already existed, no re-persist
            expect(secondResult.persisted).toBe(false)

            // Verify click still works
            const previewName = await page.$eval(
                '#preview-name',
                (el) => el.textContent
            )
            expect(previewName).toContain('Alan Turing')

            await opensteer2.close()
        },
        { timeout: 60_000 }
    )

    it(
        'resolves uncached extraction via AI',
        async () => {
            await gotoRoute(page, '/data')

            const opensteer = Opensteer.from(page, {
                name: 'ai-e2e-extract',
                model: 'gpt-5-mini',
                storage: { rootDir },
            })

            const data = await opensteer.extract<{ region: string }>({
                description: 'Extract the first region card name',
                schema: { region: 'string' },
            })

            expect(data.region).toBe('North Region')

            // Verify descriptor was persisted
            const namespaceDir = path.join(
                rootDir,
                '.opensteer',
                'selectors',
                'ai-e2e-extract'
            )
            const registry = JSON.parse(
                fs.readFileSync(path.join(namespaceDir, 'index.json'), 'utf8')
            ) as { selectors: Record<string, { description?: string }> }
            const descriptions = Object.values(registry.selectors).map(
                (s) => s.description
            )
            expect(descriptions).toContain('Extract the first region card name')

            await opensteer.close()
        },
        { timeout: 60_000 }
    )
})
