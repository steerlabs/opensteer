import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { type Dirent } from 'node:fs'
import {
    mkdir,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import {
    chromium,
    type Browser,
    type BrowserContext,
    type CDPSession,
    type Page,
} from 'playwright'
import { createServer } from 'node:net'
import { withDirLock } from './dir-lock.js'
import {
    clearPersistentProfileSingletons,
    hasActiveRuntimeProfileCreations,
    type PersistentProfileResult,
} from './persistent-profile.js'
import {
    isPersistentProfileWriteLocked,
    withPersistentProfileControlLock,
} from './persistent-profile-coordination.js'
import {
    CURRENT_PROCESS_OWNER,
    getProcessLiveness,
    isProcessRunning,
    parseProcessOwner,
    processOwnersEqual,
    readProcessOwner,
    type ProcessOwner,
} from './process-owner.js'
import {
    buildSharedSessionClientPath,
    buildSharedSessionClientsDirPath,
    buildSharedSessionDirPath,
    buildSharedSessionLockPath,
    readSharedSessionMetadata,
    writeSharedSessionMetadata,
    type SharedSessionMetadata,
} from './shared-real-browser-session-state.js'

const SHARED_SESSION_RETRY_DELAY_MS = 50
const SHARED_SESSION_READY_TIMEOUT_MS = 5_000

type OwnedRealBrowserKillStrategy = 'process' | 'process-group' | 'taskkill'

interface SharedSessionClientRegistration {
    clientId: string
    createdAt: string
    owner: ProcessOwner
}

interface SharedSessionLeaseContext {
    browser: Browser
    clientId: string
    context: BrowserContext
    page: Page
    persistentUserDataDir: string
    sessionId: string
}

interface SharedSessionReservation {
    client: SharedSessionClientRegistration
    metadata: SharedSessionMetadata
    reuseExistingPage: boolean
}

interface SharedSessionLaunchReservation {
    launchedBrowserOwner: ProcessOwner
    metadata: SharedSessionMetadata
}

type SharedSessionStateInspection =
    | { kind: 'missing' }
    | { kind: 'ready'; metadata: SharedSessionMetadata }
    | { kind: 'wait' }

type SharedSessionReservationOutcome =
    | { kind: 'launch'; reservation: SharedSessionLaunchReservation }
    | { kind: 'ready'; reservation: SharedSessionReservation }
    | { kind: 'wait' }

type SharedSessionClosePlan =
    | { closeBrowser: false; sessionId: string }
    | {
          browserOwner: ProcessOwner
          closeBrowser: true
          sessionId: string
      }

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
    const reservation = await reserveSharedSessionClient(options)
    const sessionContext = await attachToSharedSession(reservation, options)
    let closed = false

    return {
        browser: sessionContext.browser,
        context: sessionContext.context,
        page: sessionContext.page,
        close: async () => {
            if (closed) {
                return
            }
            closed = true
            await releaseSharedSessionClient(sessionContext)
        },
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

async function reserveSharedSessionClient(
    options: SharedRealBrowserSessionOptions
): Promise<SharedSessionReservation> {
    while (true) {
        const outcome: SharedSessionReservationOutcome =
            await withPersistentProfileControlLock(
                options.persistentProfile.userDataDir,
                async () => {
                    if (
                        await isPersistentProfileWriteLocked(
                            options.persistentProfile.userDataDir
                        )
                    ) {
                        return { kind: 'wait' }
                    }
                    if (
                        await hasActiveRuntimeProfileCreations(
                            options.persistentProfile.userDataDir
                        )
                    ) {
                        return { kind: 'wait' }
                    }

                    return await withSharedSessionLock(
                        options.persistentProfile.userDataDir,
                        async () => {
                            const state = await inspectSharedSessionState(options)
                            if (state.kind === 'wait') {
                                return { kind: 'wait' }
                            }
                            if (state.kind === 'ready') {
                                return {
                                    kind: 'ready',
                                    reservation:
                                        await registerSharedSessionClient(
                                            options.persistentProfile.userDataDir,
                                            state.metadata
                                        ),
                                }
                            }

                            return {
                                kind: 'launch',
                                reservation: await launchSharedSession(options),
                            }
                        }
                    )
                }
            )

        if (outcome.kind === 'wait') {
            await sleep(SHARED_SESSION_RETRY_DELAY_MS)
            continue
        }
        if (outcome.kind === 'ready') {
            return outcome.reservation
        }

        try {
            await waitForSharedSessionReady(
                outcome.reservation.metadata,
                options.timeoutMs
            )
        } catch (error) {
            await cleanupFailedSharedSessionLaunch(outcome.reservation)
            throw error
        }

        return await withSharedSessionLock(
            options.persistentProfile.userDataDir,
            async () => {
                const metadata = await readSharedSessionMetadata(
                    options.persistentProfile.userDataDir
                )
                if (
                    !metadata ||
                    metadata.sessionId !== outcome.reservation.metadata.sessionId ||
                    !processOwnersEqual(
                        metadata.browserOwner,
                        outcome.reservation.launchedBrowserOwner
                    )
                ) {
                    throw new Error(
                        'The shared real-browser session changed before launch finalized.'
                    )
                }

                const readyMetadata: SharedSessionMetadata = {
                    ...metadata,
                    state: 'ready',
                }
                await writeSharedSessionMetadata(
                    options.persistentProfile.userDataDir,
                    readyMetadata
                )

                return await registerSharedSessionClient(
                    options.persistentProfile.userDataDir,
                    readyMetadata
                )
            }
        )
    }
}

async function attachToSharedSession(
    reservation: SharedSessionReservation,
    options: SharedRealBrowserSessionOptions
): Promise<SharedSessionLeaseContext> {
    let browser: Browser | null = null
    let page: Page | null = null

    try {
        const browserWsUrl = await resolveCdpWebSocketUrl(
            buildSharedSessionDiscoveryUrl(reservation.metadata.debugPort),
            options.timeoutMs
        )
        browser = await chromium.connectOverCDP(browserWsUrl, {
            timeout: options.timeoutMs,
        })
        const context = getPrimaryBrowserContext(browser)
        page = await getSharedSessionPage(context, reservation.reuseExistingPage)
        if (options.initialUrl) {
            await page.goto(options.initialUrl, {
                timeout: options.timeoutMs,
                waitUntil: 'domcontentloaded',
            })
        }

        return {
            browser,
            clientId: reservation.client.clientId,
            context,
            page,
            persistentUserDataDir: reservation.metadata.persistentUserDataDir,
            sessionId: reservation.metadata.sessionId,
        }
    } catch (error) {
        if (page) {
            await page.close().catch(() => undefined)
        }
        if (browser) {
            await browser.close().catch(() => undefined)
        }
        await cleanupFailedSharedSessionAttach({
            clientId: reservation.client.clientId,
            persistentUserDataDir: reservation.metadata.persistentUserDataDir,
            sessionId: reservation.metadata.sessionId,
        })
        throw error
    }
}

async function releaseSharedSessionClient(
    context: SharedSessionLeaseContext
): Promise<void> {
    const releasePlan = await prepareSharedSessionCloseIfIdle(
        context.persistentUserDataDir,
        context.clientId,
        context.sessionId
    )

    if (releasePlan.closeBrowser) {
        await closeSharedSessionBrowser(
            context.persistentUserDataDir,
            releasePlan,
            context.browser
        )
    }

    await context.page.close().catch(() => undefined)
    await context.browser.close().catch(() => undefined)
}

async function inspectSharedSessionState(
    options: SharedRealBrowserSessionOptions
): Promise<SharedSessionStateInspection> {
    const persistentUserDataDir = options.persistentProfile.userDataDir
    const liveClients = await listLiveSharedSessionClients(persistentUserDataDir)
    const metadata = await readSharedSessionMetadata(persistentUserDataDir)
    if (!metadata) {
        if (liveClients.length > 0) {
            throw new Error(
                `Shared real-browser session metadata for "${persistentUserDataDir}" is missing while clients are still attached.`
            )
        }
        await rm(buildSharedSessionDirPath(persistentUserDataDir), {
            force: true,
            recursive: true,
        }).catch(() => undefined)
        return { kind: 'missing' }
    }

    assertSharedSessionCompatibility(metadata, options)

    const browserState = await getProcessLiveness(metadata.browserOwner)
    if (browserState === 'dead') {
        await rm(buildSharedSessionDirPath(persistentUserDataDir), {
            force: true,
            recursive: true,
        }).catch(() => undefined)
        return { kind: 'missing' }
    }

    if (metadata.state === 'ready') {
        return {
            kind: 'ready',
            metadata,
        }
    }

    const stateOwnerState = await getProcessLiveness(metadata.stateOwner)
    if (stateOwnerState === 'dead') {
        const recoveredMetadata: SharedSessionMetadata = {
            ...metadata,
            state: 'ready',
        }
        await writeSharedSessionMetadata(persistentUserDataDir, recoveredMetadata)
        return {
            kind: 'ready',
            metadata: recoveredMetadata,
        }
    }

    return { kind: 'wait' }
}

async function launchSharedSession(
    options: SharedRealBrowserSessionOptions
): Promise<SharedSessionLaunchReservation> {
    const persistentUserDataDir = options.persistentProfile.userDataDir
    await clearPersistentProfileSingletons(persistentUserDataDir)
    const debugPort = await reserveDebugPort()
    const launchArgs = buildRealBrowserLaunchArgs({
        debugPort,
        headless: options.headless,
        profileDirectory: options.profileDirectory,
        userDataDir: persistentUserDataDir,
    })
    const processPolicy = getOwnedRealBrowserProcessPolicy()
    const processHandle = spawn(options.executablePath, launchArgs, {
        detached: processPolicy.detached,
        stdio: 'ignore',
    })
    if (processPolicy.shouldUnref) {
        processHandle.unref()
    }
    try {
        const browserOwner = await waitForSpawnedProcessOwner(processHandle.pid)
        const metadata: SharedSessionMetadata = {
            browserOwner,
            createdAt: new Date().toISOString(),
            debugPort,
            executablePath: options.executablePath,
            headless: options.headless,
            persistentUserDataDir,
            profileDirectory: options.profileDirectory,
            sessionId: randomUUID(),
            state: 'launching',
            stateOwner: CURRENT_PROCESS_OWNER,
        }
        await writeSharedSessionMetadata(persistentUserDataDir, metadata)

        return {
            launchedBrowserOwner: browserOwner,
            metadata,
        }
    } catch (error) {
        await killSpawnedBrowserProcess(processHandle)
        await rm(buildSharedSessionDirPath(persistentUserDataDir), {
            force: true,
            recursive: true,
        }).catch(() => undefined)
        throw error
    }
}

async function cleanupFailedSharedSessionLaunch(
    reservation: SharedSessionLaunchReservation
): Promise<void> {
    const shouldPreserveLiveBrowser = await withSharedSessionLock(
        reservation.metadata.persistentUserDataDir,
        async () => {
            const metadata = await readSharedSessionMetadata(
                reservation.metadata.persistentUserDataDir
            )
            if (
                metadata &&
                metadata.sessionId === reservation.metadata.sessionId &&
                processOwnersEqual(
                    metadata.browserOwner,
                    reservation.launchedBrowserOwner
                )
            ) {
                if ((await getProcessLiveness(metadata.browserOwner)) !== 'dead') {
                    const readyMetadata: SharedSessionMetadata = {
                        ...metadata,
                        state: 'ready',
                    }
                    await writeSharedSessionMetadata(
                        reservation.metadata.persistentUserDataDir,
                        readyMetadata
                    )
                    return true
                }

                await rm(
                    buildSharedSessionDirPath(
                        reservation.metadata.persistentUserDataDir
                    ),
                    {
                        force: true,
                        recursive: true,
                    }
                ).catch(() => undefined)
            }

            return false
        }
    )

    if (shouldPreserveLiveBrowser) {
        return
    }

    await killOwnedBrowserProcess(reservation.launchedBrowserOwner)
    await waitForProcessToExit(reservation.launchedBrowserOwner, 2_000)
}

async function cleanupFailedSharedSessionAttach(options: {
    clientId: string
    persistentUserDataDir: string
    sessionId: string
}): Promise<void> {
    const closePlan = await prepareSharedSessionCloseIfIdle(
        options.persistentUserDataDir,
        options.clientId,
        options.sessionId
    )
    if (!closePlan.closeBrowser) {
        return
    }

    await closeSharedSessionBrowser(options.persistentUserDataDir, closePlan)
}

async function waitForSharedSessionReady(
    metadata: SharedSessionMetadata,
    timeoutMs: number
): Promise<void> {
    await resolveCdpWebSocketUrl(
        buildSharedSessionDiscoveryUrl(metadata.debugPort),
        timeoutMs
    )
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

async function requestBrowserShutdown(browser: Browser): Promise<void> {
    let session: CDPSession | null = null

    try {
        session = await browser.newBrowserCDPSession()
        await session.send('Browser.close')
    } catch {
    } finally {
        await session?.detach().catch(() => undefined)
    }
}

async function killOwnedBrowserProcess(owner: ProcessOwner): Promise<void> {
    if ((await getProcessLiveness(owner)) === 'dead') {
        return
    }

    await killOwnedBrowserProcessByPid(owner.pid)
}

async function killSpawnedBrowserProcess(
    processHandle: ChildProcess
): Promise<void> {
    const pid = processHandle.pid
    if (!pid || processHandle.exitCode !== null) {
        return
    }

    await killOwnedBrowserProcessByPid(pid)
    await waitForPidToExit(pid, 2_000)
}

async function killOwnedBrowserProcessByPid(pid: number): Promise<void> {
    const processPolicy = getOwnedRealBrowserProcessPolicy()

    if (processPolicy.killStrategy === 'taskkill') {
        await new Promise<void>((resolve) => {
            const killer = spawn(
                'taskkill',
                ['/pid', String(pid), '/t', '/f'],
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
            process.kill(-pid, 'SIGKILL')
            return
        } catch {
            // Fall through to a direct kill if the group is already gone.
        }
    }

    try {
        process.kill(pid, 'SIGKILL')
    } catch {
        // best-effort cleanup
    }
}

async function waitForProcessToExit(
    owner: ProcessOwner,
    timeoutMs: number
): Promise<void> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
        if ((await getProcessLiveness(owner)) === 'dead') {
            return
        }

        await sleep(50)
    }
}

async function waitForPidToExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
        if (!isProcessRunning(pid)) {
            return
        }

        await sleep(50)
    }
}

async function waitForSpawnedProcessOwner(
    pid: number | undefined
): Promise<ProcessOwner> {
    if (!pid || pid <= 0) {
        throw new Error('Chrome did not expose a child process id.')
    }

    const deadline = Date.now() + SHARED_SESSION_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
        const owner = await readProcessOwner(pid)
        if (owner) {
            return owner
        }

        await sleep(50)
    }

    throw new Error(
        `Chrome process ${pid} did not report a stable process start time.`
    )
}

