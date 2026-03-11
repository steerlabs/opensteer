import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const playwrightMocks = vi.hoisted(() => ({
    connectOverCDP: vi.fn(),
    launch: vi.fn(),
}))

const childProcessMocks = vi.hoisted(() => ({
    spawn: vi.fn(),
}))

const persistentProfileMocks = vi.hoisted(() => ({
    createIsolatedRuntimeProfile: vi.fn(),
    getOrCreatePersistentProfile: vi.fn(),
    persistIsolatedRuntimeProfile: vi.fn(),
}))

describe('BrowserPool real-browser launch cleanup', () => {
    afterEach(() => {
        vi.resetModules()
        vi.restoreAllMocks()
        vi.unmock('playwright')
        vi.unmock('node:child_process')
        vi.unmock('node:net')
        vi.unmock('../../src/browser/persistent-profile.js')
    })

    it('removes the runtime profile when reserving a debug port fails', async () => {
        const runtimeUserDataDir = await mkdtemp(
            join(tmpdir(), 'opensteer-runtime-profile-failed-launch-')
        )
        const persistentUserDataDir = join(
            tmpdir(),
            'opensteer-persistent-profile-failed-launch'
        )

        persistentProfileMocks.getOrCreatePersistentProfile.mockResolvedValue({
            created: false,
            userDataDir: persistentUserDataDir,
        })
        persistentProfileMocks.createIsolatedRuntimeProfile.mockResolvedValue({
            persistentUserDataDir,
            userDataDir: runtimeUserDataDir,
        })
        persistentProfileMocks.persistIsolatedRuntimeProfile.mockResolvedValue(
            undefined
        )

        vi.doMock('playwright', () => ({
            chromium: {
                connectOverCDP: playwrightMocks.connectOverCDP,
                launch: playwrightMocks.launch,
            },
        }))
        vi.doMock('node:child_process', () => ({
            spawn: childProcessMocks.spawn,
        }))
        vi.doMock('../../src/browser/persistent-profile.js', () => ({
            createIsolatedRuntimeProfile:
                persistentProfileMocks.createIsolatedRuntimeProfile,
            getOrCreatePersistentProfile:
                persistentProfileMocks.getOrCreatePersistentProfile,
            persistIsolatedRuntimeProfile:
                persistentProfileMocks.persistIsolatedRuntimeProfile,
        }))
        vi.doMock('node:net', () => ({
            createServer: () => {
                let onError: ((error: Error) => void) | null = null

                return {
                    address: vi.fn(),
                    close: vi.fn(),
                    listen: vi.fn(() => {
                        const error = new Error('listen denied')
                        Object.assign(error, { code: 'EPERM' })
                        onError?.(error)
                    }),
                    on: vi.fn((event: string, handler: (error: Error) => void) => {
                        if (event === 'error') {
                            onError = handler
                        }
                    }),
                    unref: vi.fn(),
                }
            },
        }))

        const { BrowserPool } = await import('../../src/browser/pool.js')
        const pool = new BrowserPool()

        await expect(
            pool.launch({
                mode: 'real',
                executablePath:
                    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            })
        ).rejects.toThrow('listen denied')

        expect(childProcessMocks.spawn).not.toHaveBeenCalled()
        expect(existsSync(runtimeUserDataDir)).toBe(false)
    })
})
