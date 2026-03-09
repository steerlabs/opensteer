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
            goto: vi.fn(async () => undefined),
        }
        const context = {
            pages: () => [startupPage],
            waitForEvent: vi.fn(async () => startupPage),
            newPage: vi.fn(async () => startupPage),
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
                expect.stringMatching(/^--user-data-dir=/),
                '--profile-directory=Default',
                expect.stringMatching(/^--remote-debugging-port=/),
            ]),
            expect.objectContaining({
                stdio: 'ignore',
            })
        )
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
        expect(context.waitForEvent).toHaveBeenCalledWith('page', {
            timeout: 1_000,
        })
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
