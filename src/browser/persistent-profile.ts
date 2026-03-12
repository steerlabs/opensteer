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
import {
    acquirePersistentProfileWriteLock,
    isPersistentProfileWriteLocked,
    withPersistentProfileControlLock,
    PERSISTENT_PROFILE_LOCK_RETRY_DELAY_MS,
} from './persistent-profile-coordination.js'
import {
    CURRENT_PROCESS_OWNER,
    getProcessLiveness,
    parseProcessOwner,
    type ProcessOwner,
} from './process-owner.js'
import {
    hasLiveSharedRealBrowserSession,
    waitForSharedRealBrowserSessionToDrain,
} from './shared-real-browser-session-state.js'

const execFileAsync = promisify(execFile)

const OPENSTEER_META_FILE = '.opensteer-meta.json'
const OPENSTEER_RUNTIME_META_FILE = '.opensteer-runtime.json'
const OPENSTEER_RUNTIME_CREATING_FILE = '.opensteer-runtime-creating.json'
const PROCESS_LIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024
const PS_COMMAND_ENV = { ...process.env, LC_ALL: 'C' }

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
    OPENSTEER_RUNTIME_CREATING_FILE,
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
    creator: ProcessOwner
    persistentUserDataDir: string
    profileDirectory: string | null
}

interface RuntimeProfileCreationMarker {
    creator: ProcessOwner
    persistentUserDataDir: string
    profileDirectory: string | null
    runtimeUserDataDir: string
}
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

interface JsonRecord {
    [key: string]: JsonValue
}

