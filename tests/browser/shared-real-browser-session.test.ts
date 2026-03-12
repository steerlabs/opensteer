import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
    hasActiveRuntimeProfileCreations: vi.fn(),
}))

const processOwnerState = vi.hoisted(() => {
    const key = (owner: { pid: number; processStartedAtMs: number }) =>
        `${owner.pid}:${owner.processStartedAtMs}`

    const currentOwner = {
        pid: 1001,
        processStartedAtMs: 10_001,
    }
    const states = new Map<string, 'dead' | 'live' | 'unknown'>([
        [key(currentOwner), 'live'],
    ])
    const runningPids = new Set<number>([currentOwner.pid])

    const ensureLive = (owner: { pid: number; processStartedAtMs: number }) => {
        states.set(key(owner), 'live')
        runningPids.add(owner.pid)
        return owner
    }

    return {
        CURRENT_PROCESS_OWNER: currentOwner,
        getProcessLiveness: vi.fn(
            async (owner: { pid: number; processStartedAtMs: number }) =>
                states.get(key(owner)) ?? 'live'
        ),
        isProcessRunning: vi.fn((pid: number) => runningPids.has(pid)),
        key,
        parseProcessOwner: (value: unknown) => {
            if (!value || typeof value !== 'object') {
                return null
            }

            const parsed = value as {
                pid?: unknown
                processStartedAtMs?: unknown
            }
            const pid = Number(parsed.pid)
            const processStartedAtMs = Number(parsed.processStartedAtMs)

            if (!Number.isInteger(pid) || pid <= 0) {
                return null
            }
            if (
                !Number.isInteger(processStartedAtMs) ||
                processStartedAtMs <= 0
            ) {
                return null
            }

            return {
                pid,
                processStartedAtMs,
            }
        },
        processOwnersEqual: (
            left: { pid: number; processStartedAtMs: number } | null,
            right: { pid: number; processStartedAtMs: number } | null
        ) =>
            left?.pid === right?.pid &&
            left?.processStartedAtMs === right?.processStartedAtMs,
        readProcessOwner: vi.fn(async (pid: number) =>
            ensureLive({
                pid,
                processStartedAtMs: pid * 10,
            })
        ),
        setState: (
            owner: { pid: number; processStartedAtMs: number },
            state: 'dead' | 'live' | 'unknown'
        ) => {
            states.set(key(owner), state)
            if (state === 'dead') {
                runningPids.delete(owner.pid)
                return
            }
            runningPids.add(owner.pid)
        },
        setPidRunning: (pid: number, running: boolean) => {
            if (running) {
                runningPids.add(pid)
                return
            }
            runningPids.delete(pid)
        },
        runningPids,
        states,
    }
})

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
    hasActiveRuntimeProfileCreations:
        persistentProfileMocks.hasActiveRuntimeProfileCreations,
}))

vi.mock('../../src/browser/process-owner.js', () => ({
    CURRENT_PROCESS_OWNER: processOwnerState.CURRENT_PROCESS_OWNER,
    getProcessLiveness: processOwnerState.getProcessLiveness,
    isProcessRunning: processOwnerState.isProcessRunning,
    parseProcessOwner: processOwnerState.parseProcessOwner,
    processOwnersEqual: processOwnerState.processOwnersEqual,
    readProcessOwner: processOwnerState.readProcessOwner,
}))

