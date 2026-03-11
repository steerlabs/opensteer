import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'

const playwrightMocks = vi.hoisted(() => ({
    launch: vi.fn(),
    connectOverCDP: vi.fn(),
}))

const childProcessMocks = vi.hoisted(() => ({
    spawn: vi.fn(),
}))

const persistentProfileMocks = vi.hoisted(() => ({
    clearPersistentProfileSingletons: vi.fn(),
    getOrCreatePersistentProfile: vi.fn(),
}))

vi.mock('playwright', () => ({
    chromium: {
        launch: playwrightMocks.launch,
        connectOverCDP: playwrightMocks.connectOverCDP,
    },
}))

vi.mock('node:child_process', () => ({
    spawn: childProcessMocks.spawn,
}))

vi.mock('../../src/browser/persistent-profile.js', () => ({
    clearPersistentProfileSingletons:
        persistentProfileMocks.clearPersistentProfileSingletons,
    getOrCreatePersistentProfile:
        persistentProfileMocks.getOrCreatePersistentProfile,
}))

import { BrowserPool } from '../../src/browser/pool.js'
import { CDPProxy } from '../../src/browser/cdp-proxy.js'

type TestPage = {
    url: () => string
    goto?: (
        url: string,
        options?: { timeout?: number; waitUntil?: string }
    ) => Promise<void>
}

