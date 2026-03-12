import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const OPENSTEER_META_FILE = '.opensteer-meta.json'
const OPENSTEER_RUNTIME_META_FILE = '.opensteer-runtime.json'

function createDeferred<T = void>(): {
    promise: Promise<T>
    resolve: (value: T | PromiseLike<T>) => void
} {
    let resolve!: (value: T | PromiseLike<T>) => void
    const promise = new Promise<T>((promiseResolve) => {
        resolve = promiseResolve
    })
    return { promise, resolve }
}

describe('persistent profile lock races', () => {
    afterEach(() => {
        vi.resetModules()
        vi.restoreAllMocks()
        vi.unmock('node:child_process')
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

        await seedPersistentProfile(sourceRootDir)
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

        await seedPersistentProfile(sourceRootDir)
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

    it('starts concurrent runtime copies for the same persistent profile before either resolves', async () => {
        const persistentUserDataDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-parallel-source-')
        )
        const runtimesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-parallel-runs-')
        )

        await seedPersistentProfile(persistentUserDataDir)

        const actualFsPromises =
            await vi.importActual<typeof import('node:fs/promises')>(
                'node:fs/promises'
            )

        const copiesReleased = createDeferred()
        const bothCopiesStarted = createDeferred()
        let startedCopies = 0
        let resolvedRuntimes = 0

        vi.doMock('node:fs/promises', () => ({
            ...actualFsPromises,
            cp: vi.fn(
                async (
                    source: string,
                    destination: string,
                    options?: Parameters<typeof actualFsPromises.cp>[2]
                ) => {
                    if (
                        source === persistentUserDataDir &&
                        destination.startsWith(runtimesRootDir)
                    ) {
                        startedCopies += 1
                        if (startedCopies === 2) {
                            bothCopiesStarted.resolve()
                        }
                        await copiesReleased.promise
                        return
                    }

                    return await actualFsPromises.cp(
                        source,
                        destination,
                        options
                    )
                }
            ),
        }))

        const { createIsolatedRuntimeProfile } = await import(
            '../../src/browser/persistent-profile.js'
        )

        const firstPromise = createIsolatedRuntimeProfile(
            persistentUserDataDir,
            runtimesRootDir
        ).then((result) => {
            resolvedRuntimes += 1
            return result
        })
        const secondPromise = createIsolatedRuntimeProfile(
            persistentUserDataDir,
            runtimesRootDir
        ).then((result) => {
            resolvedRuntimes += 1
            return result
        })

        await Promise.race([
            bothCopiesStarted.promise,
            new Promise<never>((_, reject) =>
                setTimeout(
                    () =>
                        reject(
                            new Error(
                                'second runtime copy never started while the first was still blocked'
                            )
                        ),
                    1_000
                )
            ),
        ])

        expect(resolvedRuntimes).toBe(0)

        copiesReleased.resolve()

        const [firstRuntime, secondRuntime] = await Promise.all([
            firstPromise,
            secondPromise,
        ])

        expect(firstRuntime.userDataDir).not.toBe(secondRuntime.userDataDir)

        await Promise.all([
            rm(firstRuntime.userDataDir, {
                recursive: true,
                force: true,
            }),
            rm(secondRuntime.userDataDir, {
                recursive: true,
                force: true,
            }),
        ])
    })

    it('waits for active runtime creation to finish before persisting a runtime', async () => {
        const persistentUserDataDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-persist-waits-source-')
        )
        const runtimesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-persist-waits-runs-')
        )

        await seedPersistentProfile(persistentUserDataDir)
        const existingRuntimeUserDataDir = await seedRuntimeProfile(
            persistentUserDataDir
        )

        const actualFsPromises =
            await vi.importActual<typeof import('node:fs/promises')>(
                'node:fs/promises'
            )

        const copyReleased = createDeferred()
        const copyStarted = createDeferred()
        let persistMaterializationStarted = false

        vi.doMock('node:fs/promises', () => ({
            ...actualFsPromises,
            cp: vi.fn(
                async (
                    source: string,
                    destination: string,
                    options?: Parameters<typeof actualFsPromises.cp>[2]
                ) => {
                    if (
                        source === persistentUserDataDir &&
                        destination.startsWith(runtimesRootDir)
                    ) {
                        copyStarted.resolve()
                        await copyReleased.promise
                        return
                    }

                    return await actualFsPromises.cp(
                        source,
                        destination,
                        options
                    )
                }
            ),
            copyFile: vi.fn(
                async (
                    source: string,
                    destination: string,
                    mode?: Parameters<typeof actualFsPromises.copyFile>[2]
                ) => {
                    persistMaterializationStarted = true
                    return await actualFsPromises.copyFile(
                        source,
                        destination,
                        mode
                    )
                }
            ),
        }))

        const {
            createIsolatedRuntimeProfile,
            persistIsolatedRuntimeProfile,
        } = await import('../../src/browser/persistent-profile.js')

        const creatingRuntimePromise = createIsolatedRuntimeProfile(
            persistentUserDataDir,
            runtimesRootDir
        )

        await copyStarted.promise

        const persistPromise = persistIsolatedRuntimeProfile(
            existingRuntimeUserDataDir,
            persistentUserDataDir
        )

        await sleep(200)

        expect(persistMaterializationStarted).toBe(false)

        copyReleased.resolve()

        const [creatingRuntime] = await Promise.all([
            creatingRuntimePromise,
            persistPromise,
        ])

        await rm(creatingRuntime.userDataDir, {
            recursive: true,
            force: true,
        })
    })

    it('waits for a live shared real-browser session to close before publishing', async () => {
        const persistentUserDataDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-session-waits-source-')
        )

        await seedPersistentProfile(persistentUserDataDir)
        const existingRuntimeUserDataDir = await seedRuntimeProfile(
            persistentUserDataDir
        )
        await seedSharedSession(persistentUserDataDir)

        const actualFsPromises =
            await vi.importActual<typeof import('node:fs/promises')>(
                'node:fs/promises'
            )
        const persistentTempDirPrefix = join(
            dirname(persistentUserDataDir),
            `${basename(persistentUserDataDir)}-tmp-`
        )

        let persistMaterializationStarted = false

        vi.doMock('node:fs/promises', () => ({
            ...actualFsPromises,
            copyFile: vi.fn(
                async (
                    source: string,
                    destination: string,
                    mode?: Parameters<typeof actualFsPromises.copyFile>[2]
                ) => {
                    if (destination.startsWith(persistentTempDirPrefix)) {
                        persistMaterializationStarted = true
                    }

                    return await actualFsPromises.copyFile(
                        source,
                        destination,
                        mode
                    )
                }
            ),
        }))

        const { persistIsolatedRuntimeProfile } = await import(
            '../../src/browser/persistent-profile.js'
        )

        const persistPromise = persistIsolatedRuntimeProfile(
            existingRuntimeUserDataDir,
            persistentUserDataDir
        )

        await sleep(200)

        expect(persistMaterializationStarted).toBe(false)

        await rm(buildSharedSessionDirPath(persistentUserDataDir), {
            recursive: true,
            force: true,
        })

        await persistPromise
    })

    it('reclaims a stale partial shared-session publish before writing', async () => {
        const persistentUserDataDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-session-partial-source-')
        )

        await seedPersistentProfile(persistentUserDataDir)
        const existingRuntimeUserDataDir = await seedRuntimeProfile(
            persistentUserDataDir
        )

        const actualFsPromises =
            await vi.importActual<typeof import('node:fs/promises')>(
                'node:fs/promises'
            )
        const persistentTempDirPrefix = join(
            dirname(persistentUserDataDir),
            `${basename(persistentUserDataDir)}-tmp-`
        )
        const sessionDirPath = buildSharedSessionDirPath(persistentUserDataDir)

        let persistMaterializationStarted = false

        await mkdir(sessionDirPath, { recursive: true })
        await writeFile(join(sessionDirPath, 'session.json.99999.1.partial.tmp'), '{}')

        vi.doMock('node:fs/promises', () => ({
            ...actualFsPromises,
            copyFile: vi.fn(
                async (
                    source: string,
                    destination: string,
                    mode?: Parameters<typeof actualFsPromises.copyFile>[2]
                ) => {
                    if (destination.startsWith(persistentTempDirPrefix)) {
                        persistMaterializationStarted = true
                    }

                    return await actualFsPromises.copyFile(
                        source,
                        destination,
                        mode
                    )
                }
            ),
        }))

        const { persistIsolatedRuntimeProfile } = await import(
            '../../src/browser/persistent-profile.js'
        )

        await persistIsolatedRuntimeProfile(
            existingRuntimeUserDataDir,
            persistentUserDataDir
        )

        expect(persistMaterializationStarted).toBe(true)
        expect(existsSync(sessionDirPath)).toBe(false)
    })

    it('does not treat a transient shared-session metadata read failure as drained', async () => {
        const persistentUserDataDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-session-read-race-source-')
        )

        await seedPersistentProfile(persistentUserDataDir)
        const existingRuntimeUserDataDir = await seedRuntimeProfile(
            persistentUserDataDir
        )
        await seedSharedSession(persistentUserDataDir)

        const actualFsPromises =
            await vi.importActual<typeof import('node:fs/promises')>(
                'node:fs/promises'
            )
        const persistentTempDirPrefix = join(
            dirname(persistentUserDataDir),
            `${basename(persistentUserDataDir)}-tmp-`
        )
        const sessionMetadataPath = join(
            buildSharedSessionDirPath(persistentUserDataDir),
            'session.json'
        )

        let persistMaterializationStarted = false
        let sessionReadFailed = false

        vi.doMock('node:fs/promises', () => ({
            ...actualFsPromises,
            copyFile: vi.fn(
                async (
                    source: string,
                    destination: string,
                    mode?: Parameters<typeof actualFsPromises.copyFile>[2]
                ) => {
                    if (destination.startsWith(persistentTempDirPrefix)) {
                        persistMaterializationStarted = true
                    }

                    return await actualFsPromises.copyFile(
                        source,
                        destination,
                        mode
                    )
                }
            ),
            readFile: vi.fn(
                async (
                    path: Parameters<typeof actualFsPromises.readFile>[0],
                    options?: Parameters<typeof actualFsPromises.readFile>[1]
                ) => {
                    if (!sessionReadFailed && path === sessionMetadataPath) {
                        sessionReadFailed = true
                        const error = new Error('transient session metadata read failure')
                        Object.assign(error, { code: 'EIO' })
                        throw error
                    }

                    return await actualFsPromises.readFile(path, options)
                }
            ),
        }))

        const { persistIsolatedRuntimeProfile } = await import(
            '../../src/browser/persistent-profile.js'
        )

        const persistPromise = persistIsolatedRuntimeProfile(
            existingRuntimeUserDataDir,
            persistentUserDataDir
        )

        await sleep(200)

        expect(sessionReadFailed).toBe(true)
        expect(persistMaterializationStarted).toBe(false)

        await rm(buildSharedSessionDirPath(persistentUserDataDir), {
            recursive: true,
            force: true,
        })

        await persistPromise
    })

    it('waits for a live shared real-browser session to close before copying a runtime snapshot', async () => {
        const persistentUserDataDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-create-session-waits-source-')
        )
        const runtimesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-create-session-waits-runs-')
        )

        await seedPersistentProfile(persistentUserDataDir)
        await seedSharedSession(persistentUserDataDir)

        const actualFsPromises =
            await vi.importActual<typeof import('node:fs/promises')>(
                'node:fs/promises'
            )

        let createCopyStarted = false

        vi.doMock('node:fs/promises', () => ({
            ...actualFsPromises,
            cp: vi.fn(
                async (
                    source: string,
                    destination: string,
                    options?: Parameters<typeof actualFsPromises.cp>[2]
                ) => {
                    if (
                        source === persistentUserDataDir &&
                        destination.startsWith(runtimesRootDir)
                    ) {
                        createCopyStarted = true
                    }

                    return await actualFsPromises.cp(
                        source,
                        destination,
                        options
                    )
                }
            ),
        }))

        const { createIsolatedRuntimeProfile } = await import(
            '../../src/browser/persistent-profile.js'
        )

        let resolved = false
        const createRuntimePromise = createIsolatedRuntimeProfile(
            persistentUserDataDir,
            runtimesRootDir
        ).then((runtime) => {
            resolved = true
            return runtime
        })

        await sleep(200)

        expect(createCopyStarted).toBe(false)
        expect(resolved).toBe(false)

        await rm(buildSharedSessionDirPath(persistentUserDataDir), {
            recursive: true,
            force: true,
        })

        const runtime = await createRuntimePromise
        expect(createCopyStarted).toBe(true)

        await rm(runtime.userDataDir, {
            recursive: true,
            force: true,
        })
    })

    it('blocks new runtime copies while a writer is actively publishing', async () => {
        const persistentUserDataDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-write-blocks-source-')
        )
        const runtimesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-write-blocks-runs-')
        )

        await seedPersistentProfile(persistentUserDataDir)
        const existingRuntimeUserDataDir = await seedRuntimeProfile(
            persistentUserDataDir
        )

        const actualFsPromises =
            await vi.importActual<typeof import('node:fs/promises')>(
                'node:fs/promises'
            )
        const persistentTempDirPrefix = join(
            dirname(persistentUserDataDir),
            `${basename(persistentUserDataDir)}-tmp-`
        )

        const writerReleased = createDeferred()
        const writerStarted = createDeferred()
        let createCopyStarted = false

        vi.doMock('node:fs/promises', () => ({
            ...actualFsPromises,
            copyFile: vi.fn(
                async (
                    source: string,
                    destination: string,
                    mode?: Parameters<typeof actualFsPromises.copyFile>[2]
                ) => {
                    if (destination.startsWith(persistentTempDirPrefix)) {
                        writerStarted.resolve()
                        await writerReleased.promise
                    }

                    return await actualFsPromises.copyFile(
                        source,
                        destination,
                        mode
                    )
                }
            ),
            cp: vi.fn(
                async (
                    source: string,
                    destination: string,
                    options?: Parameters<typeof actualFsPromises.cp>[2]
                ) => {
                    if (
                        source === persistentUserDataDir &&
                        destination.startsWith(runtimesRootDir)
                    ) {
                        createCopyStarted = true
                        return
                    }

                    return await actualFsPromises.cp(
                        source,
                        destination,
                        options
                    )
                }
            ),
        }))

        const {
            createIsolatedRuntimeProfile,
            persistIsolatedRuntimeProfile,
        } = await import('../../src/browser/persistent-profile.js')

        const persistPromise = persistIsolatedRuntimeProfile(
            existingRuntimeUserDataDir,
            persistentUserDataDir
        )

        await writerStarted.promise

        const creatingRuntimePromise = createIsolatedRuntimeProfile(
            persistentUserDataDir,
            runtimesRootDir
        )

        await sleep(200)

        expect(createCopyStarted).toBe(false)

        writerReleased.resolve()

        const creatingRuntime = await creatingRuntimePromise
        await persistPromise

        await rm(creatingRuntime.userDataDir, {
            recursive: true,
            force: true,
        })
    })
})

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
}