describe('shared real-browser sessions', () => {
    beforeEach(() => {
        childProcessMocks.spawn.mockReset()
        playwrightMocks.connectOverCDP.mockReset()
        persistentProfileMocks.clearPersistentProfileSingletons.mockReset()
        persistentProfileMocks.hasActiveRuntimeProfileCreations.mockReset()
        persistentProfileMocks.hasActiveRuntimeProfileCreations.mockResolvedValue(
            false
        )
        processOwnerState.getProcessLiveness.mockClear()
        processOwnerState.isProcessRunning.mockClear()
        processOwnerState.readProcessOwner.mockClear()
        processOwnerState.states.clear()
        processOwnerState.states.set(
            processOwnerState.key(processOwnerState.CURRENT_PROCESS_OWNER),
            'live'
        )
        processOwnerState.runningPids.clear()
        processOwnerState.runningPids.add(
            processOwnerState.CURRENT_PROCESS_OWNER.pid
        )
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    afterEach(() => {
        vi.resetModules()
    })

    it('launches one shared Chrome process for concurrent same-profile sessions', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-shared-real-'))
        const persistentProfile = {
            created: false,
            userDataDir: join(rootDir, 'persistent-profile'),
        }
        const browserOwner = {
            pid: 4321,
            processStartedAtMs: 43_210,
        }
        const first = createConnectedBrowser(() => {
            processOwnerState.setState(browserOwner, 'dead')
        })
        const second = createConnectedBrowser(() => {
            processOwnerState.setState(browserOwner, 'dead')
        })
        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation((pid: number | NodeJS.Signals) => {
                if (pid === browserOwner.pid || pid === -browserOwner.pid) {
                    processOwnerState.setState(browserOwner, 'dead')
                }
                return true
            })

        processOwnerState.readProcessOwner.mockResolvedValue(browserOwner)
        childProcessMocks.spawn.mockReturnValue({
            pid: browserOwner.pid,
            unref: vi.fn(),
        })
        playwrightMocks.connectOverCDP
            .mockResolvedValueOnce(first.browser)
            .mockResolvedValueOnce(second.browser)
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

        expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1)
        expect(playwrightMocks.connectOverCDP).toHaveBeenCalledTimes(2)
        expect(first.context.newPage).not.toHaveBeenCalled()
        expect(second.context.newPage).toHaveBeenCalledOnce()

        await firstLease.close()
        await secondLease.close()

        expect(first.page.close).toHaveBeenCalledOnce()
        expect(second.createdPage.close).toHaveBeenCalledOnce()
        expect(first.browser.close).toHaveBeenCalledOnce()
        expect(second.browser.close).toHaveBeenCalledOnce()
        expect(
            first.cdpSession.send.mock.calls.length +
                second.cdpSession.send.mock.calls.length
        ).toBe(1)
        expect(first.cdpSession.send.mock.calls[0] ?? second.cdpSession.send.mock.calls[0]).toEqual([
            'Browser.close',
        ])
        expect(processKill).not.toHaveBeenCalled()
        processKill.mockRestore()
    })

    it('waits for persistent-profile writers before starting a shared launch', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-shared-write-'))
        const persistentProfile = {
            created: false,
            userDataDir: join(rootDir, 'persistent-profile'),
        }
        const writeLockDirPath = `${persistentProfile.userDataDir}.lock`
        const browserOwner = {
            pid: 5432,
            processStartedAtMs: 54_320,
        }
        const browserLease = createConnectedBrowser(() => {
            processOwnerState.setState(browserOwner, 'dead')
        })
        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation((pid: number | NodeJS.Signals) => {
                if (pid === browserOwner.pid || pid === -browserOwner.pid) {
                    processOwnerState.setState(browserOwner, 'dead')
                }
                return true
            })

        await mkdir(writeLockDirPath, { recursive: true })
        await writeFile(
            join(writeLockDirPath, 'owner.json'),
            JSON.stringify(processOwnerState.CURRENT_PROCESS_OWNER)
        )

        processOwnerState.readProcessOwner.mockResolvedValue(browserOwner)
        childProcessMocks.spawn.mockReturnValue({
            pid: browserOwner.pid,
            unref: vi.fn(),
        })
        playwrightMocks.connectOverCDP.mockResolvedValue(browserLease.browser)
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

        let resolved = false
        const leasePromise = acquireSharedRealBrowserSession({
            executablePath:
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            headless: true,
            persistentProfile,
            profileDirectory: 'Default',
            timeoutMs: 5_000,
        }).then((lease) => {
            resolved = true
            return lease
        })

        await sleep(200)

        expect(childProcessMocks.spawn).not.toHaveBeenCalled()
        expect(resolved).toBe(false)

        await rm(writeLockDirPath, {
            force: true,
            recursive: true,
        })

        const lease = await leasePromise
        await lease.close()
        processKill.mockRestore()
    })

    it('waits for active runtime snapshot creation before starting a shared launch', async () => {
        const rootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-shared-runtime-create-')
        )
        const persistentProfile = {
            created: false,
            userDataDir: join(rootDir, 'persistent-profile'),
        }
        const browserOwner = {
            pid: 6543,
            processStartedAtMs: 65_430,
        }
        const browserLease = createConnectedBrowser(() => {
            processOwnerState.setState(browserOwner, 'dead')
        })
        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation((pid: number | NodeJS.Signals) => {
                if (pid === browserOwner.pid || pid === -browserOwner.pid) {
                    processOwnerState.setState(browserOwner, 'dead')
                }
                return true
            })

        let runtimeCreationActive = true
        persistentProfileMocks.hasActiveRuntimeProfileCreations.mockImplementation(
            async () => runtimeCreationActive
        )
        processOwnerState.readProcessOwner.mockResolvedValue(browserOwner)
        childProcessMocks.spawn.mockReturnValue({
            pid: browserOwner.pid,
            unref: vi.fn(),
        })
        playwrightMocks.connectOverCDP.mockResolvedValue(browserLease.browser)
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

        let resolved = false
        const leasePromise = acquireSharedRealBrowserSession({
            executablePath:
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            headless: true,
            persistentProfile,
            profileDirectory: 'Default',
            timeoutMs: 5_000,
        }).then((lease) => {
            resolved = true
            return lease
        })

        await sleep(200)

        expect(childProcessMocks.spawn).not.toHaveBeenCalled()
        expect(resolved).toBe(false)

        runtimeCreationActive = false

        const lease = await leasePromise
        await lease.close()
        processKill.mockRestore()
    })

    it('kills a spawned Chrome process if launch setup fails before session metadata is written', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-shared-owner-'))
        const persistentProfile = {
            created: false,
            userDataDir: join(rootDir, 'persistent-profile'),
        }
        const failedPid = 5555
        const recoveredOwner = {
            pid: 6666,
            processStartedAtMs: 66_660,
        }
        const recoveredBrowser = createConnectedBrowser(() => {
            processOwnerState.setState(recoveredOwner, 'dead')
        })
        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation((pid: number | NodeJS.Signals) => {
                if (pid === failedPid || pid === -failedPid) {
                    processOwnerState.setPidRunning(failedPid, false)
                }
                if (
                    pid === recoveredOwner.pid ||
                    pid === -recoveredOwner.pid
                ) {
                    processOwnerState.setState(recoveredOwner, 'dead')
                }
                return true
            })

        processOwnerState.setPidRunning(failedPid, true)
        let browserLaunchCount = 0
        childProcessMocks.spawn.mockImplementation((command: string) => {
            if (command === 'taskkill') {
                processOwnerState.setPidRunning(failedPid, false)
                return {
                    on: vi.fn((event: string, handler: () => void) => {
                        if (event === 'exit') {
                            handler()
                        }
                    }),
                }
            }

            browserLaunchCount += 1
            return browserLaunchCount === 1
                ? {
                      exitCode: null,
                      pid: failedPid,
                      unref: vi.fn(),
                  }
                : {
                      exitCode: null,
                      pid: recoveredOwner.pid,
                      unref: vi.fn(),
                  }
        })
        processOwnerState.readProcessOwner
            .mockRejectedValueOnce(new Error('cannot inspect process'))
            .mockResolvedValue(recoveredOwner)

        const { acquireSharedRealBrowserSession } = await import(
            '../../src/browser/shared-real-browser-session.js'
        )

        const failedLaunch = acquireSharedRealBrowserSession({
            executablePath:
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            headless: true,
            persistentProfile,
            profileDirectory: 'Default',
            timeoutMs: 5_000,
        })

        await expect(failedLaunch).rejects.toThrow('cannot inspect process')
        processOwnerState.setState(recoveredOwner, 'live')
        playwrightMocks.connectOverCDP.mockResolvedValue(recoveredBrowser.browser)
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

        const recoveredLease = await acquireSharedRealBrowserSession({
            executablePath:
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            headless: true,
            persistentProfile,
            profileDirectory: 'Default',
            timeoutMs: 5_000,
        })

        expect(processOwnerState.isProcessRunning(failedPid)).toBe(false)
        await recoveredLease.close()
        processKill.mockRestore()
    })

    it('respects the caller timeout while waiting for the spawned process owner', async () => {
        const rootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-shared-owner-timeout-')
        )
        const persistentProfile = {
            created: false,
            userDataDir: join(rootDir, 'persistent-profile'),
        }
        const failedPid = 7777
        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation((pid: number | NodeJS.Signals) => {
                if (pid === failedPid || pid === -failedPid) {
                    processOwnerState.setPidRunning(failedPid, false)
                }
                return true
            })

        processOwnerState.setPidRunning(failedPid, true)
        childProcessMocks.spawn.mockReturnValue({
            exitCode: null,
            pid: failedPid,
            unref: vi.fn(),
        })
        processOwnerState.readProcessOwner.mockResolvedValue(null)

        const { acquireSharedRealBrowserSession } = await import(
            '../../src/browser/shared-real-browser-session.js'
        )

        const startedAt = Date.now()

        await expect(
            acquireSharedRealBrowserSession({
                executablePath:
                    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                headless: true,
                persistentProfile,
                profileDirectory: 'Default',
                timeoutMs: 120,
            })
        ).rejects.toThrow(
            `Chrome process ${failedPid} did not report a stable process start time.`
        )
        expect(Date.now() - startedAt).toBeLessThan(1_000)
        expect(processOwnerState.isProcessRunning(failedPid)).toBe(false)
        processKill.mockRestore()
    })

    it('reuses Chrome startup tab for the first attached client', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-shared-tab-'))
        const persistentProfile = {
            created: false,
            userDataDir: join(rootDir, 'persistent-profile'),
        }
        const browserOwner = {
            pid: 1357,
            processStartedAtMs: 13_570,
        }
        const startupPage = {
            close: vi.fn(async () => undefined),
            goto: vi.fn(async () => undefined),
        }
        const createdPage = {
            close: vi.fn(async () => undefined),
            goto: vi.fn(async () => undefined),
        }
        const sharedBrowser = createConnectedBrowser({
            createdPage,
            existingPage: startupPage,
            onBrowserClose: () => {
                processOwnerState.setState(browserOwner, 'dead')
            },
        })
        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation((pid: number | NodeJS.Signals) => {
                if (pid === browserOwner.pid || pid === -browserOwner.pid) {
                    processOwnerState.setState(browserOwner, 'dead')
                }
                return true
            })

        processOwnerState.readProcessOwner.mockResolvedValue(browserOwner)
        childProcessMocks.spawn.mockReturnValue({
            exitCode: null,
            pid: browserOwner.pid,
            unref: vi.fn(),
        })
        playwrightMocks.connectOverCDP.mockResolvedValue(sharedBrowser.browser)
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

        const lease = await acquireSharedRealBrowserSession({
            executablePath:
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            headless: true,
            initialUrl: 'https://example.com',
            persistentProfile,
            profileDirectory: 'Default',
            timeoutMs: 5_000,
        })

        expect(lease.page).toBe(startupPage)
        expect(sharedBrowser.context.newPage).not.toHaveBeenCalled()
        expect(startupPage.goto).toHaveBeenCalledWith('https://example.com', {
            timeout: 5_000,
            waitUntil: 'domcontentloaded',
        })

        await lease.close()
        expect(createdPage.close).not.toHaveBeenCalled()
        processKill.mockRestore()
    })

    it('rejects incompatible headless settings while the shared session is live', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-shared-mismatch-'))
        const persistentProfile = {
            created: false,
            userDataDir: join(rootDir, 'persistent-profile'),
        }
        const browserOwner = {
            pid: 9876,
            processStartedAtMs: 98_760,
        }
        const liveBrowser = createConnectedBrowser(() => {
            processOwnerState.setState(browserOwner, 'dead')
        })
        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation((pid: number | NodeJS.Signals) => {
                if (pid === browserOwner.pid || pid === -browserOwner.pid) {
                    processOwnerState.setState(browserOwner, 'dead')
                }
                return true
            })

        processOwnerState.readProcessOwner.mockResolvedValue(browserOwner)
        childProcessMocks.spawn.mockReturnValue({
            pid: browserOwner.pid,
            unref: vi.fn(),
        })
        playwrightMocks.connectOverCDP.mockResolvedValue(liveBrowser.browser)
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

        const lease = await acquireSharedRealBrowserSession({
            executablePath:
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            headless: true,
            persistentProfile,
            profileDirectory: 'Default',
            timeoutMs: 5_000,
        })

        await expect(
            acquireSharedRealBrowserSession({
                executablePath:
                    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                headless: false,
                persistentProfile,
                profileDirectory: 'Default',
                timeoutMs: 5_000,
            })
        ).rejects.toThrow('already running with headless=true')

        await lease.close()
        processKill.mockRestore()
    })

    it('clears failed launch state so retries can relaunch with different settings', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-shared-timeout-'))
        const persistentProfile = {
            created: false,
            userDataDir: join(rootDir, 'persistent-profile'),
        }
        const failedOwner = {
            pid: 2468,
            processStartedAtMs: 24_680,
        }
        const recoveredOwner = {
            pid: 3579,
            processStartedAtMs: 35_790,
        }
        const recoveredBrowser = createConnectedBrowser(() => {
            processOwnerState.setState(recoveredOwner, 'dead')
        })
        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation((pid: number | NodeJS.Signals) => {
                if (pid === failedOwner.pid || pid === -failedOwner.pid) {
                    processOwnerState.setState(failedOwner, 'dead')
                }
                if (
                    pid === recoveredOwner.pid ||
                    pid === -recoveredOwner.pid
                ) {
                    processOwnerState.setState(recoveredOwner, 'dead')
                }
                return true
            })

        processOwnerState.setState(failedOwner, 'live')
        processOwnerState.setState(recoveredOwner, 'live')
        processOwnerState.readProcessOwner
            .mockResolvedValueOnce(failedOwner)
            .mockResolvedValueOnce(recoveredOwner)
        let browserLaunchCount = 0
        childProcessMocks.spawn.mockImplementation(() => {
            browserLaunchCount += 1
            return browserLaunchCount === 1
                ? {
                      pid: failedOwner.pid,
                      unref: vi.fn(),
                  }
                : {
                      pid: recoveredOwner.pid,
                      unref: vi.fn(),
                  }
        })
        let fetchAttempt = 0
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                fetchAttempt += 1
                if (fetchAttempt <= 1) {
                    throw new Error('CDP not ready yet')
                }

                return {
                    ok: true,
                    json: async () => ({
                        webSocketDebuggerUrl:
                            'ws://127.0.0.1:9222/devtools/browser/root',
                    }),
                }
            })
        )
        playwrightMocks.connectOverCDP.mockResolvedValue(recoveredBrowser.browser)

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

        const recoveredLease = await acquireSharedRealBrowserSession({
            executablePath:
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            headless: false,
            persistentProfile,
            profileDirectory: 'Default',
            timeoutMs: 5_000,
        })

        expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2)
        expect(playwrightMocks.connectOverCDP).toHaveBeenCalledTimes(1)
        expect(processOwnerState.isProcessRunning(failedOwner.pid)).toBe(false)

        await recoveredLease.close()
        expect(recoveredBrowser.cdpSession.send).toHaveBeenCalledWith(
            'Browser.close'
        )
        processKill.mockRestore()
    })

    it('shuts down an idle shared browser when the only attach fails', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-shared-attach-'))
        const persistentProfile = {
            created: false,
            userDataDir: join(rootDir, 'persistent-profile'),
        }
        const failedOwner = {
            pid: 8642,
            processStartedAtMs: 86_420,
        }
        const recoveredOwner = {
            pid: 9753,
            processStartedAtMs: 97_530,
        }
        const failingPage = {
            close: vi.fn(async () => undefined),
            goto: vi.fn(async () => {
                throw new Error('navigation failed')
            }),
        }
        const failingBrowser = createConnectedBrowser({
            existingPage: failingPage,
        })
        const recoveredBrowser = createConnectedBrowser(() => {
            processOwnerState.setState(recoveredOwner, 'dead')
        })
        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation((pid: number | NodeJS.Signals) => {
                if (pid === failedOwner.pid || pid === -failedOwner.pid) {
                    processOwnerState.setState(failedOwner, 'dead')
                }
                if (
                    pid === recoveredOwner.pid ||
                    pid === -recoveredOwner.pid
                ) {
                    processOwnerState.setState(recoveredOwner, 'dead')
                }
                return true
            })

        processOwnerState.setState(failedOwner, 'live')
        processOwnerState.setState(recoveredOwner, 'live')
        processOwnerState.readProcessOwner
            .mockResolvedValueOnce(failedOwner)
            .mockResolvedValueOnce(recoveredOwner)
        let browserLaunchCount = 0
        childProcessMocks.spawn.mockImplementation((command: string) => {
            if (command === 'taskkill') {
                processOwnerState.setState(failedOwner, 'dead')
                return {
                    on: vi.fn((event: string, handler: () => void) => {
                        if (event === 'exit') {
                            handler()
                        }
                    }),
                }
            }

            browserLaunchCount += 1
            return browserLaunchCount === 1
                ? {
                      exitCode: null,
                      pid: failedOwner.pid,
                      unref: vi.fn(),
                  }
                : {
                      exitCode: null,
                      pid: recoveredOwner.pid,
                      unref: vi.fn(),
                  }
        })
        playwrightMocks.connectOverCDP
            .mockResolvedValueOnce(failingBrowser.browser)
            .mockResolvedValueOnce(recoveredBrowser.browser)
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

        await expect(
            acquireSharedRealBrowserSession({
                executablePath:
                    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                headless: true,
                initialUrl: 'https://example.com',
                persistentProfile,
                profileDirectory: 'Default',
                timeoutMs: 5_000,
            })
        ).rejects.toThrow('navigation failed')

        const recoveredLease = await acquireSharedRealBrowserSession({
            executablePath:
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            headless: false,
            persistentProfile,
            profileDirectory: 'Default',
            timeoutMs: 5_000,
        })

        expect(browserLaunchCount).toBe(2)

        await recoveredLease.close()
        processKill.mockRestore()
    })
})

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
}

