import {
    chromium,
    type Browser,
    type BrowserContext,
    type Page,
} from 'playwright'
import type { LaunchOptions, OpensteerBrowserConfig } from '../types.js'
import { CDPProxy, createBlankTarget, discoverTargets } from './cdp-proxy.js'
import { detectChromePaths, expandHome } from './chrome.js'
import {
    getOrCreatePersistentProfile,
} from './persistent-profile.js'
import {
    acquireSharedRealBrowserSession,
} from './shared-real-browser-session.js'

export { getOwnedRealBrowserProcessPolicy } from './shared-real-browser-session.js'

export interface BrowserSession {
    browser: Browser
    context: BrowserContext
    page: Page
    /** True when connected to an external browser. close() disconnects without killing it. */
    isExternal: boolean
}

export class BrowserPool {
    private browser: Browser | null = null
    private activeSessionClose: (() => Promise<void>) | null = null
    private closeInFlight: Promise<void> | null = null
    private readonly defaults: OpensteerBrowserConfig

    constructor(defaults: OpensteerBrowserConfig = {}) {
        this.defaults = defaults
    }

    async launch(options: LaunchOptions = {}): Promise<BrowserSession> {
        if (this.browser || this.activeSessionClose) {
            await this.close()
        }

        const mode = options.mode ?? this.defaults.mode ?? 'chromium'
        const cdpUrl = options.cdpUrl ?? this.defaults.cdpUrl
        const userDataDir = options.userDataDir ?? this.defaults.userDataDir
        const profileDirectory =
            options.profileDirectory ?? this.defaults.profileDirectory
        const executablePath =
            options.executablePath ?? this.defaults.executablePath

        if (cdpUrl) {
            if (mode === 'real') {
                throw new Error(
                    'cdpUrl cannot be combined with mode "real". Use one browser launch path at a time.'
                )
            }
            if (userDataDir || profileDirectory) {
                throw new Error(
                    'userDataDir/profileDirectory cannot be combined with cdpUrl.'
                )
            }
            if (options.context && Object.keys(options.context).length > 0) {
                throw new Error(
                    'context launch options are not supported when attaching over CDP.'
                )
            }
            return this.connectToRunning(cdpUrl, options.timeout)
        }

        if (mode !== 'real' && (userDataDir || profileDirectory)) {
            throw new Error(
                'userDataDir/profileDirectory require mode "real".'
            )
        }

        if (mode === 'real') {
            if (options.context && Object.keys(options.context).length > 0) {
                throw new Error(
                    'context launch options are not supported for real-browser mode.'
                )
            }
            return this.launchOwnedRealBrowser({
                ...options,
                executablePath,
                userDataDir,
                profileDirectory,
            })
        }

        return this.launchSandbox(options)
    }

    async close(): Promise<void> {
        if (this.closeInFlight) {
            await this.closeInFlight
            return
        }

        const closeOperation = this.closeCurrent()
        this.closeInFlight = closeOperation

        try {
            await closeOperation
            this.browser = null
            this.activeSessionClose = null
        } finally {
            this.closeInFlight = null
        }
    }

    private async closeCurrent(): Promise<void> {
        if (this.activeSessionClose) {
            await this.activeSessionClose()
            return
        }

        await this.browser?.close().catch(() => undefined)
    }

    private async connectToRunning(
        cdpUrl: string,
        timeout?: number
    ): Promise<BrowserSession> {
        let browser: Browser | null = null
        let cdpProxy: CDPProxy | null = null

        try {
            const { browserWsUrl, targets } = await discoverTargets(cdpUrl)
            let targetId: string
            if (targets.length > 0) {
                targetId = targets[0].id
            } else {
                targetId = await createBlankTarget(browserWsUrl)
            }
            cdpProxy = new CDPProxy(browserWsUrl, targetId)
            const proxyWsUrl = await cdpProxy.start()

            browser = await chromium.connectOverCDP(proxyWsUrl, {
                timeout: timeout ?? 30_000,
            })
            this.browser = browser
            this.activeSessionClose = async () => {
                await browser?.close().catch(() => undefined)
                cdpProxy?.close()
            }
            const { context, page } = await pickBrowserContextAndPage(browser)

            return { browser, context, page, isExternal: true }
        } catch (error) {
            if (browser) {
                await browser.close().catch(() => undefined)
            }
            cdpProxy?.close()
            this.browser = null
            this.activeSessionClose = null
            throw error
        }
    }