async function withSharedSessionLock<T>(
    persistentUserDataDir: string,
    action: () => Promise<T>
): Promise<T> {
    return await withDirLock(buildSharedSessionLockPath(persistentUserDataDir), action)
}

async function registerSharedSessionClient(
    persistentUserDataDir: string,
    metadata: SharedSessionMetadata
): Promise<SharedSessionReservation> {
    const liveClients = await listLiveSharedSessionClients(persistentUserDataDir)
    const client = buildSharedSessionClientRegistration()
    await mkdir(buildSharedSessionClientsDirPath(persistentUserDataDir), {
        recursive: true,
    })
    await writeFile(
        buildSharedSessionClientPath(persistentUserDataDir, client.clientId),
        JSON.stringify(client, null, 2),
        {
            flag: 'wx',
        }
    )

    return {
        client,
        metadata,
        reuseExistingPage: liveClients.length === 0,
    }
}

async function removeSharedSessionClientRegistration(
    persistentUserDataDir: string,
    clientId: string
): Promise<void> {
    await rm(buildSharedSessionClientPath(persistentUserDataDir, clientId), {
        force: true,
    }).catch(() => undefined)
}

async function listLiveSharedSessionClients(
    persistentUserDataDir: string
): Promise<SharedSessionClientRegistration[]> {
    const clientsDirPath = buildSharedSessionClientsDirPath(persistentUserDataDir)

    let entries: Dirent<string>[]
    try {
        entries = await readdir(clientsDirPath, {
            encoding: 'utf8',
            withFileTypes: true,
        })
    } catch {
        return []
    }

    const liveClients: SharedSessionClientRegistration[] = []

    for (const entry of entries) {
        if (!entry.isFile()) {
            continue
        }

        const filePath = join(clientsDirPath, entry.name)
        const registration = await readSharedSessionClientRegistration(filePath)
        if (!registration) {
            await rm(filePath, { force: true }).catch(() => undefined)
            continue
        }

        if ((await getProcessLiveness(registration.owner)) === 'dead') {
            await rm(filePath, { force: true }).catch(() => undefined)
            continue
        }

        liveClients.push(registration)
    }

    return liveClients
}

