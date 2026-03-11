import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const playwrightMocks = vi.hoisted(() => ({
    connectOverCDP: vi.fn(),
}))

const childProcessMocks = vi.hoisted(() => ({
    spawn: vi.fn(),
}))

const persistentProfileMocks = vi.hoisted(() => ({
    createIsolatedRuntimeProfile: vi.fn(),
    getOrCreatePersistentProfile: vi.fn(),
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

vi.mock('../src/browser/persistent-profile.js', () => ({
    createIsolatedRuntimeProfile:
        persistentProfileMocks.createIsolatedRuntimeProfile,
    getOrCreatePersistentProfile:
        persistentProfileMocks.getOrCreatePersistentProfile,
    persistIsolatedRuntimeProfile:
        persistentProfileMocks.persistIsolatedRuntimeProfile,
}))

import { Opensteer } from '../src/opensteer.js'

describe('Opensteer real-browser launch', () => {
    beforeEach(() => {
        playwrightMocks.connectOverCDP.mockReset()
        childProcessMocks.spawn.mockReset()
        persistentProfileMocks.createIsolatedRuntimeProfile.mockReset()
        persistentProfileMocks.getOrCreatePersistentProfile.mockReset()
        persistentProfileMocks.persistIsolatedRuntimeProfile.mockReset()
        persistentProfileMocks.persistIsolatedRuntimeProfile.mockImplementation(
            async (runtimeUserDataDir: string) => {
                await rm(runtimeUserDataDir, {
                    recursive: true,
                    force: true,
                })
            }
        )
        vi.unstubAllGlobals()
    })

    it('defaults launch({ mode: "real" }) to headless', async () => {
        const page = {
            url: () => 'about:blank',
        }
        const context = {
            pages: () => [page],
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
        persistentProfileMocks.getOrCreatePersistentProfile.mockResolvedValue({
            created: false,
            userDataDir: join(tmpdir(), 'opensteer-persistent-profile'),
        })
        persistentProfileMocks.createIsolatedRuntimeProfile.mockResolvedValue({
            persistentUserDataDir: join(tmpdir(), 'opensteer-persistent-profile'),
            userDataDir: join(tmpdir(), 'opensteer-runtime-profile'),
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

        const rootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-real-mode-launch-')
        )
        const opensteer = new Opensteer({
            name: 'opensteer-real-mode-launch',
            storage: { rootDir },
        })

        await opensteer.launch({ mode: 'real' })

        expect(childProcessMocks.spawn).toHaveBeenCalledWith(
            expect.any(String),
            expect.arrayContaining(['--headless=new']),
            expect.any(Object)
        )

        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation(() => true)
        await opensteer.close()
        processKill.mockRestore()
    })

    it('launches isolated runtime profiles for concurrent SDK real-browser sessions', async () => {
        const runtimeUserDataDirs = [
            await mkdtemp(join(tmpdir(), 'opensteer-sdk-runtime-a-')),
            await mkdtemp(join(tmpdir(), 'opensteer-sdk-runtime-b-')),
        ]
        const pageA = {
            url: () => 'about:blank',
        }
        const pageB = {
            url: () => 'about:blank',
        }
        const contextA = {
            pages: () => [pageA],
            newPage: vi.fn(async () => pageA),
        }
        const contextB = {
            pages: () => [pageB],
            newPage: vi.fn(async () => pageB),
        }
        const browserA = {
            close: vi.fn(async () => undefined),
            contexts: () => [contextA],
        }
        const browserB = {
            close: vi.fn(async () => undefined),
            contexts: () => [contextB],
        }
        playwrightMocks.connectOverCDP
            .mockResolvedValueOnce(browserA)
            .mockResolvedValueOnce(browserB)
        childProcessMocks.spawn
            .mockReturnValueOnce({
                pid: 4321,
                exitCode: null,
                unref: vi.fn(),
                kill: vi.fn(),
            })
            .mockReturnValueOnce({
                pid: 4322,
                exitCode: null,
                unref: vi.fn(),
                kill: vi.fn(),
            })
        persistentProfileMocks.getOrCreatePersistentProfile.mockResolvedValue({
            created: false,
            userDataDir: join(tmpdir(), 'opensteer-persistent-profile'),
        })
        persistentProfileMocks.createIsolatedRuntimeProfile
            .mockResolvedValueOnce({
                persistentUserDataDir: join(
                    tmpdir(),
                    'opensteer-persistent-profile'
                ),
                userDataDir: runtimeUserDataDirs[0],
            })
            .mockResolvedValueOnce({
                persistentUserDataDir: join(
                    tmpdir(),
                    'opensteer-persistent-profile'
                ),
                userDataDir: runtimeUserDataDirs[1],
            })
        vi.stubGlobal(
            'fetch',
            vi.fn(async (_input: unknown) => ({
                ok: true,
                json: async () => ({
                    webSocketDebuggerUrl:
                        'ws://127.0.0.1:9222/devtools/browser/root',
                }),
            }))
        )

        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-sdk-real-'))
        const first = new Opensteer({
            name: 'sdk-real-first',
            storage: { rootDir },
        })
        const second = new Opensteer({
            name: 'sdk-real-second',
            storage: { rootDir },
        })

        await Promise.all([
            first.launch({ mode: 'real', headless: true }),
            second.launch({ mode: 'real', headless: true }),
        ])

        expect(persistentProfileMocks.getOrCreatePersistentProfile).toHaveBeenCalledTimes(
            2
        )
        expect(
            persistentProfileMocks.createIsolatedRuntimeProfile
        ).toHaveBeenNthCalledWith(
            1,
            join(tmpdir(), 'opensteer-persistent-profile')
        )
        expect(
            persistentProfileMocks.createIsolatedRuntimeProfile
        ).toHaveBeenNthCalledWith(
            2,
            join(tmpdir(), 'opensteer-persistent-profile')
        )
        expect(childProcessMocks.spawn).toHaveBeenNthCalledWith(
            1,
            expect.any(String),
            expect.arrayContaining([
                `--user-data-dir=${runtimeUserDataDirs[0]}`,
                '--headless=new',
            ]),
            expect.any(Object)
        )
        expect(childProcessMocks.spawn).toHaveBeenNthCalledWith(
            2,
            expect.any(String),
            expect.arrayContaining([
                `--user-data-dir=${runtimeUserDataDirs[1]}`,
                '--headless=new',
            ]),
            expect.any(Object)
        )

        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation(() => true)
        await Promise.all([first.close(), second.close()])
        processKill.mockRestore()

        expect(browserA.close).toHaveBeenCalledOnce()
        expect(browserB.close).toHaveBeenCalledOnce()
        expect(existsSync(runtimeUserDataDirs[0])).toBe(false)
        expect(existsSync(runtimeUserDataDirs[1])).toBe(false)
    })

    it('keeps the SDK closable when runtime persistence fails', async () => {
        const runtimeUserDataDirs = [
            await mkdtemp(join(tmpdir(), 'opensteer-sdk-retry-runtime-a-')),
            await mkdtemp(join(tmpdir(), 'opensteer-sdk-retry-runtime-b-')),
        ]
        const pageA = {
            url: () => 'about:blank',
        }
        const pageB = {
            url: () => 'about:blank',
        }
        const contextA = {
            pages: () => [pageA],
            newPage: vi.fn(async () => pageA),
        }
        const contextB = {
            pages: () => [pageB],
            newPage: vi.fn(async () => pageB),
        }
        const browserA = {
            close: vi.fn(async () => undefined),
            contexts: () => [contextA],
        }
        const browserB = {
            close: vi.fn(async () => undefined),
            contexts: () => [contextB],
        }
        playwrightMocks.connectOverCDP
            .mockResolvedValueOnce(browserA)
            .mockResolvedValueOnce(browserB)
        childProcessMocks.spawn
            .mockReturnValueOnce({
                pid: 4321,
                exitCode: null,
                unref: vi.fn(),
                kill: vi.fn(),
            })
            .mockReturnValueOnce({
                pid: 4322,
                exitCode: null,
                unref: vi.fn(),
                kill: vi.fn(),
            })
        persistentProfileMocks.getOrCreatePersistentProfile.mockResolvedValue({
            created: false,
            userDataDir: join(tmpdir(), 'opensteer-persistent-profile'),
        })
        persistentProfileMocks.createIsolatedRuntimeProfile
            .mockResolvedValueOnce({
                persistentUserDataDir: join(
                    tmpdir(),
                    'opensteer-persistent-profile'
                ),
                userDataDir: runtimeUserDataDirs[0],
            })
            .mockResolvedValueOnce({
                persistentUserDataDir: join(
                    tmpdir(),
                    'opensteer-persistent-profile'
                ),
                userDataDir: runtimeUserDataDirs[1],
            })
        persistentProfileMocks.persistIsolatedRuntimeProfile
            .mockRejectedValueOnce(new Error('persist failed'))
            .mockImplementation(async (runtimeUserDataDir: string) => {
                await rm(runtimeUserDataDir, {
                    recursive: true,
                    force: true,
                })
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

        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-sdk-retry-'))
        const opensteer = new Opensteer({
            name: 'sdk-real-retry',
            storage: { rootDir },
        })

        await opensteer.launch({ mode: 'real', headless: true })

        const processKill = vi
            .spyOn(process, 'kill')
            .mockImplementation(() => true)

        await expect(opensteer.close()).rejects.toThrow('persist failed')
        await opensteer.close()
        await opensteer.launch({ mode: 'real', headless: true })
        await opensteer.close()

        processKill.mockRestore()

        expect(
            persistentProfileMocks.persistIsolatedRuntimeProfile
        ).toHaveBeenNthCalledWith(
            1,
            runtimeUserDataDirs[0],
            join(tmpdir(), 'opensteer-persistent-profile')
        )
        expect(
            persistentProfileMocks.persistIsolatedRuntimeProfile
        ).toHaveBeenNthCalledWith(
            2,
            runtimeUserDataDirs[0],
            join(tmpdir(), 'opensteer-persistent-profile')
        )
        expect(
            persistentProfileMocks.createIsolatedRuntimeProfile
        ).toHaveBeenNthCalledWith(
            2,
            join(tmpdir(), 'opensteer-persistent-profile')
        )
        expect(
            persistentProfileMocks.persistIsolatedRuntimeProfile
        ).toHaveBeenNthCalledWith(
            3,
            runtimeUserDataDirs[1],
            join(tmpdir(), 'opensteer-persistent-profile')
        )
        expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2)
    })
})