type JsonValue = JsonRecord | JsonValue[] | boolean | number | null | string

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

    if (
        (await isHealthyPersistentProfile(
            targetUserDataDir,
            resolvedSourceUserDataDir,
            profileDirectory
        )) &&
        !(await isPersistentProfileWriteLocked(targetUserDataDir))
    ) {
        return {
            created: false,
            userDataDir: targetUserDataDir,
        }
    }

    return await withPersistentProfileWriteAccess(targetUserDataDir, async () => {
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

    const sourceMetadata = await requirePersistentProfileMetadata(
        resolvedSourceUserDataDir
    )
    const runtimeProfile = await reserveRuntimeProfileCreation(
        resolvedSourceUserDataDir,
        runtimeRootDir,
        sourceMetadata.profileDirectory
    )

    try {
        await cleanOrphanedRuntimeProfileDirs(
            runtimeRootDir,
            buildRuntimeProfileDirNamePrefix(resolvedSourceUserDataDir)
        )
        await copyUserDataDirSnapshot(
            resolvedSourceUserDataDir,
            runtimeProfile.userDataDir
        )
        const currentSourceMetadata = await readPersistentProfileMetadata(
            resolvedSourceUserDataDir
        )
        await writeRuntimeProfileMetadata(
            runtimeProfile.userDataDir,
            await buildRuntimeProfileMetadata(
                runtimeProfile.userDataDir,
                resolvedSourceUserDataDir,
                currentSourceMetadata?.profileDirectory ??
                    sourceMetadata.profileDirectory
            )
        )
        await clearRuntimeProfileCreationState(
            runtimeProfile.userDataDir,
            resolvedSourceUserDataDir
        )

        return {
            persistentUserDataDir: resolvedSourceUserDataDir,
            userDataDir: runtimeProfile.userDataDir,
        }
    } catch (error) {
        await clearRuntimeProfileCreationState(
            runtimeProfile.userDataDir,
            resolvedSourceUserDataDir
        )
        await rm(runtimeProfile.userDataDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined)
        throw error
    }
}

export async function persistIsolatedRuntimeProfile(
    runtimeUserDataDir: string,
    persistentUserDataDir: string
): Promise<void> {
    const resolvedRuntimeUserDataDir = expandHome(runtimeUserDataDir)
    const resolvedPersistentUserDataDir = expandHome(persistentUserDataDir)
    let claimedRuntimeUserDataDir: string | null = null

    try {
        await withPersistentProfileWriteAccess(
            resolvedPersistentUserDataDir,
            async () => {
                await mkdir(dirname(resolvedPersistentUserDataDir), {
                    recursive: true,
                })
                await recoverPersistentProfileBackup(resolvedPersistentUserDataDir)
                await cleanOrphanedOwnedDirs(
                    dirname(resolvedPersistentUserDataDir),
                    buildPersistentProfileTempDirNamePrefix(
                        resolvedPersistentUserDataDir
                    )
                )

                const metadata = await requirePersistentProfileMetadata(
                    resolvedPersistentUserDataDir
                )
                claimedRuntimeUserDataDir = await claimRuntimeProfileForPersist(
                    resolvedRuntimeUserDataDir
                )
                const runtimeMetadata = await requireRuntimeProfileMetadata(
                    claimedRuntimeUserDataDir,
                    resolvedPersistentUserDataDir,
                    metadata.profileDirectory,
                    resolvedRuntimeUserDataDir
                )

                await mergePersistentProfileSnapshot(
                    claimedRuntimeUserDataDir,
                    resolvedPersistentUserDataDir,
                    metadata,
                    runtimeMetadata
                )
            }
        )
    } catch (error) {
        if (claimedRuntimeUserDataDir) {
            try {
                await restoreClaimedRuntimeProfile(
                    claimedRuntimeUserDataDir,
                    resolvedRuntimeUserDataDir
                )
            } catch (restoreError) {
                throw new AggregateError(
                    [error, restoreError],
                    `Failed to restore runtime profile "${resolvedRuntimeUserDataDir}" after persistence failed.`
                )
            }
        }

        throw error
    }

    if (claimedRuntimeUserDataDir) {
        await rm(claimedRuntimeUserDataDir, {
            recursive: true,
            force: true,
        }).catch(() => undefined)
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
        creator: CURRENT_PROCESS_OWNER,
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

async function writeRuntimeProfileCreationMarker(
    userDataDir: string,
    marker: RuntimeProfileCreationMarker
): Promise<void> {
    await writeFile(
        join(userDataDir, OPENSTEER_RUNTIME_CREATING_FILE),
        JSON.stringify(marker, null, 2)
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
        const creator = parseProcessOwner(parsed.creator)
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

async function readRuntimeProfileCreationMarker(
    userDataDir: string
): Promise<RuntimeProfileCreationMarker | null> {
    try {
        const raw = await readFile(
            join(userDataDir, OPENSTEER_RUNTIME_CREATING_FILE),
            'utf8'
        )
        return parseRuntimeProfileCreationMarker(JSON.parse(raw))
    } catch {
        return null
    }
}

async function requireRuntimeProfileMetadata(
    userDataDir: string,
    expectedPersistentUserDataDir: string,
    expectedProfileDirectory: string,
    displayUserDataDir = userDataDir
): Promise<RuntimeProfileMetadata> {
    const metadata = await readRuntimeProfileMetadata(userDataDir)
    if (!metadata) {
        throw new Error(
            `Runtime profile metadata was not found for "${displayUserDataDir}".`
        )
    }
    if (metadata.profileDirectory !== expectedProfileDirectory) {
        throw new Error(
            `Runtime profile "${displayUserDataDir}" was created for profile "${metadata.profileDirectory ?? 'unknown'}", expected "${expectedProfileDirectory}".`
        )
    }
    if (metadata.persistentUserDataDir !== expectedPersistentUserDataDir) {
        throw new Error(
            `Runtime profile "${displayUserDataDir}" does not belong to persistent profile "${expectedPersistentUserDataDir}".`
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
            hash: await hashSnapshotFile(sourcePath, relativePath),
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

async function hashSnapshotFile(
    filePath: string,
    relativePath: string
): Promise<string> {
    const normalizedJson = await readNormalizedSnapshotJson(filePath, relativePath)
    if (normalizedJson !== null) {
        return createHash('sha256')
            .update(JSON.stringify(normalizedJson))
            .digest('hex')
    }

    return await hashFile(filePath)
}

async function readNormalizedSnapshotJson(
    filePath: string,
    relativePath: string
): Promise<JsonValue | null> {
    const normalizer = SNAPSHOT_JSON_NORMALIZERS.get(relativePath)
    if (!normalizer) {
        return null
    }

    try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown
        return normalizer(parsed)
    } catch {
        return null
    }
}

const SNAPSHOT_JSON_NORMALIZERS = new Map<
    string,
    (value: unknown) => JsonValue
>([['Local State', normalizeLocalStateSnapshotJson]])

function normalizeLocalStateSnapshotJson(value: unknown): JsonValue {
    if (!isJsonRecord(value)) {
        return value as JsonValue
    }

    // Chrome rewrites telemetry bookkeeping on every launch/close, but those
    // counters are not durable profile identity and should not block merges.
    const { user_experience_metrics: _ignored, ...rest } = value
    return rest
}

function isJsonRecord(value: unknown): value is JsonRecord {
    return (
        !!value &&
        typeof value === 'object' &&
        !Array.isArray(value)
    )
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

async function isHealthyPersistentProfile(
    userDataDir: string,
    expectedSourceUserDataDir: string,
    expectedProfileDirectory: string
): Promise<boolean> {
    if (
        !existsSync(userDataDir) ||
        !existsSync(join(userDataDir, expectedProfileDirectory))
    ) {
        return false
    }

    const metadata = await readPersistentProfileMetadata(userDataDir)
    return (
        metadata?.source === expectedSourceUserDataDir &&
        metadata.profileDirectory === expectedProfileDirectory
    )
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

async function withPersistentProfileWriteAccess<T>(
    targetUserDataDir: string,
    action: () => Promise<T>
): Promise<T> {
    const releaseWriteLock = await acquirePersistentProfileWriteLock(
        targetUserDataDir
    )

    try {
        await waitForRuntimeProfileCreationsToDrain(targetUserDataDir)
        await waitForSharedRealBrowserSessionToDrain(targetUserDataDir)
        return await action()
    } finally {
        await releaseWriteLock()
    }
}

function buildPersistentProfileTempDirPrefix(targetUserDataDir: string): string {
    return join(
        dirname(targetUserDataDir),
        `${buildPersistentProfileTempDirNamePrefix(targetUserDataDir)}${process.pid}-${CURRENT_PROCESS_OWNER.processStartedAtMs}-`
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
        `${buildPersistentProfileBackupDirNamePrefix(targetUserDataDir)}${Date.now()}-${process.pid}-${CURRENT_PROCESS_OWNER.processStartedAtMs}-${randomUUID()}`
    )
}

function buildPersistentProfileBackupDirNamePrefix(
    targetUserDataDir: string
): string {
    return `${basename(targetUserDataDir)}-backup-`
}

function buildRuntimeProfileCreationRegistryDirPath(
    persistentUserDataDir: string
): string {
    return join(
        dirname(persistentUserDataDir),
        `${basename(persistentUserDataDir)}.creating`
    )
}

function buildRuntimeProfileCreationRegistrationPath(
    persistentUserDataDir: string,
    runtimeUserDataDir: string
): string {
    const key = createHash('sha256')
        .update(runtimeUserDataDir)
        .digest('hex')
        .slice(0, 16)

    return join(
        buildRuntimeProfileCreationRegistryDirPath(persistentUserDataDir),
        `${key}.json`
    )
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

async function reserveRuntimeProfileCreation(
    persistentUserDataDir: string,
    runtimeRootDir: string,
    profileDirectory: string | null
): Promise<IsolatedRuntimeProfileResult> {
    while (true) {
        let runtimeUserDataDir: string | null = null

        await withPersistentProfileControlLock(
            persistentUserDataDir,
            async () => {
                if (await isPersistentProfileWriteLocked(persistentUserDataDir)) {
                    return
                }
                if (await hasLiveSharedRealBrowserSession(persistentUserDataDir)) {
                    return
                }

                const createdRuntimeUserDataDir = await mkdtemp(
                    buildRuntimeProfileDirPrefix(
                        runtimeRootDir,
                        persistentUserDataDir
                    )
                )
                runtimeUserDataDir = createdRuntimeUserDataDir
                const marker: RuntimeProfileCreationMarker = {
                    creator: CURRENT_PROCESS_OWNER,
                    persistentUserDataDir,
                    profileDirectory,
                    runtimeUserDataDir: createdRuntimeUserDataDir,
                }

                await writeRuntimeProfileCreationMarker(
                    createdRuntimeUserDataDir,
                    marker
                )
                await writeRuntimeProfileCreationRegistration(marker)
            }
        )

        if (runtimeUserDataDir) {
            return {
                persistentUserDataDir,
                userDataDir: runtimeUserDataDir,
            }
        }

        await sleep(PERSISTENT_PROFILE_LOCK_RETRY_DELAY_MS)
    }
}

async function clearRuntimeProfileCreationState(
    runtimeUserDataDir: string,
    persistentUserDataDir: string
): Promise<void> {
    await Promise.all([
        rm(join(runtimeUserDataDir, OPENSTEER_RUNTIME_CREATING_FILE), {
            force: true,
        }).catch(() => undefined),
        rm(
            buildRuntimeProfileCreationRegistrationPath(
                persistentUserDataDir,
                runtimeUserDataDir
            ),
            {
                force: true,
            }
        ).catch(() => undefined),
    ])
}

async function writeRuntimeProfileCreationRegistration(
    marker: RuntimeProfileCreationMarker
): Promise<void> {
    const registryDirPath = buildRuntimeProfileCreationRegistryDirPath(
        marker.persistentUserDataDir
    )
    await mkdir(registryDirPath, { recursive: true })
    await writeFile(
        buildRuntimeProfileCreationRegistrationPath(
            marker.persistentUserDataDir,
            marker.runtimeUserDataDir
        ),
        JSON.stringify(marker, null, 2)
    )
}

async function listRuntimeProfileCreationRegistrations(
    persistentUserDataDir: string
): Promise<
    Array<{
        filePath: string
        marker: RuntimeProfileCreationMarker | null
    }>
> {
    const registryDirPath = buildRuntimeProfileCreationRegistryDirPath(
        persistentUserDataDir
    )

    let entries: Dirent<string>[]
    try {
        entries = await readdir(registryDirPath, {
            encoding: 'utf8',
            withFileTypes: true,
        })
    } catch {
        return []
    }

    return await Promise.all(
        entries
            .filter((entry) => entry.isFile())
            .map(async (entry) => {
                const filePath = join(registryDirPath, entry.name)
                return {
                    filePath,
                    marker: await readRuntimeProfileCreationRegistration(filePath),
                }
            })
    )
}

async function readRuntimeProfileCreationRegistration(
    filePath: string
): Promise<RuntimeProfileCreationMarker | null> {
    try {
        const raw = await readFile(filePath, 'utf8')
        return parseRuntimeProfileCreationMarker(JSON.parse(raw))
    } catch {
        return null
    }
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
            const creationMarker = await readRuntimeProfileCreationMarker(
                runtimeDirPath
            )
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
            if (creationMarker) {
                await clearRuntimeProfileCreationState(
                    runtimeDirPath,
                    creationMarker.persistentUserDataDir
                )
            }
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
    const creationMarker = await readRuntimeProfileCreationMarker(runtimeDirPath)
    if (
        creationMarker &&
        (await getProcessLiveness(creationMarker.creator)) !== 'dead'
    ) {
        return true
    }

    const metadata = await readRuntimeProfileMetadata(runtimeDirPath)
    if (metadata && (await getProcessLiveness(metadata.creator)) !== 'dead') {
        return true
    }

    return liveProcessCommandLines.some((commandLine) =>
        commandLineIncludesUserDataDir(commandLine, runtimeDirPath)
    )
}

async function claimRuntimeProfileForPersist(
    runtimeUserDataDir: string
): Promise<string> {
    while (true) {
        await waitForRuntimeProfileProcessesToDrain(runtimeUserDataDir)

        const claimedRuntimeUserDataDir =
            buildClaimedRuntimeProfileDirPath(runtimeUserDataDir)

        try {
            await rename(runtimeUserDataDir, claimedRuntimeUserDataDir)
        } catch (error) {
            const code = getErrorCode(error)
            if (code === 'ENOENT') {
                throw new Error(
                    `Runtime profile "${runtimeUserDataDir}" was not found.`
                )
            }
            if (code === 'EACCES' || code === 'EBUSY' || code === 'EPERM') {
                await sleep(PERSISTENT_PROFILE_LOCK_RETRY_DELAY_MS)
                continue
            }
            throw error
        }

        if (!(await hasLiveProcessUsingUserDataDir(runtimeUserDataDir))) {
            return claimedRuntimeUserDataDir
        }

        await rename(
            claimedRuntimeUserDataDir,
            runtimeUserDataDir
        ).catch(() => undefined)
        await sleep(PERSISTENT_PROFILE_LOCK_RETRY_DELAY_MS)
    }
}

async function restoreClaimedRuntimeProfile(
    claimedRuntimeUserDataDir: string,
    runtimeUserDataDir: string
): Promise<void> {
    if (!existsSync(claimedRuntimeUserDataDir)) {
        return
    }
    if (existsSync(runtimeUserDataDir)) {
        throw new Error(
            `Runtime profile "${runtimeUserDataDir}" was recreated before the failed persist could restore it from "${claimedRuntimeUserDataDir}".`
        )
    }

    await rename(claimedRuntimeUserDataDir, runtimeUserDataDir)
}

function buildClaimedRuntimeProfileDirPath(runtimeUserDataDir: string): string {
    return join(
        dirname(runtimeUserDataDir),
        `${basename(runtimeUserDataDir)}-persisting-${process.pid}-${CURRENT_PROCESS_OWNER.processStartedAtMs}-${randomUUID()}`
    )
}

async function waitForRuntimeProfileProcessesToDrain(
    runtimeUserDataDir: string
): Promise<void> {
    while (await hasLiveProcessUsingUserDataDir(runtimeUserDataDir)) {
        await sleep(PERSISTENT_PROFILE_LOCK_RETRY_DELAY_MS)
    }
}

async function hasLiveProcessUsingUserDataDir(
    userDataDir: string
): Promise<boolean> {
    const liveProcessCommandLines = await listProcessCommandLines()

    return liveProcessCommandLines.some((commandLine) =>
        commandLineIncludesUserDataDir(commandLine, userDataDir)
    )
}

export async function hasActiveRuntimeProfileCreations(
    persistentUserDataDir: string
): Promise<boolean> {
    const registrations = await listRuntimeProfileCreationRegistrations(
        persistentUserDataDir
    )
    let hasLiveCreation = false

    for (const registration of registrations) {
        const marker = registration.marker
        if (
            !marker ||
            marker.persistentUserDataDir !== persistentUserDataDir
        ) {
            await rm(registration.filePath, {
                force: true,
            }).catch(() => undefined)
            continue
        }

        const runtimeMarker = await readRuntimeProfileCreationMarker(
            marker.runtimeUserDataDir
        )
        if (
            !runtimeMarker ||
            runtimeMarker.persistentUserDataDir !== persistentUserDataDir ||
            runtimeMarker.runtimeUserDataDir !== marker.runtimeUserDataDir
        ) {
            await clearRuntimeProfileCreationState(
                marker.runtimeUserDataDir,
                persistentUserDataDir
            )
            continue
        }

        if ((await getProcessLiveness(runtimeMarker.creator)) === 'dead') {
            await clearRuntimeProfileCreationState(
                marker.runtimeUserDataDir,
                persistentUserDataDir
            )
            await rm(marker.runtimeUserDataDir, {
                recursive: true,
                force: true,
            }).catch(() => undefined)
            continue
        }

        hasLiveCreation = true
    }

    return hasLiveCreation
}

async function waitForRuntimeProfileCreationsToDrain(
    persistentUserDataDir: string
): Promise<void> {
    while (true) {
        if (!(await hasActiveRuntimeProfileCreations(persistentUserDataDir))) {
            return
        }

        await sleep(PERSISTENT_PROFILE_LOCK_RETRY_DELAY_MS)
    }
}

function parseRuntimeProfileCreationMarker(
    value: unknown
): RuntimeProfileCreationMarker | null {
    if (!value || typeof value !== 'object') {
        return null
    }

    const parsed = value as Partial<RuntimeProfileCreationMarker>
    const creator = parseProcessOwner(parsed.creator)
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
    const runtimeUserDataDir =
        typeof parsed.runtimeUserDataDir === 'string'
            ? parsed.runtimeUserDataDir
            : undefined

    if (
        !creator ||
        persistentUserDataDir === undefined ||
        profileDirectory === undefined ||
        runtimeUserDataDir === undefined
    ) {
        return null
    }

    return {
        creator,
        persistentUserDataDir,
        profileDirectory,
        runtimeUserDataDir,
    }
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