    private async launchOwnedRealBrowser(
        options: LaunchOptions
    ): Promise<BrowserSession> {
        const chromePaths = detectChromePaths()
        const executablePath =
            options.executablePath ?? chromePaths.executable ?? undefined
        if (!executablePath) {
            throw new Error(
                'Chrome was not found. Set browser.executablePath or install Chrome in a supported location.'
            )
        }

        const sourceUserDataDir = expandHome(
            options.userDataDir ?? chromePaths.defaultUserDataDir
        )
        const profileDirectory = options.profileDirectory ?? 'Default'
        const persistentProfile = await getOrCreatePersistentProfile(
            sourceUserDataDir,
            profileDirectory
        )
        const sharedSession = await acquireSharedRealBrowserSession({
            executablePath,
            headless: resolveLaunchHeadless(
                'real',
                options.headless,
                this.defaults.headless
            ),
            initialUrl: options.initialUrl,
            persistentProfile,
            profileDirectory,
            timeoutMs: options.timeout ?? 30_000,
        })

        this.browser = sharedSession.browser
        this.activeSessionClose = sharedSession.close

        return {
            browser: sharedSession.browser,
            context: sharedSession.context,
            page: sharedSession.page,
            isExternal: false,
        }
    }

    private async launchSandbox(
        options: LaunchOptions
    ): Promise<BrowserSession> {
        const browser = await chromium.launch({
            headless: resolveLaunchHeadless(
                'chromium',
                options.headless,
                this.defaults.headless
            ),
            executablePath:
                options.executablePath ??
                this.defaults.executablePath ??
                undefined,
            slowMo: options.slowMo ?? this.defaults.slowMo ?? 0,
            timeout: options.timeout,
        })

        const context = await browser.newContext(options.context || {})
        const page = await context.newPage()

        this.browser = browser
        this.activeSessionClose = async () => {
            await browser.close().catch(() => undefined)
        }

        return { browser, context, page, isExternal: false }
    }
}

async function pickBrowserContextAndPage(browser: Browser): Promise<{
    context: BrowserContext
    page: Page
}> {
    const context = getPrimaryBrowserContext(browser)
    const page = await getAttachedPageOrCreate(context)

    return { context, page }
}

function resolveLaunchHeadless(
    mode: 'chromium' | 'real',
    requestedHeadless: boolean | undefined,
    defaultHeadless: boolean | undefined
): boolean {
    if (requestedHeadless !== undefined) {
        return requestedHeadless
    }
    if (defaultHeadless !== undefined) {
        return defaultHeadless
    }
    return mode === 'real'
}

async function getAttachedPageOrCreate(
    context: BrowserContext
): Promise<Page> {
    const pages = context.pages()
    const inspectablePage = pages.find((candidate) =>
        isInspectablePageUrl(safePageUrl(candidate))
    )

    if (inspectablePage) {
        return inspectablePage
    }

    const attachedPage = pages[0]
    if (attachedPage) {
        return attachedPage
    }

    return await context.newPage()
}

function getPrimaryBrowserContext(browser: Browser): BrowserContext {
    const contexts = browser.contexts()
    if (contexts.length === 0) {
        throw new Error(
            'Connection succeeded but no browser contexts were exposed.'
        )
    }

    return contexts[0]
}

function isInspectablePageUrl(url: string): boolean {
    return (
        url === 'about:blank' ||
        url.startsWith('http://') ||
        url.startsWith('https://')
    )
}

function safePageUrl(page: Page): string {
    try {
        return page.url()
    } catch {
        return ''
    }
}
