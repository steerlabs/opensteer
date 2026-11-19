import { utf8ByteLength } from "@opensteer/core";
import type { PrivateFilesystem } from "@opensteer/client/connections";
import {
  checkpointFence,
  noCheckpointFences,
  personalCheckpointMaxBytes,
  raiseCheckpointFence,
  type CheckpointFences,
  type CheckpointStorage,
} from "@opensteer/client/host";

type Entries = Record<string, { readonly savedAt: number; readonly bytes: number }>;
type Index = { readonly entries: Entries; readonly fences: CheckpointFences };
const indexMaxBytes = 64 * 1024;
const empty: Index = { entries: {}, fences: noCheckpointFences };

/**
 * Saved personal checkpoints as one private file per scope, plus a small index that also holds
 * the fences. The index is written before its file, so an interrupted write never leaves a file
 * the index cannot remove. One process owns the directory: a write checks the fences and records
 * itself in the index before anything awaits.
 */
export function fileCheckpointStorage(
  privateFiles: PrivateFilesystem,
  directory: string,
): CheckpointStorage {
  const indexPath = `${directory}/index.json`;
  const pathOf = (key: string) => `${directory}/${fileName(key)}.json`;
  let held: Promise<Index> | undefined;
  const index = () => (held ??= readIndex(privateFiles, indexPath));
  const save = async (next: Index) => {
    held = Promise.resolve(next);
    await privateFiles.writeFileAtomic(indexPath, JSON.stringify(next));
  };
  return {
    list: async () =>
      Object.entries((await index()).entries).map(([key, entry]) => ({
        key,
        savedAt: Number(entry?.savedAt) || 0,
        bytes: Number(entry?.bytes) || 0,
      })),
    read: async (key) => {
      if (!(await index()).entries[key]) return null;
      const bytes = await privateFiles.readFile(pathOf(key), personalCheckpointMaxBytes + 4096);
      if (!bytes) return null;
      const text = new TextDecoder().decode(bytes);
      const split = text.indexOf("\n");
      // The file names its key: two keys that share a file name never read each other.
      return split >= 0 && text.slice(0, split) === key ? text.slice(split + 1) : null;
    },
    fences: async () => (await index()).fences,
    write: async (key, value, guard) => {
      const current = await index();
      if (checkpointFence(current.fences, guard) !== guard.fence) return false;
      await save({
        ...current,
        entries: {
          ...current.entries,
          [key]: { savedAt: Date.now(), bytes: utf8ByteLength(value) },
        },
      });
      await privateFiles.writeFileAtomic(pathOf(key), `${key}\n${value}`);
      return true;
    },
    remove: async (keys) => {
      const current = await index();
      const entries = { ...current.entries };
      for (const key of keys) delete entries[key];
      await save({ ...current, entries });
      for (const key of keys) await privateFiles.removeFile(pathOf(key));
    },
    clear: async (matches, scope) => {
      const current = await index();
      const entries = { ...current.entries };
      const keys = Object.keys(entries).filter(matches);
      for (const key of keys) delete entries[key];
      await save({ entries, fences: raiseCheckpointFence(current.fences, scope) });
      for (const key of keys) await privateFiles.removeFile(pathOf(key));
    },
  };
}

/**
 * Removes the saved state of every earlier format under `root` (`personal-stream-v<format>`); none
 * is migrated. Format 64 kept one file; later ones list their files in an index.
 */
export async function dropEarlierCheckpointFormats(
  privateFiles: PrivateFilesystem,
  root: string,
  format: number,
): Promise<void> {
  for (let earlier = 64; earlier < format; earlier++) {
    const directory = `${root}/personal-stream-v${earlier}`;
    await privateFiles.removeFile(`${directory}/checkpoints.json`).catch(() => false);
    const indexPath = `${directory}/index.json`;
    if (!(await privateFiles.fileExists(indexPath).catch(() => false))) continue;
    const listed = await readIndex(privateFiles, indexPath);
    for (const key of Object.keys(listed.entries))
      await privateFiles.removeFile(`${directory}/${fileName(key)}.json`).catch(() => false);
    await privateFiles.removeFile(indexPath).catch(() => false);
  }
}

async function readIndex(privateFiles: PrivateFilesystem, path: string): Promise<Index> {
  try {
    const bytes = await privateFiles.readFile(path, indexMaxBytes);
    const value: unknown = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
    // Format 65 kept its entries at the top level; a later index nests them beside its fences.
    const entries = "entries" in value ? Reflect.get(value, "entries") : value;
    const fences = "fences" in value ? Reflect.get(value, "fences") : noCheckpointFences;
    return {
      entries: entries && typeof entries === "object" ? (entries as Entries) : {},
      fences:
        fences && typeof fences === "object" ? (fences as CheckpointFences) : noCheckpointFences,
    };
  } catch {
    return empty;
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
