import type { ListingPrivateFilesystem } from "@opensteer/client/connections";
import {
  checkpointFence,
  noCheckpointFences,
  personalCheckpointMaxBytes,
  raiseCheckpointFence,
  type CheckpointFences,
  type CheckpointStorage,
} from "@opensteer/client/host";
import { utf8ByteLength } from "@opensteer/core";

type Entry = { readonly savedAt: number; readonly bytes: number };
const fencesName = "fences.json";
const fencesMaxBytes = 64 * 1024;
const checkpointName = /^[0-9a-f]{16}\.json$/u;

/**
 * Saved personal checkpoints as one private file per scope. The directory is the only record of
 * what is saved: each file names its key and when it was saved, and `fences.json` holds the
 * fences. A clear first raises the fence in one atomic write, then deletes; on every start and
 * every clear the directory is listed and any file not valid under the current fences — an
 * orphan, a journal left by an interrupted write, a record saved before a clear — is deleted, so
 * no interruption leaves private state that a later clear cannot find. One process owns the
 * directory: a write checks the fences before anything awaits.
 */
export function fileCheckpointStorage(
  privateFiles: ListingPrivateFilesystem,
  directory: string,
): CheckpointStorage {
  const pathOf = (key: string) => `${directory}/${fileName(key)}.json`;
  let fences: CheckpointFences = noCheckpointFences;
  let entries = new Map<string, Entry>();
  const sweep = async () => {
    entries = await sweepDirectory(privateFiles, directory, fences);
  };
  const ready = (async () => {
    fences = await readFences(privateFiles, `${directory}/${fencesName}`);
    await sweep();
  })();
  // A failed start leaves nothing listed; the next clear sweeps again.
  const started = () => ready.catch(() => undefined);
  return {
    list: async () => {
      await started();
      return [...entries].map(([key, entry]) => ({ key, ...entry }));
    },
    read: async (key) => {
      await started();
      if (!entries.has(key)) return null;
      const held = await readCheckpoint(privateFiles, pathOf(key));
      // The file names its key: two keys that share a file name never read each other.
      return held?.key === key ? held.value : null;
    },
    fences: async () => {
      await started();
      return fences;
    },
    write: async (key, value, guard) => {
      await started();
      if (checkpointFence(fences, guard) !== guard.fence) return false;
      const savedAt = Date.now();
      await privateFiles.writeFileAtomic(pathOf(key), `${key}\n${savedAt}\n${value}`);
      entries.set(key, { savedAt, bytes: utf8ByteLength(value) });
      return true;
    },
    remove: async (keys) => {
      await started();
      for (const key of keys) {
        entries.delete(key);
        await privateFiles.removeFile(pathOf(key));
      }
    },
    clear: async (matches, scope) => {
      await started();
      // The commit point: once the raised fence is on disk, nothing saved under the old one is
      // valid, and the sweep below or at the next start deletes it whatever interrupts this.
      fences = raiseCheckpointFence(fences, scope);
      await privateFiles.writeFileAtomic(`${directory}/${fencesName}`, JSON.stringify(fences));
      for (const key of [...entries.keys()].filter(matches)) {
        entries.delete(key);
        await privateFiles.removeFile(pathOf(key));
      }
      await sweep();
    },
  };
}

/**
 * Deletes every file in the directory that is not a checkpoint valid under `fences`, and returns
 * the ones that are.
 */
async function sweepDirectory(
  privateFiles: ListingPrivateFilesystem,
  directory: string,
  fences: CheckpointFences,
): Promise<Map<string, Entry>> {
  const kept = new Map<string, Entry>();
  const journal = /\.(new|old)$/u;
  // A journal file stands for the file it was writing: reading that settles the journal.
  const names = new Set(
    (await privateFiles.listFiles(directory)).map((name) => name.replace(journal, "")),
  );
  for (const name of names) {
    if (name === fencesName) continue;
    const path = `${directory}/${name}`;
    const held = checkpointName.test(name) ? await readCheckpoint(privateFiles, path) : null;
    const valid =
      held !== null && `${fileName(held.key)}.json` === name && validUnder(fences, held.value);
    if (valid) kept.set(held.key, { savedAt: held.savedAt, bytes: utf8ByteLength(held.value) });
    else await privateFiles.removeFile(path);
  }
  // Whatever journal is still left belongs to no valid file.
  for (const name of await privateFiles.listFiles(directory))
    if (journal.test(name)) await privateFiles.removeFile(`${directory}/${name}`);
  return kept;
}

/** A saved record names its viewer and the fence it was written under. */
function validUnder(fences: CheckpointFences, value: string) {
  try {
    const record: unknown = JSON.parse(value);
    if (!record || typeof record !== "object") return false;
    const fence = Reflect.get(record, "fence");
    const scope = Reflect.get(record, "scope");
    if (typeof fence !== "number" || !scope || typeof scope !== "object") return false;
    const deploymentId = Reflect.get(scope, "deploymentId");
    const viewerId = Reflect.get(scope, "viewerId");
    return (
      typeof deploymentId === "string" &&
      typeof viewerId === "string" &&
      fence >= checkpointFence(fences, { deploymentId, viewerId })
    );
  } catch {
    return false;
  }
}

async function readCheckpoint(
  privateFiles: ListingPrivateFilesystem,
  path: string,
): Promise<{ key: string; savedAt: number; value: string } | null> {
  const bytes = await privateFiles
    .readFile(path, personalCheckpointMaxBytes + 4096)
    .catch(() => null);
  if (!bytes) return null;
  const text = new TextDecoder().decode(bytes);
  const first = text.indexOf("\n");
  const second = first < 0 ? -1 : text.indexOf("\n", first + 1);
  if (second < 0) return null;
  const savedAt = Number(text.slice(first + 1, second));
  return Number.isFinite(savedAt)
    ? { key: text.slice(0, first), savedAt, value: text.slice(second + 1) }
    : null;
}

async function readFences(
  privateFiles: ListingPrivateFilesystem,
  path: string,
): Promise<CheckpointFences> {
  const bytes = await privateFiles.readFile(path, fencesMaxBytes).catch(() => null);
  if (!bytes) return noCheckpointFences;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object") return noCheckpointFences;
    const all = Reflect.get(value, "all");
    const deployments = Reflect.get(value, "deployments");
    const viewers = Reflect.get(value, "viewers");
    return {
      all: typeof all === "number" ? all : 0,
      deployments: deployments && typeof deployments === "object" ? deployments : {},
      viewers: viewers && typeof viewers === "object" ? viewers : {},
    };
  } catch {
    // Unreadable fences are never trusted lower than they were: everything saved goes.
    return { all: Number.MAX_SAFE_INTEGER, deployments: {}, viewers: {} };
  }
}

/**
 * Removes the saved state of every earlier format under `root` (`personal-stream-v<format>`); none
 * is migrated. Every file in those directories goes, journals included.
 */
export async function dropEarlierCheckpointFormats(
  privateFiles: ListingPrivateFilesystem,
  root: string,
  format: number,
): Promise<void> {
  for (let earlier = 64; earlier < format; earlier++) {
    const directory = `${root}/personal-stream-v${earlier}`;
    for (const name of await privateFiles.listFiles(directory).catch(() => []))
      await privateFiles.removeFile(`${directory}/${name}`).catch(() => false);
  }
}

/** A short, stable file name for a key (two 32-bit FNV-1a hashes). */
function fileName(key: string) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x811c9dc5);
  }
  return `${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
}
