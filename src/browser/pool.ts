import {
    chromium,
    type Browser,
    type BrowserContext,
    type Page,
} from 'playwright'
import type { LaunchOptions, OpensteerBrowserConfig } from '../types.js'
import { CDPProxy, discoverTargets } from './cdp-proxy.js'
import { expandHome } from './chrome.js'

export interface BrowserSession {
    browser: Browser
    context: BrowserContext
    page: Page
    /** True when connected to an external browser. close() disconnects without killing it. */
    isRemote: boolean
}

export class BrowserPool {
    private browser: Browser | null = null
    private cdpProxy: CDPProxy | null = null
    private readonly defaults: OpensteerBrowserConfig

    constructor(defaults: OpensteerBrowserConfig = {}) {
        this.defaults = defaults
    }

    async launch(options: LaunchOptions = {}): Promise<BrowserSession> {
        if (this.browser || this.cdpProxy) {
            await this.close()
        }

        const connectUrl = options.connectUrl ?? this.defaults.connectUrl
        const channel = options.channel ?? this.defaults.channel
        const profileDir = options.profileDir ?? this.defaults.profileDir

        // ── Connect mode: attach to a running browser ──
        if (connectUrl) {
            return this.connectToRunning(connectUrl, options.timeout)
        }

        // ── Profile mode: launch with user profile ──
        if (channel || profileDir) {
            return this.launchWithProfile(options, channel, profileDir)
        }

        // ── Sandbox mode: fresh Chromium (existing behavior) ──
        return this.launchSandbox(options)
    }

    async close(): Promise<void> {
        const browser = this.browser
        this.browser = null

        try {
            if (browser) {
                await browser.close()
            }
        } finally {
            this.cdpProxy?.close()
            this.cdpProxy = null
        }
    }

    private async connectToRunning(connectUrl: string, timeout?: number): Promise<BrowserSession> {
        this.cdpProxy?.close()
        this.cdpProxy = null

        let browser: Browser | null = null

        try {
            const { browserWsUrl, targets } = await discoverTargets(connectUrl)

            if (targets.length === 0) {
                throw new Error(
                    'No page targets found. Is the browser running with an open window?'
                )
            }

            const target = targets[0]
            this.cdpProxy = new CDPProxy(browserWsUrl, target.id)
            const proxyWsUrl = await this.cdpProxy.start()

            browser = await chromium.connectOverCDP(proxyWsUrl, {
                timeout: timeout ?? 30_000,
            })
            this.browser = browser

            const contexts = browser.contexts()
            if (contexts.length === 0) {
                throw new Error(
                    'Connection succeeded but no browser contexts found. Is the browser running with an open window?'
                )
            }

            const context = contexts[0]
            const pages = context.pages()
            const page = pages.length > 0 ? pages[0] : await context.newPage()

            return { browser, context, page, isRemote: true }
        } catch (error) {
            if (browser) {
                await browser.close().catch(() => undefined)
            }
            this.browser = null
            this.cdpProxy?.close()
            this.cdpProxy = null
            throw error
        }
    }

    private async launchWithProfile(
        options: LaunchOptions,
        channel: string | undefined,
        profileDir: string | undefined
    ): Promise<BrowserSession> {
        const args: string[] = []
        if (profileDir) {
            args.push(`--user-data-dir=${expandHome(profileDir)}`)
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

        // When profileDir is set, Chrome creates a default context with the profile
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

        return { browser, context, page, isRemote: false }
    }

    private async launchSandbox(
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

        return { browser, context, page, isRemote: false }
    }
}