async function seedPersistentProfile(
    persistentUserDataDir: string,
    profileDirectory = 'Default'
): Promise<void> {
    await mkdir(join(persistentUserDataDir, profileDirectory), {
        recursive: true,
    })
    await writeFile(join(persistentUserDataDir, 'Local State'), '{"profile":{}}')
    await writeFile(
        join(persistentUserDataDir, OPENSTEER_META_FILE),
        JSON.stringify({
            createdAt: new Date().toISOString(),
            profileDirectory,
            source: persistentUserDataDir,
        })
    )
    await writeFile(
        join(persistentUserDataDir, profileDirectory, 'Cookies'),
        'session-cookie'
    )
}

async function seedRuntimeProfile(
    persistentUserDataDir: string,
    profileDirectory = 'Default'
): Promise<string> {
    const runtimeUserDataDir = await mkdtemp(
        join(tmpdir(), 'opensteer-ready-runtime-')
    )
    await mkdir(join(runtimeUserDataDir, profileDirectory), {
        recursive: true,
    })
    await writeFile(join(runtimeUserDataDir, 'Local State'), '{"profile":{}}')
    await writeFile(
        join(runtimeUserDataDir, profileDirectory, 'Cookies'),
        'runtime-cookie'
    )
    await writeFile(
        join(runtimeUserDataDir, OPENSTEER_RUNTIME_META_FILE),
        JSON.stringify({
            baseEntries: {
                'Local State': {
                    kind: 'file',
                    hash: hashText('{"profile":{}}'),
                },
                [profileDirectory]: {
                    kind: 'directory',
                    hash: null,
                },
                [`${profileDirectory}/Cookies`]: {
                    kind: 'file',
                    hash: hashText('session-cookie'),
                },
            },
            creator: {
                pid: process.pid,
                processStartedAtMs: Math.floor(
                    Date.now() - process.uptime() * 1_000
                ),
            },
            persistentUserDataDir,
            profileDirectory,
        })
    )

    return runtimeUserDataDir
}

function hashText(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

function buildSharedSessionDirPath(persistentUserDataDir: string): string {
    return join(
        dirname(persistentUserDataDir),
        `${basename(persistentUserDataDir)}.session`
    )
}

async function seedSharedSession(
    persistentUserDataDir: string,
    profileDirectory = 'Default'
): Promise<void> {
    const sessionDirPath = buildSharedSessionDirPath(persistentUserDataDir)
    const owner = {
        pid: process.pid,
        processStartedAtMs: Math.floor(Date.now() - process.uptime() * 1_000),
    }

    await mkdir(sessionDirPath, { recursive: true })
    await writeFile(
        join(sessionDirPath, 'session.json'),
        JSON.stringify({
            browserOwner: owner,
            createdAt: new Date().toISOString(),
            debugPort: 9222,
            executablePath:
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            headless: true,
            persistentUserDataDir,
            profileDirectory,
            sessionId: 'live-shared-session',
            state: 'ready',
            stateOwner: owner,
        })
    )
}
