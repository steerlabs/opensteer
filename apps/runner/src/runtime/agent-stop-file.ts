import { readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { nodeErrorCode } from "@opensteer/shared/nodeError";
import { z } from "zod";

const StoredStopSchema = z.object({
  stopped: z.boolean(),
  at: z.iso.datetime().nullable().optional().catch(null),
});

interface StopState {
  readonly stopped: boolean;
  /** When the person stopped agents, when the file says; null otherwise. */
  readonly at: Date | null;
}

function readStop(path: string): StopState {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { stopped: nodeErrorCode(error) !== "ENOENT", at: null };
  }
  try {
    const stored = StoredStopSchema.parse(JSON.parse(text));
    return {
      stopped: stored.stopped,
      at: stored.stopped && stored.at ? new Date(stored.at) : null,
    };
  } catch {
    return { stopped: true, at: null };
  }
}

/**
 * Whether the person stopped agents on this computer, as the app that started
 * this Runner saved it. Read at each admission, so Resume holds from the next
 * one. No file is not stopped; a file that cannot be read or understood is,
 * because a Stop the person pressed must never be lost to a bad read.
 */
export function agentStopFile(path: string): () => boolean {
  return () => readStop(path).stopped;
}

/**
 * The person's Stop for agent work on this computer, as this Runner learns it.
 * `stopped` is read fresh at each admission; `subscribe` hears each change, so
 * the Runner can end what is open and tell its Home at once.
 */
export interface AgentWorkSource {
  stopped(): boolean;
  /** When the person stopped agents, while they are stopped. */
  stoppedAt(): Date | null;
  subscribe(listener: () => void): () => void;
}

/**
 * Watches the saved Stop file. The file is replaced atomically, so its
 * directory is watched; a slow check behind it catches a change a watcher
 * missed. A read that says the same as the last one announces nothing.
 */
export function watchAgentStopFile(
  path: string,
  options: { readonly checkMs?: number } = {},
): AgentWorkSource & { close(): void } {
  const listeners = new Set<() => void>();
  let state = readStop(path);
  let firstSeenAt = state.stopped ? (state.at ?? new Date()) : null;
  const check = () => {
    const next = readStop(path);
    if (next.stopped === state.stopped && next.at?.getTime() === state.at?.getTime()) return;
    state = next;
    firstSeenAt = next.stopped ? (next.at ?? new Date()) : null;
    for (const listener of listeners) listener();
  };
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dirname(path), { persistent: false }, (_event, name) => {
      if (name === null || String(name) === basename(path)) check();
    });
    watcher.on("error", () => undefined);
  } catch {
    watcher = undefined;
  }
  const timer = setInterval(check, options.checkMs ?? 5_000);
  timer.unref();
  return {
    stopped: () => readStop(path).stopped,
    stoppedAt: () => firstSeenAt,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      clearInterval(timer);
      watcher?.close();
      listeners.clear();
    },
  };
}

/** A Stop set from outside, as the desktop app tells a Device Runner it supervises. */
export function manualAgentWork(): AgentWorkSource & { set(stopped: boolean, at?: Date): void } {
  const listeners = new Set<() => void>();
  let since: Date | null = null;
  return {
    stopped: () => since !== null,
    stoppedAt: () => since,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(stopped, at = new Date()) {
      if (stopped === (since !== null)) return;
      since = stopped ? at : null;
      for (const listener of listeners) listener();
    },
  };
}
