import { createHash } from 'node:crypto'
import { existsSync, type Dirent } from 'node:fs'
import {
    cp,
    copyFile,
    mkdir,
    mkdtemp,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { expandHome } from './chrome.js'

const OPENSTEER_META_FILE = '.opensteer-meta.json'
const PROCESS_STARTED_AT_MS = Math.floor(Date.now() - process.uptime() * 1_000)
const PROCESS_START_TIME_TOLERANCE_MS = 1_000

/**
 * Entries that Chrome recreates at runtime and must be cleared before launch.
 */
const CHROME_SINGLETON_ENTRIES = new Set([
    'SingletonCookie',
    'SingletonLock',
    'SingletonSocket',
    'DevToolsActivePort',
    'lockfile',
])

/**
 * Entries that should never be copied from the source user-data-dir into a
 * persistent clone.
 */
const COPY_SKIP_ENTRIES = new Set([
    ...CHROME_SINGLETON_ENTRIES,
    OPENSTEER_META_FILE,
])

/**
 * Root-level directories that are large, regenerated automatically by Chrome,
 * or contain data irrelevant to device identity. Skipping these keeps the
 * cloned profile lean without sacrificing authenticity.
 */
const SKIPPED_ROOT_DIRECTORIES = new Set([
    'Crash Reports',
    'Crashpad',
    'BrowserMetrics',
    'GrShaderCache',
    'ShaderCache',
    'GraphiteDawnCache',
    'component_crx_cache',
    'Crowd Deny',
    'hyphen-data',
    'OnDeviceHeadSuggestModel',
    'OptimizationGuidePredictionModels',
    'Segmentation Platform',
    'SmartCardDeviceNames',
    'WidevineCdm',
    'pnacl',
])

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
    const metadata = buildPersistentProfileMetadata(
        resolvedSourceUserDataDir,
        profileDirectory
    )

    await mkdir(dirname(targetUserDataDir), { recursive: true })
    await cleanOrphanedTempDirs(
        dirname(targetUserDataDir),
        basename(targetUserDataDir)
    )
    if (!existsSync(sourceProfileDir)) {
        throw new Error(
            `Chrome profile "${profileDirectory}" was not found in "${resolvedSourceUserDataDir}".`
        )
    }

    const created = await createPersistentProfileClone(
        resolvedSourceUserDataDir,
        sourceProfileDir,
        targetUserDataDir,
        profileDirectory,
        metadata
    )

    await ensurePersistentProfileMetadata(targetUserDataDir, metadata)

    return {
        created,
        userDataDir: targetUserDataDir,
    }
}

export async function clearPersistentProfileSingletons(
    userDataDir: string
): Promise<void> {
    await Promise.all(
        [...CHROME_SINGLETON_ENTRIES].map((entry) =>
            rm(join(userDataDir, entry), {
                force: true,
                recursive: true,
            }).catch(() => undefined)
        )
    )
}

