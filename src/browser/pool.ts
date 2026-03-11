import { spawn, type ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:net'
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
    createIsolatedRuntimeProfile,
    getOrCreatePersistentProfile,
    persistIsolatedRuntimeProfile,
    type IsolatedRuntimeProfileResult,
} from './persistent-profile.js'

export interface BrowserSession {
    browser: Browser
    context: BrowserContext
    page: Page
    /** True when connected to an external browser. close() disconnects without killing it. */
    isExternal: boolean
}

export class BrowserPool {
    private browser: Browser | null = null
    private cdpProxy: CDPProxy | null = null
    private launchedProcess: ChildProcess | null = null
    private managedRuntimeProfile: IsolatedRuntimeProfileResult | null = null
    private readonly defaults: OpensteerBrowserConfig

    constructor(defaults: OpensteerBrowserConfig = {}) {
        this.defaults = defaults
    }

    async launch(options: LaunchOptions = {}): Promise<BrowserSession> {
        if (
            this.browser ||
            this.cdpProxy ||
            this.launchedProcess ||
            this.managedRuntimeProfile
        ) {
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
        const browser = this.browser
        const cdpProxy = this.cdpProxy
        const launchedProcess = this.launchedProcess
        const managedRuntimeProfile = this.managedRuntimeProfile
        this.browser = null
        this.cdpProxy = null
        this.launchedProcess = null

        try {
            if (browser) {
                await browser.close().catch(() => undefined)
            }
        } finally {
            cdpProxy?.close()
            await killProcessTree(launchedProcess)
            if (managedRuntimeProfile) {
                await persistIsolatedRuntimeProfile(
                    managedRuntimeProfile.userDataDir,
                    managedRuntimeProfile.persistentUserDataDir
                )
                if (this.managedRuntimeProfile === managedRuntimeProfile) {
                    this.managedRuntimeProfile = null
                }
            }
        }
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
            this.cdpProxy = cdpProxy
            const { context, page } = await pickBrowserContextAndPage(browser)

            return { browser, context, page, isExternal: true }
        } catch (error) {
            if (browser) {
                await browser.close().catch(() => undefined)
            }
            cdpProxy?.close()
            this.browser = null
            this.cdpProxy = null
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
        const runtimeProfile = await createIsolatedRuntimeProfile(
            persistentProfile.userDataDir
        )
        const debugPort = await reserveDebugPort()
        const headless = resolveLaunchHeadless(
            'real',
            options.headless,
            this.defaults.headless
        )
        const launchArgs = buildRealBrowserLaunchArgs({
            userDataDir: runtimeProfile.userDataDir,
            profileDirectory,
            debugPort,
            headless,
        })
        const processHandle = spawn(executablePath, launchArgs, {
            detached: process.platform !== 'win32',
            stdio: 'ignore',
        })
        processHandle.unref()

        let browser: Browser | null = null
        try {
            const wsUrl = await resolveCdpWebSocketUrl(
                `http://127.0.0.1:${debugPort}`,
                options.timeout ?? 30_000
            )
            browser = await chromium.connectOverCDP(wsUrl, {
                timeout: options.timeout ?? 30_000,
            })
            const { context, page } = await createOwnedBrowserContextAndPage(
                browser
            )
            if (options.initialUrl) {
                await page.goto(options.initialUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: options.timeout ?? 30_000,
                })
            }
            this.browser = browser
            this.launchedProcess = processHandle
            this.managedRuntimeProfile = runtimeProfile

            return { browser, context, page, isExternal: false }
        } catch (error) {
            await browser?.close().catch(() => undefined)
            await killProcessTree(processHandle)
            await rm(runtimeProfile.userDataDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined)
            throw error
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

async function createOwnedBrowserContextAndPage(
    browser: Browser
): Promise<{
    context: BrowserContext
    page: Page
}> {
    const context = getPrimaryBrowserContext(browser)
    const page = await getExistingPageOrCreate(context)

    return { context, page }
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

async function getExistingPageOrCreate(
    context: BrowserContext
): Promise<Page> {
    const existingPage = context.pages()[0]
    if (existingPage) {
        return existingPage
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

function normalizeDiscoveryUrl(cdpUrl: string): URL {
    let parsed: URL
    try {
        parsed = new URL(cdpUrl)
    } catch {
        throw new Error(
            `Invalid CDP URL "${cdpUrl}". Use an http(s) or ws(s) endpoint.`
        )
    }

    if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
        return parsed
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(
            `Unsupported CDP URL protocol "${parsed.protocol}". Use http(s) or ws(s).`
        )
    }

    const normalized = new URL(parsed.toString())
    normalized.pathname = '/json/version'
    normalized.search = ''
    normalized.hash = ''
    return normalized
}

async function resolveCdpWebSocketUrl(
    cdpUrl: string,
    timeoutMs: number
): Promise<string> {
    if (cdpUrl.startsWith('ws://') || cdpUrl.startsWith('wss://')) {
        return cdpUrl
    }

    const versionUrl = normalizeDiscoveryUrl(cdpUrl)
    const deadline = Date.now() + timeoutMs
    let lastError = 'CDP discovery did not respond.'

    while (Date.now() < deadline) {
        const remaining = Math.max(deadline - Date.now(), 1_000)
        try {
            const response = await fetch(versionUrl, {
                signal: AbortSignal.timeout(Math.min(remaining, 5_000)),
            })
            if (!response.ok) {
                lastError = `${response.status} ${response.statusText}`
            } else {
                const payload = await response.json()
                const wsUrl =
                    payload &&
                    typeof payload === 'object' &&
                    !Array.isArray(payload) &&
                    typeof (payload as { webSocketDebuggerUrl?: unknown })
                        .webSocketDebuggerUrl === 'string'
                        ? (payload as { webSocketDebuggerUrl: string })
                              .webSocketDebuggerUrl
                        : null

                if (wsUrl && wsUrl.trim()) {
                    return wsUrl
                }
                lastError =
                    'CDP discovery response did not include webSocketDebuggerUrl.'
            }
        } catch (error) {
            lastError =
                error instanceof Error ? error.message : 'Unknown error'
        }

        await sleep(100)
    }

    throw new Error(
        `Failed to resolve a CDP websocket URL from ${versionUrl.toString()}: ${lastError}`
    )
}

async function reserveDebugPort(): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
        const server = createServer()
        server.unref()
        server.on('error', reject)
        server.listen(0, '127.0.0.1', () => {
            const address = server.address()
            if (!address || typeof address === 'string') {
                server.close()
                reject(new Error('Failed to reserve a local debug port.'))
                return
            }

            server.close((error) => {
                if (error) {
                    reject(error)
                    return
                }
                resolve(address.port)
            })
        })
    })
}

function buildRealBrowserLaunchArgs(options: {
    userDataDir: string
    profileDirectory: string
    debugPort: number
    headless: boolean
}): string[] {
    const args = [
        `--user-data-dir=${options.userDataDir}`,
        `--profile-directory=${options.profileDirectory}`,
        `--remote-debugging-port=${options.debugPort}`,
        '--disable-blink-features=AutomationControlled',
    ]

    if (options.headless) {
        args.push('--headless=new')
    }

    return args
}

async function killProcessTree(
    processHandle: ChildProcess | null
): Promise<void> {
    if (
        !processHandle ||
        processHandle.pid == null ||
        processHandle.exitCode !== null
    ) {
        return
    }

    if (process.platform === 'win32') {
        await new Promise<void>((resolve) => {
            const killer = spawn(
                'taskkill',
                ['/pid', String(processHandle.pid), '/t', '/f'],
                {
                    stdio: 'ignore',
                }
            )
            killer.on('error', () => resolve())
            killer.on('exit', () => resolve())
        })
        return
    }

    try {
        process.kill(-processHandle.pid, 'SIGKILL')
    } catch {
        try {
            processHandle.kill('SIGKILL')
        } catch {
            // best-effort cleanup
        }
    }
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
}