describe('BrowserPool', () => {
    beforeEach(() => {
        playwrightMocks.launch.mockReset()
        playwrightMocks.connectOverCDP.mockReset()
        childProcessMocks.spawn.mockReset()
        persistentProfileMocks.clearPersistentProfileSingletons.mockReset()
        persistentProfileMocks.getOrCreatePersistentProfile.mockReset()
        persistentProfileMocks.getOrCreatePersistentProfile.mockResolvedValue({
            created: false,
            userDataDir: join(tmpdir(), 'opensteer-persistent-profile'),
        })
        persistentProfileMocks.clearPersistentProfileSingletons.mockResolvedValue(
            undefined
        )
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('launches a copied real-browser profile over CDP', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-browser-pool-'))
        const profileDirectory = 'Default'
        const profileDir = join(rootDir, profileDirectory)
        const persistentUserDataDir = await mkdtemp(
            join(tmpdir(), 'opensteer-persistent-profile-')
        )
        await mkdir(profileDir, { recursive: true })
        await writeFile(join(rootDir, 'Local State'), '{}')
        await writeFile(join(profileDir, 'Cookies'), '')
        persistentProfileMocks.getOrCreatePersistentProfile.mockResolvedValue({
            created: true,
            userDataDir: persistentUserDataDir,
        })

        const startupPage: TestPage = {
            url: () => 'chrome://new-tab-page/',
            goto: vi.fn(async () => undefined),
        }
        const page = {
            url: () => 'about:blank',
            goto: vi.fn(async () => undefined),
        }
        const context = {
            pages: () => [startupPage],
            waitForEvent: vi.fn(async () => page),
            newPage: vi.fn(async () => page),
        }
        const browser = {
            close: vi.fn(async () => undefined),
            contexts: () => [context],
        }
        playwrightMocks.connectOverCDP.mockResolvedValue(browser)
        childProcessMocks.spawn.mockReturnValue({
            pid: 4321,
            exitCode: null,
            unref: vi.fn(),
            kill: vi.fn(),
        })
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                json: async () => ({
                    webSocketDebuggerUrl:
                        'ws://127.0.0.1:9222/devtools/browser/root',
                }),
            }))
        )

        const pool = new BrowserPool()
        const session = await pool.launch({
            mode: 'real',
            headless: false,
            initialUrl: 'https://example.com',
            userDataDir: rootDir,
            profileDirectory,
            executablePath:
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        })

        expect(session.page).toBe(startupPage)
        expect(childProcessMocks.spawn).toHaveBeenCalledWith(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            expect.arrayContaining([
                `--user-data-dir=${persistentUserDataDir}`,
                '--profile-directory=Default',
                expect.stringMatching(/^--remote-debugging-port=/),
                '--disable-blink-features=AutomationControlled',
            ]),
            expect.objectContaining({
                stdio: 'ignore',
            })
        )
        expect(childProcessMocks.spawn).toHaveBeenCalledWith(
            expect.any(String),
            expect.not.arrayContaining([
                '--disable-background-networking',
                '--disable-sync',
            ]),
            expect.any(Object)
        )
        expect(persistentProfileMocks.getOrCreatePersistentProfile).toHaveBeenCalledWith(
            rootDir,
            profileDirectory
        )
        expect(
            persistentProfileMocks.clearPersistentProfileSingletons
        ).toHaveBeenCalledWith(persistentUserDataDir)
        expect(startupPage.goto).toHaveBeenCalledWith(
            'https://example.com',
            { timeout: 30_000, waitUntil: 'domcontentloaded' }
        )
        expect(context.waitForEvent).not.toHaveBeenCalled()
        expect(context.newPage).not.toHaveBeenCalled()

        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation(() => true)
        await pool.close()
        processKill.mockRestore()

        expect(browser.close).toHaveBeenCalledOnce()
        expect(existsSync(persistentUserDataDir)).toBe(true)
    })

    it('keeps chromium launches on browserType.launch', async () => {
        const page = {}
        const context = {
            newPage: vi.fn(async () => page),
        }
        const browser = {
            newContext: vi.fn(async () => context),
            close: vi.fn(async () => undefined),
        }
        playwrightMocks.launch.mockResolvedValue(browser)

        const pool = new BrowserPool()
        const session = await pool.launch({
            headless: true,
        })

        expect(session.page).toBe(page)
        expect(playwrightMocks.launch).toHaveBeenCalledWith(
            expect.objectContaining({
                headless: true,
            })
        )
    })

    it('defaults owned real-browser launches to headless when headless is not configured', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-browser-pool-'))
        const profileDirectory = 'Default'
        const profileDir = join(rootDir, profileDirectory)
        await mkdir(profileDir, { recursive: true })
        await writeFile(join(rootDir, 'Local State'), '{}')
        await writeFile(join(profileDir, 'Cookies'), '')

        const page = {
            url: () => 'about:blank',
        }
        const context = {
            pages: () => [page],
        }
        const browser = {
            close: vi.fn(async () => undefined),
            contexts: () => [context],
        }
        playwrightMocks.connectOverCDP.mockResolvedValue(browser)
        childProcessMocks.spawn.mockReturnValue({
            pid: 4321,
            exitCode: null,
            unref: vi.fn(),
            kill: vi.fn(),
        })
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                json: async () => ({
                    webSocketDebuggerUrl:
                        'ws://127.0.0.1:9222/devtools/browser/root',
                }),
            }))
        )

        const pool = new BrowserPool()

        await pool.launch({
            mode: 'real',
            userDataDir: rootDir,
            profileDirectory,
            executablePath:
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        })

        expect(childProcessMocks.spawn).toHaveBeenCalledWith(
            expect.any(String),
            expect.arrayContaining(['--headless=new']),
            expect.any(Object)
        )

        await pool.close()
    })

    it('creates a blank target when attaching to a CDP browser with no pages', async () => {
        const browserServer = new WebSocketServer({
            host: '127.0.0.1',
            port: 0,
        })
        const browserMessages: Record<string, unknown>[] = []

        browserServer.on('connection', (socket) => {
            socket.on('message', (rawData) => {
                const payload = JSON.parse(rawData.toString()) as Record<
                    string,
                    unknown
                >
                browserMessages.push(payload)

                if (payload.method === 'Target.createTarget') {
                    socket.send(
                        JSON.stringify({
                            id: payload.id,
                            result: {
                                targetId: 'blank-target',
                            },
                        })
                    )
                }
            })
        })

        await waitForListening(browserServer)
        const browserPort = getWsServerPort(browserServer)

        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: unknown) => {
                const url = String(input)
                if (url.endsWith('/json')) {
                    return {
                        ok: true,
                        json: async () => [],
                    }
                }

                if (url.endsWith('/json/version')) {
                    return {
                        ok: true,
                        json: async () => ({
                            webSocketDebuggerUrl: `ws://127.0.0.1:${browserPort}/devtools/browser/root`,
                        }),
                    }
                }

                throw new Error(`Unexpected discovery URL: ${url}`)
            })
        )

        const page = {
            url: () => 'about:blank',
        }
        const context = {
            pages: () => [page],
        }
        const browser = {
            close: vi.fn(async () => undefined),
            contexts: () => [context],
        }
        playwrightMocks.connectOverCDP.mockResolvedValue(browser)

        const pool = new BrowserPool()

        try {
            const session = await pool.launch({
                cdpUrl: 'http://127.0.0.1:9222',
            })

            expect(session.page).toBe(page)
            expect(browserMessages).toContainEqual({
                id: 1,
                method: 'Target.createTarget',
                params: {
                    url: 'about:blank',
                },
            })
        } finally {
            await pool.close()
            await closeWsServer(browserServer)
        }
    })

    it('reuses the attached target when a CDP session exposes only an internal page', async () => {
        const internalPage = {
            url: () => 'chrome://new-tab-page/',
        }
        const context = {
            pages: () => [internalPage],
            newPage: vi.fn(async () => {
                throw new Error('should not create a new page')
            }),
        }
        const browser = {
            close: vi.fn(async () => undefined),
            contexts: () => [context],
        }
        playwrightMocks.connectOverCDP.mockResolvedValue(browser)
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: unknown) => {
                const url = String(input)
                if (url.endsWith('/json')) {
                    return {
                        ok: true,
                        json: async () => [
                            {
                                id: 'target-1',
                                type: 'page',
                                url: 'https://example.com',
                                title: 'Example',
                                webSocketDebuggerUrl:
                                    'ws://127.0.0.1:9222/devtools/page/target-1',
                            },
                        ],
                    }
                }

                if (url.endsWith('/json/version')) {
                    return {
                        ok: true,
                        json: async () => ({
                            webSocketDebuggerUrl:
                                'ws://127.0.0.1:9222/devtools/browser/root',
                        }),
                    }
                }

                throw new Error(`Unexpected discovery URL: ${url}`)
            })
        )

        const proxyStart = vi
            .spyOn(CDPProxy.prototype, 'start')
            .mockResolvedValue('ws://127.0.0.1:9000')
        const proxyClose = vi
            .spyOn(CDPProxy.prototype, 'close')
            .mockImplementation(() => undefined)

        const pool = new BrowserPool()

        try {
            const session = await pool.launch({
                cdpUrl: 'http://127.0.0.1:9222',
            })

            expect(session.page).toBe(internalPage)
            expect(context.newPage).not.toHaveBeenCalled()
        } finally {
            await pool.close()
            proxyStart.mockRestore()
            proxyClose.mockRestore()
        }
    })

    it('does not wait for navigation when owned real-browser startup opens about:blank', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-browser-pool-'))
        const profileDirectory = 'Default'
        const profileDir = join(rootDir, profileDirectory)
        await mkdir(profileDir, { recursive: true })
        await writeFile(join(rootDir, 'Local State'), '{}')
        await writeFile(join(profileDir, 'Cookies'), '')

        const page = {
            url: () => 'about:blank',
            goto: vi.fn(async () => undefined),
        }
        const context = {
            pages: () => [page],
            waitForEvent: vi.fn(async () => page),
            newPage: vi.fn(async () => page),
        }
        const browser = {
            close: vi.fn(async () => undefined),
            contexts: () => [context],
        }
        playwrightMocks.connectOverCDP.mockResolvedValue(browser)
        childProcessMocks.spawn.mockReturnValue({
            pid: 4321,
            exitCode: null,
            unref: vi.fn(),
            kill: vi.fn(),
        })
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                json: async () => ({
                    webSocketDebuggerUrl:
                        'ws://127.0.0.1:9222/devtools/browser/root',
                }),
            }))
        )

        const pool = new BrowserPool()
        const session = await pool.launch({
            mode: 'real',
            headless: false,
            userDataDir: rootDir,
            profileDirectory,
            executablePath:
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        })

        expect(session.page).toBe(page)
        expect(page.goto).not.toHaveBeenCalled()
        expect(context.waitForEvent).not.toHaveBeenCalled()
        expect(context.newPage).not.toHaveBeenCalled()

        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation(() => true)
        await pool.close()
        processKill.mockRestore()
    })

    it('creates a new page when Chrome exposes no startup page', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-browser-pool-'))
        const profileDirectory = 'Default'
        const profileDir = join(rootDir, profileDirectory)
        await mkdir(profileDir, { recursive: true })
        await writeFile(join(rootDir, 'Local State'), '{}')
        await writeFile(join(profileDir, 'Cookies'), '')

        const page = {
            url: () => 'about:blank',
            goto: vi.fn(async () => undefined),
        }
        const context = {
            pages: (): TestPage[] => [],
            waitForEvent: vi.fn(async () => {
                const error = new Error('Timed out waiting for page')
                error.name = 'TimeoutError'
                throw error
            }),
            newPage: vi.fn(async () => page),
        }
        const browser = {
            close: vi.fn(async () => undefined),
            contexts: () => [context],
        }
        playwrightMocks.connectOverCDP.mockResolvedValue(browser)
        childProcessMocks.spawn.mockReturnValue({
            pid: 4321,
            exitCode: null,
            unref: vi.fn(),
            kill: vi.fn(),
        })
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                json: async () => ({
                    webSocketDebuggerUrl:
                        'ws://127.0.0.1:9222/devtools/browser/root',
                }),
            }))
        )

        const pool = new BrowserPool()
        const session = await pool.launch({
            mode: 'real',
            headless: false,
            initialUrl: 'https://example.com',
            timeout: 1_000,
            userDataDir: rootDir,
            profileDirectory,
            executablePath:
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        })

        expect(session.page).toBe(page)
        expect(context.waitForEvent).not.toHaveBeenCalled()
        expect(context.newPage).toHaveBeenCalledOnce()
        expect(page.goto).toHaveBeenCalledWith(
            'https://example.com',
            { timeout: 1_000, waitUntil: 'domcontentloaded' }
        )

        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation(() => true)
        await pool.close()
        processKill.mockRestore()
    })

})

async function waitForListening(server: WebSocketServer): Promise<void> {
    if (server.address()) return

    await new Promise<void>((resolve, reject) => {
        const onListening = () => {
            server.off('error', onError)
            resolve()
        }

        const onError = (error: Error) => {
            server.off('listening', onListening)
            reject(error)
        }

        server.once('listening', onListening)
        server.once('error', onError)
    })
}

function getWsServerPort(server: WebSocketServer): number {
    const address = server.address()
    if (!address || typeof address === 'string') {
        throw new Error('Expected websocket server to expose a TCP port.')
    }

    return address.port
}

async function closeWsServer(server: WebSocketServer): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error)
                return
            }

            resolve()
        })
    })
}