export async function createIsolatedRuntimeProfile(
    sourceUserDataDir: string,
    runtimesRootDir = defaultRuntimeProfilesRootDir()
): Promise<{ userDataDir: string }> {
    const resolvedSourceUserDataDir = expandHome(sourceUserDataDir)
    const runtimeRootDir = expandHome(runtimesRootDir)
    await mkdir(runtimeRootDir, { recursive: true })

    const runtimeUserDataDir = await mkdtemp(
        join(
            runtimeRootDir,
            `${sanitizePathSegment(
                basename(resolvedSourceUserDataDir) || 'profile'
            )}-runtime-`
        )
    )

    try {
        await cp(resolvedSourceUserDataDir, runtimeUserDataDir, {
            recursive: true,
        })
        await clearPersistentProfileSingletons(runtimeUserDataDir)

        return {
            userDataDir: runtimeUserDataDir,
        }
    } catch (error) {
        await rm(runtimeUserDataDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined)
        throw error
    }
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

function defaultRuntimeProfilesRootDir(): string {
    return join(tmpdir(), 'opensteer-real-browser-runtimes')
}

function sanitizePathSegment(value: string): string {
    const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-')
    return sanitized.replace(/^-|-$/g, '') || 'profile'
}

/**
 * Determines whether a root-level entry in the user-data-dir is a Chrome
 * profile directory (e.g. "Default", "Profile 1", "Profile 2", etc.).
 * Chrome profiles always contain a Preferences file.
 */
function isProfileDirectory(userDataDir: string, entry: string): boolean {
    return existsSync(join(userDataDir, entry, 'Preferences'))
}

/**
 * Copies all root-level files and small identity-relevant directories from the
 * source user-data-dir to the target, skipping transient files, large caches,
 * and other Chrome profile subdirectories (we only want the one target profile).
 *
 * This ensures the cloned profile retains the full device identity: encryption
 * keys (Local State), A/B test state (Variations Seed), certificate revocation
 * lists, origin trial tokens, safe browsing data, and other markers that make
 * the browser instance look identical to the user's real Chrome.
 */
async function copyRootLevelEntries(
    sourceUserDataDir: string,
    targetUserDataDir: string,
    targetProfileDirectory: string
): Promise<void> {
    let entries: string[]
    try {
        entries = await readdir(sourceUserDataDir)
    } catch {
        return
    }

    const copyTasks: Promise<void>[] = []

    for (const entry of entries) {
        // Skip runtime artifacts and Opensteer bookkeeping files
        if (COPY_SKIP_ENTRIES.has(entry)) continue

        // Skip the target profile directory (already copied separately)
        if (entry === targetProfileDirectory) continue

        const sourcePath = join(sourceUserDataDir, entry)
        const targetPath = join(targetUserDataDir, entry)

        // Skip if already exists in target (don't overwrite)
        if (existsSync(targetPath)) continue

        let entryStat: Awaited<ReturnType<typeof stat>>
        try {
            entryStat = await stat(sourcePath)
        } catch {
            continue
        }

        if (entryStat.isFile()) {
            // Copy all root-level files — these are small identity markers
            copyTasks.push(copyFile(sourcePath, targetPath).catch(() => undefined))
        } else if (entryStat.isDirectory()) {
            // Skip other Chrome profile directories
            if (isProfileDirectory(sourceUserDataDir, entry)) continue

            // Skip large/regenerable directories
            if (SKIPPED_ROOT_DIRECTORIES.has(entry)) continue

            // Copy remaining directories (Safe Browsing, CertificateRevocation,
            // FileTypePolicies, MEIPreload, OriginTrials, SSLErrorAssistant,
            // Subresource Filter, ZxcvbnData, etc.)
            copyTasks.push(
                cp(sourcePath, targetPath, { recursive: true }).catch(
                    () => undefined
                )
            )
        }
    }

    await Promise.all(copyTasks)
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

function buildPersistentProfileMetadata(
    sourceUserDataDir: string,
    profileDirectory: string
): PersistentProfileMetadata {
    return {
        createdAt: new Date().toISOString(),
        profileDirectory,
        source: sourceUserDataDir,
    }
}

async function createPersistentProfileClone(
    sourceUserDataDir: string,
    sourceProfileDir: string,
    targetUserDataDir: string,
    profileDirectory: string,
    metadata: PersistentProfileMetadata
): Promise<boolean> {
    if (existsSync(targetUserDataDir)) {
        return false
    }

    const tempUserDataDir = await mkdtemp(
        buildPersistentProfileTempDirPrefix(targetUserDataDir)
    )
    let published = false

    try {
        await cp(sourceProfileDir, join(tempUserDataDir, profileDirectory), {
            recursive: true,
        })

        await copyRootLevelEntries(
            sourceUserDataDir,
            tempUserDataDir,
            profileDirectory
        )

        await writePersistentProfileMetadata(tempUserDataDir, metadata)

        try {
            await rename(tempUserDataDir, targetUserDataDir)
        } catch (error) {
            if (wasProfilePublishedByAnotherProcess(error, targetUserDataDir)) {
                return false
            }
            throw error
        }

        published = true
        return true
    } finally {
        if (!published) {
            await rm(tempUserDataDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined)
        }
    }
}

async function ensurePersistentProfileMetadata(
    userDataDir: string,
    metadata: PersistentProfileMetadata
): Promise<void> {
    if (existsSync(join(userDataDir, OPENSTEER_META_FILE))) {
        return
    }

    await writePersistentProfileMetadata(userDataDir, metadata)
}

function wasProfilePublishedByAnotherProcess(
    error: unknown,
    targetUserDataDir: string
): boolean {
    const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string'
            ? error.code
            : undefined

    return (
        existsSync(targetUserDataDir) &&
        (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM')
    )
}

function buildPersistentProfileTempDirPrefix(targetUserDataDir: string): string {
    return join(
        dirname(targetUserDataDir),
        `${basename(targetUserDataDir)}-tmp-${process.pid}-${PROCESS_STARTED_AT_MS}-`
    )
}

async function cleanOrphanedTempDirs(
    profilesDir: string,
    targetBaseName: string
): Promise<void> {
    let entries: Dirent<string>[]
    try {
        entries = await readdir(profilesDir, {
            encoding: 'utf8',
            withFileTypes: true,
        })
    } catch {
        return
    }

    const tempDirPrefix = `${targetBaseName}-tmp-`
    await Promise.all(
        entries.map(async (entry) => {
            if (!entry.isDirectory() || !entry.name.startsWith(tempDirPrefix)) {
                return
            }

            if (isTempDirOwnedByLiveProcess(entry.name, tempDirPrefix)) {
                return
            }

            await rm(join(profilesDir, entry.name), {
                recursive: true,
                force: true,
            }).catch(() => undefined)
        })
    )
}

function isTempDirOwnedByLiveProcess(
    tempDirName: string,
    tempDirPrefix: string
): boolean {
    const owner = parseTempDirOwner(tempDirName, tempDirPrefix)
    if (!owner) {
        return false
    }

    if (
        owner.pid === process.pid &&
        Math.abs(owner.processStartedAtMs - PROCESS_STARTED_AT_MS) <=
            PROCESS_START_TIME_TOLERANCE_MS
    ) {
        return true
    }

    return isProcessRunning(owner.pid)
}

function parseTempDirOwner(
    tempDirName: string,
    tempDirPrefix: string
): { pid: number; processStartedAtMs: number } | null {
    const remainder = tempDirName.slice(tempDirPrefix.length)
    const firstDashIndex = remainder.indexOf('-')
    const secondDashIndex =
        firstDashIndex === -1 ? -1 : remainder.indexOf('-', firstDashIndex + 1)

    if (firstDashIndex === -1 || secondDashIndex === -1) {
        return null
    }

    const pid = Number.parseInt(remainder.slice(0, firstDashIndex), 10)
    const processStartedAtMs = Number.parseInt(
        remainder.slice(firstDashIndex + 1, secondDashIndex),
        10
    )

    if (!Number.isInteger(pid) || pid <= 0) {
        return null
    }
    if (!Number.isInteger(processStartedAtMs) || processStartedAtMs <= 0) {
        return null
    }

    return { pid, processStartedAtMs }
}

function isProcessRunning(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        const code =
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            typeof error.code === 'string'
                ? error.code
                : undefined

        return code !== 'ESRCH'
    }
}
