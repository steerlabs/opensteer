import type { BrowserContext, Page } from 'playwright'

export async function applyStealthScripts(
    context: BrowserContext,
    page: Page
): Promise<void> {
    await context.addInitScript(installStealthPatches)
    await page.evaluate(installStealthPatches).catch(() => undefined)
}

function installStealthPatches(): void {
    const navigatorPrototype = Object.getPrototypeOf(navigator)

    if (navigator.webdriver === true) {
        try {
            Object.defineProperty(navigatorPrototype, 'webdriver', {
                configurable: true,
                get: () => false,
            })
        } catch {}
    }

    if (!Array.isArray(navigator.languages) || navigator.languages.length === 0) {
        try {
            Object.defineProperty(navigatorPrototype, 'languages', {
                configurable: true,
                get: () => ['en-US', 'en'],
            })
        } catch {}
    }

    if (window.outerWidth <= 0 || window.outerHeight <= 0) {
        try {
            Object.defineProperty(window, 'outerWidth', {
                configurable: true,
                get: () => Math.max(window.innerWidth, 0),
            })
            Object.defineProperty(window, 'outerHeight', {
                configurable: true,
                get: () => Math.max(window.innerHeight, 0),
            })
        } catch {}
    }
}
