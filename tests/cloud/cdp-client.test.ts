import { afterEach, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { CloudCdpClient } from '../../src/cloud/cdp-client.js'
import { OpensteerCloudError } from '../../src/cloud/errors.js'

afterEach(() => {
    vi.restoreAllMocks()
})

describe('CloudCdpClient', () => {
    it('prefers a non-internal page when multiple pages exist', async () => {
        const newTabPage = {
            url: vi.fn(() => 'chrome://new-tab-page/'),
        } as unknown as Page
        const appPage = {
            url: vi.fn(() => 'https://www.amazon.com/'),
        } as unknown as Page

        const context = {
            pages: vi.fn(() => [newTabPage, appPage]),
            newPage: vi.fn(),
        } as unknown as BrowserContext

        const browser = {
            contexts: vi.fn(() => [context]),
            close: vi.fn(),
        } as unknown as Browser

        vi.spyOn(chromium, 'connectOverCDP').mockResolvedValue(browser)

        const client = new CloudCdpClient()
        const connection = await client.connect({
            wsUrl: 'wss://runtime.example/ws/cdp/sess_1',
            token: 'cdp_test_token',
        })

        expect(connection.context).toBe(context)
        expect(connection.page).toBe(appPage)
    })

    it('prefers about:blank over internal pages when no external page is available', async () => {
        const newTabPage = {
            url: vi.fn(() => 'chrome://new-tab-page/'),
        } as unknown as Page
        const blankPage = {
            url: vi.fn(() => 'about:blank'),
        } as unknown as Page

        const context = {
            pages: vi.fn(() => [newTabPage, blankPage]),
            newPage: vi.fn(),
        } as unknown as BrowserContext

        const browser = {
            contexts: vi.fn(() => [context]),
            close: vi.fn(),
        } as unknown as Browser

        vi.spyOn(chromium, 'connectOverCDP').mockResolvedValue(browser)

        const client = new CloudCdpClient()
        const connection = await client.connect({
            wsUrl: 'wss://runtime.example/ws/cdp/sess_2',
            token: 'cdp_test_token',
        })

        expect(connection.context).toBe(context)
        expect(connection.page).toBe(blankPage)
    })

    it('throws CLOUD_INTERNAL when no context is available', async () => {
        const close = vi.fn(async () => undefined)
        const browser = {
            contexts: vi.fn(() => []),
            close,
        } as unknown as Browser

        vi.spyOn(chromium, 'connectOverCDP').mockResolvedValue(browser)

        const client = new CloudCdpClient()

        await expect(
            client.connect({
                wsUrl: 'wss://runtime.example/ws/cdp/sess_3',
                token: 'cdp_test_token',
            })
        ).rejects.toMatchObject({
            code: 'CLOUD_INTERNAL',
        })

        expect(close).toHaveBeenCalledTimes(1)
    })
})
