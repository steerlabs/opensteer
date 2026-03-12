import { basename, dirname, join } from 'node:path'
import {
    acquireDirLock,
    isDirLockHeld,
    tryAcquireDirLock,
    type LockRelease,
    withDirLock,
} from './dir-lock.js'

export const PERSISTENT_PROFILE_LOCK_RETRY_DELAY_MS = 50

export async function withPersistentProfileControlLock<T>(
    targetUserDataDir: string,
    action: () => Promise<T>
): Promise<T> {
    return await withDirLock(
        buildPersistentProfileControlLockDirPath(targetUserDataDir),
        action
    )
}

export async function acquirePersistentProfileWriteLock(
    targetUserDataDir: string
): Promise<LockRelease> {
    const controlLockDirPath =
        buildPersistentProfileControlLockDirPath(targetUserDataDir)
    const writeLockDirPath = buildPersistentProfileWriteLockDirPath(
        targetUserDataDir
    )

    while (true) {
        let releaseWriteLock: LockRelease | null = null
        const releaseControlLock = await acquireDirLock(controlLockDirPath)

        try {
            releaseWriteLock = await tryAcquireDirLock(writeLockDirPath)
        } finally {
            await releaseControlLock()
        }

        if (releaseWriteLock) {
            return releaseWriteLock
        }

        await sleep(PERSISTENT_PROFILE_LOCK_RETRY_DELAY_MS)
    }
}

export async function isPersistentProfileWriteLocked(
    targetUserDataDir: string
): Promise<boolean> {
    return await isDirLockHeld(
        buildPersistentProfileWriteLockDirPath(targetUserDataDir)
    )
}

function buildPersistentProfileWriteLockDirPath(targetUserDataDir: string): string {
    return join(dirname(targetUserDataDir), `${basename(targetUserDataDir)}.lock`)
}

function buildPersistentProfileControlLockDirPath(
    targetUserDataDir: string
): string {
    return join(
        dirname(targetUserDataDir),
        `${basename(targetUserDataDir)}.control.lock`
    )
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
}
