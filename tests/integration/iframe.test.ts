import * as cheerio from 'cheerio'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { cloneElementPath } from '../../src/element-path/build.js'
import type { ElementPath } from '../../src/element-path/types.js'
import { prepareSnapshot } from '../../src/html/pipeline.js'
import { performClick } from '../../src/actions/click.js'
import { performInput } from '../../src/actions/input.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { gotoRoute } from '../helpers/integration.js'

describe('integration/iframe', () => {
    let context: BrowserContext
    let page: Page

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        await gotoRoute(page, '/iframe')
        await page.waitForSelector('#named-iframe', { state: 'visible' })
        await page.waitForSelector('#anonymous-iframe', { state: 'visible' })
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it('resolves strict paths in the named iframe', async () => {
        const inputPath = await buildPathFromSnapshotSelector(
            page,
            '#named-iframe + ov-iframe-root #iframe-input'
        )
        const submitPath = await buildPathFromSnapshotSelector(
            page,
            '#named-iframe + ov-iframe-root #iframe-submit-btn'
        )

        expect(
            (await performInput(page, inputPath, { text: 'Named value' })).ok
        ).toBe(true)
        expect(
            (
                await performClick(page, submitPath, {
                    button: 'left',
                    clickCount: 1,
                })
            ).ok
        ).toBe(true)

        const frame = page.frame({ name: 'supportFrame' })
        expect(frame).toBeTruthy()
        await frame!.waitForSelector('#iframe-output', { state: 'visible' })
        expect((await frame!.textContent('#iframe-output'))?.trim()).toBe(
            'Saved: Named value'
        )
    })

    it('resolves strict paths in the anonymous iframe', async () => {
        const inputPath = await buildPathFromSnapshotSelector(
            page,
            '#anonymous-iframe + ov-iframe-root #iframe-input'
        )
        const submitPath = await buildPathFromSnapshotSelector(
            page,
            '#anonymous-iframe + ov-iframe-root #iframe-submit-btn'
        )

        expect(
            (await performInput(page, inputPath, { text: 'Anon value' })).ok
        ).toBe(true)
        expect(
            (
                await performClick(page, submitPath, {
                    button: 'left',
                    clickCount: 1,
                })
            ).ok
        ).toBe(true)

        const frames = page
            .frames()
            .filter((frame) => frame !== page.mainFrame())
        const anonymousFrame = frames[1]
        expect(anonymousFrame).toBeTruthy()
        await anonymousFrame.waitForSelector('#iframe-output', {
            state: 'visible',
        })
        expect(
            (await anonymousFrame.textContent('#iframe-output'))?.trim()
        ).toBe('Saved: Anon value')
    })

    it('does not cross-frame fallback when iframe context is removed', async () => {
        const inputPath = await buildPathFromSnapshotSelector(
            page,
            '#named-iframe + ov-iframe-root #iframe-input'
        )
        const noContextPath: ElementPath = {
            ...inputPath,
            context: [],
        }

        const result = await performInput(page, noContextPath, {
            text: 'Should fail',
        })

        expect(result.ok).toBe(false)
        expect(result.error).toContain('ERR_PATH_TARGET_NOT_FOUND')
    })
})

async function buildPathFromSnapshotSelector(
    page: Page,
    selector: string
): Promise<ElementPath> {
    const snapshot = await prepareSnapshot(page, {
        mode: 'full',
        withCounters: true,
        markInteractive: true,
    })

    const $$ = cheerio.load(snapshot.cleanedHtml)
    const value = $$(selector).first().attr('c')
    const counter = Number.parseInt(value || '', 10)
    if (!Number.isFinite(counter)) {
        throw new Error(`No counter found for selector: ${selector}`)
    }

    const path = snapshot.counterIndex?.get(counter)
    if (!path) {
        throw new Error(`No ElementPath found for selector: ${selector}`)
    }

    return cloneElementPath(path)
}
