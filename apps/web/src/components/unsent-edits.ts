import { UnsentEdits, type HostClient } from "@opensteer/client/host";

const storageKey = "opensteer:unsent-waiting-edits:v1";

/**
 * This device's unsent waiting-message edits, kept beside its composer drafts in local storage:
 * they survive a view going away, a history reset and a reload, until the person saves, sends,
 * moves or discards them.
 */
export const unsentEdits = new UnsentEdits({
  read: () => {
    try {
      return globalThis.localStorage?.getItem(storageKey) ?? null;
    } catch {
      return null;
    }
  },
  write: (document) => {
    globalThis.localStorage.setItem(storageKey, document);
  },
});

/** The login whose edits these are, as composer drafts scope theirs; null before it is known. */
export function unsentEditScope(client: HostClient): string | null {
  // A client with no signed-in shell to name (a test double, a sign-in in progress) keeps nothing.
  const snapshot = client.getSnapshot?.();
  return snapshot?.deploymentId && snapshot.user
    ? JSON.stringify([snapshot.deploymentId, snapshot.user.id])
    : null;
}