async function readSharedSessionClientRegistration(
    filePath: string
): Promise<SharedSessionClientRegistration | null> {
    try {
        const raw = await readFile(filePath, 'utf8')
        return parseSharedSessionClientRegistration(JSON.parse(raw))
    } catch {
        return null
    }
}

function buildSharedSessionClientRegistration(): SharedSessionClientRegistration {
    return {
        clientId: randomUUID(),
        createdAt: new Date().toISOString(),
        owner: CURRENT_PROCESS_OWNER,
    }
}

function parseSharedSessionClientRegistration(
    value: unknown
): SharedSessionClientRegistration | null {
    if (!value || typeof value !== 'object') {
        return null
    }

    const parsed = value as Partial<SharedSessionClientRegistration>
    const owner = parseProcessOwner(parsed.owner)
    if (
        !owner ||
        typeof parsed.clientId !== 'string' ||
        typeof parsed.createdAt !== 'string'
    ) {
        return null
    }

    return {
        clientId: parsed.clientId,
        createdAt: parsed.createdAt,
        owner,
    }
}

function assertSharedSessionCompatibility(
    metadata: SharedSessionMetadata,
    options: SharedRealBrowserSessionOptions
): void {
    if (metadata.executablePath !== options.executablePath) {
        throw new Error(
            `Chrome profile "${options.profileDirectory}" is already running with executable "${metadata.executablePath}", not "${options.executablePath}".`
        )
    }
    if (metadata.headless !== options.headless) {
        throw new Error(
            `Chrome profile "${options.profileDirectory}" is already running with headless=${metadata.headless}, not ${options.headless}.`
        )
    }
}

