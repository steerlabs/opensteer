import { existsSync } from 'node:fs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const childProcessMocks = vi.hoisted(() => ({
    spawn: vi.fn(),
}))

const playwrightMocks = vi.hoisted(() => ({
    connectOverCDP: vi.fn(),
}))

const persistentProfileMocks = vi.hoisted(() => ({
    clearPersistentProfileSingletons: vi.fn(),
    createIsolatedRuntimeProfile: vi.fn(),
    persistIsolatedRuntimeProfile: vi.fn(),
}))

vi.mock('playwright', () => ({
    chromium: {
        connectOverCDP: playwrightMocks.connectOverCDP,
    },
}))

vi.mock('node:child_process', () => ({
    spawn: childProcessMocks.spawn,
}))

vi.mock('../../src/browser/persistent-profile.js', () => ({
    clearPersistentProfileSingletons:
        persistentProfileMocks.clearPersistentProfileSingletons,
    createIsolatedRuntimeProfile:
        persistentProfileMocks.createIsolatedRuntimeProfile,
    persistIsolatedRuntimeProfile:
        persistentProfileMocks.persistIsolatedRuntimeProfile,
}))

describe('real-browser sessions', () => {
    beforeEach(() => {
        childProcessMocks.spawn.mockReset()
        playwrightMocks.connectOverCDP.mockReset()
        persistentProfileMocks.clearPersistentProfileSingletons.mockReset()
        persistentProfileMocks.createIsolatedRuntimeProfile.mockReset()
        persistentProfileMocks.persistIsolatedRuntimeProfile.mockReset()
        vi.unstubAllGlobals()
    })

    afterEach(() => {
        vi.resetModules()
        vi.restoreAllMocks()
    })

    it('launches isolated Chrome processes for concurrent same-profile sessions', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-isolated-real-'))
        const persistentProfile = {
            created: false,
            userDataDir: join(rootDir, 'persistent-profile'),
        }
        const firstRuntime = {
            persistentUserDataDir: persistentProfile.userDataDir,
            userDataDir: join(rootDir, 'runtime-one'),
        }
        const secondRuntime = {
            persistentUserDataDir: persistentProfile.userDataDir,
            userDataDir: join(rootDir, 'runtime-two'),
        }
        const firstProcess = createChildProcessStub(4321)
        const secondProcess = createChildProcessStub(5432)
        const firstBrowser = createConnectedBrowser()
        const secondBrowser = createConnectedBrowser()
        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation(() => true)

        persistentProfileMocks.createIsolatedRuntimeProfile
            .mockResolvedValueOnce(firstRuntime)
            .mockResolvedValueOnce(secondRuntime)
        persistentProfileMocks.persistIsolatedRuntimeProfile.mockResolvedValue(
            undefined
        )
        childProcessMocks.spawn
            .mockReturnValueOnce(firstProcess)
            .mockReturnValueOnce(secondProcess)
        playwrightMocks.connectOverCDP
            .mockResolvedValueOnce(firstBrowser.browser)
            .mockResolvedValueOnce(secondBrowser.browser)
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

        const { acquireSharedRealBrowserSession } = await import(
            '../../src/browser/shared-real-browser-session.js'
        )

        const [firstLease, secondLease] = await Promise.all([
            acquireSharedRealBrowserSession({
                executablePath:
                    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                headless: true,
                persistentProfile,
                profileDirectory: 'Default',
                timeoutMs: 5_000,
            }),
            acquireSharedRealBrowserSession({
                executablePath:
                    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                headless: true,
                persistentProfile,
                profileDirectory: 'Default',
                timeoutMs: 5_000,
            }),
        ])

        expect(
            persistentProfileMocks.createIsolatedRuntimeProfile
        ).toHaveBeenNthCalledWith(1, persistentProfile.userDataDir)
        expect(
            persistentProfileMocks.createIsolatedRuntimeProfile
        ).toHaveBeenNthCalledWith(2, persistentProfile.userDataDir)
        expect(childProcessMocks.spawn.mock.calls[0]?.[1]).toContain(
            `--user-data-dir=${firstRuntime.userDataDir}`
        )
        expect(childProcessMocks.spawn.mock.calls[1]?.[1]).toContain(
            `--user-data-dir=${secondRuntime.userDataDir}`
        )
        expect(firstLease.browser).toBe(firstBrowser.browser)
        expect(secondLease.browser).toBe(secondBrowser.browser)
        expect(firstLease.page).not.toBe(secondLease.page)

        await Promise.all([firstLease.close(), secondLease.close()])

        expect(
            persistentProfileMocks.persistIsolatedRuntimeProfile
        ).toHaveBeenNthCalledWith(
            1,
            firstRuntime.userDataDir,
            persistentProfile.userDataDir
        )
        expect(
            persistentProfileMocks.persistIsolatedRuntimeProfile
        ).toHaveBeenNthCalledWith(
            2,
            secondRuntime.userDataDir,
            persistentProfile.userDataDir
        )
        processKill.mockRestore()
    })

    it('retries a failed persist when closing a session', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-real-retry-'))
        const persistentProfile = {
            created: false,
            userDataDir: join(rootDir, 'persistent-profile'),
        }
        const runtimeProfile = {
            persistentUserDataDir: persistentProfile.userDataDir,
            userDataDir: join(rootDir, 'runtime'),
        }
        const processHandle = createChildProcessStub(6543)
        const browser = createConnectedBrowser()
        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation(() => true)

        persistentProfileMocks.createIsolatedRuntimeProfile.mockResolvedValue(
            runtimeProfile
        )
        persistentProfileMocks.persistIsolatedRuntimeProfile
            .mockRejectedValueOnce(new Error('persist failed'))
            .mockResolvedValueOnce(undefined)
        childProcessMocks.spawn.mockReturnValue(processHandle)
        playwrightMocks.connectOverCDP.mockResolvedValue(browser.browser)
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

        const { acquireSharedRealBrowserSession } = await import(
            '../../src/browser/shared-real-browser-session.js'
        )

        const session = await acquireSharedRealBrowserSession({
            executablePath:
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            headless: true,
            persistentProfile,
            profileDirectory: 'Default',
            timeoutMs: 5_000,
        })

        await expect(session.close()).rejects.toThrow('persist failed')
        await expect(session.close()).resolves.toBeUndefined()

        expect(
            persistentProfileMocks.persistIsolatedRuntimeProfile
        ).toHaveBeenCalledTimes(2)
        processKill.mockRestore()
    })

    it('cleans up the isolated runtime profile when startup fails', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-real-cleanup-'))
        const persistentProfile = {
            created: false,
            userDataDir: join(rootDir, 'persistent-profile'),
        }
        const runtimeProfile = {
            persistentUserDataDir: persistentProfile.userDataDir,
            userDataDir: join(rootDir, 'runtime'),
        }
        const processHandle = createChildProcessStub(7654)
        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation(() => true)

        await mkdir(runtimeProfile.userDataDir, { recursive: true })
        persistentProfileMocks.createIsolatedRuntimeProfile.mockResolvedValue(
            runtimeProfile
        )
        childProcessMocks.spawn.mockReturnValue(processHandle)
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('CDP not ready yet')
            })
        )

        const { acquireSharedRealBrowserSession } = await import(
            '../../src/browser/shared-real-browser-session.js'
        )

        await expect(
            acquireSharedRealBrowserSession({
                executablePath:
                    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                headless: true,
                persistentProfile,
                profileDirectory: 'Default',
                timeoutMs: 50,
            })
        ).rejects.toThrow('Failed to resolve a CDP websocket URL')

        expect(existsSync(runtimeProfile.userDataDir)).toBe(false)
        expect(
            persistentProfileMocks.persistIsolatedRuntimeProfile
        ).not.toHaveBeenCalled()
        processKill.mockRestore()
    })
})

function createChildProcessStub(pid: number) {
    return {
        exitCode: null,
        kill: vi.fn(),
        pid,
        unref: vi.fn(),
    }
}

function createConnectedBrowser() {
    const page = {
        close: vi.fn(async () => undefined),
        goto: vi.fn(async () => undefined),
    }
    const context = {
        pages: () => [page],
        newPage: vi.fn(async () => page),
    }
    const browser = {
        close: vi.fn(async () => undefined),
        contexts: () => [context],
    }

    return {
        browser,
        context,
        page,
    }
}
