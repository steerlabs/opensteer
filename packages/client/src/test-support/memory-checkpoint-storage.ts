import { utf8ByteLength } from "@opensteer/core";
import type { CheckpointStorage } from "../host/personal-stream-cache.js";

/** Checkpoint storage in memory, with a write clock tests can read. */
export function memoryCheckpointStorage(now: () => number = Date.now): CheckpointStorage & {
  readonly values: Map<string, { value: string; savedAt: number }>;
} {
  const values = new Map<string, { value: string; savedAt: number }>();
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
    write: async (key, value) => {
      clock = Math.max(clock + 1, now());
      values.set(key, { value, savedAt: clock });
    },
    remove: async (keys) => {
      for (const key of keys) values.delete(key);
    },
  };
}
