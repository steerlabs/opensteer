import {
    chromium,
    type Browser,
    type BrowserContext,
    type Page,
} from 'playwright'
import type { LaunchOptions, OpensteerBrowserConfig } from '../types.js'

export interface BrowserSession {
    browser: Browser
    context: BrowserContext
    page: Page
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

        return {
            browser,
            context,
            page,
        }
    }

    async close(): Promise<void> {
        if (!this.browser) return

        await this.browser.close()
        this.browser = null
    }
}
