import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'

const playwrightMocks = vi.hoisted(() => ({
    launch: vi.fn(),
    connectOverCDP: vi.fn(),
}))

const childProcessMocks = vi.hoisted(() => ({
    spawn: vi.fn(),
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

import { BrowserPool } from '../../src/browser/pool.js'

type TestPage = {
    url: () => string
    waitForLoadState?: (
        state: string,
        options?: { timeout?: number }
    ) => Promise<void>
}

describe('BrowserPool', () => {
    beforeEach(() => {
        playwrightMocks.launch.mockReset()
        playwrightMocks.connectOverCDP.mockReset()
        childProcessMocks.spawn.mockReset()
        vi.unstubAllGlobals()
    })

    it('launches a copied real-browser profile over CDP', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-browser-pool-'))
        const profileDirectory = 'Default'
        const profileDir = join(rootDir, profileDirectory)
        await mkdir(profileDir, { recursive: true })
        await writeFile(join(rootDir, 'Local State'), '{}')
        await writeFile(join(profileDir, 'Cookies'), '')

        const startupPage = {
            url: () => 'chrome://new-tab-page/',
        }
        let pages: TestPage[] = [startupPage]
        const page = {
            url: () => 'https://example.com',
            waitForLoadState: vi.fn(async () => undefined),
        }
        const context = {
            pages: () => pages,
        }
        const browserSession = {
            send: vi.fn(async (method: string) => {
                if (method === 'Target.createTarget') {
                    pages = [startupPage, page]
                    return { targetId: 'target-1' }
                }
                if (method === 'Target.getTargets') {
                    return {
                        targetInfos: [
                            {
                                targetId: 'startup-1',
                                type: 'page',
                                url: 'chrome://new-tab-page/',
                            },
                            {
                                targetId: 'target-1',
                                type: 'page',
                                url: 'https://example.com',
                            },
                        ],
                    }
                }
                return {}
            }),
            detach: vi.fn(async () => undefined),
        }
        const browser = {
            close: vi.fn(async () => undefined),
            contexts: () => [context],
            newBrowserCDPSession: vi.fn(async () => browserSession),
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

        expect(session.page).toBe(page)
        expect(childProcessMocks.spawn).toHaveBeenCalledWith(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            expect.arrayContaining([
                expect.stringMatching(/^--user-data-dir=/),
                '--profile-directory=Default',
                expect.stringMatching(/^--remote-debugging-port=/),
            ]),
            expect.objectContaining({
                stdio: 'ignore',
            })
        )
        expect(browser.newBrowserCDPSession).toHaveBeenCalledOnce()
        expect(browserSession.send).toHaveBeenNthCalledWith(
            1,
            'Target.createTarget',
            {
                url: 'https://example.com',
                newWindow: true,
            }
        )
        expect(browserSession.send).toHaveBeenNthCalledWith(
            2,
            'Target.activateTarget',
            { targetId: 'target-1' }
        )
        expect(browserSession.send).toHaveBeenNthCalledWith(3, 'Target.getTargets')
        expect(browserSession.send).toHaveBeenNthCalledWith(
            4,
            'Target.closeTarget',
            { targetId: 'startup-1' }
        )
        expect(page.waitForLoadState).toHaveBeenCalledWith(
            'domcontentloaded',
            { timeout: 30_000 }
        )
        expect(browserSession.detach).toHaveBeenCalledOnce()

        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation(() => true)
        await pool.close()
        processKill.mockRestore()

        expect(browser.close).toHaveBeenCalledOnce()
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

    it('does not wait for navigation when owned real-browser startup opens about:blank', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-browser-pool-'))
        const profileDirectory = 'Default'
        const profileDir = join(rootDir, profileDirectory)
        await mkdir(profileDir, { recursive: true })
        await writeFile(join(rootDir, 'Local State'), '{}')
        await writeFile(join(profileDir, 'Cookies'), '')

        const startupPage = {
            url: () => 'chrome://new-tab-page/',
        }
        let pages: TestPage[] = [startupPage]
        const page = {
            url: () => 'about:blank',
            waitForLoadState: vi.fn(async () => undefined),
        }
        const context = {
            pages: () => pages,
        }
        const browserSession = {
            send: vi.fn(async (method: string) => {
                if (method === 'Target.createTarget') {
                    pages = [startupPage, page]
                    return { targetId: 'target-1' }
                }
                if (method === 'Target.getTargets') {
                    return {
                        targetInfos: [
                            {
                                targetId: 'startup-1',
                                type: 'page',
                                url: 'chrome://new-tab-page/',
                            },
                            {
                                targetId: 'target-1',
                                type: 'page',
                                url: 'about:blank',
                            },
                        ],
                    }
                }
                return {}
            }),
            detach: vi.fn(async () => undefined),
        }
        const browser = {
            close: vi.fn(async () => undefined),
            contexts: () => [context],
            newBrowserCDPSession: vi.fn(async () => browserSession),
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
        expect(page.waitForLoadState).not.toHaveBeenCalled()

        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation(() => true)
        await pool.close()
        processKill.mockRestore()
    })

    it('accepts protocol redirects for owned real-browser startup pages', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-browser-pool-'))
        const profileDirectory = 'Default'
        const profileDir = join(rootDir, profileDirectory)
        await mkdir(profileDir, { recursive: true })
        await writeFile(join(rootDir, 'Local State'), '{}')
        await writeFile(join(profileDir, 'Cookies'), '')

        const startupPage = {
            url: () => 'chrome://new-tab-page/',
        }
        let pages: TestPage[] = [startupPage]
        const page = {
            url: () => 'https://example.com/',
            waitForLoadState: vi.fn(async () => undefined),
        }
        const context = {
            pages: () => pages,
        }
        const browserSession = {
            send: vi.fn(async (method: string) => {
                if (method === 'Target.createTarget') {
                    pages = [startupPage, page]
                    return { targetId: 'target-1' }
                }
                if (method === 'Target.getTargets') {
                    return {
                        targetInfos: [
                            {
                                targetId: 'startup-1',
                                type: 'page',
                                url: 'chrome://new-tab-page/',
                            },
                            {
                                targetId: 'target-1',
                                type: 'page',
                                url: 'https://example.com/',
                            },
                        ],
                    }
                }
                return {}
            }),
            detach: vi.fn(async () => undefined),
        }
        const browser = {
            close: vi.fn(async () => undefined),
            contexts: () => [context],
            newBrowserCDPSession: vi.fn(async () => browserSession),
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
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
        const session = await pool.launch({
            mode: 'real',
            headless: false,
            initialUrl: 'http://example.com/',
            timeout: 1_000,
            userDataDir: rootDir,
            profileDirectory,
            executablePath:
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        })

        expect(session.page).toBe(page)
        expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 100)
        expect(page.waitForLoadState).toHaveBeenCalledWith(
            'domcontentloaded',
            { timeout: 1_000 }
        )

        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation(() => true)
        await pool.close()
        processKill.mockRestore()
        setTimeoutSpy.mockRestore()
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
