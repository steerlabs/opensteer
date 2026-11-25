/**
 * Reloads the extension once the files on disk name another service worker (the unpacked folder
 * was replaced), when no pairing or storage operation is in progress. The reload takes its turn in
 * the storage queue: after every operation queued before it, before any queued after it. A check
 * that instead gave up while one was in progress met the popup's status read (every 1.5 s, which
 * divides the 30 and 60 s alarm) at the same phase on every later alarm, and the old code ran on.
 */
export async function reloadWhenReplaced(input: {
  /** This worker's own script URL. */
  readonly self: string;
  /** The URL of the worker the manifest on disk names, or null when it cannot be read. */
  readonly replacement: () => Promise<string | null>;
  /** The pairing in progress, settling when it ends; null when there is none. */
  readonly pairing: () => Promise<void> | null;
  /** Runs `step` in the storage queue's next turn. */
  readonly storageTurn: (step: () => boolean) => Promise<boolean>;
  readonly reload: () => void;
}): Promise<boolean> {
  const replacement = await input.replacement();
  if (replacement === null || replacement === input.self) return false;
  for (;;) {
    await input.pairing();
    const reloaded = await input.storageTurn(() => {
      if (input.pairing() !== null) return false;
      input.reload();
      return true;
    });
    if (reloaded) return true;
  }
}
