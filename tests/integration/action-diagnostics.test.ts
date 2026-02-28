import * as cheerio from 'cheerio'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Opensteer } from '../../src/opensteer.js'
import { OpensteerActionError } from '../../src/actions/errors.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('integration/action-diagnostics', () => {
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

    it('throws OpensteerActionError with BLOCKED_BY_INTERCEPTOR for blocked clicks', async () => {
        await setFixture(
            page,
            `
        <style>
          #target {
            position: absolute;
            top: 20px;
            left: 20px;
            width: 140px;
            height: 40px;
          }
          #overlay {
            position: absolute;
            inset: 0;
            pointer-events: auto;
          }
        </style>
        <button id="target">Blocked target</button>
        <div id="overlay"></div>
      `
        )

        page.setDefaultTimeout(1200)
        const opensteer = Opensteer.from(page, { name: 'action-diagnostics-blocked' })

        try {
            await opensteer.click({ selector: '#target', description: 'blocked target' })
            throw new Error('Expected click to fail.')
        } catch (err) {
            expect(err).toBeInstanceOf(OpensteerActionError)
            const actionError = err as OpensteerActionError
            expect(actionError.failure.code).toBe('BLOCKED_BY_INTERCEPTOR')
            expect(actionError.failure.classificationSource).not.toBe('unknown')
        }
    })

    it('throws OpensteerActionError with TARGET_NOT_FOUND for missing counters', async () => {
        await setFixture(
            page,
            `
        <button id="save" onclick="document.querySelector('#status').textContent='clicked'">Save</button>
        <p id="status">idle</p>
      `
        )

        const opensteer = Opensteer.from(page, { name: 'action-diagnostics-stale' })
        const html = await opensteer.snapshot({ mode: 'full', withCounters: true })
        const $ = cheerio.load(html)
        const counter = Number.parseInt($('#save').attr('c') || '', 10)
        expect(Number.isFinite(counter)).toBe(true)

        await page.evaluate(() => {
            const oldNode = document.querySelector('#save')
            if (!oldNode) return
            const replacement = document.createElement('button')
            replacement.id = 'save'
            replacement.textContent = 'Save'
            replacement.setAttribute(
                'onclick',
                "document.querySelector('#status').textContent='clicked'"
            )
            oldNode.replaceWith(replacement)
        })

        try {
            await opensteer.click({ element: counter, button: 'left', clickCount: 1 })
            throw new Error('Expected click to fail.')
        } catch (err) {
            expect(err).toBeInstanceOf(OpensteerActionError)
            const actionError = err as OpensteerActionError
            expect(actionError.failure.code).toBe('TARGET_NOT_FOUND')
            expect(actionError.message).toContain('not found')
        }
    })
})
