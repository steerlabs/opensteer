import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BrowserContext, Page } from 'playwright'
import { Opensteer } from '../../src/opensteer.js'
import { closeTestBrowser, createTestPage } from '../helpers/browser.js'
import { setFixture } from '../helpers/fixture.js'

describe('screenshot()', () => {
    let context: BrowserContext
    let page: Page
    let opensteer: Opensteer

    beforeEach(async () => {
        ;({ context, page } = await createTestPage())
        opensteer = Opensteer.from(page)
        await setFixture(page, '<h1>Hello</h1>')
    })

    afterEach(async () => {
        await context.close()
    })

    afterAll(async () => {
        await closeTestBrowser()
    })

    it('returns a Buffer', async () => {
        const buffer = await opensteer.screenshot()
        expect(Buffer.isBuffer(buffer)).toBe(true)
        expect(buffer.length).toBeGreaterThan(0)
    })

    it('default format is PNG (magic bytes 0x89 0x50 0x4e 0x47)', async () => {
        const buffer = await opensteer.screenshot()
        expect(buffer[0]).toBe(0x89)
        expect(buffer[1]).toBe(0x50)
        expect(buffer[2]).toBe(0x4e)
        expect(buffer[3]).toBe(0x47)
    })

    it('type jpeg returns JPEG (magic bytes 0xff 0xd8)', async () => {
        const buffer = await opensteer.screenshot({ type: 'jpeg' })
        expect(buffer[0]).toBe(0xff)
        expect(buffer[1]).toBe(0xd8)
    })

    it('fullPage option is accepted without error', async () => {
        const buffer = await opensteer.screenshot({ fullPage: true })
        expect(Buffer.isBuffer(buffer)).toBe(true)
        expect(buffer.length).toBeGreaterThan(0)
    })
})
