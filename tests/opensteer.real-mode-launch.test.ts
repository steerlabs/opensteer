import { mkdtemp } from 'node:fs/promises'
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
    clearPersistentProfileSingletons: vi.fn(),
    getOrCreatePersistentProfile: vi.fn(),
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
    clearPersistentProfileSingletons:
        persistentProfileMocks.clearPersistentProfileSingletons,
    getOrCreatePersistentProfile:
        persistentProfileMocks.getOrCreatePersistentProfile,
}))

import { Opensteer } from '../src/opensteer.js'

describe('Opensteer real-browser launch defaults', () => {
    beforeEach(() => {
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
})
