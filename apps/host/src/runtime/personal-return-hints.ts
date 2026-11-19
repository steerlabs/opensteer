import type { PersonalResourceKind } from "@opensteer/protocol/resources";

/**
 * Resources a task's compaction return hint reads besides the task itself: the owner's idle
 * compaction policy, the harness, its environment and the hosting computer's capabilities.
 */
export const returnHintResources: ReadonlySet<PersonalResourceKind> = new Set([
  "settings",
  "environment",
  "machine",
  "harness",
  "harness-catalog",
]);

/**
 * After a commit changes a return-hint input, republishes the `thread` value of each task some
 * device is viewing, never every task. Calls that arrive during a refresh coalesce into one more.
 */
export function createReturnHintRefresh(input: {
  readonly watched: () => ReadonlySet<string>;
  readonly republish: (threadIds: readonly string[]) => Promise<unknown>;
  readonly onError: (error: unknown) => void;
}) {
  let running = false;
  let again = false;
  return (kinds: ReadonlySet<PersonalResourceKind>) => {
    if (![...kinds].some((kind) => returnHintResources.has(kind))) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    void (async () => {
      try {
        do {
          again = false;
          const threadIds = [...input.watched()];
          if (threadIds.length) await input.republish(threadIds);
        } while (again);
      } catch (error) {
        input.onError(error);
      } finally {
        running = false;
      }
    })();
  };
}
