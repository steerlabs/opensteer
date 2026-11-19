import type { DatabaseSchema } from "./schema.js";
import { sql } from "kysely";
import type { DeploymentId } from "@opensteer/core";
import type { IsolationLevel, Kysely, Transaction } from "kysely";
import { withDatabaseTransaction } from "./connection.js";

const clocks = new WeakMap<object, () => number>();
const transactionDatabases = new WeakMap<object, object>();

export function setExecutionClock<Schema>(database: Kysely<Schema>, now: () => number) {
  clocks.set(database, now);
}

export function executionDate<Schema>(database: Kysely<Schema>): Date {
  return new Date((clocks.get(database) ?? Date.now)());
}

export function inheritExecutionClock<Schema>(
  database: Kysely<Schema>,
  transaction: Transaction<Schema>,
) {
  const clock = clocks.get(database);
  if (clock) clocks.set(transaction, clock);
  transactionDatabases.set(transaction, database);
}

export function personalTransactionDatabase<Schema>(transaction: Transaction<Schema>) {
  return transactionDatabases.get(transaction) as Kysely<Schema> | undefined;
}

const held = new WeakSet<object>();
const offlineSettlements = new WeakSet<object>();

export function isOfflineSettlement(transaction: Transaction<DatabaseSchema>): boolean {
  return offlineSettlements.has(transaction);
}

/** The converter already holds the renamed deployment fence. */
export async function runOfflineSettlement<Result>(
  transaction: Transaction<DatabaseSchema>,
  settle: () => Promise<Result>,
): Promise<Result> {
  held.add(transaction);
  offlineSettlements.add(transaction);
  try {
    return await settle();
  } finally {
    offlineSettlements.delete(transaction);
  }
}

export function withPersonalReadTransaction<Result, Schema = DatabaseSchema>(
  database: Kysely<Schema>,
  read: (transaction: Transaction<Schema>) => Promise<Result>,
  isolationLevel: IsolationLevel = "repeatable read",
): Promise<Result> {
  return database.isTransaction
    ? read(database as Transaction<Schema>)
    : withDatabaseTransaction(
        database,
        (transaction) => {
          inheritExecutionClock(database, transaction);
          return read(transaction);
        },
        isolationLevel,
      );
}

/** Personal mutations reserve commit order before taking any domain row lock. */
export async function lockPersonalSyncState<Schema>(transaction: Transaction<Schema>) {
  if (held.has(transaction)) return;
  const state = (
    await sql<{
      deploymentId: DeploymentId;
    }>`select deployment_id from client_sync_state limit 1 for no key update`.execute(transaction)
  ).rows[0];
  if (!state) throw new Error("Personal sync state is missing");
  held.add(transaction);
  return state.deploymentId;
}

export function withPersonalTransaction<Result, Schema = DatabaseSchema>(
  database: Kysely<Schema>,
  action: (transaction: Transaction<Schema>) => Promise<Result>,
  isolationLevel?: IsolationLevel,
  retryAdditional?: (error: unknown) => boolean,
): Promise<Result> {
  if (database.isTransaction) {
    const transaction = database as Transaction<Schema>;
    return lockPersonalSyncState(transaction).then(() => action(transaction));
  }
  return withDatabaseTransaction(
    database,
    async (transaction) => {
      inheritExecutionClock(database, transaction);
      await lockPersonalSyncState(transaction);
      return action(transaction);
    },
    isolationLevel,
    retryAdditional,
  );
}
