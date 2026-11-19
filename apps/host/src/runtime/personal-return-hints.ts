import { returnHintResources } from "@opensteer/database";
import type { PersonalResourceKind } from "@opensteer/protocol/resources";

/**
 * After a commit changes a return-hint input, republishes the `thread` value of each task some
 * device is viewing, never every task. Calls that arrive during a refresh coalesce into one more.
 */
export function createReturnHintRefresh<Scope>(input: {
  readonly watched: () => readonly Scope[];
  readonly republish: (scopes: readonly Scope[]) => Promise<unknown>;
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
          const scopes = input.watched();
          if (scopes.length) await input.republish(scopes);
        } while (again);
      } catch (error) {
        input.onError(error);
      } finally {
        running = false;
      }
    })();
  };
}
