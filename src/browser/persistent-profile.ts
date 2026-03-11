import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream, existsSync, type Dirent } from 'node:fs'
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
import { promisify } from 'node:util'
import { expandHome } from './chrome.js'

const execFileAsync = promisify(execFile)

const OPENSTEER_META_FILE = '.opensteer-meta.json'
const OPENSTEER_RUNTIME_META_FILE = '.opensteer-runtime.json'
const LOCK_OWNER_FILE = 'owner.json'
const LOCK_RECLAIMER_DIR = 'reclaimer'
const PROCESS_STARTED_AT_MS = Math.floor(Date.now() - process.uptime() * 1_000)
const PROCESS_START_TIME_TOLERANCE_MS = 1_000
const PROFILE_LOCK_RETRY_DELAY_MS = 50
const PROCESS_LIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024
const PS_COMMAND_ENV = { ...process.env, LC_ALL: 'C' }
const LINUX_STAT_START_TIME_FIELD_INDEX = 19

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
    OPENSTEER_RUNTIME_META_FILE,
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

interface RuntimeProfileMetadata {
    baseEntries: Record<string, SnapshotManifestEntry>
    creator: LockOwner
    persistentUserDataDir: string
    profileDirectory: string | null
}

interface LockOwner {
    pid: number
    processStartedAtMs: number
}

interface LockParticipantRecord {
    exists: boolean
    owner: LockOwner | null
}

type ProcessLiveness = 'live' | 'dead' | 'unknown'
type SnapshotEntryKind = 'directory' | 'file'
type SnapshotEntrySelection = 'current' | 'runtime'

export interface PersistentProfileResult {
    created: boolean
    userDataDir: string
}

export interface IsolatedRuntimeProfileResult {
    persistentUserDataDir: string
    userDataDir: string
}

interface SnapshotManifestEntry {
    hash: string | null
    kind: SnapshotEntryKind
}

interface SnapshotEntry extends SnapshotManifestEntry {
    sourcePath: string
}

const CURRENT_PROCESS_LOCK_OWNER: LockOwner = {
    pid: process.pid,
    processStartedAtMs: PROCESS_STARTED_AT_MS,
}

