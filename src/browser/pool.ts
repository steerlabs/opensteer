import {
    chromium,
    type Browser,
    type BrowserContext,
    type Page,
} from 'playwright'
import type { LaunchOptions, OpensteerBrowserConfig } from '../types.js'
import { expandHome } from './chrome.js'

export interface BrowserSession {
    browser: Browser
    context: BrowserContext
    page: Page
    /** True when connected to an external browser via CDP. close() disconnects without killing it. */
    connectedViaCDP: boolean
}

export class BrowserPool {
    private browser: Browser | null = null
    private readonly defaults: OpensteerBrowserConfig

    constructor(defaults: OpensteerBrowserConfig = {}) {
        this.defaults = defaults
    }

    async launch(options: LaunchOptions = {}): Promise<BrowserSession> {
        if (this.browser) {
            await this.browser.close()
            this.browser = null
        }

        const cdpUrl = options.cdpUrl ?? this.defaults.cdpUrl
        const channel = options.channel ?? this.defaults.channel
        const userDataDir = options.userDataDir ?? this.defaults.userDataDir

        // ── CDP mode: connect to a running Chrome ──
        if (cdpUrl) {
            return this.connectOverCDP(cdpUrl, options.timeout)
        }

        // ── Real Chrome mode: launch with user profile ──
        if (channel || userDataDir) {
            return this.launchRealBrowser(options, channel, userDataDir)
        }

        // ── Default: fresh Chromium (existing behavior) ──
        return this.launchFreshBrowser(options)
    }

    async close(): Promise<void> {
        if (!this.browser) return

        await this.browser.close()
        this.browser = null
    }

    private async connectOverCDP(cdpUrl: string, timeout?: number): Promise<BrowserSession> {
        const browser = await chromium.connectOverCDP(cdpUrl, {
            timeout: timeout ?? 30_000,
        })
        this.browser = browser

        const contexts = browser.contexts()
        if (contexts.length === 0) {
            throw new Error(
                'CDP connection succeeded but no browser contexts found. Is Chrome running with an open window?'
            )
        }

        const context = contexts[0]
        const pages = context.pages()
        const page = pages.length > 0 ? pages[0] : await context.newPage()

        return { browser, context, page, connectedViaCDP: true }
    }

    private async launchRealBrowser(
        options: LaunchOptions,
        channel: string | undefined,
        userDataDir: string | undefined
    ): Promise<BrowserSession> {
        const args: string[] = []
        if (userDataDir) {
            args.push(`--user-data-dir=${expandHome(userDataDir)}`)
        }

        const browser = await chromium.launch({
            channel: channel as
                | 'chrome'
                | 'chrome-beta'
                | 'msedge'
                | undefined,
            headless: options.headless ?? this.defaults.headless,
            executablePath:
                options.executablePath ??
                this.defaults.executablePath ??
                undefined,
            slowMo: options.slowMo ?? this.defaults.slowMo ?? 0,
            args,
        })

        this.browser = browser

        // When userDataDir is set, Chrome creates a default context with the profile
        const contexts = browser.contexts()
        let context: BrowserContext
        let page: Page

        if (contexts.length > 0) {
            context = contexts[0]
            const pages = context.pages()
            page = pages.length > 0 ? pages[0] : await context.newPage()
        } else {
            context = await browser.newContext(options.context || {})
            page = await context.newPage()
        }

        return { browser, context, page, connectedViaCDP: false }
    }

    private async launchFreshBrowser(
        options: LaunchOptions
    ): Promise<BrowserSession> {
        const browser = await chromium.launch({
            headless: options.headless ?? this.defaults.headless,
            executablePath:
                options.executablePath ??
                this.defaults.executablePath ??
                undefined,
            slowMo: options.slowMo ?? this.defaults.slowMo ?? 0,
        })

        const context = await browser.newContext(options.context || {})
        const page = await context.newPage()

        this.browser = browser

        return { browser, context, page, connectedViaCDP: false }
    }
}
