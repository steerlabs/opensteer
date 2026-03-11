import { mkdtemp } from 'node:fs/promises'
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

    const ensureLive = (owner: { pid: number; processStartedAtMs: number }) => {
        states.set(key(owner), 'live')
        return owner
    }

    return {
        CURRENT_PROCESS_OWNER: currentOwner,
        getProcessLiveness: vi.fn(
            async (owner: { pid: number; processStartedAtMs: number }) =>
                states.get(key(owner)) ?? 'live'
        ),
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
        },
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
}))

vi.mock('../../src/browser/process-owner.js', () => ({
    CURRENT_PROCESS_OWNER: processOwnerState.CURRENT_PROCESS_OWNER,
    getProcessLiveness: processOwnerState.getProcessLiveness,
    parseProcessOwner: processOwnerState.parseProcessOwner,
    processOwnersEqual: processOwnerState.processOwnersEqual,
    readProcessOwner: processOwnerState.readProcessOwner,
}))

describe('shared real-browser sessions', () => {
    beforeEach(() => {
        childProcessMocks.spawn.mockReset()
        playwrightMocks.connectOverCDP.mockReset()
        persistentProfileMocks.clearPersistentProfileSingletons.mockReset()
        processOwnerState.getProcessLiveness.mockClear()
        processOwnerState.readProcessOwner.mockClear()
        processOwnerState.states.clear()
        processOwnerState.states.set(
            processOwnerState.key(processOwnerState.CURRENT_PROCESS_OWNER),
            'live'
        )
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
        expect(first.context.newPage).toHaveBeenCalledOnce()
        expect(second.context.newPage).toHaveBeenCalledOnce()

        await firstLease.close()
        await secondLease.close()

        expect(first.page.close).toHaveBeenCalledOnce()
        expect(second.page.close).toHaveBeenCalledOnce()
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

    it('reuses the same Chrome process if the first launcher times out before CDP becomes reachable', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-shared-timeout-'))
        const persistentProfile = {
            created: false,
            userDataDir: join(rootDir, 'persistent-profile'),
        }
        const browserOwner = {
            pid: 2468,
            processStartedAtMs: 24_680,
        }
        const recoveredBrowser = createConnectedBrowser(() => {
            processOwnerState.setState(browserOwner, 'dead')
        })
        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation(() => true)

        processOwnerState.readProcessOwner.mockResolvedValue(browserOwner)
        childProcessMocks.spawn.mockReturnValue({
            pid: browserOwner.pid,
            unref: vi.fn(),
        })
        let fetchAttempt = 0
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                fetchAttempt += 1
                if (fetchAttempt === 1) {
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
            headless: true,
            persistentProfile,
            profileDirectory: 'Default',
            timeoutMs: 5_000,
        })

        expect(childProcessMocks.spawn).toHaveBeenCalledTimes(1)
        expect(playwrightMocks.connectOverCDP).toHaveBeenCalledTimes(1)

        await recoveredLease.close()
        expect(recoveredBrowser.cdpSession.send).toHaveBeenCalledWith(
            'Browser.close'
        )
        processKill.mockRestore()
    })
})

function createConnectedBrowser(onBrowserClose?: () => void) {
    const cdpSession = {
        detach: vi.fn(async () => undefined),
        send: vi.fn(async (method: string) => {
            if (method === 'Browser.close') {
                onBrowserClose?.()
            }
        }),
    }
    const page = {
        close: vi.fn(async () => undefined),
    }
    const context = {
        pages: () => [page],
        newPage: vi.fn(async () => page),
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
        page,
    }
}
