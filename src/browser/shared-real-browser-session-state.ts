import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
    CURRENT_PROCESS_OWNER,
    getProcessLiveness,
    parseProcessOwner,
    type ProcessOwner,
} from './process-owner.js'

const SHARED_SESSION_METADATA_FILE = 'session.json'
const SHARED_SESSION_CLIENTS_DIR = 'clients'
const SHARED_SESSION_RETRY_DELAY_MS = 50
const SHARED_SESSION_METADATA_TEMP_FILE_PREFIX =
    `${SHARED_SESSION_METADATA_FILE}.`
const SHARED_SESSION_METADATA_TEMP_FILE_SUFFIX = '.tmp'

interface SharedSessionMetadataRecord {
    exists: boolean
    metadata: SharedSessionMetadata | null
}

export type SharedSessionState = 'launching' | 'ready' | 'closing'

export interface SharedSessionMetadata {
    browserOwner: ProcessOwner
    createdAt: string
    debugPort: number
    executablePath: string
    headless: boolean
    persistentUserDataDir: string
    profileDirectory: string
    sessionId: string
    state: SharedSessionState
    stateOwner: ProcessOwner
}

export function buildSharedSessionDirPath(
    persistentUserDataDir: string
): string {
    return join(
        dirname(persistentUserDataDir),
        `${basename(persistentUserDataDir)}.session`
    )
}

export function buildSharedSessionLockPath(
    persistentUserDataDir: string
): string {
    return `${buildSharedSessionDirPath(persistentUserDataDir)}.lock`
}

export function buildSharedSessionClientsDirPath(
    persistentUserDataDir: string
): string {
    return join(
        buildSharedSessionDirPath(persistentUserDataDir),
        SHARED_SESSION_CLIENTS_DIR
    )
}

export function buildSharedSessionClientPath(
    persistentUserDataDir: string,
    clientId: string
): string {
    return join(
        buildSharedSessionClientsDirPath(persistentUserDataDir),
        `${clientId}.json`
    )
}

export async function readSharedSessionMetadata(
    persistentUserDataDir: string
): Promise<SharedSessionMetadata | null> {
    return (await readSharedSessionMetadataRecord(persistentUserDataDir)).metadata
}

export async function writeSharedSessionMetadata(
    persistentUserDataDir: string,
    metadata: SharedSessionMetadata
): Promise<void> {
    const sessionDirPath = buildSharedSessionDirPath(persistentUserDataDir)
    const metadataPath = buildSharedSessionMetadataPath(persistentUserDataDir)
    const tempPath = buildSharedSessionMetadataTempPath(sessionDirPath)

    await mkdir(sessionDirPath, { recursive: true })

    try {
        await writeFile(tempPath, JSON.stringify(metadata, null, 2))
        await rename(tempPath, metadataPath)
    } finally {
        await rm(tempPath, { force: true }).catch(() => undefined)
    }
}

export async function hasLiveSharedRealBrowserSession(
    persistentUserDataDir: string
): Promise<boolean> {
    const sessionDirPath = buildSharedSessionDirPath(persistentUserDataDir)
    const metadataRecord = await readSharedSessionMetadataRecord(
        persistentUserDataDir
    )

    if (!metadataRecord.exists) {
        return await hasLiveSharedSessionPublisherOrClients(sessionDirPath)
    }
    if (!metadataRecord.metadata) {
        return true
    }

    if (
        (await getProcessLiveness(metadataRecord.metadata.browserOwner)) ===
        'dead'
    ) {
        await rm(sessionDirPath, {
            force: true,
            recursive: true,
        }).catch(() => undefined)
        return false
    }

    return true
}

export async function waitForSharedRealBrowserSessionToDrain(
    persistentUserDataDir: string
): Promise<void> {
    while (true) {
        if (!(await hasLiveSharedRealBrowserSession(persistentUserDataDir))) {
            return
        }
        await sleep(SHARED_SESSION_RETRY_DELAY_MS)
    }
}

async function readSharedSessionMetadataRecord(
    persistentUserDataDir: string
): Promise<SharedSessionMetadataRecord> {
    try {
        const raw = await readFile(
            buildSharedSessionMetadataPath(persistentUserDataDir),
            'utf8'
        )

        return {
            exists: true,
            metadata: parseSharedSessionMetadata(JSON.parse(raw)),
        }
    } catch (error) {
        return {
            exists: getErrorCode(error) !== 'ENOENT',
            metadata: null,
        }
    }
}

