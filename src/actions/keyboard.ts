import type { Page } from 'playwright'

export async function pressKey(page: Page, key: string): Promise<void> {
    await page.keyboard.press(key)
}

export async function typeText(page: Page, text: string): Promise<void> {
    await page.keyboard.type(text)
}
