import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('persistent profile lock races', () => {
    afterEach(() => {
        vi.resetModules()
        vi.restoreAllMocks()
        vi.unmock('node:fs/promises')
    })

    it('does not delete a lock that was replaced after stale-owner inspection', async () => {
        const sourceRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-lock-race-source-')
        )
        const runtimesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-lock-race-runs-')
        )
        const lockDirPath = `${sourceRootDir}.lock`
        const ownerPath = join(lockDirPath, 'owner.json')

        await writeFile(join(sourceRootDir, 'Local State'), '{"profile":{}}')
        await mkdir(lockDirPath, { recursive: true })
        await writeFile(
            ownerPath,
            JSON.stringify({
                pid: 99999,
                processStartedAtMs: 1,
            })
        )

        const actualFsPromises =
            await vi.importActual<typeof import('node:fs/promises')>(
                'node:fs/promises'
            )

        let replacementInstalled = false

        vi.doMock('node:fs/promises', () => ({
            ...actualFsPromises,
            readFile: vi.fn(
                async (path: string, options?: BufferEncoding) => {
                    const result = await actualFsPromises.readFile(path, options)

                    if (
                        !replacementInstalled &&
                        path === ownerPath
                    ) {
                        replacementInstalled = true
                        await actualFsPromises.rm(lockDirPath, {
                            recursive: true,
                            force: true,
                        })
                        await actualFsPromises.mkdir(lockDirPath, {
                            recursive: true,
                        })
                        await actualFsPromises.writeFile(
                            ownerPath,
                            JSON.stringify({
                                pid: process.pid,
                                processStartedAtMs: Math.floor(
                                    Date.now() - process.uptime() * 1_000
                                ),
                            })
                        )
                    }

                    return result
                }
            ),
        }))

        const { createIsolatedRuntimeProfile } = await import(
            '../../src/browser/persistent-profile.js'
        )

        let resolved = false
        const runtimePromise = createIsolatedRuntimeProfile(
            sourceRootDir,
            runtimesRootDir
        ).then((result) => {
            resolved = true
            return result
        })

        await sleep(200)

        expect(replacementInstalled).toBe(true)
        expect(resolved).toBe(false)
        expect(existsSync(lockDirPath)).toBe(true)

        const replacementOwner = JSON.parse(
            await readFile(ownerPath, 'utf8')
        ) as { pid: number }
        expect(replacementOwner.pid).toBe(process.pid)

        await rm(lockDirPath, {
            recursive: true,
            force: true,
        })

        const runtime = await runtimePromise
        expect(existsSync(runtime.userDataDir)).toBe(true)

        await rm(runtime.userDataDir, {
            recursive: true,
            force: true,
        })
    })

    it('does not delete a live reclaimer after a transient metadata read failure', async () => {
        const sourceRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-reclaimer-race-source-')
        )
        const runtimesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-reclaimer-race-runs-')
        )
        const lockDirPath = `${sourceRootDir}.lock`
        const ownerPath = join(lockDirPath, 'owner.json')
        const reclaimerDirPath = join(lockDirPath, 'reclaimer')
        const reclaimerOwnerPath = join(reclaimerDirPath, 'owner.json')

        await writeFile(join(sourceRootDir, 'Local State'), '{"profile":{}}')
        await mkdir(lockDirPath, { recursive: true })
        await writeFile(
            ownerPath,
            JSON.stringify({
                pid: 99999,
                processStartedAtMs: 1,
            })
        )
        await mkdir(reclaimerDirPath, { recursive: true })
        await writeFile(
            reclaimerOwnerPath,
            JSON.stringify({
                pid: process.pid,
                processStartedAtMs: Math.floor(
                    Date.now() - process.uptime() * 1_000
                ),
            })
        )

        const actualFsPromises =
            await vi.importActual<typeof import('node:fs/promises')>(
                'node:fs/promises'
            )

        let readFailed = false

        vi.doMock('node:fs/promises', () => ({
            ...actualFsPromises,
            readFile: vi.fn(
                async (path: string, options?: BufferEncoding) => {
                    if (!readFailed && path === reclaimerOwnerPath) {
                        readFailed = true
                        const error = new Error('transient reclaimer read failure')
                        Object.assign(error, { code: 'EIO' })
                        throw error
                    }

                    return await actualFsPromises.readFile(path, options)
                }
            ),
        }))

        const { createIsolatedRuntimeProfile } = await import(
            '../../src/browser/persistent-profile.js'
        )

        let resolved = false
        const runtimePromise = createIsolatedRuntimeProfile(
            sourceRootDir,
            runtimesRootDir
        ).then((result) => {
            resolved = true
            return result
        })

        await sleep(200)

        expect(readFailed).toBe(true)
        expect(resolved).toBe(false)
        expect(existsSync(reclaimerDirPath)).toBe(true)

        await rm(lockDirPath, {
            recursive: true,
            force: true,
        })

        const runtime = await runtimePromise
        expect(existsSync(runtime.userDataDir)).toBe(true)

        await rm(runtime.userDataDir, {
            recursive: true,
            force: true,
        })
    })
})

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
}
