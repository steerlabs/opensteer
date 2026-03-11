import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const persistentProfileMocks = vi.hoisted(() => ({
    getOrCreatePersistentProfile: vi.fn(),
}))

const sharedSessionMocks = vi.hoisted(() => ({
    acquireSharedRealBrowserSession: vi.fn(),
}))

describe('BrowserPool real-browser launch cleanup', () => {
    afterEach(() => {
        vi.resetModules()
        vi.restoreAllMocks()
        vi.unmock('../../src/browser/persistent-profile.js')
        vi.unmock('../../src/browser/shared-real-browser-session.js')
    })

    it('clears failed shared-session launch state so the next launch can succeed', async () => {
        const persistentProfile = {
            created: false,
            userDataDir: join(tmpdir(), 'opensteer-persistent-profile'),
        }
        const session = createSharedSessionStub()

        persistentProfileMocks.getOrCreatePersistentProfile.mockResolvedValue(
            persistentProfile
        )
        sharedSessionMocks.acquireSharedRealBrowserSession
            .mockRejectedValueOnce(new Error('launch failed'))
            .mockResolvedValueOnce(session)
        mockRealBrowserLaunchDeps()

        const { BrowserPool } = await import('../../src/browser/pool.js')
        const pool = new BrowserPool()

        await expect(
            pool.launch({
                executablePath:
                    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                mode: 'real',
            })
        ).rejects.toThrow('launch failed')

        const recovered = await pool.launch({
            executablePath:
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            mode: 'real',
        })

        expect(recovered.page).toBe(session.page)
        expect(
            sharedSessionMocks.acquireSharedRealBrowserSession
        ).toHaveBeenCalledTimes(2)

        await pool.close()
        expect(session.close).toHaveBeenCalledOnce()
    })

    it('retries a failed shared-session close without losing the releaser', async () => {
        const persistentProfile = {
            created: false,
            userDataDir: join(tmpdir(), 'opensteer-persistent-profile'),
        }
        const session = createSharedSessionStub()
        session.close
            .mockRejectedValueOnce(new Error('close failed'))
            .mockResolvedValueOnce(undefined)

        persistentProfileMocks.getOrCreatePersistentProfile.mockResolvedValue(
            persistentProfile
        )
        sharedSessionMocks.acquireSharedRealBrowserSession.mockResolvedValue(
            session
        )
        mockRealBrowserLaunchDeps()

        const { BrowserPool } = await import('../../src/browser/pool.js')
        const pool = new BrowserPool()

        await pool.launch({
            executablePath:
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            mode: 'real',
        })

        await expect(pool.close()).rejects.toThrow('close failed')
        await expect(pool.close()).resolves.toBeUndefined()

        expect(session.close).toHaveBeenCalledTimes(2)
    })
})

function mockRealBrowserLaunchDeps() {
    vi.doMock('../../src/browser/persistent-profile.js', () => ({
        getOrCreatePersistentProfile:
            persistentProfileMocks.getOrCreatePersistentProfile,
    }))
    vi.doMock(
        '../../src/browser/shared-real-browser-session.js',
        async (importOriginal) => {
            const actual =
                await importOriginal<typeof import('../../src/browser/shared-real-browser-session.js')>()

            return {
                ...actual,
                acquireSharedRealBrowserSession:
                    sharedSessionMocks.acquireSharedRealBrowserSession,
            }
        }
    )
}

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
