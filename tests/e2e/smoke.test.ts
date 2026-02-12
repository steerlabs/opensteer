import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as cheerio from 'cheerio'
import type { BrowserContext, Page } from 'playwright'
import { Oversteer } from '../../src/oversteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { gotoRoute } from '../helpers/integration.js'

describe('e2e/smoke', () => {
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

    it('runs the full Oversteer lifecycle end-to-end', async () => {
        const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-e2e-smoke-'))

        const ov = Oversteer.from(page, {
            name: 'e2e-smoke',
            storage: { rootDir },
        })

        const initialSnapshot = await ov.snapshot({ mode: 'action' })
        expect(initialSnapshot).toContain('Submit profile')

        const fullSnapshot = await ov.snapshot({
            mode: 'full',
            withCounters: true,
        })
        const $$ = cheerio.load(fullSnapshot)
        const fullNameCounter = Number.parseInt(
            $$('#full-name').attr('c') || '',
            10
        )
        expect(Number.isFinite(fullNameCounter)).toBe(true)

        const inputByCounter = await ov.input({
            element: fullNameCounter,
            text: 'Grace Hopper',
            description: 'The full name text input',
        })
        expect(inputByCounter.persisted).toBe(true)

        const inputBySelector = await ov.input({
            selector: '#email-input',
            text: 'grace@example.com',
            description: 'The email address input field',
        })
        expect(inputBySelector.persisted).toBe(true)

        const selectPlan = await ov.select({
            selector: '#plan-select',
            value: 'pro',
            description: 'The plan selection dropdown',
        })
        expect(selectPlan.persisted).toBe(true)

        const clickSubmit = await ov.click({
            selector: '#submit-btn',
            description: 'The submit profile button',
        })
        expect(clickSubmit.persisted).toBe(true)

        const reusedInput = await ov.input({
            text: 'Grace Brewster',
            description: 'The full name text input',
        })
        expect(reusedInput.persisted).toBe(false)

        const extracted = await ov.extract<{ name: string; email: string }>({
            description: 'Preview section with name and email',
            schema: {
                name: { type: 'string', selector: '#preview-name' },
                email: { type: 'string', selector: '#preview-email' },
            },
        })

        expect(extracted).toEqual({
            name: 'Grace Brewster',
            email: 'grace@example.com',
        })

        const state = await ov.state()
        expect(state.url).toContain('/forms')
        expect(state.html).toContain('Submit profile')

        const namespaceDir = path.join(
            rootDir,
            '.oversteer',
            'selectors',
            'e2e-smoke'
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
                'Preview section with name and email',
            ])
        )

        const jsonFiles = fs
            .readdirSync(namespaceDir)
            .filter((f) => f.endsWith('.json') && f !== 'index.json')
        expect(jsonFiles.length).toBe(5)

        await ov.close()
    })
})
