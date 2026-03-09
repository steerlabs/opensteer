import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    chromium,
    type Browser,
    type BrowserContext,
    type Page,
} from 'playwright'
import type { LaunchOptions, OpensteerBrowserConfig } from '../types.js'
import { detectChromePaths, expandHome } from './chrome.js'

type BrowserCdpSession = Awaited<ReturnType<Browser['newBrowserCDPSession']>>

interface BrowserTargetInfo {
    targetId: string
    type: string
    url: string
}

export interface BrowserSession {
    browser: Browser
    context: BrowserContext
    page: Page
    /** True when connected to an external browser. close() disconnects without killing it. */
    isExternal: boolean
}

export class BrowserPool {
    private browser: Browser | null = null
    private launchedProcess: ChildProcess | null = null
    private tempUserDataDir: string | null = null
    private readonly defaults: OpensteerBrowserConfig

    constructor(defaults: OpensteerBrowserConfig = {}) {
        this.defaults = defaults
    }

    async launch(options: LaunchOptions = {}): Promise<BrowserSession> {
        if (this.browser || this.launchedProcess || this.tempUserDataDir) {
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
        const launchedProcess = this.launchedProcess
        const tempUserDataDir = this.tempUserDataDir
        this.browser = null
        this.launchedProcess = null
        this.tempUserDataDir = null

        try {
            if (browser) {
                await browser.close().catch(() => undefined)
            }
        } finally {
            await killProcessTree(launchedProcess)
            if (tempUserDataDir) {
                await rm(tempUserDataDir, {
                    recursive: true,
                    force: true,
                }).catch(() => undefined)
            }
        }
    }

    private async connectToRunning(
        cdpUrl: string,
        timeout?: number
    ): Promise<BrowserSession> {
        let browser: Browser | null = null

        try {
            const browserWsUrl = await resolveCdpWebSocketUrl(
                cdpUrl,
                timeout ?? 30_000
            )
            browser = await chromium.connectOverCDP(browserWsUrl, {
                timeout: timeout ?? 30_000,
            })
            this.browser = browser
            const { context, page } = await pickBrowserContextAndPage(browser)

            return { browser, context, page, isExternal: true }
        } catch (error) {
            if (browser) {
                await browser.close().catch(() => undefined)
            }
            this.browser = null
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
        const tempUserDataDir = await cloneProfileToTempDir(
            sourceUserDataDir,
            profileDirectory
        )
        const debugPort = await reserveDebugPort()
        const headless =
            options.headless ??
            (this.defaults.mode === 'real' &&
            this.defaults.headless !== undefined
                ? this.defaults.headless
                : true)
        const launchArgs = buildRealBrowserLaunchArgs({
            userDataDir: tempUserDataDir,
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
                browser,
                {
                    headless,
                    initialUrl: options.initialUrl,
                    timeoutMs: options.timeout ?? 30_000,
                }
            )
            this.browser = browser
            this.launchedProcess = processHandle
            this.tempUserDataDir = tempUserDataDir

            return { browser, context, page, isExternal: false }
        } catch (error) {
            await browser?.close().catch(() => undefined)
            await killProcessTree(processHandle)
            await rm(tempUserDataDir, {
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
            headless: options.headless ?? this.defaults.headless,
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
    const pages = context.pages()
    const page =
        pages.find((candidate) => isInspectablePageUrl(candidate.url())) ||
        pages[0] ||
        (await context.newPage())

    return { context, page }
}

async function createOwnedBrowserContextAndPage(
    browser: Browser,
    options: { headless: boolean; initialUrl?: string; timeoutMs: number }
): Promise<{
    context: BrowserContext
    page: Page
}> {
    const context = getPrimaryBrowserContext(browser)
    const page = await createOwnedBrowserPage(browser, context, options)

    return { context, page }
}

async function createOwnedBrowserPage(
    browser: Browser,
    context: BrowserContext,
    options: { headless: boolean; initialUrl?: string; timeoutMs: number }
): Promise<Page> {
    const targetUrl = options.initialUrl ?? 'about:blank'
    const existingPages = new Set(context.pages())
    const browserSession = await browser.newBrowserCDPSession()

    try {
        const { targetId } = await browserSession.send('Target.createTarget', {
            url: targetUrl,
            newWindow: !options.headless,
        })

        await browserSession
            .send('Target.activateTarget', { targetId })
            .catch(() => undefined)

        const page = await waitForOwnedBrowserPage(context, {
            existingPages,
            targetUrl,
            timeoutMs: options.timeoutMs,
        })
        await closeDisposableStartupTargets(browserSession, targetId)
        return page
    } finally {
        await browserSession.detach().catch(() => undefined)
    }
}

async function closeDisposableStartupTargets(
    browserSession: BrowserCdpSession,
    preservedTargetId: string
): Promise<void> {
    const response = await browserSession
        .send('Target.getTargets')
        .catch(() => null) as { targetInfos: BrowserTargetInfo[] } | null

    if (!response) {
        return
    }

    for (const targetInfo of response.targetInfos) {
        if (
            targetInfo.targetId === preservedTargetId ||
            targetInfo.type !== 'page' ||
            !isDisposableStartupPageUrl(targetInfo.url)
        ) {
            continue
        }

        await browserSession
            .send('Target.closeTarget', { targetId: targetInfo.targetId })
            .catch(() => undefined)
    }
}

async function waitForOwnedBrowserPage(
    context: BrowserContext,
    options: {
        existingPages: Set<Page>
        targetUrl: string
        timeoutMs: number
    }
): Promise<Page> {
    const deadline = Date.now() + options.timeoutMs
    let fallbackPage: Page | null = null

    while (Date.now() < deadline) {
        for (const candidate of context.pages()) {
            if (options.existingPages.has(candidate)) {
                continue
            }

            const url = candidate.url()
            if (!isInspectablePageUrl(url)) {
                continue
            }

            fallbackPage ??= candidate
            if (options.targetUrl === 'about:blank') {
                return candidate
            }

            if (pageLooselyMatchesUrl(url, options.targetUrl)) {
                return candidate
            }
        }

        await sleep(100)
    }

    if (fallbackPage) {
        return fallbackPage
    }

    throw new Error(
        `Chrome created a target for ${options.targetUrl}, but Playwright did not expose the page in time.`
    )
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

function isDisposableStartupPageUrl(url: string): boolean {
    return (
        url === 'about:blank' ||
        url === 'chrome://newtab/' ||
        url === 'chrome://new-tab-page/'
    )
}

function pageLooselyMatchesUrl(currentUrl: string, initialUrl: string): boolean {
    try {
        const current = new URL(currentUrl)
        const requested = new URL(initialUrl)

        if (current.href === requested.href) {
            return true
        }

        if (
            current.protocol === requested.protocol &&
            current.hostname === requested.hostname &&
            current.pathname === requested.pathname
        ) {
            return true
        }

        return (
            current.hostname === requested.hostname &&
            requested.pathname === '/' &&
            current.pathname !== '/'
        )
    } catch {
        return currentUrl === initialUrl
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

async function cloneProfileToTempDir(
    userDataDir: string,
    profileDirectory: string
): Promise<string> {
    const resolvedUserDataDir = expandHome(userDataDir)
    const tempUserDataDir = await mkdtemp(
        join(tmpdir(), 'opensteer-real-browser-')
    )
    const sourceProfileDir = join(resolvedUserDataDir, profileDirectory)
    const targetProfileDir = join(tempUserDataDir, profileDirectory)

    if (existsSync(sourceProfileDir)) {
        await cp(sourceProfileDir, targetProfileDir, {
            recursive: true,
        })
    } else {
        await mkdir(targetProfileDir, {
            recursive: true,
        })
    }

    const localStatePath = join(resolvedUserDataDir, 'Local State')
    if (existsSync(localStatePath)) {
        await copyFile(localStatePath, join(tempUserDataDir, 'Local State'))
    }

    return tempUserDataDir
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
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-popup-blocking',
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
