import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { expandHome } from './chrome.js'

const OPENSTEER_META_FILE = '.opensteer-meta.json'
const TRANSIENT_PROFILE_ENTRIES = [
    'SingletonCookie',
    'SingletonLock',
    'SingletonSocket',
    'DevToolsActivePort',
] as const

interface PersistentProfileMetadata {
    createdAt: string
    profileDirectory: string
    source: string
}

export interface PersistentProfileResult {
    created: boolean
    userDataDir: string
}

export async function getOrCreatePersistentProfile(
    sourceUserDataDir: string,
    profileDirectory: string,
    profilesRootDir = defaultPersistentProfilesRootDir()
): Promise<PersistentProfileResult> {
    const resolvedSourceUserDataDir = expandHome(sourceUserDataDir)
    const targetUserDataDir = join(
        expandHome(profilesRootDir),
        buildPersistentProfileKey(resolvedSourceUserDataDir, profileDirectory)
    )
    const sourceProfileDir = join(resolvedSourceUserDataDir, profileDirectory)
    const targetProfileDir = join(targetUserDataDir, profileDirectory)

    await mkdir(dirname(targetUserDataDir), { recursive: true })
    if (!existsSync(sourceProfileDir)) {
        throw new Error(
            `Chrome profile "${profileDirectory}" was not found in "${resolvedSourceUserDataDir}".`
        )
    }

    const created = !existsSync(targetUserDataDir)
    if (created) {
        try {
            await mkdir(targetUserDataDir, { recursive: true })
            await cp(sourceProfileDir, targetProfileDir, {
                recursive: true,
            })

            await copyRootFileIfPresent(
                resolvedSourceUserDataDir,
                targetUserDataDir,
                'Local State'
            )
            await copyRootFileIfPresent(
                resolvedSourceUserDataDir,
                targetUserDataDir,
                'First Run'
            )
            await writePersistentProfileMetadata(targetUserDataDir, {
                createdAt: new Date().toISOString(),
                profileDirectory,
                source: resolvedSourceUserDataDir,
            })
        } catch (error) {
            await rm(targetUserDataDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined)
            throw error
        }
    } else if (!existsSync(join(targetUserDataDir, OPENSTEER_META_FILE))) {
        await writePersistentProfileMetadata(targetUserDataDir, {
            createdAt: new Date().toISOString(),
            profileDirectory,
            source: resolvedSourceUserDataDir,
        })
    }

    return {
        created,
        userDataDir: targetUserDataDir,
    }
}

export async function clearPersistentProfileSingletons(
    userDataDir: string
): Promise<void> {
    await Promise.all(
        TRANSIENT_PROFILE_ENTRIES.map((entry) =>
            rm(join(userDataDir, entry), {
                force: true,
                recursive: true,
            }).catch(() => undefined)
        )
    )
}

function buildPersistentProfileKey(
    sourceUserDataDir: string,
    profileDirectory: string
): string {
    const hash = createHash('sha256')
        .update(`${sourceUserDataDir}\u0000${profileDirectory}`)
        .digest('hex')
        .slice(0, 16)
    const sourceLabel = sanitizePathSegment(basename(sourceUserDataDir) || 'user-data')
    const profileLabel = sanitizePathSegment(profileDirectory || 'Default')

    return `${sourceLabel}-${profileLabel}-${hash}`
}

function defaultPersistentProfilesRootDir(): string {
    return join(homedir(), '.opensteer', 'real-browser-profiles')
}

function sanitizePathSegment(value: string): string {
    const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-')
    return sanitized.replace(/^-|-$/g, '') || 'profile'
}

async function copyRootFileIfPresent(
    sourceRootDir: string,
    targetRootDir: string,
    fileName: string
): Promise<void> {
    const sourcePath = join(sourceRootDir, fileName)
    if (!existsSync(sourcePath)) {
        return
    }

    await copyFile(sourcePath, join(targetRootDir, fileName))
}

async function writePersistentProfileMetadata(
    userDataDir: string,
    metadata: PersistentProfileMetadata
): Promise<void> {
    await writeFile(
        join(userDataDir, OPENSTEER_META_FILE),
        JSON.stringify(metadata, null, 2)
    )
}
