import * as cheerio from 'cheerio'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { markInteractiveElements } from '../../src/html/interactivity.js'
import { prepareSnapshot } from '../../src/html/pipeline.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import {
    getHiddenIds,
    getInteractiveIds,
    gotoRoute,
} from '../helpers/integration.js'

describe('integration/visibility', () => {
    let context: BrowserContext
    let page: Page

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        await gotoRoute(page, '/visibility')
        await markInteractiveElements(page)
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it('marks known hidden patterns as hidden', async () => {
        const hidden = await getHiddenIds(page)

        expect(hidden).toContain('opacity-zero-btn')
        expect(hidden).toContain('display-none-btn')
        expect(hidden).toContain('visibility-hidden-btn')
        expect(hidden).toContain('scaled-zero-btn')
    })

    it('keeps visible controls interactive', async () => {
        const interactive = await getInteractiveIds(page)

        expect(interactive).toContain('visible-btn')
        expect(interactive).toContain('display-contents-btn')
        expect(interactive).toContain('behind-overlay-btn')
    })

    it('keeps action-mode controls nested under display-contents wrappers', async () => {
        const snapshot = await prepareSnapshot(page, { mode: 'action' })
        const $ = cheerio.load(snapshot.cleanedHtml)
        const displayContentsButton = $('button').filter((_, el) => {
            return $(el).text().trim() === 'Display contents child'
        })

        expect(displayContentsButton.length).toBe(1)
        expect(displayContentsButton.attr('c')).toBeTruthy()
    })

    describe('current behavior (pinned)', () => {
        it('still marks disabled and pointer-events-none buttons as interactive', async () => {
            const interactive = await getInteractiveIds(page)

            // Current interactivity checks are tag/role/cursor driven and do not gate on disabled/pointer-events.
            expect(interactive).toContain('disabled-edge-btn')
            expect(interactive).toContain('pointer-events-none-btn')
        })

        it('does not treat off-screen and clipped elements as hidden', async () => {
            const hidden = await getHiddenIds(page)

            // Current hidden checks are based on display/visibility/opacity/rect size and do not detect off-viewport clipping.
            expect(hidden).not.toContain('offscreen-btn')
            expect(hidden).not.toContain('clipped-btn')
        })
    })
})
