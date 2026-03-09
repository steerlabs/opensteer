import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    clearPersistentProfileSingletons,
    getOrCreatePersistentProfile,
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

        await Promise.all(
            ['SingletonCookie', 'SingletonLock', 'SingletonSocket', 'DevToolsActivePort'].map(
                async (entry) => {
                    await writeFile(join(userDataDir, entry), 'stale')
                }
            )
        )

        await clearPersistentProfileSingletons(userDataDir)

        for (const entry of [
            'SingletonCookie',
            'SingletonLock',
            'SingletonSocket',
            'DevToolsActivePort',
        ]) {
            expect(existsSync(join(userDataDir, entry))).toBe(false)
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