type MockPage = {
    close: ReturnType<typeof vi.fn>
    goto?: ReturnType<typeof vi.fn>
}

function createConnectedBrowser(
    options:
        | {
              createdPage?: MockPage
              existingPage?: MockPage
              onBrowserClose?: () => void
          }
        | (() => void) = {}
) {
    const resolvedOptions =
        typeof options === 'function' ? { onBrowserClose: options } : options
    const cdpSession = {
        detach: vi.fn(async () => undefined),
        send: vi.fn(async (method: string) => {
            if (method === 'Browser.close') {
                resolvedOptions.onBrowserClose?.()
            }
        }),
    }
    const existingPage = resolvedOptions.existingPage ?? {
        close: vi.fn(async () => undefined),
        goto: vi.fn(async () => undefined),
    }
    const createdPage = resolvedOptions.createdPage ?? {
        close: vi.fn(async () => undefined),
        goto: vi.fn(async () => undefined),
    }
    const context = {
        pages: () => [existingPage],
        newPage: vi.fn(async () => createdPage),
    }
    const browser = {
        close: vi.fn(async () => undefined),
        contexts: () => [context],
        newBrowserCDPSession: vi.fn(async () => cdpSession),
    }

    return {
        browser,
        cdpSession,
        context,
        createdPage,
        page: existingPage,
    }
}
