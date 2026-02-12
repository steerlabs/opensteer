import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Oversteer } from '../../src/oversteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { gotoRoute } from '../helpers/integration.js'

/**
 * AI-resolved actions targeting elements inside iframes.
 * Every action uses `description` only -- no selectors, no counters.
 */
describe('e2e/iframe-actions', () => {
    let context: BrowserContext
    let page: Page
    let rootDir: string

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-iframe-e2e-'))
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it(
        'fills and submits inside the named iframe',
        async () => {
            await gotoRoute(page, '/iframe')
            await page.waitForSelector('#named-iframe', { state: 'visible' })
            await page.waitForSelector('#anonymous-iframe', {
                state: 'visible',
            })

            const ov = Oversteer.from(page, {
                name: 'iframe-named',
                ai: { model: 'gpt-5-mini' },
                storage: { rootDir },
            })

            await ov.input({
                description:
                    'The text input inside the Named Support Frame iframe',
                text: 'hello from named',
            })

            await ov.click({
                description:
                    'The Save value button inside the Named Support Frame iframe',
            })

            const frame = page.frame({ name: 'supportFrame' })
            expect(frame).toBeTruthy()
            await frame!.waitForSelector('#iframe-output', {
                state: 'visible',
            })
            expect((await frame!.textContent('#iframe-output'))?.trim()).toBe(
                'Saved: hello from named'
            )

            await ov.close()
        },
        { timeout: 120_000 }
    )

    it(
        'fills and submits inside the anonymous iframe',
        async () => {
            await gotoRoute(page, '/iframe')
            await page.waitForSelector('#named-iframe', { state: 'visible' })
            await page.waitForSelector('#anonymous-iframe', {
                state: 'visible',
            })

            const ov = Oversteer.from(page, {
                name: 'iframe-anon',
                ai: { model: 'gpt-5-mini' },
                storage: { rootDir },
            })

            await ov.input({
                description: 'The text input inside the Anonymous Frame iframe',
                text: 'hello from anonymous',
            })

            await ov.click({
                description:
                    'The Save value button inside the Anonymous Frame iframe',
            })

            // Anonymous frame is the second child frame (DOM order)
            const frames = page.frames().filter((f) => f !== page.mainFrame())
            const anonymousFrame = frames[1]
            expect(anonymousFrame).toBeTruthy()
            await anonymousFrame.waitForSelector('#iframe-output', {
                state: 'visible',
            })
            expect(
                (await anonymousFrame.textContent('#iframe-output'))?.trim()
            ).toBe('Saved: hello from anonymous')

            await ov.close()
        },
        { timeout: 120_000 }
    )

    it(
        'extracts data from inside an iframe',
        async () => {
            await gotoRoute(page, '/iframe')
            await page.waitForSelector('#named-iframe', { state: 'visible' })
            await page.waitForSelector('#anonymous-iframe', {
                state: 'visible',
            })

            const ov = Oversteer.from(page, {
                name: 'iframe-extract',
                ai: { model: 'gpt-5-mini' },
                storage: { rootDir },
            })

            const data = await ov.extract<{ title: string }>({
                description:
                    'The frame title heading inside the Named Support Frame iframe',
                schema: { title: 'string' },
            })

            expect(data.title).toBe('Named Frame')

            const namespaceDir = path.join(
                rootDir,
                '.oversteer',
                'selectors',
                'iframe-extract'
            )
            const registry = JSON.parse(
                fs.readFileSync(path.join(namespaceDir, 'index.json'), 'utf8')
            ) as { selectors: Record<string, { description?: string }> }
            const descriptions = Object.values(registry.selectors).map(
                (s) => s.description
            )
            expect(descriptions).toContain(
                'The frame title heading inside the Named Support Frame iframe'
            )

            await ov.close()
        },
        { timeout: 120_000 }
    )
})
