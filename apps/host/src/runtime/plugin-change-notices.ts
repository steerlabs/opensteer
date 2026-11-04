import type { UserId } from "@opensteer/core";
import type { PluginSettingsStore } from "@opensteer/database";

export type PluginChangeTarget = Parameters<PluginSettingsStore["affectedViewers"]>[0];

export interface PluginChangeNotices {
  notify(target: PluginChangeTarget): void;
  close(): Promise<void>;
}

/**
 * Finding who sees a plugin change is a database read, so it runs beside the
 * change that caused it, never in front of it: a computer's disconnect still
 * recovers its Runs if the read fails. Shutdown waits for reads already started
 * before the database closes.
 */
export function createPluginChangeNotices(
  lookup: (target: PluginChangeTarget) => Promise<readonly UserId[]>,
  send: (viewers: readonly UserId[]) => void,
): PluginChangeNotices {
  const pending = new Set<Promise<void>>();
  let closed = false;
  return {
    notify(target) {
      if (closed) return;
      const notice: Promise<void> = lookup(target)
        .then(send)
        .catch((error: unknown) => console.warn("Plugin change notice failed", error))
        .finally(() => pending.delete(notice));
      pending.add(notice);
    },
    async close() {
      closed = true;
      await Promise.all(pending);
    },
  };
}
