import { spawn, type ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import {
    chromium,
    type Browser,
    type BrowserContext,
    type Page,
} from 'playwright'
import {
    clearPersistentProfileSingletons,
    createIsolatedRuntimeProfile,
    persistIsolatedRuntimeProfile,
    type PersistentProfileResult,
} from './persistent-profile.js'

type OwnedRealBrowserKillStrategy = 'process' | 'process-group' | 'taskkill'

interface OwnedRealBrowserProcessPolicy {
    detached: boolean
    killStrategy: OwnedRealBrowserKillStrategy
    shouldUnref: boolean
}

export interface SharedRealBrowserSession {
    browser: Browser
    close: () => Promise<void>
    context: BrowserContext
    page: Page
}

export interface SharedRealBrowserSessionOptions {
    executablePath: string
    headless: boolean
    initialUrl?: string
    persistentProfile: PersistentProfileResult
    profileDirectory: string
    timeoutMs: number
}

export async function acquireSharedRealBrowserSession(
    options: SharedRealBrowserSessionOptions
): Promise<SharedRealBrowserSession> {
    const runtimeProfile = await createIsolatedRuntimeProfile(
        options.persistentProfile.userDataDir
    )
    await clearPersistentProfileSingletons(runtimeProfile.userDataDir)

    const debugPort = await reserveDebugPort()
    const launchArgs = buildRealBrowserLaunchArgs({
        debugPort,
        headless: options.headless,
        profileDirectory: options.profileDirectory,
        userDataDir: runtimeProfile.userDataDir,
    })
    const processPolicy = getOwnedRealBrowserProcessPolicy()
    const processHandle = spawn(options.executablePath, launchArgs, {
        detached: processPolicy.detached,
        stdio: 'ignore',
    })
    if (processPolicy.shouldUnref) {
        processHandle.unref()
    }

    let browser: Browser | null = null

    try {
        const browserWsUrl = await resolveCdpWebSocketUrl(
            buildDiscoveryUrl(debugPort),
            options.timeoutMs
        )
        browser = await chromium.connectOverCDP(browserWsUrl, {
            timeout: options.timeoutMs,
        })

        const connectedBrowser = browser
        const context = getPrimaryBrowserContext(connectedBrowser)
        const page = await getExistingPageOrCreate(context)
        if (options.initialUrl) {
            await page.goto(options.initialUrl, {
                timeout: options.timeoutMs,
                waitUntil: 'domcontentloaded',
            })
        }

        let closed = false
        let closeInFlight: Promise<void> | null = null

        return {
            browser: connectedBrowser,
            context,
            page,
            close: async () => {
                if (closed) {
                    return
                }
                if (closeInFlight) {
                    await closeInFlight
                    return
                }

                const closeOperation = closeIsolatedRuntimeBrowserSession({
                    browser: connectedBrowser,
                    persistentUserDataDir: options.persistentProfile.userDataDir,
                    processHandle,
                    runtimeUserDataDir: runtimeProfile.userDataDir,
                })
                closeInFlight = closeOperation

                try {
                    await closeOperation
                    closed = true
                } finally {
                    closeInFlight = null
                }
            },
        }
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

export function getOwnedRealBrowserProcessPolicy(
    platformName: NodeJS.Platform = process.platform
): OwnedRealBrowserProcessPolicy {
    if (platformName === 'win32') {
        return {
            detached: false,
            killStrategy: 'taskkill',
            shouldUnref: true,
        }
    }

    return {
        detached: true,
        killStrategy: 'process-group',
        shouldUnref: true,
    }
}

async function closeIsolatedRuntimeBrowserSession(options: {
    browser: Browser
    persistentUserDataDir: string
    processHandle: ChildProcess
    runtimeUserDataDir: string
}): Promise<void> {
    await options.browser.close().catch(() => undefined)
    await killProcessTree(options.processHandle)
    await persistIsolatedRuntimeProfile(
        options.runtimeUserDataDir,
        options.persistentUserDataDir
    )
}

function buildDiscoveryUrl(debugPort: number): string {
    return `http://127.0.0.1:${debugPort}`
}

function buildRealBrowserLaunchArgs(options: {
    debugPort: number
    headless: boolean
    profileDirectory: string
    userDataDir: string
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

async function killProcessTree(processHandle: ChildProcess): Promise<void> {
    if (
        processHandle.pid == null ||
        processHandle.exitCode !== null
    ) {
        return
    }

    const processPolicy = getOwnedRealBrowserProcessPolicy()

    if (processPolicy.killStrategy === 'taskkill') {
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

    if (processPolicy.killStrategy === 'process-group') {
        try {
            process.kill(-processHandle.pid, 'SIGKILL')
            return
        } catch {
            // Fall through to a direct kill if the group is already gone.
        }
    }

    try {
        process.kill(processHandle.pid, 'SIGKILL')
    } catch {
        try {
            processHandle.kill?.('SIGKILL')
        } catch {
            // best-effort cleanup
        }
    }
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

async function getExistingPageOrCreate(
    context: BrowserContext
): Promise<Page> {
    const existingPage = context.pages()[0]
    if (existingPage) {
        return existingPage
    }

    return await context.newPage()
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

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
}
