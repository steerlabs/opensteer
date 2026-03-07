import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const playwrightMocks = vi.hoisted(() => ({
    launch: vi.fn(),
    launchPersistentContext: vi.fn(),
    connectOverCDP: vi.fn(),
}))

vi.mock('playwright', () => ({
    chromium: {
        launch: playwrightMocks.launch,
        launchPersistentContext: playwrightMocks.launchPersistentContext,
        connectOverCDP: playwrightMocks.connectOverCDP,
    },
}))

import { BrowserPool } from '../../src/browser/pool.js'

describe('BrowserPool', () => {
    beforeEach(() => {
        playwrightMocks.launch.mockReset()
        playwrightMocks.launchPersistentContext.mockReset()
        playwrightMocks.connectOverCDP.mockReset()
    })

    it('uses launchPersistentContext for profile directory launches', async () => {
        const rootDir = await mkdtemp(join(tmpdir(), 'opensteer-browser-pool-'))
        const profileDir = join(rootDir, 'Default')
        await mkdir(profileDir, { recursive: true })
        await writeFile(join(rootDir, 'Local State'), '{}')
        await writeFile(join(profileDir, 'Cookies'), '')

        const page = {}
        const browserClose = vi.fn(async () => undefined)
        const contextClose = vi.fn(async () => undefined)
        const browser = {
            close: browserClose,
        }
        const context = {
            browser: () => browser,
            pages: () => [page],
            newPage: vi.fn(async () => page),
            close: contextClose,
        }
        playwrightMocks.launchPersistentContext.mockResolvedValue(context)

        const pool = new BrowserPool()
        const session = await pool.launch({
            profileDir,
            headless: true,
        })

        expect(session.page).toBe(page)
        expect(playwrightMocks.launchPersistentContext).toHaveBeenCalledWith(
            rootDir,
            expect.objectContaining({
                headless: true,
                args: ['--profile-directory=Default'],
            })
        )

        await pool.close()

        expect(contextClose).toHaveBeenCalledOnce()
        expect(browserClose).not.toHaveBeenCalled()
    })

    it('keeps channel-only launches on browserType.launch', async () => {
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
            channel: 'chrome',
            headless: true,
        })

        expect(session.page).toBe(page)
        expect(playwrightMocks.launch).toHaveBeenCalledWith(
            expect.objectContaining({
                channel: 'chrome',
                headless: true,
            })
        )
        expect(playwrightMocks.launchPersistentContext).not.toHaveBeenCalled()
    })
})
