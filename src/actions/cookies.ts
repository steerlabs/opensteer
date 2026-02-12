import { readFile, writeFile } from 'fs/promises'
import type { BrowserContext, Cookie } from 'playwright'
import type { CookieParam } from '../types.js'

export async function getCookies(context: BrowserContext, url?: string): Promise<Cookie[]> {
    return context.cookies(url ? [url] : undefined)
}

export async function setCookie(context: BrowserContext, cookie: CookieParam): Promise<void> {
    await context.addCookies([cookie])
}

export async function clearCookies(context: BrowserContext): Promise<void> {
    await context.clearCookies()
}

export async function exportCookies(context: BrowserContext, filePath: string, url?: string): Promise<void> {
    const cookies = await context.cookies(url ? [url] : undefined)
    await writeFile(filePath, JSON.stringify(cookies, null, 2), 'utf-8')
}

export async function importCookies(context: BrowserContext, filePath: string): Promise<void> {
    const raw = await readFile(filePath, 'utf-8')
    const cookies = JSON.parse(raw) as CookieParam[]
    await context.addCookies(cookies)
}