async function prepareSharedSessionCloseIfIdle(
    persistentUserDataDir: string,
    clientId: string,
    sessionId: string
): Promise<SharedSessionClosePlan> {
    return await withSharedSessionLock(persistentUserDataDir, async () => {
        const metadata = await readSharedSessionMetadata(persistentUserDataDir)
        await removeSharedSessionClientRegistration(
            persistentUserDataDir,
            clientId
        )

        if (!metadata || metadata.sessionId !== sessionId) {
            return {
                closeBrowser: false,
                sessionId,
            }
        }

        const liveClients = await listLiveSharedSessionClients(
            persistentUserDataDir
        )
        if (liveClients.length > 0) {
            return {
                closeBrowser: false,
                sessionId: metadata.sessionId,
            }
        }

        const closingMetadata: SharedSessionMetadata = {
            ...metadata,
            state: 'closing',
            stateOwner: CURRENT_PROCESS_OWNER,
        }
        await writeSharedSessionMetadata(
            persistentUserDataDir,
            closingMetadata
        )

        return {
            browserOwner: closingMetadata.browserOwner,
            closeBrowser: true,
            sessionId: closingMetadata.sessionId,
        }
    })
}

async function closeSharedSessionBrowser(
    persistentUserDataDir: string,
    closePlan: Extract<SharedSessionClosePlan, { closeBrowser: true }>,
    browser?: Browser
): Promise<void> {
    if (browser) {
        await requestBrowserShutdown(browser)
        await waitForProcessToExit(closePlan.browserOwner, 1_000)
    }

    if ((await getProcessLiveness(closePlan.browserOwner)) !== 'dead') {
        await killOwnedBrowserProcess(closePlan.browserOwner)
        await waitForProcessToExit(closePlan.browserOwner, 2_000)
    }

    await finalizeSharedSessionClose(
        persistentUserDataDir,
        closePlan.sessionId
    )
}

