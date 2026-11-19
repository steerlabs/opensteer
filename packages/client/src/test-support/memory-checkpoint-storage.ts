import { utf8ByteLength } from "@opensteer/core";
import {
  checkpointFence,
  noCheckpointFences,
  raiseCheckpointFence,
  type CheckpointFences,
  type CheckpointStorage,
} from "../host/personal-stream-cache.js";

/**
 * Checkpoint storage in memory, with a write clock tests can read. Two caches over one instance
 * stand for two renderers or processes sharing one store.
 */
export function memoryCheckpointStorage(now: () => number = Date.now): CheckpointStorage & {
  readonly values: Map<string, { value: string; savedAt: number }>;
} {
  const values = new Map<string, { value: string; savedAt: number }>();
  let fences: CheckpointFences = noCheckpointFences;
  let clock = 0;
  return {
    values,
    list: async () =>
      [...values].map(([key, { value, savedAt }]) => ({
        key,
        savedAt,
        bytes: utf8ByteLength(value),
      })),
    read: async (key) => values.get(key)?.value ?? null,
    fences: async () => fences,
    write: async (key, value, guard) => {
      if (checkpointFence(fences, guard) !== guard.fence) return false;
      clock = Math.max(clock + 1, now());
      values.set(key, { value, savedAt: clock });
      return true;
    },
    remove: async (keys) => {
      for (const key of keys) values.delete(key);
    },
    clear: async (matches, scope) => {
      for (const key of values.keys()) if (matches(key)) values.delete(key);
      fences = raiseCheckpointFence(fences, scope);
    },
  };
}
