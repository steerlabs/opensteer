import type { BrowserContext, Page } from 'playwright'
import { waitForVisualStability } from '../navigation.js'
import type { GotoOptions, TabInfo } from '../types.js'

export async function listTabs(
    context: BrowserContext,
    activePage: Page
): Promise<TabInfo[]> {
    const pages = context.pages()
    const tabs: TabInfo[] = []

    for (let i = 0; i < pages.length; i++) {
        const page = pages[i]
        tabs.push({
            index: i,
            url: page.url(),
            title: await page.title(),
            active: page === activePage,
        })
    }

    return tabs
}

export async function createTab(
    context: BrowserContext,
    url?: string,
    gotoOptions?: GotoOptions
): Promise<{ page: Page; info: TabInfo }> {
    const page = await context.newPage()

    if (url) {
        const { waitUntil = 'domcontentloaded', ...rest } = gotoOptions ?? {}
        await page.goto(url, { waitUntil, timeout: rest.timeout })
        await waitForVisualStability(page, rest)
    }

    const index = context.pages().indexOf(page)
    const info: TabInfo = {
        index,
        url: page.url(),
        title: await page.title(),
        active: true,
    }

    return { page, info }
}

export async function switchTab(
    context: BrowserContext,
    index: number
): Promise<Page> {
    const pages = context.pages()

    if (index < 0 || index >= pages.length) {
        throw new Error(
            `Tab index ${index} out of range. ${pages.length} tab(s) open.`
        )
    }

    const page = pages[index]
    await page.bringToFront()
    return page
}

export async function closeTab(
    context: BrowserContext,
    activePage: Page,
    index?: number
): Promise<Page | null> {
    const pages = context.pages()

    const targetIndex = index ?? pages.indexOf(activePage)
    if (targetIndex < 0 || targetIndex >= pages.length) {
        throw new Error(
            `Tab index ${targetIndex} out of range. ${pages.length} tab(s) open.`
        )
    }

    const target = pages[targetIndex]
    await target.close()

    const remaining = context.pages()
    if (remaining.length === 0) return null

    // If we closed the active page, switch to the nearest tab
    if (target === activePage) {
        const newIndex = Math.min(targetIndex, remaining.length - 1)
        const newPage = remaining[newIndex]
        await newPage.bringToFront()
        return newPage
    }

    return activePage
}
