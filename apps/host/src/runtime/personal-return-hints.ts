import { returnHintResources } from "@opensteer/database";
import type { PersonalResourceKind } from "@opensteer/protocol/resources";

const retryFloorMs = 1_000;
const retryCeilingMs = 60_000;

/**
 * After a commit changes a return-hint input, republishes the `thread` value of each task some
 * device is viewing, never every task. Calls that arrive during a refresh coalesce into one more.
 * A failed republish is owed: a timer stays armed, backing off, until a pass succeeds.
 */
export function createReturnHintRefresh<Scope>(input: {
  readonly watched: () => readonly Scope[];
  readonly republish: (scopes: readonly Scope[]) => Promise<unknown>;
  readonly onError: (error: unknown) => void;
}) {
  let running = false;
  let again = false;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let delay = retryFloorMs;
  const start = () => {
    if (closed) return;
    if (running) {
      again = true;
      return;
    }
    clearTimeout(retry);
    retry = undefined;
    running = true;
    void (async () => {
      try {
        do {
          again = false;
          const scopes = input.watched();
          if (scopes.length) await input.republish(scopes);
        } while (again);
        delay = retryFloorMs;
      } catch (error) {
        input.onError(error);
        if (!closed) {
          retry = setTimeout(start, delay);
          retry.unref?.();
          delay = Math.min(delay * 2, retryCeilingMs);
        }
      } finally {
        running = false;
      }
    })();
  };
  return Object.assign(
    (kinds: ReadonlySet<PersonalResourceKind>) => {
      if ([...kinds].some((kind) => returnHintResources.has(kind))) start();
    },
    {
      close() {
        closed = true;
        clearTimeout(retry);
        retry = undefined;
      },
    },
  );
}
