import { createHash, randomUUID } from 'node:crypto'
import { existsSync, type Dirent } from 'node:fs'
import {
    cp,
    copyFile,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, sep } from 'node:path'
import { expandHome } from './chrome.js'

const OPENSTEER_META_FILE = '.opensteer-meta.json'
const LOCK_OWNER_FILE = 'owner.json'
const PROCESS_STARTED_AT_MS = Math.floor(Date.now() - process.uptime() * 1_000)
const PROCESS_START_TIME_TOLERANCE_MS = 1_000
const PROFILE_LOCK_RETRY_DELAY_MS = 50

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

interface LockOwner {
    pid: number
    processStartedAtMs: number
}

export interface PersistentProfileResult {
    created: boolean
    userDataDir: string
}

export interface IsolatedRuntimeProfileResult {
    persistentUserDataDir: string
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

    return await withPersistentProfileLock(targetUserDataDir, async () => {
        await cleanOrphanedOwnedDirs(
            dirname(targetUserDataDir),
            buildPersistentProfileTempDirNamePrefix(targetUserDataDir)
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
    })
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
): Promise<IsolatedRuntimeProfileResult> {
    const resolvedSourceUserDataDir = expandHome(sourceUserDataDir)
    const runtimeRootDir = expandHome(runtimesRootDir)
    await mkdir(runtimeRootDir, { recursive: true })

    return await withPersistentProfileLock(
        resolvedSourceUserDataDir,
        async () => {
            await cleanOrphanedOwnedDirs(
                runtimeRootDir,
                buildRuntimeProfileDirNamePrefix(resolvedSourceUserDataDir)
            )
            await clearPersistentProfileSingletons(resolvedSourceUserDataDir)

            const runtimeUserDataDir = await mkdtemp(
                buildRuntimeProfileDirPrefix(
                    runtimeRootDir,
                    resolvedSourceUserDataDir
                )
            )

            try {
                await copyUserDataDirSnapshot(
                    resolvedSourceUserDataDir,
                    runtimeUserDataDir
                )

                return {
                    persistentUserDataDir: resolvedSourceUserDataDir,
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
    )
}

export async function persistIsolatedRuntimeProfile(
    runtimeUserDataDir: string,
    persistentUserDataDir: string
): Promise<void> {
    const resolvedRuntimeUserDataDir = expandHome(runtimeUserDataDir)
    const resolvedPersistentUserDataDir = expandHome(persistentUserDataDir)

    await withPersistentProfileLock(resolvedPersistentUserDataDir, async () => {
        await mkdir(dirname(resolvedPersistentUserDataDir), { recursive: true })
        await cleanOrphanedOwnedDirs(
            dirname(resolvedPersistentUserDataDir),
            buildPersistentProfileTempDirNamePrefix(resolvedPersistentUserDataDir)
        )

        const metadata = await readPersistentProfileMetadata(resolvedRuntimeUserDataDir)
        if (!metadata) {
            throw new Error(
                `Persistent profile metadata was not found for "${resolvedRuntimeUserDataDir}".`
            )
        }

        await publishPersistentProfileSnapshot(
            resolvedRuntimeUserDataDir,
            resolvedPersistentUserDataDir,
            metadata
        )
    })

    await rm(resolvedRuntimeUserDataDir, {
        recursive: true,
        force: true,
    })
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

async function copyUserDataDirSnapshot(
    sourceUserDataDir: string,
    targetUserDataDir: string
): Promise<void> {
    await cp(sourceUserDataDir, targetUserDataDir, {
        recursive: true,
        filter: (candidatePath) =>
            shouldCopyRuntimeSnapshotEntry(sourceUserDataDir, candidatePath),
    })
}

function shouldCopyRuntimeSnapshotEntry(
    userDataDir: string,
    candidatePath: string
): boolean {
    const candidateRelativePath = relative(userDataDir, candidatePath)
    if (!candidateRelativePath) {
        return true
    }

    const segments = candidateRelativePath.split(sep).filter(Boolean)
    if (segments.length !== 1) {
        return true
    }

    return !CHROME_SINGLETON_ENTRIES.has(segments[0]!)
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
        await materializePersistentProfileSnapshot(
            sourceUserDataDir,
            sourceProfileDir,
            tempUserDataDir,
            profileDirectory,
            metadata
        )

        try {
            await rename(tempUserDataDir, targetUserDataDir)
        } catch (error) {
            if (wasDirPublishedByAnotherProcess(error, targetUserDataDir)) {
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

async function publishPersistentProfileSnapshot(
    sourceUserDataDir: string,
    targetUserDataDir: string,
    metadata: PersistentProfileMetadata
): Promise<void> {
    const sourceProfileDir = join(sourceUserDataDir, metadata.profileDirectory)
    const tempUserDataDir = await mkdtemp(
        buildPersistentProfileTempDirPrefix(targetUserDataDir)
    )
    let published = false

    try {
        await materializePersistentProfileSnapshot(
            sourceUserDataDir,
            sourceProfileDir,
            tempUserDataDir,
            metadata.profileDirectory,
            metadata
        )
        await replaceProfileDirectory(targetUserDataDir, tempUserDataDir)
        published = true
    } finally {
        if (!published) {
            await rm(tempUserDataDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined)
        }
    }
}

async function materializePersistentProfileSnapshot(
    sourceUserDataDir: string,
    sourceProfileDir: string,
    targetUserDataDir: string,
    profileDirectory: string,
    metadata: PersistentProfileMetadata
): Promise<void> {
    if (!existsSync(sourceProfileDir)) {
        throw new Error(
            `Chrome profile "${profileDirectory}" was not found in "${sourceUserDataDir}".`
        )
    }

    await cp(sourceProfileDir, join(targetUserDataDir, profileDirectory), {
        recursive: true,
    })
    await copyRootLevelEntries(sourceUserDataDir, targetUserDataDir, profileDirectory)
    await writePersistentProfileMetadata(targetUserDataDir, metadata)
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

async function readPersistentProfileMetadata(
    userDataDir: string
): Promise<PersistentProfileMetadata | null> {
    try {
        const raw = await readFile(join(userDataDir, OPENSTEER_META_FILE), 'utf8')
        const parsed = JSON.parse(raw) as Partial<PersistentProfileMetadata>
        if (
            typeof parsed.createdAt !== 'string' ||
            typeof parsed.profileDirectory !== 'string' ||
            typeof parsed.source !== 'string'
        ) {
            return null
        }

        return {
            createdAt: parsed.createdAt,
            profileDirectory: parsed.profileDirectory,
            source: parsed.source,
        }
    } catch {
        return null
    }
}

function wasDirPublishedByAnotherProcess(
    error: unknown,
    targetDirPath: string
): boolean {
    const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string'
            ? error.code
            : undefined

    return (
        existsSync(targetDirPath) &&
        (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM')
    )
}

async function replaceProfileDirectory(
    targetUserDataDir: string,
    replacementUserDataDir: string
): Promise<void> {
    if (!existsSync(targetUserDataDir)) {
        await rename(replacementUserDataDir, targetUserDataDir)
        return
    }

    const backupUserDataDir = buildPersistentProfileBackupDirPath(targetUserDataDir)
    let targetMovedToBackup = false
    let replacementPublished = false

    try {
        await rename(targetUserDataDir, backupUserDataDir)
        targetMovedToBackup = true
        await rename(replacementUserDataDir, targetUserDataDir)
        replacementPublished = true
    } catch (error) {
        if (targetMovedToBackup && !existsSync(targetUserDataDir)) {
            await rename(backupUserDataDir, targetUserDataDir).catch(() => undefined)
        }
        throw error
    } finally {
        if (
            replacementPublished &&
            targetMovedToBackup &&
            existsSync(backupUserDataDir)
        ) {
            await rm(backupUserDataDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined)
        }
    }
}

async function withPersistentProfileLock<T>(
    targetUserDataDir: string,
    action: () => Promise<T>
): Promise<T> {
    const lockDirPath = buildPersistentProfileLockDirPath(targetUserDataDir)
    await mkdir(dirname(lockDirPath), { recursive: true })

    while (true) {
        const tempLockDirPath = `${lockDirPath}-${process.pid}-${PROCESS_STARTED_AT_MS}-${randomUUID()}`
        try {
            await mkdir(tempLockDirPath)
            await writeLockOwner(tempLockDirPath, {
                pid: process.pid,
                processStartedAtMs: PROCESS_STARTED_AT_MS,
            })

            try {
                await rename(tempLockDirPath, lockDirPath)
                break
            } catch (error) {
                if (!wasDirPublishedByAnotherProcess(error, lockDirPath)) {
                    throw error
                }
            }
        } finally {
            await rm(tempLockDirPath, {
                recursive: true,
                force: true,
            }).catch(() => undefined)
        }

        const owner = await readLockOwner(lockDirPath)
        if (!owner || !isOwnerLive(owner)) {
            await rm(lockDirPath, {
                recursive: true,
                force: true,
            }).catch(() => undefined)
            continue
        }

        await sleep(PROFILE_LOCK_RETRY_DELAY_MS)
    }

    try {
        return await action()
    } finally {
        await rm(lockDirPath, {
            recursive: true,
            force: true,
        }).catch(() => undefined)
    }
}

async function writeLockOwner(
    lockDirPath: string,
    owner: LockOwner
): Promise<void> {
    await writeFile(join(lockDirPath, LOCK_OWNER_FILE), JSON.stringify(owner))
}

async function readLockOwner(lockDirPath: string): Promise<LockOwner | null> {
    try {
        const raw = await readFile(join(lockDirPath, LOCK_OWNER_FILE), 'utf8')
        const parsed = JSON.parse(raw) as Partial<LockOwner>
        const pid = Number(parsed.pid)
        const processStartedAtMs = Number(parsed.processStartedAtMs)
        if (!Number.isInteger(pid) || !Number.isInteger(processStartedAtMs)) {
            return null
        }

        return {
            pid,
            processStartedAtMs,
        }
    } catch {
        return null
    }
}

function isOwnerLive(owner: LockOwner): boolean {
    if (
        owner.pid === process.pid &&
        Math.abs(owner.processStartedAtMs - PROCESS_STARTED_AT_MS) <=
            PROCESS_START_TIME_TOLERANCE_MS
    ) {
        return true
    }

    return isProcessRunning(owner.pid)
}

function buildPersistentProfileTempDirPrefix(targetUserDataDir: string): string {
    return join(
        dirname(targetUserDataDir),
        `${buildPersistentProfileTempDirNamePrefix(targetUserDataDir)}${process.pid}-${PROCESS_STARTED_AT_MS}-`
    )
}

function buildPersistentProfileTempDirNamePrefix(
    targetUserDataDir: string
): string {
    return `${basename(targetUserDataDir)}-tmp-`
}

function buildPersistentProfileBackupDirPath(targetUserDataDir: string): string {
    return join(
        dirname(targetUserDataDir),
        `${buildPersistentProfileTempDirNamePrefix(targetUserDataDir)}${process.pid}-${PROCESS_STARTED_AT_MS}-backup-${Date.now()}`
    )
}

function buildPersistentProfileLockDirPath(targetUserDataDir: string): string {
    return join(dirname(targetUserDataDir), `${basename(targetUserDataDir)}.lock`)
}

function buildRuntimeProfileKey(sourceUserDataDir: string): string {
    const hash = createHash('sha256')
        .update(sourceUserDataDir)
        .digest('hex')
        .slice(0, 16)

    return `${sanitizePathSegment(basename(sourceUserDataDir) || 'profile')}-${hash}`
}

function buildRuntimeProfileDirNamePrefix(sourceUserDataDir: string): string {
    return `${buildRuntimeProfileKey(sourceUserDataDir)}-runtime-`
}

function buildRuntimeProfileDirPrefix(
    runtimesRootDir: string,
    sourceUserDataDir: string
): string {
    return join(
        runtimesRootDir,
        `${buildRuntimeProfileDirNamePrefix(sourceUserDataDir)}${process.pid}-${PROCESS_STARTED_AT_MS}-`
    )
}

async function cleanOrphanedOwnedDirs(
    rootDir: string,
    ownedDirNamePrefix: string
): Promise<void> {
    let entries: Dirent<string>[]
    try {
        entries = await readdir(rootDir, {
            encoding: 'utf8',
            withFileTypes: true,
        })
    } catch {
        return
    }

    await Promise.all(
        entries.map(async (entry) => {
            if (
                !entry.isDirectory() ||
                !entry.name.startsWith(ownedDirNamePrefix)
            ) {
                return
            }

            if (isOwnedDirByLiveProcess(entry.name, ownedDirNamePrefix)) {
                return
            }

            await rm(join(rootDir, entry.name), {
                recursive: true,
                force: true,
            }).catch(() => undefined)
        })
    )
}

function isOwnedDirByLiveProcess(
    ownedDirName: string,
    ownedDirPrefix: string
): boolean {
    const owner = parseOwnedDirOwner(ownedDirName, ownedDirPrefix)
    return owner ? isOwnerLive(owner) : false
}

function parseOwnedDirOwner(
    ownedDirName: string,
    ownedDirPrefix: string
): { pid: number; processStartedAtMs: number } | null {
    const remainder = ownedDirName.slice(ownedDirPrefix.length)
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

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
}
