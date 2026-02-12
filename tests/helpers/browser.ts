import {
    chromium,
    type Browser,
    type BrowserContext,
    type Page,
} from 'playwright'

let browser: Browser | null = null

export async function getTestBrowser(): Promise<Browser> {
    if (!browser) {
        const headless = process.env.HEADED !== '1'
        const slowMo = Number(process.env.SLOW_MO) || 0
        browser = await chromium.launch({ headless, slowMo })
    }

    return browser
}

export async function createTestPage(): Promise<{
    context: BrowserContext
    page: Page
}> {
    const activeBrowser = await getTestBrowser()
    const context = await activeBrowser.newContext()
    const page = await context.newPage()
    return { context, page }
}

export async function closeTestBrowser(): Promise<void> {
    if (!browser) return
    await browser.close()
    browser = null
}
