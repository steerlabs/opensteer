import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const persistentProfileMocks = vi.hoisted(() => ({
    getOrCreatePersistentProfile: vi.fn(),
}))

const sharedSessionMocks = vi.hoisted(() => ({
    acquireSharedRealBrowserSession: vi.fn(),
}))

vi.mock('../src/browser/persistent-profile.js', () => ({
    getOrCreatePersistentProfile:
        persistentProfileMocks.getOrCreatePersistentProfile,
}))

vi.mock('../src/browser/shared-real-browser-session.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('../src/browser/shared-real-browser-session.js')>()

    return {
        ...actual,
        acquireSharedRealBrowserSession:
            sharedSessionMocks.acquireSharedRealBrowserSession,
    }
})

import { Opensteer } from '../src/opensteer.js'

describe('Opensteer real-browser launch', () => {
    beforeEach(() => {
        persistentProfileMocks.getOrCreatePersistentProfile.mockReset()
        sharedSessionMocks.acquireSharedRealBrowserSession.mockReset()
    })

    it('defaults launch({ mode: "real" }) to headless', async () => {
        const session = createSharedSessionStub()
        const persistentProfile = {
            created: false,
            userDataDir: join(tmpdir(), 'opensteer-persistent-profile'),
        }
        persistentProfileMocks.getOrCreatePersistentProfile.mockResolvedValue(
            persistentProfile
        )
        sharedSessionMocks.acquireSharedRealBrowserSession.mockResolvedValue(
            session
        )

        const rootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-real-mode-launch-')
        )
        const opensteer = new Opensteer({
            name: 'opensteer-real-mode-launch',
            storage: { rootDir },
        })

        await opensteer.launch({ mode: 'real' })
        await opensteer.close()

        expect(
            sharedSessionMocks.acquireSharedRealBrowserSession
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                headless: true,
                persistentProfile,
                profileDirectory: 'Default',
            })
        )
        expect(session.close).toHaveBeenCalledOnce()
    })

    it('acquires shared real-browser leases for concurrent SDK sessions', async () => {
        const persistentProfile = {
            created: false,
            userDataDir: join(tmpdir(), 'opensteer-persistent-profile'),
        }
        const firstSession = createSharedSessionStub()
        const secondSession = createSharedSessionStub()

        persistentProfileMocks.getOrCreatePersistentProfile.mockResolvedValue(
            persistentProfile
        )
        sharedSessionMocks.acquireSharedRealBrowserSession
            .mockResolvedValueOnce(firstSession)
            .mockResolvedValueOnce(secondSession)

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
        await Promise.all([first.close(), second.close()])

        expect(persistentProfileMocks.getOrCreatePersistentProfile).toHaveBeenCalledTimes(
            2
        )
        expect(
            sharedSessionMocks.acquireSharedRealBrowserSession
        ).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                headless: true,
                persistentProfile,
                profileDirectory: 'Default',
            })
        )
        expect(
            sharedSessionMocks.acquireSharedRealBrowserSession
        ).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                headless: true,
                persistentProfile,
                profileDirectory: 'Default',
            })
        )
        expect(firstSession.close).toHaveBeenCalledOnce()
        expect(secondSession.close).toHaveBeenCalledOnce()
    })
})

function createSharedSessionStub() {
    const page = {
        close: vi.fn(async () => undefined),
    }
    const context = {
        pages: () => [page],
        newPage: vi.fn(async () => page),
    }
    const browser = {
        contexts: () => [context],
        close: vi.fn(async () => undefined),
    }

    return {
        browser,
        close: vi.fn(async () => undefined),
        context,
        page,
    }
}
