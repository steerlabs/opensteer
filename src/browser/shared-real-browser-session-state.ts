import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
    getProcessLiveness,
    parseProcessOwner,
    type ProcessOwner,
} from './process-owner.js'

const SHARED_SESSION_METADATA_FILE = 'session.json'
const SHARED_SESSION_CLIENTS_DIR = 'clients'
const SHARED_SESSION_RETRY_DELAY_MS = 50

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
    try {
        const raw = await readFile(
            buildSharedSessionMetadataPath(persistentUserDataDir),
            'utf8'
        )
        return parseSharedSessionMetadata(JSON.parse(raw))
    } catch {
        return null
    }
}

export async function writeSharedSessionMetadata(
    persistentUserDataDir: string,
    metadata: SharedSessionMetadata
): Promise<void> {
    await mkdir(buildSharedSessionDirPath(persistentUserDataDir), {
        recursive: true,
    })
    await writeFile(
        buildSharedSessionMetadataPath(persistentUserDataDir),
        JSON.stringify(metadata, null, 2)
    )
}

export async function waitForSharedRealBrowserSessionToDrain(
    persistentUserDataDir: string
): Promise<void> {
    while (true) {
        const metadata = await readSharedSessionMetadata(persistentUserDataDir)
        if (!metadata) {
            return
        }

        if ((await getProcessLiveness(metadata.browserOwner)) === 'dead') {
            await rm(buildSharedSessionDirPath(persistentUserDataDir), {
                force: true,
                recursive: true,
            }).catch(() => undefined)
            continue
        }

        await sleep(SHARED_SESSION_RETRY_DELAY_MS)
    }
}

function buildSharedSessionMetadataPath(
    persistentUserDataDir: string
): string {
    return join(
        buildSharedSessionDirPath(persistentUserDataDir),
        SHARED_SESSION_METADATA_FILE
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

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
}
