/**
 * Keys earlier builds of this app wrote and nothing reads any more. A build of the personal-sync
 * branch kept the words of unsaved waiting-message edits under `opensteer:unsent-waiting-edits:v1`
 * (private text); it is removed on start so no install keeps it.
 */
const retiredKeys = ["opensteer:unsent-waiting-edits:v1"] as const;

/** Removes every retired key; storage that refuses access has nothing of ours to remove. */
export function removeRetiredStorage(storage: Pick<Storage, "removeItem"> | undefined) {
  for (const key of retiredKeys) {
    try {
      storage?.removeItem(key);
    } catch {
      // Unavailable storage (private mode, blocked site data) holds none of these.
    }
  }
}
