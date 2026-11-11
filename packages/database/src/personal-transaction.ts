import type { IsolationLevel, Kysely, Transaction } from "kysely";
import { withDatabaseTransaction } from "./connection.js";
import type { DatabaseSchema } from "./schema.js";

const held = new WeakSet<Transaction<DatabaseSchema>>();

/** Personal mutations reserve commit order before taking any domain row lock. */
export async function lockDeploymentEvents(transaction: Transaction<DatabaseSchema>) {
  if (held.has(transaction)) return;
  const state = await transaction
    .selectFrom("deploymentEventState")
    .select("deploymentId")
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  // Settings follow enrollment of the hosting computer during first-owner setup.
  await transaction
    .selectFrom("personalSettings")
    .select("singletonKey")
    .forNoKeyUpdate()
    .executeTakeFirst();
  held.add(transaction);
  return state.deploymentId;
}

export function withPersonalTransaction<Result>(
  database: Kysely<DatabaseSchema>,
  action: (transaction: Transaction<DatabaseSchema>) => Promise<Result>,
  isolationLevel?: IsolationLevel,
  retryAdditional?: (error: unknown) => boolean,
): Promise<Result> {
  if (database.isTransaction) {
    const transaction = database as Transaction<DatabaseSchema>;
    return lockDeploymentEvents(transaction).then(() => action(transaction));
  }
  return withDatabaseTransaction(
    database,
    async (transaction) => {
      await lockDeploymentEvents(transaction);
      return action(transaction);
    },
    isolationLevel,
    retryAdditional,
  );
}
