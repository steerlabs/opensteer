import { setTimeout as delay } from "node:timers/promises";
import {
  CamelCasePlugin,
  Kysely,
  PostgresDialect,
  type Transaction,
  type IsolationLevel,
} from "kysely";
import { OpensteerError } from "@opensteer/core";
import { Pool } from "pg";
import type { DatabaseSchema } from "./schema.js";

interface DatabaseConnectionOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  readonly applicationName?: string;
}

export function createDatabase(
  options: DatabaseConnectionOptions,
  providedPool?: Pool,
): Kysely<DatabaseSchema> {
  const pool =
    providedPool ??
    new Pool({
      application_name: options.applicationName ?? "opensteer-host",
      connectionString: options.connectionString,
      max: options.maxConnections ?? 10,
    });

  return new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({ pool }),
    // Column names are converted; what a JSON column holds is not. Opensteer's
    // own documents are camelCase already, and a document from elsewhere — an
    // MCP tool's schema, a program's environment — must read back exactly as
    // it was written: `PLUGIN_ROOT` is not `PLUGINROOT`.
    plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })],
  });
}

/**
 * Whether an error is a transaction that lost to a concurrent one: a deadlock
 * or a serialization failure. PostgreSQL rolled it back whole, so running it
 * again is safe and usually succeeds.
 */
export function isTransactionConflict(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return code === "40P01" || code === "40001";
}

/**
 * Whether an error is a value the schema refused: a unique, foreign-key, check
 * or not-null constraint. The same value fails the same way every time.
 */
export function isConstraintViolation(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return typeof code === "string" && code.startsWith("23");
}

/**
 * A transaction found more rows to lock than it discovered before locking, and
 * rolled back to lock the larger set from the start.
 */
export class TransactionScopeChanged extends Error {}

/** Four total attempts. Callbacks must be database-only; publish their returned result after commit. */
export async function retryDatabaseTransaction<Result>(
  attempt: () => Promise<Result>,
  retryAdditional?: (error: unknown) => boolean,
): Promise<Result> {
  for (let index = 0; ; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      const retry = retryAdditional?.(error) || isTransactionConflict(error);
      if (!retry) throw error;
      if (index === 3) {
        // Retrying happens here and nowhere above: what reaches the caller is a
        // conflict it may try again, not a database error it cannot read.
        if (error instanceof TransactionScopeChanged) {
          throw new OpensteerError({
            cause: error,
            code: "conflict",
            message: "Concurrent changes kept moving this operation's scope; try again",
            retryable: true,
          });
        }
        if (isTransactionConflict(error)) {
          throw new OpensteerError({
            cause: error,
            code: "conflict",
            message: "Concurrent changes kept conflicting with this operation; try again",
            retryable: true,
          });
        }
        throw error;
      }
      await delay(5 + Math.floor(Math.random() * 15) * (index + 1));
    }
  }
}

export function withDatabaseTransaction<Schema, Result>(
  database: Kysely<Schema>,
  action: (transaction: Transaction<Schema>) => Promise<Result>,
  isolationLevel?: IsolationLevel,
  retryAdditional?: (error: unknown) => boolean,
): Promise<Result> {
  return retryDatabaseTransaction(() => {
    const builder = database.transaction();
    return (isolationLevel ? builder.setIsolationLevel(isolationLevel) : builder).execute(action);
  }, retryAdditional);
}
