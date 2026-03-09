import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
})