let linuxClockTicksPerSecondPromise: Promise<number | null> | null = null

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
        await recoverPersistentProfileBackup(targetUserDataDir)
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
            const sourceMetadata = await readPersistentProfileMetadata(
                resolvedSourceUserDataDir
            )
            await cleanOrphanedRuntimeProfileDirs(
                runtimeRootDir,
                buildRuntimeProfileDirNamePrefix(resolvedSourceUserDataDir)
            )

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
                await writeRuntimeProfileMetadata(
                    runtimeUserDataDir,
                    await buildRuntimeProfileMetadata(
                        runtimeUserDataDir,
                        resolvedSourceUserDataDir,
                        sourceMetadata?.profileDirectory ?? null
                    )
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
        await recoverPersistentProfileBackup(resolvedPersistentUserDataDir)
        await cleanOrphanedOwnedDirs(
            dirname(resolvedPersistentUserDataDir),
            buildPersistentProfileTempDirNamePrefix(resolvedPersistentUserDataDir)
        )

        const metadata = await requirePersistentProfileMetadata(
            resolvedPersistentUserDataDir
        )
        const runtimeMetadata = await requireRuntimeProfileMetadata(
            resolvedRuntimeUserDataDir,
            resolvedPersistentUserDataDir,
            metadata.profileDirectory
        )

        await mergePersistentProfileSnapshot(
            resolvedRuntimeUserDataDir,
            resolvedPersistentUserDataDir,
            metadata,
            runtimeMetadata
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

    return !COPY_SKIP_ENTRIES.has(segments[0]!)
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

async function mergePersistentProfileSnapshot(
    runtimeUserDataDir: string,
    persistentUserDataDir: string,
    metadata: PersistentProfileMetadata,
    runtimeMetadata: RuntimeProfileMetadata
): Promise<void> {
    const tempUserDataDir = await mkdtemp(
        buildPersistentProfileTempDirPrefix(persistentUserDataDir)
    )
    let published = false

    try {
        const baseEntries = deserializeSnapshotManifestEntries(
            runtimeMetadata.baseEntries
        )
        const currentEntries = await collectPersistentSnapshotEntries(
            persistentUserDataDir,
            metadata.profileDirectory
        )
        const runtimeEntries = await collectPersistentSnapshotEntries(
            runtimeUserDataDir,
            metadata.profileDirectory
        )
        const mergedEntries = resolveMergedSnapshotEntries(
            baseEntries,
            currentEntries,
            runtimeEntries
        )

        await materializeMergedPersistentProfileSnapshot(
            tempUserDataDir,
            currentEntries,
            runtimeEntries,
            mergedEntries
        )
        await writePersistentProfileMetadata(tempUserDataDir, metadata)
        await replaceProfileDirectory(persistentUserDataDir, tempUserDataDir)
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

async function buildRuntimeProfileMetadata(
    runtimeUserDataDir: string,
    persistentUserDataDir: string,
    profileDirectory: string | null
): Promise<RuntimeProfileMetadata> {
    const baseEntries = profileDirectory
        ? serializeSnapshotManifestEntries(
              await collectPersistentSnapshotEntries(
                  runtimeUserDataDir,
                  profileDirectory
              )
          )
        : {}

    return {
        baseEntries,
        creator: CURRENT_PROCESS_LOCK_OWNER,
        persistentUserDataDir,
        profileDirectory,
    }
}

async function writeRuntimeProfileMetadata(
    userDataDir: string,
    metadata: RuntimeProfileMetadata
): Promise<void> {
    await writeFile(
        join(userDataDir, OPENSTEER_RUNTIME_META_FILE),
        JSON.stringify(metadata, null, 2)
    )
}

async function readRuntimeProfileMetadata(
    userDataDir: string
): Promise<RuntimeProfileMetadata | null> {
    try {
        const raw = await readFile(
            join(userDataDir, OPENSTEER_RUNTIME_META_FILE),
            'utf8'
        )
        const parsed = JSON.parse(raw) as Partial<RuntimeProfileMetadata>
        const creator = parseLockOwner(parsed.creator)
        const persistentUserDataDir =
            typeof parsed.persistentUserDataDir === 'string'
                ? parsed.persistentUserDataDir
                : undefined
        const profileDirectory =
            parsed.profileDirectory === null
                ? null
                : typeof parsed.profileDirectory === 'string'
                  ? parsed.profileDirectory
                  : undefined
        if (
            !creator ||
            persistentUserDataDir === undefined ||
            profileDirectory === undefined ||
            typeof parsed.baseEntries !== 'object' ||
            parsed.baseEntries === null ||
            Array.isArray(parsed.baseEntries)
        ) {
            return null
        }

        const baseEntries = deserializeSnapshotManifestEntries(
            parsed.baseEntries as Record<string, SnapshotManifestEntry>
        )

        return {
            baseEntries: Object.fromEntries(baseEntries),
            creator,
            persistentUserDataDir,
            profileDirectory,
        }
    } catch {
        return null
    }
}

async function requireRuntimeProfileMetadata(
    userDataDir: string,
    expectedPersistentUserDataDir: string,
    expectedProfileDirectory: string
): Promise<RuntimeProfileMetadata> {
    const metadata = await readRuntimeProfileMetadata(userDataDir)
    if (!metadata) {
        throw new Error(
            `Runtime profile metadata was not found for "${userDataDir}".`
        )
    }
    if (metadata.profileDirectory !== expectedProfileDirectory) {
        throw new Error(
            `Runtime profile "${userDataDir}" was created for profile "${metadata.profileDirectory ?? 'unknown'}", expected "${expectedProfileDirectory}".`
        )
    }
    if (metadata.persistentUserDataDir !== expectedPersistentUserDataDir) {
        throw new Error(
            `Runtime profile "${userDataDir}" does not belong to persistent profile "${expectedPersistentUserDataDir}".`
        )
    }

    return metadata
}

async function collectPersistentSnapshotEntries(
    userDataDir: string,
    profileDirectory: string
): Promise<Map<string, SnapshotEntry>> {
    let rootEntries: Dirent<string>[]
    try {
        rootEntries = await readdir(userDataDir, {
            encoding: 'utf8',
            withFileTypes: true,
        })
    } catch {
        return new Map()
    }

    rootEntries.sort((left, right) => left.name.localeCompare(right.name))

    const collected = new Map<string, SnapshotEntry>()
    for (const entry of rootEntries) {
        if (
            !shouldIncludePersistentRootEntry(
                userDataDir,
                profileDirectory,
                entry.name
            )
        ) {
            continue
        }

        await collectSnapshotEntry(
            join(userDataDir, entry.name),
            entry.name,
            collected
        )
    }

    return collected
}

function shouldIncludePersistentRootEntry(
    userDataDir: string,
    profileDirectory: string,
    entry: string
): boolean {
    if (entry === profileDirectory) {
        return true
    }
    if (COPY_SKIP_ENTRIES.has(entry)) {
        return false
    }
    if (SKIPPED_ROOT_DIRECTORIES.has(entry)) {
        return false
    }

    return !isProfileDirectory(userDataDir, entry)
}

async function collectSnapshotEntry(
    sourcePath: string,
    relativePath: string,
    collected: Map<string, SnapshotEntry>
): Promise<void> {
    let entryStat: Awaited<ReturnType<typeof stat>>
    try {
        entryStat = await stat(sourcePath)
    } catch {
        return
    }

    if (entryStat.isDirectory()) {
        collected.set(relativePath, {
            kind: 'directory',
            hash: null,
            sourcePath,
        })

        let children: Dirent<string>[]
        try {
            children = await readdir(sourcePath, {
                encoding: 'utf8',
                withFileTypes: true,
            })
        } catch {
            return
        }
        children.sort((left, right) => left.name.localeCompare(right.name))

        for (const child of children) {
            await collectSnapshotEntry(
                join(sourcePath, child.name),
                join(relativePath, child.name),
                collected
            )
        }
        return
    }

    if (entryStat.isFile()) {
        collected.set(relativePath, {
            kind: 'file',
            hash: await hashFile(sourcePath),
            sourcePath,
        })
    }
}

function serializeSnapshotManifestEntries(
    entries: Map<string, SnapshotManifestEntry | SnapshotEntry>
): Record<string, SnapshotManifestEntry> {
    return Object.fromEntries(
        [...entries.entries()]
            .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
            .map(([relativePath, entry]) => [
                relativePath,
                {
                    kind: entry.kind,
                    hash: entry.hash,
                },
            ])
    )
}

function deserializeSnapshotManifestEntries(
    entries: Record<string, SnapshotManifestEntry>
): Map<string, SnapshotManifestEntry> {
    const manifestEntries = new Map<string, SnapshotManifestEntry>()

    for (const [relativePath, entry] of Object.entries(entries)) {
        if (
            !entry ||
            (entry.kind !== 'directory' && entry.kind !== 'file') ||
            !(entry.hash === null || typeof entry.hash === 'string')
        ) {
            throw new Error(
                `Runtime profile metadata for "${relativePath}" is invalid.`
            )
        }

        manifestEntries.set(relativePath, {
            kind: entry.kind,
            hash: entry.hash,
        })
    }

    return manifestEntries
}

function resolveMergedSnapshotEntries(
    baseEntries: Map<string, SnapshotManifestEntry>,
    currentEntries: Map<string, SnapshotEntry>,
    runtimeEntries: Map<string, SnapshotEntry>
): Map<string, SnapshotEntrySelection | null> {
    const mergedEntries = new Map<string, SnapshotEntrySelection | null>()
    const relativePaths = new Set<string>([
        ...baseEntries.keys(),
        ...currentEntries.keys(),
        ...runtimeEntries.keys(),
    ])

    for (const relativePath of [...relativePaths].sort(compareSnapshotPaths)) {
        mergedEntries.set(
            relativePath,
            resolveMergedSnapshotEntrySelection(
                relativePath,
                baseEntries.get(relativePath) ?? null,
                currentEntries.get(relativePath) ?? null,
                runtimeEntries.get(relativePath) ?? null
            )
        )
    }

    return mergedEntries
}

function resolveMergedSnapshotEntrySelection(
    relativePath: string,
    baseEntry: SnapshotManifestEntry | null,
    currentEntry: SnapshotManifestEntry | null,
    runtimeEntry: SnapshotManifestEntry | null
): SnapshotEntrySelection | null {
    if (snapshotEntriesEqual(runtimeEntry, baseEntry)) {
        return currentEntry ? 'current' : null
    }
    if (snapshotEntriesEqual(currentEntry, baseEntry)) {
        return runtimeEntry ? 'runtime' : null
    }
    if (!baseEntry) {
        if (!currentEntry) {
            return runtimeEntry ? 'runtime' : null
        }
        if (!runtimeEntry) {
            return 'current'
        }
        if (snapshotEntriesEqual(currentEntry, runtimeEntry)) {
            return 'current'
        }
        throw new Error(
            `Concurrent runtime updates changed "${relativePath}" differently; refusing to overwrite the persistent profile.`
        )
    }
    if (!currentEntry && !runtimeEntry) {
        return null
    }
    if (snapshotEntriesEqual(currentEntry, runtimeEntry)) {
        return currentEntry ? 'current' : null
    }

    throw new Error(
        `Concurrent runtime updates changed "${relativePath}" differently; refusing to overwrite the persistent profile.`
    )
}

function snapshotEntriesEqual(
    left: SnapshotManifestEntry | null,
    right: SnapshotManifestEntry | null
): boolean {
    if (!left || !right) {
        return left === right
    }

    return left.kind === right.kind && left.hash === right.hash
}

async function materializeMergedPersistentProfileSnapshot(
    targetUserDataDir: string,
    currentEntries: Map<string, SnapshotEntry>,
    runtimeEntries: Map<string, SnapshotEntry>,
    mergedEntries: Map<string, SnapshotEntrySelection | null>
): Promise<void> {
    const selectedEntries = [...mergedEntries.entries()]
        .filter(([, selection]) => selection !== null)
        .sort(([leftPath], [rightPath]) =>
            compareSnapshotPaths(leftPath, rightPath)
        )

    for (const [relativePath, selection] of selectedEntries) {
        const entry =
            (selection === 'current'
                ? currentEntries.get(relativePath)
                : runtimeEntries.get(relativePath)) ?? null
        if (!entry) {
            continue
        }

        const targetPath = join(targetUserDataDir, relativePath)
        if (entry.kind === 'directory') {
            await mkdir(targetPath, { recursive: true })
            continue
        }

        await mkdir(dirname(targetPath), { recursive: true })
        await copyFile(entry.sourcePath, targetPath)
    }
}

function compareSnapshotPaths(left: string, right: string): number {
    const leftDepth = left.split(sep).length
    const rightDepth = right.split(sep).length
    if (leftDepth !== rightDepth) {
        return leftDepth - rightDepth
    }

    return left.localeCompare(right)
}

async function hashFile(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const hash = createHash('sha256')
        const stream = createReadStream(filePath)

        stream.on('data', (chunk) => {
            hash.update(chunk)
        })
        stream.on('error', reject)
        stream.on('end', () => {
            resolve(hash.digest('hex'))
        })
    })
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

async function recoverPersistentProfileBackup(
    targetUserDataDir: string
): Promise<void> {
    const backupDirPaths = await listPersistentProfileBackupDirs(targetUserDataDir)
    if (backupDirPaths.length === 0) {
        return
    }

    if (!existsSync(targetUserDataDir)) {
        const [latestBackupDirPath, ...staleBackupDirPaths] = backupDirPaths
        await rename(latestBackupDirPath!, targetUserDataDir)
        await Promise.all(
            staleBackupDirPaths.map((backupDirPath) =>
                rm(backupDirPath, {
                    recursive: true,
                    force: true,
                }).catch(() => undefined)
            )
        )
        return
    }

    await Promise.all(
        backupDirPaths.map((backupDirPath) =>
            rm(backupDirPath, {
                recursive: true,
                force: true,
            }).catch(() => undefined)
        )
    )
}

async function listPersistentProfileBackupDirs(
    targetUserDataDir: string
): Promise<string[]> {
    const profilesDir = dirname(targetUserDataDir)
    let entries: Dirent<string>[]
    try {
        entries = await readdir(profilesDir, {
            encoding: 'utf8',
            withFileTypes: true,
        })
    } catch {
        return []
    }

    const backupDirNamePrefix =
        buildPersistentProfileBackupDirNamePrefix(targetUserDataDir)

    return entries
        .filter(
            (entry) =>
                entry.isDirectory() && entry.name.startsWith(backupDirNamePrefix)
        )
        .map((entry) => join(profilesDir, entry.name))
        .sort((leftPath, rightPath) => rightPath.localeCompare(leftPath))
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

async function requirePersistentProfileMetadata(
    userDataDir: string
): Promise<PersistentProfileMetadata> {
    const metadata = await readPersistentProfileMetadata(userDataDir)
    if (!metadata) {
        throw new Error(
            `Persistent profile metadata was not found for "${userDataDir}".`
        )
    }

    return metadata
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
            await writeLockOwner(tempLockDirPath, CURRENT_PROCESS_LOCK_OWNER)

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
        if (
            (!owner || (await getProcessLiveness(owner)) === 'dead') &&
            (await tryReclaimStaleLock(lockDirPath, owner))
        ) {
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
    await writeLockParticipant(join(lockDirPath, LOCK_OWNER_FILE), owner)
}

async function readLockOwner(lockDirPath: string): Promise<LockOwner | null> {
    return await readLockParticipant(join(lockDirPath, LOCK_OWNER_FILE))
}

async function writeLockParticipant(
    filePath: string,
    owner: LockOwner,
    options?: { flag?: 'w' | 'wx' }
): Promise<void> {
    await writeFile(filePath, JSON.stringify(owner), options)
}

async function readLockParticipant(filePath: string): Promise<LockOwner | null> {
    return (await readLockParticipantRecord(filePath)).owner
}

async function readLockReclaimerRecord(
    lockDirPath: string
): Promise<LockParticipantRecord> {
    return await readLockParticipantRecord(
        join(buildLockReclaimerDirPath(lockDirPath), LOCK_OWNER_FILE)
    )
}

async function readLockParticipantRecord(
    filePath: string
): Promise<LockParticipantRecord> {
    try {
        const raw = await readFile(filePath, 'utf8')
        const owner = parseLockOwner(JSON.parse(raw))

        return {
            exists: true,
            owner,
        }
    } catch (error) {
        return {
            exists: getErrorCode(error) !== 'ENOENT',
            owner: null,
        }
    }
}

async function tryReclaimStaleLock(
    lockDirPath: string,
    expectedOwner: LockOwner | null
): Promise<boolean> {
    if (!(await tryAcquireLockReclaimer(lockDirPath))) {
        return false
    }

    let reclaimed = false

    try {
        const owner = await readLockOwner(lockDirPath)
        if (!lockOwnersEqual(owner, expectedOwner)) {
            return false
        }

        if (owner && (await getProcessLiveness(owner)) !== 'dead') {
            return false
        }

        await rm(lockDirPath, {
            recursive: true,
            force: true,
        }).catch(() => undefined)
        reclaimed = !existsSync(lockDirPath)
        return reclaimed
    } finally {
        if (!reclaimed) {
            await rm(buildLockReclaimerDirPath(lockDirPath), {
                recursive: true,
                force: true,
            }).catch(() => undefined)
        }
    }
}

async function tryAcquireLockReclaimer(lockDirPath: string): Promise<boolean> {
    const reclaimerDirPath = buildLockReclaimerDirPath(lockDirPath)

    while (true) {
        const tempReclaimerDirPath =
            `${reclaimerDirPath}-${process.pid}-${PROCESS_STARTED_AT_MS}-${randomUUID()}`
        try {
            await mkdir(tempReclaimerDirPath)
            await writeLockOwner(tempReclaimerDirPath, CURRENT_PROCESS_LOCK_OWNER)

            try {
                await rename(tempReclaimerDirPath, reclaimerDirPath)
                return true
            } catch (error) {
                if (getErrorCode(error) === 'ENOENT') {
                    return false
                }
                if (!wasDirPublishedByAnotherProcess(error, reclaimerDirPath)) {
                    throw error
                }
            }
        } catch (error) {
            const code = getErrorCode(error)
            if (code === 'ENOENT') {
                return false
            }
            throw error
        } finally {
            await rm(tempReclaimerDirPath, {
                recursive: true,
                force: true,
            }).catch(() => undefined)
        }

        const reclaimerRecord = await readLockReclaimerRecord(lockDirPath)
        if (!reclaimerRecord.exists || !reclaimerRecord.owner) {
            return false
        }
        if ((await getProcessLiveness(reclaimerRecord.owner)) !== 'dead') {
            return false
        }

        await rm(reclaimerDirPath, {
            recursive: true,
            force: true,
        }).catch(() => undefined)
    }
}

function lockOwnersEqual(
    left: LockOwner | null,
    right: LockOwner | null
): boolean {
    if (!left || !right) {
        return left === right
    }

    return (
        left.pid === right.pid &&
        left.processStartedAtMs === right.processStartedAtMs
    )
}

async function getProcessLiveness(owner: LockOwner): Promise<ProcessLiveness> {
    if (
        owner.pid === process.pid &&
        hasMatchingProcessStartTime(
            owner.processStartedAtMs,
            PROCESS_STARTED_AT_MS
        )
    ) {
        return 'live'
    }

    const startedAtMs = await readProcessStartedAtMs(owner.pid)
    if (typeof startedAtMs === 'number') {
        return hasMatchingProcessStartTime(
            owner.processStartedAtMs,
            startedAtMs
        )
            ? 'live'
            : 'dead'
    }

    return isProcessRunning(owner.pid) ? 'unknown' : 'dead'
}

function hasMatchingProcessStartTime(
    expectedStartedAtMs: number,
    actualStartedAtMs: number
): boolean {
    return (
        Math.abs(expectedStartedAtMs - actualStartedAtMs) <=
        PROCESS_START_TIME_TOLERANCE_MS
    )
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
        `${buildPersistentProfileBackupDirNamePrefix(targetUserDataDir)}${Date.now()}-${process.pid}-${PROCESS_STARTED_AT_MS}-${randomUUID()}`
    )
}

function buildPersistentProfileBackupDirNamePrefix(
    targetUserDataDir: string
): string {
    return `${basename(targetUserDataDir)}-backup-`
}

function buildPersistentProfileLockDirPath(targetUserDataDir: string): string {
    return join(dirname(targetUserDataDir), `${basename(targetUserDataDir)}.lock`)
}

function buildLockReclaimerDirPath(lockDirPath: string): string {
    return join(lockDirPath, LOCK_RECLAIMER_DIR)
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
        buildRuntimeProfileDirNamePrefix(sourceUserDataDir)
    )
}

async function cleanOrphanedRuntimeProfileDirs(
    rootDir: string,
    runtimeDirNamePrefix: string
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

    const liveProcessCommandLines = await listProcessCommandLines()

    await Promise.all(
        entries.map(async (entry) => {
            if (
                !entry.isDirectory() ||
                !entry.name.startsWith(runtimeDirNamePrefix)
            ) {
                return
            }

            const runtimeDirPath = join(rootDir, entry.name)
            if (
                await isRuntimeProfileDirInUse(
                    runtimeDirPath,
                    liveProcessCommandLines
                )
            ) {
                return
            }

            await rm(runtimeDirPath, {
                recursive: true,
                force: true,
            }).catch(() => undefined)
        })
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

            if (await isOwnedDirByLiveProcess(entry.name, ownedDirNamePrefix)) {
                return
            }

            await rm(join(rootDir, entry.name), {
                recursive: true,
                force: true,
            }).catch(() => undefined)
        })
    )
}

async function isOwnedDirByLiveProcess(
    ownedDirName: string,
    ownedDirPrefix: string
): Promise<boolean> {
    const owner = parseOwnedDirOwner(ownedDirName, ownedDirPrefix)
    return owner ? (await getProcessLiveness(owner)) !== 'dead' : false
}

async function isRuntimeProfileDirInUse(
    runtimeDirPath: string,
    liveProcessCommandLines: readonly string[]
): Promise<boolean> {
    const metadata = await readRuntimeProfileMetadata(runtimeDirPath)
    if (metadata && (await getProcessLiveness(metadata.creator)) !== 'dead') {
        return true
    }

    return liveProcessCommandLines.some((commandLine) =>
        commandLineIncludesUserDataDir(commandLine, runtimeDirPath)
    )
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

function parseLockOwner(value: unknown): LockOwner | null {
    if (!value || typeof value !== 'object') {
        return null
    }

    const parsed = value as Partial<LockOwner>
    const pid = Number(parsed.pid)
    const processStartedAtMs = Number(parsed.processStartedAtMs)
    if (!Number.isInteger(pid) || pid <= 0) {
        return null
    }
    if (!Number.isInteger(processStartedAtMs) || processStartedAtMs <= 0) {
        return null
    }

    return {
        pid,
        processStartedAtMs,
    }
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

async function readProcessStartedAtMs(pid: number): Promise<number | null> {
    if (pid <= 0) {
        return null
    }

    if (process.platform === 'linux') {
        return await readLinuxProcessStartedAtMs(pid)
    }

    if (process.platform === 'win32') {
        return await readWindowsProcessStartedAtMs(pid)
    }

    return await readPsProcessStartedAtMs(pid)
}

async function readLinuxProcessStartedAtMs(
    pid: number
): Promise<number | null> {
    let statRaw: string
    try {
        statRaw = await readFile(`/proc/${pid}/stat`, 'utf8')
    } catch (error) {
        return null
    }

    const startTicks = parseLinuxProcessStartTicks(statRaw)
    if (startTicks === null) {
        return null
    }

    const [bootTimeMs, clockTicksPerSecond] = await Promise.all([
        readLinuxBootTimeMs(),
        readLinuxClockTicksPerSecond(),
    ])
    if (bootTimeMs === null || clockTicksPerSecond === null) {
        return null
    }

    return Math.floor(
        bootTimeMs + (startTicks * 1_000) / clockTicksPerSecond
    )
}

function parseLinuxProcessStartTicks(statRaw: string): number | null {
    const closingParenIndex = statRaw.lastIndexOf(')')
    if (closingParenIndex === -1) {
        return null
    }

    const fields = statRaw
        .slice(closingParenIndex + 2)
        .trim()
        .split(/\s+/)
    const startTicks = Number(fields[LINUX_STAT_START_TIME_FIELD_INDEX])

    return Number.isFinite(startTicks) && startTicks >= 0 ? startTicks : null
}

async function readLinuxBootTimeMs(): Promise<number | null> {
    try {
        const statRaw = await readFile('/proc/stat', 'utf8')
        const bootTimeLine = statRaw
            .split('\n')
            .find((line) => line.startsWith('btime '))
        if (!bootTimeLine) {
            return null
        }

        const bootTimeSeconds = Number.parseInt(
            bootTimeLine.slice('btime '.length),
            10
        )
        return Number.isFinite(bootTimeSeconds)
            ? bootTimeSeconds * 1_000
            : null
    } catch {
        return null
    }
}

async function readLinuxClockTicksPerSecond(): Promise<number | null> {
    linuxClockTicksPerSecondPromise ??= execFileAsync(
        'getconf',
        ['CLK_TCK']
    ).then(
        ({ stdout }) => {
            const value = Number.parseInt(stdout.trim(), 10)
            return Number.isFinite(value) && value > 0 ? value : null
        },
        () => null
    )

    return await linuxClockTicksPerSecondPromise
}

async function readPsProcessStartedAtMs(pid: number): Promise<number | null> {
    try {
        const { stdout } = await execFileAsync(
            'ps',
            ['-p', String(pid), '-o', 'lstart='],
            {
                env: PS_COMMAND_ENV,
                maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
            }
        )
        return parsePsStartedAtMs(stdout)
    } catch (error) {
        return null
    }
}

function parsePsStartedAtMs(stdout: string): number | null {
    const raw = stdout.trim()
    if (!raw) {
        return null
    }

    const startedAtMs = Date.parse(raw)
    return Number.isNaN(startedAtMs) ? null : startedAtMs
}

async function readWindowsProcessStartedAtMs(
    pid: number
): Promise<number | null> {
    const script = [
        '$process = Get-Process -Id ' + String(pid) + ' -ErrorAction SilentlyContinue',
        'if ($null -eq $process) { exit 3 }',
        '$process.StartTime.ToUniversalTime().ToString("o")',
    ].join('; ')

    try {
        const { stdout } = await execFileAsync(
            'powershell.exe',
            ['-NoLogo', '-NoProfile', '-Command', script],
            {
                maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
            }
        )
        return parsePsStartedAtMs(stdout)
    } catch (error) {
        return null
    }
}

async function listProcessCommandLines(): Promise<string[]> {
    if (process.platform === 'win32') {
        return await listWindowsProcessCommandLines()
    }

    return await listPsProcessCommandLines()
}

async function listPsProcessCommandLines(): Promise<string[]> {
    try {
        const { stdout } = await execFileAsync(
            'ps',
            ['-axww', '-o', 'command='],
            {
                env: PS_COMMAND_ENV,
                maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
            }
        )

        return stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
    } catch {
        return []
    }
}

async function listWindowsProcessCommandLines(): Promise<string[]> {
    const script = [
        '$processes = Get-CimInstance Win32_Process | Select-Object CommandLine',
        '$processes | ConvertTo-Json -Compress',
    ].join('; ')

    try {
        const { stdout } = await execFileAsync(
            'powershell.exe',
            ['-NoLogo', '-NoProfile', '-Command', script],
            {
                maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
            }
        )
        const parsed = JSON.parse(stdout) as
            | Array<{ CommandLine?: string | null }>
            | { CommandLine?: string | null }
        const records = Array.isArray(parsed) ? parsed : [parsed]

        return records
            .map((record) => record?.CommandLine?.trim() ?? '')
            .filter((commandLine) => commandLine.length > 0)
    } catch {
        return []
    }
}

function commandLineIncludesUserDataDir(
    commandLine: string,
    userDataDir: string
): boolean {
    return [
        `--user-data-dir=${userDataDir}`,
        `--user-data-dir="${userDataDir}"`,
        `--user-data-dir='${userDataDir}'`,
    ].some((candidate) => commandLine.includes(candidate))
}

function getErrorCode(error: unknown): string | number | undefined {
    return typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (typeof error.code === 'string' || typeof error.code === 'number')
        ? error.code
        : undefined
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
}
