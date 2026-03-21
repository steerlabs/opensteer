import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  CURRENT_PROCESS_OWNER,
  getProcessLiveness,
  parseProcessOwner,
  processOwnersEqual,
  type ProcessOwner,
} from "./process-owner.js";

const LOCK_OWNER_FILE = "owner.json";
const LOCK_RECLAIMER_DIR = "reclaimer";
const LOCK_RETRY_DELAY_MS = 50;

interface ProcessParticipantRecord {
  readonly exists: boolean;
  readonly owner: ProcessOwner | null;
}

export type LockRelease = () => Promise<void>;

export async function withDirLock<T>(lockDirPath: string, action: () => Promise<T>): Promise<T> {
  const releaseLock = await acquireDirLock(lockDirPath);

  try {
    return await action();
  } finally {
    await releaseLock();
  }
}

export async function acquireDirLock(lockDirPath: string): Promise<LockRelease> {
  while (true) {
    const releaseLock = await tryAcquireDirLock(lockDirPath);
    if (releaseLock) {
      return releaseLock;
    }

    await sleep(LOCK_RETRY_DELAY_MS);
  }
}

export async function tryAcquireDirLock(lockDirPath: string): Promise<LockRelease | null> {
  await mkdir(dirname(lockDirPath), { recursive: true });

  while (true) {
    const tempLockDirPath = `${lockDirPath}-${String(process.pid)}-${String(CURRENT_PROCESS_OWNER.processStartedAtMs)}-${randomUUID()}`;

    try {
      await mkdir(tempLockDirPath);
      await writeLockOwner(tempLockDirPath, CURRENT_PROCESS_OWNER);

      try {
        await rename(tempLockDirPath, lockDirPath);
        break;
      } catch (error) {
        if (!wasDirPublishedByAnotherProcess(error, lockDirPath)) {
          throw error;
        }
      }
    } finally {
      await rm(tempLockDirPath, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }

    const owner = await readLockOwner(lockDirPath);
    if (
      (!owner || (await getProcessLiveness(owner)) === "dead") &&
      (await tryReclaimStaleLock(lockDirPath, owner))
    ) {
      continue;
    }

    return null;
  }

  return async () => {
    await rm(lockDirPath, {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  };
}

export async function isDirLockHeld(lockDirPath: string): Promise<boolean> {
  if (!existsSync(lockDirPath)) {
    return false;
  }

  const owner = await readLockOwner(lockDirPath);
  if (
    (!owner || (await getProcessLiveness(owner)) === "dead") &&
    (await tryReclaimStaleLock(lockDirPath, owner))
  ) {
    return false;
  }

  return existsSync(lockDirPath);
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function wasDirPublishedByAnotherProcess(error: unknown, targetDirPath: string): boolean {
  const code = getErrorCode(error);
  return (
    existsSync(targetDirPath) && (code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM")
  );
}

async function writeLockOwner(lockDirPath: string, owner: ProcessOwner): Promise<void> {
  await writeFile(join(lockDirPath, LOCK_OWNER_FILE), JSON.stringify(owner));
}

async function readLockOwner(lockDirPath: string): Promise<ProcessOwner | null> {
  return readLockParticipant(join(lockDirPath, LOCK_OWNER_FILE));
}

async function readLockParticipant(filePath: string): Promise<ProcessOwner | null> {
  return (await readLockParticipantRecord(filePath)).owner;
}

async function readLockParticipantRecord(filePath: string): Promise<ProcessParticipantRecord> {
  try {
    const raw = await readFile(filePath, "utf8");
    return {
      exists: true,
      owner: parseProcessOwner(JSON.parse(raw)),
    };
  } catch (error) {
    return {
      exists: getErrorCode(error) !== "ENOENT",
      owner: null,
    };
  }
}

async function readLockReclaimerRecord(lockDirPath: string): Promise<ProcessParticipantRecord> {
  return readLockParticipantRecord(join(buildLockReclaimerDirPath(lockDirPath), LOCK_OWNER_FILE));
}

async function tryReclaimStaleLock(
  lockDirPath: string,
  expectedOwner: ProcessOwner | null,
): Promise<boolean> {
  if (!(await tryAcquireLockReclaimer(lockDirPath))) {
    return false;
  }

  let reclaimed = false;
  try {
    const owner = await readLockOwner(lockDirPath);
    if (!processOwnersEqual(owner, expectedOwner)) {
      return false;
    }
    if (owner && (await getProcessLiveness(owner)) !== "dead") {
      return false;
    }

    await rm(lockDirPath, {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    reclaimed = !existsSync(lockDirPath);
    return reclaimed;
  } finally {
    if (!reclaimed) {
      await rm(buildLockReclaimerDirPath(lockDirPath), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
  }
}

async function tryAcquireLockReclaimer(lockDirPath: string): Promise<boolean> {
  const reclaimerDirPath = buildLockReclaimerDirPath(lockDirPath);

  while (true) {
    const tempReclaimerDirPath = `${reclaimerDirPath}-${String(process.pid)}-${String(CURRENT_PROCESS_OWNER.processStartedAtMs)}-${randomUUID()}`;

    try {
      await mkdir(tempReclaimerDirPath);
      await writeLockOwner(tempReclaimerDirPath, CURRENT_PROCESS_OWNER);

      try {
        await rename(tempReclaimerDirPath, reclaimerDirPath);
        return true;
      } catch (error) {
        if (getErrorCode(error) === "ENOENT") {
          return false;
        }
        if (!wasDirPublishedByAnotherProcess(error, reclaimerDirPath)) {
          throw error;
        }
      }
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return false;
      }
      throw error;
    } finally {
      await rm(tempReclaimerDirPath, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }

    const reclaimerRecord = await readLockReclaimerRecord(lockDirPath);
    if (!reclaimerRecord.exists || !reclaimerRecord.owner) {
      return false;
    }
    if ((await getProcessLiveness(reclaimerRecord.owner)) !== "dead") {
      return false;
    }

    await rm(reclaimerDirPath, {
      recursive: true,
      force: true,
    }).catch(() => undefined);
  }
}

function buildLockReclaimerDirPath(lockDirPath: string): string {
  return join(lockDirPath, LOCK_RECLAIMER_DIR);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
