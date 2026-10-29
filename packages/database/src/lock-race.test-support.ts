import { recordedTransactionConflicts } from "./lock-order-checker.test-support.js";
import type { Kysely } from "kysely";
import type { DatabaseSchema } from "./schema.js";

/** Stop after a real PostgreSQL statement has acquired its locks. */
export function pauseAfterLock(
  database: Kysely<DatabaseSchema>,
  matches: (node: string) => boolean,
) {
  const conflictsStart = recordedTransactionConflicts.length;
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const queries = new Set<object>();
  let paused = false;
  return {
    get conflicts() {
      return recordedTransactionConflicts.slice(conflictsStart);
    },
    reached: reached.promise,
    release: () => release.resolve(),
    database: database.withPlugin({
      transformQuery(args) {
        if (!paused && matches(JSON.stringify(args.node))) queries.add(args.queryId);
        return args.node;
      },
      async transformResult(args) {
        if (queries.delete(args.queryId) && !paused) {
          paused = true;
          reached.resolve();
          await release.promise;
        }
        return args.result;
      },
    }),
  };
}
