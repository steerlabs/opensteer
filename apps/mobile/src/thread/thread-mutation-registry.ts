import { useMemo, useSyncExternalStore } from "react";
import {
  createThreadMutationGate,
  type ThreadMutationGate,
  type ThreadMutationOwner,
} from "./thread-mutation-gate.js";

/**
 * One Thread's mutation ownership, shared by every surface that mutates it.
 *
 * The composer lives inside the Thread pane and the model picker sheet is a
 * sibling route in the native stack, so no React context can hand the second
 * the gate the first created. The gate therefore lives here, keyed by the
 * scope that already keys drafts — Deployment, user, Thread — and each
 * surface asks for the same entry. Ownership outlives a dismissed sheet: an
 * execution change still in flight keeps the composer's Send blocked until the
 * Host answers, exactly as it did when both controls shared one component.
 */
export interface ThreadMutationScope {
  readonly deploymentId: string;
  readonly threadId: string;
  readonly userId: string | null;
}

export interface ThreadMutationHandle {
  readonly gate: ThreadMutationGate;
  readonly owner: () => ThreadMutationOwner | null;
  /** Bound to this entry, so a resubscription cannot land on another one. */
  readonly subscribe: (listener: () => void) => () => void;
}

interface ThreadMutationEntry {
  readonly handle: ThreadMutationHandle;
  readonly listeners: Set<() => void>;
  owner: ThreadMutationOwner | null;
}

/**
 * Kept for the life of the process. An entry is a gate, a flag and a listener
 * set — bytes — and dropping one is the only way two surfaces of the same
 * Thread can end up holding different gates: a hook retains the entry it first
 * read across an effect teardown (a Strict Mode replay, a Fast Refresh), so an
 * entry deleted while idle would be mutated by that hook and watched by nobody.
 * A claim also has to survive the pane that made it, which is the whole point
 * of the registry.
 */
const entries = new Map<string, ThreadMutationEntry>();

/** A separator no id can contain, so two scopes never spell the same key. */
const scopeSeparator = "|";

export function threadMutationScopeKey(scope: ThreadMutationScope): string {
  return [scope.deploymentId, scope.userId ?? "signed-out", scope.threadId].join(scopeSeparator);
}

/**
 * The shared entry for one scope, created on first use. `initialOwner` seeds a
 * fresh entry only: a durable pending send found on disk is the composer's
 * claim, and a sheet opened later must see it rather than overwrite it.
 */
export function threadMutationEntry(
  scope: ThreadMutationScope,
  initialOwner: ThreadMutationOwner | null = null,
): ThreadMutationHandle {
  const key = threadMutationScopeKey(scope);
  const existing = entries.get(key);
  if (existing !== undefined) return existing.handle;
  const listeners = new Set<() => void>();
  const created: ThreadMutationEntry = {
    handle: {
      gate: createThreadMutationGate(initialOwner, (owner) => {
        created.owner = owner;
        for (const listener of listeners) listener();
      }),
      owner: () => created.owner,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    listeners,
    owner: initialOwner,
  };
  entries.set(key, created);
  return created.handle;
}

/**
 * The gate and the current owner for one scope, from any surface. The gate
 * identity is stable for the scope, so it can be handed to memoised children.
 * The scope's key is its identity; the object literal a caller builds each
 * render is not, which is why the memo below depends on the key alone.
 */
export function useThreadMutation(
  scope: ThreadMutationScope,
  initialOwner: ThreadMutationOwner | null = null,
): { readonly gate: ThreadMutationGate; readonly owner: ThreadMutationOwner | null } {
  const { deploymentId, threadId, userId } = scope;
  const entry = useMemo(
    () => threadMutationEntry({ deploymentId, threadId, userId }, initialOwner),
    // A later initial owner never overwrites a live claim, so it is not an input.
    [deploymentId, threadId, userId],
  );
  const owner = useSyncExternalStore(entry.subscribe, entry.owner, entry.owner);
  return { gate: entry.gate, owner };
}

/** Test seam: forget every entry between cases. */
export function resetThreadMutationRegistryForTests(): void {
  entries.clear();
}
