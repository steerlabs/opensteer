import type { LegacyDatabaseSchema } from "./schema.js";
import { sql } from "kysely";
import type { DeploymentId } from "@opensteer/core";
import type { IsolationLevel, Kysely, Transaction } from "kysely";
import { withDatabaseTransaction } from "./connection.js";

const clocks = new WeakMap<object, () => number>();

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
}

const held = new WeakSet<object>();

export function withPersonalReadTransaction<Result, Schema = LegacyDatabaseSchema>(
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
export async function lockDeploymentEvents<Schema>(transaction: Transaction<Schema>) {
  if (held.has(transaction)) return;
  const state = (
    await sql<{
      deploymentId: DeploymentId;
    }>`select deployment_id from deployment_event_state for no key update`.execute(transaction)
  ).rows[0];
  if (!state) throw new Error("Personal deployment event state is missing");
  // Settings follow enrollment of the hosting computer during first-owner setup.
  await sql`select singleton_key from personal_settings for no key update`.execute(transaction);
  held.add(transaction);
  return state.deploymentId;
}

export function withPersonalTransaction<Result, Schema = LegacyDatabaseSchema>(
  database: Kysely<Schema>,
  action: (transaction: Transaction<Schema>) => Promise<Result>,
  isolationLevel?: IsolationLevel,
  retryAdditional?: (error: unknown) => boolean,
): Promise<Result> {
  if (database.isTransaction) {
    const transaction = database as Transaction<Schema>;
    return lockDeploymentEvents(transaction).then(() => action(transaction));
  }
  return withDatabaseTransaction(
    database,
    async (transaction) => {
      inheritExecutionClock(database, transaction);
      await lockDeploymentEvents(transaction);
      return action(transaction);
    },
    isolationLevel,
    retryAdditional,
  );
}