async function finalizeSharedSessionClose(
    persistentUserDataDir: string,
    sessionId: string
): Promise<void> {
    await withSharedSessionLock(persistentUserDataDir, async () => {
        const metadata = await readSharedSessionMetadata(persistentUserDataDir)
        if (!metadata || metadata.sessionId !== sessionId) {
            return
        }

        const liveClients = await listLiveSharedSessionClients(
            persistentUserDataDir
        )
        if (liveClients.length > 0) {
            const readyMetadata: SharedSessionMetadata = {
                ...metadata,
                state: 'ready',
            }
            await writeSharedSessionMetadata(
                persistentUserDataDir,
                readyMetadata
            )
            return
        }

        if ((await getProcessLiveness(metadata.browserOwner)) !== 'dead') {
            const readyMetadata: SharedSessionMetadata = {
                ...metadata,
                state: 'ready',
            }
            await writeSharedSessionMetadata(
                persistentUserDataDir,
                readyMetadata
            )
            return
        }

        await rm(buildSharedSessionDirPath(persistentUserDataDir), {
            force: true,
            recursive: true,
        }).catch(() => undefined)
    })
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

async function getSharedSessionPage(
    context: BrowserContext,
    reuseExistingPage: boolean
): Promise<Page> {
    if (reuseExistingPage) {
        return await getExistingPageOrCreate(context)
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

function buildSharedSessionDiscoveryUrl(debugPort: number): string {
    return `http://127.0.0.1:${debugPort}`
}

async function resolveCdpWebSocketUrl(
    cdpUrl: string,
    timeoutMs: number
): Promise<string> {
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