async function hasLiveSharedSessionPublisherOrClients(
    sessionDirPath: string
): Promise<boolean> {
    if (!existsSync(sessionDirPath)) {
        return false
    }

    let entries: string[]
    try {
        entries = await readDirNames(sessionDirPath)
    } catch (error) {
        return getErrorCode(error) !== 'ENOENT'
    }

    let hasUnknownEntries = false

    for (const entry of entries) {
        if (entry === SHARED_SESSION_METADATA_FILE) {
            return true
        }
        if (entry === SHARED_SESSION_CLIENTS_DIR) {
            if (await hasDirectoryEntries(join(sessionDirPath, entry))) {
                return true
            }
            continue
        }

        const owner = parseSharedSessionMetadataTempOwner(entry)
        if (!owner) {
            if (isSharedSessionMetadataTempFile(entry)) {
                continue
            }
            hasUnknownEntries = true
            continue
        }
        if ((await getProcessLiveness(owner)) !== 'dead') {
            return true
        }
    }

    if (hasUnknownEntries) {
        return true
    }

    await rm(sessionDirPath, {
        force: true,
        recursive: true,
    }).catch(() => undefined)
    return false
}

function buildSharedSessionMetadataPath(
    persistentUserDataDir: string
): string {
    return join(
        buildSharedSessionDirPath(persistentUserDataDir),
        SHARED_SESSION_METADATA_FILE
    )
}

function buildSharedSessionMetadataTempPath(sessionDirPath: string): string {
    return join(
        sessionDirPath,
        [
            SHARED_SESSION_METADATA_FILE,
            CURRENT_PROCESS_OWNER.pid,
            CURRENT_PROCESS_OWNER.processStartedAtMs,
            randomUUID(),
            'tmp',
        ].join('.')
    )
}

function parseSharedSessionMetadata(
    value: unknown
): SharedSessionMetadata | null {
    if (!value || typeof value !== 'object') {
        return null
    }

    const parsed = value as Partial<SharedSessionMetadata>
    const browserOwner = parseProcessOwner(parsed.browserOwner)
    const stateOwner = parseProcessOwner(parsed.stateOwner)
    const state =
        parsed.state === 'launching' ||
        parsed.state === 'ready' ||
        parsed.state === 'closing'
            ? parsed.state
            : null

    if (
        !browserOwner ||
        !stateOwner ||
        typeof parsed.createdAt !== 'string' ||
        typeof parsed.debugPort !== 'number' ||
        typeof parsed.executablePath !== 'string' ||
        typeof parsed.headless !== 'boolean' ||
        typeof parsed.persistentUserDataDir !== 'string' ||
        typeof parsed.profileDirectory !== 'string' ||
        typeof parsed.sessionId !== 'string' ||
        !state
    ) {
        return null
    }

    return {
        browserOwner,
        createdAt: parsed.createdAt,
        debugPort: parsed.debugPort,
        executablePath: parsed.executablePath,
        headless: parsed.headless,
        persistentUserDataDir: parsed.persistentUserDataDir,
        profileDirectory: parsed.profileDirectory,
        sessionId: parsed.sessionId,
        state,
        stateOwner,
    }
}

function parseSharedSessionMetadataTempOwner(
    entryName: string
): ProcessOwner | null {
    if (!isSharedSessionMetadataTempFile(entryName)) {
        return null
    }

    const segments = entryName.split('.')
    if (segments.length < 5) {
        return null
    }

    return parseProcessOwner({
        pid: Number.parseInt(segments[2] ?? '', 10),
        processStartedAtMs: Number.parseInt(segments[3] ?? '', 10),
    })
}

function isSharedSessionMetadataTempFile(entryName: string): boolean {
    return (
        entryName.startsWith(SHARED_SESSION_METADATA_TEMP_FILE_PREFIX) &&
        entryName.endsWith(SHARED_SESSION_METADATA_TEMP_FILE_SUFFIX)
    )
}

function getErrorCode(error: unknown): string | undefined {
    return typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string'
        ? error.code
        : undefined
}

async function hasDirectoryEntries(dirPath: string): Promise<boolean> {
    try {
        return (await readDirNames(dirPath)).length > 0
    } catch (error) {
        return getErrorCode(error) !== 'ENOENT'
    }
}

async function readDirNames(dirPath: string): Promise<string[]> {
    return await readdir(dirPath, { encoding: 'utf8' })
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
}
