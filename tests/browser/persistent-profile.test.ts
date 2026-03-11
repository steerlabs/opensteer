import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    createIsolatedRuntimeProfile,
    clearPersistentProfileSingletons,
    getOrCreatePersistentProfile,
    persistIsolatedRuntimeProfile,
} from '../../src/browser/persistent-profile.js'

describe('persistent real-browser profiles', () => {
    it('creates a reusable clone with metadata and sentinel files', async () => {
        const sourceRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-source-')
        )
        const profilesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-cache-')
        )
        const profileDirectory = 'Default'
        const sourceProfileDir = join(sourceRootDir, profileDirectory)
        await mkdir(sourceProfileDir, { recursive: true })
        await writeFile(join(sourceRootDir, 'Local State'), '{"profile":{}}')
        await writeFile(join(sourceRootDir, 'First Run'), '')
        await writeFile(join(sourceProfileDir, 'Cookies'), 'session-cookie')

        const first = await getOrCreatePersistentProfile(
            sourceRootDir,
            profileDirectory,
            profilesRootDir
        )

        expect(first.created).toBe(true)
        expect(
            await readFile(join(first.userDataDir, 'Local State'), 'utf8')
        ).toContain('"profile"')
        expect(existsSync(join(first.userDataDir, 'First Run'))).toBe(true)
        expect(
            await readFile(
                join(first.userDataDir, profileDirectory, 'Cookies'),
                'utf8'
            )
        ).toBe('session-cookie')

        const metadata = JSON.parse(
            await readFile(join(first.userDataDir, '.opensteer-meta.json'), 'utf8')
        ) as {
            createdAt: string
            profileDirectory: string
            source: string
        }
        expect(metadata.profileDirectory).toBe(profileDirectory)
        expect(metadata.source).toBe(sourceRootDir)
        expect(metadata.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

        await writeFile(
            join(first.userDataDir, profileDirectory, 'Cookies'),
            'persisted-cookie'
        )

        const second = await getOrCreatePersistentProfile(
            sourceRootDir,
            profileDirectory,
            profilesRootDir
        )
        expect(second.created).toBe(false)
        expect(second.userDataDir).toBe(first.userDataDir)
        expect(
            await readFile(
                join(second.userDataDir, profileDirectory, 'Cookies'),
                'utf8'
            )
        ).toBe('persisted-cookie')
    })

    it('clears stale singleton artifacts before relaunch', async () => {
        const userDataDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-singletons-')
        )
        const metadataPath = join(userDataDir, '.opensteer-meta.json')

        await Promise.all(
            ['SingletonCookie', 'SingletonLock', 'SingletonSocket', 'DevToolsActivePort'].map(
                async (entry) => {
                    await writeFile(join(userDataDir, entry), 'stale')
                }
            )
        )
        await writeFile(metadataPath, '{"profileDirectory":"Default"}')

        await clearPersistentProfileSingletons(userDataDir)

        for (const entry of [
            'SingletonCookie',
            'SingletonLock',
            'SingletonSocket',
            'DevToolsActivePort',
        ]) {
            expect(existsSync(join(userDataDir, entry))).toBe(false)
        }
        expect(existsSync(metadataPath)).toBe(true)
    })

    it('creates isolated runtime copies for concurrent real-browser launches', async () => {
        const sourceRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-runtime-source-')
        )
        const profilesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-runtime-cache-')
        )
        const runtimesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-runtime-runs-')
        )
        const profileDirectory = 'Default'
        const sourceProfileDir = join(sourceRootDir, profileDirectory)
        await mkdir(sourceProfileDir, { recursive: true })
        await writeFile(join(sourceRootDir, 'Local State'), '{"profile":{}}')
        await writeFile(join(sourceProfileDir, 'Cookies'), 'session-cookie')

        const persistentProfile = await getOrCreatePersistentProfile(
            sourceRootDir,
            profileDirectory,
            profilesRootDir
        )

        await writeFile(
            join(persistentProfile.userDataDir, 'SingletonLock'),
            'stale-lock'
        )

        const [firstRuntime, secondRuntime] = await Promise.all([
            createIsolatedRuntimeProfile(
                persistentProfile.userDataDir,
                runtimesRootDir
            ),
            createIsolatedRuntimeProfile(
                persistentProfile.userDataDir,
                runtimesRootDir
            ),
        ])

        expect(firstRuntime.userDataDir).not.toBe(secondRuntime.userDataDir)
        expect(firstRuntime.persistentUserDataDir).toBe(
            persistentProfile.userDataDir
        )
        expect(secondRuntime.persistentUserDataDir).toBe(
            persistentProfile.userDataDir
        )
        expect(
            await readFile(
                join(firstRuntime.userDataDir, profileDirectory, 'Cookies'),
                'utf8'
            )
        ).toBe('session-cookie')
        expect(
            await readFile(
                join(secondRuntime.userDataDir, profileDirectory, 'Cookies'),
                'utf8'
            )
        ).toBe('session-cookie')
        expect(
            existsSync(join(firstRuntime.userDataDir, 'SingletonLock'))
        ).toBe(false)
        expect(
            existsSync(join(secondRuntime.userDataDir, 'SingletonLock'))
        ).toBe(false)

        await writeFile(
            join(firstRuntime.userDataDir, profileDirectory, 'Cookies'),
            'runtime-cookie'
        )

        expect(
            await readFile(
                join(persistentProfile.userDataDir, profileDirectory, 'Cookies'),
                'utf8'
            )
        ).toBe('session-cookie')
        expect(
            await readFile(
                join(secondRuntime.userDataDir, profileDirectory, 'Cookies'),
                'utf8'
            )
        ).toBe('session-cookie')
    })

    it('publishes runtime profile changes back into the persistent snapshot', async () => {
        const sourceRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-publish-source-')
        )
        const profilesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-publish-cache-')
        )
        const runtimesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-publish-runs-')
        )
        const profileDirectory = 'Default'
        const sourceProfileDir = join(sourceRootDir, profileDirectory)
        await mkdir(sourceProfileDir, { recursive: true })
        await writeFile(join(sourceRootDir, 'Local State'), '{"profile":{}}')
        await writeFile(join(sourceRootDir, 'TransportSecurity'), 'source-state')
        await writeFile(join(sourceProfileDir, 'Cookies'), 'session-cookie')

        const persistentProfile = await getOrCreatePersistentProfile(
            sourceRootDir,
            profileDirectory,
            profilesRootDir
        )
        const runtimeProfile = await createIsolatedRuntimeProfile(
            persistentProfile.userDataDir,
            runtimesRootDir
        )

        await writeFile(
            join(runtimeProfile.userDataDir, profileDirectory, 'Cookies'),
            'runtime-cookie'
        )
        await writeFile(
            join(runtimeProfile.userDataDir, 'TransportSecurity'),
            'runtime-state'
        )
        await mkdir(join(runtimeProfile.userDataDir, 'Crashpad'), {
            recursive: true,
        })
        await writeFile(
            join(runtimeProfile.userDataDir, 'Crashpad', 'ignored'),
            'ignore-me'
        )

        await persistIsolatedRuntimeProfile(
            runtimeProfile.userDataDir,
            persistentProfile.userDataDir
        )

        expect(existsSync(runtimeProfile.userDataDir)).toBe(false)
        expect(
            await readFile(
                join(persistentProfile.userDataDir, profileDirectory, 'Cookies'),
                'utf8'
            )
        ).toBe('runtime-cookie')
        expect(
            await readFile(
                join(persistentProfile.userDataDir, 'TransportSecurity'),
                'utf8'
            )
        ).toBe('runtime-state')
        expect(existsSync(join(persistentProfile.userDataDir, 'Crashpad'))).toBe(
            false
        )

        const reopenedRuntime = await createIsolatedRuntimeProfile(
            persistentProfile.userDataDir,
            runtimesRootDir
        )
        expect(
            await readFile(
                join(reopenedRuntime.userDataDir, profileDirectory, 'Cookies'),
                'utf8'
            )
        ).toBe('runtime-cookie')
        await rm(reopenedRuntime.userDataDir, {
            recursive: true,
            force: true,
        })
    })

    it('rejects persisting a runtime into a different persistent profile', async () => {
        const firstSourceRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-source-a-')
        )
        const secondSourceRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-source-b-')
        )
        const profilesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-cross-persist-cache-')
        )
        const runtimesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-cross-persist-runs-')
        )
        const profileDirectory = 'Default'

        await mkdir(join(firstSourceRootDir, profileDirectory), { recursive: true })
        await mkdir(join(secondSourceRootDir, profileDirectory), {
            recursive: true,
        })
        await writeFile(join(firstSourceRootDir, 'Local State'), '{"profile":{}}')
        await writeFile(join(secondSourceRootDir, 'Local State'), '{"profile":{}}')
        await writeFile(
            join(firstSourceRootDir, profileDirectory, 'Cookies'),
            'first-cookie'
        )
        await writeFile(
            join(secondSourceRootDir, profileDirectory, 'Cookies'),
            'second-cookie'
        )

        const firstPersistentProfile = await getOrCreatePersistentProfile(
            firstSourceRootDir,
            profileDirectory,
            profilesRootDir
        )
        const secondPersistentProfile = await getOrCreatePersistentProfile(
            secondSourceRootDir,
            profileDirectory,
            profilesRootDir
        )
        const runtimeProfile = await createIsolatedRuntimeProfile(
            firstPersistentProfile.userDataDir,
            runtimesRootDir
        )

        await expect(
            persistIsolatedRuntimeProfile(
                runtimeProfile.userDataDir,
                secondPersistentProfile.userDataDir
            )
        ).rejects.toThrow(
            `Runtime profile "${runtimeProfile.userDataDir}" does not belong to persistent profile "${secondPersistentProfile.userDataDir}".`
        )

        await rm(runtimeProfile.userDataDir, {
            recursive: true,
            force: true,
        })
    })

    it('merges non-conflicting concurrent runtime updates into the persistent snapshot', async () => {
        const sourceRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-merge-source-')
        )
        const profilesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-merge-cache-')
        )
        const runtimesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-merge-runs-')
        )
        const profileDirectory = 'Default'
        const sourceProfileDir = join(sourceRootDir, profileDirectory)
        await mkdir(sourceProfileDir, { recursive: true })
        await writeFile(join(sourceRootDir, 'Local State'), '{"profile":{}}')
        await writeFile(join(sourceRootDir, 'TransportSecurity'), 'source-state')
        await writeFile(join(sourceProfileDir, 'Cookies'), 'session-cookie')

        const persistentProfile = await getOrCreatePersistentProfile(
            sourceRootDir,
            profileDirectory,
            profilesRootDir
        )
        const [firstRuntime, secondRuntime] = await Promise.all([
            createIsolatedRuntimeProfile(
                persistentProfile.userDataDir,
                runtimesRootDir
            ),
            createIsolatedRuntimeProfile(
                persistentProfile.userDataDir,
                runtimesRootDir
            ),
        ])

        await writeFile(
            join(firstRuntime.userDataDir, 'TransportSecurity'),
            'runtime-root-update'
        )
        await writeFile(
            join(secondRuntime.userDataDir, profileDirectory, 'Cookies'),
            'runtime-profile-update'
        )

        await persistIsolatedRuntimeProfile(
            firstRuntime.userDataDir,
            persistentProfile.userDataDir
        )
        await persistIsolatedRuntimeProfile(
            secondRuntime.userDataDir,
            persistentProfile.userDataDir
        )

        expect(
            await readFile(
                join(persistentProfile.userDataDir, 'TransportSecurity'),
                'utf8'
            )
        ).toBe('runtime-root-update')
        expect(
            await readFile(
                join(persistentProfile.userDataDir, profileDirectory, 'Cookies'),
                'utf8'
            )
        ).toBe('runtime-profile-update')
    })

    it('rejects conflicting concurrent runtime updates to the same path', async () => {
        const sourceRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-conflict-source-')
        )
        const profilesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-conflict-cache-')
        )
        const runtimesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-conflict-runs-')
        )
        const profileDirectory = 'Default'
        const sourceProfileDir = join(sourceRootDir, profileDirectory)
        await mkdir(sourceProfileDir, { recursive: true })
        await writeFile(join(sourceRootDir, 'Local State'), '{"profile":{}}')
        await writeFile(join(sourceProfileDir, 'Cookies'), 'session-cookie')

        const persistentProfile = await getOrCreatePersistentProfile(
            sourceRootDir,
            profileDirectory,
            profilesRootDir
        )
        const [firstRuntime, secondRuntime] = await Promise.all([
            createIsolatedRuntimeProfile(
                persistentProfile.userDataDir,
                runtimesRootDir
            ),
            createIsolatedRuntimeProfile(
                persistentProfile.userDataDir,
                runtimesRootDir
            ),
        ])

        await writeFile(
            join(firstRuntime.userDataDir, profileDirectory, 'Cookies'),
            'runtime-one-cookie'
        )
        await writeFile(
            join(secondRuntime.userDataDir, profileDirectory, 'Cookies'),
            'runtime-two-cookie'
        )

        await persistIsolatedRuntimeProfile(
            firstRuntime.userDataDir,
            persistentProfile.userDataDir
        )
        await expect(
            persistIsolatedRuntimeProfile(
                secondRuntime.userDataDir,
                persistentProfile.userDataDir
            )
        ).rejects.toThrow(
            'Concurrent runtime updates changed "Default/Cookies" differently'
        )

        expect(
            await readFile(
                join(persistentProfile.userDataDir, profileDirectory, 'Cookies'),
                'utf8'
            )
        ).toBe('runtime-one-cookie')

        await rm(secondRuntime.userDataDir, {
            recursive: true,
            force: true,
        })
    })

    it('publishes only one clone when the same profile is created concurrently', async () => {
        const sourceRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-concurrent-source-')
        )
        const profilesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-concurrent-cache-')
        )
        const profileDirectory = 'Default'
        const sourceProfileDir = join(sourceRootDir, profileDirectory)
        await mkdir(sourceProfileDir, { recursive: true })
        await writeFile(join(sourceRootDir, 'Local State'), '{"profile":{}}')
        await writeFile(join(sourceRootDir, 'First Run'), '')

        await Promise.all(
            Array.from({ length: 64 }, (_, index) =>
                writeFile(
                    join(sourceProfileDir, `Cookie-${index}.sqlite`),
                    `cookie-${index}`
                )
            )
        )

        const results = await Promise.all(
            Array.from({ length: 4 }, () =>
                getOrCreatePersistentProfile(
                    sourceRootDir,
                    profileDirectory,
                    profilesRootDir
                )
            )
        )

        expect(results.filter((result) => result.created)).toHaveLength(1)
        expect(new Set(results.map((result) => result.userDataDir)).size).toBe(1)

        const userDataDir = results[0].userDataDir
        expect(
            await readFile(join(userDataDir, 'Local State'), 'utf8')
        ).toContain('"profile"')
        expect(
            await readFile(
                join(userDataDir, profileDirectory, 'Cookie-63.sqlite'),
                'utf8'
            )
        ).toBe('cookie-63')
        expect(existsSync(join(userDataDir, '.opensteer-meta.json'))).toBe(true)
    })

    it('removes orphaned runtime directories before creating a fresh runtime', async () => {
        const sourceRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-runtime-orphan-source-')
        )
        const profilesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-runtime-orphan-cache-')
        )
        const runtimesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-runtime-orphan-runs-')
        )
        const profileDirectory = 'Default'
        const sourceProfileDir = join(sourceRootDir, profileDirectory)
        await mkdir(sourceProfileDir, { recursive: true })
        await writeFile(join(sourceRootDir, 'Local State'), '{"profile":{}}')
        await writeFile(join(sourceProfileDir, 'Cookies'), 'session-cookie')

        const persistentProfile = await getOrCreatePersistentProfile(
            sourceRootDir,
            profileDirectory,
            profilesRootDir
        )
        const firstRuntime = await createIsolatedRuntimeProfile(
            persistentProfile.userDataDir,
            runtimesRootDir
        )
        const firstRuntimeName = basename(firstRuntime.userDataDir)
        const runtimeMarkerIndex = firstRuntimeName.lastIndexOf('-runtime-')
        const runtimePrefix = `${firstRuntimeName.slice(
            0,
            runtimeMarkerIndex
        )}-runtime-`
        await rm(firstRuntime.userDataDir, {
            recursive: true,
            force: true,
        })

        const orphanRuntimeDir = join(
            runtimesRootDir,
            `${runtimePrefix}orphaned`
        )
        await mkdir(orphanRuntimeDir, { recursive: true })
        await writeFile(join(orphanRuntimeDir, 'stale-cookie'), 'stale')

        const recreatedRuntime = await createIsolatedRuntimeProfile(
            persistentProfile.userDataDir,
            runtimesRootDir
        )

        expect(existsSync(orphanRuntimeDir)).toBe(false)
        expect(existsSync(recreatedRuntime.userDataDir)).toBe(true)
        await rm(recreatedRuntime.userDataDir, {
            recursive: true,
            force: true,
        })
    })

    it('preserves runtime directories that are still referenced by a live process', async () => {
        const sourceRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-runtime-live-source-')
        )
        const profilesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-runtime-live-cache-')
        )
        const runtimesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-runtime-live-runs-')
        )
        const profileDirectory = 'Default'
        const sourceProfileDir = join(sourceRootDir, profileDirectory)
        await mkdir(sourceProfileDir, { recursive: true })
        await writeFile(join(sourceRootDir, 'Local State'), '{"profile":{}}')
        await writeFile(join(sourceProfileDir, 'Cookies'), 'session-cookie')

        const persistentProfile = await getOrCreatePersistentProfile(
            sourceRootDir,
            profileDirectory,
            profilesRootDir
        )
        const firstRuntime = await createIsolatedRuntimeProfile(
            persistentProfile.userDataDir,
            runtimesRootDir
        )
        const firstRuntimeName = basename(firstRuntime.userDataDir)
        const runtimeMarkerIndex = firstRuntimeName.lastIndexOf('-runtime-')
        const runtimePrefix = `${firstRuntimeName.slice(
            0,
            runtimeMarkerIndex
        )}-runtime-`
        await rm(firstRuntime.userDataDir, {
            recursive: true,
            force: true,
        })

        const liveRuntimeDir = join(
            runtimesRootDir,
            `${runtimePrefix}live-browser`
        )
        await mkdir(liveRuntimeDir, { recursive: true })
        await writeFile(
            join(liveRuntimeDir, '.opensteer-runtime.json'),
            JSON.stringify({
                baseEntries: {},
                creator: {
                    pid: 99999,
                    processStartedAtMs: 1,
                },
                persistentUserDataDir: persistentProfile.userDataDir,
                profileDirectory,
            })
        )

        const liveProcess = spawn(
            process.execPath,
            [
                '-e',
                'setTimeout(() => {}, 10_000)',
                '--',
                `--user-data-dir=${liveRuntimeDir}`,
            ],
            {
                stdio: 'ignore',
            }
        )

        if (typeof liveProcess.pid !== 'number') {
            throw new Error('failed to spawn runtime-holder process')
        }

        try {
            const recreatedRuntime = await createIsolatedRuntimeProfile(
                persistentProfile.userDataDir,
                runtimesRootDir
            )

            expect(existsSync(liveRuntimeDir)).toBe(true)
            expect(existsSync(recreatedRuntime.userDataDir)).toBe(true)

            await rm(recreatedRuntime.userDataDir, {
                recursive: true,
                force: true,
            })
        } finally {
            liveProcess.kill('SIGKILL')
            await rm(liveRuntimeDir, {
                recursive: true,
                force: true,
            })
        }
    })

    it('removes orphaned temp clone directories before recreating a profile', async () => {
        const sourceRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-orphan-source-')
        )
        const profilesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-orphan-cache-')
        )
        const profileDirectory = 'Default'
        const sourceProfileDir = join(sourceRootDir, profileDirectory)
        await mkdir(sourceProfileDir, { recursive: true })
        await writeFile(join(sourceRootDir, 'Local State'), '{"profile":{}}')
        await writeFile(join(sourceProfileDir, 'Cookies'), 'session-cookie')

        const created = await getOrCreatePersistentProfile(
            sourceRootDir,
            profileDirectory,
            profilesRootDir
        )
        const targetBaseName = basename(created.userDataDir)

        await rm(created.userDataDir, { recursive: true, force: true })

        const orphanTempDir = join(
            profilesRootDir,
            `${targetBaseName}-tmp-999999-1-orphaned`
        )
        await mkdir(orphanTempDir, { recursive: true })
        await writeFile(join(orphanTempDir, 'stale-cookie'), 'stale')

        const recreated = await getOrCreatePersistentProfile(
            sourceRootDir,
            profileDirectory,
            profilesRootDir
        )

        expect(recreated.created).toBe(true)
        expect(existsSync(orphanTempDir)).toBe(false)
        expect(existsSync(recreated.userDataDir)).toBe(true)
    })

    it('restores interrupted replacement backups before recreating a profile', async () => {
        const sourceRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-backup-recovery-source-')
        )
        const profilesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-backup-recovery-cache-')
        )
        const profileDirectory = 'Default'
        const sourceProfileDir = join(sourceRootDir, profileDirectory)
        await mkdir(sourceProfileDir, { recursive: true })
        await writeFile(join(sourceRootDir, 'Local State'), '{"profile":{}}')
        await writeFile(join(sourceProfileDir, 'Cookies'), 'source-cookie')

        const created = await getOrCreatePersistentProfile(
            sourceRootDir,
            profileDirectory,
            profilesRootDir
        )
        const targetBaseName = basename(created.userDataDir)
        const interruptedBackupDir = join(
            profilesRootDir,
            `${targetBaseName}-backup-9999999999999-1234-5678-crash`
        )
        const orphanTempDir = join(
            profilesRootDir,
            `${targetBaseName}-tmp-999999-1-interrupted`
        )

        await writeFile(
            join(created.userDataDir, profileDirectory, 'Cookies'),
            'persisted-cookie'
        )
        await rename(created.userDataDir, interruptedBackupDir)
        await mkdir(orphanTempDir, { recursive: true })
        await writeFile(join(orphanTempDir, 'stale-cookie'), 'stale')

        const recreated = await getOrCreatePersistentProfile(
            sourceRootDir,
            profileDirectory,
            profilesRootDir
        )

        expect(recreated.created).toBe(false)
        expect(recreated.userDataDir).toBe(created.userDataDir)
        expect(existsSync(interruptedBackupDir)).toBe(false)
        expect(existsSync(orphanTempDir)).toBe(false)
        expect(
            await readFile(
                join(recreated.userDataDir, profileDirectory, 'Cookies'),
                'utf8'
            )
        ).toBe('persisted-cookie')
    })

    it('preserves temp clone directories owned by the current live process', async () => {
        const sourceRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-live-source-')
        )
        const profilesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-live-cache-')
        )
        const profileDirectory = 'Default'
        const sourceProfileDir = join(sourceRootDir, profileDirectory)
        await mkdir(sourceProfileDir, { recursive: true })
        await writeFile(join(sourceRootDir, 'Local State'), '{"profile":{}}')
        await writeFile(join(sourceProfileDir, 'Cookies'), 'session-cookie')

        const created = await getOrCreatePersistentProfile(
            sourceRootDir,
            profileDirectory,
            profilesRootDir
        )
        const targetBaseName = basename(created.userDataDir)

        await rm(created.userDataDir, { recursive: true, force: true })

        const processStartedAtMs = Math.floor(Date.now() - process.uptime() * 1_000)
        const liveTempDir = join(
            profilesRootDir,
            `${targetBaseName}-tmp-${process.pid}-${processStartedAtMs}-live`
        )
        await mkdir(liveTempDir, { recursive: true })
        await writeFile(join(liveTempDir, 'in-flight'), 'live')

        await getOrCreatePersistentProfile(
            sourceRootDir,
            profileDirectory,
            profilesRootDir
        )

        expect(existsSync(liveTempDir)).toBe(true)
    })

    it('reclaims stale locks when a live PID has a different start time', async () => {
        const sourceRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-runtime-locked-')
        )
        const runtimesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-runtime-locked-runs-')
        )
        const lockDirPath = `${sourceRootDir}.lock`
        const sleeper = spawn(
            process.execPath,
            ['-e', 'setTimeout(() => {}, 10_000)'],
            {
                stdio: 'ignore',
            }
        )
        const sleeperPid = sleeper.pid

        if (typeof sleeperPid !== 'number') {
            throw new Error('failed to spawn lock-holder process')
        }

        try {
            await mkdir(lockDirPath, { recursive: true })
            await writeFile(
                join(lockDirPath, 'owner.json'),
                JSON.stringify({
                    pid: sleeperPid,
                    processStartedAtMs: 1,
                })
            )
            await writeFile(join(sourceRootDir, 'Local State'), '{"profile":{}}')

            const runtime = await Promise.race([
                createIsolatedRuntimeProfile(sourceRootDir, runtimesRootDir),
                new Promise<never>((_, reject) =>
                    setTimeout(
                        () =>
                            reject(
                                new Error(
                                    'stale foreign lock was not reclaimed in time'
                                )
                            ),
                        1_000
                    )
                ),
            ])

            expect(existsSync(lockDirPath)).toBe(false)
            expect(existsSync(runtime.userDataDir)).toBe(true)

            await rm(runtime.userDataDir, {
                recursive: true,
                force: true,
            })
        } finally {
            sleeper.kill('SIGKILL')
        }
    })

    it('fails when the source profile directory does not exist', async () => {
        const sourceRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-missing-')
        )
        const profilesRootDir = await mkdtemp(
            join(tmpdir(), 'opensteer-profile-cache-')
        )

        await expect(
            getOrCreatePersistentProfile(
                sourceRootDir,
                'Missing',
                profilesRootDir
            )
        ).rejects.toThrow(
            `Chrome profile "Missing" was not found in "${sourceRootDir}".`
        )
    })
})
