import { utf8ByteLength } from "@opensteer/core";
import type { PrivateFilesystem } from "@opensteer/client/connections";
import { personalCheckpointMaxBytes, type CheckpointStorage } from "@opensteer/client/host";

type Index = Record<string, { readonly savedAt: number; readonly bytes: number }>;
const indexMaxBytes = 64 * 1024;

/**
 * Saved personal checkpoints as one private file per scope, plus a small index. The index is
 * written before its file, so an interrupted write never leaves a file the index cannot remove.
 */
export function fileCheckpointStorage(
  privateFiles: PrivateFilesystem,
  directory: string,
): CheckpointStorage {
  const indexPath = `${directory}/index.json`;
  const pathOf = (key: string) => `${directory}/${fileName(key)}.json`;
  let held: Promise<Index> | undefined;
  const index = () =>
    (held ??= privateFiles
      .readFile(indexPath, indexMaxBytes)
      .then((bytes): Index => {
        const value: unknown = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : {};
        return value && typeof value === "object" && !Array.isArray(value) ? (value as Index) : {};
      })
      .catch((): Index => ({})));
  const save = async (next: Index) => {
    held = Promise.resolve(next);
    await privateFiles.writeFileAtomic(indexPath, JSON.stringify(next));
  };
  return {
    list: async () =>
      Object.entries(await index()).map(([key, entry]) => ({
        key,
        savedAt: Number(entry?.savedAt) || 0,
        bytes: Number(entry?.bytes) || 0,
      })),
    read: async (key) => {
      if (!(await index())[key]) return null;
      const bytes = await privateFiles.readFile(pathOf(key), personalCheckpointMaxBytes + 4096);
      if (!bytes) return null;
      const text = new TextDecoder().decode(bytes);
      const split = text.indexOf("\n");
      // The file names its key: two keys that share a file name never read each other.
      return split >= 0 && text.slice(0, split) === key ? text.slice(split + 1) : null;
    },
    write: async (key, value) => {
      await save({
        ...(await index()),
        [key]: { savedAt: Date.now(), bytes: utf8ByteLength(value) },
      });
      await privateFiles.writeFileAtomic(pathOf(key), `${key}\n${value}`);
    },
    remove: async (keys) => {
      const next = { ...(await index()) };
      for (const key of keys) {
        await privateFiles.removeFile(pathOf(key));
        delete next[key];
      }
      await save(next);
    },
  };
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
