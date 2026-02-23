import * as cheerio from 'cheerio'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { prepareSnapshot } from '../../src/html/pipeline.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { gotoRoute } from '../helpers/integration.js'
import { setFixture } from '../helpers/fixture.js'

describe('integration/snapshot-modes', () => {
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

    it('generates action, extraction, and full snapshots for form pages', async () => {
        await gotoRoute(page, '/forms')

        const action = await prepareSnapshot(page, { mode: 'action' })
        const extraction = await prepareSnapshot(page, { mode: 'extraction' })
        const full = await prepareSnapshot(page, { mode: 'full' })

        expect(action.cleanedHtml).toContain('Submit profile')
        expect(action.cleanedHtml).not.toContain('<script')
        expect(extraction.cleanedHtml).toContain('Full name')
        expect(extraction.cleanedHtml).toContain('Email address')
        expect(full.cleanedHtml).toContain('forms-page-form')
        expect(full.cleanedHtml.length).toBeGreaterThan(
            action.cleanedHtml.length
        )
    })

    it('generates clickable snapshots that prioritize actionable controls', async () => {
        await gotoRoute(page, '/navigation')

        const clickable = await prepareSnapshot(page, { mode: 'clickable' })

        expect(clickable.cleanedHtml).toContain('Workflow Runner')
        expect(clickable.cleanedHtml).toContain('Overview')
    })

    it('supports counterless snapshots for raw output modes', async () => {
        await gotoRoute(page, '/data')

        const snapshot = await prepareSnapshot(page, {
            mode: 'action',
            withCounters: false,
            markInteractive: true,
        })

        expect(snapshot.cleanedHtml).toContain('Aurora Lamp')
        expect(snapshot.cleanedHtml).not.toContain(' c="')
    })

    it('assigns compact counters only for retained output nodes in each mode', async () => {
        const fixture = `
            <main id="root">
                <button id="cta">Run</button>
                <input id="search" value="query" />
                <a id="primary-link" href="#next">Open details</a>
                <div id="scroll-wrap" style="max-height: 48px; overflow: auto;">
                    <div style="height: 240px;">
                        <p id="long-content">Long content block</p>
                    </div>
                </div>
            </main>
        `

        const modes = [
            'action',
            'extraction',
            'clickable',
            'scrollable',
            'full',
        ] as const

        for (const mode of modes) {
            await setFixture(page, fixture)
            const snapshot = await prepareSnapshot(page, {
                mode,
                withCounters: true,
                markInteractive: true,
            })
            const $$ = cheerio.load(snapshot.cleanedHtml)

            const counters = new Set<number>()
            $$('[c]').each((_idx, element) => {
                const value = Number.parseInt($$(element).attr('c') || '', 10)
                if (Number.isFinite(value)) {
                    counters.add(value)
                }
            })

            const sortedCounters = [...counters].sort((a, b) => a - b)
            expect(sortedCounters.length).toBeGreaterThan(0)
            const firstCounter = sortedCounters[0]
            expect(firstCounter).toBeGreaterThan(0)
            sortedCounters.forEach((value, index) => {
                expect(value).toBe(firstCounter + index)
            })

            const bindingKeys = [
                ...(snapshot.counterBindings?.keys() || []),
            ].sort((a, b) => a - b)
            const indexKeys = [...(snapshot.counterIndex?.keys() || [])].sort(
                (a, b) => a - b
            )

            expect(bindingKeys).toEqual(sortedCounters)
            expect(indexKeys).toEqual(sortedCounters)
            expect(snapshot.cleanedHtml).not.toContain('data-os-node-id')
        }
    })
})
